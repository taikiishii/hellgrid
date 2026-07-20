'use strict';
/* =========================================================================
 * 探索版デモのシェル (explore.html 専用)
 *
 * index.html (main.js) には手を入れず、独立したページとして動く。
 * 「見たものだけ」で学習した各段階の方策を切り替えて観察する:
 *
 *   K         方策の切り替え (探索者 / ナビゲーター / チャンピオン / ハンター)
 *   1〜5      E1M1〜E1M5 を単発で (素の状態から)
 *   C         通し (E1M1 から HP・弾持ち越し。チャンピオンの訓練条件)
 *   R         ランダム迷路 (21×21・部屋つき。探索者の訓練条件)
 *   H         狩りモード (敵つき迷路 + キルゲート。ハンターの訓練条件)
 *   N         同じモードで新しいシード
 *   V         フォグ・オブ・ウォー (AIの記憶) の表示切替
 *   M         全体マップ (神の視点。フォグとの対比用)
 *   [ ] \ .   速度 / 一時停止 / コマ送り
 *
 * 画面右上のフォグマップが「AIが見た(覚えている)世界」のすべてで、
 * 3D ビューが神の視点。両者の差がこのプロジェクトの主題。
 * ========================================================================= */

const MAX_STEPS_PER_FRAME = 5;
const AI_END_WAIT = 2.0;      // クリア/死亡から自動で次へ進むまでの秒数
const SPEEDS = [0.25, 0.5, 1, 2, 4];

// render.js が参照するグローバル
const ui = { screen: 'game', showMap: false, showRearview: false, showVision: false };
let pointerLocked = false;
let mouseDown = false;

let curWorld = null;
let ai = null;                 // AIDriver2
let showFog = true;
let speedIdx = 2;
let paused = false;
let stepOnce = false;

// モード: {kind: 'single', level: n} / {kind: 'campaign'} / {kind: 'maze'}
let mode = { kind: 'campaign' };
let mazeIdx = -1;

// 方策 (js/policy2-*.js が POLICIES2 に登録している)。手法の進化の順に並べる
const POLICY_ORDER = ['explorer', 'navigator', 'champion', 'hunter'];
let policyName = 'champion';
const policyCache = {};

function currentPolicy() {
  if (!policyCache[policyName]) policyCache[policyName] = new Policy(POLICIES2[policyName]);
  return policyCache[policyName];
}

function randSeed() { return (Math.random() * 0x100000000) >>> 0; }

// ======================= ゲーム開始 =======================

function startGame() {
  Sound.init();
  const seed = randSeed();
  let level = 0;
  if (mode.kind === 'single') level = mode.level;
  else if (mode.kind === 'maze' || mode.kind === 'hunt') {
    const opts = mode.kind === 'hunt'
      ? { size: 17, braid: 0.15, rooms: 3, enemies: [2, 6] }
      : { size: 21, braid: 0.15, rooms: 5 };
    const def = generateMaze(seed, opts);
    if (mazeIdx < 0) { mazeIdx = LEVELS.length; LEVELS.push(def); }
    else LEVELS[mazeIdx] = def;
    level = mazeIdx;
  }
  if (!curWorld) curWorld = new World({ seed, level });
  else curWorld.reset(level, seed);
  // 狩りモード: 敵を全滅させるまで出口が作動しない (ハンターの訓練条件)
  if (mode.kind === 'hunt') curWorld.level.killGate = curWorld.level.totalKills;
  curWorld.drainEvents();
  ai = new AIDriver2(curWorld, currentPolicy());
  showModeMessage();
}

function showModeMessage() {
  const m = mode.kind === 'single' ? `E1M${mode.level + 1} 単発`
    : mode.kind === 'campaign' ? '通し (E1M1→M5・持ち越し)'
    : mode.kind === 'hunt' ? '狩り (敵つき迷路・全滅ゲート)'
    : 'ランダム迷路 21×21';
  showMessage(`${POLICIES2[policyName].label} / ${m}`);
}

