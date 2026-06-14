// 既存マップに高さレイヤーを生成する補助スクリプト: node tools/gen-heights.js
// 地形を「矩形/階段」操作で記述し、マップ幅に合った heights 文字列配列を出力する。
// 出力を levels.js に貼り付ける。壁タイルの高さは無視されるが0で埋める。
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'levels.js'), 'utf8');
const LEVELS = new Function(src + '\nreturn LEVELS;')();

function blank(map) {
  const w = map[0].length;
  return map.map(() => new Array(w).fill(0));
}
const setRect = (h, x0, y0, x1, y1, v) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) h[y][x] = v;
};
// 縦方向の階段: x列範囲を、yTopからyBotへ向けて値を1ずつ変える
function stairsV(h, x0, x1, yFrom, yTo, vFrom, step) {
  let v = vFrom, y = yFrom;
  const dy = yTo >= yFrom ? 1 : -1;
  while (true) {
    for (let x = x0; x <= x1; x++) h[y][x] = v;
    if (y === yTo) break;
    y += dy; v += step;
  }
}
function stairsH(h, y0, y1, xFrom, xTo, vFrom, step) {
  let v = vFrom, x = xFrom;
  const dx = xTo >= xFrom ? 1 : -1;
  while (true) {
    for (let y = y0; y <= y1; y++) h[y][x] = v;
    if (x === xTo) break;
    x += dx; v += step;
  }
}
const toStrings = h => h.map(row => row.map(v => String(v)).join(''));

function emit(name, h, map) {
  // 壁タイル上の高さは見た目に影響しないが、念のため0にしておく
  const W = ['#', '&', '=', 'D', 'R', 'B', '*', 'X'];
  for (let y = 0; y < map.length; y++)
    for (let x = 0; x < map[0].length; x++)
      if (W.includes(map[y][x])) h[y][x] = 0;
  console.log(`\n// ===== ${name} (${map[0].length}x${map.length}) =====`);
  console.log('    heights: [');
  for (const s of toStrings(h)) console.log(`      '${s}',`);
  console.log('    ],');
}

// ---------------- E1M1: 侵入 (27x23) ----------------
// 右上の大部屋(北東角)に2段の見晴らし台。南から階段で登る。
// 下の部屋には腰高(0.5)の小さな段差を1つ。
{
  const map = LEVELS[0].map, h = blank(map);
  // 北東の見晴らし台 cols23-25, 階段は南(row8→row5)から
  stairsV(h, 23, 25, 8, 5, 1, 1);   // row8=1,row7=2,row6=3,row5=4
  setRect(h, 23, 1, 25, 4, 4);      // rows1-4 = 4(1.0) 台地
  // 下の部屋 右側に腰高の足場(段差0.5)
  setRect(h, 20, 17, 24, 19, 2);
  emit('E1M1', h, map);
}

// ---------------- E1M2: 闘技場 (21x17) ----------------
// 中央の闘技場を一段下げ(ピット)、四隅の柱まわりを高くして攻防に高低差を出す。
{
  const map = LEVELS[1].map, h = blank(map);
  // 外周の床(リング)を一段高く 0.5
  setRect(h, 1, 1, 19, 13, 2);
  // 中央ピット cols6-14, rows4-12 を 0 に戻す(一段低い闘技場)
  setRect(h, 6, 4, 14, 12, 0);
  // ピットへ降りる/上がるための階段(中央通路 col10)
  stairsV(h, 9, 11, 3, 4, 2, -1); // 北の通路からピットへ1段
  // 四隅の柱足場を少し高く(==の周り)
  setRect(h, 2, 4, 4, 5, 3);    // 左上
  setRect(h, 16, 4, 18, 5, 3);  // 右上
  setRect(h, 2, 9, 4, 10, 3);   // 左下
  setRect(h, 16, 9, 18, 10, 3); // 右下
  // 南の出入口(プレイヤー開始 row15付近)は0のまま
  setRect(h, 1, 14, 19, 15, 0);
  emit('E1M2', h, map);
}

// ---------------- E1M3: 処理施設 (29x23) ----------------
// 中央ホールを一段高い処理台に。左右のサイド部屋から階段で上がる。
{
  const map = LEVELS[2].map, h = blank(map);
  // 中央の大ホール cols9-19, rows1-16 を 0.5 の処理台に
  setRect(h, 9, 1, 19, 16, 2);
  // 上部の北ホール rows1-7 はさらに高く(0.75)
  setRect(h, 9, 1, 19, 7, 3);
  // 北⇔中央をつなぐ階段(row8の細い通路 cols12-14)
  stairsV(h, 12, 14, 8, 8, 2, 0); // row8 = 0.5(中継)
  // 南の出入口(プレイヤー開始エリア rows18-21)は0、中央ホールへ上がる階段(D前)
  stairsV(h, 13, 15, 17, 16, 1, 1); // D(row17)=0.25 → row16=0.5へ繋ぐ
  setRect(h, 11, 18, 17, 21, 0);
  // 左サイド部屋(cols1-7)と右サイド部屋(cols20-27)は0のまま(中央が高い構図)
  emit('E1M3', h, map);
}
