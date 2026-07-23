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
from collections import Counter

import numpy as np
from stable_baselines3 import PPO

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from hellgrid_env import HellgridVecEnv  # noqa: E402
from train2 import STAGES  # noqa: E402

# 観測レイアウト (env/obs2.js の OBS2_LAYOUT と一致させること)
RAYS = 360
LOCAL_OFF, LOCAL_PLANE, LOCAL_CH = RAYS, 15 * 15, 9
GLOB_OFF, GLOB_PLANE, GLOB_CH = RAYS + 15 * 15 * 9, 24 * 24, 6

# アブレーション: 観測の一部をゼロ埋めして、方策が本当にそれを使っているか測る。
# 「探索している」と主張する前の必須検証 (設計書 §6)。
# 未探索チャネルを消しても性能が落ちなければ、探索チャネルを使っていない。
ABLATIONS = {
    "unexplored": [  # 局所・全体マップの「未探索」チャネル (ch0)
        slice(LOCAL_OFF, LOCAL_OFF + LOCAL_PLANE),
        slice(GLOB_OFF, GLOB_OFF + GLOB_PLANE),
    ],
    "localmap": [slice(LOCAL_OFF, GLOB_OFF)],                            # 既知マップ全体 (自己中心)
    "globalmap": [slice(GLOB_OFF, GLOB_OFF + GLOB_PLANE * GLOB_CH)],     # 全体マップ全体
    "trail": [slice(GLOB_OFF + 3 * GLOB_PLANE, GLOB_OFF + 4 * GLOB_PLANE)],  # 自分の軌跡
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--stage", choices=list(STAGES), default="maze9")
    ap.add_argument("--episodes", type=int, default=100)
    ap.add_argument("--envs", type=int, default=16)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--deterministic", action="store_true")
    ap.add_argument("--seed", type=int, default=10_000, help="学習と重ならないシード帯で評価する")
    ap.add_argument("--ablate", choices=list(ABLATIONS), default=None,
                    help="観測の一部をゼロ埋めして依存度を測る")
    ap.add_argument("--levels", type=int, nargs="+", default=None,
                    help="ステージ設定の levels を上書きしてステージ別に測る (迷路は混ぜない)")
    ap.add_argument("--algo", choices=["ppo", "rppo"], default="ppo")
    args = ap.parse_args()

    cfg = dict(STAGES[args.stage])
    if args.levels is not None:
        cfg["levels"] = args.levels
        cfg["mazeMix"] = 0
    venv = HellgridVecEnv(
        num_envs=args.envs, n_workers=args.workers, cfg=cfg, base_seed=args.seed
    )
    if args.algo == "rppo":
        from sb3_contrib import RecurrentPPO
        model = RecurrentPPO.load(args.model, device="cpu")
    else:
        model = PPO.load(args.model, device="cpu")

    zero_slices = ABLATIONS[args.ablate] if args.ablate else []

    def censor(o: np.ndarray) -> np.ndarray:
        if not zero_slices:
            return o
        o = o.copy()
        for s in zero_slices:
            o[:, s] = 0.0
        return o

    obs = venv.reset()
    results: list[dict] = []
    # rppo は再帰状態を引き回す (episode_start でエピソード境界の状態リセット)。
    # ppo でも同じ呼び方で動く (state は None のまま)
    state = None
    ep_start = np.ones(args.envs, dtype=bool)
    while len(results) < args.episodes:
        actions, state = model.predict(
            censor(obs), state=state, episode_start=ep_start, deterministic=args.deterministic)
        obs, _, dones, infos = venv.step(actions)
        ep_start = dones
        for i, d in enumerate(dones):
            if d and len(results) < args.episodes:
                results.append(infos[i])
    venv.close()

    n = len(results)
    cleared = [r for r in results if r["levelsCleared"] > 0]
    seen = [r for r in results if r.get("exitSeen")]
    seen_and_cleared = [r for r in seen if r["levelsCleared"] > 0]

    label = f"ablate={args.ablate}" if args.ablate else "観測そのまま"
    print(f"\n{n} エピソード / stage={args.stage} / {'決定的' if args.deterministic else '確率的'} / {label}")
    # 通し完走 = 全5面クリア (levelsCleared>=5)。--levels 0 で E1M1 固定スタートにすると
    # この値がそのまま「通し完走率」になる (逆カリキュラム混合スタートでは中途スタート
    # ぶん過大評価になるので注意)。面数分布も出して、どの面で詰まるか見えるようにする
    full = [r for r in results if r["levelsCleared"] >= 5]
    dist = Counter(r["levelsCleared"] for r in results)
    print(f"  通し完走率(5面) {len(full) / n:>6.1%}  ({len(full)}/{n})")
    print(f"  面数分布       " + "  ".join(f"{k}面:{dist.get(k, 0)}" for k in range(0, 6)))
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
    failed = [r for r in results if r["levelsCleared"] == 0]
    if failed:
        # 失敗 = 時間切れ。カバレッジが高いのに失敗 → 「見たのに出口に行けない」
        # カバレッジが低い → 「同じ場所をループして探索が止まっている」
        print(f"  失敗時の平均カバレッジ   {np.mean([r['coverage'] for r in failed]):>6.1%}"
              f"  (出口発見済みで失敗 {sum(1 for r in failed if r.get('exitSeen'))}/{len(failed)})")


if __name__ == "__main__":
    main()
