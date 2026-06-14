'use strict';
/* =========================================================================
 * HELLGRID — ブラウザ レイキャスティングFPS エンジン
 *
 * 外部依存なし。index.html から levels.js の後に読み込む。
 * セクション:
 *   1. 設定・ユーティリティ
 *   2. サウンド (WebAudio 手続き生成)
 *   3. テクスチャ (手続き生成)
 *   4. スプライト描画 (敵・アイテム・武器)
 *   5. レベルロード
 *   6. 入力
 *   7. プレイヤー・武器
 *   8. 敵AI・弾
 *   9. レンダリング
 *  10. ゲームループ・状態管理
 * ========================================================================= */

// ======================= 1. 設定・ユーティリティ =======================
const W = 640, VIEW_H = 352, HUD_H = 48, H = VIEW_H + HUD_H;
const TEX = 64;                  // テクスチャ解像度
const FOV_PLANE = 0.66;          // 視野(カメラ平面の長さ)
const PLAYER_RADIUS = 0.28;
const MOVE_SPEED = 4.2;          // タイル/秒
const ROT_SPEED = 2.6;           // rad/秒 (キーボード旋回)
const MOUSE_SENS = 0.0022;
const STEP_MAX = 0.55;           // 歩いて登れる段差の高さ(タイル)
const EYE = 0.5;                 // 床からの目の高さ(タイル)
const PITCH_MAX = 150;           // 上下視点の最大シフト量(px)
const WATER_DEPTH = -0.4;        // 水路・池の水面の高さ(床より低い窪み)
const CONVEYOR_SPEED = 2.2;      // 動く歩道で流される速さ(タイル/秒)
// 動く歩道タイル → 流れる方向ベクトル ( '^' は北=画面奥, 'v' は南 )
const CONV_CHARS = { '>': [1, 0], '<': [-1, 0], '^': [0, -1], 'v': [0, 1] };
const BARREL_HP = 20;            // 爆発樽の耐久
const EXPLOSION_RADIUS = 2.6;    // 爆風の半径(タイル)
const EXPLOSION_DMG = 65;        // 爆風の中心ダメージ(距離で減衰)
const LIFT_MIN = 0, LIFT_MAX = 1.0, LIFT_RATE = 1.1; // リフトの上下範囲と速さ
const ARMOR_MAX = 200;           // アーマーの上限
const ARMOR_ABSORB = 1 / 3;      // アーマーが肩代わりするダメージの割合

let currentTheme = 'pastel'; // 'hell'(ホラー) / 'pastel'(ほのぼの)

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
const hexToRGB = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// ======================= 2. サウンド =======================
const Sound = {
  ctx: null, master: null, musicGain: null, muted: false, musicTimer: null,
  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.16;
    this.musicGain.connect(this.master);
    this.startMusic();
  },
  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
  },
  // 単発オシレーター
  tone(freq, dur, type, vol, slide = 0, delay = 0) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  },
  // ノイズバースト
  noise(dur, vol, filterFreq, delay = 0) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = filterFreq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t0);
  },
  // 効果音はテーマで切り替える。pastel は sine 中心のやわらかい音、hell はノイズ混じりの攻撃的な音。
  pistol()    { if (currentTheme === 'pastel') { this.tone(880, 0.09, 'sine', 0.2, -300); } else { this.noise(0.12, 0.5, 2500); this.tone(220, 0.08, 'square', 0.25, -150); } },
  shotgun()   { if (currentTheme === 'pastel') { this.tone(523, 0.16, 'sine', 0.24, -160); this.tone(392, 0.12, 'sine', 0.16, 0, 0.04); } else { this.noise(0.3, 0.8, 1400); this.tone(90, 0.2, 'sawtooth', 0.4, -50); } },
  fireball()  { if (currentTheme === 'pastel') { this.tone(620, 0.18, 'sine', 0.18, 260); } else { this.tone(300, 0.3, 'sawtooth', 0.2, -200); this.noise(0.2, 0.15, 900); } },
  explode()   { if (currentTheme === 'pastel') { this.tone(330, 0.18, 'sine', 0.22, -120); this.tone(220, 0.12, 'triangle', 0.14, 0, 0.03); } else { this.noise(0.25, 0.5, 700); this.tone(70, 0.25, 'triangle', 0.4, -40); } },
  enemyPain() { if (currentTheme === 'pastel') { this.tone(700, 0.1, 'sine', 0.2, 140); } else { this.tone(160, 0.18, 'sawtooth', 0.3, 60); } },
  enemyDie()  { if (currentTheme === 'pastel') { this.tone(660, 0.35, 'sine', 0.24, -260); this.tone(880, 0.2, 'sine', 0.12, 0, 0.08); } else { this.tone(140, 0.5, 'sawtooth', 0.35, -100); this.noise(0.4, 0.3, 600); } },
  alert()     { if (currentTheme === 'pastel') { this.tone(523, 0.1, 'sine', 0.2); this.tone(659, 0.12, 'sine', 0.2, 0, 0.08); } else { this.tone(110, 0.25, 'sawtooth', 0.25, 50); this.tone(95, 0.2, 'sawtooth', 0.2, -20, 0.15); } },
  playerHurt(){ if (currentTheme === 'pastel') { this.tone(392, 0.16, 'sine', 0.26, -70); } else { this.tone(120, 0.25, 'square', 0.35, -60); } },
  pickup()    { if (currentTheme === 'pastel') { this.tone(784, 0.07, 'sine', 0.2); this.tone(1047, 0.1, 'sine', 0.2, 0, 0.06); } else { this.tone(660, 0.07, 'square', 0.2); this.tone(880, 0.1, 'square', 0.2, 0, 0.07); } },
  weaponUp()  { if (currentTheme === 'pastel') { this.tone(523, 0.08, 'sine', 0.22); this.tone(659, 0.08, 'sine', 0.22, 0, 0.08); this.tone(784, 0.12, 'sine', 0.22, 0, 0.16); } else { this.tone(440, 0.08, 'square', 0.25); this.tone(660, 0.08, 'square', 0.25, 0, 0.08); this.tone(880, 0.12, 'square', 0.25, 0, 0.16); } },
  door()      { if (currentTheme === 'pastel') { this.tone(330, 0.18, 'sine', 0.18, 40); this.tone(440, 0.14, 'sine', 0.14, 0, 0.06); } else { this.noise(0.4, 0.25, 400); this.tone(60, 0.4, 'triangle', 0.2, 30); } },
  switch_()   { if (currentTheme === 'pastel') { this.tone(659, 0.1, 'sine', 0.26); this.tone(880, 0.14, 'sine', 0.26, 0, 0.09); } else { this.tone(200, 0.1, 'square', 0.3); this.tone(150, 0.15, 'square', 0.3, 0, 0.1); } },
  denied()    { if (currentTheme === 'pastel') { this.tone(440, 0.12, 'sine', 0.24, -120); this.tone(330, 0.16, 'sine', 0.24, -80, 0.1); } else { this.tone(110, 0.12, 'square', 0.3); this.tone(85, 0.18, 'square', 0.3, 0, 0.1); } },
  teleport()  { if (currentTheme === 'pastel') { this.tone(660, 0.3, 'sine', 0.26, 520); this.tone(990, 0.2, 'sine', 0.16, 0, 0.1); } else { this.tone(900, 0.35, 'sawtooth', 0.3, -750); this.noise(0.3, 0.25, 1500); } },
  bite()      { if (currentTheme === 'pastel') { this.tone(260, 0.1, 'sine', 0.24, -60); this.tone(200, 0.08, 'sine', 0.18, 0, 0.05); } else { this.noise(0.08, 0.45, 3000); this.tone(170, 0.13, 'square', 0.3, -90, 0.03); } },
  knife()     { // ほのぼのモードは「ぽよん」、ホラーは刃のスイッシュ音
    if (currentTheme === 'pastel') { this.tone(540, 0.12, 'sine', 0.28, 240); this.tone(400, 0.1, 'sine', 0.2, 120, 0.05); }
    else { this.noise(0.1, 0.32, 3800); this.tone(220, 0.07, 'sawtooth', 0.15, -110); }
  },
  knifeHit()  { if (currentTheme === 'pastel') this.tone(720, 0.1, 'sine', 0.3, -160); else this.noise(0.09, 0.4, 1800); },
  // BGM をループ再生。テーマで曲調が変わる(毎ステップ currentTheme を見るので切替に追従)
  startMusic() {
    if (this.musicTimer) return;
    const darkBass = [55, 55, 58.27, 55, 65.41, 55, 51.91, 55];       // A1 ベースの不穏な音列(hell)
    const sweetMel = [261.63, 329.63, 392, 329.63, 440, 392, 329.63, 293.66]; // C メジャー風のやさしい旋律(pastel)
    let step = 0;
    const playStep = () => {
      if (!this.ctx) return;
      if (!this.muted) {
        const t0 = this.ctx.currentTime;
        const pastel = currentTheme === 'pastel';
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = pastel ? 'triangle' : 'sawtooth';
        o.frequency.value = (pastel ? sweetMel : darkBass)[step % 8];
        g.gain.setValueAtTime(pastel ? 0.4 : 0.5, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + (pastel ? 0.5 : 0.42));
        o.connect(g); g.connect(this.musicGain);
        o.start(t0); o.stop(t0 + (pastel ? 0.55 : 0.45));
        if (pastel ? step % 4 === 2 : step % 8 === 4) {
          const o2 = this.ctx.createOscillator();
          const g2 = this.ctx.createGain();
          if (pastel) { // 3度上のやわらかいハモり(きらきら)
            o2.type = 'sine';
            o2.frequency.value = sweetMel[step % 8] * 1.5;
            g2.gain.setValueAtTime(0.14, t0);
            g2.gain.exponentialRampToValueAtTime(0.001, t0 + 0.7);
            o2.connect(g2); g2.connect(this.musicGain);
            o2.start(t0); o2.stop(t0 + 0.75);
          } else {      // ハイの不協和音
            o2.type = 'triangle';
            o2.frequency.value = 220 * 1.06;
            g2.gain.setValueAtTime(0.12, t0);
            g2.gain.exponentialRampToValueAtTime(0.001, t0 + 1.2);
            o2.connect(g2); g2.connect(this.musicGain);
            o2.start(t0); o2.stop(t0 + 1.3);
          }
        }
      }
      step++;
      this.musicTimer = setTimeout(playStep, currentTheme === 'pastel' ? 500 : 460);
    };
    playStep();
  },
};

// ===================== テーマ(色・世界観) =====================
// 壁テクスチャ・スプライト・UI・レベルの色をまとめて切り替える。
// 新しいテーマは THEMES に1エントリ + SPRITE_BUILDERS に1エントリ足すだけ。
const THEMES = {
  hell: {
    label: '地獄 (ホラー)',
    wall: {
      brickBase: '#4a2820', brick: '#5d3328',
      techBase: '#2e3540', techPanel: '#3c4554', techSeam: '#1b2027',
      techLed1: '#7fdc7f', techLed2: '#dc5050', techRivet: '#586475',
      pillarBase: '#4d4d52', pillarBlock: '#5d5d63',
      doorFrame: '#52524e', doorPanel: '#62625c', doorSeam: '#3a3a36',
      doorStripe: '#c8a020', doorKick: '#2a2a28',
      exitPanel: '#3a3a40', exitInner: '#2a2a2e', exitSlot: '#181818',
      exitLever: '#30d030', exitBase: '#777', exitText: '#d03030', exitLabel: 'EXIT',
      lockRed: '#c83030', lockBlue: '#3050c8',
      darkSide: 0.35,
    },
    ui: {
      titleBg: '#0c0a0a', titleGlow: ['#481010', '#0c0a0a'],
      titleGrad: ['#ff5030', '#801010'], titleName: 'HELLGRID',
      subtitle: '— browser raycasting shooter —', subtitleColor: '#a09080',
      helpColor: '#c0c0c0', startColor: '255,200,80',
      hudBg: '#1a1a1c', hudLine: '#333', label: '#888', value: '#d8d8d8', arms: '#c8b840',
      message: '230,60,40', damageFlash: '200,0,0', pickupFlash: '255,220,80',
      deadColor: '#d02020', deadTitle: 'おまえは死んだ',
      clearColor: '#ff6030', clearTitle: 'DEMO COMPLETE',
      clearMsg: 'デモはここまで。地獄はまだ続く…', endColor: '#40d040',
      overlay: 'rgba(0,0,0,0.75)',
    },
    fx: {
      fireball: ['#c83000', '#ff8820', '#ffe060'],
      greenball: ['#1a7020', '#30c040', '#a0ffa0'],
      boom: ['255,160,40', '255,230,120'],
      blood: ['160,20,20', '220,60,40'],
      tele: ['40,220,80', '200,255,200'],
    },
    weapon: {
      muzzle: '255,220,80', crosshair: '220,220,220',
      pBody: '#23232a', pGrip: '#33333c', pBarrel: '#15151a', pTop: '#444450',
      sBody: '#2a2a30', sBarrel: '#171719', sStock: '#5a4028', sStockTop: '#6a4c30',
      kBlade: '#d8dde6', kEdge: '#ffffff', kGuard: '#3a3a40', kGrip: '#2a2a2e',
    },
    terrain: { waterRGB: [26, 54, 78], conveyorRGB: [66, 70, 84], conveyorHi: [120, 126, 146] },
    levelColor: null, // levels.js の色をそのまま使う
  },
  pastel: {
    label: 'ほのぼの (パステル)',
    wall: {
      brickBase: '#e9b9c8', brick: '#f6cdd9',
      techBase: '#bfe0ea', techPanel: '#d4eef5', techSeam: '#9fc8d6',
      techLed1: '#9be8b8', techLed2: '#ffb3c6', techRivet: '#cfe8f0',
      pillarBase: '#cfc3e8', pillarBlock: '#ddd2f0',
      doorFrame: '#d9c9a8', doorPanel: '# efe2c6', doorSeam: '#c8b48a',
      doorStripe: '#ffd98a', doorKick: '#c8b48a',
      exitPanel: '#ffd6e6', exitInner: '#fff0f5', exitSlot: '#ffffff',
      exitLever: '#7fd6a0', exitBase: '#f0a8c0', exitText: '#ef7aa6', exitLabel: 'GOAL',
      lockRed: '#ef8aa6', lockBlue: '#8ab6ef',
      darkSide: 0.22,
    },
    ui: {
      titleBg: '#fdf3f7', titleGlow: ['#ffe3ef', '#fdf3f7'],
      titleGrad: ['#ff9ec4', '#b58ad8'], titleName: 'FLUFFYGRID',
      subtitle: '— ほのぼのパステル モード —', subtitleColor: '#b09ab8',
      helpColor: '#8a7a98', startColor: '255,150,200',
      hudBg: '#f3e6ee', hudLine: '#e0c8d8', label: '#b08 aa0', value: '#7a6a88', arms: '#d88ab0',
      message: '230,120,170', damageFlash: '255,150,190', pickupFlash: '180,240,200',
      deadColor: '#e58ab0', deadTitle: 'めがまわった…',
      clearColor: '#ff9ec4', clearTitle: 'おつかれさま!',
      clearMsg: 'なかよしの輪はまだまだ広がる…', endColor: '#8ad6a8',
      overlay: 'rgba(60,40,60,0.55)',
    },
    fx: {
      fireball: ['#7fc8ef', '#bfe6f8', '#ffffff'],   // シャボン玉
      greenball: ['#6ec98f', '#aee8c4', '#eafff2'],  // ハート風
      boom: ['255,240,210', '255,255,255'],          // ぽふっと白い煙
      blood: ['255,190,215', '255,235,245'],         // ピンクの煙(血ではない)
      tele: ['180,225,255', '235,250,255'],
    },
    weapon: {
      muzzle: '180,235,255', crosshair: '120,150,180',
      pBody: '#9fd6ea', pGrip: '#f3b0cb', pBarrel: '#cdeffb', pTop: '#ffffff',
      sBody: '#b9a8e0', sBarrel: '#e6dcf5', sStock: '#f3b0cb', sStockTop: '#ffd0e0',
      kMain: '#ff9ec4', kAccent: '#fff0f5', kArm: '#b9a8e0',
    },
    terrain: { waterRGB: [150, 215, 240], conveyorRGB: [212, 200, 236], conveyorHi: [248, 242, 255] },
    // ステージごとに空色・芝の色をローテーション
    levelColor: i => [
      { ceil: '#bfe6f5', floor: '#cdeccc', fog: [232, 244, 250] }, // 晴れの草原
      { ceil: '#f8d6e8', floor: '#e8dcf2', fog: [250, 236, 246] }, // 夕焼けピンク
      { ceil: '#cfe6f0', floor: '#dceadd', fog: [236, 244, 246] }, // やわらか水色
      { ceil: '#e6dcf2', floor: '#d8ecd4', fog: [244, 240, 250] }, // ラベンダー
    ][i % 4],
  },
};

