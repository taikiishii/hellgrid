"""探索版 (env2) の方策を評価する。

    .venv/Scripts/python env/eval2.py --model runs2/maze9/final.zip --stage maze9 --episodes 100

探索の質を測る指標 (docs/next-partial-observability.md §6):
    クリア率        … 出口スイッチを押せたか
    出口発見率      … 出口を視界に入れられたか (クリアの前提)
    カバレッジ      … マップの床の何%を見たか
    発見後クリア率  … 「見つけたのに辿り着けない」の切り分け
"""
from __future__ import annotations

import argparse
import pathlib
import sys

import numpy as np
from stable_baselines3 import PPO

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from hellgrid_env import HellgridVecEnv  # noqa: E402
from train2 import STAGES  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--stage", choices=list(STAGES), default="maze9")
    ap.add_argument("--episodes", type=int, default=100)
    ap.add_argument("--envs", type=int, default=16)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--deterministic", action="store_true")
    ap.add_argument("--seed", type=int, default=10_000, help="学習と重ならないシード帯で評価する")
    args = ap.parse_args()

    venv = HellgridVecEnv(
        num_envs=args.envs, n_workers=args.workers, cfg=STAGES[args.stage], base_seed=args.seed
    )
    model = PPO.load(args.model, device="cpu")

    obs = venv.reset()
    results: list[dict] = []
    while len(results) < args.episodes:
        actions, _ = model.predict(obs, deterministic=args.deterministic)
        obs, _, dones, infos = venv.step(actions)
        for i, d in enumerate(dones):
            if d and len(results) < args.episodes:
                results.append(infos[i])
    venv.close()

    n = len(results)
    cleared = [r for r in results if r["levelsCleared"] > 0]
    seen = [r for r in results if r.get("exitSeen")]
    seen_and_cleared = [r for r in seen if r["levelsCleared"] > 0]

    print(f"\n{n} エピソード / stage={args.stage} / {'決定的' if args.deterministic else '確率的'}")
    print(f"  クリア率       {len(cleared) / n:>6.1%}  ({len(cleared)}/{n})")
    print(f"  出口発見率     {len(seen) / n:>6.1%}  ({len(seen)}/{n})")
    if seen:
        print(f"  発見後クリア率 {len(seen_and_cleared) / len(seen):>6.1%}  (見つけたのに辿り着けない場合ここが下がる)")
    print(f"  平均カバレッジ {np.mean([r['coverage'] for r in results]):>6.1%}")
    print(f"  平均報酬       {np.mean([r['epReward'] for r in results]):>6.1f}")
    print(f"  平均エピソード長 {np.mean([r['steps'] for r in results]):>5.0f} 步")
    if cleared:
        print(f"  クリア時の平均所要 {np.mean([r['steps'] for r in cleared]):>5.0f} 步 "
              f"({np.mean([r['timeSec'] for r in cleared]):.1f}秒)")
        print(f"  クリア時の平均カバレッジ {np.mean([r['coverage'] for r in cleared]):>6.1%}")


if __name__ == "__main__":
    main()
