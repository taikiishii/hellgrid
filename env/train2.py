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

try:
    from sb3_contrib import RecurrentPPO   # Lv2 (LSTM) 用。--algo rppo のときだけ必要
except ImportError:
    RecurrentPPO = None

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
    # ==== 戦闘カリキュラム (キルゲート) ====
    # 「規定数の敵を倒すまで出口が作動しない」ルールで、戦闘を道具的に必要にする。
    # 報酬レバー5連敗の結論: 環境が回避を最適解にしている限り戦闘は学ばれない。
    # v1 arena の失敗 (いきなり13体全滅 = 解けない) を避け、敵1〜3体の迷路から始める
    "hunt1": {
        "env2": True, "mazeSize": 13, "mazeBraid": 0.15, "mazeRooms": 2,
        "mazeEnemies": [1, 3], "killGate": [1.0, 1.0],   # 全滅ゲート (でも敵は1〜3体)
        "maxSteps": 800,
    },
    "hunt2": {
        "env2": True, "mazeSize": 17, "mazeBraid": 0.15, "mazeRooms": 3,
        "mazeEnemies": [2, 6], "killGate": [0.5, 1.0],
        "maxSteps": 1000,
    },
    # 戦闘スキル強化: 火球持ち (焔鬼) を増やした迷路で、被弾ペナルティを2倍にする。
    # 立ち止まって撃ち合うと損なので、避けながら (ストレイフ) 撃つ・弾を節約する・
    # 弾薬に寄る、が創発することを狙う。弾薬誘導 (ammoSeek) も効く段階
    "hunt-skill": {
        "env2": True, "mazeSize": 15, "mazeBraid": 0.15, "mazeRooms": 3,
        "mazeEnemies": [3, 7], "mazeFireballRatio": 0.6, "killGate": [0.5, 1.0],
        "hpDamageScale": 2.0,
        "maxSteps": 1200,
    },
    # 汎化 第1段: 手続き生成のフル機能ステージ (鍵・施錠ドア・アイテム) で走り抜けを学ぶ。
    # 固定5面への過学習を避け、サイズ/鍵ロック段数/アイテム密度/敵数をエピソードごとに
    # 広く抽選する (ドメインランダム化)。生成器が可解性を保証。走り抜けチャンピオン cs2 から
    # warm-start し、「未知レイアウトで鍵を取り出口へ」を汎化させる。敵は軽め (ナビ主眼)。
    "gen-nav1": {
        "env2": True,
        "mazeSize": [11, 21], "mazeBraid": 0.12, "mazeRooms": 3,
        "mazeEnemies": [0, 4], "mazeFireballRatio": 0.2,
        "mazeKeyDepth": [0, 2],
        "mazeItems": {"heal": [0, 3], "ammo": [1, 3], "armor": [0, 2]},
        "maxSteps": 2000,
    },
    # 汎化 第2段: gen-nav1 は未知生成ステージで3倍改善したが、生成分布が狭く(小さい・
    # 特徴少ない)実5面を壊滅的に忘却した(4.7%)。対策2本を入れる:
    #  (a) サイズを [11,27] に広げ実面サイズを包含、(b) 実5面を 35% 混ぜて忘却を防ぐ
    #     (横断教訓7)。生成・実の両方に強い1モデルを狙う。cs2 (実面92%) から warm-start。
    "gen-nav2": {
        "env2": True,
        "levels": [0, 1, 2, 3, 4], "mazeMix": 0.65,   # 65%生成 / 35%実5面 (忘却防止)
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.4, 1.0],
        "mazeSize": [11, 27], "mazeBraid": 0.12, "mazeRooms": 3,
        "mazeEnemies": [0, 4], "mazeFireballRatio": 0.2,
        "mazeKeyDepth": [0, 2],
        "mazeItems": {"heal": [0, 3], "ammo": [1, 3], "armor": [0, 2]},
        "maxSteps": 2500,
    },
    # 汎化 第3段 (Phase 2b): 実面級に豊かにした生成器 (通常ドア・水路・上位敵M/K/F・壁多様・
    # テーマ配色) で学習。生成が実面特徴を包含するので、混ぜ量に頼らず生成・実の両方が
    # 伸びるはず。gen-nav2 (バランス型) から warm-start。実5面は 30% 混ぜて anchor。
    "gen-nav3": {
        "env2": True,
        "levels": [0, 1, 2, 3, 4], "mazeMix": 0.7,   # 70%生成 / 30%実
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.4, 1.0],
        "mazeSize": [11, 27], "mazeBraid": 0.12, "mazeRooms": 3,
        "mazeEnemies": [0, 5], "mazeFireballRatio": 0.25, "mazeEnemyElite": 0.25,
        "mazeKeyDepth": [0, 2],
        "mazeItems": {"heal": [0, 3], "ammo": [1, 4], "armor": [0, 2]},
        "mazeDoors": [0, 3], "mazeWater": [0, 4], "mazeWallMix": 0.4, "mazeTheme": True,
        "maxSteps": 2500,
    },
    # 汎化 Phase 3: 戦闘の汎化。「銃で戦うハンター」を未知ステージでも通用させる。
    # 方向が重要: gen-nav3 (汎化はあるが銃を使わない) に gun-gate を足すのは camp-hunt7 で
    # 実証済みの「探索の壁」で詰む。逆に **銃で戦える camp-hunt9 から** 生成ステージへ
    # 広げる。gun-kill-gate + gunKillBonus で銃使用を維持しつつ、豊かな生成70%＋実5面30%で
    # 汎化させる。弾は多めに撒く (銃戦闘は弾を食う)。ゲートは軽め (camp-hunt9 の知見)。
    "gen-hunt1": {
        "env2": True,
        "levels": [0, 1, 2, 3, 4], "mazeMix": 0.7,   # 70%生成 / 30%実 (忘却防止)
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.4, 1.0],
        "mazeSize": [11, 25], "mazeBraid": 0.12, "mazeRooms": 3,
        "mazeEnemies": [2, 6], "mazeFireballRatio": 0.25, "mazeEnemyElite": 0.25,
        "mazeKeyDepth": [0, 2],
        "mazeItems": {"heal": [1, 4], "ammo": [2, 5], "armor": [0, 2]},
        "mazeDoors": [0, 3], "mazeWater": [0, 3], "mazeWallMix": 0.4, "mazeTheme": True,
        "gunKillGate": True, "killGate": [0.15, 0.3],
        "killGateByLevel": {2: [0, 0], 3: [0, 0]},   # 実面 E1M3/M4 (要キー) は免除
        "gunKillBonus": 0.3,
        "hpDamageScale": 1.5,
        "maxSteps": 2500,
    },
    # 汎化 Phase 3 第2段: gen-hunt1 は複合課題(未知探索+鍵+水路+上位敵+gun-gate)を一度に
    # 積んで失敗した (銃使用12→3%に崩壊・クリア24→16%)。killGate 系譜と同じく **易→難に分解**し、
    # まず「未知レイアウトで銃で戦う」だけを取り戻す:
    #  - 鍵なし・水路なし・上位敵ほぼなし・小さめサイズ (探索と副課題の負荷を落とす)
    #  - gunKillBonus 0.3→0.8 に強化 (ナイフ習慣は頑健。難度が上がると必ず退避するため守る)
    #  - 弾は多め。見た目の多様性(壁/配色)は無害なので残す
    # ここで銃使用が戻れば、次段で鍵・水路・上位敵・サイズを戻して難度を上げる。
    "gen-hunt2": {
        "env2": True,
        "levels": [0, 1, 2, 3, 4], "mazeMix": 0.75,   # 75%生成 / 25%実
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.4, 1.0],
        "mazeSize": [11, 19], "mazeBraid": 0.12, "mazeRooms": 3,
        "mazeEnemies": [2, 5], "mazeFireballRatio": 0.2, "mazeEnemyElite": 0.1,
        "mazeKeyDepth": 0,            # 鍵なし (複合課題を外す)
        "mazeItems": {"heal": [1, 4], "ammo": [3, 6], "armor": [0, 2]},
        "mazeDoors": [0, 2],          # 水路はなし
        "mazeWallMix": 0.4, "mazeTheme": True,
        "gunKillGate": True, "killGate": [0.2, 0.35],
        "killGateByLevel": {2: [0, 0], 3: [0, 0]},
        "gunKillBonus": 0.8,          # 銃使用を守る (0.3 では崩壊した)
        "hpDamageScale": 1.5,
        "maxSteps": 2000,
    },
    # 銃使用カリキュラム 第1段: 「銃キルで出口が開く」を易しい単発で学ばせる。
    # camp-hunt7 (gun-kill-gate を通しにいきなり) は、ナイフ専門家 warm-start では
    # 銃を使う前にナイフで倒し gunKills=0 で詰んだ。キルゲートで戦闘を得た時と同じく
    # 単発・低ゲートから立ち上げる。敵2〜4・銃キル1〜2体でゲート開放 (残りはナイフ可)。
    # gunKillBonus=1.0 で銃キルを即時に強く報い、habit を上書きする即時信号を作る。
    # 火球は低め (避けでなく銃使用の学習に集中)。ナイフ威力は素のまま (完走を削らない)
    "hunt-gun1": {
        "env2": True, "mazeSize": 13, "mazeBraid": 0.15, "mazeRooms": 2,
        "mazeEnemies": [2, 4], "mazeFireballRatio": 0.2,
        "gunKillGate": True, "killGate": [0.34, 0.5],
        "gunKillBonus": 1.0,
        "maxSteps": 1200,
    },
    # 銃使用カリキュラム 第2段 (ブートストラップ): hunt-gun1 はナイフ・フォールバックで
    # プラトー (クリア21%)。銃を使う前にナイフで倒す既定行動が抜けない。そこでナイフを
    # 一時的にほぼ無力化 (0.1) して**銃で倒すしかない**状況を作り、銃競技力を強制的に
    # 立ち上げる。これは恒久的ナイフ弱体化 (失敗) と別物 = 銃スキルを仕込む一時的道具で、
    # この後 hunt-gun2 で素のナイフ + gun-kill-gate に戻して定着させる。
    "hunt-gun-boot": {
        "env2": True, "mazeSize": 13, "mazeBraid": 0.15, "mazeRooms": 2,
        "mazeEnemies": [2, 5], "mazeFireballRatio": 0.2,
        "killGate": [0.5, 1.0],       # 敵の大半を倒すまで出口が開かない
        "knifeDamageScale": 0.1,      # ナイフをほぼ無力化 -> 銃で倒すしかない
        "gunKillBonus": 1.0,
        "maxSteps": 1200,
    },
    # 銃使用カリキュラム 第3段: ナイフを素(1.0)に戻し gun-kill-gate で定着させる。
    # ブートで得た銃競技力を保ったまま「ゲートは銃キルで開ける・ナイフは自衛」を学ぶ。
    # 敵をやや増やしゲートも上げて、通し前の総仕上げにする
    "hunt-gun2": {
        "env2": True, "mazeSize": 15, "mazeBraid": 0.15, "mazeRooms": 3,
        "mazeEnemies": [3, 6], "mazeFireballRatio": 0.3,
        "gunKillGate": True, "killGate": [0.4, 0.6],
        "gunKillBonus": 0.6,          # ゲートで銃を要求しつつ報酬は控えめに戻す
        "maxSteps": 1500,
    },
    # 銃使用カリキュラム 第4段: 実ステージ単発で gun-gate を橋渡し (通しの前段)。
    # killGate 系譜の e1m-hunt に相当。hunt-gun2 は単発迷路の方策なので、通しへ跳ぶ前に
    # 実5面 (キー・ドア・実レイアウト) を単発で取り戻す。銃使用は gun-gate で保つ。
    # E1M3/M4 (要キー三重課題) はゲート免除。迷路も25%混ぜて忘却を防ぐ
    "e1m-gun": {
        "env2": True, "levels": [0, 1, 2, 3, 4], "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0],
        "gunKillGate": True, "killGate": [0.25, 0.5],
        "killGateByLevel": {2: [0, 0], 3: [0, 0]},
        "gunKillBonus": 0.4,
        "mazeMix": 0.25, "mazeSize": 17, "mazeBraid": 0.15, "mazeRooms": 3,
        "mazeEnemies": [2, 6],
        "maxSteps": 2000,
    },
    # 実ステージ版: ゲート割合と敵密度を混合し、迷路 (敵つき) も混ぜ続ける
    "e1m-hunt": {
        "env2": True, "levels": [0, 1, 2, 3, 4], "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0], "killGate": [0.25, 0.75],
        "mazeMix": 0.25, "mazeSize": 17, "mazeBraid": 0.15, "mazeRooms": 3,
        "mazeEnemies": [2, 6],
        "maxSteps": 2000,
    },
    # 戦闘カリキュラムの最終段階: 通し (ゲート付き)。逆カリキュラム + ゲート25〜75%。
    # 「戦って通し完走」が戦闘路線のゴール。e1m-hunt の重みから継続する
    "e1m-camp-hunt": {
        "env2": True, "mode": "campaign", "levels": [0, 0, 0, 1, 2, 3],
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0], "killGate": [0.25, 0.75],
        "startHp": [30, 100], "startArmor": [0, 60],
        "startBullets": [10, 70], "startShells": [0, 20], "shotgunChance": 0.6,
        "maxSteps": 12000,
    },
    # v2: 「戦える所では戦い、キー課題のステージは通過に集中」。E1M3/M4 (要キー) は
    # ゲートを外し、戦闘ステージ (M1/M2/M5) だけゲートを乗せる現実的な通し。
    # ユーザー判断 (2026-07-21): 全ステージ戦闘は E1M3/M4 の三重課題で詰むため緩和
    "e1m-camp-hunt2": {
        "env2": True, "mode": "campaign", "levels": [0, 0, 0, 1, 2, 3],
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0],
        "killGate": [0.25, 0.5],   # E1M1(0)/M2(1)/M5(4) はこの割合でゲート
        "killGateByLevel": {2: [0, 0], 3: [0, 0]},  # E1M3/M4 (要キー) はゲートなし
        "startHp": [30, 100], "startArmor": [0, 60],
        "startBullets": [10, 70], "startShells": [0, 20], "shotgunChance": 0.6,
        "maxSteps": 12000,
    },
    # v3: 戦闘スキル強化を通しに組み込む。camp-hunt2 は完走0%・死亡100% (戦闘の
    # 消耗が5ステージ持ち越しで複利に削る) だった。単発で効いた被弾低減 (hpDamageScale
    # =1.5) + 弾薬誘導 (自動) + ゲート軽減 (0.25-0.4) で消耗を抑えて完走を狙う。
    # 火球持ちを避ける動機を与えつつ、5ステージ通すのでゲートは control 気味に
    "e1m-camp-hunt3": {
        "env2": True, "mode": "campaign", "levels": [0, 0, 0, 1, 2, 3],
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0],
        "killGate": [0.25, 0.4],
        "killGateByLevel": {2: [0, 0], 3: [0, 0]},
        "hpDamageScale": 1.5,   # 被弾を嫌って避ける (単発では 2.0 が効いた)
        "startHp": [30, 100], "startArmor": [0, 60],
        "startBullets": [10, 70], "startShells": [0, 20], "shotgunChance": 0.6,
        "maxSteps": 12000,
    },
    # v4: 全戦闘通しの最終壁 = E1M4→E1M5 の遷移 (camp-hunt2/3 とも「4ステージ止まり0」)。
    # 原因は逆カリキュラムの開始分布に E1M5 (消耗状態) が無く未訓練だったこと。
    # 開始ステージに E1M4 を厚く + E1M5 を追加して、消耗した M4/M5 を直接練習する。
    # E1M1 も忘却防止に高確率で残す (v1 教訓4)
    "e1m-camp-hunt4": {
        "env2": True, "mode": "campaign", "levels": [0, 0, 1, 2, 3, 3, 4],
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0],
        "killGate": [0.25, 0.4],
        "killGateByLevel": {2: [0, 0], 3: [0, 0]},
        "hpDamageScale": 1.5,
        "startHp": [40, 100], "startArmor": [0, 60],
        "startBullets": [20, 70], "startShells": [0, 25], "shotgunChance": 0.6,
        "maxSteps": 12000,
    },
    # v5: v4 (完走13%) の2つの診断への対策。
    #  ① 消耗が支配的 (E1M4到達HP: 42=通過 vs 28=死亡、削れどころは E1M2/M3) →
    #     healSeekBelow を 60→80 に上げ、早めに回復へ寄せて E1M2/M3 の消耗を防ぐ。
    #     開始HPも実到達分布 [25,55] に寄せ、消耗した E1M4 を直接練習する。
    #  ② ナイフ偏重 (ピストル0%/ショットガン7%/ナイフ55%) → env2.js 側で至近2倍から
    #     ナイフを除外 + 遠距離キルに加点 (rangedKillBonus)。銃使用を誘導し、接触戦
    #     による焔鬼被弾 (消耗源) を減らす。E1M4 スタートを 3/8 に厚くする
    "e1m-camp-hunt5": {
        "env2": True, "mode": "campaign", "levels": [0, 0, 1, 2, 3, 3, 3, 4],
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0],
        "killGate": [0.25, 0.4],
        "killGateByLevel": {2: [0, 0], 3: [0, 0]},
        "hpDamageScale": 1.5,
        "healSeekBelow": 80,   # 消耗が支配的 -> 早めに回復へ寄せる (既定60)
        "startHp": [25, 55], "startArmor": [0, 60],
        "startBullets": [20, 70], "startShells": [0, 25], "shotgunChance": 0.6,
        "maxSteps": 12000,
    },
    # v6: v5 の負の結果への対応。報酬による銃促進はナイフ88〜94%のまま失敗した
    # (キルゲートで戦闘を得た時と同じ = 頑健な行動の谷は報酬でなく環境ルールで動かす)。
    # そこで **ナイフのダメージを0.35倍に弱める環境ルール** で、方策自身のキル最大化欲が
    # 銃を選ぶよう仕向ける。設定は camp-hunt4 (決定的59.5%の最良ベース) をそのまま使い、
    # knifeDamageScale だけを足した単一変数実験。camp-hunt4/final から warm-start
    "e1m-camp-hunt6": {
        "env2": True, "mode": "campaign", "levels": [0, 0, 1, 2, 3, 3, 4],
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0],
        "killGate": [0.25, 0.4],
        "killGateByLevel": {2: [0, 0], 3: [0, 0]},
        "hpDamageScale": 1.5,
        "knifeDamageScale": 0.35,   # ナイフを弱め銃使用を強制する環境ルール
        "startHp": [40, 100], "startArmor": [0, 60],
        "startBullets": [20, 70], "startShells": [0, 25], "shotgunChance": 0.6,
        "maxSteps": 12000,
    },
    # v6b: v6 (0.35) は銃使用を動かした (ピストル0→24%) が完走が半減 (55→31%) した。
    # 0.35 は強すぎ = 戦闘力を削りすぎて killGate 進行が詰まった。トレードオフ曲線の
    # 中間点を測るため、弱体化を緩めた 0.55 の単一変数実験。銃使用と完走の折り合いを探す
    "e1m-camp-hunt6b": {
        "env2": True, "mode": "campaign", "levels": [0, 0, 1, 2, 3, 3, 4],
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0],
        "killGate": [0.25, 0.4],
        "killGateByLevel": {2: [0, 0], 3: [0, 0]},
        "hpDamageScale": 1.5,
        "knifeDamageScale": 0.55,   # 0.35 は強すぎたので緩める
        "startHp": [40, 100], "startArmor": [0, 60],
        "startBullets": [20, 70], "startShells": [0, 25], "shotgunChance": 0.6,
        "maxSteps": 12000,
    },
    # v7: ナイフ弱体化軸は甘い点なしと判明 (0.55=両損, 0.35=完走半減)。ナイフ弱体化は
    # 「戦闘力の一律弱化」で killGate 進行と衝突するのが原因。そこで **戦闘力を削らずに
    # 銃を要求する gun-kill-gate**: killGate を銃(hitscan)キルのみで計上する。ナイフは
    # 自衛に使えるが、出口を開けるには規定数の銃キルが要る。ナイフ威力は素のまま(1.0)。
    # camp-hunt4 の設定に gunKillGate=True だけ足した単一変数実験。camp-hunt4 warm-start
    "e1m-camp-hunt7": {
        "env2": True, "mode": "campaign", "levels": [0, 0, 1, 2, 3, 3, 4],
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0],
        "killGate": [0.25, 0.4],
        "killGateByLevel": {2: [0, 0], 3: [0, 0]},
        "gunKillGate": True,        # 出口を開けるゲートは銃キルのみで進行 (ナイフは自衛用)
        "hpDamageScale": 1.5,
        "startHp": [40, 100], "startArmor": [0, 60],
        "startBullets": [20, 70], "startShells": [0, 25], "shotgunChance": 0.6,
        "maxSteps": 12000,
    },
    # 銃使用カリキュラム 最終段: 通しに gun-kill-gate 統合 (両立の最終検証)。
    # camp-hunt7 は camp-hunt4 からいきなり gun-gate で完走0%(探索の壁)だった。今回は
    # 銃使用カリキュラム (hunt-gun1→boot→gun2→e1m-gun) を積んだ e1m-gun から入る。
    # 設定は camp-hunt4 と同じ + gunKillGate=True + gunKillBonus 0.3 (控えめな即時信号)。
    # 評価は camp-hunt4 と同じ E1M1固定/HP100 で完走率と銃使用を測る
    "e1m-camp-hunt8": {
        "env2": True, "mode": "campaign", "levels": [0, 0, 1, 2, 3, 3, 4],
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0],
        "killGate": [0.25, 0.4],
        "killGateByLevel": {2: [0, 0], 3: [0, 0]},
        "gunKillGate": True,        # ゲートは銃キルで開ける (ナイフは自衛)
        "gunKillBonus": 0.3,        # 控えめな銃キル即時報酬 (habit 逆戻り防止)
        "hpDamageScale": 1.5,
        "startHp": [40, 100], "startArmor": [0, 60],
        "startBullets": [20, 70], "startShells": [0, 25], "shotgunChance": 0.6,
        "maxSteps": 12000,
    },
    # camp-hunt9: camp-hunt8-80M (銃48%達成・完走17〜25%) の完走を回収する。
    # gun-kill-gate の銃キル必須が弾消耗を招き E1M2 等で詰まるのが完走の頭打ち要因。
    # ゲートの必要銃キル数を減らし(0.25→0.15)、弾供給を増やして消耗を緩める。
    # 銃使用は gun-gate で維持しつつ完走を camp-hunt4 に近づける狙い。80M からwarm-start
    "e1m-camp-hunt9": {
        "env2": True, "mode": "campaign", "levels": [0, 0, 1, 2, 3, 3, 4],
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0],
        "killGate": [0.15, 0.25],   # 必要銃キル数を軽く (弾消耗を緩める)
        "killGateByLevel": {2: [0, 0], 3: [0, 0]},
        "gunKillGate": True,
        "gunKillBonus": 0.3,
        "hpDamageScale": 1.5,
        "startHp": [40, 100], "startArmor": [0, 60],
        "startBullets": [40, 100], "startShells": [15, 40], "shotgunChance": 0.7,  # 弾増
        "maxSteps": 12000,
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
    # 通しの残る壁 = 消耗状態の E1M4 (条件付き通過率 41〜52% で飽和)。
    # E1M4 スタートを2倍にして練習量を寄せる (単発で 24→49% を生んだ手法の通し版)。
    # E1M1 スタートは 3/7 残す (忘却対策の下限 — v1 教訓4)
    "e1m-camp-mix2": {
        "env2": True, "mode": "campaign", "levels": [0, 0, 0, 1, 2, 3, 3],
        "noEnemies": False, "noItems": False,
        "enemyFraction": [0.5, 1.0],
        "startHp": [30, 100], "startArmor": [0, 60],
        "startBullets": [10, 70], "startShells": [0, 20], "shotgunChance": 0.6,
        "maxSteps": 12000,
    },
}

