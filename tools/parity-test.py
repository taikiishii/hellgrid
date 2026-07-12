# パリティテスト: Node のヘッドレスシムと、ブラウザ上のシムが
# 「同じシード + 同じ入力列 -> 同じ状態トレース」になることを検証する。
#
# 学習は Node 側のシムで回し、学習した方策はブラウザで動かす。両者がズレていたら
# 学習した方策はブラウザで通用しない。このテストがその保証になる。
#
#   python tools/parity-test.py
import json
import pathlib
import subprocess
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SEEDS_LEVELS = [(42, 0), (7, 1), (1234, 3), (99, 4)]
STEPS = 900  # 15秒ぶん

ROLLOUT_JS = (ROOT / 'tools' / 'parity-rollout.js').read_text(encoding='utf-8')

# ---- Node 側 ----
node_script = f"""
const {{ createSim }} = require({json.dumps(str(ROOT / 'env' / 'sim-loader.cjs'))});
const vm = require('vm');
const fs = require('fs');
const sim = createSim();
vm.runInContext(fs.readFileSync({json.dumps(str(ROOT / 'tools' / 'parity-rollout.js'))}, 'utf8'), sim);
const out = {json.dumps(SEEDS_LEVELS)}.map(([s, l]) => sim.parityRollout(s, {STEPS}, l));
process.stdout.write(JSON.stringify(out));
"""
node_out = subprocess.run(
    ['node', '-e', node_script], capture_output=True, text=True, cwd=ROOT, check=True
).stdout
node_traces = json.loads(node_out)

# ---- ブラウザ側 ----
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto((ROOT / 'index.html').as_uri())
    page.wait_for_timeout(400)
    browser_traces = page.evaluate(
        ROLLOUT_JS + f"\n({json.dumps(SEEDS_LEVELS)}).map(([s, l]) => parityRollout(s, {STEPS}, l))"
    )
    browser.close()

if errors:
    print('ページエラー:', errors)
    sys.exit(1)

# ---- 比較 ----
ok = True
for (seed, lvl), nt, bt in zip(SEEDS_LEVELS, node_traces, browser_traces):
    if nt == bt:
        print(f'  OK   seed={seed:<5} level={lvl}  {len(nt)} スナップショット一致')
        continue
    ok = False
    print(f'  NG   seed={seed:<5} level={lvl}  不一致')
    for i, (a, b) in enumerate(zip(nt, bt)):
        if a != b:
            print(f'       最初のズレ: スナップショット #{i} (step {i * 20})')
            print(f'         node    = {a}')
            print(f'         browser = {b}')
            break

print('--- パリティ ' + ('OK: Node とブラウザのシムは完全に一致 ---' if ok else 'NG: シムが分岐している ---'))
sys.exit(0 if ok else 1)