// CSS色がうっかりスペースを含むと無効になるので除去
for (const t of Object.values(THEMES)) {
  for (const k in t.wall) if (typeof t.wall[k] === 'string') t.wall[k] = t.wall[k].replace(/\s/g, '');
  for (const k in t.ui) if (typeof t.ui[k] === 'string') t.ui[k] = t.ui[k].replace(/\s/g, '');
}

let TH = THEMES[currentTheme];

// ======================= 3. テクスチャ =======================
// 壁テクスチャを手続き生成。textures[char] = {lit, dark} (側面は暗い方を使う)
const textures = {};

function darken(srcCanvas, amount) {
  const c = makeCanvas(TEX, TEX);
  const g = c.getContext('2d');
  g.drawImage(srcCanvas, 0, 0);
  g.fillStyle = `rgba(0,0,0,${amount})`;
  g.fillRect(0, 0, TEX, TEX);
  return c;
}

function addNoise(g, alpha) {
  for (let i = 0; i < 350; i++) {
    const v = Math.floor(Math.random() * 60);
    g.fillStyle = `rgba(${v},${v},${v},${alpha})`;
    g.fillRect(Math.random() * TEX | 0, Math.random() * TEX | 0, 2, 2);
  }
}

function buildTextures() {
  const wc = TH.wall;
  const ds = wc.darkSide;
  // '#' レンガ
  {
    const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
    g.fillStyle = wc.brickBase; g.fillRect(0, 0, TEX, TEX);
    g.fillStyle = wc.brick;
    for (let row = 0; row < 8; row++) {
      const off = (row % 2) * 8;
      for (let col = -1; col < 5; col++) {
        g.fillRect(col * 16 + off + 1, row * 8 + 1, 14, 6);
      }
    }
    g.fillStyle = 'rgba(0,0,0,0.25)';
    for (let row = 0; row < 8; row++) g.fillRect(0, row * 8, TEX, 1);
    addNoise(g, 0.18);
    textures['#'] = { lit: c, dark: darken(c, ds) };
  }
  // '&' テックパネル
  {
    const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
    g.fillStyle = wc.techBase; g.fillRect(0, 0, TEX, TEX);
    g.fillStyle = wc.techPanel;
    g.fillRect(4, 4, 56, 26); g.fillRect(4, 34, 26, 26); g.fillRect(34, 34, 26, 26);
    g.fillStyle = wc.techSeam;
    g.fillRect(0, 31, TEX, 2); g.fillRect(31, 32, 2, 32);
    // ライト
    g.fillStyle = wc.techLed1; g.fillRect(8, 8, 4, 4); g.fillRect(52, 8, 4, 4);
    g.fillStyle = wc.techLed2; g.fillRect(8, 18, 4, 4);
    // リベット
    g.fillStyle = wc.techRivet;
    [[6, 38], [26, 38], [6, 56], [26, 56], [38, 38], [56, 38], [38, 56], [56, 56]].forEach(([x, y]) => g.fillRect(x, y, 3, 3));
    addNoise(g, 0.1);
    textures['&'] = { lit: c, dark: darken(c, ds) };
  }
  // '=' 石柱
  {
    const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
    g.fillStyle = wc.pillarBase; g.fillRect(0, 0, TEX, TEX);
    g.fillStyle = wc.pillarBlock;
    for (let row = 0; row < 4; row++) {
      const off = (row % 2) * 16;
      for (let col = -1; col < 3; col++) g.fillRect(col * 32 + off + 1, row * 16 + 1, 30, 14);
    }
    g.fillStyle = 'rgba(0,0,0,0.3)';
    for (let row = 0; row < 4; row++) g.fillRect(0, row * 16, TEX, 2);
    addNoise(g, 0.2);
    textures['='] = { lit: c, dark: darken(c, ds) };
  }
  // 'D' ドア (金属+ハザードストライプ)
  {
    const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
    g.fillStyle = wc.doorFrame; g.fillRect(0, 0, TEX, TEX);
    g.fillStyle = wc.doorPanel; g.fillRect(4, 2, 56, 60);
    g.fillStyle = wc.doorSeam; g.fillRect(30, 2, 4, 60);
    // ハザードストライプ
    for (let i = -2; i < 10; i++) {
      g.fillStyle = wc.doorStripe;
      g.save();
      g.beginPath(); g.rect(0, 50, TEX, 10); g.clip();
      g.translate(i * 14, 0); g.rotate(0);
      g.beginPath();
      g.moveTo(0, 60); g.lineTo(8, 50); g.lineTo(14, 50); g.lineTo(6, 60);
      g.closePath(); g.fill();
      g.restore();
    }
    g.fillStyle = wc.doorKick; g.fillRect(0, 48, TEX, 2);
    addNoise(g, 0.1);
    textures['D'] = { lit: c, dark: darken(c, ds) };
  }
  // 'X' 出口スイッチ
  {
    const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
    g.fillStyle = wc.exitPanel; g.fillRect(0, 0, TEX, TEX);
    g.fillStyle = wc.exitInner; g.fillRect(8, 8, 48, 48);
    g.fillStyle = wc.exitSlot; g.fillRect(22, 20, 20, 26);
    g.fillStyle = wc.exitLever; g.fillRect(26, 24, 12, 8); // レバー
    g.fillStyle = wc.exitBase; g.fillRect(26, 34, 12, 8);
    g.fillStyle = wc.exitText;
    g.font = 'bold 11px monospace';
    g.fillText(wc.exitLabel, 19, 16);
    g.fillStyle = wc.exitLever; g.fillRect(10, 58, 44, 3);
    textures['X'] = { lit: c, dark: darken(c, ds) };
  }
  // 'R'/'B' ロックドア (ドアに色帯を重ねる)
  for (const [ch, color] of [['R', wc.lockRed], ['B', wc.lockBlue]]) {
    const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
    g.drawImage(textures['D'].lit, 0, 0);
    g.fillStyle = color;
    g.fillRect(4, 8, 56, 7);
    g.fillRect(4, 38, 56, 7);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(4, 8, 56, 2); g.fillRect(4, 38, 56, 2);
    textures[ch] = { lit: c, dark: darken(c, ds) };
  }
  // '*' 隠し扉: 見た目は完全にレンガ壁と同じ
  textures['*'] = textures['#'];
}

// ======================= 4. スプライト描画 =======================
// 敵・アイテムは64x64キャンバスに手続き描画した「フレーム」を使い回す。
// アイテムは下半分に描いて床置きに見せる。
const sprites = {}; // sprites.zombie = [frame,...] など

// 4pxグリッドのドット絵ヘルパー
function px(g, x, y, w, h, color) {
  g.fillStyle = color;
  g.fillRect(x * 4, y * 4, w * 4, h * 4);
}

function drawZombieFrame(pose) {
  // pose: 'walk0','walk1','aim','pain','dead0','dead1','dead2'
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  const skin = pose === 'pain' ? '#e0c0a0' : '#9aa86a';
  const armor = pose === 'pain' ? '#b0b0b0' : '#5a6a4a';
  const dark = '#3a4632';
  if (pose.startsWith('dead')) {
    const stage = +pose.slice(4);
    if (stage === 0) { // 仰け反り
      px(g, 5, 6, 6, 3, skin);
      px(g, 4, 9, 8, 4, armor);
      px(g, 4, 13, 3, 3, dark); px(g, 9, 13, 3, 3, dark);
      g.fillStyle = '#a02020'; g.fillRect(24, 36, 16, 8);
    } else if (stage === 1) { // 崩れ
      px(g, 4, 10, 8, 3, skin);
      px(g, 3, 12, 10, 3, armor);
      g.fillStyle = '#a02020'; g.fillRect(16, 48, 32, 8);
    } else { // 死体
      g.fillStyle = '#701818'; g.fillRect(12, 56, 40, 6);
      px(g, 3, 13, 4, 2, skin);
      px(g, 6, 13, 7, 2, armor);
    }
    return c;
  }
  const legShift = pose === 'walk1' ? 1 : 0;
  // 脚
  px(g, 6 - legShift, 13, 2, 3, dark);
  px(g, 9 + legShift, 13, 2, 3, dark);
  // 胴体(アーマー)
  px(g, 5, 8, 6, 5, armor);
  // 腕+ライフル
  if (pose === 'aim') {
    px(g, 4, 9, 8, 1, dark);             // 両腕前へ
    px(g, 10, 8, 4, 1, '#222');          // 銃身
    px(g, 13, 8, 1, 1, '#ffd040');       // マズルフラッシュ
  } else {
    px(g, 4, 9, 1, 3, armor);
    px(g, 11, 9, 1, 3, armor);
    px(g, 10, 10, 3, 1, '#222');
  }
  // 頭
  px(g, 6, 4, 4, 4, skin);
  px(g, 6, 5, 1, 1, '#c02020'); px(g, 9, 5, 1, 1, '#c02020'); // 赤目
  px(g, 6, 4, 4, 1, dark); // ヘルメット
  return c;
}

function drawImpFrame(pose) {
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  const skin = pose === 'pain' ? '#e8b890' : '#a55a2a';
  const dark = pose === 'pain' ? '#c09060' : '#7a3c1a';
  if (pose.startsWith('dead')) {
    const stage = +pose.slice(4);
    if (stage === 0) {
      px(g, 4, 7, 8, 4, skin);
      px(g, 5, 5, 6, 3, dark);
      g.fillStyle = '#a02020'; g.fillRect(20, 40, 24, 8);
    } else if (stage === 1) {
      px(g, 4, 11, 8, 3, skin);
      g.fillStyle = '#801818'; g.fillRect(14, 50, 36, 8);
    } else {
      g.fillStyle = '#701818'; g.fillRect(10, 56, 44, 6);
      px(g, 4, 13, 8, 2, dark);
    }
    return c;
  }
  const legShift = pose === 'walk1' ? 1 : 0;
  // 脚(太め)
  px(g, 5 - legShift, 12, 2, 4, dark);
  px(g, 9 + legShift, 12, 2, 4, dark);
  // 胴体
  px(g, 4, 7, 8, 5, skin);
  px(g, 5, 8, 6, 3, dark); // 腹の影
  // 腕
  if (pose === 'attack') {
    px(g, 2, 4, 2, 4, skin);   // 振り上げた腕
    px(g, 12, 9, 2, 3, skin);
    // 火球
    g.fillStyle = '#ff8820'; g.beginPath(); g.arc(10, 22, 7, 0, 7); g.fill();
    g.fillStyle = '#ffd040'; g.beginPath(); g.arc(10, 22, 4, 0, 7); g.fill();
  } else {
    px(g, 2, 8, 2, 4, skin);
    px(g, 12, 8, 2, 4, skin);
    // 爪
    px(g, 2, 12, 2, 1, '#e8e8d0');
    px(g, 12, 12, 2, 1, '#e8e8d0');
  }
  // 頭+角
  px(g, 5, 3, 6, 4, skin);
  px(g, 4, 1, 1, 2, '#e8e8d0'); px(g, 11, 1, 1, 2, '#e8e8d0'); // 角
  px(g, 6, 4, 1, 1, '#ffe040'); px(g, 9, 4, 1, 1, '#ffe040'); // 黄目
  px(g, 6, 6, 4, 1, '#601010'); // 口
  return c;
}

function drawSergeantFrame(pose) {
  // 散弾兵: 黒アーマー+赤ベレー
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  const skin = pose === 'pain' ? '#f0d0b0' : '#c8a070';
  const armor = pose === 'pain' ? '#909098' : '#33333c';
  const dark = '#202026';
  if (pose.startsWith('dead')) {
    const stage = +pose.slice(4);
    if (stage === 0) {
      px(g, 5, 6, 6, 3, skin);
      px(g, 4, 9, 8, 4, armor);
      g.fillStyle = '#a02020'; g.fillRect(24, 36, 16, 8);
    } else if (stage === 1) {
      px(g, 4, 10, 8, 3, skin);
      px(g, 3, 12, 10, 3, armor);
      g.fillStyle = '#a02020'; g.fillRect(16, 48, 32, 8);
    } else {
      g.fillStyle = '#701818'; g.fillRect(12, 56, 40, 6);
      px(g, 3, 13, 4, 2, skin);
      px(g, 6, 13, 7, 2, armor);
    }
    return c;
  }
  const legShift = pose === 'walk1' ? 1 : 0;
  px(g, 6 - legShift, 13, 2, 3, dark);
  px(g, 9 + legShift, 13, 2, 3, dark);
  px(g, 5, 8, 6, 5, armor);
  if (pose === 'aim') {
    px(g, 4, 9, 8, 1, dark);
    px(g, 10, 8, 4, 2, '#3a3a3a');           // 太い銃身(ショットガン)
    px(g, 14, 8, 1, 2, '#ffd040');           // マズルフラッシュ
  } else {
    px(g, 4, 9, 1, 3, armor);
    px(g, 11, 9, 1, 3, armor);
    px(g, 9, 10, 4, 2, '#3a3a3a');
  }
  px(g, 6, 4, 4, 4, skin);
  px(g, 6, 5, 1, 1, '#ffffff'); px(g, 9, 5, 1, 1, '#ffffff'); // 白目
  px(g, 6, 4, 4, 1, '#a02828'); px(g, 9, 3, 2, 1, '#a02828'); // 赤ベレー
  return c;
}

function drawDemonFrame(pose) {
  // 牙獣: ずんぐりしたピンクの近接モンスター
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  const skin = pose === 'pain' ? '#f0c0c0' : '#c06058';
  const dark = pose === 'pain' ? '#c89898' : '#8a3c38';
  if (pose.startsWith('dead')) {
    const stage = +pose.slice(4);
    if (stage === 0) {
      px(g, 3, 8, 10, 5, skin);
      px(g, 4, 6, 8, 3, dark);
      g.fillStyle = '#a02020'; g.fillRect(16, 36, 32, 10);
    } else if (stage === 1) {
      px(g, 3, 11, 10, 3, skin);
      g.fillStyle = '#801818'; g.fillRect(12, 48, 40, 10);
    } else {
      g.fillStyle = '#701818'; g.fillRect(8, 56, 48, 6);
      px(g, 3, 13, 10, 2, dark);
    }
    return c;
  }
  const legShift = pose === 'walk1' ? 1 : 0;
  // 太い脚
  px(g, 4 - legShift, 12, 3, 4, dark);
  px(g, 9 + legShift, 12, 3, 4, dark);
  // どっしりした胴体(頭と一体)
  px(g, 3, 4, 10, 8, skin);
  px(g, 2, 6, 1, 4, skin); px(g, 13, 6, 1, 4, skin); // 肩
  // 目
  px(g, 5, 5, 1, 1, '#40e040'); px(g, 10, 5, 1, 1, '#40e040');
  if (pose === 'attack') {
    // 大口を開けて噛みつく
    px(g, 4, 8, 8, 4, '#501010');
    px(g, 4, 8, 1, 1, '#fff'); px(g, 6, 8, 1, 1, '#fff'); px(g, 8, 8, 1, 1, '#fff'); px(g, 10, 8, 1, 1, '#fff');
    px(g, 5, 11, 1, 1, '#fff'); px(g, 7, 11, 1, 1, '#fff'); px(g, 9, 11, 1, 1, '#fff');
  } else {
    // 閉じた口に牙
    px(g, 4, 9, 8, 2, dark);
    px(g, 5, 9, 1, 1, '#fff'); px(g, 8, 9, 1, 1, '#fff'); px(g, 10, 9, 1, 1, '#fff');
  }
  return c;
}

