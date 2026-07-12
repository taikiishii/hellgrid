'use strict';
/* 学習環境の検証: node tools/env-test.cjs
 *   1. 観測の形と値域 (NaN / 範囲外がないか)
 *   2. 出口までのBFS距離場が全ステージで正しく張れているか
 *   3. ランダム方策のスループットと報酬の分布
 *   4. ポテンシャル整形が「出口に近づくと正」になっているか
 */
const { createEnvContext } = require('../env/sim-loader.cjs');
const ctx = createEnvContext();
const { HellgridEnv, World, OBS_DIM, ACTION_NVEC, LEVELS, computeGoalField, goalDistAt, levelMeta } = ctx;

console.log(`観測次元: ${OBS_DIM}  行動: MultiDiscrete(${ACTION_NVEC.join(',')})`);

// ---- 2. 各ステージで、開始位置から出口までBFSが通っているか ----
console.log('\n出口までのBFS距離 (開始位置から):');
for (let i = 0; i < LEVELS.length; i++) {
  const w = new World({ seed: 1, level: i });
  w.level.meta = levelMeta(w.level);
  const goal = computeGoalField(w);
  const d = goalDistAt(goal, w.level, w.player.x, w.player.y);
  const ok = d >= 0;
  console.log(`  ${ok ? 'OK ' : 'NG '} ${w.level.def.name.padEnd(14)} ${String(d).padStart(3)}歩  目標=${goal.target}`);
  if (!ok) process.exitCode = 1;
}

// ---- 1 & 3. ランダム方策 ----
function randPolicy(rnd) {
  return ACTION_NVEC.map(n => (rnd() * n) | 0);
}
function lcg(s) { let a = s >>> 0; return () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; }; }

const env = new HellgridEnv({ levels: [0, 1, 2, 3, 4], mode: 'single', maxSteps: 900 });
const rnd = lcg(2024);
let bad = 0, minV = Infinity, maxV = -Infinity;
const check = o => {
  for (let i = 0; i < o.length; i++) {
    const v = o[i];
    if (!Number.isFinite(v)) { bad++; continue; }
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
};

const N_EP = 20;
let totalSteps = 0, deaths = 0, clears = 0;
const rewards = [];
const t0 = process.hrtime.bigint();
for (let ep = 0; ep < N_EP; ep++) {
  check(env.reset(1000 + ep));
  let done = false;
  while (!done) {
    const r = env.step(randPolicy(rnd));
    check(r.obs);
    totalSteps++;
    if (r.terminated || r.truncated) {
      done = true;
      rewards.push(r.info.epReward);
      if (r.info.hp <= 0) deaths++;
      if (r.info.levelsCleared > 0) clears++;
    }
  }
}
const secs = Number(process.hrtime.bigint() - t0) / 1e9;

console.log(`\n観測の健全性: NaN/Inf ${bad}個  値域 [${minV.toFixed(3)}, ${maxV.toFixed(3)}] ${bad === 0 && minV >= -1.001 && maxV <= 1.001 ? 'OK' : 'NG'}`);
if (bad > 0 || minV < -1.001 || maxV > 1.001) process.exitCode = 1;

rewards.sort((a, b) => a - b);
console.log(`\nランダム方策 ${N_EP}エピソード:`);
console.log(`  死亡 ${deaths}/${N_EP}   クリア ${clears}/${N_EP}`);
console.log(`  報酬 中央値 ${rewards[N_EP >> 1].toFixed(1)}  最小 ${rewards[0].toFixed(1)}  最大 ${rewards[N_EP - 1].toFixed(1)}`);
console.log(`  スループット: ${(totalSteps / secs / 1000).toFixed(1)}k 行動/秒 (1コア・観測生成込み)`);

// ---- 4. ポテンシャル整形の符号 ----
// 出口に向かって最短経路を1歩進むと必ず正の整形報酬になるはず
const e2 = new HellgridEnv({ levels: [0], mode: 'single', noEnemies: true });
e2.reset(1);
const before = e2.goalDist;
// BFS の勾配に沿って手動でプレイヤーを動かす(整形報酬だけを見る)
const w2 = e2.world, lv2 = w2.level;
let moved = 0;
for (let t = 0; t < 60 && e2.goalDist > 1; t++) {
  const px = w2.player.x | 0, py = w2.player.y | 0;
  let best = null, bd = goalDistAt(e2.goal, lv2, px, py);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const d = goalDistAt(e2.goal, lv2, px + dx, py + dy);
    if (d >= 0 && d < bd) { bd = d; best = [dx, dy]; }
  }
  if (!best) break;
  w2.player.x = px + best[0] + 0.5;
  w2.player.y = py + best[1] + 0.5;
  const r = e2.step([0, 0, 2, 1, 0, 0, 0]);
  if (r.reward <= 0) { console.log(`\nNG 整形報酬が正でない: ${r.reward}`); process.exitCode = 1; break; }
  moved++;
}
console.log(`\nポテンシャル整形: 出口へ${moved}歩ぶん進めて全ステップ正の報酬  ${e2.goalDist <= 1 ? '(出口に到達)' : ''} ${moved > 5 ? 'OK' : 'NG'}`);
console.log(`  開始時の出口までの距離 ${before}歩 -> ${e2.goalDist}歩`);
if (moved <= 5) process.exitCode = 1;
