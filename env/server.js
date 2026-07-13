'use strict';
/* =========================================================================
 * バッチ環境サーバ — 1プロセスで M 個の HellgridEnv をホストする
 *
 * Node は単スレッドなので、1プロセスの上限は ~3.5k 行動/秒。コアを使い切るには
 * Python 側がこのサーバを複数プロセス立ち上げ、環境を分割して持たせる
 * (env/hellgrid_env.py の HellgridVecEnv がそれをやる)。
 *
 * プロトコル
 *   Python -> Node : JSON を1行ずつ (stdin)
 *     {"cmd":"init","n":8,"cfg":{...},"seeds":[...]}
 *     {"cmd":"step","actions":[[0,1,2,1,0,0,0], ...]}
 *     {"cmd":"reset","idx":[0,3],"seeds":[...]}
 *     {"cmd":"close"}
 *   Node -> Python : バイナリフレーム (stdout)
 *     [u32 headerLen][header JSON (utf8)][float32 の観測ブロブ]
 *
 * 観測は JSON にすると重いので float32 の生バイト列で返す。
 * step の応答では、終了した環境は即座に自動リセットして「次の観測」を返し、
 * 終了時の観測は resetIdx の順にブロブの後半へ付ける (SB3 の VecEnv 流儀)。
 * ========================================================================= */
const readline = require('readline');
const { createEnvContext, createEnvContext2 } = require('./sim-loader.cjs');

// コンテキストは init で作る。cfg.env2 が真なら探索版 (HellgridEnv2 / Box(5866))、
// 偽なら従来版 (HellgridEnv / Box(1477))。既定は従来版で、挙動は以前と同じ。
let EnvClass = null;
let OBS_DIM = 0;
let ACTION_NVEC = null;

let envs = [];
let seedCounter = 0;

// 送信バッファは使い回す。毎ステップ数百KB を新規確保すると GC に食われる。
let outF32 = new Float32Array(0);   // 通常の観測 n個 + 終了時の観測 最大n個
let outBuf = Buffer.alloc(0);       // outF32 と同じメモリを見る Buffer

function allocOut(n) {
  const floats = 2 * n * OBS_DIM;
  if (outF32.length >= floats) return;
  outF32 = new Float32Array(floats);
  outBuf = Buffer.from(outF32.buffer);
}

// [u32 headerLen][header JSON][float32 の観測 nObs 個] を1回で書き出す
function send(header, nObs) {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const frame = Buffer.allocUnsafe(4 + head.length);
  frame.writeUInt32LE(head.length, 0);
  head.copy(frame, 4);
  process.stdout.write(frame);
  if (nObs > 0) process.stdout.write(outBuf.subarray(0, nObs * OBS_DIM * 4));
}

const commands = {
  init(msg) {
    const cfg = Object.assign({}, msg.cfg || {});
    const useV2 = !!cfg.env2;
    delete cfg.env2;   // Env 側には渡さない (プロトコル層のフラグ)
    const ctx = useV2 ? createEnvContext2() : createEnvContext();
    EnvClass = useV2 ? ctx.HellgridEnv2 : ctx.HellgridEnv;
    OBS_DIM = useV2 ? ctx.OBS2_DIM : ctx.OBS_DIM;
    ACTION_NVEC = useV2 ? ctx.ACTION_NVEC2 : ctx.ACTION_NVEC;
    envs = [];
    seedCounter = (msg.baseSeed >>> 0) || 1;
    allocOut(msg.n);
    for (let i = 0; i < msg.n; i++) {
      const env = new EnvClass(cfg);
      envs.push(env);
      outF32.set(env.reset(msg.seeds ? msg.seeds[i] : seedCounter++), i * OBS_DIM);
    }
    send({ ok: true, obsDim: OBS_DIM, actionNvec: ACTION_NVEC, n: envs.length }, envs.length);
  },

  step(msg) {
    const n = envs.length;
    // info は「エピソードが終わった環境」のぶんだけ返す。全環境ぶんを毎ステップ
    // JSON にすると、それだけでスループットが3割落ちる。
    const rewards = [], terminated = [], truncated = [], resetIdx = [], infos = [];
    let term = 0;  // 終了時の観測は通常の観測の後ろに積む
    for (let i = 0; i < n; i++) {
      const r = envs[i].step(msg.actions[i]);
      rewards.push(r.reward);
      terminated.push(r.terminated ? 1 : 0);
      truncated.push(r.truncated ? 1 : 0);
      if (r.terminated || r.truncated) {
        outF32.set(r.obs, (n + term) * OBS_DIM);        // 終了時の観測を先に退避
        resetIdx.push(i);
        infos.push(r.info);
        term++;
        outF32.set(envs[i].reset(seedCounter++), i * OBS_DIM);  // 自動リセット
      } else {
        outF32.set(r.obs, i * OBS_DIM);
      }
    }
    send({ rewards, terminated, truncated, resetIdx, infos }, n + term);
  },

  reset(msg) {
    const idx = msg.idx || envs.map((_, i) => i);
    for (let j = 0; j < idx.length; j++) {
      outF32.set(envs[idx[j]].reset(msg.seeds ? msg.seeds[j] : seedCounter++), j * OBS_DIM);
    }
    send({ ok: true, idx }, idx.length);
  },

  close() {
    process.exit(0);
  },
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const fn = commands[msg.cmd];
  if (!fn) { send({ error: `unknown cmd: ${msg.cmd}` }, []); return; }
  try {
    fn(msg);
  } catch (e) {
    send({ error: String(e && e.stack || e) }, []);
  }
});
rl.on('close', () => process.exit(0));
