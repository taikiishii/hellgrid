#!/usr/bin/env bash
# カリキュラム再走 (arena を外した版)
#
# 1回目は nav-all のあとに arena (敵を全滅させないと終われない) を挟んだが、
# 8Mステップ回して一度もクリアできなかった (キル率25%止まり)。解けないタスクを
# 延々と練習させた結果、方策が「突っ込んで撃ちまくる」方向へ歪み、ナビゲーション
# 性能が壊れた (single の E1M4 が 0/11)。カリキュラムの原則 —— 前段より少しだけ
# 難しく —— を自分で破っていた。
#
# ここでは arena を外し、良質なナビゲーション (nav-all) から直接 single を長く回す。
# 「観測に補給物資への勾配を足したこと」単体の効果が、これで測れる。
set -e
cd "$(dirname "$0")/.."
PY=.venv/Scripts/python.exe
ENVS=192
WORKERS=12

echo "===== 1/2 single (全部入り・1ステージ単位) ====="
$PY env/train.py --stage single --steps 20000000 --envs $ENVS --workers $WORKERS \
  --init runs/nav-all/final.zip

echo "===== 2/2 campaign-mix (通し + 逆カリキュラム) ====="
$PY env/train.py --stage campaign-mix --steps 25000000 --envs $ENVS --workers $WORKERS \
  --init runs/single/final.zip

echo "===== 評価 ====="
echo "--- single (1ステージ単位) ---"
$PY env/eval.py --model runs/single/final.zip --stage single --episodes 100 --envs 16 --workers 8
echo "--- campaign (通し) ---"
$PY env/eval.py --model runs/campaign-mix/final.zip --stage campaign --episodes 60 --envs 12 --workers 6
echo "--- HPアブレーション ---"
$PY tools/ablate-hp.py runs/campaign-mix/final.zip

echo "===== 完了 ====="