// クリア/死亡したら少し待って自動で次へ
function aiAutoAdvance(dt) {
  if (curWorld.state === 'playing') { ai.endT = 0; return; }
  ai.endT += dt;
  if (ai.endT < AI_END_WAIT) return;
  ai.endT = 0;
  if (mode.kind === 'campaign' && curWorld.state === 'levelEnd' && curWorld.level.index < 4) {
    curWorld.nextLevel();      // HP・弾を持ち越して次のステージへ
    curWorld.drainEvents();
    ai.syncLevel();            // 記憶は白紙から (学習時と同じ)
  } else {
    startGame();               // 仕切り直し (迷路は新しい形を生成)
  }
}

function handleEvents(events) {
  for (const ev of events) {
    if (ev.t === 'sound') { if (Sound[ev.v]) Sound[ev.v](); }
    else if (ev.t === 'message') showMessage(ev.v);
  }
}

// ======================= フォグ・オブ・ウォー描画 =======================
// AIの記憶 (ExploreMemory) だけを描く。3Dビュー (神の視点) との対比が主題

function renderFog() {
  if (!ai) return;
  const lv = curWorld.level, mem = ai.mem, p = curWorld.player;
  const cell = Math.max(3, Math.min(7, Math.floor(168 / Math.max(lv.w, lv.h))));
  const mw = lv.w * cell, mh = lv.h * cell;
  const x0 = canvas.width - mw - 10, y0 = 34;

  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(x0 - 4, y0 - 18, mw + 8, mh + 26);
  ctx.fillStyle = '#9ad';
  ctx.font = 'bold 9px monospace';
  ctx.fillText(`AIの記憶  探索率 ${(ai.coverage() * 100).toFixed(0)}%`, x0, y0 - 7);

  for (let y = 0; y < lv.h; y++) {
    for (let x = 0; x < lv.w; x++) {
      const i = y * lv.w + x;
      if (!mem.known[i]) { ctx.fillStyle = '#15151d'; ctx.fillRect(x0 + x * cell, y0 + y * cell, cell, cell); continue; }
      const ch = lv.grid[y][x];
      if (ch === null) ctx.fillStyle = lv.water[y][x] ? '#1d3a5f' : '#3c3c46';
      else if (ch === 'X') ctx.fillStyle = '#e04040';
      else if (ch === 'D') ctx.fillStyle = '#4a90d9';
      else if (ch === 'R') ctx.fillStyle = p.keys.red ? '#4a90d9' : '#a03050';
      else if (ch === 'B') ctx.fillStyle = p.keys.blue ? '#4a90d9' : '#3050a0';
      else ctx.fillStyle = '#6b5a48';
      ctx.fillRect(x0 + x * cell, y0 + y * cell, cell, cell);
      // 記憶しているアイテム / 最後に見た敵 (時間で薄れる)
      if (mem.itemSeen[i]) {
        ctx.fillStyle = '#e0c040';
        ctx.fillRect(x0 + x * cell + cell / 3, y0 + y * cell + cell / 3, cell / 3, cell / 3);
      }
      const et = mem.enemyT[i];
      if (et >= 0) {
        const f = Math.max(0, 1 - (lv.time - et) / 6);
        if (f > 0) {
          ctx.fillStyle = `rgba(255,60,60,${(0.35 + 0.65 * f).toFixed(2)})`;
          ctx.fillRect(x0 + x * cell + cell / 4, y0 + y * cell + cell / 4, cell / 2, cell / 2);
        }
      }
    }
  }
  // 自機 (向き付き)
  const px = x0 + p.x * cell, py = y0 + p.y * cell;
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + p.dirX * cell * 1.6, py + p.dirY * cell * 1.6);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
}

