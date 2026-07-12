# 学習した PPO の方策を、ブラウザで動く素のJavaScriptに書き出す。
#
#   .venv/Scripts/python.exe tools/export-policy.py runs/single/final.zip
#
# onnxruntime-web は file:// では WASM の fetch がブロックされて動かないので、
# 方策のMLP (1231 -> 512 -> 512 -> 22) を素のJSで実装し、重みだけを base64 で
# 埋め込んだ js/policy.js を吐く。外部依存ゼロ・サーバー不要のまま AI が動く。
#
# 価値関数 (value_net) は推論に不要なので出力しない (サイズが半分になる)。
import base64
import pathlib
import sys

import numpy as np
from stable_baselines3 import PPO

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "js" / "policy.js"

model_path = sys.argv[1] if len(sys.argv) > 1 else "runs/single/final.zip"
model = PPO.load(str(ROOT / model_path), device="cpu")
sd = model.policy.state_dict()
nvec = model.policy.action_space.nvec.tolist()

# activation_fn はクラスそのものが入っている (インスタンスではない)
assert model.policy.activation_fn.__name__ == "Tanh", "活性化関数が Tanh 以外になっている"


def b64(t) -> str:
    return base64.b64encode(np.ascontiguousarray(t.numpy(), dtype="<f4").tobytes()).decode("ascii")


# PyTorch の Linear は y = x @ W.T + b。W は (out, in) なので、
# JS 側では行優先の (out, in) としてそのまま使う。
layers = []
for src, act in [("mlp_extractor.policy_net.0", "tanh"),
                 ("mlp_extractor.policy_net.2", "tanh"),
                 ("action_net", "none")]:
    w, b = sd[f"{src}.weight"], sd[f"{src}.bias"]
    layers.append({"out": w.shape[0], "in": w.shape[1], "act": act, "w": b64(w), "b": b64(b)})

n_params = sum(lay["out"] * lay["in"] + lay["out"] for lay in layers)

body = ",\n".join(
    f'    {{ in: {lay["in"]}, out: {lay["out"]}, act: {lay["act"]!r}, '
    f'w: "{lay["w"]}", b: "{lay["b"]}" }}'.replace("'", '"')
    for lay in layers
)

OUT.write_text(
    f"""'use strict';
/* =========================================================================
 * 学習済みの方策 (自動生成 — 手で編集しない)
 *
 *   元: {model_path}
 *   構成: {" -> ".join([str(layers[0]["in"])] + [str(l["out"]) for l in layers])}  (活性化 tanh)
 *   パラメータ数: {n_params:,}
 *
 * tools/export-policy.py で再生成する。
 * ========================================================================= */
globalThis.POLICY = {{
  obsDim: {layers[0]["in"]},
  nvec: {nvec},
  layers: [
{body}
  ],
}};
""",
    encoding="utf-8",
)

print(f"{model_path} -> js/policy.js")
print(f"  構成        {' -> '.join([str(layers[0]['in'])] + [str(l['out']) for l in layers])}")
print(f"  パラメータ数 {n_params:,}")
print(f"  ファイルサイズ {OUT.stat().st_size / 1e6:.1f} MB")
