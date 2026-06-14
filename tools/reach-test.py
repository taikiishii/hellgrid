# 高さ追加後の到達性チェック: 各マップでスタート→出口がBFSで到達可能か、
# さらに各敵・各アイテムのタイルが到達可能か(高さの段差で孤立していないか)を確認。
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / 'index.html').as_uri()
OUT = ROOT / 'tools'
errors = []

BFS = r'''
(levelIndex) => {
  loadLevel(levelIndex); game.state = "playing";
  const H = level.h, W = level.w;
  const wall = (ch) => ch !== null && !isDoorChar(ch); // ドアは通れる扱い(プレイヤーが開ける)
  const ht = (x,y) => level.heights[y][x];
  const start = [player.x|0, player.y|0];
  const seen = Array.from({length:H}, () => new Array(W).fill(false));
  const q = [start]; seen[start[1]][start[0]] = true;
  const STEP = 0.55;
  while (q.length) {
    const [x,y] = q.shift();
    for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx=x+dx, ny=y+dy;
      if (nx<0||ny<0||nx>=W||ny>=H||seen[ny][nx]) continue;
      const ch = level.grid[ny][nx];
      if (wall(ch)) continue;
      // 段差: ドアでない床同士は登れる高さ差のみ。ドアは0扱い
      const a = isDoorChar(level.grid[y][x]) ? 0 : ht(x,y);
      const b = isDoorChar(ch) ? 0 : ht(nx,ny);
      if (Math.abs(a-b) > STEP) continue;
      seen[ny][nx] = true; q.push([nx,ny]);
    }
  }
  // 出口
  let exit = null;
  for (let y=0;y<H;y++) for (let x=0;x<W;x++) if (level.grid[y][x]==='X') {
    // Xは壁。隣接タイルが到達可能ならクリア可
    for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const ax=x+dx, ay=y+dy;
      if (ax>=0&&ay>=0&&ax<W&&ay<H && !wall(level.grid[ay][ax]) && seen[ay][ax]) exit = true;
    }
  }
  // 敵・アイテムの孤立チェック
  const stranded = [];
  for (const e of level.enemies) {
    if (!seen[e.y|0][e.x|0]) stranded.push(`enemy ${e.type} @${e.x|0},${e.y|0}`);
  }
  for (const it of level.items) {
    if (!seen[it.y|0][it.x|0]) stranded.push(`item ${it.kind} @${it.x|0},${it.y|0}`);
  }
  return { name: level.def.name, start, exitReachable: !!exit, stranded };
}
'''

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1024, 'height': 640})
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_timeout(400)
    page.keyboard.press('Space')
    page.wait_for_timeout(300)

    for i in range(3):
        res = page.evaluate(BFS, i)
        print(f'L{i}:', res)
        page.wait_for_timeout(200)
        page.screenshot(path=str(OUT / f'reach-L{i}.png'))

    browser.close()

print('CONSOLE ERRORS:', errors if errors else 'none')
