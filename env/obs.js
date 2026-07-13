'use strict';
/* =========================================================================
 * 観測 (エージェントに見せるもの)
 *
 * このゲームはレイキャスターなので、画面を描いてCNNに見せなくても、
 * レイが何に当たったかを直接ベクトルにすれば「見えているもの」とほぼ等価になる。
 * 描画コストがゼロになるぶん学習が2〜3桁速い。
 *
 *   rays    24本 x 15ch : 視界内の壁・ドア・出口・敵・アイテム・樽の距離と種別
 *   grid    11x11 x 7ch : 自己中心(進行方向を上に回転)の局所マップ
 *   scalars 24          : HP・弾・武器・キー・出口までの距離 など
 *
 * grid の最後のチャネルは「出口までのBFS距離の勾配」で、これが探索の背骨になる。
 * ========================================================================= */

const N_RAYS = 24;
const RAY_CH = 15;
const GRID = 11, GRID_CH = 9;    // ch7/ch8 = 回復・弾薬への勾配 (後述)
const N_SCALARS = 28;

const RAYS_DIM = N_RAYS * RAY_CH;          // 360
const GRID_DIM = GRID * GRID * GRID_CH;    // 847
const OBS_DIM = RAYS_DIM + GRID_DIM + N_SCALARS; // 1231

const RAYS_OFF = 0;
const GRID_OFF = RAYS_DIM;
const SCALARS_OFF = RAYS_DIM + GRID_DIM;

const MAX_D = 24;                          // 距離の正規化に使う上限(タイル)
const ENEMY_ORDER = ['zombie', 'sergeant', 'imp', 'demon', 'knight', 'floater'];
const SUPPLY_ITEMS = 'hHaAsSpV';           // 補給品(回復・弾・アーマー・武器)
const KEY_ITEMS = 'rb';

// ======================= 出口までの距離場 (BFS) =======================

// BFS 用の通行判定。ドアは「開けられるなら通れる」扱い。隠し扉('*')は壁のまま
// (見た目がただの壁なので、エージェントに教えるのはカンニングになる)
function bfsWalkable(level, x, y, keys) {
  const ch = level.grid[y][x];
  if (ch === null) return !level.water[y][x];
  if (ch === 'D') return true;
  if (ch === 'R') return !!keys.red;
  if (ch === 'B') return !!keys.blue;
  return false; // '#' '&' '=' 'X' '*'
}

function bfsHeight(level, x, y) {
  return level.lift[y][x] ? 0 : level.heights[y][x]; // リフトは下りてくるので0扱い
}

// seeds から逆向きに幅優先探索して、各タイルから seeds までの歩数を求める。
// 段差は登れる高さ(STEP_MAX)までしか遡らない = 実際に歩ける経路だけを数える。
function bfsField(level, seeds, keys) {
  const w = level.w, h = level.h;
  const dist = new Int16Array(w * h).fill(-1);
  const q = [];
  for (const [x, y] of seeds) {
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = y * w + x;
    if (dist[i] < 0 && bfsWalkable(level, x, y, keys)) { dist[i] = 0; q.push(i); }
  }
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi], cx = c % w, cy = (c / w) | 0;
    const hb = bfsHeight(level, cx, cy);
    for (const [dx, dy] of NB) {
      const ax = cx + dx, ay = cy + dy;
      if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue;
      const k = ay * w + ax;
      if (dist[k] >= 0 || !bfsWalkable(level, ax, ay, keys)) continue;
      if (hb - bfsHeight(level, ax, ay) > STEP_MAX) continue; // a から b へ登れない
      dist[k] = dist[c] + 1;
      q.push(k);
    }
  }
  return dist;
}

