'use strict';
/* =========================================================================
 * ランダム迷路の生成 — 探索学習 (env2) 用
 *
 * 「見たものだけ」で学習するエージェントは、固定5ステージだけで訓練すると
 * マップを丸暗記してしまう (docs/next-partial-observability.md §4)。
 * そこでシードから決定的に迷路を無限に作り、毎エピソード違うマップを見せる。
 *
 *   const def = generateMaze(seed, { size: 11 });   // LEVELS 互換のステージ定義
 *
 * 生成物は js/levels.js の LEVELS と同じ形式なので、World.loadLevel が
 * そのまま読める。壁 '#'、床 '.'、開始位置 'P'、出口スイッチ 'X' のみ。
 * 敵・アイテム・ドアは後のカリキュラム段階で足す。
 *
 * アルゴリズム: 再帰的バックトラッカー (完全迷路)。
 *   - size は奇数。セル座標 (2x+1, 2y+1) が床、間の壁を掘って通路にする
 *   - P はランダムな床セル
 *   - X は P から BFS で最も遠い床タイルに隣接する壁 (= 必ず到達可能で、
 *     開始地点からそこそこ遠い)
 *   - braid > 0 で行き止まりの一部を開通させ、ループのある迷路にする
 * ========================================================================= */
(() => {

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // ---- 可解性チェック (鍵→ドア→出口の到達を保証する) ----
  // 壁・秘密扉・水路は通れない。R/B は対応する鍵を拾っていれば通れる。
  const REACH_WALL = '#&=*~';
  function passableReach(ch, red, blue) {
    if (REACH_WALL.includes(ch)) return false;
    if (ch === 'R') return red;
    if (ch === 'B') return blue;
    return true;   // 床 . P X T / ドア D / 敵 / アイテム / 鍵
  }
  // start から「鍵を拾いながら」到達できる床の seen 配列を返す (鍵取得で範囲が広がる)
  function reachWithKeys(grid, w, h, sx, sy) {
    const seen = new Uint8Array(w * h);
    let red = false, blue = false, changed = true;
    while (changed) {
      changed = false;
      seen[sy * w + sx] = 1;
      const q = [];
      for (let i = 0; i < w * h; i++) if (seen[i]) q.push(i);
      for (let qi = 0; qi < q.length; qi++) {
        const c = q[qi], cx = c % w, cy = (c / w) | 0, ch = grid[cy][cx];
        if (ch === 'r' && !red) { red = true; changed = true; }
        if (ch === 'b' && !blue) { blue = true; changed = true; }
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const k = ny * w + nx;
          if (seen[k] || !passableReach(grid[ny][nx], red, blue)) continue;
          seen[k] = 1; q.push(k);
        }
      }
    }
    return seen;
  }
  function findTile(grid, w, h, chs) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (chs.includes(grid[y][x])) return [x, y];
    return null;
  }
  function isSolvable(grid, w, h, sx, sy) {
    const xt = findTile(grid, w, h, 'X');
    if (!xt) return false;
    return !!reachWithKeys(grid, w, h, sx, sy)[xt[1] * w + xt[0]];
  }

  function generateMaze(seed, opts = {}) {
    const rng = makeRNG((seed >>> 0) || 1);
    // サイズは固定値か [lo,hi] 範囲 (エピソードごとに奇数を抽選 = 難易度のばらつき)
    let size = opts.size || 11;
    if (Array.isArray(size)) {
      const lo = size[0] | 1, hi = size[1] | 0;          // lo は奇数へ丸め
      const steps = Math.max(0, ((hi - lo) / 2) | 0);
      size = lo + 2 * ((rng() * (steps + 1)) | 0);
    }
    if (size < 5 || size % 2 === 0) throw new Error(`mazeSize は 5 以上の奇数: ${size}`);
    const w = size, h = size;
    const cw = (w - 1) / 2, ch = (h - 1) / 2;   // セル数

    const grid = [];
    for (let y = 0; y < h; y++) grid.push(new Array(w).fill('#'));

    // ---- 再帰的バックトラッカー (スタックによる反復実装) ----
    const visited = new Uint8Array(cw * ch);
    const start = [(rng() * cw) | 0, (rng() * ch) | 0];
    visited[start[1] * cw + start[0]] = 1;
    grid[start[1] * 2 + 1][start[0] * 2 + 1] = '.';
    const stack = [start];
    while (stack.length) {
      const [cx, cy] = stack[stack.length - 1];
      const cand = [];
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch || visited[ny * cw + nx]) continue;
        cand.push([nx, ny, dx, dy]);
      }
      if (!cand.length) { stack.pop(); continue; }
      const [nx, ny, dx, dy] = cand[(rng() * cand.length) | 0];
      visited[ny * cw + nx] = 1;
      grid[cy * 2 + 1 + dy][cx * 2 + 1 + dx] = '.';   // 間の壁を掘る
      grid[ny * 2 + 1][nx * 2 + 1] = '.';
      stack.push([nx, ny]);
    }

    // ---- braid: 行き止まりの一部を開通させてループを作る ----
    if (opts.braid > 0) {
      for (let y = 1; y < h - 1; y += 2) {
        for (let x = 1; x < w - 1; x += 2) {
          let walls = 0;
          for (const [dx, dy] of DIRS) if (grid[y + dy][x + dx] === '#') walls++;
          if (walls < 3 || rng() >= opts.braid) continue;   // 行き止まり = 壁3方向
          // 外周でなく、向こう側が床の壁を1枚抜く
          const knock = [];
          for (const [dx, dy] of DIRS) {
            const wx = x + dx, wy = y + dy, bx = x + 2 * dx, by = y + 2 * dy;
            if (wx <= 0 || wy <= 0 || wx >= w - 1 || wy >= h - 1) continue;
            if (grid[wy][wx] === '#' && grid[by] && grid[by][bx] === '.') knock.push([wx, wy]);
          }
          if (knock.length) {
            const [wx, wy] = knock[(rng() * knock.length) | 0];
            grid[wy][wx] = '.';
          }
        }
      }
    }

    // ---- rooms: 迷路の上に矩形の部屋を彫る ----
    // 実ステージ (E1M*) は幅1タイルの通路ではなく部屋+廊下の構造なので、
    // 転移の前に「開けた空間」に慣れさせる。部屋は 2x2 以上なら必ず奇数座標の
    // セル (=迷路の床) を含むため、孤立しない。
    for (let n = 0; n < (opts.rooms || 0); n++) {
      const rw = 3 + ((rng() * 5) | 0), rh = 3 + ((rng() * 5) | 0);   // 3..7
      const rx = 1 + ((rng() * (w - rw - 2)) | 0);
      const ry = 1 + ((rng() * (h - rh - 2)) | 0);
      for (let y = ry; y < ry + rh; y++) {
        for (let x = rx; x < rx + rw; x++) grid[y][x] = '.';
      }
    }

    // ---- P: ランダムな床セル ----
    const px = ((rng() * cw) | 0) * 2 + 1, py = ((rng() * ch) | 0) * 2 + 1;
    grid[py][px] = 'P';

    // ---- X: P から最も遠い床タイルの隣の壁 ----
    // 部屋の中央 (壁が隣接しない床) が最遠になることがあるので、
    // 「壁が隣接する床のうち最も遠いもの」を選ぶ
    const dist = new Int16Array(w * h).fill(-1);
    dist[py * w + px] = 0;
    const q = [py * w + px];
    const hasWallNb = c => {
      const cx = c % w, cy = (c / w) | 0;
      for (const [dx, dy] of DIRS) {
        const ax = cx + dx, ay = cy + dy;
        if (ax >= 0 && ay >= 0 && ax < w && ay < h && grid[ay][ax] === '#') return true;
      }
      return false;
    };
    let far = q[0];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi], cx = c % w, cy = (c / w) | 0;
      if (dist[c] > dist[far] && hasWallNb(c)) far = c;
      for (const [dx, dy] of DIRS) {
        const ax = cx + dx, ay = cy + dy;
        if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue;
        const k = ay * w + ax;
        if (dist[k] >= 0 || grid[ay][ax] === '#') continue;
        dist[k] = dist[c] + 1;
        q.push(k);
      }
    }
    // ---- enemies: 戦闘カリキュラム用の敵配置 ----
    // P から5歩以上離れた床にランダムに置く (開幕即交戦を避ける)。
    // 既定は 亡兵60% / 焔鬼25% / 散弾兵15% — 弱い敵から当てる練習をさせる。
    // opts.fireballRatio を上げると焔鬼 (火球持ち) が増え、避けないと削られる状況を作る
    // = ストレイフ (射線をずらしながら撃つ) を要求する
    if (opts.enemies) {
      const [lo, hi] = opts.enemies;
      const n = lo + Math.floor(rng() * (hi - lo + 1));
      const fb = opts.fireballRatio != null ? opts.fireballRatio : 0.25;
      const cand = [];
      for (let i = 0; i < dist.length; i++) {
        if (dist[i] >= 5 && grid[(i / w) | 0][i % w] === '.') cand.push(i);
      }
      // opts.enemyElite: 上位種 (牙獣M/獄騎士K/漂霊F) が混じる確率。汎化・難易度のばらつき用
      const elite = opts.enemyElite || 0;
      for (let k = 0; k < n && cand.length; k++) {
        const j = (rng() * cand.length) | 0;
        const t = cand.splice(j, 1)[0];
        let ch;
        if (rng() < elite) {
          ch = 'MKF'[(rng() * 3) | 0];   // 牙獣(突進) / 獄騎士(タフ) / 漂霊(遠距離)
        } else {
          const r = rng();
          // r < fb: 焔鬼(I, 火球) / 次の15%: 散弾兵(G) / 残り: 亡兵(Z)
          ch = r < fb ? 'I' : r < fb + 0.15 ? 'G' : 'Z';
        }
        grid[(t / w) | 0][t % w] = ch;
      }
    }

    const fx = far % w, fy = (far / w) | 0;
    // 出口スイッチを埋め込む壁。壁は複数の通路に面しうるので、
    // 「隣接する床タイルのうち P から最も近いものが、最も遠い」壁を選ぶ
    // (= 意図しない近道側から出口に届いてしまうのを防ぐ)
    let best = null, bestScore = -1;
    for (const [dx, dy] of DIRS) {
      const wx = fx + dx, wy = fy + dy;
      if (wx < 0 || wy < 0 || wx >= w || wy >= h || grid[wy][wx] !== '#') continue;
      let score = Infinity;
      for (const [ax, ay] of DIRS) {
        const nx = wx + ax, ny = wy + ay;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const d = dist[ny * w + nx];
        if (d >= 0 && d < score) score = d;
      }
      if (score > bestScore) { bestScore = score; best = [wx, wy]; }
    }
    const [ex, ey] = best;
    grid[ey][ex] = 'X';

    // ---- 鍵・施錠ドア: 鍵→ドア→出口の依存を、可解性を保ったまま作る ----
    // 経路上の「切断タイル」(壁にすると出口が P から切れる床) をドアにし、鍵をその手前
    // (P側の到達域) に置く = 構築上つねに可解。depth 2 は前段の鍵込みの到達域で入れ子になる。
    const floorAt = (x, y) => grid[y][x] === '.';
    let depth = opts.keyDepth || 0;
    if (Array.isArray(depth)) depth = depth[0] + ((rng() * (depth[1] - depth[0] + 1)) | 0);
    depth = Math.min(depth, 2);
    const DOOR_KEY = [['R', 'r'], ['B', 'b']];
    for (let li = 0; li < depth; li++) {
      const [door, key] = DOOR_KEY[li];
      // これまでの鍵込みの到達域から、出口へ向かう切断タイルを探す
      const cuts = [];
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        if (!floorAt(x, y)) continue;
        grid[y][x] = '#';
        if (!isSolvable(grid, w, h, px, py)) cuts.push([x, y, dist[y * w + x]]);
        grid[y][x] = '.';
      }
      if (!cuts.length) break;                    // これ以上ロックできない
      cuts.sort((a, b) => b[2] - a[2]);           // P から遠い切断を優先 (奥にロック)
      const [dxx, dyy] = cuts[(rng() * Math.min(3, cuts.length)) | 0];
      grid[dyy][dxx] = door;
      // 鍵はドアの手前 (鍵未配置の今の到達域) の床。P から遠めを選ぶ
      const near = reachWithKeys(grid, w, h, px, py);
      const kc = [];
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        if (floorAt(x, y) && near[y * w + x] && !(x === px && y === py)) kc.push([x, y, dist[y * w + x]]);
      }
      if (!kc.length) { grid[dyy][dxx] = '.'; break; }   // 置けないならロック撤回
      kc.sort((a, b) => b[2] - a[2]);
      const [kx, ky] = kc[(rng() * Math.min(5, kc.length)) | 0];
      grid[ky][kx] = key;
    }

    // ---- アイテム: 回復・弾薬・アーマーを床にばらまく (密度可変) ----
    if (opts.items) {
      const rn = r => (r ? r[0] + ((rng() * (r[1] - r[0] + 1)) | 0) : 0);
      const scatter = (chars, n) => {
        for (let k = 0; k < n; k++) {
          const cand = [];
          for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (floorAt(x, y)) cand.push([x, y]);
          if (!cand.length) return;
          const [x, y] = cand[(rng() * cand.length) | 0];
          grid[y][x] = chars[(rng() * chars.length) | 0];
        }
      };
      scatter('hH', rn(opts.items.heal));
      scatter('aAsS', rn(opts.items.ammo));
      scatter('pV', rn(opts.items.armor));
    }

    const rnRange = r => (Array.isArray(r) ? r[0] + ((rng() * (r[1] - r[0] + 1)) | 0) : (r || 0));
    // ---- 通常ドア (D): 通路に扉を置く (E で開く)。通行可なので可解性に影響しない ----
    for (let k = 0, nd = rnRange(opts.doors); k < nd; k++) {
      const cand = [];
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        if (!floorAt(x, y)) continue;
        let fl = 0; for (const [dx, dy] of DIRS) if (!REACH_WALL.includes(grid[y + dy][x + dx])) fl++;
        if (fl === 2) cand.push([x, y]);   // 通路 (床の隣接がちょうど2)
      }
      if (!cand.length) break;
      const [x, y] = cand[(rng() * cand.length) | 0];
      grid[y][x] = 'D';
    }
    // ---- 水路 (~): 通行不可のハザード。置いて不可解になったら戻す ----
    for (let k = 0, nw = rnRange(opts.water); k < nw; k++) {
      const cand = [];
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (floorAt(x, y)) cand.push([x, y]);
      if (!cand.length) break;
      const [x, y] = cand[(rng() * cand.length) | 0];
      grid[y][x] = '~';
      if (!isSolvable(grid, w, h, px, py)) grid[y][x] = '.';   // 唯一の道を塞いだら撤回
    }
    // ---- 壁テクスチャの多様化: # の一部を & (テック壁) に (見た目のテーマ差、挙動は同じ) ----
    if (opts.wallMix) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (grid[y][x] === '#' && rng() < opts.wallMix) grid[y][x] = '&';
      }
    }

    // 安全網: 構築上は常に可解だが、万一不可解なら鍵/ドア/水路を外して素の迷路に戻す
    if (!isSolvable(grid, w, h, px, py)) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ('RBrb~'.includes(grid[y][x])) grid[y][x] = '.';
    }

    // ---- テーマ配色: パレットからランダムに (opts.theme 時)。既定は従来の茶系 ----
    const THEMES = [
      { ceilColor: '#1c1c22', floorColor: '#3a322a', fogColor: [10, 8, 8] },   // 茶 (既定)
      { ceilColor: '#101418', floorColor: '#223038', fogColor: [6, 10, 14] },  // 青
      { ceilColor: '#181410', floorColor: '#402820', fogColor: [14, 8, 6] },   // 赤茶
      { ceilColor: '#141814', floorColor: '#283024', fogColor: [8, 12, 8] },   // 緑
      { ceilColor: '#1a1a1a', floorColor: '#303030', fogColor: [11, 11, 13] }, // 灰
    ];
    const theme = opts.theme ? THEMES[(rng() * THEMES.length) | 0] : THEMES[0];

    const startDir = DIRS[(rng() * 4) | 0];
    return {
      name: `MAZE ${size}x${size} #${seed >>> 0}`,
      ceilColor: theme.ceilColor, floorColor: theme.floorColor, fogColor: theme.fogColor,
      startDir, par: 60,
      map: grid.map(row => row.join('')),
      // デバッグ用: 開始→最遠タイルの歩数 (出口はその隣)
      mazeDist: dist[far],
    };
  }

  Object.assign(globalThis, { generateMaze });
})();
