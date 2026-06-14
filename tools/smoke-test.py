# 起動スモークテスト: タイトル→ゲーム開始→E1M4を直接ロードして描画とコンソールエラーを確認
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
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / 'shot1-title.png'))

    # ゲーム開始 (Space)
    page.keyboard.press('Space')
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / 'shot2-e1m1.png'))

    # E1M1で少し前進
    page.keyboard.down('KeyW')
    page.wait_for_timeout(700)
    page.keyboard.up('KeyW')
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / 'shot3-e1m1-move.png'))

    # E1M4を直接ロード
    page.evaluate('loadLevel(3); game.state = "playing";')
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / 'shot4-e1m4-start.png'))

    # 前進して広場へ (中央の高台と階段が見えるはず)
    page.keyboard.down('KeyW')
    page.wait_for_timeout(1200)
    page.keyboard.up('KeyW')
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / 'shot5-e1m4-yard.png'))

    # 見上げる (pitchを直接操作)
    page.evaluate('player.pitch = 110;')
    page.wait_for_timeout(200)
    page.screenshot(path=str(OUT / 'shot6-e1m4-lookup.png'))
    page.evaluate('player.pitch = -110;')
    page.wait_for_timeout(200)
    page.screenshot(path=str(OUT / 'shot7-e1m4-lookdown.png'))

    # 高台(大広間)にテレポートして見下ろし視点を確認
    page.evaluate('player.pitch = -60; player.x = 14.5; player.y = 2.5; player.z = 1.0;')
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / 'shot8-e1m4-hall.png'))

    # テラスから広場を見下ろす
    page.evaluate('''
      player.x = 22.5; player.y = 8.5; player.z = 1.0; player.pitch = -50;
      player.dirX = 0; player.dirY = 1; player.planeX = -0.66; player.planeY = 0;
    ''')
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / 'shot9-e1m4-terrace.png'))

    state = page.evaluate('JSON.stringify({state: game.state, hp: player.health, z: player.z, lvl: level.def.name})')
    print('STATE:', state)
    browser.close()

print('CONSOLE ERRORS:', errors if errors else 'none')
