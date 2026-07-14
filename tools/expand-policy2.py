"""観測v2 (5866次元) で学習した方策を、観測v3 (5917次元・旋回7バケツ) に移植する。

    .venv/bin/python tools/expand-policy2.py --src runs2/e1m-camp-mix/final.zip --out runs2/e1m-camp-mix/final-v3.zip

観測次元や行動空間を変えると重みの系譜が切れてカリキュラムの再走になるが、
変更が「入力の追加」と「バケツの追加」だけなら外科手術で移植できる:

  - 第1層 (obs -> 256): 旧入力の列を新レイアウトの対応位置へコピー。
    新入力 (飛翔弾レイ2ch x 24本、被弾スカラー3個) の列はゼロ = 「まだ見ていない」
    のと等価で、旧方策の挙動が完全に保存される
  - action_net: 旧の22ロジット行を新の24行へ対応位置コピー。新しい旋回バケツ
    (±12) の行は隣接バケツ (±47 と 0) の平均で初期化 = ほどほどの確率から学習開始

移植直後の方策は旧方策とほぼ同じ挙動になるはず (新入力は無視、新バケツは中間的な
確率で選ばれる)。移植後に必ず旧モデルと同条件で評価して確認すること。
"""
from __future__ import annotations

import argparse
import pathlib
import sys

import numpy as np
import torch
import gymnasium as gym
from gymnasium import spaces
from stable_baselines3 import PPO

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "env"))
from protocol import OBS2_DIM, ACTION_NVEC2  # noqa: E402  (= v3 の次元)

OLD_OBS = 5866
OLD_NVEC = [3, 3, 5, 3, 2, 2, 4]
NEW_OBS = OBS2_DIM              # 5917
NEW_NVEC = ACTION_NVEC2         # [3,3,7,3,2,2,4]

OLD_RAY_CH, NEW_RAY_CH, N_RAYS = 15, 17, 24
OLD_RAYS_DIM = N_RAYS * OLD_RAY_CH   # 360
NEW_RAYS_DIM = N_RAYS * NEW_RAY_CH   # 408


def col_map(j: int) -> int:
    """旧観測の添字 -> 新観測の添字 (レイはチャネル数が増えるので織り込み直す)"""
    if j < OLD_RAYS_DIM:
        return (j // OLD_RAY_CH) * NEW_RAY_CH + (j % OLD_RAY_CH)
    return j + (NEW_RAYS_DIM - OLD_RAYS_DIM)


class _Dummy(gym.Env):
    """空間情報だけを持つダミー環境 (PPO の構築にしか使わない)"""
    observation_space = spaces.Box(-1.0, 1.0, (NEW_OBS,), np.float32)
    action_space = spaces.MultiDiscrete(NEW_NVEC)

    def reset(self, *, seed=None, options=None):
        return np.zeros(NEW_OBS, np.float32), {}

    def step(self, action):
        return np.zeros(NEW_OBS, np.float32), 0.0, True, False, {}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    old = PPO.load(str(ROOT / args.src), device="cpu")
    osd = old.policy.state_dict()
    assert osd["mlp_extractor.policy_net.0.weight"].shape[1] == OLD_OBS, "src が v2 の観測次元ではない"

    new = PPO(
        "MlpPolicy", _Dummy(), device="cpu",
        policy_kwargs=dict(net_arch=dict(pi=[256, 256], vf=[256, 256])),
    )
    nsd = new.policy.state_dict()

    # ---- そのままコピーできる層 (第2層・価値ヘッド) ----
    for k in nsd:
        if k in osd and nsd[k].shape == osd[k].shape:
            nsd[k] = osd[k].clone()

    # ---- 第1層: 列の移植 (新入力はゼロのまま) ----
    cmap = torch.tensor([col_map(j) for j in range(OLD_OBS)], dtype=torch.long)
    for net in ("mlp_extractor.policy_net.0", "mlp_extractor.value_net.0"):
        w = torch.zeros(256, NEW_OBS)
        w[:, cmap] = osd[f"{net}.weight"]
        nsd[f"{net}.weight"] = w
        nsd[f"{net}.bias"] = osd[f"{net}.bias"].clone()

    # ---- action_net: ロジット行の移植 ----
    ow, ob = osd["action_net.weight"], osd["action_net.bias"]
    nw = torch.zeros(sum(NEW_NVEC), 256)
    nb = torch.zeros(sum(NEW_NVEC))
    ooff = noff = 0
    for oi, ni in zip(OLD_NVEC, NEW_NVEC):
        if oi == ni:
            nw[noff:noff + ni] = ow[ooff:ooff + oi]
            nb[noff:noff + ni] = ob[ooff:ooff + oi]
        else:
            # 旋回: 旧 [-94,-47,0,47,94] -> 新 [-94,-47,-12,0,12,47,94]
            assert (oi, ni) == (5, 7)
            for old_k, new_k in zip(range(5), (0, 1, 3, 5, 6)):
                nw[noff + new_k] = ow[ooff + old_k]
                nb[noff + new_k] = ob[ooff + old_k]
            for new_k, (a, b) in ((2, (1, 2)), (4, (2, 3))):   # ±12 は隣接の平均
                nw[noff + new_k] = (ow[ooff + a] + ow[ooff + b]) / 2
                nb[noff + new_k] = (ob[ooff + a] + ob[ooff + b]) / 2
        ooff += oi
        noff += ni
    nsd["action_net.weight"] = nw
    nsd["action_net.bias"] = nb

    new.policy.load_state_dict(nsd)
    out = ROOT / args.out
    new.save(str(out))
    n_old = sum(v.numel() for v in osd.values())
    n_new = sum(v.numel() for v in nsd.values())
    print(f"移植完了: {args.src} ({OLD_OBS}次元/{sum(OLD_NVEC)}ロジット, {n_old:,}param)")
    print(f"      -> {args.out} ({NEW_OBS}次元/{sum(NEW_NVEC)}ロジット, {n_new:,}param)")


if __name__ == "__main__":
    main()
