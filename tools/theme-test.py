# テーマ切替の確認: タイトル(両テーマ)と、各テーマでE1M4の同一視点を撮る
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / 'index.html').as_uri()
OUT = ROOT / 'tools'
errors = []

# 広場南から中央の高台を見る視点(キャラと壁と段差が一度に見える)
VIEW = '''
  loadLevel(3); game.state = "playing";
  player.x = 14.5; player.y = 17.5; player.z = 0; player.pitch = 0;
  player.dirX = 0; player.dirY = -1; player.planeX = 0.66; player.planeY = 0;
'''

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1024, 'height': 640})
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_timeout(500)

    # タイトル: hell
    page.screenshot(path=str(OUT / 'th-title-hell.png'))
    # 右キーでpastelへ
    page.keyboard.press('ArrowRight')
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / 'th-title-pastel.png'))
    pastel = page.evaluate('currentTheme')

    # pastelのままE1M4
    page.evaluate(VIEW)
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / 'th-e1m4-pastel.png'))

    # hellに戻して同じ視点
    page.evaluate('applyTheme("hell");')
    page.evaluate(VIEW)
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / 'th-e1m4-hell.png'))

    # pastelで各キャラが見える角度 (テラスの軍曹相当=くま)
    page.evaluate('''
      applyTheme("pastel");
      player.x = 10.5; player.y = 9.5; player.z = 0; player.pitch = 18;
      player.dirX = 1; player.dirY = 0; player.planeX = 0; player.planeY = 0.66;
    ''')
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / 'th-e1m4-pastel-chars.png'))

    print('pastel theme name:', pastel)
    browser.close()

print('CONSOLE ERRORS:', errors if errors else 'none')
