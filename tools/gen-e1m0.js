// テスト用ステージ E1M0 を生成: 樽(o)・飛行敵(F)・リフト(L)の動作確認用。17x15。
const W = 17, H = 15;
const g = Array.from({ length: H }, () => new Array(W).fill('#'));
const hh = Array.from({ length: H }, () => new Array(W).fill('0'));
const room = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y][x] = '.'; };
const put = (x, y, c) => { g[y][x] = c; };
const seth = (x0, y0, x1, y1, v) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) hh[y][x] = v; };

// アリーナ
room(1, 1, 15, 13);

// --- 北西の高台(出口) : リフトでのみ到達 ---
// 高台 cols1-3 rows1-3 を高さ1.0('4')
seth(1, 1, 3, 3, '4');
// 高台の周りを壁で囲い、col2 の縦シャフトだけ開ける
put(1, 4, '#'); put(3, 4, '#');           // 高台直下の左右を壁
put(4, 1, '#'); put(4, 2, '#'); put(4, 3, '#'); // 高台の東側を壁
put(2, 4, 'L'); put(2, 5, 'L');           // リフト(2マス)。ground(row6)と高台(row3)を繋ぐ
put(2, 0, 'X');                            // 出口スイッチ(高台の北壁)

// --- 樽: 敵の近くに配置(撃つと誘爆して巻き込む) ---
put(8, 6, 'o'); put(9, 6, 'o'); put(8, 7, 'o');

// --- 敵 ---
put(8, 8, 'M');     // 樽のそばの牙獣(樽が巻き込む)
put(12, 4, 'Z');    // 亡兵
put(13, 10, 'G');   // 散弾兵
put(8, 3, 'F');     // 飛行敵(アリーナ上空を漂う)
put(14, 2, 'f');    // 休眠の飛行敵(罠)

// trigger(休眠敵用)
put(13, 6, 'T');

// --- アイテム ---
put(2, 13, 'A'); put(14, 13, 'H'); put(3, 11, 'S'); put(13, 12, 'a');

// --- スタート ---
put(8, 12, 'P');

console.log('    map: [');
for (const row of g) console.log(`      '${row.join('')}',`);
console.log('    ],');
console.log('    heights: [');
for (const row of hh) console.log(`      '${row.join('')}',`);
console.log('    ],');
