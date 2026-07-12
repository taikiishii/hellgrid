'use strict';
/* =========================================================================
 * 描画 (Canvas)。World の状態を読むだけで、書き換えない。
 *
 * 毎フレーム bindWorld(world) を呼ぶと player / level / game が差し替わり、
 * 以降の render*() はその World を描く。テーマ依存の色は level に遅延キャッシュ。
 * ========================================================================= */
const W = 640, HUD_H = 48, H = VIEW_H + HUD_H;  // VIEW_H は sim/constants.js
const TEX = 64;                                  // テクスチャ解像度

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const hexToRGB = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// 描画対象の World。player / level / game は中身への別名
let world = null, player = null, level = null, game = null;

function bindWorld(w) {
  world = w; game = w;
  player = w.player;
  level = w.level;
  if (level.__themeKey !== currentTheme) applyLevelColors(level);
}

// テーマに応じた天井/床/フォグ色を level に載せる(描画専用のキャッシュ)
function applyLevelColors(lv) {
  const lc = TH.levelColor ? TH.levelColor(lv.index) : null;
  lv.ceilColor = lc ? lc.ceil : lv.def.ceilColor;
  lv.floorColor = lc ? lc.floor : lv.def.floorColor;
  lv.fogColor = lc ? lc.fog : lv.def.fogColor;
  lv.floorRGB = hexToRGB(lv.floorColor);
  lv.shadeCache = {};
  lv.__themeKey = currentTheme;
}

