'use strict';
/* =========================================================================
 * AIの「見え方」を可視化する (V キー)
 *
 * エージェントが実際に受け取っている観測ベクトル (1231次元) を、そのまま画面に
 * 描く。作り話ではなく、ai.obs の中身をデコードして表示しているだけ。
 *
 *   上部のセンサーバー … レイ24本。壁までの距離と、そこに見えている敵/アイテム
 *   右のグリッド      … 自己中心11x11。壁・ドア・水・敵・アイテムと、
 *                        出口までのBFS距離の勾配 (緑=出口に近づく向き)
 *   下部の行動ストリップ … いまAIが「押している」入力
 *
 * これを見ると、AIが敵を無視して緑の方向へ一直線に走っているのが一目でわかる。
 * ========================================================================= */

const VIS_CELL = 12;                      // グリッド1マスの大きさ(px)
const VIS_GRID_PX = GRID * VIS_CELL;      // 11 * 12 = 132
const VIS_PANEL = VIS_GRID_PX + 12;
const VIS_GX = W - VIS_PANEL - 8;         // グリッドパネルの左上
const VIS_GY = 56;

const VIS_BAR_W = N_RAYS * 10;            // センサーバー (24本 x 10px)
const VIS_BAR_X = (W - VIS_BAR_W) / 2;
const VIS_BAR_Y = 8;
const VIS_BAR_H = 38;

// 観測ベクトルから値を引くヘルパ (env/obs.js のレイアウトそのまま)
const rayCh = (o, i, c) => o[RAYS_OFF + i * RAY_CH + c];
const gridCh = (o, plane, gx, gy) => o[GRID_OFF + plane * GRID * GRID + gy * GRID + gx];
const scalar = (o, i) => o[SCALARS_OFF + i];

// BFS勾配 (-1..1) → 色。緑=出口に近づく / 赤=遠ざかる / 灰=変わらない
function gradColor(g) {
  if (g > 0) return `rgb(${(40 - 20 * g) | 0},${(70 + 150 * g) | 0},${(60 + 30 * g) | 0})`;
  return `rgb(${(70 + 90 * -g) | 0},${(60 - 25 * -g) | 0},${(60 - 25 * -g) | 0})`;
}