function drawKnightFrame(pose) {
  // 獄騎士: 背の高い緑褐色の上位種
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  const skin = pose === 'pain' ? '#e8e0c0' : '#8a9060';
  const dark = pose === 'pain' ? '#b8b090' : '#5c6240';
  if (pose.startsWith('dead')) {
    const stage = +pose.slice(4);
    if (stage === 0) {
      px(g, 4, 5, 8, 6, skin);
      px(g, 5, 3, 6, 3, dark);
      g.fillStyle = '#308030'; g.fillRect(20, 32, 24, 10); // 緑の血
    } else if (stage === 1) {
      px(g, 4, 10, 8, 4, skin);
      g.fillStyle = '#206020'; g.fillRect(14, 44, 36, 12);
    } else {
      g.fillStyle = '#1a501a'; g.fillRect(8, 56, 48, 6);
      px(g, 3, 13, 9, 2, dark);
    }
    return c;
  }
  const legShift = pose === 'walk1' ? 1 : 0;
  // 脚 (長い)
  px(g, 5 - legShift, 11, 2, 5, dark);
  px(g, 9 + legShift, 11, 2, 5, dark);
  // 胴体 (縦長)
  px(g, 4, 4, 8, 7, skin);
  px(g, 5, 6, 6, 3, dark); // 胸の影
  // 腕
  if (pose === 'attack') {
    px(g, 2, 1, 2, 4, skin);   // 振り上げ
    px(g, 12, 7, 2, 3, skin);
    g.fillStyle = '#30c040'; g.beginPath(); g.arc(10, 14, 7, 0, 7); g.fill();
    g.fillStyle = '#a0ffa0'; g.beginPath(); g.arc(10, 14, 4, 0, 7); g.fill();
  } else {
    px(g, 2, 5, 2, 5, skin);
    px(g, 12, 5, 2, 5, skin);
    px(g, 2, 10, 2, 1, '#e8e8d0');
    px(g, 12, 10, 2, 1, '#e8e8d0');
  }
  // 頭+大きな角
  px(g, 5, 1, 6, 3, skin);
  px(g, 3, 0, 2, 2, '#e8e8d0'); px(g, 11, 0, 2, 2, '#e8e8d0'); // 巨大な角
  px(g, 6, 2, 1, 1, '#ff4040'); px(g, 9, 2, 1, 1, '#ff4040');  // 赤目
  return c;
}

function drawItemFrame(kind) {
  // 下半分に描いて床置きに見せる
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  switch (kind) {
    case 'stim': // 小さい注射器ぽい箱
      px(g, 6, 12, 4, 3, '#d8d8e0');
      px(g, 7, 12, 2, 3, '#c03030');
      break;
    case 'medkit':
      px(g, 5, 11, 6, 4, '#d8d8e0');
      px(g, 7, 11, 2, 4, '#c03030');
      px(g, 5, 12, 6, 1, '#c03030');
      break;
    case 'clip':
      px(g, 7, 13, 2, 2, '#8a7430');
      px(g, 7, 12, 2, 1, '#c0a040');
      break;
    case 'ammoBox':
      px(g, 5, 12, 6, 3, '#5a5a3a');
      px(g, 6, 11, 4, 1, '#c0a040');
      g.fillStyle = '#d0d0a0'; g.font = 'bold 8px monospace'; g.fillText('AMMO', 22, 58);
      break;
    case 'shells':
      px(g, 6, 13, 1, 2, '#c04020'); px(g, 8, 13, 1, 2, '#c04020'); px(g, 10, 13, 1, 2, '#c04020');
      px(g, 6, 12, 5, 1, '#c0a040');
      break;
    case 'shotgunPickup':
      px(g, 4, 12, 8, 1, '#3a3a3a'); // 銃身
      px(g, 10, 13, 3, 1, '#6a4a2a'); // ストック
      px(g, 5, 13, 3, 1, '#6a4a2a'); // フォアエンド
      break;
    case 'redcard':
    case 'bluecard': {
      const col = kind === 'redcard' ? '#e03030' : '#3050e0';
      px(g, 6, 11, 4, 3, col);
      px(g, 6, 11, 4, 1, '#e8e8e8');  // 白帯
      px(g, 9, 13, 1, 1, '#181818');  // チップ
      break;
    }
    case 'armorShard': // 緑の小さな破片
      px(g, 7, 12, 2, 3, '#30b030');
      px(g, 7, 12, 2, 1, '#90e890');
      break;
    case 'armorVest': { // 青いボディアーマー(盾型の胸当て)
      px(g, 5, 11, 6, 4, '#2a5ab0');
      px(g, 4, 11, 1, 2, '#2a5ab0'); px(g, 11, 11, 1, 2, '#2a5ab0'); // 肩
      px(g, 5, 11, 6, 1, '#90b8ff');  // ハイライト
      px(g, 7, 12, 2, 2, '#4a8ae0');  // 中央パネル
      px(g, 6, 14, 4, 1, '#1a3a78');  // 裾
      break;
    }
  }
  return c;
}

function drawFireballFrame(phase, colors) {
  const [outer, mid, core] = colors;
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  const r = phase === 0 ? 10 : 12;
  g.fillStyle = outer; g.beginPath(); g.arc(32, 32, r + 4, 0, 7); g.fill();
  g.fillStyle = mid; g.beginPath(); g.arc(32, 32, r, 0, 7); g.fill();
  g.fillStyle = core; g.beginPath(); g.arc(32, 32, r - 5, 0, 7); g.fill();
  return c;
}

function drawPuffFrame(stage, [outerRGB, coreRGB]) {
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  const r = 6 + stage * 7;
  const alpha = 0.9 - stage * 0.28;
  g.fillStyle = `rgba(${outerRGB},${alpha})`;
  g.beginPath(); g.arc(32, 32, r, 0, 7); g.fill();
  g.fillStyle = `rgba(${coreRGB},${alpha})`;
  g.beginPath(); g.arc(32, 32, r * 0.55, 0, 7); g.fill();
  return c;
}

// ---- ほのぼの(パステル)モードのキャラクター ----
// 同じ敵タイプ(zombie/sergeant/imp/demon/knight)を、ほのぼの系の動物に置き換える。
// ポーズは hell版と同じ ('walk0','walk1','aim'/'attack','pain','dead0..2')。
// 倒れた時は流血ではなく「目をまわして気絶 → ぺたんと寝る」表現にする。

function drawKittenFrame(pose) { // zombie枠: 水でっぽうの子ねこ
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  const fur = pose === 'pain' ? '#ffe2ee' : '#fbfbff';
  const ear = '#ffc4d8';
  if (pose.startsWith('dead')) {
    const stage = +pose.slice(4);
    if (stage === 0) {
      px(g, 5, 5, 6, 6, fur);
      px(g, 6, 7, 1, 1, '#88607a'); px(g, 9, 7, 1, 1, '#88607a');
    } else if (stage === 1) {
      px(g, 4, 11, 8, 3, fur); px(g, 3, 13, 10, 2, fur);
    } else {
      px(g, 3, 13, 10, 2, fur); px(g, 4, 12, 8, 1, ear);
    }
    return c;
  }
  const legShift = pose === 'walk1' ? 1 : 0;
  px(g, 12, 10, 2, 1, fur); px(g, 13, 8, 1, 2, fur); // しっぽ
  px(g, 6 - legShift, 13, 2, 3, fur);
  px(g, 9 + legShift, 13, 2, 3, fur);
  px(g, 5, 8, 6, 5, fur);
  if (pose === 'aim') {
    px(g, 4, 9, 7, 1, fur);
    px(g, 10, 9, 4, 1, '#9bd0e8'); // 水でっぽう
    px(g, 13, 9, 1, 1, '#cdeffb'); // しずく
  } else {
    px(g, 4, 9, 1, 3, fur);
    px(g, 11, 9, 1, 3, fur);
  }
  px(g, 5, 4, 6, 4, fur);
  px(g, 5, 3, 1, 1, fur); px(g, 4, 4, 1, 1, ear);    // 耳
  px(g, 10, 3, 1, 1, fur); px(g, 11, 4, 1, 1, ear);
  px(g, 6, 6, 1, 1, '#5a4a55'); px(g, 9, 6, 1, 1, '#5a4a55'); // 目
  px(g, 5, 6, 1, 1, ear); px(g, 10, 6, 1, 1, ear);            // ほっぺ
  px(g, 7, 7, 2, 1, '#ff9ab5');                                // 鼻
  return c;
}

function drawBearCubFrame(pose) { // sergeant枠: ベレー帽のくま
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  const fur = pose === 'pain' ? '#e8c8a8' : '#c89a6a';
  const dark = '#a67a4a';
  const beret = '#ef8a8a';
  if (pose.startsWith('dead')) {
    const stage = +pose.slice(4);
    if (stage === 0) { px(g, 4, 6, 8, 5, fur); px(g, 5, 5, 6, 2, beret); }
    else if (stage === 1) { px(g, 3, 11, 10, 3, fur); }
    else { px(g, 3, 13, 10, 2, fur); px(g, 4, 12, 8, 1, dark); }
    return c;
  }
  const legShift = pose === 'walk1' ? 1 : 0;
  px(g, 5 - legShift, 13, 3, 3, dark);
  px(g, 8 + legShift, 13, 3, 3, dark);
  px(g, 4, 8, 8, 5, fur);
  if (pose === 'aim') {
    px(g, 3, 9, 9, 1, fur);
    px(g, 11, 9, 4, 2, '#b0e0e8'); // おもちゃの2連発(水色)
    px(g, 14, 9, 1, 2, '#eafaff');
  } else {
    px(g, 3, 9, 1, 3, fur);
    px(g, 11, 9, 1, 3, fur);
  }
  px(g, 4, 4, 8, 4, fur);
  px(g, 3, 4, 1, 2, fur); px(g, 12, 4, 1, 2, fur); // 丸い耳
  px(g, 4, 3, 7, 1, beret); px(g, 5, 2, 4, 1, beret); // ベレー帽
  px(g, 6, 6, 1, 1, '#4a3a2a'); px(g, 9, 6, 1, 1, '#4a3a2a');
  px(g, 7, 7, 2, 1, '#4a3a2a'); // 鼻
  return c;
}

function drawBunnyFrame(pose) { // imp枠: シャボン玉を投げるうさぎ
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  const fur = pose === 'pain' ? '#ffe6f0' : '#f8d4e2';
  const ear = '#f3aecb';
  if (pose.startsWith('dead')) {
    const stage = +pose.slice(4);
    if (stage === 0) { px(g, 5, 6, 6, 5, fur); px(g, 5, 3, 1, 3, fur); px(g, 10, 3, 1, 3, fur); }
    else if (stage === 1) { px(g, 4, 11, 8, 3, fur); }
    else { px(g, 3, 13, 10, 2, fur); }
    return c;
  }
  const legShift = pose === 'walk1' ? 1 : 0;
  px(g, 6 - legShift, 13, 2, 3, fur);
  px(g, 9 + legShift, 13, 2, 3, fur);
  px(g, 5, 8, 6, 5, fur);
  if (pose === 'attack') {
    px(g, 3, 5, 2, 4, fur);   // 振り上げた手
    px(g, 11, 9, 2, 3, fur);
    g.fillStyle = '#aadcf0'; g.beginPath(); g.arc(44, 24, 8, 0, 7); g.fill(); // シャボン玉
    g.fillStyle = '#e8f7ff'; g.beginPath(); g.arc(42, 22, 3, 0, 7); g.fill();
  } else {
    px(g, 4, 9, 2, 3, fur);
    px(g, 10, 9, 2, 3, fur);
  }
  px(g, 5, 5, 6, 4, fur);
  px(g, 5, 1, 2, 4, fur); px(g, 9, 1, 2, 4, fur);   // 長い耳
  px(g, 5, 2, 1, 2, ear); px(g, 10, 2, 1, 2, ear);
  px(g, 6, 6, 1, 1, '#7a5a6a'); px(g, 9, 6, 1, 1, '#7a5a6a');
  px(g, 5, 7, 1, 1, ear); px(g, 10, 7, 1, 1, ear);  // ほっぺ
  px(g, 7, 7, 2, 1, '#ff8ab0');
  return c;
}

function drawPiggyFrame(pose) { // demon枠: 突進するまんまるブタ
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  const skin = pose === 'pain' ? '#ffd0dc' : '#ffb0c4';
  const dark = '#ef8aa6';
  if (pose.startsWith('dead')) {
    const stage = +pose.slice(4);
    if (stage === 0) { px(g, 3, 7, 10, 5, skin); }
    else if (stage === 1) { px(g, 3, 11, 10, 3, skin); }
    else { px(g, 3, 13, 10, 2, skin); }
    return c;
  }
  const legShift = pose === 'walk1' ? 1 : 0;
  px(g, 4 - legShift, 12, 3, 4, dark);
  px(g, 9 + legShift, 12, 3, 4, dark);
  px(g, 3, 4, 10, 8, skin);
  px(g, 2, 6, 1, 4, skin); px(g, 13, 6, 1, 4, skin);
  px(g, 3, 3, 2, 2, dark); px(g, 11, 3, 2, 2, dark); // 耳
  px(g, 5, 5, 1, 1, '#6a4a55'); px(g, 10, 5, 1, 1, '#6a4a55');
  if (pose === 'attack') {
    px(g, 4, 8, 8, 4, '#d86a86'); // 大きな口(はむっ)
    px(g, 5, 8, 1, 1, '#fff'); px(g, 8, 8, 1, 1, '#fff'); px(g, 10, 8, 1, 1, '#fff');
  } else {
    px(g, 6, 8, 4, 2, dark); // ブタ鼻
    px(g, 7, 8, 1, 2, '#c86a86'); px(g, 8, 8, 1, 2, '#c86a86');
  }
  return c;
}

function drawBigBearFrame(pose) { // knight枠: ハートを投げる大きなくま(ボス)
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  const fur = pose === 'pain' ? '#e6dcf5' : '#bca8e0';
  const dark = '#9a86c0';
  if (pose.startsWith('dead')) {
    const stage = +pose.slice(4);
    if (stage === 0) { px(g, 4, 5, 8, 6, fur); px(g, 3, 4, 1, 2, fur); px(g, 12, 4, 1, 2, fur); }
    else if (stage === 1) { px(g, 4, 10, 8, 4, fur); }
    else { px(g, 3, 13, 9, 2, fur); }
    return c;
  }
  const legShift = pose === 'walk1' ? 1 : 0;
  px(g, 5 - legShift, 11, 3, 5, dark);
  px(g, 8 + legShift, 11, 3, 5, dark);
  px(g, 4, 4, 8, 7, fur);
  px(g, 5, 6, 6, 3, dark); // おなかの模様
  if (pose === 'attack') {
    px(g, 2, 1, 2, 4, fur);
    px(g, 12, 7, 2, 3, fur);
    g.fillStyle = '#7fd6a0'; // 大きなハート
    g.beginPath(); g.arc(38, 13, 5, 0, 7); g.arc(48, 13, 5, 0, 7);
    g.moveTo(33, 15); g.lineTo(43, 26); g.lineTo(53, 15); g.closePath(); g.fill();
    g.fillStyle = '#d6f5e2'; g.fillRect(40, 12, 3, 3);
  } else {
    px(g, 2, 5, 2, 5, fur);
    px(g, 12, 5, 2, 5, fur);
  }
  px(g, 4, 1, 8, 4, fur);
  px(g, 3, 1, 1, 2, fur); px(g, 12, 1, 1, 2, fur); // 丸耳
  px(g, 6, 2, 1, 1, '#5a4a6a'); px(g, 9, 2, 1, 1, '#5a4a6a');
  px(g, 7, 3, 2, 1, '#5a4a6a');
  return c;
}

