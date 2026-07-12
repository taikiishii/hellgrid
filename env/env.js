'use strict';
/* =========================================================================
 * HellgridEnv — World を強化学習の環境インターフェースに包む
 *
 *   const env = new HellgridEnv({ levels: [0], mode: 'single' });
 *   let obs = env.reset(seed);
 *   const { reward, terminated, truncated, info } = env.step([1,0,2,1,1,0,0]);
 *
 * 行動 (MultiDiscrete [3,3,5,3,2,2,4]):
 *   0 前後   0=なし 1=前進 2=後退
 *   1 左右   0=なし 1=左   2=右
 *   2 旋回   0..4 = 左に大 / 左に小 / なし / 右に小 / 右に大
 *   3 上下視点 0=下 1=なし 2=上
 *   4 射撃   0/1 (フレームスキップの間ずっと押しっぱなし)
 *   5 使う   0/1 (E: ドア・スイッチ)
 *   6 武器   0=変えない 1=ピストル 2=ショットガン 3=ナイフ
 *
 * 1行動 = frameSkip(既定4) 回の step。60Hz のシムに対して 15Hz で判断する。
 * ========================================================================= */

const ACTION_NVEC = [3, 3, 5, 3, 2, 2, 4];
const TURN_UNITS = [-94, -47, 0, 47, 94];   // マウス移動量相当。±94 で約180度/秒
const PITCH_UNITS = [40, 0, -40];           // 画面座標系なので +dy = 下を向く
const WEAPON_BY_ACTION = [null, 'pistol', 'shotgun', 'knife'];

const REWARD = {
  damageDealt: 0.01,    // 敵に与えたHP 1あたり
  kill: 1.0,
  damageTaken: -0.02,   // 受けたHP 1あたり
  death: -10,
  item: 0.3,
  keycard: 3.0,
  secret: 1.0,
  doorOpened: 0.2,
  levelClear: 20.0,
  gameClear: 50.0,
  ammoSpent: -0.002,    // 弾1発あたり(乱射の抑制)
  step: -0.002,         // 時間ペナルティ
  progress: 0.1,        // 目標に1タイル近づくごと (ポテンシャル整形)
};

class HellgridEnv {
  constructor(cfg = {}) {
    this.cfg = Object.assign({
      levels: [0, 1, 2, 3, 4],  // このリストから毎エピソード1つ選ぶ
      mode: 'single',           // 'single' = 1ステージで終了 / 'campaign' = 通しでクリアまで
      maxSteps: 3000,           // 行動ステップ上限 (15Hz なので 3000 = 200秒)
      frameSkip: 4,
      noEnemies: false,         // カリキュラム: 敵なしで「出口に着く」だけを学ぶ
      noItems: false,
    }, cfg);
    this.world = new World({ seed: 1, level: this.cfg.levels[0] });
    this.obsBuf = new Float32Array(OBS_DIM);
    this.episodeSeed = 1;
  }

  // ---- 内部: ステージ読み込み直後の後処理 ----
  _onLevelLoaded() {
    const lv = this.world.level;
    if (this.cfg.noEnemies) { lv.enemies.length = 0; lv.totalKills = 0; }
    if (this.cfg.noItems) {
      lv.items = lv.items.filter(it => 'rb'.includes(it.kind)); // キーカードだけは残す
      lv.totalItems = lv.items.length;
    }
    lv.meta = levelMeta(lv);
    this._refreshGoal();
    this._snapshot();
    this.doorsOpen = this._countOpenDoors();
  }

  _refreshGoal() {
    this.goal = computeGoalField(this.world);
    this.goalDist = goalDistAt(this.goal, this.world.level, this.world.player.x, this.world.player.y);
    this.goalTarget = this.goal.target;
  }

  // 報酬計算のために前ステップの値を控えておく
  _snapshot() {
    const p = this.world.player, lv = this.world.level;
    this.prev = {
      hp: p.health, armor: p.armor,
      enemyHp: lv.enemies.reduce((a, e) => a + Math.max(0, e.hp), 0),
      kills: lv.kills, itemsGot: lv.itemsGot, secrets: lv.secretsFound,
      redKey: p.keys.red, blueKey: p.keys.blue,
      bullets: p.bullets, shells: p.shells,
    };
  }

  _countOpenDoors() {
    let n = 0;
    for (const k in this.world.level.doors) if (this.world.level.doors[k].opening) n++;
    return n;
  }

