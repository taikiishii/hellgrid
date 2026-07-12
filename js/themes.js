'use strict';
/* =========================================================================
 * テーマ(色・世界観)。描画専用で、シミュレーションには一切影響しない。
 * 新しいテーマは THEMES に1エントリ + SPRITE_BUILDERS(render.js)に1エントリ。
 * ========================================================================= */
let currentTheme = 'pastel'; // 'hell'(ホラー) / 'pastel'(ほのぼの)

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

Object.assign(globalThis, { THEMES });
