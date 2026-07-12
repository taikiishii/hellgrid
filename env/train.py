"""PPO で HELLGRID を学習する。

カリキュラム (段階を追って難しくする。前段の重みを --init で引き継ぐ):

    1. nav      敵もアイテムもなし・E1M1 だけ。「出口に着く」ことだけを学ぶ
    2. nav-all  敵なし・全5ステージ。キーカードとロックドアが入ってくる
    3. combat   E1M2 (闘技場) で戦闘。報酬が密なので戦い方が速く身につく
    4. single   全5ステージ・敵もアイテムもあり。1ステージ単位でクリアを学ぶ
    5. campaign E1M1 から通しでクリア。HPと弾の持ち越しがあるのでリソース管理も入る

使い方:

    python env/train.py --stage nav      --steps 2000000
    python env/train.py --stage nav-all  --steps 5000000  --init runs/nav/final.zip
    python env/train.py --stage combat   --steps 5000000  --init runs/nav-all/final.zip
    python env/train.py --stage single   --steps 20000000 --init runs/combat/final.zip
    python env/train.py --stage campaign --steps 20000000 --init runs/single/final.zip

    tensorboard --logdir runs/
"""
from __future__ import annotations

import argparse
import pathlib
import sys

import numpy as np
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback, CheckpointCallback
from stable_baselines3.common.vec_env import VecMonitor, VecNormalize

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from hellgrid_env import HellgridVecEnv  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent

STAGES = {
    "nav":      {"levels": [0],             "mode": "single",   "noEnemies": True,  "noItems": True,  "maxSteps": 1500},
    "nav-all":  {"levels": [0, 1, 2, 3, 4], "mode": "single",   "noEnemies": True,  "noItems": False, "maxSteps": 2000},
    "combat":   {"levels": [1],             "mode": "single",   "noEnemies": False, "noItems": False, "maxSteps": 2000},
    "single":   {"levels": [0, 1, 2, 3, 4], "mode": "single",   "noEnemies": False, "noItems": False, "maxSteps": 3000},
    "campaign": {"levels": [0],             "mode": "campaign", "noEnemies": False, "noItems": False, "maxSteps": 12000},
}


class ProgressCallback(BaseCallback):
    """クリア率と平均報酬を TensorBoard に出す。学習が進んでいるかはこれで見る。"""

    def __init__(self, window: int = 100):
        super().__init__()
        self.window = window
        self.rewards: list[float] = []
        self.cleared: list[int] = []
        self.lengths: list[int] = []

    def _on_step(self) -> bool:
        for info in self.locals.get("infos", []):
            ep = info.get("episode")
            if ep is None:
                continue
            self.rewards.append(ep["r"])
            self.lengths.append(ep["l"])
            # VecMonitor が info["episode"] を自前のものに差し替えるので、
            # クリア判定は Node から来た levelsCleared を直接見る
            self.cleared.append(1 if info.get("levelsCleared", 0) > 0 else 0)
        for name in ("rewards", "cleared", "lengths"):
            buf = getattr(self, name)
            if len(buf) > self.window:
                del buf[: -self.window]
        if self.cleared:
            self.logger.record("hellgrid/clear_rate", float(np.mean(self.cleared)))
            self.logger.record("hellgrid/ep_reward", float(np.mean(self.rewards)))
            self.logger.record("hellgrid/ep_len", float(np.mean(self.lengths)))
        return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=list(STAGES), default="nav")
    ap.add_argument("--steps", type=int, default=2_000_000)
    ap.add_argument("--envs", type=int, default=192)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--init", type=str, default=None, help="前段の重みを引き継ぐ (.zip)")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    out = ROOT / "runs" / args.stage
    out.mkdir(parents=True, exist_ok=True)

    venv = HellgridVecEnv(
        num_envs=args.envs, n_workers=args.workers, cfg=STAGES[args.stage], base_seed=args.seed
    )
    venv = VecMonitor(venv)
    # 観測は既に [-1,1] に収めてあるので正規化しない。報酬だけスケールを揃える。
    venv = VecNormalize(venv, norm_obs=False, norm_reward=True, gamma=0.99)

    kwargs = dict(
        n_steps=256,               # 192 envs x 256 = 49k サンプル/更新
        batch_size=8192,
        n_epochs=4,
        gamma=0.99,
        gae_lambda=0.95,
        clip_range=0.2,
        ent_coef=0.01,             # 探索を切らさない (疎報酬の序盤で効く)
        learning_rate=3e-4,
        vf_coef=0.5,
        max_grad_norm=0.5,
        policy_kwargs=dict(net_arch=dict(pi=[512, 512], vf=[512, 512])),
        tensorboard_log=str(ROOT / "runs"),
        verbose=1,
        seed=args.seed,
    )

    if args.init:
        model = PPO.load(args.init, env=venv, **{k: v for k, v in kwargs.items() if k != "policy_kwargs"})
        print(f"前段の重みを読み込んだ: {args.init}")
    else:
        model = PPO("MlpPolicy", venv, **kwargs)

    model.learn(
        total_timesteps=args.steps,
        tb_log_name=args.stage,
        callback=[
            ProgressCallback(),
            CheckpointCallback(save_freq=max(1, 500_000 // args.envs), save_path=str(out), name_prefix="ckpt"),
        ],
    )
    model.save(str(out / "final"))
    venv.save(str(out / "vecnorm.pkl"))
    print(f"保存した: {out / 'final.zip'}")
    venv.close()


if __name__ == "__main__":
    main()