function drawWispFrame(pose) { // floater枠(ホラー): 浮遊する紫の亡霊・目玉
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  const body = pose === 'pain' ? '#d8c0f0' : '#7a4ab0';
  const dark = '#4a2a78';
  if (pose.startsWith('dead')) {
    const stage = +pose.slice(4);
    const r = [12, 8, 4][stage];
    g.fillStyle = dark; g.beginPath(); g.arc(32, 30, r, 0, 7); g.fill(); // しぼんで消える
    return c;
  }
  const sway = pose === 'walk1' ? 2 : -2;
  // 触手(下)
  g.fillStyle = dark;
  for (let i = 0; i < 4; i++) g.fillRect(18 + i * 8, 40, 4, 12 + ((i % 2) ? sway : -sway));
  // 本体(球)
  g.fillStyle = body; g.beginPath(); g.arc(32, 28, 15, 0, 7); g.fill();
  g.fillStyle = dark; g.beginPath(); g.arc(32, 34, 12, 0, 7); g.fill(); // 下半分の影
  // 目
  if (pose === 'attack') {
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(32, 26, 9, 0, 7); g.fill();
    g.fillStyle = '#c02020'; g.beginPath(); g.arc(32, 26, 5, 0, 7); g.fill(); // 怒りの赤目
  } else {
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(32, 26, 7, 0, 7); g.fill();
    g.fillStyle = '#202020'; g.beginPath(); g.arc(32, 26, 3, 0, 7); g.fill();
  }
  return c;
}

function drawBalloonFrame(pose) { // floater枠(ほのぼの): 顔つきのふわふわ風船
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  const body = pose === 'pain' ? '#ffe0ec' : '#ff9ec4';
  if (pose.startsWith('dead')) {
    const stage = +pose.slice(4);
    const r = [11, 7, 3][stage];
    g.fillStyle = '#ffc0d8'; g.beginPath(); g.arc(32, 30, r, 0, 7); g.fill();
    return c;
  }
  // 紐
  g.strokeStyle = '#c89ab0'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(32, 42); g.lineTo(pose === 'walk1' ? 34 : 30, 56); g.stroke();
  // 風船
  g.fillStyle = body; g.beginPath(); g.arc(32, 26, 16, 0, 7); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.5)'; g.beginPath(); g.arc(27, 20, 4, 0, 7); g.fill(); // ハイライト
  // 結び目
  g.fillStyle = body; g.beginPath(); g.moveTo(28, 41); g.lineTo(36, 41); g.lineTo(32, 46); g.closePath(); g.fill();
  // 顔
  g.fillStyle = '#6a4a55';
  g.fillRect(26, 24, 2, 2); g.fillRect(36, 24, 2, 2);
  if (pose === 'attack') { g.beginPath(); g.arc(32, 30, 3, 0, 7); g.fill(); }
  else g.fillRect(30, 30, 4, 2);
  g.fillStyle = '#ff7aa0'; g.fillRect(24, 28, 2, 2); g.fillRect(38, 28, 2, 2); // ほっぺ
  return c;
}

function drawDrumFrame() { // 爆発樽(ホラー): 危険マーク付きの赤いドラム缶。下半分に接地
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  g.fillStyle = '#a02828'; g.fillRect(20, 30, 24, 30);   // 胴
  g.fillStyle = '#c03434'; g.fillRect(22, 30, 20, 30);
  g.fillStyle = '#7a1c1c'; g.fillRect(20, 30, 24, 2); g.fillRect(20, 44, 24, 2); g.fillRect(20, 58, 24, 2); // 帯
  g.fillStyle = '#e8c020'; g.font = 'bold 9px monospace'; g.fillText('!', 30, 42); // 危険
  g.fillStyle = '#1a1a1a'; g.fillRect(26, 47, 12, 8);    // ハザード窓
  g.fillStyle = '#e8c020';
  for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(26 + i * 5, 55); g.lineTo(30 + i * 5, 47); g.lineTo(33 + i * 5, 47); g.lineTo(29 + i * 5, 55); g.closePath(); g.fill(); }
  return c;
}

function drawGiftFrame() { // 爆発樽(ほのぼの): リボン付きプレゼント箱(中身は…?)
  const c = makeCanvas(TEX, TEX), g = c.getContext('2d');
  g.fillStyle = '#9be0c4'; g.fillRect(20, 34, 24, 26);   // 箱
  g.fillStyle = '#b8eed8'; g.fillRect(22, 34, 20, 26);
  g.fillStyle = '#ff9ec4'; g.fillRect(30, 34, 4, 26);    // 縦リボン
  g.fillStyle = '#ff9ec4'; g.fillRect(20, 40, 24, 4);    // 横リボン
  g.fillStyle = '#ff7aa0';                                // 上のちょうちょ結び
  g.beginPath(); g.arc(28, 33, 4, 0, 7); g.arc(36, 33, 4, 0, 7); g.fill();
  g.fillStyle = '#ffd0e0'; g.fillRect(30, 31, 4, 4);
  return c;
}

// テーマごとの敵スプライト描画関数。[walk/pain/dead用関数, 攻撃ポーズ名]
const SPRITE_BUILDERS = {
  hell: {
    zombie: [drawZombieFrame, 'aim'], sergeant: [drawSergeantFrame, 'aim'],
    imp: [drawImpFrame, 'attack'], demon: [drawDemonFrame, 'attack'],
    knight: [drawKnightFrame, 'attack'], floater: [drawWispFrame, 'attack'],
  },
  pastel: {
    zombie: [drawKittenFrame, 'aim'], sergeant: [drawBearCubFrame, 'aim'],
    imp: [drawBunnyFrame, 'attack'], demon: [drawPiggyFrame, 'attack'],
    knight: [drawBigBearFrame, 'attack'], floater: [drawBalloonFrame, 'attack'],
  },
};

function makeMonsterSet(drawFn, attackPose) {
  return {
    walk: [drawFn('walk0'), drawFn('walk1')],
    aim: drawFn(attackPose),
    pain: drawFn('pain'),
    dead: [drawFn('dead0'), drawFn('dead1'), drawFn('dead2')],
  };
}

function buildSprites() {
  const B = SPRITE_BUILDERS[currentTheme];
  for (const type in B) sprites[type] = makeMonsterSet(B[type][0], B[type][1]);
  sprites.items = {
    stim: drawItemFrame('stim'),
    medkit: drawItemFrame('medkit'),
    clip: drawItemFrame('clip'),
    ammoBox: drawItemFrame('ammoBox'),
    shells: drawItemFrame('shells'),
    shotgunPickup: drawItemFrame('shotgunPickup'),
    redcard: drawItemFrame('redcard'),
    bluecard: drawItemFrame('bluecard'),
    armorShard: drawItemFrame('armorShard'),
    armorVest: drawItemFrame('armorVest'),
  };
  sprites.barrel = currentTheme === 'pastel' ? drawGiftFrame() : drawDrumFrame();
  const fx = TH.fx;
  sprites.fireball = [drawFireballFrame(0, fx.fireball), drawFireballFrame(1, fx.fireball)];
  sprites.greenball = [drawFireballFrame(0, fx.greenball), drawFireballFrame(1, fx.greenball)];
  sprites.puff = {
    boom: [0, 1, 2].map(i => drawPuffFrame(i, fx.boom)),
    blood: [0, 1, 2].map(i => drawPuffFrame(i, fx.blood)),
    tele: [0, 1, 2].map(i => drawPuffFrame(i, fx.tele)),
  };
}

// ======================= 5. レベルロード =======================
// 敵の種類ごとのパラメータ。新しい敵はここに足す。
// attack.kind: 'hitscan'(単発射撃) / 'pellets'(散弾) / 'projectile'(弾を投げる) / 'melee'(噛みつき)
const ENEMY_TYPES = {
  zombie: {
    hp: 30, speed: 1.7, attackRange: 8, attackCooldown: 1.6, stopDist: 1.6,
    painChance: 0.7, sightRange: 12, scoreName: '亡兵',
    attack: { kind: 'hitscan', dmg: [3, 10], hitBase: 0.55 },
  },
  sergeant: {
    hp: 45, speed: 2.0, attackRange: 7, attackCooldown: 2.0, stopDist: 1.6,
    painChance: 0.6, sightRange: 12, scoreName: '散弾兵',
    attack: { kind: 'pellets', count: 3, dmg: [3, 8], hitBase: 0.5 },
    drops: 's', // 死ぬとシェルを落とす
  },
  imp: {
    hp: 60, speed: 2.1, attackRange: 9, attackCooldown: 2.2, stopDist: 1.2,
    painChance: 0.5, sightRange: 13, scoreName: '焔鬼',
    attack: { kind: 'projectile', speed: 6.5, dmg: [9, 17], sprite: 'fireball' },
  },
  demon: {
    hp: 110, speed: 3.6, attackRange: 1.35, attackCooldown: 1.0, stopDist: 1.0,
    painChance: 0.45, sightRange: 13, scoreName: '牙獣',
    attack: { kind: 'melee', dmg: [8, 22] },
  },
  knight: {
    hp: 220, speed: 2.0, attackRange: 11, attackCooldown: 1.7, stopDist: 1.3,
    painChance: 0.25, sightRange: 14, scoreName: '獄騎士', scale: 1.15,
    attack: { kind: 'projectile', speed: 9, dmg: [14, 26], sprite: 'greenball' },
  },
  // 飛行する敵: 床に追従せず空中を漂い、遠距離から撃ち下ろす。配置タイルの高さ+1を基準に浮く
  floater: {
    hp: 80, speed: 1.6, attackRange: 12, attackCooldown: 2.0, stopDist: 5.5,
    painChance: 0.4, sightRange: 15, scoreName: '漂霊',
    fly: true, hoverBase: 1.0,
    attack: { kind: 'projectile', speed: 7, dmg: [8, 16], sprite: 'fireball' },
  },
};

// マップ文字 → [敵タイプ, 休眠か] (小文字はトリガーで出現するアンブッシュ敵)
const ENEMY_CHARS = {
  Z: ['zombie', false],   z: ['zombie', true],
  G: ['sergeant', false], g: ['sergeant', true],
  I: ['imp', false],      i: ['imp', true],
  M: ['demon', false],    m: ['demon', true],
  K: ['knight', false],   k: ['knight', true],
  F: ['floater', false],  f: ['floater', true],
};

const ITEM_TYPES = {
  h: { sprite: 'stim',          msg: 'スティムパックを拾った (+10 HP)',  apply: p => p.health = Math.min(100, p.health + 10), need: p => p.health < 100 },
  H: { sprite: 'medkit',        msg: 'メディキットを拾った (+25 HP)',    apply: p => p.health = Math.min(100, p.health + 25), need: p => p.health < 100 },
  a: { sprite: 'clip',          msg: '弾倉を拾った (+10)',               apply: p => p.bullets = Math.min(200, p.bullets + 10), need: p => p.bullets < 200 },
  A: { sprite: 'ammoBox',       msg: '弾薬箱を拾った (+25)',             apply: p => p.bullets = Math.min(200, p.bullets + 25), need: p => p.bullets < 200 },
  s: { sprite: 'shells',        msg: 'シェルを拾った (+4)',              apply: p => p.shells = Math.min(50, p.shells + 4), need: p => p.shells < 50 },
  S: { sprite: 'shotgunPickup', msg: 'ショットガンを手に入れた!',       apply: p => { p.hasShotgun = true; p.shells = Math.min(50, p.shells + 8); p.weapon = 'shotgun'; Sound.weaponUp(); }, need: () => true },
  r: { sprite: 'redcard',       msg: '赤のキーカードを手に入れた!',     apply: p => { p.keys.red = true; Sound.weaponUp(); }, need: p => !p.keys.red },
  b: { sprite: 'bluecard',      msg: '青のキーカードを手に入れた!',     apply: p => { p.keys.blue = true; Sound.weaponUp(); }, need: p => !p.keys.blue },
  p: { sprite: 'armorShard',    msg: 'アーマーの破片 (+5)',             apply: p => p.armor = Math.min(ARMOR_MAX, p.armor + 5), need: p => p.armor < ARMOR_MAX },
  V: { sprite: 'armorVest',     msg: 'ボディアーマーを着た (+100)',     apply: p => { p.armor = Math.min(ARMOR_MAX, p.armor + 100); Sound.weaponUp(); }, need: p => p.armor < ARMOR_MAX },
};

let level = null; // 現在のレベル状態

function isWallChar(ch) {
  return ch === '#' || ch === '&' || ch === '=' || ch === 'X' || isDoorChar(ch);
}

// スライド開閉する壁(ドア・ロックドア・隠し扉)
function isDoorChar(ch) {
  return ch === 'D' || ch === 'R' || ch === 'B' || ch === '*';
}

function loadLevel(index) {
  const def = LEVELS[index];
  const rows = def.map;
  const w = rows[0].length;
  for (const r of rows) {
    if (r.length !== w) throw new Error(`マップの行の長さが不一致: ${def.name} -> "${r}"`);
  }
  // 高さレイヤー: '0'-'9' = 床の高さ(0.25タイル刻み)。省略時は全て0(平坦)
  const heights = [];
  for (let y = 0; y < rows.length; y++) {
    heights.push(new Float32Array(w));
    if (!def.heights) continue;
    const hr = def.heights[y];
    if (!hr || hr.length !== w) throw new Error(`高さレイヤーの行の長さが不一致: ${def.name} 行${y}`);
    for (let x = 0; x < w; x++) {
      const v = hr.charCodeAt(x) - 48;
      if (v >= 1 && v <= 9) heights[y][x] = v * 0.25;
    }
  }
  const grid = [];      // grid[y][x] = 壁文字 or null(床)
  const water = [];     // water[y][x] = 1 なら水路・池(通行不可・床より低い)
  const conv = [];      // conv[y][x] = [dx,dy] なら動く歩道(その方向へ流す)
  const lift = [];      // lift[y][x] = 1 なら上下するリフト床
  const barrelMask = [];// barrelMask[y][x] = 1 なら未破壊の樽がある(通行不可)
  const barrels = [];   // 爆発樽
  const doors = {};     // "x,y" -> {open: 0..1, opening: bool, found: bool}
  const enemies = [];
  const items = [];
  const triggers = [];  // アンブッシュトリガー
  let startX = 1.5, startY = 1.5;
  let totalSecrets = 0, hasLift = false;
  for (let y = 0; y < rows.length; y++) {
    grid.push([]);
    water.push(new Uint8Array(w));
    conv.push(new Array(w).fill(null));
    lift.push(new Uint8Array(w));
    barrelMask.push(new Uint8Array(w));
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      if (isWallChar(ch)) {
        grid[y][x] = ch;
        if (isDoorChar(ch)) doors[`${x},${y}`] = { open: 0, opening: false, found: false };
        if (ch === '*') totalSecrets++;
        continue;
      }
      grid[y][x] = null;
      const cx = x + 0.5, cy = y + 0.5;
      if (ch === '~') water[y][x] = 1;
      else if (CONV_CHARS[ch]) conv[y][x] = CONV_CHARS[ch];
      else if (ch === 'L') { lift[y][x] = 1; hasLift = true; }
      else if (ch === 'o') { barrelMask[y][x] = 1; barrels.push({ x: cx, y: cy, z: heights[y][x], mx: x, my: y, hp: BARREL_HP, dead: false }); }
      else if (ch === 'P') { startX = cx; startY = cy; }
      else if (ch === 'T') triggers.push({ x, y, used: false });
      else if (ENEMY_CHARS[ch]) {
        const [type, dormant] = ENEMY_CHARS[ch];
        const T = ENEMY_TYPES[type];
        const baseZ = T.fly ? heights[y][x] + T.hoverBase : heights[y][x];
        enemies.push({
          type, x: cx, y: cy, z: baseZ, hoverBase: baseZ, hp: T.hp, dormant,
          state: 'idle', stateT: 0, animT: Math.random() * 10,
          attackCd: 1 + Math.random(), dirX: 0, dirY: 0,
        });
      }
      else if (ITEM_TYPES[ch]) items.push({ kind: ch, x: cx, y: cy, z: heights[y][x], bob: Math.random() * 6 });
    }
  }
  // テーマがレベル色を持つ場合は天井/床/フォグを上書き(ほのぼのモードの空・芝など)
  const lc = TH.levelColor ? TH.levelColor(index) : null;
  const ceilColor = lc ? lc.ceil : def.ceilColor;
  const floorColor = lc ? lc.floor : def.floorColor;
  const fogColor = lc ? lc.fog : def.fogColor;
  level = {
    index, def, grid, w, h: rows.length, doors, enemies, items, triggers,
    water, conv, lift, hasLift, barrels, barrelMask, liftZ: LIFT_MIN,
    heights, ceilH: def.ceilHeight || 1, stepTex: def.stepTex || '=',
    ceilColor, floorColor, fogColor,
    floorRGB: hexToRGB(floorColor), shadeCache: {},
    projectiles: [], puffs: [],
    startX, startY,
    totalKills: enemies.length, kills: 0,
    totalItems: items.length, itemsGot: 0,
    totalSecrets, secretsFound: 0,
    time: 0,
  };
  player.keys = { red: false, blue: false }; // キーカードはステージ毎にリセット
  player.x = startX; player.y = startY;
  player.z = heights[startY | 0][startX | 0];
  player.pitch = 0;
  const [dx, dy] = def.startDir || [1, 0];
  player.dirX = dx; player.dirY = dy;
  player.planeX = -dy * FOV_PLANE; player.planeY = dx * FOV_PLANE;
  showMessage(def.name);
}

