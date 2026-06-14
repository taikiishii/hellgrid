# E1M5(水路)の検証: 水で止まる/コンベアで流される/出口到達可能、両テーマの見た目
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / 'index.html').as_uri()
OUT = ROOT / 'tools'
errors = []

# 水を考慮したBFS(水タイルは通行不可)
BFS = r'''
(idx) => {
  loadLevel(idx); game.state='playing';
  const H=level.h, W=level.w;
  const blocked=(x,y)=>{
    const ch=level.grid[y][x];
    if (ch!==null && !isDoorChar(ch)) return true; // 壁
    if (level.water[y][x]) return true;             // 水
    return false;
  };
  const s=[player.x|0, player.y|0];
  const seen=Array.from({length:H},()=>new Array(W).fill(false));
  const q=[s]; seen[s[1]][s[0]]=true;
  const STEP=0.55;
  while(q.length){
    const [x,y]=q.shift();
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nx=x+dx, ny=y+dy;
      if(nx<0||ny<0||nx>=W||ny>=H||seen[ny][nx]||blocked(nx,ny)) continue;
      const a=isDoorChar(level.grid[y][x])?0:floorHt(x,y);
      const b=isDoorChar(level.grid[ny][nx])?0:floorHt(nx,ny);
      if(Math.abs(a-b)>STEP) continue;
      seen[ny][nx]=true; q.push([nx,ny]);
    }
  }
  let exit=false;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++) if(level.grid[y][x]==='X')
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const ax=x+dx,ay=y+dy;
      if(ax>=0&&ay>=0&&ax<W&&ay<H&&seen[ay]&&seen[ay][ax]) exit=true;
    }
  return { name:level.def.name, exitReachable:exit };
}
'''

with sync_playwright() as p:
    b=p.chromium.launch(headless=True); pg=b.new_page(viewport={'width':800,'height':500})
    pg.on('console', lambda m: errors.append(m.text) if m.type=='error' else None)
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(URL); pg.wait_for_timeout(400)
    pg.keyboard.press('Space'); pg.wait_for_timeout(300)

    print('reach:', pg.evaluate(BFS, 4))

    # 水で止まる: 池の縁(row3の水 col4-12)へ向かって北上。水に入れず y がある程度で止まる
    pg.evaluate('''
      loadLevel(4); game.state='playing';
      player.x=7.5; player.y=4.5; player.z=0; // Aの行(池の真下)
      player.dirX=0; player.dirY=-1; player.planeX=0.66; player.planeY=0;
    ''')
    pg.keyboard.down('KeyW'); pg.wait_for_timeout(1200); pg.keyboard.up('KeyW'); pg.wait_for_timeout(150)
    water = pg.evaluate('''({
      y:+player.y.toFixed(3),
      enteredWater: !!level.water[player.y|0][player.x|0],
      stoppedAbovePond: player.y > 4.0
    })''')
    print('water-block:', water)

    # コンベア: row5(>)に乗せて静止 → 東へ流されるか
    pg.evaluate('''
      player.x=3.5; player.y=5.5; player.z=0; // 動く歩道の上(西寄り)
    ''')
    x0 = pg.evaluate('player.x')
    pg.wait_for_timeout(700)  # 入力なしで放置
    x1 = pg.evaluate('player.x')
    print('conveyor: x0=%.2f x1=%.2f drift=%.2f (東へ+)' % (x0, x1, x1-x0))

    # 見た目(ホラー)
    pg.evaluate('''
      player.x=8.5; player.y=6.5; player.z=0; player.pitch=10;
      player.dirX=0; player.dirY=-1; player.planeX=0.66; player.planeY=0;
    ''')
    pg.wait_for_timeout(200); pg.screenshot(path=str(OUT/'wt-hell.png'))
    # 見た目(ほのぼの)
    pg.evaluate('applyTheme("pastel");'); pg.wait_for_timeout(200)
    pg.screenshot(path=str(OUT/'wt-pastel.png'))
    b.close()

print('ERRORS:', errors if errors else 'none')
