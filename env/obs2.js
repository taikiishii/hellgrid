'use strict';
/* =========================================================================
 * 観測 v2 — 「見たものだけ」(フォグ・オブ・ウォー)
 *
 * 観測 v1 (env/obs.js) はマップ全体の BFS 勾配を毎ステップ与えており、
 * エージェントは探索せず与えられた最短経路を辿るだけだった (docs 参照)。
 * v2 では環境側に「エージェント自身の記憶」(ExploreMemory) を持たせ、
 * 実際に視界に入れた情報しか観測に出さない。
 *
 *   rays    24本 x 17ch = 408   … 視線判定つき (v3 で飛翔弾の距離・接近速度を追加)
 *   local   15x15 x 9ch = 2025  … 自己中心の既知マップ。未探索チャネルが探索の主役
 *   global  24x24 x 6ch = 3456  … レベル全体を粗く。絶対座標 + 自機マーカー
 *   scalars 28                  … HUD 相当 + 探索の進み具合 + 被弾の量と方向 (v3)
 *
 * カンニングの線引き:
 *   - 「見たタイル」への BFS (computeKnownGoal) は人間の「来た道は覚えている」に
 *     相当するので正当。未探索タイルは通れない扱い = 未知の近道は使えない
 *   - 隠し扉 '*' は見た目が壁なので壁として記憶する (v1 と同じ方針)
 *   - 敵は「最後に見た位置と経過時間」。古い情報は減衰し、視界に入れて
 *     いなくなっていたら消す (人間のプレイと同じ)
 *
 * v1 と同じ vm コンテキスト / ブラウザに同居できるよう、IIFE で包んで
 * 2系の名前だけを globalThis に出す。obs.js は一切変更しない。
 * ========================================================================= */
