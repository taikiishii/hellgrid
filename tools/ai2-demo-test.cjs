'use strict';
/* 探索版ブラウザデモの検証: node tools/ai2-demo-test.cjs
 *
 * ブラウザ (explore.html) とまったく同じファイル群 — 書き出した方策 (js/policy2-*.js)、
 * Policy (js/ai.js)、ドライバ (js/ai2.js)、観測 (env/obs2.js) — を Node で駆動して、
 * 「デモのAIが学習時と同じ振る舞いをするか」をエピソード単位で確かめる。
 * ここが通れば、ブラウザで動かないのは描画側の問題に絞れる。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'js/levels.js', 'js/sim/rng.js', 'js/sim/constants.js', 'js/sim/world.js',
  'env/mazegen.js', 'env/obs2.js', 'env/env2.js',
  'js/policy2-champion.js', 'js/policy2-explorer.js',
  'js/ai.js', 'js/ai2.js',
];

const ctx = vm.createContext({ console, atob: s => Buffer.from(s, 'base64').toString('binary') });
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { World, Policy, AIDriver2, POLICIES2, SIM_DT, generateMaze, LEVELS } = ctx;

let failures = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? 'OK ' : 'NG '} ${label}`);
  if (!cond) failures++;
};

// ドライバでエピソードを回す (ブラウザのループと同じ: preStep -> step)
function runEpisode(policy, level, seed, maxActions) {
  const world = new World({ seed, level });
  const drv = new ctx.AIDriver2(world, policy);
  for (let a = 0; a < maxActions; a++) {
    for (let i = 0; i < 4; i++) {
      if (world.state !== 'playing') break;
      drv.preStep();
      world.step(SIM_DT);
    }
    if (world.state !== 'playing') break;
  }
  return { state: world.state, coverage: drv.coverage(), hp: world.player.health };
}

// ---- 1. チャンピオンが E1M1 をクリアできるか (学習時: ~100%) ----
console.log('[1] チャンピオン方策 x E1M1 (10エピソード):');
{
  const policy = new Policy(POLICIES2.champion);
  let clears = 0;
  for (let ep = 0; ep < 10; ep++) {
    const r = runEpisode(policy, 0, 100 + ep, 1500);
    if (r.state === 'levelEnd') clears++;
  }
  ok(clears >= 7, `10回中 ${clears} クリア (学習時 ~100%。大きく下回るなら観測がズレている)`);
}

// ---- 2. 探索者がランダム迷路を解けるか (学習時: ~59%) ----
console.log('[2] 探索者方策 x ランダム迷路 21x21 (10エピソード):');
{
  const policy = new Policy(POLICIES2.explorer);
  let clears = 0, covSum = 0;
  for (let ep = 0; ep < 10; ep++) {
    const def = generateMaze(500 + ep, { size: 21, braid: 0.15, rooms: 5 });
    const idx = LEVELS.length;
    LEVELS.push(def);
    const r = runEpisode(policy, idx, 500 + ep, 1200);
    LEVELS.pop();
    if (r.state === 'levelEnd') clears++;
    covSum += r.coverage;
  }
  ok(clears >= 3, `10回中 ${clears} クリア (学習時 ~59%)`);
  ok(covSum / 10 > 0.4, `平均カバレッジ ${(covSum * 10).toFixed(0)}% > 40% (探索が機能している)`);
}

console.log(failures ? `\nNG ${failures}件の失敗` : '\nすべてOK');
process.exitCode = failures ? 1 : 0;
