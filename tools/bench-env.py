# 学習環境のスループット計測とプロトコル検証 (numpy だけで動く。SB3 不要)
#
#   python tools/bench-env.py
#
# Node は単スレッドなので、ワーカー数を増やして初めてコアを使い切れる。
# 何ワーカーでどれだけ出るかをここで確かめる。
import pathlib
import sys
import time

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "env"))
from protocol import ACTION_NVEC, GRID_SLICE, OBS_DIM, RAYS_SLICE, SCALARS_SLICE, Worker  # noqa: E402

CFG = {"levels": [0, 1, 2, 3, 4], "mode": "single", "maxSteps": 900}
ENVS_PER_WORKER = 4
STEPS = 300
rng = np.random.default_rng(0)

# Node は単スレッドなので、ワーカー数を増やして初めてコアを使い切れる。
# (ワーカー数, ワーカーあたりの環境数)
SWEEP = [(1, 16), (2, 16), (4, 16), (8, 16), (12, 16), (12, 32)]


def rand_actions(n):
    return np.stack([rng.integers(0, k, size=n) for k in ACTION_NVEC], axis=1)


# ---- プロトコル検証 ----
w = Worker(ENVS_PER_WORKER, {**CFG, "maxSteps": 60}, base_seed=1)  # 短いエピソードで自動リセットを踏ませる
obs = w.reset()
assert obs.shape == (ENVS_PER_WORKER, OBS_DIM), obs.shape
assert np.isfinite(obs).all(), "観測に NaN/Inf がある"
print(f"観測 {obs.shape}  値域 [{obs.min():.3f}, {obs.max():.3f}]")
print(f"  rays    {obs[:, RAYS_SLICE].shape[1]:>4}次元")
print(f"  grid    {obs[:, GRID_SLICE].shape[1]:>4}次元")
print(f"  scalars {obs[:, SCALARS_SLICE].shape[1]:>4}次元")

ep_ends = 0
for _ in range(STEPS):
    obs, rew, dones, infos = w.step(rand_actions(ENVS_PER_WORKER))
    assert obs.shape == (ENVS_PER_WORKER, OBS_DIM)
    assert np.isfinite(obs).all()
    for i, d in enumerate(dones):
        if d:
            ep_ends += 1
            assert "terminal_observation" in infos[i], "自動リセット時の終了観測がない"
            assert "episode" in infos[i]
print(f"自動リセット: {STEPS}ステップ中 {ep_ends}回のエピソード終了を正しく検出 OK")
w.close()

# ---- スループット ----
print("\nスループット (ランダム方策):")
print(f"{'ワーカー':>8} {'env/worker':>11} {'環境数':>7} {'行動/秒':>10} {'sim step/秒':>12}")
for n_workers, per in SWEEP:
    workers = [Worker(per, CFG, base_seed=1 + i * 10_000) for i in range(n_workers)]
    n_envs = n_workers * per
    for _ in range(10):  # ウォームアップ (JIT)
        for wk in workers:
            wk.step_async(rand_actions(per))
        for wk in workers:
            wk.step_wait()

    acts = [rand_actions(per) for _ in workers]  # 行動生成のコストを計測から外す
    t0 = time.perf_counter()
    for _ in range(STEPS):
        for i, wk in enumerate(workers):
            wk.step_async(acts[i])
        for wk in workers:
            wk.step_wait()
    dt = time.perf_counter() - t0
    aps = STEPS * n_envs / dt
    print(f"{n_workers:>8} {per:>11} {n_envs:>7} {aps:>10,.0f} {aps * 4:>12,.0f}")
    for wk in workers:
        wk.close()
