"""HELLGRID の強化学習環境 — Stable-Baselines3 の VecEnv として見せる。

    from hellgrid_env import HellgridVecEnv
    venv = HellgridVecEnv(num_envs=32, cfg={"levels": [0], "mode": "single"})
    obs = venv.reset()                                # (32, 1231)
    obs, rewards, dones, infos = venv.step(actions)   # actions: (32, 7)

環境設定 cfg (env/env.js の HellgridEnv に渡る):
    levels     : 学習に使うステージ番号のリスト。毎エピソード1つ選ぶ
    mode       : 'single' = 1ステージで終了 / 'campaign' = 全ステージ通し
    maxSteps   : 行動ステップ上限 (15Hz なので 3000 = 約200秒)
    frameSkip  : 1行動あたりのシムステップ数 (既定4 = 15Hz で判断)
    noEnemies  : 敵なし (カリキュラム第1段階: 出口に着くことだけを学ぶ)
    noItems    : 補給品なし (キーカードは残る)

観測は Box(1231,)。内訳は env/obs.js と env/protocol.py の *_SLICE を参照。
"""
from __future__ import annotations

import os

import numpy as np
from gymnasium import spaces
from stable_baselines3.common.vec_env.base_vec_env import VecEnv

from protocol import ACTION_NVEC, OBS_DIM, Worker, action_nvec_for, obs_dim_for  # noqa: F401


class HellgridVecEnv(VecEnv):
    """num_envs 個の環境を n_workers 個の Node プロセスに分けて並列に回す。"""

    def __init__(
        self,
        num_envs: int = 32,
        n_workers: int | None = None,
        cfg: dict | None = None,
        base_seed: int = 0,
    ):
        if n_workers is None:
            n_workers = max(1, min(num_envs, (os.cpu_count() or 4) - 2))
        while num_envs % n_workers != 0:
            n_workers -= 1
        per = num_envs // n_workers

        super().__init__(
            num_envs,
            # 観測・行動空間は cfg で決まる (env2:True でフォグ・オブ・ウォー版)
            spaces.Box(low=-1.0, high=1.0, shape=(obs_dim_for(cfg),), dtype=np.float32),
            spaces.MultiDiscrete(action_nvec_for(cfg)),
        )
        self.n_workers = n_workers
        self.per = per
        self.workers = [
            Worker(per, cfg, base_seed=base_seed + 1 + w * 1_000_000) for w in range(n_workers)
        ]
        self._actions: np.ndarray | None = None

    def reset(self) -> np.ndarray:
        return np.concatenate([w.reset() for w in self.workers], axis=0)

    def step_async(self, actions: np.ndarray) -> None:
        self._actions = np.asarray(actions)
        # 先に全ワーカーへ投げてから回収する。ここでワーカー間が並列に走る
        for i, w in enumerate(self.workers):
            w.step_async(self._actions[i * self.per : (i + 1) * self.per])

    def step_wait(self):
        obs_l, rew_l, done_l, infos = [], [], [], []
        for w in self.workers:
            o, r, d, inf = w.step_wait()
            obs_l.append(o)
            rew_l.append(r)
            done_l.append(d)
            infos.extend(inf)
        return (
            np.concatenate(obs_l, axis=0),
            np.concatenate(rew_l, axis=0),
            np.concatenate(done_l, axis=0),
            infos,
        )

    def close(self) -> None:
        for w in self.workers:
            w.close()

    # VecEnv の抽象メソッド。環境の実体は Node 側にあるので属性は持たない。
    # SB3 は初期化時に render_mode を問い合わせてくるので、そこだけ答える。
    def get_attr(self, attr_name, indices=None):
        n = self.num_envs if indices is None else len(list(indices))
        if attr_name == "render_mode":
            return [None] * n
        raise NotImplementedError(f"get_attr({attr_name}) は未対応")

    def set_attr(self, attr_name, value, indices=None):
        raise NotImplementedError

    def env_method(self, method_name, *args, indices=None, **kwargs):
        raise NotImplementedError

    def env_is_wrapped(self, wrapper_class, indices=None):
        return [False] * self.num_envs
