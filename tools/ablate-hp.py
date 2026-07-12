# 「同じ状況でもHPが違えば行動が変わるか」を因果的に確かめる。
#
#   .venv/Scripts/python.exe tools/ablate-hp.py runs/campaign/final.zip
#
# 実際のプレイから観測を集め、そのうち HP のスカラー1個だけを書き換えて方策に通す。
# 他の条件 (敵の位置、壁、弾、出口までの距離...) は完全に固定されるので、
# 行動が変われば「HPが原因」と言い切れる。介入実験そのもの。
import pathlib
import sys
from collections import Counter

import numpy as np
from stable_baselines3 import PPO

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "env"))
from protocol import ACTION_NVEC, SCALARS_SLICE, Worker  # noqa: E402

HP_IDX = SCALARS_SLICE.start + 0     # スカラー0 = health / 100
model_path = sys.argv[1] if len(sys.argv) > 1 else "runs/campaign/final.zip"
model = PPO.load(str(ROOT / model_path), device="cpu")

# ---- 実際のプレイ中の観測を集める (方策自身に動かせて、現実的な状況を拾う) ----
CFG = {"levels": [0, 1, 2, 3, 4], "mode": "single", "maxSteps": 600}
w = Worker(16, CFG, base_seed=999)
obs = w.reset()
pool = []
for _ in range(120):
    a, _ = model.predict(obs, deterministic=True)
    obs, _, _, _ = w.step(a)
    pool.append(obs.copy())
w.close()
states = np.concatenate(pool, axis=0)
rng = np.random.default_rng(0)
states = states[rng.choice(len(states), 1500, replace=False)]
print(f"実際のプレイから {len(states)} 状態を採取 (モデル: {model_path})\n")

HPS = [10, 25, 50, 75, 100]
NAMES = ["前後", "左右", "旋回", "上下視点", "射撃", "使う(E)", "武器"]

# ---- HP だけを書き換えて行動を比べる ----
acts = {}
for hp in HPS:
    s = states.copy()
    s[:, HP_IDX] = hp / 100.0
    acts[hp], _ = model.predict(s, deterministic=True)

base = acts[100]
print("HP=100 のときの行動と、どれだけ違うか (同一状況・HPだけ変更):")
print(f"{'HP':>5} {'行動が変わった状態':>18} " + " ".join(f"{n:>8}" for n in NAMES))
for hp in HPS:
    diff = acts[hp] != base
    any_diff = diff.any(axis=1).mean()
    per = " ".join(f"{diff[:, i].mean():>8.1%}" for i in range(len(NAMES)))
    print(f"{hp:>5} {any_diff:>18.1%} {per}")

# ---- 中身がどう変わるか ----
print("\n行動の中身 (全状態の平均):")
print(f"{'HP':>5} {'前進率':>8} {'後退率':>8} {'射撃率':>8} {'E率':>8} {'ナイフ率':>9} {'旋回の大きさ':>12}")
for hp in HPS:
    a = acts[hp]
    fwd = (a[:, 0] == 1).mean()
    back = (a[:, 0] == 2).mean()
    fire = (a[:, 4] == 1).mean()
    use = (a[:, 5] == 1).mean()
    knife = (a[:, 6] == 3).mean()
    turn = np.abs(a[:, 2].astype(int) - 2).mean()
    print(f"{hp:>5} {fwd:>8.1%} {back:>8.1%} {fire:>8.1%} {use:>8.1%} {knife:>9.1%} {turn:>12.2f}")

# ---- 敵が見えている状況だけに絞る ----
ENEMY_D = SCALARS_SLICE.start + 21   # 最寄りの見えている敵までの距離 (1.0 = いない)
visible = states[:, ENEMY_D] < 0.999
print(f"\n敵が見えている状況だけ ({visible.sum()}/{len(states)}):")
print(f"{'HP':>5} {'前進率':>8} {'後退率':>8} {'射撃率':>8}")
for hp in HPS:
    a = acts[hp][visible]
    if not len(a):
        continue
    print(f"{hp:>5} {(a[:, 0] == 1).mean():>8.1%} {(a[:, 0] == 2).mean():>8.1%} {(a[:, 4] == 1).mean():>8.1%}")