// 現在の目標までの距離場。出口へ行けないなら、足りないキーカードを目標にする。
// キーを拾ったとき / ステージが変わったときだけ作り直せばよい。
function computeGoalField(world) {
  const level = world.level, keys = world.player.keys;
  const exits = [];
  for (let y = 0; y < level.h; y++) {
    for (let x = 0; x < level.w; x++) {
      if (level.grid[y][x] === 'X') exits.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }
  const pi = (world.player.y | 0) * level.w + (world.player.x | 0);
  const toExit = bfsField(level, exits, keys);
  if (toExit[pi] >= 0) return { field: toExit, target: 'exit' };

  // 出口が施錠ドアの向こう側 → まだ持っていないキーカードを目標にする
  const keySeeds = [];
  for (const it of level.items) {
    if (it.kind === 'r' && !keys.red) keySeeds.push([it.x | 0, it.y | 0]);
    if (it.kind === 'b' && !keys.blue) keySeeds.push([it.x | 0, it.y | 0]);
  }
  if (keySeeds.length) {
    const toKey = bfsField(level, keySeeds, keys);
    if (toKey[pi] >= 0) return { field: toKey, target: 'key' };
  }
  return { field: toExit, target: 'unreachable' };
}

function goalDistAt(goal, level, x, y) {
  const ix = x | 0, iy = y | 0;
  if (ix < 0 || iy < 0 || ix >= level.w || iy >= level.h) return -1;
  return goal.field[iy * level.w + ix];
}

// ======================= 補給物資までの距離場 =======================
// 出口までのBFSしか持たせていなかったせいで、エージェントは「視界の外にある回復
// アイテムを探しに行く」ことが原理的にできなかった (レイと11x11グリッドに入って
// 初めて見える)。通しで必ずジリ貧になっていた根本原因。出口と同じ仕組みで
// 「いま自分に必要な補給物資」への勾配を作る。
const HEAL_KINDS = 'hHpV';   // 回復・アーマー
const AMMO_KINDS = 'aAsS';   // 弾・シェル・ショットガン

// いま「拾う価値がある」物資だけを種にする。満タンなら種はゼロ = 場は存在しない
function computeSupplyField(world, kinds) {
  const level = world.level, p = world.player;
  const seeds = [];
  for (const it of level.items) {
    if (!kinds.includes(it.kind)) continue;
    if (!ITEM_TYPES[it.kind].need(p)) continue;
    seeds.push([it.x | 0, it.y | 0]);
  }
  if (!seeds.length) return { field: null, exists: false };
  return { field: bfsField(level, seeds, p.keys), exists: true };
}

function supplyDistAt(sup, level, x, y) {
  if (!sup.field) return -1;
  const ix = x | 0, iy = y | 0;
  if (ix < 0 || iy < 0 || ix >= level.w || iy >= level.h) return -1;
  return sup.field[iy * level.w + ix];
}

// 場を作り直すべきか判断するための署名。アイテムを拾った / 満タンになった /
// キーカードを取った (通れる場所が変わる) ときだけ作り直せばよい
function supplySignature(world) {
  const p = world.player, lv = world.level;
  return `${lv.items.length}|${p.health < 100 ? 1 : 0}|${p.armor < ARMOR_MAX ? 1 : 0}` +
    `|${p.bullets < 200 ? 1 : 0}|${p.shells < 50 ? 1 : 0}|${p.hasShotgun ? 1 : 0}` +
    `|${p.keys.red ? 1 : 0}${p.keys.blue ? 1 : 0}`;
}

// ======================= レイ =======================

// 壁(閉じたドア含む)か、視線を遮る段差に当たるまで進む
function rayWall(world, x, y, dx, dy) {
  const level = world.level;
  const eyeZ = world.player.z + EYE;
  let mapX = x | 0, mapY = y | 0;
  const deltaX = Math.abs(1 / dx), deltaY = Math.abs(1 / dy);
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
    if (floorHt(level, mapX, mapY) > eyeZ) return { dist: t, ch: null }; // 段差に視界を遮られた
  }
  return { dist: MAX_D, ch: null };
}

// ======================= 観測ベクトル =======================

