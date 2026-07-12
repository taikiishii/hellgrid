'use strict';
/* =========================================================================
 * World — ゲームシミュレーション本体
 *
 * DOM・Canvas・Audio・実時間に一切依存しない。1インスタンス = 1ゲーム世界で、
 * 同一プロセスに何個でも並べられる(機械学習の並列環境のため)。
 *
 *   const w = new World({ seed: 123, level: 0 });
 *   w.keys['KeyW'] = true;
 *   w.step(SIM_DT);            // 固定タイムステップ。実時間 dt は渡さない
 *   w.drainEvents();           // [{t:'sound', v:'pistol'}, ...] を取り出す
 *
 * 音・メッセージ・ポインタロックといった「外の世界」への副作用は emit() で
 * イベントとして投げるだけで、World 自身は何もしない。描画側 (main.js) が
 * drainEvents() で受け取って鳴らす/表示する。
 * ========================================================================= */

// ---- レベルデータの問い合わせ (level を引数に取る自由関数。描画側とも共有) ----

function isWallChar(ch) {
  return ch === '#' || ch === '&' || ch === '=' || ch === 'X' || isDoorChar(ch);
}

// スライド開閉する壁(ドア・ロックドア・隠し扉)
function isDoorChar(ch) {
  return ch === 'D' || ch === 'R' || ch === 'B' || ch === '*';
}

function cellAt(level, x, y) {
  if (y < 0 || y >= level.h || x < 0 || x >= level.w) return '#';
  return level.grid[y][x];
}

// 移動・弾にとってそのタイルが通れるか
function isSolid(level, x, y) {
  const ch = cellAt(level, x | 0, y | 0);
  if (ch === null) return false;
  if (isDoorChar(ch)) {
    const d = level.doors[`${x | 0},${y | 0}`];
    return d.open < 0.75;
  }
  return true;
}

// そのタイルの床の高さ(水路は床より低い窪み、リフトは時間で上下)
function floorHt(level, x, y) {
  if (y < 0 || y >= level.h || x < 0 || x >= level.w) return 0;
  if (level.water[y][x]) return WATER_DEPTH;
  if (level.lift[y][x]) return level.liftZ;
  return level.heights[y][x];
}

