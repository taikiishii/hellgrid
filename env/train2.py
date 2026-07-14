"""探索版 (env2 = フォグ・オブ・ウォー観測) の PPO 学習。

v1 の train.py とは独立。エージェントは「見たものだけ」で出口を探す。
docs/next-partial-observability.md のカリキュラム第1段階から:

    1. maze9    9x9 のランダム迷路。まず「探索して出口を見つける」が成立するか
    2. maze11   11x11。本命の第1段階
    3. maze15   15x15 + braid (ループあり)。丸暗記が効かないことはマップ生成が保証する
    4. (以降)   敵・アイテムを足す → E1M1〜5 へ転移。設計書 §4 参照

使い方:

    .venv/Scripts/python env/train2.py --stage maze9  --steps 3000000
    .venv/Scripts/python env/train2.py --stage maze11 --steps 8000000 --init runs2/maze9/final.zip

    tensorboard --logdir runs2/

観測に「既知マップ」(記憶) が入っているので、第1段階は LSTM なしの MLP で試す
(設計書の Lv1.5 相当)。これで頭打ちになったら RecurrentPPO に切り替える。
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
    # 迷路サイズは奇数。maxSteps は「ランダム方策でもたまに解ける」程度に余裕を持たせる
    "maze9":  {"env2": True, "mazeSize": 9,  "maxSteps": 400},
    "maze11": {"env2": True, "mazeSize": 11, "maxSteps": 600},
    "maze15": {"env2": True, "mazeSize": 15, "mazeBraid": 0.15, "maxSteps": 900},
    # 部屋つき: 実ステージ (E1M* は部屋+廊下、床243〜425タイル) への転移の橋渡し。
    # サイズと構造 (開けた空間) の両方の軸を一度に飛ばないための中間段階
    "maze21-rooms": {"env2": True, "mazeSize": 21, "mazeBraid": 0.15, "mazeRooms": 5, "maxSteps": 1200},
    "maze25-rooms": {"env2": True, "mazeSize": 25, "mazeBraid": 0.15, "mazeRooms": 7, "maxSteps": 1500},
    # 転移: 既存ステージを探索観測でプレイ (敵なしから)。
    # 入る前に「前段の重みでの成功率が0%でない」ことを eval2 で必ず確認する (教訓6)
    "e1m1-nav": {"env2": True, "levels": [0], "noEnemies": True, "noItems": True, "maxSteps": 1500},
    # 本命の転移段階: E1M1〜M5 (敵なし・キーカードあり) とランダム部屋つき迷路を
    # 50:50 で混ぜる。固定5マップだけで学習すると探索が丸暗記に化け、
    # 迷路を完全に外すと手続き生成で得た探索を忘れる (教訓4)
    "e1m-nav-mix": {
        "env2": True, "levels": [0, 1, 2, 3, 4], "noEnemies": True, "noItems": True,
        "mazeMix": 0.5, "mazeSize": 21, "mazeBraid": 0.15, "mazeRooms": 5,
        "maxSteps": 2000,
    },
    # 敵とアイテムを戻す (設計書 §4 の 3)。迷路は 0.3 に減らして探索の保険に残す。
    # 移行前チェック (e1m-nav-mix の重みでゼロショット): 全体 51% (E1M1 100% /
    # E1M4 0% — 戦闘を学べば引き上がる。ステージ全体では教訓6のゲートを通過)
    "e1m-mix": {
        "env2": True, "levels": [0, 1, 2, 3, 4], "noEnemies": False, "noItems": False,
        "mazeMix": 0.3, "mazeSize": 21, "mazeBraid": 0.15, "mazeRooms": 5,
        "maxSteps": 2000,
    },
    # e1m-mix の実測: E1M4 (敵16体) だけ 0/100 のまま動かない (30M步)。
    # 死因は戦闘力不足 (平均キル0.9・20秒で全滅)。エピソードごとに敵密度を
    # 25〜100% でばらつかせ、「解けるエピソード」を常に混ぜて成功信号を流す
    "e1m-mix2": {
        "env2": True, "levels": [0, 1, 2, 3, 4], "noEnemies": False, "noItems": False,
        "enemyFraction": [0.25, 1.0],
        "mazeMix": 0.2, "mazeSize": 21, "mazeBraid": 0.15, "mazeRooms": 5,
        "maxSteps": 2000,
    },
    # 密度カリキュラムの続き。mix2 で E1M4 が 0% -> 18% (敵100%評価) まで
    # 立ち上がったので、範囲を上に寄せて難しい側の練習量を増やす
    "e1m-mix3": {
        "env2": True, "levels": [0, 1, 2, 3, 4], "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0],
        "mazeMix": 0.2, "mazeSize": 21, "mazeBraid": 0.15, "mazeRooms": 5,
        "maxSteps": 2000,
    },
    # E1M4 だけ 24% で伸びが鈍い (mix3 実測: 平均キル0.8 = 戦わず縫って走る)。
    # E1M4 を3倍サンプリングして練習量を寄せる。他ステージと迷路は混ぜ続ける
    # (難所だけの集中訓練は破滅的忘却で失敗する — v1 教訓4)
    "e1m-mix4": {
        "env2": True, "levels": [0, 1, 2, 3, 3, 3, 4], "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0],
        "mazeMix": 0.15, "mazeSize": 21, "mazeBraid": 0.15, "mazeRooms": 5,
        "maxSteps": 2000,
    },
    # 最終段階: 通し (HP・弾を持ち越し)。開始ステージを混ぜる逆カリキュラム (v1 と同じ)。
    # E1M1 スタートを高確率で残すのが肝 (これを外して v1 は 2.90 -> 2.52 に劣化した)。
    # 記憶は新しいステージごとに白紙。回復整形 (healSeek) の本領はここ
    "e1m-camp-mix": {
        "env2": True, "mode": "campaign", "levels": [0, 0, 0, 1, 2, 3],
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0],
        "startHp": [30, 100], "startArmor": [0, 60],
        "startBullets": [10, 70], "startShells": [0, 20], "shotgunChance": 0.6,
        "maxSteps": 12000,
    },
}

# 割引率: 実効視野はおよそ 1/(1-gamma)。通しは「4ステージ先まで生き延びる価値」が
# 見える長さが必要 (v1 教訓1: gamma=0.99 の campaign は目先だけ見て崩壊した)
GAMMA = {"e1m-camp-mix": 0.999}
# 長いエピソードは GAE を安定させるため n_steps も伸ばす
N_STEPS = {"e1m-camp-mix": 256}


class EntCoefAnneal(BaseCallback):
    """ent_coef を学習の進行に合わせて線形に減衰させる。

    固定 (0.01) のままだと、VecNormalize が報酬をリターンの走行標準偏差で割り続ける
    ため、方策が上達するほど勾配の信号が縮み、固定のエントロピーボーナスが相対的に
    勝ってしまう。maze15 (20M步) で実測: エントロピーが 5.1→6.2 と単調に膨らみ、
    clear_rate が 75%→61% に劣化した。終盤は圧力を弱めて方策を固めさせる。
    """

    def __init__(self, start: float = 0.01, end: float = 0.001):
        super().__init__()
        self.start = start
        self.end = end

    def _on_rollout_start(self) -> None:
        # _current_progress_remaining: 1.0 (開始) -> 0.0 (終了)
        p = self.model._current_progress_remaining
        self.model.ent_coef = self.end + (self.start - self.end) * p

    def _on_step(self) -> bool:
        return True


class ExploreCallback(BaseCallback):
    """探索版の学習指標。クリア率に加えて「出口発見率」と「カバレッジ」を見る。

    クリア率が上がらないとき、原因が「見つけられない」(exit_seen が低い) のか
    「見つけたのに辿り着けない」(exit_seen は高いのに clear が低い) のかを
    切り分けられるようにしておく。
    """

    def __init__(self, window: int = 200):
        super().__init__()
        self.window = window
        self.rewards: list[float] = []
        self.cleared: list[int] = []
        self.lengths: list[int] = []
        self.exit_seen: list[int] = []
        self.coverage: list[float] = []

    def _on_step(self) -> bool:
        for info in self.locals.get("infos", []):
            ep = info.get("episode")
            if ep is None:
                continue
            self.rewards.append(ep["r"])
            self.lengths.append(ep["l"])
            self.cleared.append(info.get("levelsCleared", 0))
            self.exit_seen.append(info.get("exitSeen", 0))
            self.coverage.append(info.get("coverage", 0.0))
        for name in ("rewards", "cleared", "lengths", "exit_seen", "coverage"):
            buf = getattr(self, name)
            if len(buf) > self.window:
                del buf[: -self.window]
        if self.cleared:
            self.logger.record("explore/clear_rate", float(np.mean([c > 0 for c in self.cleared])))
            self.logger.record("explore/exit_seen_rate", float(np.mean(self.exit_seen)))
            self.logger.record("explore/coverage", float(np.mean(self.coverage)))
            self.logger.record("explore/ep_reward", float(np.mean(self.rewards)))
            self.logger.record("explore/ep_len", float(np.mean(self.lengths)))
        return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=list(STAGES), default="maze9")
    ap.add_argument("--steps", type=int, default=3_000_000)
    # 観測が v1 の4倍 (5866) なのでロールアウトバッファが太る。
    # 96 envs x 128 n_steps x 5866 x 4B = 288MB。envs を増やすときはメモリに注意
    ap.add_argument("--envs", type=int, default=96)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--n-steps", type=int, default=128)
    ap.add_argument("--init", type=str, default=None, help="前段の重みを引き継ぐ (.zip)")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    out = ROOT / "runs2" / args.stage
    out.mkdir(parents=True, exist_ok=True)

    venv = HellgridVecEnv(
        num_envs=args.envs, n_workers=args.workers, cfg=STAGES[args.stage], base_seed=args.seed
    )
    # 既定 gamma=0.995 (視野 ~200 步)。通しはステージ別に上書き (GAMMA 参照)
    gamma = GAMMA.get(args.stage, 0.995)
    n_steps = N_STEPS.get(args.stage, args.n_steps)

    venv = VecMonitor(venv)
    venv = VecNormalize(venv, norm_obs=False, norm_reward=True, gamma=gamma)

    kwargs = dict(
        n_steps=n_steps,
        batch_size=4096,
        n_epochs=4,
        gamma=gamma,
        gae_lambda=0.95,
        clip_range=0.2,
        ent_coef=0.01,
        learning_rate=3e-4,
        vf_coef=0.5,
        max_grad_norm=0.5,
        # 学習器が律速 (実測: 学習ループの83%)。512x512 から半減して2倍速にする。
        # 観測 5866 -> 256 の初段だけで 1.5M パラメータあるので表現力は足りる
        policy_kwargs=dict(net_arch=dict(pi=[256, 256], vf=[256, 256])),
        tensorboard_log=str(ROOT / "runs2"),
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
            ExploreCallback(),
            EntCoefAnneal(),
            CheckpointCallback(save_freq=max(1, 2_000_000 // args.envs), save_path=str(out), name_prefix="ckpt"),
        ],
    )
    model.save(str(out / "final"))
    venv.save(str(out / "vecnorm.pkl"))
    print(f"保存した: {out / 'final.zip'}")
    venv.close()


if __name__ == "__main__":
    main()
