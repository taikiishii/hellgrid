'use strict';
/* =========================================================================
 * HellgridEnv2 — 「見たものだけ」で学習する環境 (探索版)
 *
 * v1 (env/env.js) との違い:
 *   - 観測は obs2.js のフォグ・オブ・ウォー版 (Box(5866))。BFSオラクルなし
 *   - マップ全体へのポテンシャル整形が消える代わりに、
 *       「新しいタイルを見た」+0.02 が探索の背骨になる
 *       「出口を見つけた」+5 で発見そのものを褒める
 *       見つけた後は「既知マップ上のBFS」で接近を整形する (見た道を辿るのは正当)
 *   - 既定ではシード付きランダム迷路を毎エピソード生成する (丸暗記の防止)。
 *     cfg.levels を渡すと既存ステージ (E1M1〜) でも動く
 *
 * 行動空間・フレームスキップは v1 と完全に同一。
 * v1 と同じコンテキストに同居できるよう IIFE で包む。env.js は変更しない。
 * ========================================================================= */
(() => {

  const ACTION_NVEC2 = [3, 3, 5, 3, 2, 2, 4];
  const TURN_UNITS2 = [-94, -47, 0, 47, 94];
  const PITCH_UNITS2 = [40, 0, -40];
  const WEAPON_BY_ACTION2 = [null, 'pistol', 'shotgun', 'knife'];

  const REWARD2 = {
    // ---- 探索 (新しい背骨) ----
    newTile: 0.02,       // 新しいタイルを見た (1タイルごと)
    exitFound: 5.0,      // 出口スイッチを初めて視界に入れた
    keyFound: 2.0,       // キーカードを初めて視界に入れた
    progress: 0.1,       // 見つけた目標へ既知マップ上で1歩近づいた (ポテンシャル整形)
    // 目標をまだ見つけていない間、最寄りのフロンティア (未知との境界) へ近づくと
    // 加点する。newTile だけだと発見の瞬間しか報酬が出ず、次のフロンティアまでの
    // 移動区間が報酬の砂漠になって探索がループする (maze15 で実測: 失敗の全てが
    // 「出口未発見のまま停滞」)。progress より小さくして、目標発見後は出口優先
    frontier: 0.05,
    revisit: -0.01,      // 同じタイルをうろつく (訪問回数に応じて最大まで漸増)
    // ---- v1 から引き継ぎ ----
    damageDealt: 0.01,
    kill: 1.0,
    hp: 0.02,            // HP+アーマーの増減 (対称)
    death: -10,
    item: 0.3,
    keycard: 3.0,
    secret: 1.0,
    doorOpened: 0.2,
    levelClear: 20.0,
    gameClear: 50.0,
    ammoSpent: -0.002,
    step: -0.002,
  };

  class HellgridEnv2 {
    constructor(cfg = {}) {
      this.cfg = Object.assign({
        levels: null,      // null = 毎エピソードにランダム迷路 / [0,...] = 既存ステージ
        mazeSize: 11,      // 迷路の一辺 (奇数)
        mazeBraid: 0,      // 0..1 行き止まりを開通させてループを作る割合
        mazeRooms: 0,      // 迷路の上に彫る矩形の部屋の数 (実ステージの構造に近づける)
        maxSteps: 600,     // 行動ステップ上限 (15Hz なので 600 = 40秒)
        frameSkip: 4,
        noEnemies: false,
        noItems: false,
      }, cfg);
      this.world = null;
      this.mazeIdx = -1;   // LEVELS 配列に生成迷路を差し込むスロット
      this.mem = new ExploreMemory();
      this.obsBuf = new Float32Array(OBS2_DIM);
      this.episodeSeed = 1;
    }

    reset(seed) {
      this.episodeSeed = (seed >>> 0) || 1;
      let idx;
      if (this.cfg.levels) {
        const rng = makeRNG(this.episodeSeed);
        idx = this.cfg.levels[(rng() * this.cfg.levels.length) | 0];
      } else {
        const def = generateMaze(this.episodeSeed, {
          size: this.cfg.mazeSize, braid: this.cfg.mazeBraid, rooms: this.cfg.mazeRooms,
        });
        // このコンテキストの LEVELS に1スロット確保して毎回差し替える
        // (World.loadLevel は LEVELS[index] を読むだけなので、これで注入できる)
        if (this.mazeIdx < 0) { this.mazeIdx = LEVELS.length; LEVELS.push(def); }
        else LEVELS[this.mazeIdx] = def;
        idx = this.mazeIdx;
      }
      if (!this.world) this.world = new World({ seed: this.episodeSeed, level: idx });
      else this.world.reset(idx, this.episodeSeed);
      this.world.drainEvents();

      const lv = this.world.level;
      if (this.cfg.noEnemies) { lv.enemies.length = 0; lv.totalKills = 0; }
      if (this.cfg.noItems) {
        lv.items = lv.items.filter(it => 'rb'.includes(it.kind));
        lv.totalItems = lv.items.length;
      }

      this.steps = 0;
      this.epReward = 0;
      this.levelsCleared = 0;
      this._initMemory();
      this._snapshot();
      this.doorsOpen = this._countOpenDoors();
      return buildObs2(this.world, this.mem, this.goal, this.obsBuf);
    }

    // 記憶を白紙にして開始地点の視界を書き込む。
    // 開始時に見えていたぶんは「無料」(報酬なし)。出口が最初から見えていた場合も
    // 発見ボーナスは出さない (探した結果ではないので)
    _initMemory() {
      this.mem.init(this.world.level);
      this.mem.update(this.world, 0);
      this.goal = computeKnownGoal(this.world, this.mem);
      this.frontier = computeFrontierField(this.world, this.mem);
      this.exitSeen = this.mem.exits.length > 0;
      this.seenRed = this.mem.seenRed;
      this.seenBlue = this.mem.seenBlue;
      this.exitCount = this.mem.exits.length;
      this.keyCount = this.mem.keyTiles.length;
      const p = this.world.player;
      this.prevTileX = p.x | 0;
      this.prevTileY = p.y | 0;
    }

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

    step(action) {
      const w = this.world, p = w.player, cfg = this.cfg;
      let reward = 0;

      // ---- 行動を入力に変換 (v1 と同一) ----
      const weapon = WEAPON_BY_ACTION2[action[6]];
      if (weapon) w.pressKey(weapon === 'pistol' ? 'Digit1' : weapon === 'shotgun' ? 'Digit2' : 'Digit3');
      if (action[5]) w.pressKey('KeyE');
      w.keys['KeyW'] = action[0] === 1;
      w.keys['KeyS'] = action[0] === 2;
      w.keys['KeyA'] = action[1] === 1;
      w.keys['KeyD'] = action[1] === 2;
      w.shootHeld = action[4] === 1;
      const turn = TURN_UNITS2[action[2]];
      const pitch = PITCH_UNITS2[action[3]];

      for (let i = 0; i < cfg.frameSkip; i++) {
        w.look(turn / cfg.frameSkip, pitch / cfg.frameSkip);
        w.step(SIM_DT);
        if (w.state !== 'playing') break;
      }
      w.drainEvents();
      this.steps++;

      // ---- 記憶を更新 (このステップで視界に入れたものを覚える) ----
      const newTiles = this.mem.update(w, this.steps);

      // ---- 基本報酬 (v1 と同じ骨格) ----
      const lv = w.level, prev = this.prev;
      const enemyHp = lv.enemies.reduce((a, e) => a + Math.max(0, e.hp), 0);
      reward += Math.max(0, prev.enemyHp - enemyHp) * REWARD2.damageDealt;
      reward += (lv.kills - prev.kills) * REWARD2.kill;
      reward += ((p.health + p.armor) - (prev.hp + prev.armor)) * REWARD2.hp;
      reward += (lv.itemsGot - prev.itemsGot) * REWARD2.item;
      reward += (lv.secretsFound - prev.secrets) * REWARD2.secret;
      reward += Math.max(0, (prev.bullets - p.bullets) + (prev.shells - p.shells)) * REWARD2.ammoSpent;
      reward += REWARD2.step;

      const gotKey = (p.keys.red && !prev.redKey) || (p.keys.blue && !prev.blueKey);
      if (gotKey) reward += REWARD2.keycard;

      const openNow = this._countOpenDoors();
      if (openNow > this.doorsOpen) reward += (openNow - this.doorsOpen) * REWARD2.doorOpened;
      this.doorsOpen = openNow;

      // ---- 探索報酬: ここが新しい背骨 ----
      reward += newTiles * REWARD2.newTile;
      if (!this.exitSeen && this.mem.exits.length) { this.exitSeen = true; reward += REWARD2.exitFound; }
      if (!this.seenRed && this.mem.seenRed) { this.seenRed = true; reward += REWARD2.keyFound; }
      if (!this.seenBlue && this.mem.seenBlue) { this.seenBlue = true; reward += REWARD2.keyFound; }

      // ---- 見つけた目標への接近 (既知マップ上のBFSによるポテンシャル整形) ----
      // 知識が変わったら場を張り直す。差分は必ず「今の場」で前タイル vs 現タイルを
      // 取るので、場の更新による距離の飛びが報酬に化けることはない。
      if (newTiles > 0 || gotKey ||
          this.mem.exits.length !== this.exitCount || this.mem.keyTiles.length !== this.keyCount) {
        this.goal = computeKnownGoal(w, this.mem);
        this.exitCount = this.mem.exits.length;
        this.keyCount = this.mem.keyTiles.length;
      }
      const cx = p.x | 0, cy = p.y | 0;
      if (this.goal.field) {
        const dPrev = knownGoalDistAt(this.goal, lv, this.prevTileX, this.prevTileY);
        const dCur = knownGoalDistAt(this.goal, lv, cx, cy);
        if (dPrev >= 0 && dCur >= 0) reward += (dPrev - dCur) * REWARD2.progress;
        this.frontier = null;   // 目標優先。フロンティア場は使わなくなったら捨てる
      } else {
        // ---- 目標をまだ見つけていない: フロンティアへのポテンシャル整形 ----
        // 差分は「前ステップ時点の知識で張った場」で取る。行動した時点で正しかった
        // 方向に報い、発見でフロンティアが移動しても遡って罰しない。
        // 全タイル探索済みで場が消えたら整形なし
        if (!this.frontier) this.frontier = computeFrontierField(w, this.mem);
        const fPrev = knownGoalDistAt(this.frontier, lv, this.prevTileX, this.prevTileY);
        const fCur = knownGoalDistAt(this.frontier, lv, cx, cy);
        if (fPrev >= 0 && fCur >= 0) reward += (fPrev - fCur) * REWARD2.frontier;
        if (newTiles > 0 || gotKey) this.frontier = computeFrontierField(w, this.mem);
      }
      this.prevTileX = cx; this.prevTileY = cy;

      // ---- うろつきペナルティ (3回目以降の訪問から漸増) ----
      const visits = this.mem.visits[cy * lv.w + cx];
      if (visits > 2) reward += REWARD2.revisit * Math.min(1, (visits - 2) / 8);

      // ---- 終了判定 ----
      let terminated = false, truncated = false;
      if (w.state === 'dead') {
        reward += REWARD2.death;
        terminated = true;
      } else if (w.state === 'levelEnd' || w.state === 'gameClear') {
        reward += REWARD2.levelClear;
        this.levelsCleared++;
        terminated = true;
      }
      if (!terminated && this.steps >= cfg.maxSteps) truncated = true;

      this._snapshot();
      this.epReward += reward;

      const obs = buildObs2(w, this.mem, this.goal, this.obsBuf);
      return {
        obs, reward, terminated, truncated,
        info: {
          level: lv.index,
          coverage: this.mem.totalFloor ? this.mem.knownFloor / this.mem.totalFloor : 1,
          exitSeen: this.exitSeen ? 1 : 0,
          goalDist: knownGoalDistAt(this.goal, lv, p.x, p.y),
          kills: lv.kills, totalKills: lv.totalKills,
          itemsGot: lv.itemsGot, totalItems: lv.totalItems,
          hp: p.health,
          levelsCleared: this.levelsCleared,
          steps: this.steps,
          epReward: this.epReward,
          timeSec: lv.time,
        },
      };
    }
  }

  Object.assign(globalThis, { HellgridEnv2, REWARD2, ACTION_NVEC2 });
})();
