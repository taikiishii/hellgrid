'use strict';
/* =========================================================================
 * パリティテスト用の共通ロールアウト。
 *
 * Node (vm コンテキスト) とブラウザの両方で、まったく同じこのコードを走らせる。
 * World / SIM_DT はどちらの環境でもグローバルに居る前提。
 * 入力列は seed から決まる固定手順なので、World の RNG と合わせて完全に決定的。
 * ========================================================================= */
function parityRollout(seed, steps, levelIndex) {
  const lcg = (s => () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; })(seed ^ 0x9e3779b9);
  const w = new World({ seed, level: levelIndex || 0 });
  const trace = [];
  const snap = () => {
    const p = w.player, lv = w.level;
    trace.push([
      p.x, p.y, p.z, p.dirX, p.dirY, p.pitch, p.health, p.armor, p.bullets, p.shells,
      lv.kills, lv.itemsGot, lv.secretsFound, lv.items.length, lv.projectiles.length,
      lv.enemies.reduce((a, e) => a + e.hp, 0),
      lv.barrels.reduce((a, b) => a + (b.dead ? 0 : b.hp), 0),
      w.state === 'playing' ? 0 : 1,
    ].map(v => Math.round(v * 1e6) / 1e6));
  };

  for (let i = 0; i < steps; i++) {
    w.keys['KeyW'] = lcg() < 0.75;
    w.keys['KeyS'] = lcg() < 0.10;
    w.keys['KeyA'] = lcg() < 0.20;
    w.keys['KeyD'] = lcg() < 0.20;
    w.shootHeld = lcg() < 0.30;
    w.look((lcg() - 0.5) * 80, (lcg() - 0.5) * 20);
    if (i % 17 === 0) w.pressKey('KeyE');
    if (i % 211 === 0) w.pressKey('Digit3');
    if (i % 233 === 0) w.pressKey('Digit1');
    w.step(SIM_DT);
    w.drainEvents();
    if (i % 20 === 0) snap();
  }
  snap();
  return trace;
}

globalThis.parityRollout = parityRollout;
