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

    # 闘技場: 敵を全滅させないと終われない。逃げると罰。
    # 通常のステージでは「敵を無視して走り抜ける」のが最適解なので、戦闘は絶対に
    # 学習されなかった (実測: 射撃率60%・キル率0.2% = ただの弾のばら撒き)。
    "arena": {"levels": [0, 1, 2], "mode": "arena", "noEnemies": False, "noItems": False, "maxSteps": 1200},

    # 通しの逆カリキュラム。開始ステージを E1M1〜E1M4 から選び、E1M2 以降から始まる
    # ときだけ「消耗した状態」にする。E1M1 スタートを必ず混ぜるのが肝で、これを
    # やらないと序盤を忘れる (前回の late がこれで失敗: 通し性能 2.90 -> 2.52)。
    "campaign-mix": {
        "levels": [0, 0, 0, 1, 2, 3], "mode": "campaign", "noEnemies": False, "noItems": False,
        "maxSteps": 12000,
        "startHp": [30, 100], "startArmor": [0, 60],
        "startBullets": [10, 70], "startShells": [0, 20], "shotgunChance": 0.6,
    },
}

# 割引率は「どれくらい先まで見えるか」を決める。実効的な視野はおよそ 1/(1-gamma) ステップ。
#   gamma=0.99  ->  100ステップ  … 1ステージ分の判断には十分
#   gamma=0.999 -> 1000ステップ  … 通し(campaign)で「4ステージ先まで生き延びる価値」が見える
# campaign を 0.99 のまま学習すると、次のステージの +20 は見えても全クリアの +50 が
# 割引で消え (50 * 0.99^600 = 0.12)、目先しか見ない方策になってHPを使い果たす。
GAMMA = {"campaign": 0.999, "campaign-mix": 0.999}
N_STEPS = {"campaign": 512, "campaign-mix": 512}   # 長いエピソードのGAEを安定させる


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
            self.cleared.append(info.get("levelsCleared", 0))
        for name in ("rewards", "cleared", "lengths"):
            buf = getattr(self, name)
            if len(buf) > self.window:
                del buf[: -self.window]
        if self.cleared:
            # clear_rate  … 1ステージでもクリアした割合 (single 向き)
            # levels_cleared … 平均何ステージ進めたか 0〜5 (campaign はこっちを見る)
            self.logger.record("hellgrid/clear_rate", float(np.mean([c > 0 for c in self.cleared])))
            self.logger.record("hellgrid/levels_cleared", float(np.mean(self.cleared)))
            self.logger.record("hellgrid/full_clear_rate", float(np.mean([c >= 5 for c in self.cleared])))
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
    gamma = GAMMA.get(args.stage, 0.99)
    n_steps = N_STEPS.get(args.stage, 256)

    venv = VecMonitor(venv)
    # 観測は既に [-1,1] に収めてあるので正規化しない。報酬だけスケールを揃える。
    venv = VecNormalize(venv, norm_obs=False, norm_reward=True, gamma=gamma)

    kwargs = dict(
        n_steps=n_steps,           # 192 envs x n_steps サンプル/更新
        batch_size=8192,
        n_epochs=4,
        gamma=gamma,
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

    print(f"stage={args.stage}  gamma={gamma}  n_steps={n_steps}  envs={args.envs}")
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
            # チェックポイントは1個24MB。500kステップごとに取ると50Mステップで2.4GBになり、
            # ディスクを食い潰す (実際に一度満杯にした)。2Mごとで十分に復旧できる
            CheckpointCallback(save_freq=max(1, 2_000_000 // args.envs), save_path=str(out), name_prefix="ckpt"),
        ],
    )
    model.save(str(out / "final"))
    venv.save(str(out / "vecnorm.pkl"))
    print(f"保存した: {out / 'final.zip'}")
    venv.close()


if __name__ == "__main__":
    main()