// テーマを切り替え、テクスチャ・スプライトを作り直す(レベル色は次の bindWorld で再構築)
function applyTheme(name) {
  if (!THEMES[name]) return;
  currentTheme = name;
  TH = THEMES[name];
  buildTextures();
  buildSprites();
}

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
// ======================= 9. レンダリング =======================
// 床の高さに対応したレイキャスト: 列ごとにレイを奥へ進めながら
// 「床スパン(タイル上面)」「段差の立ち上がり(ライザー)」「壁」を手前から順に描く。
// clipBot(描画済みの下端)より下には描かないことで前後関係を保つ。
const zBuffer = new Float32Array(W);
// バックミラー(後方ビュー)用のオフスクリーンと深度バッファ
const MIRROR_W = 200, MIRROR_H = 54;
const mirrorCanvas = makeCanvas(MIRROR_W, MIRROR_H);
const mirrorCtx = mirrorCanvas.getContext('2d');
mirrorCtx.imageSmoothingEnabled = false;
const rearZ = new Float32Array(MIRROR_W);

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
    let prevFloor = floorHt(level, mapX, mapY);     // 直前タイルの床高さ
    let prevDist = 0;
    occlN[x] = 0;
    zBuffer[x] = 64;

    for (let i = 0; i < 128; i++) {
      let side;
      if (sideX < sideY) { sideX += deltaX; mapX += stepX; side = 0; }
      else { sideY += deltaY; mapY += stepY; side = 1; }
      const d = side === 0 ? sideX - deltaX : sideY - deltaY;
      const ch = cellAt(level, mapX, mapY);

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
      const fH = floorHt(level, mapX, mapY);
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

// バックミラー: 真後ろを向いた視界を上端中央に小さく描く(左右反転した鏡像)。
// 視界外(背後)の敵を把握するための機能。
function renderRearview() {
  const g = mirrorCtx;
  const mw = MIRROR_W, mh = MIRROR_H;
  const def = level.def;
  // 後方カメラ(向き・カメラ平面を反転)
  const dirX = -player.dirX, dirY = -player.dirY;
  const planeX = -player.planeX, planeY = -player.planeY;

  g.fillStyle = def.ceilColor; g.fillRect(0, 0, mw, mh / 2);
  g.fillStyle = def.floorColor; g.fillRect(0, mh / 2, mw, mh / 2);

  // 壁(メインビューと同じDDA)
  for (let x = 0; x < mw; x++) {
    const cameraX = 2 * x / mw - 1;
    const rayDirX = dirX + planeX * cameraX;
    const rayDirY = dirY + planeY * cameraX;
    let mapX = player.x | 0, mapY = player.y | 0;
    const deltaX = Math.abs(1 / rayDirX), deltaY = Math.abs(1 / rayDirY);
    let stepX, stepY, sideX, sideY;
    if (rayDirX < 0) { stepX = -1; sideX = (player.x - mapX) * deltaX; }
    else { stepX = 1; sideX = (mapX + 1 - player.x) * deltaX; }
    if (rayDirY < 0) { stepY = -1; sideY = (player.y - mapY) * deltaY; }
    else { stepY = 1; sideY = (mapY + 1 - player.y) * deltaY; }
    let side = 0, hitChar = null, perpDist = 0, texX = 0;
    for (let i = 0; i < 128; i++) {
      if (sideX < sideY) { sideX += deltaX; mapX += stepX; side = 0; }
      else { sideY += deltaY; mapY += stepY; side = 1; }
      const ch = cellAt(level, mapX, mapY);
      if (ch === null) continue;
      perpDist = side === 0 ? sideX - deltaX : sideY - deltaY;
      let wallX = side === 0 ? player.y + perpDist * rayDirY : player.x + perpDist * rayDirX;
      wallX -= Math.floor(wallX);
      if (isDoorChar(ch)) {
        const d = level.doors[`${mapX},${mapY}`];
        const shifted = wallX + d.open;
        if (shifted >= 1) continue;
        texX = (shifted * TEX) | 0;
      } else {
        texX = (wallX * TEX) | 0;
        if ((side === 0 && rayDirX > 0) || (side === 1 && rayDirY < 0)) texX = TEX - texX - 1;
      }
      hitChar = ch; break;
    }
    if (hitChar === null) { rearZ[x] = 99; continue; }
    rearZ[x] = perpDist;
    const lineH = (mh / perpDist) | 0;
    const y0 = ((mh - lineH) / 2) | 0;
    const tex = textures[hitChar];
    g.drawImage(side === 1 ? tex.dark : tex.lit, texX, 0, 1, TEX, x, y0, 1, lineH);
    const fog = clamp(1 - 6 / (perpDist + 3), 0, 0.82);
    if (fog > 0.04) {
      const [fr, fgc, fb] = def.fogColor;
      g.fillStyle = `rgba(${fr},${fgc},${fb},${fog})`;
      g.fillRect(x, y0, 1, lineH);
    }
  }

  // 敵スプライト(後方カメラで投影、概況把握なので高さは簡略)
  const invDet = 1 / (planeX * dirY - dirX * planeY);
  const en = level.enemies.filter(e => !e.dormant && e.state !== 'dead');
  for (const e of en) e._rd = dist2(player.x, player.y, e.x, e.y);
  en.sort((a, b) => b._rd - a._rd);
  for (const e of en) {
    const relX = e.x - player.x, relY = e.y - player.y;
    const transX = invDet * (dirY * relX - dirX * relY);
    const transY = invDet * (-planeY * relX + planeX * relY);
    if (transY <= 0.1) continue;
    const screenX = (mw / 2) * (1 + transX / transY);
    const scale = ENEMY_TYPES[e.type].scale || 1;
    const spriteH = Math.abs(mh / transY) * scale;
    const spriteW = spriteH;
    const S = sprites[e.type];
    let frame;
    if (e.state === 'pain') frame = S.pain;
    else if (e.state === 'attack') frame = S.aim;
    else frame = S.walk[((e.animT * 4) | 0) % 2];
    const bottom = (mh + Math.abs(mh / transY)) / 2;
    const drawY0 = bottom - spriteH;
    const x0 = Math.max(0, (screenX - spriteW / 2) | 0);
    const x1 = Math.min(mw - 1, (screenX + spriteW / 2) | 0);
    for (let sx = x0; sx <= x1; sx++) {
      if (rearZ[sx] <= transY - 0.05) continue;
      const texCol = clamp((((sx - (screenX - spriteW / 2)) / spriteW) * TEX) | 0, 0, TEX - 1);
      g.drawImage(frame, texCol, 0, 1, TEX, sx, drawY0, 1, spriteH);
    }
  }

  // メイン画面の上端中央へ左右反転(鏡像)して貼る
  const dx = (W - mw) >> 1, dy = 6;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(dx + mw, dy); ctx.scale(-1, 1);
  ctx.drawImage(mirrorCanvas, 0, 0);
  ctx.restore();
  // 枠とラベル
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 3;
  ctx.strokeRect(dx - 2, dy - 2, mw + 4, mh + 4);
  ctx.strokeStyle = 'rgba(200,200,210,0.5)'; ctx.lineWidth = 1;
  ctx.strokeRect(dx - 0.5, dy - 0.5, mw + 1, mh + 1);
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(dx, dy, 46, 13);
  ctx.font = 'bold 9px monospace'; ctx.fillStyle = 'rgba(220,220,225,0.85)';
  ctx.textBaseline = 'top';
  ctx.fillText('REAR', dx + 5, dy + 3);
  ctx.textBaseline = 'alphabetic';
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
    '1/2/3: 武器切替(3=ナイフ)   M: マップ   B: 後方ミラー   P: サウンド',
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