function cellAt(x, y) {
  if (y < 0 || y >= level.h || x < 0 || x >= level.w) return '#';
  return level.grid[y][x];
}

// 移動・弾にとってそのタイルが通れるか
function isSolid(x, y) {
  const ch = cellAt(x | 0, y | 0);
  if (ch === null) return false;
  if (isDoorChar(ch)) {
    const d = level.doors[`${x | 0},${y | 0}`];
    return d.open < 0.75;
  }
  return true;
}

// そのタイルの床の高さ(水路は床より低い窪み、リフトは時間で上下)
function floorHt(x, y) {
  if (y < 0 || y >= level.h || x < 0 || x >= level.w) return 0;
  if (level.water[y][x]) return WATER_DEPTH;
  if (level.lift[y][x]) return level.liftZ;
  return level.heights[y][x];
}

// ======================= 6. 入力 =======================
const keys = {};
let mouseDown = false;
let pointerLocked = false;

document.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyM', 'Tab'].includes(e.code)) e.preventDefault();
  handleKeyPress(e.code);
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

canvas.addEventListener('mousedown', e => {
  if (e.button === 0) {
    mouseDown = true;
    if (game.state === 'title') { startGame(); return; }
    if (game.state === 'playing' && !pointerLocked) canvas.requestPointerLock();
    if (game.state === 'dead') restartLevel();
    if (game.state === 'levelEnd') nextLevel();
    if (game.state === 'gameClear') { game.state = 'title'; }
  }
});
document.addEventListener('mouseup', e => { if (e.button === 0) mouseDown = false; });
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
});
document.addEventListener('mousemove', e => {
  if (pointerLocked && game.state === 'playing') {
    rotatePlayer(e.movementX * MOUSE_SENS);
    // 上下視点 (y-shearing)。上に動かすと見上げる
    player.pitch = clamp(player.pitch - e.movementY * 0.35, -PITCH_MAX, PITCH_MAX);
  }
});

function cycleTheme(dir) {
  const names = Object.keys(THEMES);
  const i = names.indexOf(currentTheme);
  applyTheme(names[(i + dir + names.length) % names.length]);
  Sound.switch_();
}

function handleKeyPress(code) {
  if (game.state === 'title' && (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'KeyT')) {
    cycleTheme(code === 'ArrowLeft' ? -1 : 1); return;
  }
  if (game.state === 'title' && (code === 'Space' || code === 'Enter')) { startGame(); return; }
  if (game.state === 'dead' && code === 'KeyR') { restartLevel(); return; }
  if (game.state === 'dead' && code === 'KeyQ') { game.state = 'title'; document.exitPointerLock(); return; }
  if (game.state === 'levelEnd' && (code === 'Space' || code === 'Enter')) { nextLevel(); return; }
  if (game.state === 'gameClear' && (code === 'Space' || code === 'Enter')) { game.state = 'title'; return; }
  if (game.state !== 'playing') return;
  if (code === 'KeyE') useAction();
  if (code === 'Digit1') switchWeapon('pistol');
  if (code === 'Digit2') switchWeapon('shotgun');
  if (code === 'Digit3') switchWeapon('knife');
  if (code === 'KeyM') game.showMap = !game.showMap;
  if (code === 'KeyP') { Sound.toggleMute(); showMessage(Sound.muted ? 'サウンド OFF' : 'サウンド ON'); }
}

// ======================= 7. プレイヤー・武器 =======================
const WEAPONS = {
  knife:   { name: 'ナイフ',     cooldown: 0.45, damage: [18, 32], melee: true, range: 1.3, halfWidth: 0.55, ammo: null, cost: 0 },
  pistol:  { name: 'ピストル',   cooldown: 0.38, damage: [10, 16], pellets: 1, spread: 0.012, ammo: 'bullets', cost: 1 },
  shotgun: { name: 'ショットガン', cooldown: 0.95, damage: [8, 13], pellets: 7, spread: 0.09, ammo: 'shells', cost: 1 },
};

const player = {
  x: 2, y: 2, z: 0,
  pitch: 0,                      // 上下視点 (画面pxシフト量)
  dirX: 1, dirY: 0,
  planeX: 0, planeY: FOV_PLANE,
  health: 100, armor: 0, bullets: 50, shells: 0,
  hasShotgun: false,
  keys: { red: false, blue: false },
  weapon: 'pistol',
  shootCd: 0,
  bobPhase: 0, bobAmount: 0,
  damageFlash: 0, pickupFlash: 0,
  muzzleT: 0,
};

function resetPlayerStats() {
  player.health = 100;
  player.armor = 0;
  player.bullets = 50;
  player.shells = 0;
  player.hasShotgun = false;
  player.weapon = 'pistol';
  player.shootCd = 0;
  player.pitch = 0;
  player.damageFlash = 0; player.pickupFlash = 0; player.muzzleT = 0;
}

function rotatePlayer(angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const odx = player.dirX;
  player.dirX = player.dirX * cos - player.dirY * sin;
  player.dirY = odx * sin + player.dirY * cos;
  const opx = player.planeX;
  player.planeX = player.planeX * cos - player.planeY * sin;
  player.planeY = opx * sin + player.planeY * cos;
}

// 高さも考慮した通行判定。maxDropを渡すとそれ以上の段差は降りない(敵用)
function passable(x, y, z, maxDrop) {
  if (isSolid(x, y)) return false;
  const ix = x | 0, iy = y | 0;
  if (level.water[iy] && level.water[iy][ix]) return false;     // 水路・池は通れない
  if (level.barrelMask[iy] && level.barrelMask[iy][ix]) return false; // 樽は障害物
  const fh = floorHt(ix, iy);
  if (fh - z > STEP_MAX) return false;                          // 高すぎて登れない
  if (maxDrop !== undefined && z - fh > maxDrop) return false;  // 敵は高所から飛び降りない
  return true;
}

// 半径つき移動(壁ずりスライド)
function tryMove(ent, dx, dy, radius, maxDrop) {
  const z = ent.z || 0;
  const nx = ent.x + dx;
  if (passable(nx + Math.sign(dx) * radius, ent.y - radius, z, maxDrop) &&
      passable(nx + Math.sign(dx) * radius, ent.y + radius, z, maxDrop)) {
    ent.x = nx;
  }
  const ny = ent.y + dy;
  if (passable(ent.x - radius, ny + Math.sign(dy) * radius, z, maxDrop) &&
      passable(ent.x + radius, ny + Math.sign(dy) * radius, z, maxDrop)) {
    ent.y = ny;
  }
}

// 飛行する敵の移動: 壁だけを避け、段差・水路・樽の上は自由に飛ぶ
function tryMoveFly(ent, dx, dy, radius) {
  const nx = ent.x + dx;
  if (!isSolid(nx + Math.sign(dx) * radius, ent.y - radius) &&
      !isSolid(nx + Math.sign(dx) * radius, ent.y + radius)) {
    ent.x = nx;
  }
  const ny = ent.y + dy;
  if (!isSolid(ent.x - radius, ny + Math.sign(dy) * radius) &&
      !isSolid(ent.x + radius, ny + Math.sign(dy) * radius)) {
    ent.y = ny;
  }
}

function updatePlayer(dt) {
  let mx = 0, my = 0;
  if (keys['KeyW']) { mx += player.dirX; my += player.dirY; }
  if (keys['KeyS']) { mx -= player.dirX; my -= player.dirY; }
  if (keys['KeyA']) { mx += player.dirY; my -= player.dirX; }
  if (keys['KeyD']) { mx -= player.dirY; my += player.dirX; }
  if (keys['ArrowUp']) { mx += player.dirX; my += player.dirY; }
  if (keys['ArrowDown']) { mx -= player.dirX; my -= player.dirY; }
  if (keys['ArrowLeft']) rotatePlayer(-ROT_SPEED * dt);
  if (keys['ArrowRight']) rotatePlayer(ROT_SPEED * dt);

  const len = Math.hypot(mx, my);
  if (len > 0.001) {
    const speed = MOVE_SPEED * dt / len;
    tryMove(player, mx * speed, my * speed, PLAYER_RADIUS);
    player.bobPhase += dt * 11;
    player.bobAmount = Math.min(1, player.bobAmount + dt * 6);
  } else {
    player.bobAmount = Math.max(0, player.bobAmount - dt * 6);
  }

  // 動く歩道: 乗っているタイルの方向へ流される
  const pConv = level.conv[player.y | 0] && level.conv[player.y | 0][player.x | 0];
  if (pConv) tryMove(player, pConv[0] * CONVEYOR_SPEED * dt, pConv[1] * CONVEYOR_SPEED * dt, PLAYER_RADIUS);

  // 段差の昇降: 上りはゆっくり登り、下りは素早く落ちる
  const ground = floorHt(player.x | 0, player.y | 0);
  if (ground > player.z) player.z = Math.min(ground, player.z + dt * 5);
  else player.z = Math.max(ground, player.z - dt * 14);

  player.shootCd = Math.max(0, player.shootCd - dt);
  player.muzzleT = Math.max(0, player.muzzleT - dt);
  player.damageFlash = Math.max(0, player.damageFlash - dt * 2.2);
  player.pickupFlash = Math.max(0, player.pickupFlash - dt * 3);

  if ((mouseDown && pointerLocked) || keys['Space']) tryShoot();

  // アンブッシュトリガー: 踏むと付近の休眠敵がテレポートしてくる
  for (const tr of level.triggers) {
    if (tr.used || (player.x | 0) !== tr.x || (player.y | 0) !== tr.y) continue;
    tr.used = true;
    let woke = 0;
    for (const e of level.enemies) {
      if (e.dormant && dist2(e.x, e.y, tr.x + 0.5, tr.y + 0.5) < 144) {
        e.dormant = false;
        setEnemyState(e, 'chase');
        spawnPuff(e.x, e.y, 'tele', e.z + 0.5);
        woke++;
      }
    }
    if (woke > 0) {
      Sound.teleport();
      showMessage('罠だ!');
    }
  }

  // アイテム回収
  for (let i = level.items.length - 1; i >= 0; i--) {
    const it = level.items[i];
    if (dist2(player.x, player.y, it.x, it.y) < 0.45 && Math.abs(it.z - player.z) < 0.9) {
      const def = ITEM_TYPES[it.kind];
      if (def.need(player)) {
        def.apply(player);
        showMessage(def.msg);
        Sound.pickup();
        player.pickupFlash = 0.5;
        level.items.splice(i, 1);
        if (!it.dropped) level.itemsGot++; // 敵のドロップ品は取得率に含めない
      }
    }
  }
}

// プレイヤーが敵をすり抜けないよう、重なりを解消して少し押し離す。
// 敵移動後に呼ぶ。高さが大きく違う敵(別フロア)とはぶつからない。
function resolvePlayerEnemyCollision() {
  for (const e of level.enemies) {
    if (e.state === 'dead' || e.dormant) continue;
    if (Math.abs(player.z - e.z) > 0.9) continue;
    const er = 0.32 * (ENEMY_TYPES[e.type].scale || 1);
    const minD = PLAYER_RADIUS + er;
    let dx = player.x - e.x, dy = player.y - e.y;
    let d = Math.hypot(dx, dy);
    if (d >= minD) continue;
    if (d < 1e-4) { dx = -player.dirX; dy = -player.dirY; d = 1; } // 完全重なりは後退方向へ
    const nx = dx / d, ny = dy / d;
    const push = (minD - d) + 0.06; // 重なり解消 + わずかな反発(張り付き防止)
    const tx = player.x + nx * push, ty = player.y + ny * push;
    if (passable(tx, player.y, player.z)) player.x = tx; // 壁・段差にはめり込まない
    if (passable(player.x, ty, player.z)) player.y = ty;
  }
}

function switchWeapon(w) {
  if (w === 'shotgun' && !player.hasShotgun) { showMessage('ショットガンを持っていない'); return; }
  if (player.weapon !== w) {
    player.weapon = w;
    showMessage(WEAPONS[w].name);
  }
}

function tryShoot() {
  if (player.shootCd > 0) return;
  const w = WEAPONS[player.weapon];
  if (w.melee) {
    player.shootCd = w.cooldown;
    Sound.knife();
    meleeAttack(w);
    alertEnemiesNear(player.x, player.y, 4); // ナイフは音が小さく、敵を遠くまで起こさない
    return;
  }
  if (player[w.ammo] < w.cost) {
    // 撃てる武器に自動で持ち替える(最後はナイフ)
    if (player.weapon === 'shotgun' && player.bullets > 0) switchWeapon('pistol');
    else { switchWeapon('knife'); showMessage('弾切れ! ナイフに持ち替えた'); }
    player.shootCd = 0.3;
    return;
  }
  player[w.ammo] -= w.cost;
  player.shootCd = w.cooldown;
  player.muzzleT = 0.09;
  if (player.weapon === 'pistol') Sound.pistol(); else Sound.shotgun();

  // 上下視点に合わせて弾道を傾ける (クロスヘア=画面中央に飛ぶ)
  const slope = player.pitch / VIEW_H;
  for (let p = 0; p < w.pellets; p++) {
    const spread = (Math.random() * 2 - 1) * w.spread;
    const cos = Math.cos(spread), sin = Math.sin(spread);
    const dx = player.dirX * cos - player.dirY * sin;
    const dy = player.dirX * sin + player.dirY * cos;
    hitscan(player.x, player.y, player.z + EYE, dx, dy, slope, w.damage[0] + Math.random() * (w.damage[1] - w.damage[0]));
  }
  alertEnemiesNear(player.x, player.y, 11);
}

// 弾道レイ: 壁・床段差・天井に当たるまでの距離 (slopeは距離1あたりの上下量)
function castRay3D(x, y, z, dx, dy, slope, maxDist = 64) {
  let mapX = x | 0, mapY = y | 0;
  const deltaX = Math.abs(1 / dx), deltaY = Math.abs(1 / dy);
  let stepX, stepY, sideX, sideY;
  if (dx < 0) { stepX = -1; sideX = (x - mapX) * deltaX; }
  else { stepX = 1; sideX = (mapX + 1 - x) * deltaX; }
  if (dy < 0) { stepY = -1; sideY = (y - mapY) * deltaY; }
  else { stepY = 1; sideY = (mapY + 1 - y) * deltaY; }
  for (let i = 0; i < 256; i++) {
    let t;
    if (sideX < sideY) { t = sideX; sideX += deltaX; mapX += stepX; }
    else { t = sideY; sideY += deltaY; mapY += stepY; }
    if (t > maxDist) return maxDist;
    if (isSolid(mapX + 0.5, mapY + 0.5)) return t;
    const bz = z + slope * t;
    if (bz > level.ceilH || bz < floorHt(mapX, mapY)) return t;
  }
  return maxDist;
}