function visPanel(x, y, w, h, label) {
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(64,224,128,0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  if (label) {
    ctx.font = 'bold 9px monospace';
    ctx.fillStyle = 'rgba(64,224,128,0.9)';
    ctx.fillText(label, x + 5, y + 11);
  }
}

// ---- レイ24本のセンサーバー ----
// 棒の高さ = 壁までの近さ。上に載る点 = そのレイに見えている敵(赤)/アイテム(緑)
function renderRayBar(o) {
  visPanel(VIS_BAR_X - 4, VIS_BAR_Y - 4, VIS_BAR_W + 8, VIS_BAR_H + 8, null);
  for (let i = 0; i < N_RAYS; i++) {
    const x = VIS_BAR_X + i * 10;
    const wallD = rayCh(o, i, 0);                  // 0(近い) .. 1(遠い)
    const hgt = Math.max(1, (1 - wallD) * VIS_BAR_H);
    const isDoor = rayCh(o, i, 1) > 0.5;
    const isLocked = rayCh(o, i, 2) > 0.5;
    const isExit = rayCh(o, i, 3) > 0.5;
    ctx.fillStyle = isExit ? '#30e030' : isLocked ? '#d04040' : isDoor ? '#c8a030' : `rgba(150,150,165,${0.35 + 0.5 * (1 - wallD)})`;
    ctx.fillRect(x, VIS_BAR_Y + VIS_BAR_H - hgt, 8, hgt);

    const enemyD = rayCh(o, i, 4);
    if (enemyD < 0.999) {
      ctx.fillStyle = '#ff4040';
      ctx.fillRect(x, VIS_BAR_Y + enemyD * VIS_BAR_H, 8, 3);
    }
    const itemD = rayCh(o, i, 11);
    if (itemD < 0.999) {
      ctx.fillStyle = rayCh(o, i, 13) > 0.5 ? '#4080ff' : '#40d060';  // キーカードは青
      ctx.fillRect(x + 2, VIS_BAR_Y + itemD * VIS_BAR_H, 4, 3);
    }
  }
  ctx.font = 'bold 9px monospace';
  ctx.fillStyle = 'rgba(64,224,128,0.85)';
  ctx.fillText('RAYS (24)', VIS_BAR_X - 1, VIS_BAR_Y + VIS_BAR_H + 1);
}

// ---- 自己中心グリッド 11x11 ----
function renderGrid(o) {
  visPanel(VIS_GX, VIS_GY - 16, VIS_PANEL, VIS_GRID_PX + 36, 'GRID 11x11 + 出口へのBFS勾配');
  const ox = VIS_GX + 6, oy = VIS_GY + 6;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const x = ox + gx * VIS_CELL, y = oy + gy * VIS_CELL;
      const wall = gridCh(o, 0, gx, gy);
      const door = gridCh(o, 1, gx, gy);
      const water = gridCh(o, 2, gx, gy);
      const grad = gridCh(o, 6, gx, gy);

      if (wall > 0.5) ctx.fillStyle = '#33333c';
      else if (door > 0) ctx.fillStyle = door < 0.75 ? '#a03030' : '#b09030'; // 0.5 = 施錠中
      else if (water > 0.5) ctx.fillStyle = '#2e6aa0';
      else ctx.fillStyle = gradColor(grad);
      ctx.fillRect(x, y, VIS_CELL - 1, VIS_CELL - 1);

      if (gridCh(o, 4, gx, gy) > 0.5) {          // 敵
        ctx.fillStyle = '#ff4040';
        ctx.fillRect(x + 3, y + 3, VIS_CELL - 7, VIS_CELL - 7);
      }
      const item = gridCh(o, 5, gx, gy);
      if (item > 0) {                             // アイテム(1.0) / 樽(0.5)
        ctx.fillStyle = item > 0.75 ? '#40d060' : '#c06020';
        ctx.beginPath();
        ctx.arc(x + VIS_CELL / 2 - 0.5, y + VIS_CELL / 2 - 0.5, 2.5, 0, 7);
        ctx.fill();
      }
    }
  }
  // 中心 = プレイヤー。グリッドは進行方向が上を向くよう回転済みなので、常に上向き
  const cx = ox + 5 * VIS_CELL + VIS_CELL / 2 - 0.5;
  const cy = oy + 5 * VIS_CELL + VIS_CELL / 2 - 0.5;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx - 4, cy + 4);
  ctx.lineTo(cx + 4, cy + 4);
  ctx.closePath();
  ctx.fill();

  const d = scalar(o, 14) * 40;
  ctx.font = 'bold 9px monospace';
  ctx.fillStyle = 'rgba(220,220,225,0.75)';
  ctx.fillText(scalar(o, 16) > 0.5 ? `目標: キーカード (${d | 0}歩)` : `目標: 出口 (${d | 0}歩)`,
    VIS_GX + 6, VIS_GY + VIS_GRID_PX + 14);
}

