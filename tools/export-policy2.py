# 探索版 (観測v3) の方策を、ブラウザで動く素のJavaScriptに書き出す。
#
#   .venv/Scripts/python tools/export-policy2.py --src runs2/e1m-camp-mix/final-v3r2.zip \
#       --name champion --label "チャンピオン (通し完走37%)"
#
# v1 の export-policy.py と同じ方式 (重みを base64 で埋め込んだ素のJS) だが、
# 複数の段階のポリシーを同時に載せるため、js/policy2-<name>.js に
# POLICIES2[name] として登録するレジストリ形式にしている。
#
# 旧観測 (v2, 5866次元) のモデルは先に tools/expand-policy2.py で v3 に変換すること。
import argparse
import base64
import pathlib
import sys

import numpy as np
from stable_baselines3 import PPO

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "env"))
from protocol import OBS2_DIM, ACTION_NVEC2  # noqa: E402


def b64(t) -> str:
    return base64.b64encode(np.ascontiguousarray(t.numpy(), dtype="<f4").tobytes()).decode("ascii")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--name", required=True, help="POLICIES2 のキー (英数字)")
    ap.add_argument("--label", required=True, help="デモの UI に出す表示名")
    args = ap.parse_args()

    model = PPO.load(str(ROOT / args.src), device="cpu")
    sd = model.policy.state_dict()
    nvec = model.policy.action_space.nvec.tolist()
    obs_dim = sd["mlp_extractor.policy_net.0.weight"].shape[1]
    assert obs_dim == OBS2_DIM, f"観測次元が v3 ではない ({obs_dim})。expand-policy2.py で変換すること"
    assert nvec == ACTION_NVEC2, f"行動空間が v3 ではない ({nvec})"
    assert model.policy.activation_fn.__name__ == "Tanh"

    layers = []
    for src, act in [("mlp_extractor.policy_net.0", "tanh"),
                     ("mlp_extractor.policy_net.2", "tanh"),
                     ("action_net", "none")]:
        w, b = sd[f"{src}.weight"], sd[f"{src}.bias"]
        layers.append({"out": w.shape[0], "in": w.shape[1], "act": act, "w": b64(w), "b": b64(b)})

    body = ",\n".join(
        f'    {{ in: {lay["in"]}, out: {lay["out"]}, act: {lay["act"]!r}, '
        f'w: "{lay["w"]}", b: "{lay["b"]}" }}'
        for lay in layers
    )
    out = ROOT / "js" / f"policy2-{args.name}.js"
    out.write_text(
        f"""'use strict';
/* 学習済みの方策 (自動生成 — 手で編集しない)
 *   元: {args.src}
 *   構成: {" -> ".join([str(layers[0]["in"])] + [str(lay["out"]) for lay in layers])}  (活性化 tanh)
 * tools/export-policy2.py で再生成する。 */
globalThis.POLICIES2 = globalThis.POLICIES2 || {{}};
POLICIES2[{args.name!r}] = {{
  label: {args.label!r},
  obsDim: {obs_dim},
  nvec: {nvec},
  layers: [
{body}
  ],
}};
""",
        encoding="utf-8",
    )
    print(f"書き出した: {out.relative_to(ROOT)} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