// 視線判定: 壁と床段差(高さ)を考慮。z0/z1 は両端の目の高さ
function hasLineOfSight(x0, y0, x1, y1, z0 = 0.5, z1 = 0.5) {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.01) return true;
  const rx = dx / dist, ry = dy / dist;
  let mapX = x0 | 0, mapY = y0 | 0;
  const deltaX = Math.abs(1 / rx), deltaY = Math.abs(1 / ry);
  let stepX, stepY, sideX, sideY;
  if (rx < 0) { stepX = -1; sideX = (x0 - mapX) * deltaX; }
  else { stepX = 1; sideX = (mapX + 1 - x0) * deltaX; }
  if (ry < 0) { stepY = -1; sideY = (y0 - mapY) * deltaY; }
  else { stepY = 1; sideY = (mapY + 1 - y0) * deltaY; }
  for (let i = 0; i < 256; i++) {
    let t;
    if (sideX < sideY) { t = sideX; sideX += deltaX; mapX += stepX; }
    else { t = sideY; sideY += deltaY; mapY += stepY; }
    if (t > dist - 0.05) return true;
    if (isSolid(mapX + 0.5, mapY + 0.5)) return false;
    const rayZ = z0 + (z1 - z0) * (t / dist);
    if (floorHt(mapX, mapY) > rayZ) return false; // 段差が視線を遮る
  }
  return true;
}

function hitscan(x, y, z, dx, dy, slope, damage) {
  const wallDist = castRay3D(x, y, z, dx, dy, slope);
  // 射線に最も近い敵を探す
  let best = null, bestDist = Infinity;
  for (const e of level.enemies) {
    if (e.state === 'dead' || e.dormant) continue;
    const relX = e.x - x, relY = e.y - y;
    const along = relX * dx + relY * dy;         // 射線方向の距離
    if (along < 0.3 || along > wallDist + 0.2) continue;
    const perp = Math.abs(relX * dy - relY * dx); // 射線からの横ずれ
    if (perp >= 0.36) continue;
    const bz = z + slope * along;                 // その距離での弾の高さ
    const bodyTop = e.z + 0.95 * (ENEMY_TYPES[e.type].scale || 1);
    if (bz < e.z - 0.15 || bz > bodyTop + 0.15) continue;
    if (along < bestDist) { best = e; bestDist = along; }
  }
  // 射線に最も近い樽
  let barrel = null, barrelDist = Infinity;
  for (const b of level.barrels) {
    if (b.dead) continue;
    const relX = b.x - x, relY = b.y - y;
    const along = relX * dx + relY * dy;
    if (along < 0.2 || along > wallDist + 0.2) continue;
    if (Math.abs(relX * dy - relY * dx) >= 0.45) continue;
    const bz = z + slope * along;
    if (bz < b.z - 0.1 || bz > b.z + 1.0) continue;
    if (along < barrelDist) { barrel = b; barrelDist = along; }
  }
  if (best && (!barrel || bestDist <= barrelDist)) {
    damageEnemy(best, damage);
    spawnPuff(x + dx * bestDist, y + dy * bestDist, 'blood',
      clamp(z + slope * bestDist, best.z + 0.1, best.z + 1.4));
  } else if (barrel) {
    spawnPuff(x + dx * barrelDist, y + dy * barrelDist, 'boom', barrel.z + 0.5);
    damageBarrel(barrel, damage);
  } else {
    spawnPuff(x + dx * (wallDist - 0.05), y + dy * (wallDist - 0.05), 'boom',
      clamp(z + slope * wallDist, 0.1, level.ceilH - 0.05));
  }
}

// 樽にダメージ。耐久がゼロで爆発(連鎖あり)
function damageBarrel(b, dmg) {
  if (b.dead) return;
  b.hp -= dmg;
  if (b.hp <= 0) explodeBarrel(b);
}

function explodeBarrel(b) {
  if (b.dead) return;
  b.dead = true;
  level.barrelMask[b.my][b.mx] = 0; // 通行可に
  spawnPuff(b.x, b.y, 'boom', b.z + 0.5);
  spawnPuff(b.x, b.y, 'boom', b.z + 1.0);
  Sound.explode();
  explosionDamage(b.x, b.y, b.z + 0.4, b);
}

// 爆風: 半径内の敵・プレイヤー・他の樽(連鎖)にダメージ
function explosionDamage(x, y, z, source) {
  const R = EXPLOSION_RADIUS;
  for (const e of level.enemies) {
    if (e.state === 'dead' || e.dormant) continue;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < R && Math.abs(e.z - z) < 1.6) damageEnemy(e, EXPLOSION_DMG * (1 - d / R));
  }
  const dp = Math.hypot(player.x - x, player.y - y);
  if (dp < R && Math.abs(player.z + EYE - z) < 1.6) damagePlayer(EXPLOSION_DMG * 0.7 * (1 - dp / R));
  for (const o of level.barrels) {
    if (o === source || o.dead) continue;
    if (Math.hypot(o.x - x, o.y - y) < R) damageBarrel(o, EXPLOSION_DMG); // 連鎖爆発
  }
}

// 近接攻撃(ナイフ): 正面のごく近い敵のみに当たる。距離が離れていると無効。
function meleeAttack(w) {
  const dx = player.dirX, dy = player.dirY;
  const slope = player.pitch / VIEW_H;
  let best = null, bestDist = Infinity;
  for (const e of level.enemies) {
    if (e.state === 'dead' || e.dormant) continue;
    const relX = e.x - player.x, relY = e.y - player.y;
    const along = relX * dx + relY * dy;          // 正面方向の距離
    if (along < 0 || along > w.range) continue;    // 後ろ・遠すぎる敵は対象外
    if (Math.abs(relX * dy - relY * dx) > w.halfWidth) continue; // 横ずれ
    const bz = player.z + EYE + slope * along;     // 振った高さ
    const bodyTop = e.z + 0.95 * (ENEMY_TYPES[e.type].scale || 1);
    if (bz < e.z - 0.3 || bz > bodyTop + 0.3) continue; // 高低差がありすぎると届かない
    if (along < bestDist) { best = e; bestDist = along; }
  }
  // 正面の樽も殴れる
  let barrel = null, barrelDist = Infinity;
  for (const b of level.barrels) {
    if (b.dead) continue;
    const relX = b.x - player.x, relY = b.y - player.y;
    const along = relX * dx + relY * dy;
    if (along < 0 || along > w.range) continue;
    if (Math.abs(relX * dy - relY * dx) > w.halfWidth) continue;
    if (along < barrelDist) { barrel = b; barrelDist = along; }
  }
  if (best && (!barrel || bestDist <= barrelDist)) {
    damageEnemy(best, w.damage[0] + Math.random() * (w.damage[1] - w.damage[0]));
    spawnPuff(best.x, best.y, 'blood', best.z + 0.5);
    Sound.knifeHit();
  } else if (barrel) {
    Sound.knifeHit();
    damageBarrel(barrel, w.damage[0] + Math.random() * (w.damage[1] - w.damage[0]));
  }
}

// kind: 'boom'(爆発) / 'blood'(血しぶき) / 'tele'(テレポート)。zはエフェクト中心の高さ
function spawnPuff(x, y, kind, z = 0.5) {
  level.puffs.push({ x, y, z, t: 0, kind });
}

function useAction() {
  // 正面1.2タイル以内のドア/スイッチを起動
  const tx = player.x + player.dirX * 1.0;
  const ty = player.y + player.dirY * 1.0;
  const targets = [[tx, ty], [player.x + player.dirX * 1.5, player.y + player.dirY * 1.5]];
  for (const [x, y] of targets) {
    const ch = cellAt(x | 0, y | 0);
    if (isDoorChar(ch)) {
      const d = level.doors[`${x | 0},${y | 0}`];
      if (d.opening || d.open >= 1) return;
      // ロックドアはキーカードが必要
      if (ch === 'R' && !player.keys.red) { showMessage('赤のキーカードが必要だ'); Sound.denied(); return; }
      if (ch === 'B' && !player.keys.blue) { showMessage('青のキーカードが必要だ'); Sound.denied(); return; }
      if (ch === '*' && !d.found) {
        d.found = true;
        level.secretsFound++;
        showMessage('隠し扉を発見した!');
      }
      d.opening = true;
      Sound.door();
      return;
    }
    if (ch === 'X') {
      Sound.switch_();
      endLevel();
      return;
    }
  }
}

function damagePlayer(dmg) {
  if (game.state !== 'playing') return;
  // アーマーがダメージの一部(ARMOR_ABSORB)を肩代わりする
  if (player.armor > 0) {
    const absorbed = Math.min(player.armor, dmg * ARMOR_ABSORB);
    player.armor -= absorbed;
    dmg -= absorbed;
  }
  player.health -= dmg;
  player.damageFlash = Math.min(1, player.damageFlash + 0.25 + dmg * 0.012);
  Sound.playerHurt();
  if (player.health <= 0) {
    player.health = 0;
    game.state = 'dead';
    document.exitPointerLock();
  }
}

// ======================= 8. 敵AI・弾 =======================
function alertEnemiesNear(x, y, range) {
  for (const e of level.enemies) {
    if (e.dormant) continue;
    if (e.state === 'idle' && dist2(e.x, e.y, x, y) < range * range) {
      if (hasLineOfSight(e.x, e.y, x, y, e.z + EYE, player.z + EYE) || dist2(e.x, e.y, x, y) < 36) {
        setEnemyState(e, 'chase');
        Sound.alert();
      }
    }
  }
}

function setEnemyState(e, state) {
  e.state = state;
  e.stateT = 0;
}

function damageEnemy(e, dmg) {
  if (e.state === 'dead') return;
  e.hp -= dmg;
  if (e.hp <= 0) {
    setEnemyState(e, 'dead');
    level.kills++;
    Sound.enemyDie();
    const T = ENEMY_TYPES[e.type];
    if (T.drops) level.items.push({ kind: T.drops, x: e.x, y: e.y, z: e.z, dropped: true });
    return;
  }
  Sound.enemyPain();
  if (Math.random() < ENEMY_TYPES[e.type].painChance) setEnemyState(e, 'pain');
  else if (e.state === 'idle') setEnemyState(e, 'chase');
}

function updateEnemies(dt) {
  for (const e of level.enemies) {
    if (e.dormant) continue; // 休眠中の敵はトリガーで起こされるまで存在しない扱い
    const T = ENEMY_TYPES[e.type];
    e.stateT += dt;
    e.animT += dt;
    e.attackCd = Math.max(0, e.attackCd - dt);
    if (T.fly) {
      // 飛行: 床に追従せず、基準高度でふわふわ上下
      e.z = e.hoverBase + Math.sin(level.time * 2 + e.animT) * 0.15;
    } else {
      // 動く歩道に乗っていたら流される
      const eConv = level.conv[e.y | 0] && level.conv[e.y | 0][e.x | 0];
      if (eConv) tryMove(e, eConv[0] * CONVEYOR_SPEED * dt, eConv[1] * CONVEYOR_SPEED * dt, 0.3, STEP_MAX);
      // 足元の床高さに追従
      const fz = floorHt(e.x | 0, e.y | 0);
      e.z += clamp(fz - e.z, -dt * 10, dt * 10);
    }
    const dx = player.x - e.x, dy = player.y - e.y;
    const dist = Math.hypot(dx, dy);

    switch (e.state) {
      case 'idle':
        if (dist < T.sightRange && hasLineOfSight(e.x, e.y, player.x, player.y, e.z + EYE, player.z + EYE)) {
          // 視界に入ったら起きる
          setEnemyState(e, 'chase');
          Sound.alert();
        }
        break;
      case 'chase': {
        const los = hasLineOfSight(e.x, e.y, player.x, player.y, e.z + EYE, player.z + EYE);
        const inRange = T.attack.kind === 'melee'
          ? dist < T.attackRange
          : dist < T.attackRange && dist > 1.0;
        if (los && inRange && e.attackCd <= 0) {
          setEnemyState(e, 'attack');
          break;
        }
        // プレイヤーへ直進(+他の敵と離れる)
        let mx = dx / (dist || 1), my = dy / (dist || 1);
        for (const o of level.enemies) {
          if (o === e || o.state === 'dead' || o.dormant) continue;
          const d2 = dist2(e.x, e.y, o.x, o.y);
          if (d2 < 1.2 && d2 > 0.0001) {
            const d = Math.sqrt(d2);
            mx += (e.x - o.x) / d * 0.6;
            my += (e.y - o.y) / d * 0.6;
          }
        }
        const ml = Math.hypot(mx, my) || 1;
        if (dist > T.stopDist) {
          if (T.fly) tryMoveFly(e, mx / ml * T.speed * dt, my / ml * T.speed * dt, 0.3);
          else tryMove(e, mx / ml * T.speed * dt, my / ml * T.speed * dt, 0.3, STEP_MAX);
        } else if (e.attackCd <= 0 && los) {
          setEnemyState(e, 'attack');
        }
        break;
      }
      case 'attack':
        if (e.stateT >= 0.45 && !e.attacked) {
          e.attacked = true;
          const atk = T.attack;
          if (atk.kind === 'hitscan' || atk.kind === 'pellets') {
            // 距離で命中率が落ちる射撃 (pellets は複数判定)
            if (atk.kind === 'pellets') Sound.shotgun(); else Sound.pistol();
            const shots = atk.count || 1;
            for (let s = 0; s < shots; s++) {
              const hitChance = clamp(atk.hitBase - dist * 0.03, 0.1, atk.hitBase);
              if (Math.random() < hitChance && hasLineOfSight(e.x, e.y, player.x, player.y, e.z + EYE, player.z + EYE)) {
                damagePlayer(atk.dmg[0] + Math.random() * (atk.dmg[1] - atk.dmg[0]));
              }
            }
          } else if (atk.kind === 'melee') {
            // 噛みつき: 打撃の瞬間にまだ近く(高さも)にいれば命中
            Sound.bite();
            if (dist < 1.8 && Math.abs(e.z - player.z) < 0.8) {
              damagePlayer(atk.dmg[0] + Math.random() * (atk.dmg[1] - atk.dmg[0]));
            }
          } else {
            // 弾を投げる (高低差があれば上下にも飛ぶ)
            Sound.fireball();
            const d = dist || 1;
            const pz = e.z + 0.45;
            level.projectiles.push({
              x: e.x + dx / d * 0.5, y: e.y + dy / d * 0.5, z: pz,
              dx: dx / d * atk.speed, dy: dy / d * atk.speed,
              vz: (player.z + 0.45 - pz) * atk.speed / d,
              dmg: atk.dmg, sprite: atk.sprite,
              t: 0,
            });
          }
        }
        if (e.stateT >= 0.8) {
          e.attacked = false;
          e.attackCd = T.attackCooldown * (0.8 + Math.random() * 0.4);
          setEnemyState(e, 'chase');
        }
        break;
      case 'pain':
        if (e.stateT >= 0.35) setEnemyState(e, 'chase');
        break;
      case 'dead':
        break;
    }
  }

  // 火球
  for (let i = level.projectiles.length - 1; i >= 0; i--) {
    const p = level.projectiles[i];
    p.t += dt;
    const steps = 3; // すり抜け防止に分割移動
    let dead = false;
    for (let s = 0; s < steps && !dead; s++) {
      p.x += p.dx * dt / steps;
      p.y += p.dy * dt / steps;
      p.z += p.vz * dt / steps;
      const bm = level.barrelMask[p.y | 0];
      if (isSolid(p.x, p.y) || p.z < floorHt(p.x | 0, p.y | 0) || p.z > level.ceilH) {
        spawnPuff(p.x - p.dx * dt / steps, p.y - p.dy * dt / steps, 'boom', p.z);
        Sound.explode();
        dead = true;
      } else if (bm && bm[p.x | 0]) { // 樽に当たると誘爆
        const b = level.barrels.find(bb => !bb.dead && bb.mx === (p.x | 0) && bb.my === (p.y | 0));
        if (b) damageBarrel(b, p.dmg[1]);
        dead = true;
      } else if (dist2(p.x, p.y, player.x, player.y) < 0.3 && Math.abs(p.z - (player.z + 0.5)) < 0.8) {
        damagePlayer(p.dmg[0] + Math.random() * (p.dmg[1] - p.dmg[0]));
        spawnPuff(p.x, p.y, 'boom', p.z);
        dead = true;
      }
    }
    if (dead || p.t > 6) level.projectiles.splice(i, 1);
  }

  // パフ(着弾エフェクト)
  for (let i = level.puffs.length - 1; i >= 0; i--) {
    level.puffs[i].t += dt;
    if (level.puffs[i].t > 0.3) level.puffs.splice(i, 1);
  }

  // ドア開閉
  for (const key in level.doors) {
    const d = level.doors[key];
    if (d.opening && d.open < 1) d.open = Math.min(1, d.open + dt * 1.8);
  }
}