// ---- 補給物資への勾配 (grid ch7=回復 / ch8=弾薬) ----
// 出口への勾配 (ch6) しか持たせていなかったせいで、エージェントは視界外の回復を
// 探せず、通しで必ずジリ貧になった。その反省で足したチャネル。
const VIS_S_CELL = 7;
const VIS_S_PX = GRID * VIS_S_CELL;                       // 77
const VIS_SY = VIS_GY + VIS_GRID_PX + 32;                 // グリッドパネルの下
function renderSupply(o) {
  const w = VIS_S_PX * 2 + 22;
  visPanel(VIS_GX, VIS_SY - 14, VIS_PANEL, VIS_S_PX + 30, null);
  const labels = ['回復への勾配', '弾薬への勾配'];
  for (let k = 0; k < 2; k++) {
    const plane = 7 + k;
    const ox = VIS_GX + 6 + k * (VIS_S_PX + 10);
    ctx.font = 'bold 8px monospace';
    ctx.fillStyle = 'rgba(64,224,128,0.85)';
    ctx.fillText(labels[k], ox, VIS_SY - 3);
    // 全面 -1 = 「探す先がない」(満タン、または到達できない)
    let exists = false;
    for (let gy = 0; gy < GRID && !exists; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        if (gridCh(o, plane, gx, gy) > -0.999) { exists = true; break; }
      }
    }
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        const g = gridCh(o, plane, gx, gy);
        ctx.fillStyle = exists ? gradColor(g) : 'rgba(50,50,58,0.6)';
        ctx.fillRect(ox + gx * VIS_S_CELL, VIS_SY + gy * VIS_S_CELL, VIS_S_CELL - 1, VIS_S_CELL - 1);
      }
    }
    if (!exists) {   // 満タン = 探す必要がない
      ctx.font = 'bold 8px monospace';
      ctx.fillStyle = 'rgba(200,200,205,0.7)';
      ctx.fillText('満タン', ox + 20, VIS_SY + VIS_S_PX / 2);
    }
  }
  const hd = scalar(o, 24) * 40, ad = scalar(o, 26) * 40;
  ctx.font = 'bold 9px monospace';
  ctx.fillStyle = 'rgba(220,220,225,0.75)';
  ctx.fillText(`回復 ${scalar(o, 25) > 0.5 ? (hd | 0) + '歩' : '—'}   弾薬 ${scalar(o, 27) > 0.5 ? (ad | 0) + '歩' : '—'}`,
    VIS_GX + 6, VIS_SY + VIS_S_PX + 11);
}

// ---- いまAIが押している入力 ----
const VIS_ACT_X = 8, VIS_ACT_H = 34;
function renderAction(a) {
  const y = VIS_H_ACT();
  visPanel(VIS_ACT_X, y, 216, VIS_ACT_H, null);
  const on = '#40e080', off = 'rgba(120,120,130,0.5)';
  ctx.font = 'bold 11px monospace';

  const chip = (label, active, x) => {
    ctx.fillStyle = active ? on : off;
    ctx.fillText(label, x, y + 22);
  };
  chip('W', a[0] === 1, VIS_ACT_X + 8);
  chip('S', a[0] === 2, VIS_ACT_X + 22);
  chip('A', a[1] === 1, VIS_ACT_X + 38);
  chip('D', a[1] === 2, VIS_ACT_X + 52);
  chip(['≪', '<', '·', '>', '≫'][a[2]], a[2] !== 2, VIS_ACT_X + 72);
  chip(['v', '·', '^'][a[3]], a[3] !== 1, VIS_ACT_X + 90);
  chip('FIRE', a[4] === 1, VIS_ACT_X + 108);
  chip('USE', a[5] === 1, VIS_ACT_X + 146);
  chip(['-', '1', '2', '3'][a[6]], a[6] !== 0, VIS_ACT_X + 180);

  ctx.font = 'bold 9px monospace';
  ctx.fillStyle = 'rgba(64,224,128,0.9)';
  ctx.fillText('ACTION', VIS_ACT_X + 5, y + 10);
}
function VIS_H_ACT() { return VIEW_H - 48 - VIS_ACT_H - 4; }  // AIバッジの上

function renderAIVision(driver) {
  if (!driver || !driver.action) return;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  renderRayBar(driver.obs);
  renderGrid(driver.obs);
  if (GRID_CH >= 9) renderSupply(driver.obs);   // 補給物資への勾配 (新しい観測にだけある)
  renderAction(driver.action);
  ctx.restore();
}

globalThis.renderAIVision = renderAIVision;
