# AIの移動方向が「出口への勾配」と「回復への勾配」のどちらに向いているか、
# そしてそれがHPで変わるかを測る。
#
#   .venv/Scripts/python.exe tools/analyze-gradient-follow.py
#
# 観測のグリッドには、出口への勾配 (ch6) と回復への勾配 (ch7) が入っている。
# 各チャネルから「その方向を指すベクトル」を作り、エージェントが実際に選んだ
# 移動方向との一致度 (コサイン類似度) を測る。
#
# HP のスカラーだけを書き換えて比べれば、「HPが低いときだけ回復に向かうのか」が
# 因果的に分かる。
import pathlib
import sys

import numpy as np
from stable_baselines3 import PPO

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "env"))
from protocol import ACTION_NVEC, GRID, GRID_SLICE, SCALARS_SLICE, Worker  # noqa: E402
from train import STAGES  # noqa: E402

HP_IDX = SCALARS_SLICE.start + 0
HEAL_EXISTS = SCALARS_SLICE.start + 25
PLANE = GRID * GRID
G0 = GRID_SLICE.start
HALF = (GRID - 1) // 2

model = PPO.load(str(ROOT / "runs/campaign-mix/final.zip"), device="cpu")

# ---- 実プレイから状態を集める ----
w = Worker(16, STAGES["campaign"], base_seed=31337)
obs = w.reset()
pool = []
for _ in range(400):
    a, _ = model.predict(obs, deterministic=True)
    obs, _, _, _ = w.step(a)
    pool.append(obs.copy())
w.close()
states = np.concatenate(pool, axis=0)
rng = np.random.default_rng(0)
states = states[rng.choice(len(states), min(2500, len(states)), replace=False)]


def grad_vector(s, plane):
    """グリッドのチャネルから「その方向を指す」自己中心ベクトルを作る。
    セル (gx, gy) は 前方 = HALF - gy, 右 = gx - HALF。勾配値で重み付けして足す。"""
    g = s[:, G0 + plane * PLANE: G0 + (plane + 1) * PLANE].reshape(-1, GRID, GRID)
    gy, gx = np.mgrid[0:GRID, 0:GRID]
    fwd = (HALF - gy).astype(np.float32)
    rgt = (gx - HALF).astype(np.float32)
    norm = np.hypot(fwd, rgt)
    norm[HALF, HALF] = 1.0
    fwd, rgt = fwd / norm, rgt / norm          # 単位ベクトル化してから重み付け
    vf = (g * fwd).sum(axis=(1, 2))
    vr = (g * rgt).sum(axis=(1, 2))
    return np.stack([vf, vr], axis=1)


def move_vector(a):
    """行動から自己中心の移動ベクトル (前方, 右) を作る"""
    fwd = np.where(a[:, 0] == 1, 1.0, np.where(a[:, 0] == 2, -1.0, 0.0))
    rgt = np.where(a[:, 1] == 2, 1.0, np.where(a[:, 1] == 1, -1.0, 0.0))
    return np.stack([fwd, rgt], axis=1)


def cos(u, v):
    nu = np.linalg.norm(u, axis=1)
    nv = np.linalg.norm(v, axis=1)
    ok = (nu > 1e-6) & (nv > 1e-6)
    c = np.full(len(u), np.nan)
    c[ok] = (u[ok] * v[ok]).sum(axis=1) / (nu[ok] * nv[ok])
    return c


# 回復への勾配が存在する状態だけを見る (満タン/到達不能なら ch7 は全面 -1 で無意味)
has_heal = states[:, HEAL_EXISTS] > 0.5
print(f"採取した状態 {len(states)}  うち「到達できる回復がある」状態 {has_heal.sum()} "
      f"({has_heal.mean():.0%})\n")

exit_v = grad_vector(states, 6)
heal_v = grad_vector(states, 7)

print("移動方向と各勾配の一致度 (コサイン類似度。1=完全に沿う, 0=無関係, -1=逆)")
print("HPスカラーだけを書き換えて比較 -- 世界の状態はまったく同じ\n")
print(f"{'HP':>5} {'出口の勾配に沿う':>16} {'回復の勾配に沿う':>16} {'前進率':>8} {'アイテムへ向かう率':>18}")
for hp in [10, 25, 50, 75, 95]:
    s = states.copy()
    s[:, HP_IDX] = hp / 100.0
    a, _ = model.predict(s, deterministic=True)
    mv = move_vector(a)
    ce = np.nanmean(cos(mv[has_heal], exit_v[has_heal]))
    ch = np.nanmean(cos(mv[has_heal], heal_v[has_heal]))
    fwd = (a[has_heal, 0] == 1).mean()
    # 回復のほうが出口より「沿っている」状態の割合
    better = np.nanmean(cos(mv[has_heal], heal_v[has_heal]) > cos(mv[has_heal], exit_v[has_heal]))
    print(f"{hp:>5} {ce:>16.3f} {ch:>16.3f} {fwd:>8.1%} {better:>18.1%}")

print("\n参考: 出口の勾配と回復の勾配は、そもそもどれくらい同じ方向を向いているか")
print(f"  コサイン類似度 {np.nanmean(cos(exit_v[has_heal], heal_v[has_heal])):.3f}")
print("  (1に近ければ「回復は出口へ向かう道すがらにある」= 寄り道の必要がない)")