// ======================= 9. レンダリング =======================
// 床の高さに対応したレイキャスト: 列ごとにレイを奥へ進めながら
// 「床スパン(タイル上面)」「段差の立ち上がり(ライザー)」「壁」を手前から順に描く。
// clipBot(描画済みの下端)より下には描かないことで前後関係を保つ。
const zBuffer = new Float32Array(W);

// 列ごとの床オクルージョン: 床スパン/段差が画面下側を塗った位置を距離つきで記録し、
// スプライト描画時の下側クリップ(段差の陰に隠れる部分)に使う
const OCCL_MAX = 8;
const occlD = new Float32Array(W * OCCL_MAX);
const occlY = new Float32Array(W * OCCL_MAX);
const occlN = new Uint8Array(W);

function pushOccl(x, d, y) {
  const n = occlN[x];
  if (n >= OCCL_MAX) return;
  occlD[x * OCCL_MAX + n] = d;
  occlY[x * OCCL_MAX + n] = y;
  occlN[x] = n + 1;
}

// 床の色: 高い床ほど明るく、距離フォグで暗く。毎フレームの文字列生成を避けるためキャッシュ
function floorColorAt(h, d) {
  const fog = clamp(1 - 9 / (d + 4), 0, 0.85);
  const key = ((h * 4 + 0.5) | 0) * 64 + ((fog * 40) | 0);
  let c = level.shadeCache[key];
  if (!c) {
    const bright = 1 + h * 0.22;
    const [br, bg, bb] = level.floorRGB;
    const [fr, fgr, fb] = level.fogColor;
    const r = Math.min(255, br * bright * (1 - fog) + fr * fog) | 0;
    const g = Math.min(255, bg * bright * (1 - fog) + fgr * fog) | 0;
    const b = Math.min(255, bb * bright * (1 - fog) + fb * fog) | 0;
    c = `rgb(${r},${g},${b})`;
    level.shadeCache[key] = c;
  }
  return c;
}

// RGB配列を距離フォグと合成して 'rgb(...)' 文字列にする
function blendFog(rgb, d) {
  const fog = clamp(1 - 9 / (d + 4), 0, 0.85);
  const [fr, fgc, fb] = level.fogColor;
  const r = Math.min(255, rgb[0] * (1 - fog) + fr * fog) | 0;
  const g = Math.min(255, rgb[1] * (1 - fog) + fgc * fog) | 0;
  const b = Math.min(255, rgb[2] * (1 - fog) + fb * fog) | 0;
  return `rgb(${r},${g},${b})`;
}

// 水面の色(ゆるく揺らぐ)
function waterColorAt(mapX, mapY, d) {
  const base = TH.terrain.waterRGB;
  const w = 0.85 + 0.15 * Math.sin(level.time * 1.6 + (mapX + mapY) * 1.3);
  return blendFog([base[0] * w, base[1] * w, base[2] * w], d);
}

// 動く歩道の色。流れる方向に沿って明暗の波が進み「動いて見える」
function conveyorColorAt(mapX, mapY, dir, d) {
  const T = TH.terrain;
  const coord = mapX * dir[0] + mapY * dir[1];
  const t = 0.5 + 0.5 * Math.sin(level.time * 4 - coord * 1.7); // 0..1
  const lo = T.conveyorRGB, hi = T.conveyorHi;
  return blendFog([lerp(lo[0], hi[0], t), lerp(lo[1], hi[1], t), lerp(lo[2], hi[2], t)], d);
}

// テクスチャ1列を画面の [y0,y1) に描く。clipBotより下と画面上端より上はクロップ
function drawTexSlice(img, texX, sy0, sh0, x, y0, y1, clipBot) {
  let sy = sy0, sh = sh0, dy0 = y0, dy1 = y1;
  if (dy1 > clipBot) { sh = sh0 * (clipBot - y0) / (y1 - y0); dy1 = clipBot; }
  if (dy0 < 0) { const f = -y0 / (y1 - y0); sy = sy0 + sh0 * f; sh -= sh0 * f; dy0 = 0; }
  if (sh <= 0.01 || dy1 - dy0 < 0.01) return;
  ctx.drawImage(img, texX, sy, 1, sh, x, dy0, 1, dy1 - dy0);
}

// 距離フォグの帯を1列ぶん重ねる
function fogColumn(x, d, y0, y1) {
  const fog = clamp(1 - 9 / (d + 4), 0, 0.85);
  if (fog <= 0.04) return;
  const top = Math.max(0, y0);
  if (y1 <= top) return;
  const [fr, fgc, fb] = level.fogColor;
  ctx.fillStyle = `rgba(${fr},${fgc},${fb},${fog})`;
  ctx.fillRect(x, top, 1, y1 - top);
}

function renderView() {
  const ceilH = level.ceilH;
  const eyeZ = player.z + EYE;
  const bobY = Math.sin(player.bobPhase) * 3 * player.bobAmount;
  const horizon = VIEW_H / 2 + player.pitch + bobY; // 上下視点(y-shearing)

  // 天井は全面に塗っておき、壁と床スパンで上書きする
  ctx.fillStyle = level.ceilColor;
  ctx.fillRect(0, 0, W, VIEW_H);

  for (let x = 0; x < W; x++) {
    const cameraX = 2 * x / W - 1;
    const rayDirX = player.dirX + player.planeX * cameraX;
    const rayDirY = player.dirY + player.planeY * cameraX;
    let mapX = player.x | 0, mapY = player.y | 0;
    const deltaX = Math.abs(1 / rayDirX), deltaY = Math.abs(1 / rayDirY);
    let stepX, stepY, sideX, sideY;
    if (rayDirX < 0) { stepX = -1; sideX = (player.x - mapX) * deltaX; }
    else { stepX = 1; sideX = (mapX + 1 - player.x) * deltaX; }
    if (rayDirY < 0) { stepY = -1; sideY = (player.y - mapY) * deltaY; }
    else { stepY = 1; sideY = (mapY + 1 - player.y) * deltaY; }

    let clipBot = VIEW_H;                    // ここより下は描画済み
    let prevMapX = mapX, prevMapY = mapY;    // 直前タイルの座標
    let prevFloor = floorHt(mapX, mapY);     // 直前タイルの床高さ
    let prevDist = 0;
    occlN[x] = 0;
    zBuffer[x] = 64;

    for (let i = 0; i < 128; i++) {
      let side;
      if (sideX < sideY) { sideX += deltaX; mapX += stepX; side = 0; }
      else { sideY += deltaY; mapY += stepY; side = 1; }
      const d = side === 0 ? sideX - deltaX : sideY - deltaY;
      const ch = cellAt(mapX, mapY);

      // 直前まで通ってきたタイルの床スパン (目線より低い床のみ見える)
      if (prevFloor < eyeZ - 0.01 && d > 0.02) {
        const yFar = horizon + (eyeZ - prevFloor) * VIEW_H / d;
        if (yFar < clipBot) {
          const yNear = prevDist < 0.02 ? VIEW_H : horizon + (eyeZ - prevFloor) * VIEW_H / prevDist;
          const top = Math.max(0, yFar);
          const bot = Math.min(yNear, clipBot);
          if (bot > top) {
            const md = (prevDist + d) / 2;
            const wTile = level.water[prevMapY] && level.water[prevMapY][prevMapX];
            const cTile = level.conv[prevMapY] && level.conv[prevMapY][prevMapX];
            ctx.fillStyle = wTile ? waterColorAt(prevMapX, prevMapY, md)
              : cTile ? conveyorColorAt(prevMapX, prevMapY, cTile, md)
              : floorColorAt(prevFloor, md);
            ctx.fillRect(x, top, 1, bot - top);
          }
          clipBot = yFar;
          pushOccl(x, d, clipBot);
        }
      }

      // 壁ヒット判定
      if (ch !== null) {
        let wallX = side === 0 ? player.y + d * rayDirY : player.x + d * rayDirX;
        wallX -= Math.floor(wallX);
        let texX = -1;
        if (isDoorChar(ch)) {
          // スライドドア: 開いた部分はレイが通過する
          const dr = level.doors[`${mapX},${mapY}`];
          const shifted = wallX + dr.open;
          if (shifted < 1) texX = (shifted * TEX) | 0;
        } else {
          texX = (wallX * TEX) | 0;
          if ((side === 0 && rayDirX > 0) || (side === 1 && rayDirY < 0)) texX = TEX - texX - 1;
        }
        if (texX >= 0) {
          const tex = textures[ch];
          const img = side === 1 ? tex.dark : tex.lit;
          const unitH = VIEW_H / d;
          // 天井(ceilH)から床(0)まで1タイルごとにテクスチャを繰り返す
          for (let k = ceilH; k > 0; k--) {
            const y0 = horizon + (eyeZ - k) * unitH;
            if (y0 >= clipBot) break;
            drawTexSlice(img, texX, 0, TEX, x, y0, y0 + unitH, clipBot);
          }
          fogColumn(x, d, horizon + (eyeZ - ceilH) * unitH, Math.min(clipBot, horizon + eyeZ * unitH));
          zBuffer[x] = d;
          break;
        }
      }

      // 床タイル: 段差の立ち上がり(ライザー)を描く
      const fH = floorHt(mapX, mapY);
      if (fH > prevFloor + 0.001) {
        const y0 = horizon + (eyeZ - fH) * VIEW_H / d;
        if (y0 < clipBot) {
          const y1 = horizon + (eyeZ - prevFloor) * VIEW_H / d;
          let wallX = side === 0 ? player.y + d * rayDirY : player.x + d * rayDirX;
          wallX -= Math.floor(wallX);
          let texX = (wallX * TEX) | 0;
          if ((side === 0 && rayDirX > 0) || (side === 1 && rayDirY < 0)) texX = TEX - texX - 1;
          const tex = textures[level.stepTex];
          const img = side === 1 ? tex.dark : tex.lit;
          const srcH = TEX * Math.min(1, fH - prevFloor); // テクスチャ下部を段差の高さぶん使う
          drawTexSlice(img, texX, TEX - srcH, srcH, x, y0, y1, clipBot);
          fogColumn(x, d, y0, Math.min(y1, clipBot));
          clipBot = Math.max(0, y0);
          pushOccl(x, d, clipBot);
          if (clipBot <= 0) { zBuffer[x] = d; break; } // 画面全体が埋まった
        }
      }
      prevFloor = fH;
      prevDist = d;
      prevMapX = mapX;
      prevMapY = mapY;
    }
  }

  // スプライト収集 (base = フレーム下端のワールド高さ)
  const drawList = [];
  for (const e of level.enemies) {
    if (e.dormant) continue;
    let frame;
    const S = sprites[e.type];
    if (e.state === 'dead') {
      const stage = Math.min(2, (e.stateT / 0.18) | 0);
      frame = S.dead[stage];
    } else if (e.state === 'pain') frame = S.pain;
    else if (e.state === 'attack') frame = S.aim;
    else frame = S.walk[((e.animT * 4) | 0) % 2];
    drawList.push({ x: e.x, y: e.y, frame, scale: ENEMY_TYPES[e.type].scale || 1, base: e.z });
  }
  for (const b of level.barrels) {
    if (b.dead) continue;
    drawList.push({ x: b.x, y: b.y, frame: sprites.barrel, scale: 0.95, base: b.z });
  }
  for (const it of level.items) {
    drawList.push({ x: it.x, y: it.y, frame: sprites.items[ITEM_TYPES[it.kind].sprite], scale: 1, base: it.z });
  }
  for (const p of level.projectiles) {
    // フレーム中央に描かれているので中心が p.z に来るよう下端を合わせる
    drawList.push({ x: p.x, y: p.y, frame: sprites[p.sprite][((p.t * 10) | 0) % 2], scale: 0.6, base: p.z - 0.3 });
  }
  for (const p of level.puffs) {
    const frames = sprites.puff[p.kind];
    const scale = p.kind === 'blood' ? 0.5 : p.kind === 'tele' ? 1.0 : 0.6;
    drawList.push({ x: p.x, y: p.y, frame: frames[Math.min(2, (p.t / 0.1) | 0)], scale, base: p.z - scale / 2 });
  }

  // 奥から手前にソートして描画
  for (const s of drawList) s.d = dist2(player.x, player.y, s.x, s.y);
  drawList.sort((a, b) => b.d - a.d);

  const invDet = 1 / (player.planeX * player.dirY - player.dirX * player.planeY);
  for (const s of drawList) {
    const relX = s.x - player.x, relY = s.y - player.y;
    const transX = invDet * (player.dirY * relX - player.dirX * relY);
    const transY = invDet * (-player.planeY * relX + player.planeX * relY);
    if (transY <= 0.1) continue;
    const screenX = (W / 2) * (1 + transX / transY);
    const fullH = Math.abs(VIEW_H / transY);
    const spriteH = fullH * s.scale;
    const spriteW = spriteH;
    const bottom = horizon + (eyeZ - s.base) * VIEW_H / transY;
    const drawY = bottom - spriteH;
    const startX = Math.max(0, (screenX - spriteW / 2) | 0);
    const endX = Math.min(W - 1, (screenX + spriteW / 2) | 0);
    if (endX < 0 || startX >= W) continue;
    for (let x = startX; x <= endX; x++) {
      if (zBuffer[x] <= transY - 0.05) continue;
      // 手前の床スパン/段差による下側クリップ
      let clip = VIEW_H;
      const n = occlN[x], b0 = x * OCCL_MAX;
      for (let j = 0; j < n; j++) {
        if (occlD[b0 + j] < transY - 0.05) clip = occlY[b0 + j];
        else break;
      }
      const visBot = Math.min(bottom, clip);
      if (visBot - drawY < 0.5) continue;
      const texCol = clamp((((x - (screenX - spriteW / 2)) / spriteW) * TEX) | 0, 0, TEX - 1);
      ctx.drawImage(s.frame, texCol, 0, 1, TEX * (visBot - drawY) / spriteH, x, drawY, 1, visBot - drawY);
    }
  }
}

