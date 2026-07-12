# 方策パリティテスト: PyTorch (学習側) と 素のJS (ブラウザ側) の推論が一致するか。
#
#   .venv/Scripts/python.exe tools/policy-parity.py runs/single/final.zip
#
# js/policy.js は tools/export-policy.py が書き出した重み。同じ観測を入れて、
# 同じ行動が返らなければ、学習した方策はブラウザで別物になっている。
# parity-test.py がシムの一致を保証し、これが推論の一致を保証する。
import json
import pathlib
import subprocess
import sys

import numpy as np
import torch
from stable_baselines3 import PPO

ROOT = pathlib.Path(__file__).resolve().parent.parent
model_path = sys.argv[1] if len(sys.argv) > 1 else "runs/single/final.zip"

model = PPO.load(str(ROOT / model_path), device="cpu")
policy = model.policy
obs_dim = policy.observation_space.shape[0]
nvec = policy.action_space.nvec.tolist()

# 観測は [-1, 1] に収まる設計なので、その範囲でランダムに作る
rng = np.random.default_rng(7)
N = 32
obs = rng.uniform(-1, 1, size=(N, obs_dim)).astype(np.float32)

with torch.no_grad():
    actions, _ = policy.predict(obs, deterministic=True)
    latent = policy.mlp_extractor.forward_actor(torch.as_tensor(obs))
    logits = policy.action_net(latent).numpy()

# ---- JS 側 (js/policy.js + js/ai.js の Policy クラス) ----
# 観測は 32 x 1231 と大きいので、コマンドラインではなくファイルで渡す
tmp = ROOT / "tools" / ".policy-parity-obs.json"
tmp.write_text(json.dumps(obs.tolist()), encoding="utf-8")
runner = ROOT / "tools" / ".policy-parity-run.cjs"
runner.write_text(
    f"""
const fs = require('fs'), vm = require('vm');
const ctx = vm.createContext({{ atob: s => Buffer.from(s, 'base64').toString('binary'), console }});
vm.runInContext(fs.readFileSync({json.dumps(str(ROOT / 'js' / 'policy.js'))}, 'utf8'), ctx);
vm.runInContext(fs.readFileSync({json.dumps(str(ROOT / 'js' / 'ai.js'))}, 'utf8'), ctx);
const p = new ctx.Policy(ctx.POLICY);
const OBS = JSON.parse(fs.readFileSync({json.dumps(str(tmp))}, 'utf8'));
const out = OBS.map(o => {{
  const x = Float32Array.from(o);
  return {{ logits: Array.from(p.forward(x)), action: p.act(x) }};
}});
process.stdout.write(JSON.stringify(out));
""",
    encoding="utf-8",
)
res = json.loads(subprocess.run(["node", str(runner)], capture_output=True, text=True, check=True).stdout)
tmp.unlink()
runner.unlink()

js_actions = np.array([r["action"] for r in res])
js_logits = np.array([r["logits"] for r in res], dtype=np.float32)

max_diff = float(np.abs(js_logits - logits).max())
same = int((js_actions == actions).all(axis=1).sum())

print(f"モデル: {model_path}")
print(f"  構成      {obs_dim} -> ... -> {sum(nvec)}   行動 MultiDiscrete({nvec})")
print(f"  ロジットの最大差 {max_diff:.3e}  (float32の丸め誤差の範囲なら 1e-4 未満)")
print(f"  行動の一致       {same}/{N}")

ok = max_diff < 1e-3 and same == N
print("--- 方策パリティ " + ("OK: PyTorch と JS の推論は一致 ---" if ok else "NG: 推論が食い違っている ---"))
sys.exit(0 if ok else 1)
