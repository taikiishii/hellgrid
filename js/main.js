'use strict';
/* =========================================================================
 * ブラウザ用シェル — 入力・タイトル画面・固定タイムステップのループ
 *
 * World(js/sim/world.js)を1つ持ち、入力を流し込み、固定タイムステップで
 * step() し、結果を描画する。World が emit したイベント(音・メッセージ・
 * ポインタロック)をここで実際の副作用に変換する。
 *
 * 実時間 dt はアキュムレータに積み、SIM_DT (1/60秒) 単位でだけ step する。
 * これにより「フレームレートによって挙動が変わる」ことがなくなり、Node 側の
 * 学習環境とまったく同じ物理になる。
 * ========================================================================= */

const MAX_STEPS_PER_FRAME = 5;  // 描画が遅れても最大5ステップまで(スパイラル防止)

const ui = {
  screen: 'title',       // 'title' / 'game'
  showMap: false,
  showRearview: false,
};

let curWorld = null;
let pointerLocked = false;   // render.js の renderOverlays が読む
let mouseDown = false;

// AI デモ (js/ai.js + js/policy.js)。policy.js を読み込んでいなければ機能ごと無効
let ai = null;
let policy = null;
const AI_AVAILABLE = typeof POLICY !== 'undefined' && typeof AIDriver !== 'undefined';
const AI_END_WAIT = 2.5;   // クリア/死亡から自動で次へ進むまでの秒数

// ======================= 起動・状態遷移 =======================

function newGame(withAI = false) {
  Sound.init();
  curWorld = new World({ seed: (Math.random() * 0x100000000) >>> 0, level: 0 });
  ui.screen = 'game';
  ai = null;
  if (withAI) enableAI();
  else canvas.requestPointerLock();
}

function enableAI() {
  if (!AI_AVAILABLE || !curWorld) return;
  if (!policy) policy = new Policy(POLICY);   // 重みのデコードは初回だけ
  ai = new AIDriver(curWorld, policy);
  document.exitPointerLock();
  showMessage('AI がプレイ中 (I キーで操作を取り戻す)');
}

function disableAI() {
  if (!ai) return;
  ai.release();
  ai = null;
  showMessage('手動操作に戻した');
}

function toggleAI() {
  if (!AI_AVAILABLE) { showMessage('学習済みモデルがない (tools/export-policy.py)'); return; }
  if (ai) disableAI(); else enableAI();
}

function toTitle() {
  ui.screen = 'title';
  curWorld = null;
  ai = null;
  document.exitPointerLock();
}

function cycleTheme(dir) {
  const names = Object.keys(THEMES);
  const i = names.indexOf(currentTheme);
  applyTheme(names[(i + dir + names.length) % names.length]);
  Sound.switch_();
}

// World からのイベントを実際の副作用に変換する
function handleEvents(events) {
  for (const ev of events) {
    if (ev.t === 'sound') { if (Sound[ev.v]) Sound[ev.v](); }
    else if (ev.t === 'message') showMessage(ev.v);
    else if (ev.t === 'unlockPointer') document.exitPointerLock();
  }
}

// ======================= 入力 =======================

document.addEventListener('keydown', e => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyM', 'Tab'].includes(e.code)) e.preventDefault();

  if (ui.screen === 'title') {
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'KeyT') cycleTheme(e.code === 'ArrowLeft' ? -1 : 1);
    else if (e.code === 'KeyI') newGame(true);          // AI のデモを見る
    else if (e.code === 'Space' || e.code === 'Enter') newGame();
    return;
  }

  // 画面まわり(World の外の話)。AI がプレイ中でも操作できる
  if (e.code === 'KeyI') { toggleAI(); return; }
  if (e.code === 'KeyM') { ui.showMap = !ui.showMap; return; }
  if (e.code === 'KeyB') { ui.showRearview = !ui.showRearview; showMessage(ui.showRearview ? 'バックミラー ON' : 'バックミラー OFF'); return; }
  if (e.code === 'KeyP') { Sound.toggleMute(); showMessage(Sound.muted ? 'サウンド OFF' : 'サウンド ON'); return; }

  if (ai) {
    if (e.code === 'KeyQ') toTitle();   // デモを抜ける
    return;                            // AI 中はプレイヤーの入力を World に流さない
  }

  curWorld.keys[e.code] = true;

  switch (curWorld.state) {
    case 'dead':
      if (e.code === 'KeyR') { curWorld.restartLevel(); canvas.requestPointerLock(); }
      else if (e.code === 'KeyQ') toTitle();
      return;
    case 'levelEnd':
      if (e.code === 'Space' || e.code === 'Enter') advance();
      return;
    case 'gameClear':
      if (e.code === 'Space' || e.code === 'Enter') toTitle();
      return;
    default:
      curWorld.pressKey(e.code);
  }
});

document.addEventListener('keyup', e => {
  if (curWorld && !ai) curWorld.keys[e.code] = false;
});

canvas.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  mouseDown = true;
  if (ui.screen === 'title') { newGame(); return; }
  if (ai) return;
  switch (curWorld.state) {
    case 'playing':   if (!pointerLocked) canvas.requestPointerLock(); break;
    case 'dead':      curWorld.restartLevel(); canvas.requestPointerLock(); break;
    case 'levelEnd':  advance(); break;
    case 'gameClear': toTitle(); break;
  }
});

document.addEventListener('mouseup', e => { if (e.button === 0) mouseDown = false; });

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
});

