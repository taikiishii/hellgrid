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

  function generateMaze(seed, opts = {}) {
    const size = opts.size || 11;
    if (size < 5 || size % 2 === 0) throw new Error(`mazeSize は 5 以上の奇数: ${size}`);
    const rng = makeRNG((seed >>> 0) || 1);
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
      for (let k = 0; k < n && cand.length; k++) {
        const j = (rng() * cand.length) | 0;
        const t = cand.splice(j, 1)[0];
        const r = rng();
        // r < fb: 焔鬼(I, 火球) / 次の15%: 散弾兵(G) / 残り: 亡兵(Z)
        grid[(t / w) | 0][t % w] = r < fb ? 'I' : r < fb + 0.15 ? 'G' : 'Z';
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

    const startDir = DIRS[(rng() * 4) | 0];
    return {
      name: `MAZE ${size}x${size} #${seed >>> 0}`,
      ceilColor: '#1c1c22', floorColor: '#3a322a', fogColor: [10, 8, 8],
      startDir, par: 60,
      map: grid.map(row => row.join('')),
      // デバッグ用: 開始→最遠タイルの歩数 (出口はその隣)
      mazeDist: dist[far],
    };
  }

  Object.assign(globalThis, { generateMaze });
})();