class World {
  // opts: { seed, level }
  constructor(opts = {}) {
    this.seed = opts.seed >>> 0 || 1;
    this.rng = makeRNG(this.seed);
    this.events = [];
    this.state = 'playing';   // playing / dead / levelEnd / gameClear
    this.level = null;
    this.time = 0;            // 世界の経過時間(秒)。ステージ跨ぎで累積
    this.keys = Object.create(null);
    this.shootHeld = false;   // マウス左ボタン相当(押しっぱなしで連射)
    this.lookDX = 0;          // 次の step で消費する視点移動(マウス移動量相当)
    this.lookDY = 0;

    this.player = {
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

    this.reset(opts.level || 0);
  }

  emit(t, v) { this.events.push({ t, v }); }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ======================= 状態遷移 =======================

  // 最初から(または任意のステージから)始める。プレイヤーの装備もリセット
  reset(index = 0, seed) {
    if (seed !== undefined) { this.seed = seed >>> 0; this.rng = makeRNG(this.seed); }
    this.events = [];
    this.time = 0;
    this.resetPlayerStats();
    this.loadLevel(index);
    this.state = 'playing';
  }

  restartLevel() {
    this.resetPlayerStats();
    this.loadLevel(this.level.index);
    this.state = 'playing';
  }

  endLevel() {
    this.state = 'levelEnd';
    this.emit('unlockPointer');
  }

  nextLevel() {
    if (this.level.index + 1 < LEVELS.length) {
      this.loadLevel(this.level.index + 1);
      this.state = 'playing';
    } else {
      this.state = 'gameClear';
    }
  }

  resetPlayerStats() {
    const p = this.player;
    p.health = 100;
    p.armor = 0;
    p.bullets = 50;
    p.shells = 0;
    p.hasShotgun = false;
    p.weapon = 'pistol';
    p.shootCd = 0;
    p.pitch = 0;
    p.damageFlash = 0; p.pickupFlash = 0; p.muzzleT = 0;
  }

  // ======================= レベルロード =======================

  loadLevel(index) {
    const player = this.player;
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
            state: 'idle', stateT: 0, animT: this.rng() * 10,
            attackCd: 1 + this.rng(), dirX: 0, dirY: 0,
          });
        }
        else if (ITEM_TYPES[ch]) items.push({ kind: ch, x: cx, y: cy, z: heights[y][x], bob: this.rng() * 6 });
      }
    }
    this.level = {
      index, def, grid, w, h: rows.length, doors, enemies, items, triggers,
      water, conv, lift, hasLift, barrels, barrelMask, liftZ: LIFT_MIN,
      heights, ceilH: def.ceilHeight || 1, stepTex: def.stepTex || '=',
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
    this.emit('message', def.name);
  }

  // ======================= 入力 =======================

  // 視点移動(マウス移動量相当)。次の step で消費される
  look(dx, dy) {
    this.lookDX += dx;
    this.lookDY += dy;
  }

  // 押した瞬間に効くキー。押しっぱなしのキーは this.keys に直接立てる
  pressKey(code) {
    if (this.state !== 'playing') return;
    if (code === 'KeyE') this.useAction();
    else if (code === 'Digit1') this.switchWeapon('pistol');
    else if (code === 'Digit2') this.switchWeapon('shotgun');
    else if (code === 'Digit3') this.switchWeapon('knife');
  }

  // ======================= メインステップ =======================

  // dt は固定 (SIM_DT)。実時間を渡さないこと
  step(dt) {
    if (this.state !== 'playing') return;
    const level = this.level;
    this.time += dt;
    level.time += dt;
    // リフトの現在高さ(全リフト同期で上下)。floorHt より先に更新する
    if (level.hasLift) level.liftZ = LIFT_MIN + (LIFT_MAX - LIFT_MIN) * (0.5 - 0.5 * Math.cos(level.time * LIFT_RATE));
    this.updatePlayer(dt);
    this.updateEnemies(dt);
    this.resolvePlayerEnemyCollision();
  }

  // ======================= プレイヤー・移動 =======================

  rotatePlayer(angle) {
    const player = this.player;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const odx = player.dirX;
    player.dirX = player.dirX * cos - player.dirY * sin;
    player.dirY = odx * sin + player.dirY * cos;
    const opx = player.planeX;
    player.planeX = player.planeX * cos - player.planeY * sin;
    player.planeY = opx * sin + player.planeY * cos;
  }

  // 高さも考慮した通行判定。maxDropを渡すとそれ以上の段差は降りない(敵用)
  passable(x, y, z, maxDrop) {
    const level = this.level;
    if (isSolid(level, x, y)) return false;
    const ix = x | 0, iy = y | 0;
    if (level.water[iy] && level.water[iy][ix]) return false;     // 水路・池は通れない
    if (level.barrelMask[iy] && level.barrelMask[iy][ix]) return false; // 樽は障害物
    const fh = floorHt(level, ix, iy);
    if (fh - z > STEP_MAX) return false;                          // 高すぎて登れない
    if (maxDrop !== undefined && z - fh > maxDrop) return false;  // 敵は高所から飛び降りない
    return true;
  }

  // 半径つき移動(壁ずりスライド)
  tryMove(ent, dx, dy, radius, maxDrop) {
    const z = ent.z || 0;
    const nx = ent.x + dx;
    if (this.passable(nx + Math.sign(dx) * radius, ent.y - radius, z, maxDrop) &&
        this.passable(nx + Math.sign(dx) * radius, ent.y + radius, z, maxDrop)) {
      ent.x = nx;
    }
    const ny = ent.y + dy;
    if (this.passable(ent.x - radius, ny + Math.sign(dy) * radius, z, maxDrop) &&
        this.passable(ent.x + radius, ny + Math.sign(dy) * radius, z, maxDrop)) {
      ent.y = ny;
    }
  }

  // 飛行する敵の移動: 壁だけを避け、段差・水路・樽の上は自由に飛ぶ
  tryMoveFly(ent, dx, dy, radius) {
    const level = this.level;
    const nx = ent.x + dx;
    if (!isSolid(level, nx + Math.sign(dx) * radius, ent.y - radius) &&
        !isSolid(level, nx + Math.sign(dx) * radius, ent.y + radius)) {
      ent.x = nx;
    }
    const ny = ent.y + dy;
    if (!isSolid(level, ent.x - radius, ny + Math.sign(dy) * radius) &&
        !isSolid(level, ent.x + radius, ny + Math.sign(dy) * radius)) {
      ent.y = ny;
    }
  }

  updatePlayer(dt) {
    const player = this.player, level = this.level, keys = this.keys;

    // 視点移動を消費(旋回は実時間ではなく入力量で決まる)
    if (this.lookDX !== 0) { this.rotatePlayer(this.lookDX * MOUSE_SENS); this.lookDX = 0; }
    if (this.lookDY !== 0) {
      player.pitch = clamp(player.pitch - this.lookDY * 0.35, -PITCH_MAX, PITCH_MAX);
      this.lookDY = 0;
    }

    let mx = 0, my = 0;
    if (keys['KeyW']) { mx += player.dirX; my += player.dirY; }
    if (keys['KeyS']) { mx -= player.dirX; my -= player.dirY; }
    if (keys['KeyA']) { mx += player.dirY; my -= player.dirX; }
    if (keys['KeyD']) { mx -= player.dirY; my += player.dirX; }
    if (keys['ArrowUp']) { mx += player.dirX; my += player.dirY; }
    if (keys['ArrowDown']) { mx -= player.dirX; my -= player.dirY; }
    if (keys['ArrowLeft']) this.rotatePlayer(-ROT_SPEED * dt);
    if (keys['ArrowRight']) this.rotatePlayer(ROT_SPEED * dt);

    const len = Math.hypot(mx, my);
    if (len > 0.001) {
      const speed = MOVE_SPEED * dt / len;
      this.tryMove(player, mx * speed, my * speed, PLAYER_RADIUS);
      player.bobPhase += dt * 11;
      player.bobAmount = Math.min(1, player.bobAmount + dt * 6);
    } else {
      player.bobAmount = Math.max(0, player.bobAmount - dt * 6);
    }

    // 動く歩道: 乗っているタイルの方向へ流される
    const pConv = level.conv[player.y | 0] && level.conv[player.y | 0][player.x | 0];
    if (pConv) this.tryMove(player, pConv[0] * CONVEYOR_SPEED * dt, pConv[1] * CONVEYOR_SPEED * dt, PLAYER_RADIUS);

    // 段差の昇降: 上りはゆっくり登り、下りは素早く落ちる
    const ground = floorHt(level, player.x | 0, player.y | 0);
    if (ground > player.z) player.z = Math.min(ground, player.z + dt * 5);
    else player.z = Math.max(ground, player.z - dt * 14);

    player.shootCd = Math.max(0, player.shootCd - dt);
    player.muzzleT = Math.max(0, player.muzzleT - dt);
    player.damageFlash = Math.max(0, player.damageFlash - dt * 2.2);
    player.pickupFlash = Math.max(0, player.pickupFlash - dt * 3);

    if (this.shootHeld || keys['Space']) this.tryShoot();

    // アンブッシュトリガー: 踏むと付近の休眠敵がテレポートしてくる
    for (const tr of level.triggers) {
      if (tr.used || (player.x | 0) !== tr.x || (player.y | 0) !== tr.y) continue;
      tr.used = true;
      let woke = 0;
      for (const e of level.enemies) {
        if (e.dormant && dist2(e.x, e.y, tr.x + 0.5, tr.y + 0.5) < 144) {
          e.dormant = false;
          this.setEnemyState(e, 'chase');
          this.spawnPuff(e.x, e.y, 'tele', e.z + 0.5);
          woke++;
        }
      }
      if (woke > 0) {
        this.emit('sound', 'teleport');
        this.emit('message', '罠だ!');
      }
    }

    // アイテム回収
    for (let i = level.items.length - 1; i >= 0; i--) {
      const it = level.items[i];
      if (dist2(player.x, player.y, it.x, it.y) < 0.45 && Math.abs(it.z - player.z) < 0.9) {
        const def = ITEM_TYPES[it.kind];
        if (def.need(player)) {
          def.apply(player, this);
          this.emit('message', def.msg);
          this.emit('sound', 'pickup');
          player.pickupFlash = 0.5;
          level.items.splice(i, 1);
          if (!it.dropped) level.itemsGot++; // 敵のドロップ品は取得率に含めない
        }
      }
    }
  }

  // プレイヤーが敵をすり抜けないよう、重なりを解消して少し押し離す。
  // 敵移動後に呼ぶ。高さが大きく違う敵(別フロア)とはぶつからない。
  resolvePlayerEnemyCollision() {
    const player = this.player;
    for (const e of this.level.enemies) {
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
      if (this.passable(tx, player.y, player.z)) player.x = tx; // 壁・段差にはめり込まない
      if (this.passable(player.x, ty, player.z)) player.y = ty;
    }
  }

  // ======================= 武器 =======================

  switchWeapon(w) {
    const player = this.player;
    if (w === 'shotgun' && !player.hasShotgun) { this.emit('message', 'ショットガンを持っていない'); return; }
    if (player.weapon !== w) {
      player.weapon = w;
      this.emit('message', WEAPONS[w].name);
    }
  }

  tryShoot() {
    const player = this.player;
    if (player.shootCd > 0) return;
    const w = WEAPONS[player.weapon];
    if (w.melee) {
      player.shootCd = w.cooldown;
      this.emit('sound', 'knife');
      this.meleeAttack(w);
      this.alertEnemiesNear(player.x, player.y, 4); // ナイフは音が小さく、敵を遠くまで起こさない
      return;
    }
    if (player[w.ammo] < w.cost) {
      // 撃てる武器に自動で持ち替える(最後はナイフ)
      if (player.weapon === 'shotgun' && player.bullets > 0) this.switchWeapon('pistol');
      else { this.switchWeapon('knife'); this.emit('message', '弾切れ! ナイフに持ち替えた'); }
      player.shootCd = 0.3;
      return;
    }
    player[w.ammo] -= w.cost;
    player.shootCd = w.cooldown;
    player.muzzleT = 0.09;
    this.emit('sound', player.weapon === 'pistol' ? 'pistol' : 'shotgun');

    // 上下視点に合わせて弾道を傾ける (クロスヘア=画面中央に飛ぶ)
    const slope = player.pitch / VIEW_H;
    for (let p = 0; p < w.pellets; p++) {
      const spread = (this.rng() * 2 - 1) * w.spread;
      const cos = Math.cos(spread), sin = Math.sin(spread);
      const dx = player.dirX * cos - player.dirY * sin;
      const dy = player.dirX * sin + player.dirY * cos;
      this.hitscan(player.x, player.y, player.z + EYE, dx, dy, slope, w.damage[0] + this.rng() * (w.damage[1] - w.damage[0]));
    }
    this.alertEnemiesNear(player.x, player.y, 11);
  }

  // 弾道レイ: 壁・床段差・天井に当たるまでの距離 (slopeは距離1あたりの上下量)
  castRay3D(x, y, z, dx, dy, slope, maxDist = 64) {
    const level = this.level;
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
      if (isSolid(level, mapX + 0.5, mapY + 0.5)) return t;
      const bz = z + slope * t;
      if (bz > level.ceilH || bz < floorHt(level, mapX, mapY)) return t;
    }
    return maxDist;
  }

  // 視線判定: 壁と床段差(高さ)を考慮。z0/z1 は両端の目の高さ
  hasLineOfSight(x0, y0, x1, y1, z0 = 0.5, z1 = 0.5) {
    const level = this.level;
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
      if (isSolid(level, mapX + 0.5, mapY + 0.5)) return false;
      const rayZ = z0 + (z1 - z0) * (t / dist);
      if (floorHt(level, mapX, mapY) > rayZ) return false; // 段差が視線を遮る
    }
    return true;
  }

  hitscan(x, y, z, dx, dy, slope, damage) {
    const level = this.level;
    const wallDist = this.castRay3D(x, y, z, dx, dy, slope);
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
      this.damageEnemy(best, damage);
      this.spawnPuff(x + dx * bestDist, y + dy * bestDist, 'blood',
        clamp(z + slope * bestDist, best.z + 0.1, best.z + 1.4));
    } else if (barrel) {
      this.spawnPuff(x + dx * barrelDist, y + dy * barrelDist, 'boom', barrel.z + 0.5);
      this.damageBarrel(barrel, damage);
    } else {
      this.spawnPuff(x + dx * (wallDist - 0.05), y + dy * (wallDist - 0.05), 'boom',
        clamp(z + slope * wallDist, 0.1, level.ceilH - 0.05));
    }
  }

  // 樽にダメージ。耐久がゼロで爆発(連鎖あり)
  damageBarrel(b, dmg) {
    if (b.dead) return;
    b.hp -= dmg;
    if (b.hp <= 0) this.explodeBarrel(b);
  }

  explodeBarrel(b) {
    if (b.dead) return;
    b.dead = true;
    this.level.barrelMask[b.my][b.mx] = 0; // 通行可に
    this.spawnPuff(b.x, b.y, 'boom', b.z + 0.5);
    this.spawnPuff(b.x, b.y, 'boom', b.z + 1.0);
    this.emit('sound', 'explode');
    this.explosionDamage(b.x, b.y, b.z + 0.4, b);
  }

  // 爆風: 半径内の敵・プレイヤー・他の樽(連鎖)にダメージ
  explosionDamage(x, y, z, source) {
    const level = this.level, player = this.player;
    const R = EXPLOSION_RADIUS;
    for (const e of level.enemies) {
      if (e.state === 'dead' || e.dormant) continue;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < R && Math.abs(e.z - z) < 1.6) this.damageEnemy(e, EXPLOSION_DMG * (1 - d / R));
    }
    const dp = Math.hypot(player.x - x, player.y - y);
    if (dp < R && Math.abs(player.z + EYE - z) < 1.6) this.damagePlayer(EXPLOSION_DMG * 0.7 * (1 - dp / R));
    for (const o of level.barrels) {
      if (o === source || o.dead) continue;
      if (Math.hypot(o.x - x, o.y - y) < R) this.damageBarrel(o, EXPLOSION_DMG); // 連鎖爆発
    }
  }

  // 近接攻撃(ナイフ): 正面のごく近い敵のみに当たる。距離が離れていると無効。
  meleeAttack(w) {
    const level = this.level, player = this.player;
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
      this.damageEnemy(best, w.damage[0] + this.rng() * (w.damage[1] - w.damage[0]));
      this.spawnPuff(best.x, best.y, 'blood', best.z + 0.5);
      this.emit('sound', 'knifeHit');
    } else if (barrel) {
      this.emit('sound', 'knifeHit');
      this.damageBarrel(barrel, w.damage[0] + this.rng() * (w.damage[1] - w.damage[0]));
    }
  }

  // kind: 'boom'(爆発) / 'blood'(血しぶき) / 'tele'(テレポート)。zはエフェクト中心の高さ
  spawnPuff(x, y, kind, z = 0.5) {
    this.level.puffs.push({ x, y, z, t: 0, kind });
  }

  useAction() {
    const level = this.level, player = this.player;
    // 正面1.2タイル以内のドア/スイッチを起動
    const tx = player.x + player.dirX * 1.0;
    const ty = player.y + player.dirY * 1.0;
    const targets = [[tx, ty], [player.x + player.dirX * 1.5, player.y + player.dirY * 1.5]];
    for (const [x, y] of targets) {
      const ch = cellAt(level, x | 0, y | 0);
      if (isDoorChar(ch)) {
        const d = level.doors[`${x | 0},${y | 0}`];
        if (d.opening || d.open >= 1) return;
        // ロックドアはキーカードが必要
        if (ch === 'R' && !player.keys.red) { this.emit('message', '赤のキーカードが必要だ'); this.emit('sound', 'denied'); return; }
        if (ch === 'B' && !player.keys.blue) { this.emit('message', '青のキーカードが必要だ'); this.emit('sound', 'denied'); return; }
        if (ch === '*' && !d.found) {
          d.found = true;
          level.secretsFound++;
          this.emit('message', '隠し扉を発見した!');
        }
        d.opening = true;
        this.emit('sound', 'door');
        return;
      }
      if (ch === 'X') {
        this.emit('sound', 'switch_');
        this.endLevel();
        return;
      }
    }
  }

  damagePlayer(dmg) {
    const player = this.player;
    if (this.state !== 'playing') return;
    // アーマーがダメージの一部(ARMOR_ABSORB)を肩代わりする
    if (player.armor > 0) {
      const absorbed = Math.min(player.armor, dmg * ARMOR_ABSORB);
      player.armor -= absorbed;
      dmg -= absorbed;
    }
    player.health -= dmg;
    player.damageFlash = Math.min(1, player.damageFlash + 0.25 + dmg * 0.012);
    this.emit('sound', 'playerHurt');
    if (player.health <= 0) {
      player.health = 0;
      this.state = 'dead';
      this.emit('unlockPointer');
    }
  }

  // ======================= 敵AI・弾 =======================

  alertEnemiesNear(x, y, range) {
    const player = this.player;
    for (const e of this.level.enemies) {
      if (e.dormant) continue;
      if (e.state === 'idle' && dist2(e.x, e.y, x, y) < range * range) {
        if (this.hasLineOfSight(e.x, e.y, x, y, e.z + EYE, player.z + EYE) || dist2(e.x, e.y, x, y) < 36) {
          this.setEnemyState(e, 'chase');
          this.emit('sound', 'alert');
        }
      }
    }
  }

  setEnemyState(e, state) {
    e.state = state;
    e.stateT = 0;
  }

  damageEnemy(e, dmg) {
    if (e.state === 'dead') return;
    e.hp -= dmg;
    if (e.hp <= 0) {
      this.setEnemyState(e, 'dead');
      this.level.kills++;
      this.emit('sound', 'enemyDie');
      const T = ENEMY_TYPES[e.type];
      if (T.drops) this.level.items.push({ kind: T.drops, x: e.x, y: e.y, z: e.z, dropped: true });
      return;
    }
    this.emit('sound', 'enemyPain');
    if (this.rng() < ENEMY_TYPES[e.type].painChance) this.setEnemyState(e, 'pain');
    else if (e.state === 'idle') this.setEnemyState(e, 'chase');
  }

  updateEnemies(dt) {
    const level = this.level, player = this.player;
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
        if (eConv) this.tryMove(e, eConv[0] * CONVEYOR_SPEED * dt, eConv[1] * CONVEYOR_SPEED * dt, 0.3, STEP_MAX);
        // 足元の床高さに追従
        const fz = floorHt(level, e.x | 0, e.y | 0);
        e.z += clamp(fz - e.z, -dt * 10, dt * 10);
      }
      const dx = player.x - e.x, dy = player.y - e.y;
      const dist = Math.hypot(dx, dy);

      switch (e.state) {
        case 'idle':
          if (dist < T.sightRange && this.hasLineOfSight(e.x, e.y, player.x, player.y, e.z + EYE, player.z + EYE)) {
            // 視界に入ったら起きる
            this.setEnemyState(e, 'chase');
            this.emit('sound', 'alert');
          }
          break;
        case 'chase': {
          const los = this.hasLineOfSight(e.x, e.y, player.x, player.y, e.z + EYE, player.z + EYE);
          const inRange = T.attack.kind === 'melee'
            ? dist < T.attackRange
            : dist < T.attackRange && dist > 1.0;
          if (los && inRange && e.attackCd <= 0) {
            this.setEnemyState(e, 'attack');
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
            if (T.fly) this.tryMoveFly(e, mx / ml * T.speed * dt, my / ml * T.speed * dt, 0.3);
            else this.tryMove(e, mx / ml * T.speed * dt, my / ml * T.speed * dt, 0.3, STEP_MAX);
          } else if (e.attackCd <= 0 && los) {
            this.setEnemyState(e, 'attack');
          }
          break;
        }
        case 'attack':
          if (e.stateT >= 0.45 && !e.attacked) {
            e.attacked = true;
            const atk = T.attack;
            if (atk.kind === 'hitscan' || atk.kind === 'pellets') {
              // 距離で命中率が落ちる射撃 (pellets は複数判定)
              this.emit('sound', atk.kind === 'pellets' ? 'shotgun' : 'pistol');
              const shots = atk.count || 1;
              for (let s = 0; s < shots; s++) {
                const hitChance = clamp(atk.hitBase - dist * 0.03, 0.1, atk.hitBase);
                if (this.rng() < hitChance && this.hasLineOfSight(e.x, e.y, player.x, player.y, e.z + EYE, player.z + EYE)) {
                  this.damagePlayer(atk.dmg[0] + this.rng() * (atk.dmg[1] - atk.dmg[0]));
                }
              }
            } else if (atk.kind === 'melee') {
              // 噛みつき: 打撃の瞬間にまだ近く(高さも)にいれば命中
              this.emit('sound', 'bite');
              if (dist < 1.8 && Math.abs(e.z - player.z) < 0.8) {
                this.damagePlayer(atk.dmg[0] + this.rng() * (atk.dmg[1] - atk.dmg[0]));
              }
            } else {
              // 弾を投げる (高低差があれば上下にも飛ぶ)
              this.emit('sound', 'fireball');
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
            e.attackCd = T.attackCooldown * (0.8 + this.rng() * 0.4);
            this.setEnemyState(e, 'chase');
          }
          break;
        case 'pain':
          if (e.stateT >= 0.35) this.setEnemyState(e, 'chase');
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
        if (isSolid(level, p.x, p.y) || p.z < floorHt(level, p.x | 0, p.y | 0) || p.z > level.ceilH) {
          this.spawnPuff(p.x - p.dx * dt / steps, p.y - p.dy * dt / steps, 'boom', p.z);
          this.emit('sound', 'explode');
          dead = true;
        } else if (bm && bm[p.x | 0]) { // 樽に当たると誘爆
          const b = level.barrels.find(bb => !bb.dead && bb.mx === (p.x | 0) && bb.my === (p.y | 0));
          if (b) this.damageBarrel(b, p.dmg[1]);
          dead = true;
        } else if (dist2(p.x, p.y, player.x, player.y) < 0.3 && Math.abs(p.z - (player.z + 0.5)) < 0.8) {
          this.damagePlayer(p.dmg[0] + this.rng() * (p.dmg[1] - p.dmg[0]));
          this.spawnPuff(p.x, p.y, 'boom', p.z);
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
}

Object.assign(globalThis, { World, isWallChar, isDoorChar, cellAt, isSolid, floorHt });