// supply: { heal, ammo } — computeSupplyField() の結果。env.js がキャッシュして渡す
function buildObs(world, goal, out, supply) {
  const o = out || new Float32Array(OBS_DIM);
  o.fill(0);
  const p = world.player, level = world.level;
  const heal = (supply && supply.heal) || { field: null, exists: false };
  const ammo = (supply && supply.ammo) || { field: null, exists: false };

  // ---- rays ----
  for (let i = 0; i < N_RAYS; i++) {
    const camX = 2 * (i + 0.5) / N_RAYS - 1;
    let dx = p.dirX + p.planeX * camX, dy = p.dirY + p.planeY * camX;
    const len = Math.hypot(dx, dy); dx /= len; dy /= len;
    const b = RAYS_OFF + i * RAY_CH;
    const hit = rayWall(world, p.x, p.y, dx, dy);
    o[b + 0] = hit.dist / MAX_D;
    o[b + 1] = hit.ch === 'D' ? 1 : 0;
    o[b + 2] = (hit.ch === 'R' && !p.keys.red) || (hit.ch === 'B' && !p.keys.blue) ? 1 : 0;
    o[b + 3] = hit.ch === 'X' ? 1 : 0;
    o[b + 4] = 1;   // 敵までの距離 (1 = 見えない)
    o[b + 11] = 1;  // アイテムまでの距離
    o[b + 14] = 1;  // 樽までの距離
  }

  // 敵・アイテム・樽は「カメラ平面に射影してレイ番号に落とす」ほうが、
  // レイごとに全部をなめるより速い (O(n) で済む)
  const invDet = 1 / (p.planeX * p.dirY - p.dirX * p.planeY);
  const rayOf = (x, y) => {
    const rx = x - p.x, ry = y - p.y;
    const ty = invDet * (-p.planeY * rx + p.planeX * ry); // 奥行き
    if (ty <= 0.15) return -1;
    const s = invDet * (p.dirY * rx - p.dirX * ry) / ty;  // -1..1 が画面内
    if (s < -1 || s > 1) return -1;
    const idx = ((s + 1) / 2 * N_RAYS) | 0;
    return idx < 0 ? 0 : idx >= N_RAYS ? N_RAYS - 1 : idx;
  };

  for (const e of level.enemies) {
    if (e.dormant || e.state === 'dead') continue;
    const i = rayOf(e.x, e.y);
    if (i < 0) continue;
    const d = Math.hypot(e.x - p.x, e.y - p.y);
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
    const d = Math.hypot(it.x - p.x, it.y - p.y);
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
    const d = Math.hypot(br.x - p.x, br.y - p.y);
    if (d > MAX_D) continue;
    const b = RAYS_OFF + i * RAY_CH;
    const nd = d / MAX_D;
    if (nd < o[b + 14]) o[b + 14] = nd;
  }

  // ---- grid (自己中心・進行方向が上) ----
  // 敵とアイテムのタイル分布を先に作る
  const wh = level.w * level.h;
  const eMap = gridScratch.e.length === wh ? gridScratch.e.fill(0) : (gridScratch.e = new Float32Array(wh));
  const iMap = gridScratch.i.length === wh ? gridScratch.i.fill(0) : (gridScratch.i = new Float32Array(wh));
  for (const e of level.enemies) {
    if (e.dormant || e.state === 'dead') continue;
    eMap[(e.y | 0) * level.w + (e.x | 0)] = 1;
  }
  for (const it of level.items) iMap[(it.y | 0) * level.w + (it.x | 0)] = 1;
  for (const br of level.barrels) {
    if (!br.dead) iMap[br.my * level.w + br.mx] = Math.max(iMap[br.my * level.w + br.mx], 0.5);
  }

  const half = (GRID - 1) / 2;
  const rgtX = -p.dirY, rgtY = p.dirX;     // 右手方向 (KeyD の向き)
  const pd = goalDistAt(goal, level, p.x, p.y);
  const phd = supplyDistAt(heal, level, p.x, p.y);   // 回復までの歩数 (自分の位置)
  const pad = supplyDistAt(ammo, level, p.x, p.y);   // 弾薬まで
  const plane = GRID * GRID;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const fwd = half - gy, rgt = gx - half;
      const wx = (p.x + p.dirX * fwd + rgtX * rgt) | 0;
      const wy = (p.y + p.dirY * fwd + rgtY * rgt) | 0;
      const c = GRID_OFF + gy * GRID + gx;
      if (wx < 0 || wy < 0 || wx >= level.w || wy >= level.h) { o[c] = 1; continue; } // 場外は壁
      const ch = level.grid[wy][wx];
      if (ch === null) {
        o[c + 2 * plane] = level.water[wy][wx] ? 1 : 0;
        o[c + 3 * plane] = Math.min(1, level.heights[wy][wx] / 2);
        o[c + 4 * plane] = eMap[wy * level.w + wx];
        o[c + 5 * plane] = iMap[wy * level.w + wx];
      } else if (ch === 'D') {
        o[c + 1 * plane] = 1;
      } else if (ch === 'R') {
        o[c + 1 * plane] = p.keys.red ? 1 : 0.5;   // 0.5 = 施錠中(キーがない)
      } else if (ch === 'B') {
        o[c + 1 * plane] = p.keys.blue ? 1 : 0.5;
      } else {
        o[c] = 1; // '#' '&' '=' 'X' '*' (隠し扉は壁のまま = カンニングさせない)
      }
      // 出口(または目標のキー)までの距離の勾配。正 = 目標に近づく向き
      const td = goalDistAt(goal, level, wx, wy);
      o[c + 6 * plane] = (td < 0 || pd < 0) ? -1 : clamp((pd - td) / 8, -1, 1);
      // 同じ要領で「いま必要な回復」「いま必要な弾薬」への勾配。
      // 満タンなら場そのものが存在しないので、全面 -1 (= 探す先がない) になる
      const hd = supplyDistAt(heal, level, wx, wy);
      o[c + 7 * plane] = (hd < 0 || phd < 0) ? -1 : clamp((phd - hd) / 8, -1, 1);
      const ad = supplyDistAt(ammo, level, wx, wy);
      o[c + 8 * plane] = (ad < 0 || pad < 0) ? -1 : clamp((pad - ad) / 8, -1, 1);
    }
  }

  // ---- scalars ----
  const s = SCALARS_OFF;
  const lv = level;
  o[s + 0] = p.health / 100;
  o[s + 1] = p.armor / ARMOR_MAX;
  o[s + 2] = Math.min(1, p.bullets / 50);
  o[s + 3] = Math.min(1, p.shells / 20);
  o[s + 4] = p.hasShotgun ? 1 : 0;
  o[s + 5] = p.weapon === 'pistol' ? 1 : 0;
  o[s + 6] = p.weapon === 'shotgun' ? 1 : 0;
  o[s + 7] = p.weapon === 'knife' ? 1 : 0;
  o[s + 8] = Math.min(1, p.shootCd);
  o[s + 9] = p.pitch / PITCH_MAX;
  o[s + 10] = p.keys.red ? 1 : 0;
  o[s + 11] = p.keys.blue ? 1 : 0;
  o[s + 12] = lv.meta.hasRedDoor ? 1 : 0;
  o[s + 13] = lv.meta.hasBlueDoor ? 1 : 0;
  o[s + 14] = pd < 0 ? 1 : Math.min(1, pd / 40);
  o[s + 15] = pd < 0 ? 0 : 1;
  o[s + 16] = goal.target === 'key' ? 1 : 0;
  o[s + 17] = lv.totalKills ? lv.kills / lv.totalKills : 1;
  o[s + 18] = lv.totalItems ? lv.itemsGot / lv.totalItems : 1;
  o[s + 19] = Math.min(1, p.z / 2);
  o[s + 20] = Math.min(1, lv.time / 300);

  // 最寄りの「見えている」敵の距離と方位
  let nd = Infinity, nx = 0, ny = 0;
  for (const e of lv.enemies) {
    if (e.dormant || e.state === 'dead') continue;
    const d = Math.hypot(e.x - p.x, e.y - p.y);
    if (d >= nd || d > 16) continue;
    if (!world.hasLineOfSight(p.x, p.y, e.x, e.y, p.z + EYE, e.z + EYE)) continue;
    nd = d; nx = e.x - p.x; ny = e.y - p.y;
  }
  if (nd === Infinity) {
    o[s + 21] = 1; o[s + 22] = 0; o[s + 23] = 0;
  } else {
    o[s + 21] = nd / 16;
    // 自機基準の方位 (前方 = cos=1)
    o[s + 22] = (nx * rgtX + ny * rgtY) / nd;  // sin: 右が正
    o[s + 23] = (nx * p.dirX + ny * p.dirY) / nd; // cos: 前が正
  }

  // 補給物資までの残り歩数。「HPが減った → 回復はどこだ」を判断できるようにする
  o[s + 24] = phd < 0 ? 1 : Math.min(1, phd / 40);
  o[s + 25] = phd < 0 ? 0 : 1;   // 到達できる回復があるか
  o[s + 26] = pad < 0 ? 1 : Math.min(1, pad / 40);
  o[s + 27] = pad < 0 ? 0 : 1;   // 到達できる弾薬があるか

  return o;
}

const gridScratch = { e: new Float32Array(0), i: new Float32Array(0) };

// ステージ固有のメタ情報 (毎ステップ数えなくて済むよう loadLevel 後に1回)
function levelMeta(level) {
  let hasRedDoor = false, hasBlueDoor = false, exits = 0;
  for (let y = 0; y < level.h; y++) {
    for (let x = 0; x < level.w; x++) {
      const ch = level.grid[y][x];
      if (ch === 'R') hasRedDoor = true;
      else if (ch === 'B') hasBlueDoor = true;
      else if (ch === 'X') exits++;
    }
  }
  return { hasRedDoor, hasBlueDoor, exits };
}

Object.assign(globalThis, {
  N_RAYS, RAY_CH, GRID, GRID_CH, N_SCALARS,
  RAYS_DIM, GRID_DIM, OBS_DIM, RAYS_OFF, GRID_OFF, SCALARS_OFF,
  buildObs, computeGoalField, goalDistAt, levelMeta,
  computeSupplyField, supplyDistAt, supplySignature, HEAL_KINDS, AMMO_KINDS,
});
