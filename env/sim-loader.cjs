'use strict';
/* =========================================================================
 * Node から js/sim/* をヘッドレスで読み込む。
 *
 * ブラウザは <script> タグでこれらを素直に読むので、シムのファイルはビルド不要の
 * 素の JS のまま。Node 側は vm でまっさらなコンテキストを作って同じファイルを
 * 流し込むことで、まったく同じコードを描画なしで走らせる。
 *
 *   const { createSim } = require('./sim-loader.cjs');
 *   const sim = createSim();
 *   const w = new sim.World({ seed: 1, level: 0 });
 *   w.keys['KeyW'] = true;
 *   w.step(sim.SIM_DT);
 *
 * 1コンテキストに World を何個でも並べられる(並列環境用)。
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SIM_FILES = [
  'js/levels.js',
  'js/sim/rng.js',
  'js/sim/constants.js',
  'js/sim/world.js',
];

// 学習環境 (観測・行動・報酬)。シムと同じコンテキストに載せる
const ENV_FILES = [
  'env/obs.js',
  'env/env.js',
];

// 探索版 (フォグ・オブ・ウォー観測 + ランダム迷路)。v1 とは独立に開発する
const ENV2_FILES = [
  'env/mazegen.js',
  'env/obs2.js',
  'env/env2.js',
];

function load(files) {
  const ctx = vm.createContext({ console });
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

function createSim() { return load(SIM_FILES); }

// HellgridEnv まで込みのコンテキスト。1つのコンテキストに Env を何個でも並べられる
function createEnvContext() { return load(SIM_FILES.concat(ENV_FILES)); }

// 探索版 (HellgridEnv2)。v1 の env.js/obs.js は読み込まない
function createEnvContext2() { return load(SIM_FILES.concat(ENV2_FILES)); }

module.exports = { createSim, createEnvContext, createEnvContext2, SIM_FILES, ENV_FILES, ENV2_FILES };
