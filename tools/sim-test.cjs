'use strict';
/* ヘッドレスのシム検証: node tools/sim-test.cjs
 *   1. 全ステージがロードできる
 *   2. 決定性 (同じシード+同じ入力 -> 同じ状態)
 *   3. シードを変えると結果が変わる
 *   4. スループット計測 (学習に使えるか)
 */
const { createSim } = require('../env/sim-loader.cjs');

const sim = createSim();
const { World, SIM_DT, LEVELS } = sim;

// ---- 1. 全ステージのロード ----
for (let i = 0; i < LEVELS.length; i++) {
  const w = new World({ seed: 1, level: i });
  const lv = w.level;
  console.log(`  L${i} ${lv.def.name.padEnd(14)} ${lv.w}x${lv.h} 敵${String(lv.totalKills).padStart(2)} アイテム${String(lv.totalItems).padStart(2)} 秘密${lv.totalSecrets} start=(${lv.startX},${lv.startY})`);
}

// ---- 疑似プレイ: 決まった手順で入力を与える ----
// 実際の学習と同じく「毎ステップ入力を差し替えて step する」形にする
function rollout(seed, steps) {
  const w = new World({ seed, level: 0 });
  const rnd = makeLCG(12345); // 入力列自体はシードに依らず固定
  for (let i = 0; i < steps; i++) {
    w.keys['KeyW'] = rnd() < 0.7;
    w.keys['KeyA'] = rnd() < 0.15;
    w.keys['KeyD'] = rnd() < 0.15;
    w.shootHeld = rnd() < 0.25;
    w.look((rnd() - 0.5) * 60, 0);
    if (i % 30 === 0) w.pressKey('KeyE');
    w.step(SIM_DT);
    w.drainEvents();
  }
  const p = w.player;
  return {
    x: +p.x.toFixed(6), y: +p.y.toFixed(6), z: +p.z.toFixed(6),
    dirX: +p.dirX.toFixed(6), hp: +p.health.toFixed(6), armor: +p.armor.toFixed(6),
    bullets: p.bullets, kills: w.level.kills, state: w.state, time: +w.time.toFixed(6),
  };
}

function makeLCG(s) {
  let a = s >>> 0;
  return () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
}

// ---- 2. 決定性 ----
const a = rollout(42, 600);
const b = rollout(42, 600);
const same = JSON.stringify(a) === JSON.stringify(b);
console.log(`\n  決定性 (seed=42 を2回): ${same ? 'OK 一致' : 'NG 不一致'}`);
console.log(`    ${JSON.stringify(a)}`);
if (!same) { console.log(`    ${JSON.stringify(b)}`); process.exitCode = 1; }

// ---- 3. シード違いで結果が変わる ----
const c = rollout(7, 600);
console.log(`  シード依存 (seed=7):     ${JSON.stringify(c) !== JSON.stringify(a) ? 'OK 異なる' : 'NG 同一(RNGが効いていない)'}`);
if (JSON.stringify(c) === JSON.stringify(a)) process.exitCode = 1;

// ---- 4. スループット ----
const N = 200000;
const w = new World({ seed: 1, level: 0 });
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  w.keys['KeyW'] = true;
  w.step(SIM_DT);
  if (w.events.length) w.drainEvents();
  if (w.state !== 'playing') w.reset(0);
}
const secs = Number(process.hrtime.bigint() - t0) / 1e9;
console.log(`\n  スループット: ${(N / secs / 1000).toFixed(1)}k step/秒 (1コア・描画なし)`);
console.log(`    = 行動15Hz(フレームスキップ4)換算で ${(N / secs / 4 / 1000).toFixed(1)}k 行動/秒`);