  reset(seed) {
    this.episodeSeed = (seed >>> 0) || 1;
    const rng = makeRNG(this.episodeSeed);
    const levels = this.cfg.levels;
    const idx = levels[(rng() * levels.length) | 0];
    this.world.reset(idx, this.episodeSeed);
    this.world.drainEvents();
    this.steps = 0;
    this.epReward = 0;
    this.levelsCleared = 0;
    this._onLevelLoaded();
    return buildObs(this.world, this.goal, this.obsBuf);
  }

  step(action) {
    const w = this.world, p = w.player, cfg = this.cfg;
    let reward = 0;

    // ---- 行動を入力に変換 ----
    const weapon = WEAPON_BY_ACTION[action[6]];
    if (weapon) w.pressKey(weapon === 'pistol' ? 'Digit1' : weapon === 'shotgun' ? 'Digit2' : 'Digit3');
    if (action[5]) w.pressKey('KeyE');

    w.keys['KeyW'] = action[0] === 1;
    w.keys['KeyS'] = action[0] === 2;
    w.keys['KeyA'] = action[1] === 1;
    w.keys['KeyD'] = action[1] === 2;
    w.shootHeld = action[4] === 1;

    const turn = TURN_UNITS[action[2]];
    const pitch = PITCH_UNITS[action[3]];

    // ---- フレームスキップぶん進める ----
    for (let i = 0; i < cfg.frameSkip; i++) {
      w.look(turn / cfg.frameSkip, pitch / cfg.frameSkip);
      w.step(SIM_DT);
      if (w.state !== 'playing') break;
    }
    w.drainEvents();
    this.steps++;

    // ---- 報酬 ----
    const lv = w.level, prev = this.prev;
    const enemyHp = lv.enemies.reduce((a, e) => a + Math.max(0, e.hp), 0);
    reward += Math.max(0, prev.enemyHp - enemyHp) * REWARD.damageDealt;
    reward += (lv.kills - prev.kills) * REWARD.kill;
    reward += Math.max(0, (prev.hp + prev.armor) - (p.health + p.armor)) * REWARD.damageTaken;
    reward += (lv.itemsGot - prev.itemsGot) * REWARD.item;
    reward += (lv.secretsFound - prev.secrets) * REWARD.secret;
    reward += Math.max(0, (prev.bullets - p.bullets) + (prev.shells - p.shells)) * REWARD.ammoSpent;
    reward += REWARD.step;

    const gotKey = (p.keys.red && !prev.redKey) || (p.keys.blue && !prev.blueKey);
    if (gotKey) reward += REWARD.keycard;

    const openNow = this._countOpenDoors();
    if (openNow > this.doorsOpen) reward += (openNow - this.doorsOpen) * REWARD.doorOpened;
    this.doorsOpen = openNow;

    // ---- 出口までの距離によるポテンシャル整形 ----
    // キーを取ると目標が切り替わって距離が飛ぶので、そのステップは整形しない
    if (gotKey) {
      this._refreshGoal();
    } else {
      const d = goalDistAt(this.goal, lv, p.x, p.y);
      if (d >= 0 && this.goalDist >= 0) reward += (this.goalDist - d) * REWARD.progress;
      if (d >= 0) this.goalDist = d;
    }

    // ---- 終了判定 ----
    let terminated = false, truncated = false;
    if (w.state === 'dead') {
      reward += REWARD.death;
      terminated = true;
    } else if (w.state === 'levelEnd') {
      reward += REWARD.levelClear;
      this.levelsCleared++;
      if (cfg.mode === 'campaign') {
        w.nextLevel();
        w.drainEvents();
        if (w.state === 'gameClear') { reward += REWARD.gameClear; terminated = true; }
        else this._onLevelLoaded();
      } else {
        terminated = true;
      }
    } else if (w.state === 'gameClear') {
      reward += REWARD.gameClear;
      terminated = true;
    }
    if (!terminated && this.steps >= cfg.maxSteps) truncated = true;

    this._snapshot();
    this.epReward += reward;

    const obs = buildObs(w, this.goal, this.obsBuf);
    return {
      obs, reward, terminated, truncated,
      info: {
        level: lv.index,
        kills: lv.kills, totalKills: lv.totalKills,
        itemsGot: lv.itemsGot, totalItems: lv.totalItems,
        secrets: lv.secretsFound,
        hp: p.health,
        goalDist: this.goalDist,
        goalTarget: this.goalTarget,
        levelsCleared: this.levelsCleared,
        steps: this.steps,
        epReward: this.epReward,
        timeSec: lv.time,
      },
    };
  }
}

Object.assign(globalThis, { HellgridEnv, ACTION_NVEC, OBS_DIM, REWARD });