function renderDemoBadge() {
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(6, 4, 340, 24);
  ctx.fillStyle = '#8fd';
  ctx.font = 'bold 10px monospace';
  const m = mode.kind === 'single' ? `E1M${mode.level + 1}` : mode.kind === 'campaign' ? '通し'
    : mode.kind === 'hunt' ? '狩り' : '迷路';
  let tag = `${POLICIES2[policyName].label} [${m}] x${SPEEDS[speedIdx]}${paused ? ' ⏸' : ''}`;
  const lv = curWorld.level;
  if (lv.killGate) tag += `  討伐 ${lv.kills}/${lv.killGate}`;   // 狩りモードの進捗
  ctx.fillText(tag, 12, 20);
  ctx.fillStyle = '#789';
  ctx.font = '9px monospace';
  ctx.fillText('K:方策 1-5:単発 C:通し R:迷路 H:狩り N:新シード V:記憶 M:全体図', 12, 44);
}

// ======================= 入力 =======================

document.addEventListener('keydown', e => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyM', 'Tab'].includes(e.code)) e.preventDefault();

  if (e.code === 'KeyK') {
    policyName = POLICY_ORDER[(POLICY_ORDER.indexOf(policyName) + 1) % POLICY_ORDER.length];
    ai = new AIDriver2(curWorld, currentPolicy());   // 記憶も引き継がず白紙から
    showModeMessage();
    return;
  }
  if (/^Digit[1-5]$/.test(e.code)) { mode = { kind: 'single', level: +e.code[5] - 1 }; startGame(); return; }
  if (e.code === 'KeyC') { mode = { kind: 'campaign' }; startGame(); return; }
  if (e.code === 'KeyR') { mode = { kind: 'maze' }; startGame(); return; }
  if (e.code === 'KeyH') { mode = { kind: 'hunt' }; startGame(); return; }
  if (e.code === 'KeyN') { startGame(); return; }
  if (e.code === 'KeyV') { showFog = !showFog; return; }
  if (e.code === 'KeyM') { ui.showMap = !ui.showMap; return; }
  if (e.code === 'KeyP') { Sound.toggleMute(); showMessage(Sound.muted ? 'サウンド OFF' : 'サウンド ON'); return; }
  if (e.code === 'BracketLeft') { speedIdx = Math.max(0, speedIdx - 1); return; }
  if (e.code === 'BracketRight') { speedIdx = Math.min(SPEEDS.length - 1, speedIdx + 1); return; }
  if (e.code === 'Backslash') { paused = !paused; return; }
  if (e.code === 'Period') { stepOnce = true; paused = true; return; }
});

canvas.addEventListener('mousedown', () => { Sound.init(); });

// ======================= ループ =======================

let lastTime = performance.now();
let acc = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  const w = curWorld;

  const speed = SPEEDS[speedIdx];
  if (paused) {
    if (stepOnce) {
      for (let i = 0; i < AI2_FRAME_SKIP; i++) { if (w.state === 'playing') { ai.preStep(); w.step(SIM_DT); } }
      stepOnce = false;
    }
    acc = 0;
  } else {
    acc += dt * speed;
    const maxAcc = SIM_DT * MAX_STEPS_PER_FRAME * Math.max(1, speed);
    if (acc > maxAcc) acc = maxAcc;
    while (acc >= SIM_DT) {
      if (w.state === 'playing') ai.preStep();
      w.step(SIM_DT);
      acc -= SIM_DT;
    }
  }
  handleEvents(w.drainEvents());
  if (!paused) aiAutoAdvance(dt * speed);

  bindWorld(w);
  renderView();
  if (w.state === 'playing' || w.state === 'dead') renderWeapon();
  renderHUD();
  if (ui.showMap) renderMinimap();
  renderOverlays(dt);
  if (showFog) renderFog();
  renderDemoBadge();

  requestAnimationFrame(frame);
}

buildTextures();   // テーマの壁テクスチャとスプライトを生成 (main.js の起動処理と同じ)
buildSprites();
startGame();
requestAnimationFrame(frame);
