'use strict';
/* =========================================================================
 * AIドライバ — 学習した方策でゲームをプレイさせる
 *
 * 学習は Python (PPO) でやるが、推論はここで完結する。方策は
 * 1231 -> 512(tanh) -> 512(tanh) -> 22 の小さなMLPなので、素のJSで十分速い
 * (1回の推論で90万回の積和。15Hzで回しても数%のCPU)。
 *
 * onnxruntime-web を使わないのは、file:// で開いたときに WASM の fetch が
 * ブロックされて動かないため。「index.html をダブルクリックするだけで動く」を
 * 守るには、重みを埋め込んで自前で行列積を回すのが一番確実。
 *
 * 重要: 観測 (env/obs.js) と行動の解釈 (env/env.js の TURN_UNITS など) は
 * 学習時とまったく同じものを使う。ここがズレると方策は動かない。
 * ========================================================================= */

const AI_FRAME_SKIP = 4;   // 学習時と同じ。60Hzのシムに対して15Hzで判断する

// base64 -> Float32Array
function decodeF32(b64) {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(buf);
}

// 全結合の多層パーセプトロン。PyTorch の Linear は y = x·Wᵀ + b で、
// W は (out, in) の行優先なので、そのまま行ごとに内積を取ればよい。
class Policy {
  constructor(spec) {
    this.obsDim = spec.obsDim;
    this.nvec = spec.nvec;
    this.layers = spec.layers.map(l => ({
      nIn: l.in, nOut: l.out, tanh: l.act === 'tanh',
      w: decodeF32(l.w), b: decodeF32(l.b),
    }));
    this.bufs = this.layers.map(l => new Float32Array(l.nOut));
    // 形が合っていないと、行列積が静かに壊れて「常に同じ行動」になる。必ず落とす
    for (const L of this.layers) {
      if (L.w.length !== L.nIn * L.nOut || L.b.length !== L.nOut) {
        throw new Error(`policy: 重みの形が合わない (${L.nIn}x${L.nOut} に対し w=${L.w.length} b=${L.b.length})`);
      }
    }
    const nLogits = this.nvec.reduce((a, n) => a + n, 0);
    if (this.layers[this.layers.length - 1].nOut !== nLogits) {
      throw new Error(`policy: 出力数が行動空間と合わない (${this.layers[this.layers.length - 1].nOut} != ${nLogits})`);
    }
  }

  forward(x) {
    let inp = x;
    for (let li = 0; li < this.layers.length; li++) {
      const L = this.layers[li], out = this.bufs[li], w = L.w, b = L.b, nIn = L.nIn;
      for (let o = 0; o < L.nOut; o++) {
        let s = b[o];
        const row = o * nIn;
        for (let i = 0; i < nIn; i++) s += w[row + i] * inp[i];
        out[o] = L.tanh ? Math.tanh(s) : s;
      }
      inp = out;
    }
    return inp; // 22個のロジット
  }

  // 決定的な行動選択: MultiDiscrete の各グループごとに argmax
  act(obs) {
    const logits = this.forward(obs);
    const a = [];
    let off = 0;
    for (const n of this.nvec) {
      let best = 0, bv = -Infinity;
      for (let k = 0; k < n; k++) {
        if (logits[off + k] > bv) { bv = logits[off + k]; best = k; }
      }
      a.push(best);
      off += n;
    }
    return a;
  }
}

// World に入力を流し込む。学習時の HellgridEnv.step とまったく同じ順序で行う。
//
// script を渡すと、方策を呼ばずにその行動列をそのまま流す(リプレイ)。World は
// 決定的なので、同じシード + 同じ行動列 なら寸分違わず同じプレイが再現される。
class AIDriver {
  constructor(world, policy, script) {
    this.world = world;
    this.policy = policy;
    this.script = script || null;
    this.obs = new Float32Array(policy ? policy.obsDim : OBS_DIM);
    this.tick = 0;
    this.turn = 0;
    this.pitch = 0;
    this.action = null;
    this.levelIndex = -1;
    this.endT = 0;             // クリア/死亡してから自動で次へ進むまでの待ち時間
    this.syncLevel();
  }

  // ステージが変わったら、出口までの距離場を張り直し、録画も撮り直す
  syncLevel() {
    const lv = this.world.level;
    lv.meta = levelMeta(lv);
    this.goal = computeGoalField(this.world);
    this.hadRed = this.world.player.keys.red;
    this.hadBlue = this.world.player.keys.blue;
    this.levelIndex = lv.index;
    this.tick = 0;
    this.frame = 0;
    if (!this.script) {
      // リプレイ用の記録。シードと行動列さえあればこのプレイを完全に再現できる
      this.record = { v: 1, seed: this.world.seed, level: lv.index, frameSkip: AI_FRAME_SKIP, actions: [] };
    }
  }

  // world.step() の直前に、毎シムステップ呼ぶ
  preStep() {
    const w = this.world;
    if (w.level.index !== this.levelIndex) this.syncLevel();

    // キーカードを拾うと施錠ドアが通れるようになるので、目標を出口に張り直す
    const p = w.player;
    if (p.keys.red !== this.hadRed || p.keys.blue !== this.hadBlue) {
      this.hadRed = p.keys.red;
      this.hadBlue = p.keys.blue;
      this.goal = computeGoalField(w);
    }

    if (this.tick % AI_FRAME_SKIP === 0) this.decide();
    w.look(this.turn / AI_FRAME_SKIP, this.pitch / AI_FRAME_SKIP);
    this.tick++;
  }

  decide() {
    const w = this.world;
    buildObs(w, this.goal, this.obs);   // リプレイ中も可視化のために観測は作る
    const a = this.script
      ? (this.script[this.frame] || [0, 0, 0, 0, 0, 0, 0])
      : this.policy.act(this.obs);
    if (!this.script) this.record.actions.push(a);
    this.frame++;
    this.action = a;

    const weapon = WEAPON_BY_ACTION[a[6]];
    if (weapon) w.pressKey(weapon === 'pistol' ? 'Digit1' : weapon === 'shotgun' ? 'Digit2' : 'Digit3');
    if (a[5]) w.pressKey('KeyE');

    w.keys['KeyW'] = a[0] === 1;
    w.keys['KeyS'] = a[0] === 2;
    w.keys['KeyA'] = a[1] === 1;
    w.keys['KeyD'] = a[1] === 2;
    w.shootHeld = a[4] === 1;

    this.turn = TURN_UNITS[a[2]];
    this.pitch = PITCH_UNITS[a[3]];
  }

  // AI を切るとき、押しっぱなしのキーを離しておく
  release() {
    const w = this.world;
    for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) w.keys[k] = false;
    w.shootHeld = false;
  }

  // 出口までの残り歩数 (デモのHUD表示用)
  goalDist() {
    return goalDistAt(this.goal, this.world.level, this.world.player.x, this.world.player.y);
  }
}

Object.assign(globalThis, { Policy, AIDriver, AI_FRAME_SKIP });