document.addEventListener('mousemove', e => {
  if (pointerLocked && curWorld && curWorld.state === 'playing') {
    curWorld.look(e.movementX, e.movementY);
  }
});

// 次のステージへ。全ステージ終わっていれば World が gameClear になる
function advance() {
  curWorld.nextLevel();
  if (curWorld.state === 'playing' && !ai) canvas.requestPointerLock();
}

// AI デモは止まらずに進み続ける。クリア/死亡から少し待って自動で次へ。
//
// ステージごとに reset() で仕切り直すのは、いまの方策が「1ステージ単位」(stage=single)
// で学習されているから。HPや弾を持ち越す通し(campaign)の方策はまだ学習していないので、
// 持ち越したまま走らせると訓練時と条件が変わって途中で力尽きる。
function aiAutoAdvance(dt) {
  if (curWorld.state === 'playing') { ai.endT = 0; return; }
  ai.endT += dt;
  if (ai.endT < AI_END_WAIT) return;
  ai.endT = 0;

  const i = curWorld.level.index;
  if (curWorld.state === 'dead') curWorld.reset(i);                  // 同じステージをやり直す
  else if (curWorld.state === 'levelEnd') curWorld.reset((i + 1) % LEVELS.length);
  else curWorld.reset(0);
  curWorld.drainEvents();
  ai.syncLevel();
}

// ======================= ループ =======================

let lastTime = performance.now();
let acc = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (ui.screen === 'title') {
    renderTitle();
    requestAnimationFrame(frame);
    return;
  }

  const w = curWorld;
  if (!ai) w.shootHeld = mouseDown && pointerLocked;

  // 固定タイムステップ。積み残しが多すぎるときは捨てる(タブ復帰など)
  acc += dt;
  if (acc > SIM_DT * MAX_STEPS_PER_FRAME) acc = SIM_DT * MAX_STEPS_PER_FRAME;
  while (acc >= SIM_DT) {
    if (ai && w.state === 'playing') ai.preStep();   // 4シムステップに1回だけ推論する
    w.step(SIM_DT);
    acc -= SIM_DT;
  }
  handleEvents(w.drainEvents());
  if (ai) aiAutoAdvance(dt);

  bindWorld(w);
  renderView();
  if (ui.showRearview) renderRearview();
  if (w.state === 'playing' || w.state === 'dead') renderWeapon();
  renderHUD();
  if (ui.showMap) renderMinimap();
  renderOverlays(dt);
  if (ai) renderAIBadge();

  const uiTh = TH.ui;
  const lv = w.level;
  if (w.state === 'dead') {
    renderCenteredScreen([
      [uiTh.deadTitle, 'bold 40px monospace', uiTh.deadColor],
      ['', '', ''],
      [`キル: ${lv.kills}/${lv.totalKills}`, 'bold 18px monospace', uiTh.helpColor],
      ['Rキー / クリックでリスタート', 'bold 18px monospace', '#e0b040'],
      ['Qキーでタイトルへ戻る', 'bold 18px monospace', '#e0b040'],
    ]);
  } else if (w.state === 'levelEnd') {
    const t = lv.time | 0;
    renderCenteredScreen([
      [`${lv.def.name} クリア!`, 'bold 32px monospace', uiTh.endColor],
      ['', '', ''],
      [`キル: ${lv.kills}/${lv.totalKills}   アイテム: ${lv.itemsGot}/${lv.totalItems}   シークレット: ${lv.secretsFound}/${lv.totalSecrets}`, 'bold 18px monospace', uiTh.helpColor],
      [`タイム: ${(t / 60) | 0}:${String(t % 60).padStart(2, '0')} (パー ${lv.def.par}秒)`, 'bold 18px monospace', uiTh.helpColor],
      ['', '', ''],
      [lv.index + 1 < LEVELS.length ? 'Space / クリックで次のステージへ' : 'Space / クリックでリザルトへ', 'bold 18px monospace', '#e0b040'],
    ]);
  } else if (w.state === 'gameClear') {
    renderCenteredScreen([
      [uiTh.clearTitle, 'bold 44px monospace', uiTh.clearColor],
      ['', '', ''],
      [uiTh.clearMsg, 'bold 18px monospace', uiTh.helpColor],
      ['クリックでタイトルへ', 'bold 18px monospace', '#e0b040'],
    ]);
  }

  requestAnimationFrame(frame);
}

// AI デモ中であることを画面に出す
function renderAIBadge() {
  const lv = curWorld.level;
  const d = ai.goalDist();
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(8, VIEW_H - 48, 216, 40);
  ctx.strokeStyle = 'rgba(64,224,128,0.5)';
  ctx.strokeRect(8.5, VIEW_H - 47.5, 215, 39);
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = '#40e080';
  ctx.fillText('● AI PLAYING', 16, VIEW_H - 31);
  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = 'rgba(220,220,225,0.75)';
  ctx.fillText(`${lv.def.name}   出口まで ${d < 0 ? '?' : d} 歩`, 16, VIEW_H - 16);
  ctx.restore();
}

// tools/*.py の自動テストから page.evaluate で叩くためのハンドル。
// player / level / game は render.js が現在の World にバインドした別名なので、
// そのままグローバルとして読み書きできる。
globalThis.HG = {
  get world() { return curWorld; },
  newGame,
  loadLevel(i) {
    if (!curWorld) newGame();
    curWorld.loadLevel(i);
    curWorld.state = 'playing';
  },
};
function loadLevel(i) { HG.loadLevel(i); }

// 起動
buildTextures();
buildSprites();
requestAnimationFrame(frame);
