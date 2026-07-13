'use strict';
/* 探索版 (env2) の検証: node tools/env2-test.cjs
 *   1. 迷路生成: 形式・出口への到達可能性・決定性
 *   2. フォグ・オブ・ウォー: 開始時に全マップが見えていないこと
 *   3. 環境の決定性: 同じシード + 同じ行動列 → 同じ報酬列・同じ観測
 *   4. 観測の健全性: NaN / 値域
 *   5. 台本プレイ: 最短経路を歩かせて「探索報酬で黒字 → 出口発見 → クリア」まで通す
 *   6. ランダム方策の基準値: クリア率が 0% でないこと (学習の立ち上がりに必須)
 */
const { createEnvContext2 } = require('../env/sim-loader.cjs');
const ctx = createEnvContext2();
const { HellgridEnv2, OBS2_DIM, OBS2_LAYOUT, ACTION_NVEC2, generateMaze } = ctx;

let failures = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? 'OK ' : 'NG '} ${label}`);
  if (!cond) failures++;
};

console.log(`観測次元: ${OBS2_DIM}  (rays ${OBS2_LAYOUT.rays.join('x')} + local ${OBS2_LAYOUT.local.join('x')} + global ${OBS2_LAYOUT.global.join('x')} + scalars ${OBS2_LAYOUT.scalars})`);

// ---- 1. 迷路生成 ----
console.log('\n[1] 迷路生成 (50シード, size=11):');
{
  // マップ全域の素朴なBFS (テスト専用。env側の実装には依存しない)
  const bfs = (map, sx, sy) => {
    const h = map.length, w = map[0].length;
    const dist = new Int16Array(w * h).fill(-1);
    dist[sy * w + sx] = 0;
    const q = [sy * w + sx];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi], cx = c % w, cy = (c / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ax = cx + dx, ay = cy + dy;
        if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue;
        const ch = map[ay][ax];
        if (ch === '#' || ch === 'X' || dist[ay * w + ax] >= 0) continue;
        dist[ay * w + ax] = dist[c] + 1;
        q.push(ay * w + ax);
      }
    }
    return dist;
  };
  const checkConfig = (label, opts) => {
    let allOk = true, minD = Infinity, maxD = -Infinity, sumD = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const def = generateMaze(seed, opts);
      const map = def.map, w = map[0].length;
      if (!map.every(r => r.length === w)) { allOk = false; break; }
      const px = map.join('').indexOf('P');
      const nX = map.join('').split('X').length - 1;
      if (px < 0 || nX !== 1) { allOk = false; break; }
      const sx = px % w, sy = (px / w) | 0;
      const dist = bfs(map, sx, sy);
      // 出口スイッチの隣の床に届くか
      const xi = map.join('').indexOf('X'), ex = xi % w, ey = (xi / w) | 0;
      let reach = -1;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ax = ex + dx, ay = ey + dy;
        if (ax < 0 || ay < 0 || ax >= w || ay >= map.length) continue;
        const d = dist[ay * w + ax];
        if (d >= 0 && (reach < 0 || d < reach)) reach = d;
      }
      // 全床タイルが P から到達可能か (部屋の彫り込みで孤立が生まれていないか)
      let isolated = 0;
      for (let y = 0; y < map.length; y++) {
        for (let x = 0; x < w; x++) {
          if (!'#X'.includes(map[y][x]) && dist[y * w + x] < 0) isolated++;
        }
      }
      if (reach < 0 || isolated > 0) { allOk = false; break; }
      minD = Math.min(minD, reach); maxD = Math.max(maxD, reach); sumD += reach;
    }
    ok(allOk, `${label}: 50迷路すべて 行長一致・P/X 1個・出口到達可能・孤立床なし`);
    console.log(`      出口までの歩数: 最小 ${minD}  平均 ${(sumD / 50).toFixed(1)}  最大 ${maxD}`);
  };
  checkConfig('11x11 素の迷路          ', { size: 11 });
  checkConfig('15x15 braid=0.15        ', { size: 15, braid: 0.15 });
  checkConfig('21x21 braid+部屋5個     ', { size: 21, braid: 0.15, rooms: 5 });
  checkConfig('25x25 braid+部屋7個     ', { size: 25, braid: 0.15, rooms: 7 });
  const a = generateMaze(7, { size: 11 }).map.join('\n');
  const b = generateMaze(7, { size: 11 }).map.join('\n');
  const c = generateMaze(8, { size: 11 }).map.join('\n');
  ok(a === b, '同じシード → 同じ迷路');
  ok(a !== c, '違うシード → 違う迷路');
}

// ---- 2. フォグ・オブ・ウォー ----
console.log('\n[2] フォグ・オブ・ウォー:');
{
  const env = new HellgridEnv2({ mazeSize: 11 });
  let covSum = 0;
  let allPartial = true;
  for (let seed = 1; seed <= 20; seed++) {
    env.reset(seed);
    const cov = env.mem.knownFloor / env.mem.totalFloor;
    covSum += cov;
    if (cov >= 1) allPartial = false;
  }
  ok(allPartial, `開始時に全床タイルが見えているエピソードがない`);
  console.log(`      開始時の平均カバレッジ: ${(covSum / 20 * 100).toFixed(1)}% (11x11 迷路)`);
}

// ---- 3. 決定性 ----
console.log('\n[3] 決定性 (同シード + 同行動列):');
{
  const lcg = s => { let a = s >>> 0; return () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; }; };
  const run = () => {
    const env = new HellgridEnv2({ mazeSize: 11 });
    const rnd = lcg(99);
    let obs = env.reset(42);
    const rewards = [];
    for (let t = 0; t < 100; t++) {
      const r = env.step(ACTION_NVEC2.map(n => (rnd() * n) | 0));
      rewards.push(r.reward);
      obs = r.obs;
      if (r.terminated || r.truncated) break;
    }
    return { rewards: rewards.join(','), obs: Array.from(obs) };
  };
  const r1 = run(), r2 = run();
  ok(r1.rewards === r2.rewards, '報酬列が完全一致');
  ok(r1.obs.every((v, i) => v === r2.obs[i]), '最終観測が完全一致');
}

// ---- 4 & 6. 観測の健全性とランダム方策 ----
console.log('\n[4] 観測の健全性 + [6] ランダム方策の基準値:');
{
  const lcg = s => { let a = s >>> 0; return () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; }; };
  const rnd = lcg(2024);
  const env = new HellgridEnv2({ mazeSize: 11, maxSteps: 600 });
  let bad = 0, minV = Infinity, maxV = -Infinity;
  const check = o => {
    for (let i = 0; i < o.length; i++) {
      const v = o[i];
      if (!Number.isFinite(v)) { bad++; continue; }
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  };
  const N_EP = 50;
  let clears = 0, exitSeens = 0, covSum = 0, totalSteps = 0;
  const rewards = [];
  const t0 = process.hrtime.bigint();
  for (let ep = 0; ep < N_EP; ep++) {
    check(env.reset(3000 + ep));
    for (;;) {
      const r = env.step(ACTION_NVEC2.map(n => (rnd() * n) | 0));
      totalSteps++;
      if (r.terminated || r.truncated) {
        check(r.obs);
        rewards.push(r.info.epReward);
        covSum += r.info.coverage;
        if (r.info.exitSeen) exitSeens++;
        if (r.info.levelsCleared > 0) clears++;
        break;
      }
    }
  }
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  ok(bad === 0, `NaN/Inf なし`);
  ok(minV >= -1.001 && maxV <= 1.001, `値域 [${minV.toFixed(3)}, ${maxV.toFixed(3)}] が [-1, 1] 内`);
  rewards.sort((a, b) => a - b);
  console.log(`      ランダム方策 ${N_EP}エピソード (11x11迷路, 600步上限):`);
  console.log(`        クリア ${clears}/${N_EP}   出口発見 ${exitSeens}/${N_EP}   平均カバレッジ ${(covSum / N_EP * 100).toFixed(1)}%`);
  console.log(`        報酬 中央値 ${rewards[N_EP >> 1].toFixed(1)}  最小 ${rewards[0].toFixed(1)}  最大 ${rewards[N_EP - 1].toFixed(1)}`);
  console.log(`        スループット ${(totalSteps / secs / 1000).toFixed(1)}k 行動/秒 (1コア・観測生成込み)`);
  // 教訓6: 最初のカリキュラム段階は成功率 0% であってはならない
  ok(clears > 0, `ランダム方策でもクリアが 0 でない (${clears}/${N_EP}) — 学習の立ち上がりに必須`);
}

// ---- 5. 台本プレイ: 最短経路を歩いて出口発見 → クリア ----
console.log('\n[5] 台本プレイ (最短経路を1タイルずつテレポート):');
{
  const env = new HellgridEnv2({ mazeSize: 11 });
  env.reset(5);
  const w = env.world, lv = w.level;
  // テスト側でマップ全域BFS (出口の隣まで)
  const dist = new Int16Array(lv.w * lv.h).fill(-1);
  let ex = -1, ey = -1;
  for (let y = 0; y < lv.h; y++) for (let x = 0; x < lv.w; x++) if (lv.grid[y][x] === 'X') { ex = x; ey = y; }
  const seeds = [[ex + 1, ey], [ex - 1, ey], [ex, ey + 1], [ex, ey - 1]];
  const q = [];
  for (const [x, y] of seeds) {
    if (x < 0 || y < 0 || x >= lv.w || y >= lv.h || lv.grid[y][x] !== null) continue;
    dist[y * lv.w + x] = 0; q.push(y * lv.w + x);
  }
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi], cx = c % lv.w, cy = (c / lv.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = cx + dx, ay = cy + dy;
      if (ax < 0 || ay < 0 || ax >= lv.w || ay >= lv.h) continue;
      if (lv.grid[ay][ax] !== null || dist[ay * lv.w + ax] >= 0) continue;
      dist[ay * lv.w + ax] = dist[c] + 1;
      q.push(ay * lv.w + ax);
    }
  }
  let total = 0, exploreReward = 0, moved = 0;
  let sawExitReward = false;
  for (let t = 0; t < 200; t++) {
    const px = w.player.x | 0, py = w.player.y | 0;
    const d0 = dist[py * lv.w + px];
    if (d0 <= 0) break;
    let best = null, bd = d0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = px + dx, ay = py + dy;
      if (ax < 0 || ay < 0 || ax >= lv.w || ay >= lv.h) continue;
      const d = dist[ay * lv.w + ax];
      if (d >= 0 && d < bd) { bd = d; best = [dx, dy]; }
    }
    if (!best) break;
    // 進行方向を向かせてからテレポート (視界が進行方向に開くように)
    w.player.dirX = best[0]; w.player.dirY = best[1];
    w.player.planeX = -best[1] * 0.66; w.player.planeY = best[0] * 0.66;
    w.player.x = px + best[0] + 0.5;
    w.player.y = py + best[1] + 0.5;
    const wasSeen = env.exitSeen;
    const r = env.step([0, 0, 2, 1, 0, 0, 0]);   // 何もしない行動 (観測と報酬だけ)
    total += r.reward;
    if (!wasSeen && env.exitSeen) sawExitReward = true;
    moved++;
  }
  ok(moved > 3, `最短経路を ${moved} 歩ぶん前進できた`);
  ok(env.exitSeen, '道中で出口スイッチを発見した');
  ok(sawExitReward, '発見の瞬間に発見ボーナスが出た');
  ok(total > 0, `探索しながらの前進で合計報酬が黒字 (${total.toFixed(2)})`);
  // 出口の隣で出口の方を向いて E → クリア
  const px = w.player.x | 0, py = w.player.y | 0;
  w.player.dirX = ex + 0.5 - w.player.x; w.player.dirY = ey + 0.5 - w.player.y;
  const len = Math.hypot(w.player.dirX, w.player.dirY);
  w.player.dirX /= len; w.player.dirY /= len;
  w.player.planeX = -w.player.dirY * 0.66; w.player.planeY = w.player.dirX * 0.66;
  const r = env.step([0, 0, 2, 1, 0, 1, 0]);   // E を押す
  ok(r.terminated && r.info.levelsCleared === 1, `出口スイッチでクリア (報酬 ${r.reward.toFixed(1)})`);
  console.log(`      クリア時カバレッジ ${(r.info.coverage * 100).toFixed(1)}%`);
}

// ---- 7. フロンティア整形の符号 ----
// 出口をまだ見つけていない間、最寄りのフロンティア (未知との境界) へ向かって
// 1タイルずつ進むと、毎ステップ正の報酬になるはず (整形 + 新タイル発見)
console.log('\n[7] フロンティア整形 (出口未発見時の探索の勾配):');
{
  const { computeFrontierField } = ctx;
  const env = new HellgridEnv2({ mazeSize: 15, mazeBraid: 0.15 });
  let seed = 11;
  do { env.reset(seed++); } while (env.exitSeen && seed < 30);   // 出口が最初から見えていない開始を選ぶ
  const w = env.world, lv = w.level;
  let moved = 0, negatives = 0;
  while (moved < 25 && !env.goal.field) {
    const f = computeFrontierField(w, env.mem);
    if (!f.field) break;
    const px = w.player.x | 0, py = w.player.y | 0;
    let best = null, bd = f.field[py * lv.w + px];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = px + dx, ay = py + dy;
      if (ax < 0 || ay < 0 || ax >= lv.w || ay >= lv.h) continue;
      const d = f.field[ay * lv.w + ax];
      if (d >= 0 && d < bd) { bd = d; best = [dx, dy]; }
    }
    if (!best) break;
    w.player.dirX = best[0]; w.player.dirY = best[1];
    w.player.planeX = -best[1] * 0.66; w.player.planeY = best[0] * 0.66;
    w.player.x = px + best[0] + 0.5;
    w.player.y = py + best[1] + 0.5;
    const r = env.step([0, 0, 2, 1, 0, 0, 0]);
    if (r.reward <= 0) negatives++;
    moved++;
    if (r.terminated || r.truncated) break;
  }
  ok(moved > 10, `フロンティアへ ${moved} 歩ぶん前進できた`);
  ok(negatives === 0, `全ステップで報酬が正 (負だったステップ ${negatives}/${moved})`);
}

console.log(failures ? `\nNG ${failures}件の失敗` : '\nすべてOK');
process.exitCode = failures ? 1 : 0;
