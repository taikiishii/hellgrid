"""env/server.js (Node) と話す低レベル層。numpy にしか依存しない。

Node は単スレッドなので、1プロセスあたり ~3.5k 行動/秒が上限。コアを使い切るには
Worker を複数立ち上げて環境を分割する (env/hellgrid_env.py の HellgridVecEnv)。

フレーム形式:  [u32 headerLen][header JSON (utf8)][float32 の観測ブロブ]
"""
from __future__ import annotations

import json
import pathlib
import struct
import subprocess
from typing import Any, Sequence

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVER = ROOT / "env" / "server.js"

OBS_DIM = 1477    # 従来版 (env/obs.js)
OBS2_DIM = 5866   # 探索版 (env/obs2.js)。cfg に env2:True を入れると server.js が切り替える
ACTION_NVEC = [3, 3, 5, 3, 2, 2, 4]


def obs_dim_for(cfg: dict | None) -> int:
    """cfg から観測次元を決める。env2 フラグでフォグ・オブ・ウォー版になる。"""
    return OBS2_DIM if (cfg or {}).get("env2") else OBS_DIM

# 観測の内訳 (grid を CNN に流したくなったときに切り出せるよう公開しておく)
# grid の ch6/ch7/ch8 = 出口 / 回復 / 弾薬 へのBFS勾配
N_RAYS, RAY_CH = 24, 15
GRID, GRID_CH = 11, 9
RAYS_SLICE = slice(0, N_RAYS * RAY_CH)
GRID_SLICE = slice(N_RAYS * RAY_CH, N_RAYS * RAY_CH + GRID * GRID * GRID_CH)
SCALARS_SLICE = slice(N_RAYS * RAY_CH + GRID * GRID * GRID_CH, OBS_DIM)


class Worker:
    """Node プロセス1つ。環境を n_envs 個ホストし、まとめて step する。"""

    def __init__(self, n_envs: int, cfg: dict | None = None, base_seed: int = 1):
        self.n = n_envs
        self.obs_dim = obs_dim_for(cfg)
        self.proc = subprocess.Popen(
            ["node", str(SERVER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            cwd=str(ROOT),
        )
        header, obs = self._call({"cmd": "init", "n": n_envs, "cfg": cfg or {}, "baseSeed": base_seed})
        if header.get("obsDim") != self.obs_dim:
            raise RuntimeError(f"観測次元が食い違っている: JS={header.get('obsDim')} Py={self.obs_dim}")
        self.action_nvec = header["actionNvec"]
        self.last_obs = obs

    # ---- 入出力 ----
    def _send(self, msg: dict) -> None:
        self.proc.stdin.write((json.dumps(msg) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def _read_exact(self, n: int) -> bytes:
        buf = bytearray()
        while len(buf) < n:
            chunk = self.proc.stdout.read(n - len(buf))
            if not chunk:
                raise RuntimeError("Node のワーカーが応答しなくなった (stderr を確認)")
            buf += chunk
        return bytes(buf)

    def _recv(self) -> tuple[dict, np.ndarray]:
        (head_len,) = struct.unpack("<I", self._read_exact(4))
        header = json.loads(self._read_exact(head_len).decode("utf-8"))
        if "error" in header:
            raise RuntimeError(f"Node 側でエラー: {header['error']}")
        if "rewards" in header:                       # step の応答
            n_obs = self.n + len(header["resetIdx"])  # 通常の観測 + 終了時の観測
        else:                                         # init / reset の応答
            n_obs = len(header.get("idx", [])) or self.n
        blob = self._read_exact(n_obs * self.obs_dim * 4)
        return header, np.frombuffer(blob, dtype="<f4").reshape(n_obs, self.obs_dim)

    def _call(self, msg: dict) -> tuple[dict, np.ndarray]:
        self._send(msg)
        return self._recv()

    # ---- 環境操作 ----
    def step_async(self, actions: np.ndarray) -> None:
        self._send({"cmd": "step", "actions": np.asarray(actions).astype(int).tolist()})

    def step_wait(self) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[dict[str, Any]]]:
        header, obs = self._recv()
        rewards = np.asarray(header["rewards"], dtype=np.float32)
        terminated = np.asarray(header["terminated"], dtype=bool)
        truncated = np.asarray(header["truncated"], dtype=bool)
        # info は終了した環境ぶんだけ届く (毎ステップ全環境ぶん送ると遅い)
        infos: list[dict[str, Any]] = [{} for _ in range(self.n)]
        terminal = obs[self.n :]
        for k, i in enumerate(header["resetIdx"]):
            info = header["infos"][k]
            info["terminal_observation"] = terminal[k]
            info["TimeLimit.truncated"] = bool(truncated[i] and not terminated[i])
            info["episode"] = {
                "r": float(info["epReward"]),
                "l": int(info["steps"]),
                "cleared": int(info["levelsCleared"]),
            }
            infos[i] = info
        return obs[: self.n], rewards, terminated | truncated, infos

    def step(self, actions: np.ndarray):
        self.step_async(actions)
        return self.step_wait()

    def reset(self, seeds: Sequence[int] | None = None) -> np.ndarray:
        msg: dict = {"cmd": "reset"}
        if seeds is not None:
            msg["seeds"] = list(seeds)
        _, obs = self._call(msg)
        return obs

    def close(self) -> None:
        try:
            self._send({"cmd": "close"})
            self.proc.wait(timeout=3)
        except Exception:
            self.proc.kill()