function renderWeapon() {
  const w = WEAPONS[player.weapon];
  const bobX = Math.sin(player.bobPhase * 0.5) * 9 * player.bobAmount;
  const bobY = Math.abs(Math.cos(player.bobPhase * 0.5)) * 7 * player.bobAmount;
  const recoil = player.shootCd > w.cooldown - 0.1 ? 10 : 0;
  const cx = W / 2 + bobX;
  const baseY = VIEW_H + bobY + recoil;

  ctx.save();
  const wp = TH.weapon;
  if (player.muzzleT > 0) {
    // マズルフラッシュ
    ctx.fillStyle = `rgba(${wp.muzzle},0.9)`;
    ctx.beginPath();
    const fy = baseY - (player.weapon === 'pistol' ? 78 : 88);
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4 + 0.4;
      const r = i % 2 === 0 ? 22 : 9;
      ctx.lineTo(cx + Math.cos(a) * r, fy + Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill();
  }
  if (player.weapon === 'pistol') {
    ctx.fillStyle = wp.pBody;
    ctx.fillRect(cx - 9, baseY - 76, 18, 42);      // 銃身上部
    ctx.fillStyle = wp.pGrip;
    ctx.fillRect(cx - 12, baseY - 40, 24, 40);     // グリップ部
    ctx.fillStyle = wp.pBarrel;
    ctx.fillRect(cx - 4, baseY - 76, 8, 10);       // 銃口
    ctx.fillStyle = wp.pTop;
    ctx.fillRect(cx - 12, baseY - 44, 24, 5);
  } else if (player.weapon === 'shotgun') {
    ctx.fillStyle = wp.sBody;
    ctx.fillRect(cx - 14, baseY - 86, 28, 50);     // 銃身
    ctx.fillStyle = wp.sBarrel;
    ctx.fillRect(cx - 10, baseY - 86, 8, 50);
    ctx.fillStyle = wp.sStock;
    ctx.fillRect(cx - 20, baseY - 38, 40, 38);     // ストック
    ctx.fillStyle = wp.sStockTop;
    ctx.fillRect(cx - 20, baseY - 38, 40, 6);
  } else { // ナイフ(近接): 攻撃中は突き出す
    const swing = player.shootCd > w.cooldown - 0.2;
    if (currentTheme === 'pastel') {
      // ほのぼの: 肉球パンチ
      const oy = swing ? -28 : 0;
      ctx.fillStyle = wp.kArm;
      ctx.fillRect(cx - 10, baseY - 26 + oy, 20, 40);
      ctx.fillStyle = wp.kMain;
      ctx.beginPath(); ctx.arc(cx, baseY - 30 + oy, 22, 0, 7); ctx.fill();
      ctx.fillStyle = wp.kAccent; // 肉球の模様
      ctx.beginPath(); ctx.arc(cx, baseY - 26 + oy, 7, 0, 7); ctx.fill();
      ctx.beginPath();
      ctx.arc(cx - 10, baseY - 38 + oy, 4, 0, 7);
      ctx.arc(cx, baseY - 42 + oy, 4, 0, 7);
      ctx.arc(cx + 10, baseY - 38 + oy, 4, 0, 7);
      ctx.fill();
    } else {
      // ホラー: 戦闘ナイフ
      ctx.save();
      ctx.translate(cx + 16, baseY - 4);
      ctx.rotate(swing ? -0.55 : -1.05);
      ctx.fillStyle = wp.kGrip; ctx.fillRect(-5, -12, 10, 28);
      ctx.fillStyle = wp.kGuard; ctx.fillRect(-9, -14, 18, 5);
      ctx.fillStyle = wp.kBlade; ctx.fillRect(-4, -60, 8, 48);
      ctx.fillStyle = wp.kEdge; ctx.fillRect(2, -60, 2, 46);
      ctx.beginPath(); ctx.moveTo(-4, -60); ctx.lineTo(4, -60); ctx.lineTo(0, -70); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();

  // クロスヘア
  ctx.fillStyle = `rgba(${wp.crosshair},0.7)`;
  ctx.fillRect(W / 2 - 1, VIEW_H / 2 - 6, 2, 4);
  ctx.fillRect(W / 2 - 1, VIEW_H / 2 + 2, 2, 4);
  ctx.fillRect(W / 2 - 6, VIEW_H / 2 - 1, 4, 2);
  ctx.fillRect(W / 2 + 2, VIEW_H / 2 - 1, 4, 2);
}

function renderHUD() {
  const ui = TH.ui;
  ctx.fillStyle = ui.hudBg;
  ctx.fillRect(0, VIEW_H, W, HUD_H);
  ctx.fillStyle = ui.hudLine;
  ctx.fillRect(0, VIEW_H, W, 2);

  ctx.textBaseline = 'middle';
  const midY = VIEW_H + HUD_H / 2 + 1;

  // HP
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = ui.label;
  ctx.fillText('HEALTH', 18, midY - 12);
  ctx.font = 'bold 26px monospace';
  ctx.fillStyle = player.health > 50 ? ui.value : player.health > 25 ? '#e0a030' : '#e03030';
  ctx.fillText(`${Math.ceil(player.health)}%`, 18, midY + 8);

  // アーマー
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = ui.label;
  ctx.fillText('ARMOR', 118, midY - 12);
  ctx.font = 'bold 26px monospace';
  ctx.fillStyle = player.armor > 0 ? '#4a9ae0' : ui.label;
  ctx.fillText(`${Math.ceil(player.armor)}`, 118, midY + 8);

  // 弾
  const w = WEAPONS[player.weapon];
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = ui.label;
  ctx.fillText('AMMO', 215, midY - 12);
  ctx.font = 'bold 26px monospace';
  ctx.fillStyle = ui.value;
  ctx.fillText(w.ammo ? `${player[w.ammo]}` : '∞', 215, midY + 8);

  // 武器 (1/2/3 スロット。装備中をハイライト、未所持は暗く)
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = ui.label;
  ctx.fillText('ARMS', 305, midY - 12);
  ctx.font = 'bold 20px monospace';
  let ax = 305;
  for (const [slot, key] of [['1', 'pistol'], ['2', 'shotgun'], ['3', 'knife']]) {
    const owned = key !== 'shotgun' || player.hasShotgun;
    ctx.fillStyle = player.weapon === key ? ui.arms : owned ? ui.value : ui.hudLine;
    ctx.fillText(slot, ax, midY + 8);
    ax += 22;
  }

  // キル数
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = ui.label;
  ctx.fillText('KILLS', 490, midY - 12);
  ctx.font = 'bold 20px monospace';
  ctx.fillStyle = ui.value;
  ctx.fillText(`${level.kills}/${level.totalKills}`, 490, midY + 8);

  // キーカード
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = ui.label;
  ctx.fillText('KEYS', 575, midY - 12);
  for (const [i, [name, color]] of [['red', '#e03030'], ['blue', '#3050e0']].entries()) {
    const x = 575 + i * 24;
    if (player.keys[name]) {
      ctx.fillStyle = color;
      ctx.fillRect(x, midY, 18, 12);
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect(x, midY, 18, 3);
    } else {
      ctx.strokeStyle = '#444';
      ctx.strokeRect(x + 0.5, midY + 0.5, 17, 11);
    }
  }

  ctx.textBaseline = 'alphabetic';
}

function renderMinimap() {
  const scale = 6;
  const mw = level.w * scale, mh = level.h * scale;
  const ox = W - mw - 10, oy = 10;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(ox - 3, oy - 3, mw + 6, mh + 6);
  for (let y = 0; y < level.h; y++) {
    for (let x = 0; x < level.w; x++) {
      const ch = level.grid[y][x];
      if (ch === null) {
        if (level.water[y][x]) {                 // 水路・池
          ctx.fillStyle = '#2e6aa0';
          ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
        } else if (level.conv[y][x]) {            // 動く歩道
          ctx.fillStyle = '#9a8fc0';
          ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
        } else {
          // 高い床ほど明るく表示
          const fh = level.heights[y][x];
          if (fh > 0) {
            ctx.fillStyle = `rgba(190,190,200,${Math.min(0.65, 0.1 + fh * 0.18)})`;
            ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
          }
        }
        continue;
      }
      // '*'(隠し扉) はネタバレ防止のため通常壁と同じ色
      ctx.fillStyle = ch === 'D' ? '#b09030'
        : ch === 'R' ? '#d04040'
        : ch === 'B' ? '#4060d0'
        : ch === 'X' ? '#30c030' : '#777';
      ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
    }
  }
  for (const e of level.enemies) {
    if (e.state === 'dead' || e.dormant) continue;
    ctx.fillStyle = '#d04040';
    ctx.fillRect(ox + e.x * scale - 2, oy + e.y * scale - 2, 4, 4);
  }
  ctx.fillStyle = '#40c040';
  ctx.fillRect(ox + player.x * scale - 2, oy + player.y * scale - 2, 4, 4);
  ctx.strokeStyle = '#40c040';
  ctx.beginPath();
  ctx.moveTo(ox + player.x * scale, oy + player.y * scale);
  ctx.lineTo(ox + (player.x + player.dirX * 2) * scale, oy + (player.y + player.dirY * 2) * scale);
  ctx.stroke();
}

// メッセージ表示
let message = '', messageT = 0;
function showMessage(msg) {
  message = msg;
  messageT = 2.5;
}

function renderOverlays(dt) {
  const ui = TH.ui;
  if (player.damageFlash > 0) {
    ctx.fillStyle = `rgba(${ui.damageFlash},${clamp(player.damageFlash * 0.45, 0, 0.55)})`;
    ctx.fillRect(0, 0, W, VIEW_H);
  }
  if (player.pickupFlash > 0) {
    ctx.fillStyle = `rgba(${ui.pickupFlash},${player.pickupFlash * 0.12})`;
    ctx.fillRect(0, 0, W, VIEW_H);
  }
  if (messageT > 0) {
    messageT -= dt;
    ctx.font = 'bold 16px monospace';
    ctx.fillStyle = `rgba(${ui.message},${clamp(messageT, 0, 1)})`;
    ctx.fillText(message, 14, 26);
  }
  if (!pointerLocked && game.state === 'playing') {
    ctx.font = 'bold 14px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.textAlign = 'center';
    ctx.fillText('クリックでマウス操作 (Escで解除)', W / 2, VIEW_H - 16);
    ctx.textAlign = 'left';
  }
}

function renderCenteredScreen(lines) {
  ctx.fillStyle = TH.ui.overlay;
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  let y = H / 2 - lines.length * 16;
  for (const [text, font, color] of lines) {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.fillText(text, W / 2, y);
    y += 36;
  }
  ctx.textAlign = 'left';
}

function renderTitle() {
  const ui = TH.ui;
  ctx.fillStyle = ui.titleBg;
  ctx.fillRect(0, 0, W, H);
  // 背景グラデーション
  const g = ctx.createRadialGradient(W / 2, H * 0.7, 30, W / 2, H * 0.7, 400);
  g.addColorStop(0, ui.titleGlow[0]);
  g.addColorStop(1, ui.titleGlow[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.font = 'bold 64px monospace';
  const tg = ctx.createLinearGradient(0, 80, 0, 150);
  tg.addColorStop(0, ui.titleGrad[0]);
  tg.addColorStop(1, ui.titleGrad[1]);
  ctx.fillStyle = tg;
  ctx.fillText(ui.titleName, W / 2, 132);
  ctx.font = 'bold 16px monospace';
  ctx.fillStyle = ui.subtitleColor;
  ctx.fillText(ui.subtitle, W / 2, 164);

  ctx.font = 'bold 15px monospace';
  ctx.fillStyle = ui.helpColor;
  const help = [
    'WASD: 移動   マウス: 旋回・上下視点 / ←→: 旋回',
    'クリック / Space: 射撃   E: ドア・スイッチ',
    '1/2/3: 武器切替(3=ナイフ)   M: マップ   P: サウンドON/OFF',
  ];
  let y = 214;
  for (const line of help) { ctx.fillText(line, W / 2, y); y += 25; }

  // テーマ選択
  ctx.font = 'bold 15px monospace';
  ctx.fillStyle = ui.subtitleColor;
  ctx.fillText('← → / T キーで モード切替', W / 2, 304);
  ctx.font = 'bold 18px monospace';
  ctx.fillStyle = ui.titleGrad[0];
  ctx.fillText(`モード: ${TH.label}`, W / 2, 332);

  ctx.font = 'bold 22px monospace';
  ctx.fillStyle = `rgba(${ui.startColor},${0.6 + 0.4 * Math.sin(performance.now() / 300)})`;
  ctx.fillText('クリックしてスタート', W / 2, 372);
  ctx.textAlign = 'left';
}

// ======================= 10. ゲームループ・状態管理 =======================
const game = {
  state: 'title', // title / playing / dead / levelEnd / gameClear
  showMap: false,
};

// テーマを切り替え、テクスチャ・スプライトを作り直す
function applyTheme(name) {
  if (!THEMES[name]) return;
  currentTheme = name;
  TH = THEMES[name];
  buildTextures();
  buildSprites();
  // プレイ中に切り替えた場合は床色キャッシュとレベル色も更新
  if (level) {
    const lc = TH.levelColor ? TH.levelColor(level.index) : null;
    level.ceilColor = lc ? lc.ceil : level.def.ceilColor;
    level.floorColor = lc ? lc.floor : level.def.floorColor;
    level.fogColor = lc ? lc.fog : level.def.fogColor;
    level.floorRGB = hexToRGB(level.floorColor);
    level.shadeCache = {};
  }
}

function startGame() {
  Sound.init();
  resetPlayerStats();
  loadLevel(0);
  game.state = 'playing';
  canvas.requestPointerLock();
}

function restartLevel() {
  resetPlayerStats();
  loadLevel(level.index);
  game.state = 'playing';
  canvas.requestPointerLock();
}

function endLevel() {
  game.state = 'levelEnd';
  document.exitPointerLock();
}

function nextLevel() {
  if (level.index + 1 < LEVELS.length) {
    loadLevel(level.index + 1);
    game.state = 'playing';
    canvas.requestPointerLock();
  } else {
    game.state = 'gameClear';
  }
}

let lastTime = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (game.state === 'title') {
    renderTitle();
  } else {
    if (game.state === 'playing') {
      level.time += dt;
      // リフトの現在高さ(全リフト同期で上下)。floorHt より先に更新する
      if (level.hasLift) level.liftZ = LIFT_MIN + (LIFT_MAX - LIFT_MIN) * (0.5 - 0.5 * Math.cos(level.time * LIFT_RATE));
      updatePlayer(dt);
      updateEnemies(dt);
      resolvePlayerEnemyCollision();
    }
    renderView();
    if (game.state === 'playing' || game.state === 'dead') {
      renderWeapon();
    }
    renderHUD();
    if (game.showMap) renderMinimap();
    renderOverlays(dt);

    const ui = TH.ui;
    if (game.state === 'dead') {
      renderCenteredScreen([
        [ui.deadTitle, 'bold 40px monospace', ui.deadColor],
        ['', '', ''],
        [`キル: ${level.kills}/${level.totalKills}`, 'bold 18px monospace', ui.helpColor],
        ['Rキー / クリックでリスタート', 'bold 18px monospace', '#e0b040'],
        ['Qキーでタイトルへ戻る', 'bold 18px monospace', '#e0b040'],
      ]);
    } else if (game.state === 'levelEnd') {
      const t = level.time | 0;
      renderCenteredScreen([
        [`${level.def.name} クリア!`, 'bold 32px monospace', ui.endColor],
        ['', '', ''],
        [`キル: ${level.kills}/${level.totalKills}   アイテム: ${level.itemsGot}/${level.totalItems}   シークレット: ${level.secretsFound}/${level.totalSecrets}`, 'bold 18px monospace', ui.helpColor],
        [`タイム: ${(t / 60) | 0}:${String(t % 60).padStart(2, '0')} (パー ${level.def.par}秒)`, 'bold 18px monospace', ui.helpColor],
        ['', '', ''],
        [level.index + 1 < LEVELS.length ? 'Space / クリックで次のステージへ' : 'Space / クリックでリザルトへ', 'bold 18px monospace', '#e0b040'],
      ]);
    } else if (game.state === 'gameClear') {
      renderCenteredScreen([
        [ui.clearTitle, 'bold 44px monospace', ui.clearColor],
        ['', '', ''],
        [ui.clearMsg, 'bold 18px monospace', ui.helpColor],
        ['クリックでタイトルへ', 'bold 18px monospace', '#e0b040'],
      ]);
    }
  }
  requestAnimationFrame(frame);
}

// 起動
buildTextures();
buildSprites();
requestAnimationFrame(frame);
