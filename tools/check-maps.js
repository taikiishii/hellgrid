// マップデータ検証スクリプト: node tools/check-maps.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'levels.js'), 'utf8');
const LEVELS = new Function(src + '\nreturn LEVELS;')();

const wallChars = new Set(['#', '&', '=', 'D', 'R', 'B', '*', 'X']);
const floorChars = '.PT' + '~<>^v' + 'oL' + 'ZGIMKF' + 'zgimkf' + 'hHaAsSrbpV';
let failed = false;

for (const lv of LEVELS) {
  const rows = lv.map;
  const w = rows[0].length;
  let p = 0, exits = 0, enemies = 0, dormant = 0, items = 0;
  let triggers = 0, secrets = 0, water = 0, conveyor = 0, barrels = 0, lifts = 0;
  const chars = new Set();
  for (let y = 0; y < rows.length; y++) {
    if (rows[y].length !== w) {
      console.log(`NG 行の長さ不一致: ${lv.name} 行${y} = ${rows[y].length} (期待 ${w})`);
      failed = true;
      continue;
    }
    for (let i = 0; i < w; i++) {
      const ch = rows[y][i];
      chars.add(ch);
      const border = y === 0 || y === rows.length - 1 || i === 0 || i === w - 1;
      if (border && !wallChars.has(ch)) {
        console.log(`NG 外周が開いている: ${lv.name} (${i},${y}) '${ch}'`);
        failed = true;
      }
      if (ch === 'P') p++;
      if (ch === 'X') exits++;
      if (ch === 'T') triggers++;
      if (ch === '*') secrets++;
      if ('ZGIMKF'.includes(ch)) enemies++;
      if ('zgimkf'.includes(ch)) dormant++;
      if ('hHaAsSrbpV'.includes(ch)) items++;
      if (ch === '~') water++;
      if ('<>^v'.includes(ch)) conveyor++;
      if (ch === 'o') barrels++;
      if (ch === 'L') lifts++;
      if (!wallChars.has(ch) && !floorChars.includes(ch)) {
        console.log(`NG 未知の文字: ${lv.name} '${ch}' (${i},${y})`);
        failed = true;
      }
    }
  }
  // 高さレイヤー (任意): マップと同じ縦横サイズで '0'-'9' のみ
  if (lv.heights) {
    if (lv.heights.length !== rows.length) {
      console.log(`NG 高さレイヤーの行数不一致: ${lv.name} ${lv.heights.length}行 (期待 ${rows.length})`);
      failed = true;
    }
    for (let y = 0; y < Math.min(lv.heights.length, rows.length); y++) {
      const hr = lv.heights[y];
      if (hr.length !== w) {
        console.log(`NG 高さレイヤーの行の長さ不一致: ${lv.name} 行${y} = ${hr.length} (期待 ${w})`);
        failed = true;
        continue;
      }
      for (let x = 0; x < w; x++) {
        if (hr[x] < '0' || hr[x] > '9') {
          console.log(`NG 高さレイヤーに数字以外: ${lv.name} (${x},${y}) '${hr[x]}'`);
          failed = true;
        }
      }
    }
  }
  if (p !== 1) { console.log(`NG プレイヤー開始位置が${p}個: ${lv.name}`); failed = true; }
  if (exits < 1) { console.log(`NG 出口がない: ${lv.name}`); failed = true; }
  if (dormant > 0 && triggers === 0) { console.log(`NG 休眠敵がいるのにトリガーがない: ${lv.name}`); failed = true; }
  if (chars.has('R') && !chars.has('r')) { console.log(`NG 赤ドアがあるのに赤キーがない: ${lv.name}`); failed = true; }
  if (chars.has('B') && !chars.has('b')) { console.log(`NG 青ドアがあるのに青キーがない: ${lv.name}`); failed = true; }
  console.log(`OK ${lv.name}: ${w}x${rows.length}, 敵${enemies}+休眠${dormant}, アイテム${items}, トリガー${triggers}, シークレット${secrets}, 水${water}, 歩道${conveyor}, 樽${barrels}, リフト${lifts}`);
}
console.log(failed ? '--- 検証失敗 ---' : '--- 全マップ検証OK ---');
process.exit(failed ? 1 : 0);
