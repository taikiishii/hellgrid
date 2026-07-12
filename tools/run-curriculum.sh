#!/usr/bin/env bash
# カリキュラムを最初から通しで回す (B案: 観測に補給物資への勾配を追加した版)
#
#   bash tools/run-curriculum.sh
#
# 観測が 1231 -> 1477 次元に変わったので、旧モデルとは互換性がない。ゼロから学習する。
set -e
cd "$(dirname "$0")/.."
PY=.venv/Scripts/python.exe
ENVS=192
WORKERS=12

echo "===== 1/5 nav (敵なし・E1M1・出口に着くだけ) ====="
$PY env/train.py --stage nav --steps 3000000 --envs $ENVS --workers $WORKERS

echo "===== 2/5 nav-all (敵なし・全5ステージ・キーカード) ====="
$PY env/train.py --stage nav-all --steps 5000000 --envs $ENVS --workers $WORKERS \
  --init runs/nav/final.zip

echo "===== 3/5 arena (敵を全滅させないと終われない = 戦闘を強制) ====="
$PY env/train.py --stage arena --steps 8000000 --envs $ENVS --workers $WORKERS \
  --init runs/nav-all/final.zip

echo "===== 4/5 single (全部入り・1ステージ単位) ====="
$PY env/train.py --stage single --steps 12000000 --envs $ENVS --workers $WORKERS \
  --init runs/arena/final.zip

echo "===== 5/5 campaign-mix (通し・逆カリキュラム込み) ====="
$PY env/train.py --stage campaign-mix --steps 22000000 --envs $ENVS --workers $WORKERS \
  --init runs/single/final.zip

echo "===== 評価 ====="
echo "--- single (1ステージ単位) ---"
$PY env/eval.py --model runs/single/final.zip --stage single --episodes 100 --envs 16 --workers 8
echo "--- arena (戦闘) ---"
$PY env/eval.py --model runs/arena/final.zip --stage arena --episodes 60 --envs 12 --workers 6
echo "--- campaign (通し) 逆カリキュラム後 ---"
$PY env/eval.py --model runs/campaign-mix/final.zip --stage campaign --episodes 60 --envs 12 --workers 6
echo "--- HPアブレーション (慎重さを獲得したか) ---"
$PY tools/ablate-hp.py runs/campaign-mix/final.zip

echo "===== 完了 ====="
