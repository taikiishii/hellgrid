'use strict';
/* =========================================================================
 * シミュレーションの定数・データテーブル
 *
 * DOM・Canvas・Audio に一切依存しない。ブラウザでも Node (vm) でも同じものを
 * 読み込む。見た目に関する定数(W / TEX / 色)は render.js 側にある。
 * ========================================================================= */

const VIEW_H = 352;              // 3D ビューの高さ(px)。pitch -> 弾道の傾きに使う
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

const SIM_DT = 1 / 60;           // 固定タイムステップ。実時間に依存しない

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

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

// apply(p, w): p = player, w = World。効果音は w.emit で外に投げる(sim は音を鳴らさない)
const ITEM_TYPES = {
  h: { sprite: 'stim',          msg: 'スティムパックを拾った (+10 HP)',  apply: p => p.health = Math.min(100, p.health + 10), need: p => p.health < 100 },
  H: { sprite: 'medkit',        msg: 'メディキットを拾った (+25 HP)',    apply: p => p.health = Math.min(100, p.health + 25), need: p => p.health < 100 },
  a: { sprite: 'clip',          msg: '弾倉を拾った (+10)',               apply: p => p.bullets = Math.min(200, p.bullets + 10), need: p => p.bullets < 200 },
  A: { sprite: 'ammoBox',       msg: '弾薬箱を拾った (+25)',             apply: p => p.bullets = Math.min(200, p.bullets + 25), need: p => p.bullets < 200 },
  s: { sprite: 'shells',        msg: 'シェルを拾った (+4)',              apply: p => p.shells = Math.min(50, p.shells + 4), need: p => p.shells < 50 },
  S: { sprite: 'shotgunPickup', msg: 'ショットガンを手に入れた!',       apply: (p, w) => { p.hasShotgun = true; p.shells = Math.min(50, p.shells + 8); p.weapon = 'shotgun'; w.emit('sound', 'weaponUp'); }, need: () => true },
  r: { sprite: 'redcard',       msg: '赤のキーカードを手に入れた!',     apply: (p, w) => { p.keys.red = true; w.emit('sound', 'weaponUp'); }, need: p => !p.keys.red },
  b: { sprite: 'bluecard',      msg: '青のキーカードを手に入れた!',     apply: (p, w) => { p.keys.blue = true; w.emit('sound', 'weaponUp'); }, need: p => !p.keys.blue },
  p: { sprite: 'armorShard',    msg: 'アーマーの破片 (+5)',             apply: p => p.armor = Math.min(ARMOR_MAX, p.armor + 5), need: p => p.armor < ARMOR_MAX },
  V: { sprite: 'armorVest',     msg: 'ボディアーマーを着た (+100)',     apply: (p, w) => { p.armor = Math.min(ARMOR_MAX, p.armor + 100); w.emit('sound', 'weaponUp'); }, need: p => p.armor < ARMOR_MAX },
};

const WEAPONS = {
  knife:   { name: 'ナイフ',     cooldown: 0.45, damage: [18, 32], melee: true, range: 1.3, halfWidth: 0.55, ammo: null, cost: 0 },
  pistol:  { name: 'ピストル',   cooldown: 0.38, damage: [10, 16], pellets: 1, spread: 0.012, ammo: 'bullets', cost: 1 },
  shotgun: { name: 'ショットガン', cooldown: 0.95, damage: [8, 13], pellets: 7, spread: 0.09, ammo: 'shells', cost: 1 },
};

Object.assign(globalThis, {
  VIEW_H, FOV_PLANE, PLAYER_RADIUS, MOVE_SPEED, ROT_SPEED, MOUSE_SENS, STEP_MAX,
  EYE, PITCH_MAX, WATER_DEPTH, CONVEYOR_SPEED, CONV_CHARS, BARREL_HP,
  EXPLOSION_RADIUS, EXPLOSION_DMG, LIFT_MIN, LIFT_MAX, LIFT_RATE,
  ARMOR_MAX, ARMOR_ABSORB, SIM_DT,
  clamp, lerp, dist2, ENEMY_TYPES, ENEMY_CHARS, ITEM_TYPES, WEAPONS,
});
