# このマシンで PPO が何 fps 出るかを、環境と学習器に分けて測る。
#
#   .venv/bin/python tools/bench-machine.py
#   .venv/bin/python tools/bench-machine.py --envs 384 --workers 24
#
# 学習ループの時間は「環境を回す」と「勾配を更新する」の2つに割れる。どちらが律速かで
# ハードの選び方が180度変わるので、必ず測ってから決めること。
#
#   環境が律速   -> vCPU を増やすと効く。GPU は効かない
#   学習器が律速 -> GPU、または網を縮めると効く
import argparse
import pathlib
import sys
import time

import numpy as np
import torch
from stable_baselines3 import PPO

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "env"))
from hellgrid_env import HellgridVecEnv  # noqa: E402
from protocol import ACTION_NVEC, OBS_DIM  # noqa: E402
from train import STAGES  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--envs", type=int, default=192)
ap.add_argument("--workers", type=int, default=12)
ap.add_argument("--n-steps", type=int, default=512, help="PPOのロールアウト長")
ap.add_argument("--steps", type=int, default=150, help="環境ベンチのステップ数")
args = ap.parse_args()

ROLLOUT = args.envs * args.n_steps
CAP = torch.backends.cpu.get_cpu_capability()

print(f"CPU      {torch.get_num_threads()} スレッド  /  PyTorch カーネル: {CAP}")
if CAP != "AVX2":
    print("  !!! 警告: AVX2 が無効です。行列積が3〜4倍遅くなります")
    print("      (仮想マシンなら CPU Type を host にすること)")
print(f"観測     {OBS_DIM} 次元")
print(f"設定     {args.envs} 環境 / {args.workers} ワーカー / ロールアウト {ROLLOUT:,} ステップ\n")

# ---- 1. 環境を回す速度 ----
venv = HellgridVecEnv(num_envs=args.envs, n_workers=args.workers,
                      cfg=STAGES["single"], base_seed=1)
venv.reset()
acts = np.stack([np.random.randint(0, int(n), args.envs) for n in ACTION_NVEC], axis=1)
for _ in range(20):
    venv.step(acts)                      # ウォームアップ
t0 = time.perf_counter()
for _ in range(args.steps):
    venv.step(acts)
env_rate = args.envs * args.steps / (time.perf_counter() - t0)
venv.close()
env_sec = ROLLOUT / env_rate

# ---- 2. 勾配を更新する速度 (学習時と同じ形) ----
venv2 = HellgridVecEnv(num_envs=2, n_workers=1, cfg=STAGES["single"], base_seed=1)
model = PPO("MlpPolicy", venv2, n_steps=8, batch_size=8192, n_epochs=4, device="cpu",
            policy_kwargs=dict(net_arch=dict(pi=[512, 512], vf=[512, 512])), verbose=0)
p = model.policy
o = torch.randn(ROLLOUT, OBS_DIM)
a = torch.stack([torch.randint(0, int(n), (ROLLOUT,)) for n in ACTION_NVEC], dim=1)
bs = 8192
t0 = time.perf_counter()
for _ in range(4):
    for i in range(0, ROLLOUT, bs):
        v, lp, ent = p.evaluate_actions(o[i:i + bs], a[i:i + bs])
        loss = lp.mean() + v.mean() + ent.mean()
        p.optimizer.zero_grad()
        loss.backward()
        p.optimizer.step()
learn_sec = time.perf_counter() - t0
venv2.close()

total = env_sec + learn_sec
fps = ROLLOUT / total
print(f"1ロールアウト ({ROLLOUT:,} ステップ) あたり")
print(f"  環境を回す      {env_sec:6.1f} 秒  ({env_sec / total:4.0%})   {env_rate:8,.0f} 行動/秒")
print(f"  勾配を更新する  {learn_sec:6.1f} 秒  ({learn_sec / total:4.0%})   4エポック / バッチ {bs}")
print("  ----------------------------------")
print(f"  合計            {total:6.1f} 秒  ->  {fps:,.0f} fps\n")

print("この fps でかかる時間")
for steps, label in [(53_000_000, "現行のカリキュラム (53M)"),
                     (500_000_000, "探索版 最小 (500M)"),
                     (1_500_000_000, "探索版 本番 (1.5G)")]:
    h = steps / fps / 3600
    print(f"  {label:<26} {h:7.1f} 時間" + (f"  ({h / 24:.1f} 日)" if h > 48 else ""))

slow = "環境" if env_sec > learn_sec else "勾配更新"
hint = ("vCPU を増やすと効く。GPU は効かない" if env_sec > learn_sec
        else "GPU、または網を縮めると効く")
print(f"\n律速は「{slow}」 -> {hint}")
