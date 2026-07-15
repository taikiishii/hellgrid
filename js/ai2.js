'use strict';
/* =========================================================================
 * AIドライバ v2 — 「見たものだけ」(フォグ・オブ・ウォー観測) の方策でプレイさせる
 *
 * js/ai.js (v1: BFSオラクル観測) との違い:
 *   - 観測は env/obs2.js。ExploreMemory (エージェント自身の記憶) を毎行動更新する
 *   - 行動は確率的にサンプリングする。探索型の方策はランダム性が機能の一部で、
 *     決定的 (argmax) にすると同じ場所でループする (実測: maze9 で 92% -> 65%)
 *   - 目標場 (見つけた出口/キーへの既知マップBFS) は知識が変わったときだけ張り直す
 *     — env/env2.js の step() と同じ流儀
 *
 * Policy クラス (forward) は js/ai.js のものを再利用する。
 * ========================================================================= */

const AI2_FRAME_SKIP = 4;   // 学習時と同じ。60Hzのシムに対して15Hzで判断する

// MultiDiscrete の各グループを softmax からサンプリングする
function sampleMultiDiscrete(logits, nvec) {
  const a = [];
  let off = 0;
  for (const n of nvec) {
    let mx = -Infinity;
    for (let k = 0; k < n; k++) if (logits[off + k] > mx) mx = logits[off + k];
    let sum = 0;
    const p = new Array(n);
    for (let k = 0; k < n; k++) { p[k] = Math.exp(logits[off + k] - mx); sum += p[k]; }
    let r = Math.random() * sum, pick = n - 1;
    for (let k = 0; k < n; k++) { r -= p[k]; if (r <= 0) { pick = k; break; } }
    a.push(pick);
    off += n;
  }
  return a;
}

class AIDriver2 {
  constructor(world, policy) {
    if (policy.obsDim !== OBS2_DIM) {
      throw new Error(
        `policy: 観測次元が食い違っている (重み=${policy.obsDim}, いまの観測=${OBS2_DIM})。` +
        'tools/export-policy2.py で書き出し直すこと');
    }
    this.world = world;
    this.policy = policy;
    this.mem = new ExploreMemory();
    this.obs = new Float32Array(OBS2_DIM);
    this.tick = 0;
    this.turn = 0;
    this.pitch = 0;
    this.action = null;
    this.stepNo = 0;
    this.levelIndex = -1;
    this.endT = 0;
    this.syncLevel();
  }

  // ステージが変わったら記憶を白紙に戻す (学習時と同じ・正直な仕様)
  syncLevel() {
    const w = this.world;
    this.mem.init(w.level);
    this.stepNo = 0;
    this.mem.update(w, 0);
    this.goal = computeKnownGoal(w, this.mem);
    this.hadRed = w.player.keys.red;
    this.hadBlue = w.player.keys.blue;
    this.knownCount = this.mem.newCount;
    this.exitLen = this.mem.exits.length;
    this.keyLen = this.mem.keyTiles.length;
    this.levelIndex = w.level.index;
    this.tick = 0;
  }

  // world.step() の直前に、毎シムステップ呼ぶ
  preStep() {
    const w = this.world;
    if (w.level.index !== this.levelIndex) this.syncLevel();
    if (this.tick % AI2_FRAME_SKIP === 0) this.decide();
    w.look(this.turn / AI2_FRAME_SKIP, this.pitch / AI2_FRAME_SKIP);
    this.tick++;
  }

  decide() {
    const w = this.world, p = w.player;
    this.stepNo++;
    this.mem.update(w, this.stepNo);

    // 知識が変わったら目標場を張り直す (env2.step と同じ条件)
    const gotKey = p.keys.red !== this.hadRed || p.keys.blue !== this.hadBlue;
    if (this.mem.newCount !== this.knownCount || gotKey ||
        this.mem.exits.length !== this.exitLen || this.mem.keyTiles.length !== this.keyLen) {
      this.goal = computeKnownGoal(w, this.mem);
      this.knownCount = this.mem.newCount;
      this.exitLen = this.mem.exits.length;
      this.keyLen = this.mem.keyTiles.length;
      this.hadRed = p.keys.red;
      this.hadBlue = p.keys.blue;
    }

    buildObs2(w, this.mem, this.goal, this.obs);
    const a = sampleMultiDiscrete(this.policy.forward(this.obs), this.policy.nvec);
    this.action = a;

    const weapon = WEAPON_BY_ACTION2[a[6]];
    if (weapon) w.pressKey(weapon === 'pistol' ? 'Digit1' : weapon === 'shotgun' ? 'Digit2' : 'Digit3');
    if (a[5]) w.pressKey('KeyE');

    w.keys['KeyW'] = a[0] === 1;
    w.keys['KeyS'] = a[0] === 2;
    w.keys['KeyA'] = a[1] === 1;
    w.keys['KeyD'] = a[1] === 2;
    w.shootHeld = a[4] === 1;

    this.turn = TURN_UNITS2[a[2]];
    this.pitch = PITCH_UNITS2[a[3]];
  }

  release() {
    const w = this.world;
    for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) w.keys[k] = false;
    w.shootHeld = false;
  }

  coverage() {
    return this.mem.totalFloor ? this.mem.knownFloor / this.mem.totalFloor : 1;
  }
}

Object.assign(globalThis, { AIDriver2, AI2_FRAME_SKIP, sampleMultiDiscrete });
