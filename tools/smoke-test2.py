# E1M4の立体要素の検証: 階段・高台・ライザー描画、昇降、敵の高さ
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / 'index.html').as_uri()
OUT = ROOT / 'tools'
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1024, 'height': 640})
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_timeout(500)
    page.keyboard.press('Space')
    page.wait_for_timeout(300)
    page.evaluate('loadLevel(3); game.state = "playing";')

    # 1) 広場南から北を見る: 中央の高台(インプ2体)とその奥の階段が見えるはず
    page.evaluate('player.x = 14.5; player.y = 17.5; player.z = 0; player.pitch = 0;')
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / 't2-1-platform.png'))

    # 2) 広場西側から東を見る: テラス(高さ4)のライザーと上の軍曹
    page.evaluate('''
      player.x = 10.5; player.y = 9.5; player.z = 0; player.pitch = 20;
      player.dirX = 1; player.dirY = 0; player.planeX = 0; player.planeY = 0.66;
    ''')
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / 't2-2-terrace-riser.png'))

    # 3) 階段下から見上げる
    page.evaluate('''
      player.x = 14.5; player.y = 8.7; player.z = 0; player.pitch = 40;
      player.dirX = 0; player.dirY = -1; player.planeX = 0.66; player.planeY = 0;
    ''')
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / 't2-3-stairs.png'))

    # 4) 階段を歩いて登る (青キー付与してBドアも開ける)
    page.evaluate('player.keys.blue = true;')
    page.keyboard.down('KeyW')
    page.wait_for_timeout(900)   # 階段を登る
    page.keyboard.up('KeyW')
    page.wait_for_timeout(200)
    mid = page.evaluate('JSON.stringify({x: player.x.toFixed(2), y: player.y.toFixed(2), z: player.z.toFixed(2)})')
    page.keyboard.press('KeyE')  # Bドア
    page.wait_for_timeout(800)
    page.keyboard.down('KeyW')
    page.wait_for_timeout(900)
    page.keyboard.up('KeyW')
    page.wait_for_timeout(200)
    top = page.evaluate('JSON.stringify({x: player.x.toFixed(2), y: player.y.toFixed(2), z: player.z.toFixed(2), hp: player.health})')
    print('STAIR MID:', mid)
    print('AFTER DOOR:', top)
    page.evaluate('player.pitch = -20;')
    page.wait_for_timeout(200)
    page.screenshot(path=str(OUT / 't2-4-hall-entry.png'))

    # 5) 敵の高さ確認
    enemies = page.evaluate('JSON.stringify(level.enemies.map(e => ({t: e.type, x: e.x|0, y: e.y|0, z: e.z})))')
    print('ENEMIES:', enemies)
    browser.close()

print('CONSOLE ERRORS:', errors if errors else 'none')