(() => {

  // v3: レイに飛翔弾2ch (ch15 距離 / ch16 接近速度)、スカラーに被弾3個を追加。
  // 「火球を見て避ける」「視野外から撃たれたら音源の方を向く」は人間が画面から
  // 得ている情報で、これが無いと原理的に学習できない (教訓5)。
  const N_RAYS = 24, RAY_CH = 17;          // v2 は 15ch だった
  const LOCAL = 15, LOCAL_CH = 9;          // 自己中心の既知マップ
  const GLOB = 24, GLOB_CH = 6;            // 全体マップ (粗い・絶対座標)
  const N_SCALARS = 28;                    // v2 は 25 だった
  const PROJ_MAX_SPEED = 9;                // 最速の弾 (獄騎士) で接近速度を正規化
  const HIT_MEMORY_S = 2;                  // 被弾情報が薄れきるまでの秒数

  const RAYS_DIM = N_RAYS * RAY_CH;                              // 408
  const LOCAL_DIM = LOCAL * LOCAL * LOCAL_CH;                    // 2025
  const GLOB_DIM = GLOB * GLOB * GLOB_CH;                        // 3456
  const OBS2_DIM = RAYS_DIM + LOCAL_DIM + GLOB_DIM + N_SCALARS;  // 5917

  const RAYS_OFF = 0;
  const LOCAL_OFF = RAYS_DIM;
  const GLOB_OFF = LOCAL_OFF + LOCAL_DIM;
  const SC_OFF = GLOB_OFF + GLOB_DIM;

  const MAX_D = 24;                 // 視界距離の上限 (タイル)
  const VIS_RAYS = 48;              // 視界マーキング用レイ (観測レイ24本より密)

  // vm コンテキストではグローバル (Math 含む) へのアクセスがプロキシ経由で遅い。
  // ホットループで使う関数はクロージャに束縛しておく (実測で観測生成が数倍速くなる)
  const mAbs = Math.abs, mHypot = Math.hypot, mMin = Math.min, mMax = Math.max;
  const ENEMY_MEMORY_S = 6;         // 敵の目撃情報が薄れきるまでの秒数
  const ENEMY_ORDER = ['zombie', 'sergeant', 'imp', 'demon', 'knight', 'floater'];
  const SUPPLY_ITEMS = 'hHaAsSpV';
  const KEY_ITEMS = 'rb';

  // ======================= 記憶 =======================
  // エージェントが「これまでに見たもの」。エピソード開始で白紙に戻る。
  // update() は毎行動ステップ (15Hz) に1回呼ぶ。

  class ExploreMemory {
    init(level) {
      const n = level.w * level.h;
      this.w = level.w; this.h = level.h;
      this.known = new Uint8Array(n);       // 1 = 見たことがあるタイル
      this.visits = new Uint16Array(n);     // 踏んだ回数 (うろつき検出・軌跡表示)
      // 全体マップ用: タイル → 24x24 セルの対応 (毎ステップ計算すると遅いので前計算)
      this.gScale = mMax(level.w, level.h) / GLOB;   // タイル / セル
      this.cellOf = new Int32Array(n);
      this.cellCnt = new Float32Array(GLOB * GLOB);
      for (let y = 0; y < level.h; y++) {
        const gy = mMin(GLOB - 1, (y / this.gScale) | 0);
        for (let x = 0; x < level.w; x++) {
          const gx = mMin(GLOB - 1, (x / this.gScale) | 0);
          const c = gy * GLOB + gx;
          this.cellOf[y * level.w + x] = c;
          this.cellCnt[c]++;
        }
      }
      this.visStamp = new Int32Array(n).fill(-1);  // 最後に視界に入れたステップ
      this.enemyT = new Float32Array(n).fill(-1);  // 敵を最後に見た時刻 (level.time)
      this.itemSeen = new Uint8Array(n);    // 1 = そこにアイテムがあると思っている
      this.itemKind = new Uint8Array(n);    // 見たアイテムの種別 (文字コード)。回復誘導用
      this.itemRev = 0;                     // アイテム記憶の世代番号 (場の張り直し判定用)
      this.exits = [];                      // 見つけた出口スイッチのタイル [x,y]
      this.keyTiles = [];                   // 見つけた(まだある)キーカード {x,y,kind}
      this.seenRed = false; this.seenBlue = false;  // 一度でも見たか (拾っても真のまま)
      this.newCount = 0;                    // 知ったタイルの総数
      this.knownFloor = 0;
      this.lastNewStep = 0;                 // 最後に新タイルを見たステップ
      this.stepNo = 0;
      this.lastTileX = -1; this.lastTileY = -1;
      this._visList = [];                   // このステップで視界に入ったタイル
      let tf = 0;
      for (let y = 0; y < level.h; y++) {
        for (let x = 0; x < level.w; x++) if (level.grid[y][x] === null) tf++;
      }
      this.totalFloor = tf;
    }

    _mark(level, x, y) {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
      const i = y * this.w + x;
      if (this.visStamp[i] !== this.stepNo) {
        this.visStamp[i] = this.stepNo;
        this._visList.push(i);
      }
      if (this.known[i]) return;
      this.known[i] = 1;
      this.newCount++;
      this.lastNewStep = this.stepNo;
      const ch = level.grid[y][x];
      if (ch === null) this.knownFloor++;
      else if (ch === 'X') this.exits.push([x, y]);
    }

    // 視界を計算して記憶に書き込む。戻り値 = このステップで新しく知ったタイル数
    update(world, stepNo) {
      const level = world.level, p = world.player;
      this.stepNo = stepNo;
      this._visList.length = 0;
      const px = p.x | 0, py = p.y | 0;
      const before = this.newCount;

      // 足元 3x3 は視界に関係なく分かる (体で触れられる範囲。真後ろの壁など)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) this._mark(level, px + dx, py + dy);
      }

      // FOV 内を DDA でなめて、通過した床と突き当たった壁を「見た」ことにする
      const eyeZ = p.z + EYE;
      for (let r = 0; r < VIS_RAYS; r++) {
        const camX = 2 * (r + 0.5) / VIS_RAYS - 1;
        let dx = p.dirX + p.planeX * camX, dy = p.dirY + p.planeY * camX;
        const len = mHypot(dx, dy); dx /= len; dy /= len;
        let mapX = px, mapY = py;
        const deltaX = mAbs(1 / dx), deltaY = mAbs(1 / dy);
        let stepX, stepY, sideX, sideY;
        if (dx < 0) { stepX = -1; sideX = (p.x - mapX) * deltaX; }
        else { stepX = 1; sideX = (mapX + 1 - p.x) * deltaX; }
        if (dy < 0) { stepY = -1; sideY = (p.y - mapY) * deltaY; }
        else { stepY = 1; sideY = (mapY + 1 - p.y) * deltaY; }
        for (let i = 0; i < 128; i++) {
          let t;
          if (sideX < sideY) { t = sideX; sideX += deltaX; mapX += stepX; }
          else { t = sideY; sideY += deltaY; mapY += stepY; }
          if (t > MAX_D) break;
          this._mark(level, mapX, mapY);
          if (isSolid(level, mapX + 0.5, mapY + 0.5)) break;   // 壁も「見た」上で止まる
          if (floorHt(level, mapX, mapY) > eyeZ) break;        // 段差が視線を遮る
        }
      }

      // 見えている敵・アイテムを「最後に見た位置」として記憶する
      const invDet = 1 / (p.planeX * p.dirY - p.dirX * p.planeY);
      const inFov = (x, y) => {
        const rx = x - p.x, ry = y - p.y;
        const ty = invDet * (-p.planeY * rx + p.planeX * ry);
        if (ty <= 0.15) return false;
        const s = invDet * (p.dirY * rx - p.dirX * ry) / ty;
        return s >= -1 && s <= 1;
      };
      const liveEnemy = new Set(), liveItem = new Set();
      for (const e of level.enemies) {
        if (e.dormant || e.state === 'dead') continue;
        const ti = (e.y | 0) * this.w + (e.x | 0);
        liveEnemy.add(ti);
        if (!inFov(e.x, e.y)) continue;
        if (mHypot(e.x - p.x, e.y - p.y) > MAX_D) continue;
        if (!world.hasLineOfSight(p.x, p.y, e.x, e.y, p.z + EYE, e.z + EYE)) continue;
        this.enemyT[ti] = level.time;
      }
      for (const it of level.items) {
        const tx = it.x | 0, ty = it.y | 0, ti = ty * this.w + tx;
        liveItem.add(ti);
        if (!inFov(it.x, it.y)) continue;
        if (mHypot(it.x - p.x, it.y - p.y) > MAX_D) continue;
        if (!world.hasLineOfSight(p.x, p.y, it.x, it.y, p.z + EYE, it.z + 0.3)) continue;
        if (!this.itemSeen[ti]) {
          this.itemSeen[ti] = 1;
          this.itemKind[ti] = it.kind.charCodeAt(0);
          this.itemRev++;
          if (it.kind === 'r' || it.kind === 'b') {
            this.keyTiles.push({ x: tx, y: ty, kind: it.kind });
            if (it.kind === 'r') this.seenRed = true; else this.seenBlue = true;
          }
        }
      }

      // いま視界に入れたタイルで記憶の答え合わせ。
      // 「さっき見た敵がもういない」「あったはずのアイテムが消えた」を反映する
      for (const i of this._visList) {
        if (this.enemyT[i] >= 0 && !liveEnemy.has(i)) this.enemyT[i] = -1;
        if (this.itemSeen[i] && !liveItem.has(i)) {
          this.itemSeen[i] = 0;
          this.itemKind[i] = 0;
          this.itemRev++;
          for (let k = this.keyTiles.length - 1; k >= 0; k--) {
            const kt = this.keyTiles[k];
            if (kt.y * this.w + kt.x === i) this.keyTiles.splice(k, 1);
          }
        }
      }

      // 訪問回数 (タイルをまたいだときだけ加算)
      if (px !== this.lastTileX || py !== this.lastTileY) {
        const i = py * this.w + px;
        this.visits[i] = mMin(65535, this.visits[i] + 1);
        this.lastTileX = px; this.lastTileY = py;
      }

      return this.newCount - before;
    }
  }

  // ======================= 既知マップ上の BFS =======================
  // 「これまでに見たタイル」だけを通れる扱いで目標 (見つけた出口 / キー) までの
  // 距離場を張る。未探索タイルは通れない = 未知の近道は使えない。
  // 探索済みエリアの道順が分かるのは人間も同じなので、これはカンニングではない。

  function knownWalkable(mem, level, x, y, keys) {
    if (!mem.known[y * level.w + x]) return false;
    const ch = level.grid[y][x];
    if (ch === null) return !level.water[y][x];
    if (ch === 'D') return true;
    if (ch === 'R') return !!keys.red;
    if (ch === 'B') return !!keys.blue;
    return false;   // '#' '&' '=' 'X' '*'
  }

  function bfsHeight2(level, x, y) {
    return level.lift[y][x] ? 0 : level.heights[y][x];
  }

  function bfsKnownField(mem, level, seeds, keys) {
    const w = level.w, h = level.h;
    const dist = new Int16Array(w * h).fill(-1);
    const q = [];
    for (const [x, y] of seeds) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      if (dist[i] < 0 && knownWalkable(mem, level, x, y, keys)) { dist[i] = 0; q.push(i); }
    }
    const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi], cx = c % w, cy = (c / w) | 0;
      const hb = bfsHeight2(level, cx, cy);
      for (const [dx, dy] of NB) {
        const ax = cx + dx, ay = cy + dy;
        if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue;
        const k = ay * w + ax;
        if (dist[k] >= 0 || !knownWalkable(mem, level, ax, ay, keys)) continue;
        if (hb - bfsHeight2(level, ax, ay) > STEP_MAX) continue;
        dist[k] = dist[c] + 1;
        q.push(k);
      }
    }
    return dist;
  }

  // 目標: 見つけた出口 (到達可能なら) > 見つけた未所持キーカード > なし。
  // キルゲートが閉じている間は出口を目標にしない (倒すまで押せないので、
  // 出口前で待つより探索して敵を見つけるほうが正しい)
  function computeKnownGoal(world, mem) {
    const level = world.level, keys = world.player.keys;
    const pi = (world.player.y | 0) * level.w + (world.player.x | 0);
    const gateClosed = level.killGate && level.kills < level.killGate;
    if (mem.exits.length && !gateClosed) {
      const seeds = [];
      for (const [x, y] of mem.exits) seeds.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
      const f = bfsKnownField(mem, level, seeds, keys);
      if (f[pi] >= 0) return { field: f, target: 'exit' };
    }
    const kseeds = [];
    for (const kt of mem.keyTiles) {
      if ((kt.kind === 'r' && !keys.red) || (kt.kind === 'b' && !keys.blue)) kseeds.push([kt.x, kt.y]);
    }
    if (kseeds.length) {
      const f = bfsKnownField(mem, level, kseeds, keys);
      if (f[pi] >= 0) return { field: f, target: 'key' };
    }
    return { field: null, target: 'none' };
  }

  function knownGoalDistAt(goal, level, x, y) {
    if (!goal || !goal.field) return -1;
    const ix = x | 0, iy = y | 0;
    if (ix < 0 || iy < 0 || ix >= level.w || iy >= level.h) return -1;
    return goal.field[iy * level.w + ix];
  }

  // 「見つけた回復・アーマー」までの距離場。HPが減っているときの誘導用。
  // v1 の決定打だった「補給物資へのBFS勾配」(地図オラクル) のフォグ版で、
  // 記憶にあるアイテムしか対象にしないのでカンニングではない。
  const HEAL2_KINDS = 'hH', ARMOR2_KINDS = 'pV';
  function computeHealField(world, mem) {
    const level = world.level, p = world.player;
    const seeds = [];
    const wantHeal = p.health < 100, wantArmor = p.armor < ARMOR_MAX;
    for (let y = 0; y < level.h; y++) {
      for (let x = 0; x < level.w; x++) {
        const i = y * level.w + x;
        if (!mem.itemSeen[i]) continue;
        const kind = String.fromCharCode(mem.itemKind[i]);
        if ((wantHeal && HEAL2_KINDS.includes(kind)) || (wantArmor && ARMOR2_KINDS.includes(kind))) {
          seeds.push([x, y]);
        }
      }
    }
    if (!seeds.length) return { field: null, target: 'none' };
    return { field: bfsKnownField(mem, level, seeds, p.keys), target: 'heal' };
  }

  // フロンティア (= 未知の隣接タイルを持つ既知の床) までの距離場。
  // 「新タイル発見」報酬は発見の瞬間にしか出ず、次のフロンティアまで既知の通路を
  // 歩く区間が報酬の砂漠になる (実測: 探索がループして停滞する)。この場で
  // ポテンシャル整形をかけて、砂漠の全区間に「未知へ向かう」勾配を立てる。
  // 自分が見たタイルの地図から計算するので、カンニングではない (Lv1 の線引き)。
  function computeFrontierField(world, mem) {
    const level = world.level, keys = world.player.keys;
    const w = level.w, h = level.h, known = mem.known;
    const seeds = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!known[i] || !knownWalkable(mem, level, x, y, keys)) continue;
        if ((x > 0 && !known[i - 1]) || (x < w - 1 && !known[i + 1]) ||
            (y > 0 && !known[i - w]) || (y < h - 1 && !known[i + w])) {
          seeds.push([x, y]);
        }
      }
    }
    if (!seeds.length) return { field: null, target: 'none' };   // 全て探索済み
    return { field: bfsKnownField(mem, level, seeds, keys), target: 'frontier' };
  }

  // ======================= レイ (v1 と同じ・正当ブロック) =======================

  function rayWall2(world, x, y, dx, dy) {
    const level = world.level;
    const eyeZ = world.player.z + EYE;
    let mapX = x | 0, mapY = y | 0;
    const deltaX = mAbs(1 / dx), deltaY = mAbs(1 / dy);
    let stepX, stepY, sideX, sideY;
    if (dx < 0) { stepX = -1; sideX = (x - mapX) * deltaX; }
    else { stepX = 1; sideX = (mapX + 1 - x) * deltaX; }
    if (dy < 0) { stepY = -1; sideY = (y - mapY) * deltaY; }
    else { stepY = 1; sideY = (mapY + 1 - y) * deltaY; }
    for (let i = 0; i < 128; i++) {
      let t;
      if (sideX < sideY) { t = sideX; sideX += deltaX; mapX += stepX; }
      else { t = sideY; sideY += deltaY; mapY += stepY; }
      if (t > MAX_D) return { dist: MAX_D, ch: null };
      if (isSolid(level, mapX + 0.5, mapY + 0.5)) return { dist: t, ch: cellAt(level, mapX, mapY) };
      if (floorHt(level, mapX, mapY) > eyeZ) return { dist: t, ch: null };
    }
    return { dist: MAX_D, ch: null };
  }

  // ======================= 観測ベクトル =======================

  // mem: ExploreMemory / goal: computeKnownGoal() の結果 (env2 がキャッシュして渡す)
  function buildObs2(world, mem, goal, out) {
    const o = out || new Float32Array(OBS2_DIM);
    o.fill(0);
    const p = world.player, level = world.level;

    // ---- rays (v1 と同一) ----
    for (let i = 0; i < N_RAYS; i++) {
      const camX = 2 * (i + 0.5) / N_RAYS - 1;
      let dx = p.dirX + p.planeX * camX, dy = p.dirY + p.planeY * camX;
      const len = mHypot(dx, dy); dx /= len; dy /= len;
      const b = RAYS_OFF + i * RAY_CH;
      const hit = rayWall2(world, p.x, p.y, dx, dy);
      o[b + 0] = hit.dist / MAX_D;
      o[b + 1] = hit.ch === 'D' ? 1 : 0;
      // 「まだ開かないもの」チャネル: キー未所持の施錠ドア + キルゲート中の出口
      const gated = level.killGate && level.kills < level.killGate;
      o[b + 2] = (hit.ch === 'R' && !p.keys.red) || (hit.ch === 'B' && !p.keys.blue) ||
                 (hit.ch === 'X' && gated) ? 1 : 0;
      o[b + 3] = hit.ch === 'X' ? 1 : 0;
      o[b + 4] = 1;
      o[b + 11] = 1;
      o[b + 14] = 1;
      o[b + 15] = 1;   // 飛翔弾までの距離 (1 = ない)
    }

    const invDet = 1 / (p.planeX * p.dirY - p.dirX * p.planeY);
    const rayOf = (x, y) => {
      const rx = x - p.x, ry = y - p.y;
      const ty = invDet * (-p.planeY * rx + p.planeX * ry);
      if (ty <= 0.15) return -1;
      const s = invDet * (p.dirY * rx - p.dirX * ry) / ty;
      if (s < -1 || s > 1) return -1;
      const idx = ((s + 1) / 2 * N_RAYS) | 0;
      return idx < 0 ? 0 : idx >= N_RAYS ? N_RAYS - 1 : idx;
    };

    for (const e of level.enemies) {
      if (e.dormant || e.state === 'dead') continue;
      const i = rayOf(e.x, e.y);
      if (i < 0) continue;
      const d = mHypot(e.x - p.x, e.y - p.y);
      if (d > MAX_D) continue;
      const b = RAYS_OFF + i * RAY_CH;
      const nd = d / MAX_D;
      if (nd >= o[b + 4]) continue;
      if (!world.hasLineOfSight(p.x, p.y, e.x, e.y, p.z + EYE, e.z + EYE)) continue;
      o[b + 4] = nd;
      for (let k = 0; k < 6; k++) o[b + 5 + k] = 0;
      o[b + 5 + ENEMY_ORDER.indexOf(e.type)] = 1;
    }

    for (const it of level.items) {
      const i = rayOf(it.x, it.y);
      if (i < 0) continue;
      const d = mHypot(it.x - p.x, it.y - p.y);
      if (d > MAX_D) continue;
      const b = RAYS_OFF + i * RAY_CH;
      const nd = d / MAX_D;
      if (nd >= o[b + 11]) continue;
      if (!world.hasLineOfSight(p.x, p.y, it.x, it.y, p.z + EYE, it.z + 0.3)) continue;
      o[b + 11] = nd;
      o[b + 12] = SUPPLY_ITEMS.includes(it.kind) ? 1 : 0;
      o[b + 13] = KEY_ITEMS.includes(it.kind) ? 1 : 0;
    }

    for (const br of level.barrels) {
      if (br.dead) continue;
      const i = rayOf(br.x, br.y);
      if (i < 0) continue;
      const d = mHypot(br.x - p.x, br.y - p.y);
      if (d > MAX_D) continue;
      const b = RAYS_OFF + i * RAY_CH;
      const nd = d / MAX_D;
      if (nd < o[b + 14]) o[b + 14] = nd;
    }

    // 飛翔中の弾 (火球など)。画面に見えるものなので観測に出すのは正当。
    // ch15 = 最も近い弾までの距離、ch16 = その弾の接近速度 (正 = 向かってくる)
    for (const pr of level.projectiles) {
      const i = rayOf(pr.x, pr.y);
      if (i < 0) continue;
      const d = mHypot(pr.x - p.x, pr.y - p.y);
      if (d > MAX_D) continue;
      const b = RAYS_OFF + i * RAY_CH;
      const nd = d / MAX_D;
      if (nd >= o[b + 15]) continue;
      if (!world.hasLineOfSight(p.x, p.y, pr.x, pr.y, p.z + EYE, pr.z)) continue;
      o[b + 15] = nd;
      const closing = d > 0.01 ? -((pr.x - p.x) * pr.dx + (pr.y - p.y) * pr.dy) / d / PROJ_MAX_SPEED : 1;
      o[b + 16] = closing < -1 ? -1 : closing > 1 ? 1 : closing;
    }

    // ---- local: 自己中心の既知マップ (進行方向が上) ----
    //  ch0 未探索  ch1 壁  ch2 床  ch3 ドア(0.5=施錠中)  ch4 水  ch5 床の高さ
    //  ch6 最後に見た敵(時間で減衰)  ch7 見たアイテム  ch8 出口スイッチ
    const half = (LOCAL - 1) / 2;
    const rgtX = -p.dirY, rgtY = p.dirX;
    const plane = LOCAL * LOCAL;
    for (let gy = 0; gy < LOCAL; gy++) {
      for (let gx = 0; gx < LOCAL; gx++) {
        const fwd = half - gy, rgt = gx - half;
        const wx = (p.x + p.dirX * fwd + rgtX * rgt) | 0;
        const wy = (p.y + p.dirY * fwd + rgtY * rgt) | 0;
        const c = LOCAL_OFF + gy * LOCAL + gx;
        if (wx < 0 || wy < 0 || wx >= level.w || wy >= level.h) { o[c] = 1; continue; } // 場外 = 未探索
        const ti = wy * level.w + wx;
        if (!mem.known[ti]) { o[c] = 1; continue; }
        const ch = level.grid[wy][wx];
        if (ch === null) {
          o[c + 2 * plane] = 1;
          o[c + 4 * plane] = level.water[wy][wx] ? 1 : 0;
          o[c + 5 * plane] = mMin(1, level.heights[wy][wx] / 2);
        } else if (ch === 'D') {
          o[c + 3 * plane] = 1;
        } else if (ch === 'R') {
          o[c + 3 * plane] = p.keys.red ? 1 : 0.5;
        } else if (ch === 'B') {
          o[c + 3 * plane] = p.keys.blue ? 1 : 0.5;
        } else {
          o[c + 1 * plane] = 1;                       // '#' '&' '=' '*' は壁 ('*' は秘密のまま)
          // 出口は壁 + 出口チャネル。キルゲート中は 0.5 (施錠ドアの表現と同じ流儀)
          if (ch === 'X') {
            o[c + 8 * plane] = level.killGate && level.kills < level.killGate ? 0.5 : 1;
          }
        }
        const et = mem.enemyT[ti];
        if (et >= 0) o[c + 6 * plane] = mMax(0, 1 - (level.time - et) / ENEMY_MEMORY_S);
        if (mem.itemSeen[ti]) o[c + 7 * plane] = 1;
      }
    }

    // ---- global: レベル全体の粗い既知マップ (絶対座標・北が上) ----
    //  ch0 未探索率  ch1 壁  ch2 見たアイテム  ch3 軌跡(訪問回数)  ch4 見た出口
    //  ch5 自機 (1=位置, 0.5=向いている方向の隣セル)
    // タイル→セルの対応 (mem.cellOf) は init で前計算済み。タイルを1回なめるだけ
    const gplane = GLOB * GLOB;
    const cellOf = mem.cellOf, known = mem.known, itemSeen = mem.itemSeen, mvisits = mem.visits;
    for (let y = 0; y < level.h; y++) {
      const row = level.grid[y];
      const base = y * level.w;
      for (let x = 0; x < level.w; x++) {
        const ti = base + x;
        const c = GLOB_OFF + cellOf[ti];
        if (!known[ti]) { o[c] += 1; continue; }   // 後段でセル内タイル数で割る
        const ch = row[x];
        if (ch === 'X') o[c + 4 * gplane] = 1;
        else if (ch !== null && ch !== 'D' && ch !== 'R' && ch !== 'B') o[c + 1 * gplane] = 1;
        if (itemSeen[ti]) o[c + 2 * gplane] = 1;
        const v = mvisits[ti];
        if (v > 0) {
          const t = c + 3 * gplane;
          const nv = v >= 8 ? 1 : v / 8;
          if (nv > o[t]) o[t] = nv;
        }
      }
    }
    for (let i = 0; i < gplane; i++) {             // 未探索カウント → 率
      const cnt = mem.cellCnt[i];
      if (cnt > 1 && o[GLOB_OFF + i] > 0) o[GLOB_OFF + i] /= cnt;
    }
    const gs = mem.gScale;
    const pgx = mMin(GLOB - 1, (p.x / gs) | 0), pgy = mMin(GLOB - 1, (p.y / gs) | 0);
    o[GLOB_OFF + 5 * gplane + pgy * GLOB + pgx] = 1;
    const fgx = mMin(GLOB - 1, mMax(0, ((p.x + p.dirX * 1.5) / gs) | 0));
    const fgy = mMin(GLOB - 1, mMax(0, ((p.y + p.dirY * 1.5) / gs) | 0));
    const fc = GLOB_OFF + 5 * gplane + fgy * GLOB + fgx;
    if (o[fc] < 0.5) o[fc] = 0.5;

    // ---- scalars ----
    const s = SC_OFF, lv = level;
    const gd = knownGoalDistAt(goal, lv, p.x, p.y);
    o[s + 0] = p.health / 100;
    o[s + 1] = p.armor / ARMOR_MAX;
    o[s + 2] = mMin(1, p.bullets / 50);
    o[s + 3] = mMin(1, p.shells / 20);
    o[s + 4] = p.hasShotgun ? 1 : 0;
    o[s + 5] = p.weapon === 'pistol' ? 1 : 0;
    o[s + 6] = p.weapon === 'shotgun' ? 1 : 0;
    o[s + 7] = p.weapon === 'knife' ? 1 : 0;
    o[s + 8] = mMin(1, p.shootCd);
    o[s + 9] = p.pitch / PITCH_MAX;
    o[s + 10] = p.keys.red ? 1 : 0;
    o[s + 11] = p.keys.blue ? 1 : 0;
    o[s + 12] = mem.totalFloor ? mem.knownFloor / mem.totalFloor : 1;   // 探索率
    o[s + 13] = mMin(1, (mem.stepNo - mem.lastNewStep) / 100);      // 新発見からの経過
    o[s + 14] = mem.exits.length ? 1 : 0;                               // 出口を見つけたか
    o[s + 15] = gd < 0 ? 1 : mMin(1, gd / 40);                      // 目標までの歩数 (既知マップ)
    o[s + 16] = gd >= 0 ? 1 : 0;                                        // 目標へ到達可能か
    o[s + 17] = mem.seenRed ? 1 : 0;
    o[s + 18] = mem.seenBlue ? 1 : 0;
    o[s + 19] = goal && goal.target === 'key' ? 1 : 0;
    o[s + 20] = mMin(1, p.z / 2);
    o[s + 21] = mMin(1, lv.time / 300);

    // 最寄りの「見えている」敵 (v1 と同一)
    let nd = Infinity, nx = 0, ny = 0;
    for (const e of lv.enemies) {
      if (e.dormant || e.state === 'dead') continue;
      const d = mHypot(e.x - p.x, e.y - p.y);
      if (d >= nd || d > 16) continue;
      if (!world.hasLineOfSight(p.x, p.y, e.x, e.y, p.z + EYE, e.z + EYE)) continue;
      nd = d; nx = e.x - p.x; ny = e.y - p.y;
    }
    if (nd === Infinity) {
      o[s + 22] = 1; o[s + 23] = 0; o[s + 24] = 0;
    } else {
      o[s + 22] = nd / 16;
      o[s + 23] = (nx * rgtX + ny * rgtY) / nd;
      o[s + 24] = (nx * p.dirX + ny * p.dirY) / nd;
    }

    // 最後に受けた攻撃 (v3)。人間の「痛みと被弾方向の感覚」に相当し、
    // 「視野外から撃たれた → 攻撃源の方を向く」を学習可能にする。
    // 数秒で減衰し、方向 (自機基準 sin/cos) も同じ重みで薄れる
    const lh = p.lastHit;
    if (lh) {
      const decay = mMax(0, 1 - (world.time - lh.t) / HIT_MEMORY_S);
      if (decay > 0) {
        const hx = lh.x - p.x, hy = lh.y - p.y;
        const hd = mHypot(hx, hy) || 1;
        o[s + 25] = decay * mMin(1, lh.dmg / 25);
        o[s + 26] = decay * ((hx * rgtX + hy * rgtY) / hd);
        o[s + 27] = decay * ((hx * p.dirX + hy * p.dirY) / hd);
      }
    }

    return o;
  }

  Object.assign(globalThis, {
    OBS2_DIM, ExploreMemory, buildObs2, computeKnownGoal, knownGoalDistAt,
    computeFrontierField, computeHealField,
    OBS2_LAYOUT: {
      rays: [N_RAYS, RAY_CH], local: [LOCAL, LOCAL, LOCAL_CH],
      global: [GLOB, GLOB, GLOB_CH], scalars: N_SCALARS,
    },
  });
})();
