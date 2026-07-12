# AIデモの検証: ブラウザで学習済みの方策にプレイさせ、実際にクリアできるか確かめる。
#
#   python tools/ai-demo-test.py
#
# Node で学習した方策が、ブラウザ上でも同じように動くことの最終確認になる
# (parity-test.py がシムの一致を保証し、これが観測・行動・推論の一致を保証する)。
import pathlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / "index.html").as_uri()

errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1024, "height": 640})
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(URL)
    page.wait_for_timeout(2000)  # policy.js (4.8MB) の読み込みを待つ
    page.screenshot(path=str(ROOT / "tools" / "ai-1-title.png"))

    print("方策の読み込み:", page.evaluate("typeof POLICY !== 'undefined' ? `OK ${POLICY.layers.length}層 obsDim=${POLICY.obsDim}` : 'NG 見つからない'"))

    page.keyboard.press("KeyI")   # AI デモ開始
    page.wait_for_timeout(1500)
    page.screenshot(path=str(ROOT / "tools" / "ai-2-playing.png"))
    print("AI 起動:", page.evaluate("ai ? 'OK' : 'NG'"))

    # AI は止まらずに全ステージを回り続ける。決着がついた瞬間だけを拾う
    import json

    results = []
    prev_key = None
    for _ in range(300):          # 最大150秒ぶん
        page.wait_for_timeout(500)
        s = json.loads(page.evaluate("""JSON.stringify({
            state: HG.world.state,
            lvl: HG.world.level.index,
            name: HG.world.level.def.name,
            hp: Math.round(HG.world.player.health),
            kills: HG.world.level.kills,
            total: HG.world.level.totalKills,
            t: Math.round(HG.world.level.time * 10) / 10,
            goal: ai.goalDist(),
        })"""))
        if s["state"] == "playing":
            prev_key = None
            continue
        key = (s["lvl"], s["state"], s["t"])
        if key == prev_key:
            continue
        prev_key = key
        results.append(s)
        tag = "クリア" if s["state"] in ("levelEnd", "gameClear") else "死亡  "
        print(f"  {tag}  {s['name']:<14} {s['t']:>5.1f}秒  HP {s['hp']:>3}  キル {s['kills']:>2}/{s['total']:<2} 出口まで{s['goal']:>3}歩")
        page.screenshot(path=str(ROOT / "tools" / f"ai-{len(results):02d}-{s['state']}-{s['lvl']}.png"))
        if len({r["lvl"] for r in results}) == 5 and len(results) >= 5:
            break

    cleared = [r for r in results if r["state"] in ("levelEnd", "gameClear")]
    print(f"\n  {len(cleared)}/{len(results)} クリア")
    browser.close()

print("コンソールエラー:", errors if errors else "なし")
