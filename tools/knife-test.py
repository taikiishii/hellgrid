# ナイフ検証: 弾切れ→自動でナイフ、近接で当たる/離れると当たらない、両テーマの見た目
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
    page.wait_for_timeout(400)
    page.keyboard.press('Space')
    page.wait_for_timeout(300)

    # 平坦なE1M1で検証。弾を0にして自動ナイフ持ち替えを確認
    page.evaluate('''
      loadLevel(0); game.state = "playing";
      player.bullets = 0; player.shells = 0; player.hasShotgun = false; player.weapon = 'pistol';
    ''')
    page.wait_for_timeout(100)
    page.evaluate('tryShoot();')  # 弾切れ→ナイフへ
    page.wait_for_timeout(50)
    after_empty = page.evaluate('player.weapon')

    # 敵を正面の近距離に置いてナイフでヒット
    res_near = page.evaluate('''
      (() => {
        player.weapon = 'knife'; player.shootCd = 0;
        player.x = 5; player.y = 5; player.z = 0;
        player.dirX = 1; player.dirY = 0; player.planeX = 0; player.planeY = 0.66;
        // 既存の敵を一旦どかして、テスト用に正面1.0タイルへ1体置く
        const e = level.enemies[0];
        e.dormant = false; e.state = 'idle'; e.hp = 60; e.x = 6.0; e.y = 5.0; e.z = 0;
        const before = e.hp;
        meleeAttack(WEAPONS.knife);
        return { dist: 1.0, before, after: e.hp, hit: e.hp < before };
      })()
    ''')

    # 離れた敵には当たらない (3タイル先)
    res_far = page.evaluate('''
      (() => {
        player.shootCd = 0;
        const e = level.enemies[0];
        e.state = 'idle'; e.hp = 60; e.x = 8.0; e.y = 5.0; e.z = 0;
        const before = e.hp;
        meleeAttack(WEAPONS.knife);
        return { dist: 3.0, before, after: e.hp, hit: e.hp < before };
      })()
    ''')

    # ナイフ何回でデーモン(hp110)を倒せるか
    res_kill = page.evaluate('''
      (() => {
        const e = level.enemies[0];
        e.state = 'idle'; e.hp = 110; e.x = 6.0; e.y = 5.0; e.z = 0;
        let hits = 0;
        while (e.state !== 'dead' && hits < 20) { meleeAttack(WEAPONS.knife); hits++; }
        return { hits, dead: e.state === 'dead' };
      })()
    ''')

    # 見た目(ホラー)
    page.evaluate('''
      player.weapon = 'knife'; player.shootCd = 0; player.bobAmount = 0;
      player.x = 3.5; player.y = 2.5; player.dirX = 1; player.dirY = 0;
      player.planeX = 0; player.planeY = 0.66;
    ''')
    page.wait_for_timeout(100)
    page.screenshot(path=str(OUT / 'kn-hell-idle.png'))
    page.evaluate('player.shootCd = WEAPONS.knife.cooldown;')  # 振り中
    page.wait_for_timeout(50)
    page.screenshot(path=str(OUT / 'kn-hell-swing.png'))

    # 見た目(ほのぼの)
    page.evaluate('applyTheme("pastel"); player.weapon = "knife"; player.shootCd = 0;')
    page.wait_for_timeout(100)
    page.screenshot(path=str(OUT / 'kn-pastel-idle.png'))
    page.evaluate('player.shootCd = WEAPONS.knife.cooldown;')
    page.wait_for_timeout(50)
    page.screenshot(path=str(OUT / 'kn-pastel-swing.png'))

    print('empty->weapon:', after_empty)
    print('near:', res_near)
    print('far :', res_far)
    print('kill:', res_kill)
    browser.close()

print('CONSOLE ERRORS:', errors if errors else 'none')
