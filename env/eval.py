"""学習した方策を評価する。

    python env/eval.py --model runs/nav/final.zip --stage nav --episodes 50
    python env/eval.py --model runs/single/final.zip --stage single --episodes 50 --deterministic

クリア率・キル率・生存率・所要時間をステージ別に出す。
"""
from __future__ import annotations

import argparse
import pathlib
import sys
from collections import Counter

import numpy as np
from stable_baselines3 import PPO

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from hellgrid_env import HellgridVecEnv  # noqa: E402
from train import STAGES  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--stage", choices=list(STAGES), default="single")
    ap.add_argument("--episodes", type=int, default=50)
    ap.add_argument("--envs", type=int, default=16)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--deterministic", action="store_true", help="確率的にサンプリングせず最頻の行動を取る")
    ap.add_argument("--seed", type=int, default=10_000)
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

    cleared = [r for r in results if r["levelsCleared"] > 0]
    dead = [r for r in results if r["hp"] <= 0]
    by_level = Counter(r["level"] for r in results)
    clear_by_level = Counter(r["level"] for r in cleared)

    print(f"\n{len(results)} エピソード / stage={args.stage} / {'決定的' if args.deterministic else '確率的'}")
    print(f"  クリア率   {len(cleared) / len(results):>6.1%}  ({len(cleared)}/{len(results)})")
    print(f"  死亡率     {len(dead) / len(results):>6.1%}")
    print(f"  平均報酬   {np.mean([r['epReward'] for r in results]):>6.1f}")
    print(f"  平均キル率 {np.mean([r['kills'] / max(1, r['totalKills']) for r in results]):>6.1%}")
    if cleared:
        print(f"  クリア時の平均所要時間 {np.mean([r['timeSec'] for r in cleared]):.1f}秒")
    print("\n  ステージ別クリア率:")
    for lv in sorted(by_level):
        n = by_level[lv]
        print(f"    E1M{lv + 1}  {clear_by_level[lv] / n:>6.1%}  ({clear_by_level[lv]}/{n})")


if __name__ == "__main__":
    main()