# 割引率: 実効視野はおよそ 1/(1-gamma)。通しは「4ステージ先まで生き延びる価値」が
# 見える長さが必要 (v1 教訓1: gamma=0.99 の campaign は目先だけ見て崩壊した)
GAMMA = {"e1m-camp-mix": 0.999, "e1m-camp-mix2": 0.999, "e1m-camp-hunt": 0.999,
         "e1m-camp-hunt2": 0.999, "e1m-camp-hunt3": 0.999, "e1m-camp-hunt4": 0.999,
         "e1m-camp-hunt5": 0.999, "e1m-camp-hunt6": 0.999, "e1m-camp-hunt6b": 0.999,
         "e1m-camp-hunt7": 0.999, "e1m-camp-hunt8": 0.999, "e1m-camp-hunt9": 0.999}
# 長いエピソードは GAE を安定させるため n_steps も伸ばす
N_STEPS = {"e1m-camp-mix": 256, "e1m-camp-mix2": 256, "e1m-camp-hunt": 256,
           "e1m-camp-hunt2": 256, "e1m-camp-hunt3": 256, "e1m-camp-hunt4": 256,
           "e1m-camp-hunt5": 256, "e1m-camp-hunt6": 256, "e1m-camp-hunt6b": 256,
           "e1m-camp-hunt7": 256, "e1m-camp-hunt8": 256, "e1m-camp-hunt9": 256}


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
    # Lv2 化: RecurrentPPO (LSTM)。MLP とはアーキテクチャが違うため --init の互換はない
    # (rppo の系譜は rppo 同士でのみ引き継げる)。出力先も runs2/<stage>-rppo に分ける
    ap.add_argument("--algo", choices=["ppo", "rppo"], default="ppo")
    args = ap.parse_args()

    out = ROOT / "runs2" / (args.stage + ("-rppo" if args.algo == "rppo" else ""))
    out.mkdir(parents=True, exist_ok=True)

    venv = HellgridVecEnv(
        num_envs=args.envs, n_workers=args.workers, cfg=STAGES[args.stage], base_seed=args.seed
    )
    # 既定 gamma=0.995 (視野 ~200 步)。通しはステージ別に上書き (GAMMA 参照)
    gamma = GAMMA.get(args.stage, 0.995)
    n_steps = N_STEPS.get(args.stage, args.n_steps)

    venv = VecMonitor(venv)
    venv = VecNormalize(venv, norm_obs=False, norm_reward=True, gamma=gamma)

    if args.algo == "rppo":
        # LSTM は勾配更新が重いので、MLP部を絞ってバッファも軽くする
        policy_kwargs = dict(
            lstm_hidden_size=256,
            net_arch=dict(pi=[256], vf=[256]),
        )
    else:
        # 学習器が律速 (実測: 学習ループの83%)。512x512 から半減して2倍速にする。
        # 観測 5866 -> 256 の初段だけで 1.5M パラメータあるので表現力は足りる
        policy_kwargs = dict(net_arch=dict(pi=[256, 256], vf=[256, 256]))

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
        policy_kwargs=policy_kwargs,
        tensorboard_log=str(ROOT / "runs2"),
        verbose=1,
        seed=args.seed,
    )

    Algo = RecurrentPPO if args.algo == "rppo" else PPO
    policy_name = "MlpLstmPolicy" if args.algo == "rppo" else "MlpPolicy"
    print(f"stage={args.stage}  algo={args.algo}  gamma={gamma}  n_steps={n_steps}  envs={args.envs}")
    if args.init:
        model = Algo.load(args.init, env=venv, **{k: v for k, v in kwargs.items() if k != "policy_kwargs"})
        print(f"前段の重みを読み込んだ: {args.init}")
    else:
        model = Algo(policy_name, venv, **kwargs)

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
