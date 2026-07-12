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

function createSim() {
  const ctx = vm.createContext({ console });
  for (const f of SIM_FILES) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

module.exports = { createSim, SIM_FILES };
