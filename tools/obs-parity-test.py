# 観測パリティテスト: 学習時 (env/env.js) とブラウザ (js/ai.js) が、
# 同じ状況でまったく同じ観測ベクトルを作るかを検証する。
#
#   python tools/obs-parity-test.py
#
# これがないと「ネットワークは正しいのに、食わせている観測が違う」という事故が起きる。
# 実際に一度やらかした: js/ai.js が buildObs に補給場を渡し忘れ、ch7/ch8 が全部 -1 の
# 壊れた観測を方策に食わせていた。推論パリティ (policy-parity.py) はネットワークしか
# 見ないので、この手のバグは検出できない。
import json
import pathlib
import subprocess

import numpy as np
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SEED, LEVEL, STEPS = 4242, 0, 240

# 決まった行動列 (方策に依存しない)。同じシード + 同じ行動列 -> 同じ状態列になる
ACTIONS = [[(i * 7 + k * 3) % n for k, n in enumerate([3, 3, 5, 3, 2, 2, 4])] for i in range(STEPS)]

# ---- Node 側: 学習環境 (HellgridEnv) が作る観測 ----
runner = ROOT / "tools" / ".obs-parity.cjs"
runner.write_text(f"""
const {{ createEnvContext }} = require({json.dumps(str(ROOT / 'env' / 'sim-loader.cjs'))});
const ctx = createEnvContext();
const env = new ctx.HellgridEnv({{ levels: [{LEVEL}], mode: 'campaign', maxSteps: 100000 }});
const ACTIONS = {json.dumps(ACTIONS)};
let obs = env.reset({SEED});
const out = [Array.from(obs)];
for (const a of ACTIONS) {{
  const r = env.step(a);
  out.push(Array.from(r.obs));
  if (r.terminated || r.truncated) break;
}}
process.stdout.write(JSON.stringify(out));
""", encoding="utf-8")
node_obs = np.array(json.loads(
    subprocess.run(["node", str(runner)], capture_output=True, text=True, check=True).stdout), dtype=np.float32)
runner.unlink()

# ---- ブラウザ側: AIDriver が作る観測 ----
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto((ROOT / "index.html").as_uri())
    page.wait_for_timeout(2500)
    browser_obs = np.array(page.evaluate(f"""(() => {{
        const ACTIONS = {json.dumps(ACTIONS)};
        HG.newGame();
        const w = HG.world;
        w.reset({LEVEL}, {SEED});
        w.drainEvents();
        HG.enableAI();
        const d = HG.ai;
        d.syncLevel();
        const out = [];
        // AIDriver が方策を呼ぶ代わりに、決まった行動を流し込む
        d.script = ACTIONS;
        d.frame = 0; d.tick = 0;
        out.push(Array.from((buildObs(w, d.goal, d.obs, d.supply), d.obs)));
        for (let i = 0; i < ACTIONS.length; i++) {{
            for (let k = 0; k < AI_FRAME_SKIP; k++) {{ d.preStep(); w.step(SIM_DT); }}
            w.drainEvents();
            d.refreshSupply();
            buildObs(w, d.goal, d.obs, d.supply);
            out.push(Array.from(d.obs));
            if (w.state !== 'playing') break;
        }}
        return out;
    }})()"""), dtype=np.float32)
    browser.close()

if errors:
    print("ページエラー:", errors)
    raise SystemExit(1)

n = min(len(node_obs), len(browser_obs))
diff = np.abs(node_obs[:n] - browser_obs[:n])
max_diff = float(diff.max())
bad_steps = int((diff.max(axis=1) > 1e-5).sum())

print(f"比較したステップ数 {n}  (node {len(node_obs)} / browser {len(browser_obs)})")
print(f"  観測の最大差   {max_diff:.3e}")
print(f"  食い違うステップ {bad_steps}/{n}")

if bad_steps:
    s = int(np.argmax(diff.max(axis=1)))
    ch = int(np.argmax(diff[s]))
    print(f"  最初にズレる箇所: ステップ {s}, 次元 {ch}  node={node_obs[s][ch]:.4f} browser={browser_obs[s][ch]:.4f}")

ok = max_diff < 1e-5 and n > STEPS // 2
print("--- 観測パリティ " + ("OK: 学習時とブラウザの観測は一致 ---" if ok else "NG: 観測が食い違っている ---"))
raise SystemExit(0 if ok else 1)
