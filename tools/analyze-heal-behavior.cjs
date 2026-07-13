'use strict';
/* AIが回復アイテムをどう扱っているかを、実プレイから測る。
 *
 *   node tools/analyze-heal-behavior.cjs
 *
 * 知りたいこと:
 *   - 回復を拾った瞬間のHPはいくつか (低HPのときだけ拾うのか、常に拾うのか)
 *   - マップ上の回復のうち、何割を回収しているか
 *   - 回復を持っているのに素通りしている状況はどれくらいあるか
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createEnvContext } = require('../env/sim-loader.cjs');

const ROOT = path.join(__dirname, '..');
const ctx = createEnvContext();
// ブラウザ用の Policy クラスと学習済みの重みを、同じコンテキストに載せる
ctx.atob = s => Buffer.from(s, 'base64').toString('binary');
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/policy.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8'), ctx);

const { HellgridEnv, POLICY, Policy, ITEM_TYPES } = ctx;
const policy = new Policy(POLICY);
const HEAL = 'hH';   // スティムパック(+10) / メディキット(+25)

const env = new HellgridEnv({ levels: [0], mode: 'campaign', maxSteps: 12000 });

const pickups = [];      // 拾った瞬間のHP
const passed = [];       // 拾えたのに拾わなかった場面 (回復の上を通らなかった)
let totalHeal = 0, gotHeal = 0, episodes = 0, fullClears = 0;
const hpHistogram = new Array(10).fill(0);   // 滞在時間のHP分布 (比較用の基準)

for (let ep = 0; ep < 40; ep++) {
  let obs = env.reset(50000 + ep);
  let lvl = env.world.level.index;
  totalHeal += env.world.level.items.filter(it => HEAL.includes(it.kind)).length;

  for (let t = 0; t < 12000; t++) {
    const p = env.world.player;
    const before = new Set(env.world.level.items.filter(it => HEAL.includes(it.kind)));
    const hpBefore = p.health;
    hpHistogram[Math.min(9, Math.floor(hpBefore / 10))]++;

    const a = policy.act(obs);
    const r = env.step(a);
    obs = r.obs;

    // ステージが変わったら、そのステージの回復の総数を足す
    if (env.world.level.index !== lvl) {
      lvl = env.world.level.index;
      totalHeal += env.world.level.items.filter(it => HEAL.includes(it.kind)).length;
    } else {
      for (const it of before) {
        if (!env.world.level.items.includes(it)) {   // 消えた = 拾った
          pickups.push({ hp: hpBefore, kind: it.kind });
          gotHeal++;
        }
      }
    }
    if (r.terminated || r.truncated) {
      episodes++;
      if (r.info.levelsCleared >= 5) fullClears++;
      break;
    }
  }
}

const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '—';
console.log(`${episodes} エピソード (通し)  完走 ${fullClears} (${pct(fullClears, episodes)})\n`);

console.log(`マップ上の回復アイテム ${totalHeal} 個中 ${gotHeal} 個を回収  (${pct(gotHeal, totalHeal)})\n`);

// ---- 拾った瞬間のHP分布 ----
const bins = new Array(10).fill(0);
for (const p of pickups) bins[Math.min(9, Math.floor(p.hp / 10))]++;
const totalTime = hpHistogram.reduce((a, b) => a + b, 0);

console.log('回復を拾った瞬間のHP  (基準 = そのHP帯にいた時間の割合)');
console.log('  HP帯      拾った数   拾った割合    滞在時間の割合   拾いやすさ');
for (let i = 0; i < 10; i++) {
  const lo = i * 10, hi = lo + 9;
  const pickShare = pickups.length ? bins[i] / pickups.length : 0;
  const timeShare = hpHistogram[i] / totalTime;
  // 「拾いやすさ」= その HP 帯での拾いやすさ / 全体平均。1より大きければ、その帯で
  // 拾いやすい = HPが低いときを狙って拾っている
  const ratio = timeShare > 0.001 ? pickShare / timeShare : NaN;
  const bar = '#'.repeat(Math.round(pickShare * 60));
  console.log(`  ${String(lo).padStart(3)}-${String(hi).padStart(3)}  ${String(bins[i]).padStart(8)}   ${(pickShare * 100).toFixed(1).padStart(7)}%   ${(timeShare * 100).toFixed(1).padStart(11)}%   ${isNaN(ratio) ? '  —' : ratio.toFixed(2).padStart(6)}  ${bar}`);
}
const avg = pickups.length ? pickups.reduce((a, p) => a + p.hp, 0) / pickups.length : 0;
console.log(`\n  拾った瞬間の平均HP  ${avg.toFixed(1)}`);
console.log(`  プレイ中の平均HP    ${(hpHistogram.reduce((a, c, i) => a + c * (i * 10 + 5), 0) / totalTime).toFixed(1)}`);
