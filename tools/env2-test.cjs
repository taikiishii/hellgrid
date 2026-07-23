'use strict';
/* 探索版 (env2) の検証: node tools/env2-test.cjs
 *   1. 迷路生成: 形式・出口への到達可能性・決定性
 *   2. フォグ・オブ・ウォー: 開始時に全マップが見えていないこと
 *   3. 環境の決定性: 同じシード + 同じ行動列 → 同じ報酬列・同じ観測
 *   4. 観測の健全性: NaN / 値域
 *   5. 台本プレイ: 最短経路を歩かせて「探索報酬で黒字 → 出口発見 → クリア」まで通す
 *   6. ランダム方策の基準値: クリア率が 0% でないこと (学習の立ち上がりに必須)
 */
const { createEnvContext2 } = require('../env/sim-loader.cjs');
const ctx = createEnvContext2();
const { HellgridEnv2, OBS2_DIM, OBS2_LAYOUT, ACTION_NVEC2, generateMaze } = ctx;

let failures = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? 'OK ' : 'NG '} ${label}`);
  if (!cond) failures++;
};

console.log(`観測次元: ${OBS2_DIM}  (rays ${OBS2_LAYOUT.rays.join('x')} + local ${OBS2_LAYOUT.local.join('x')} + global ${OBS2_LAYOUT.global.join('x')} + scalars ${OBS2_LAYOUT.scalars})`);

// ---- 1. 迷路生成 ----
console.log('\n[1] 迷路生成 (50シード, size=11):');
{
  // マップ全域の素朴なBFS (テスト専用。env側の実装には依存しない)
  const bfs = (map, sx, sy) => {
    const h = map.length, w = map[0].length;
    const dist = new Int16Array(w * h).fill(-1);
    dist[sy * w + sx] = 0;
    const q = [sy * w + sx];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi], cx = c % w, cy = (c / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ax = cx + dx, ay = cy + dy;
        if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue;
        const ch = map[ay][ax];
        if (ch === '#' || ch === 'X' || dist[ay * w + ax] >= 0) continue;
        dist[ay * w + ax] = dist[c] + 1;
        q.push(ay * w + ax);
      }
    }
    return dist;
  };
  const checkConfig = (label, opts) => {
    let allOk = true, minD = Infinity, maxD = -Infinity, sumD = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const def = generateMaze(seed, opts);
      const map = def.map, w = map[0].length;
      if (!map.every(r => r.length === w)) { allOk = false; break; }
      const px = map.join('').indexOf('P');
      const nX = map.join('').split('X').length - 1;
      if (px < 0 || nX !== 1) { allOk = false; break; }
      const sx = px % w, sy = (px / w) | 0;
      const dist = bfs(map, sx, sy);
      // 出口スイッチの隣の床に届くか
      const xi = map.join('').indexOf('X'), ex = xi % w, ey = (xi / w) | 0;
      let reach = -1;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ax = ex + dx, ay = ey + dy;
        if (ax < 0 || ay < 0 || ax >= w || ay >= map.length) continue;
        const d = dist[ay * w + ax];
        if (d >= 0 && (reach < 0 || d < reach)) reach = d;
      }
      // 全床タイルが P から到達可能か (部屋の彫り込みで孤立が生まれていないか)
      let isolated = 0;
      for (let y = 0; y < map.length; y++) {
        for (let x = 0; x < w; x++) {
          if (!'#X'.includes(map[y][x]) && dist[y * w + x] < 0) isolated++;
        }
      }
      if (reach < 0 || isolated > 0) { allOk = false; break; }
      minD = Math.min(minD, reach); maxD = Math.max(maxD, reach); sumD += reach;
    }
    ok(allOk, `${label}: 50迷路すべて 行長一致・P/X 1個・出口到達可能・孤立床なし`);
    console.log(`      出口までの歩数: 最小 ${minD}  平均 ${(sumD / 50).toFixed(1)}  最大 ${maxD}`);
  };
  checkConfig('11x11 素の迷路          ', { size: 11 });
  checkConfig('15x15 braid=0.15        ', { size: 15, braid: 0.15 });
  checkConfig('21x21 braid+部屋5個     ', { size: 21, braid: 0.15, rooms: 5 });
  checkConfig('25x25 braid+部屋7個     ', { size: 25, braid: 0.15, rooms: 7 });
  checkConfig('13x13 部屋2+敵1〜3      ', { size: 13, braid: 0.15, rooms: 2, enemies: [1, 3] });
  const a = generateMaze(7, { size: 11 }).map.join('\n');
  const b = generateMaze(7, { size: 11 }).map.join('\n');
  const c = generateMaze(8, { size: 11 }).map.join('\n');
  ok(a === b, '同じシード → 同じ迷路');
  ok(a !== c, '違うシード → 違う迷路');
}

// ---- 2. フォグ・オブ・ウォー ----
console.log('\n[2] フォグ・オブ・ウォー:');
{
  const env = new HellgridEnv2({ mazeSize: 11 });
  let covSum = 0;
  let allPartial = true;
  for (let seed = 1; seed <= 20; seed++) {
    env.reset(seed);
    const cov = env.mem.knownFloor / env.mem.totalFloor;
    covSum += cov;
    if (cov >= 1) allPartial = false;
  }
  ok(allPartial, `開始時に全床タイルが見えているエピソードがない`);
  console.log(`      開始時の平均カバレッジ: ${(covSum / 20 * 100).toFixed(1)}% (11x11 迷路)`);
}

// ---- 3. 決定性 ----
console.log('\n[3] 決定性 (同シード + 同行動列):');
{
  const lcg = s => { let a = s >>> 0; return () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; }; };
  const run = () => {
    const env = new HellgridEnv2({ mazeSize: 11 });
    const rnd = lcg(99);
    let obs = env.reset(42);
    const rewards = [];
    for (let t = 0; t < 100; t++) {
      const r = env.step(ACTION_NVEC2.map(n => (rnd() * n) | 0));
      rewards.push(r.reward);
      obs = r.obs;
      if (r.terminated || r.truncated) break;
    }
    return { rewards: rewards.join(','), obs: Array.from(obs) };
  };
  const r1 = run(), r2 = run();
  ok(r1.rewards === r2.rewards, '報酬列が完全一致');
  ok(r1.obs.every((v, i) => v === r2.obs[i]), '最終観測が完全一致');
}

// ---- 4 & 6. 観測の健全性とランダム方策 ----
console.log('\n[4] 観測の健全性 + [6] ランダム方策の基準値:');
{
  const lcg = s => { let a = s >>> 0; return () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; }; };
  const rnd = lcg(2024);
  const env = new HellgridEnv2({ mazeSize: 11, maxSteps: 600 });
  let bad = 0, minV = Infinity, maxV = -Infinity;
  const check = o => {
    for (let i = 0; i < o.length; i++) {
      const v = o[i];
      if (!Number.isFinite(v)) { bad++; continue; }
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  };
  const N_EP = 50;
  let clears = 0, exitSeens = 0, covSum = 0, totalSteps = 0;
  const rewards = [];
  const t0 = process.hrtime.bigint();
  for (let ep = 0; ep < N_EP; ep++) {
    check(env.reset(3000 + ep));
    for (;;) {
      const r = env.step(ACTION_NVEC2.map(n => (rnd() * n) | 0));
      totalSteps++;
      if (r.terminated || r.truncated) {
        check(r.obs);
        rewards.push(r.info.epReward);
        covSum += r.info.coverage;
        if (r.info.exitSeen) exitSeens++;
        if (r.info.levelsCleared > 0) clears++;
        break;
      }
    }
  }
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  ok(bad === 0, `NaN/Inf なし`);
  ok(minV >= -1.001 && maxV <= 1.001, `値域 [${minV.toFixed(3)}, ${maxV.toFixed(3)}] が [-1, 1] 内`);
  rewards.sort((a, b) => a - b);
  console.log(`      ランダム方策 ${N_EP}エピソード (11x11迷路, 600步上限):`);
  console.log(`        クリア ${clears}/${N_EP}   出口発見 ${exitSeens}/${N_EP}   平均カバレッジ ${(covSum / N_EP * 100).toFixed(1)}%`);
  console.log(`        報酬 中央値 ${rewards[N_EP >> 1].toFixed(1)}  最小 ${rewards[0].toFixed(1)}  最大 ${rewards[N_EP - 1].toFixed(1)}`);
  console.log(`        スループット ${(totalSteps / secs / 1000).toFixed(1)}k 行動/秒 (1コア・観測生成込み)`);
  // 教訓6: 最初のカリキュラム段階は成功率 0% であってはならない
  ok(clears > 0, `ランダム方策でもクリアが 0 でない (${clears}/${N_EP}) — 学習の立ち上がりに必須`);
}

// ---- 5. 台本プレイ: 最短経路を歩いて出口発見 → クリア ----
console.log('\n[5] 台本プレイ (最短経路を1タイルずつテレポート):');
{
  const env = new HellgridEnv2({ mazeSize: 11 });
  env.reset(5);
  const w = env.world, lv = w.level;
  // テスト側でマップ全域BFS (出口の隣まで)
  const dist = new Int16Array(lv.w * lv.h).fill(-1);
  let ex = -1, ey = -1;
  for (let y = 0; y < lv.h; y++) for (let x = 0; x < lv.w; x++) if (lv.grid[y][x] === 'X') { ex = x; ey = y; }
  const seeds = [[ex + 1, ey], [ex - 1, ey], [ex, ey + 1], [ex, ey - 1]];
  const q = [];
  for (const [x, y] of seeds) {
    if (x < 0 || y < 0 || x >= lv.w || y >= lv.h || lv.grid[y][x] !== null) continue;
    dist[y * lv.w + x] = 0; q.push(y * lv.w + x);
  }
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi], cx = c % lv.w, cy = (c / lv.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = cx + dx, ay = cy + dy;
      if (ax < 0 || ay < 0 || ax >= lv.w || ay >= lv.h) continue;
      if (lv.grid[ay][ax] !== null || dist[ay * lv.w + ax] >= 0) continue;
      dist[ay * lv.w + ax] = dist[c] + 1;
      q.push(ay * lv.w + ax);
    }
  }
  let total = 0, exploreReward = 0, moved = 0;
  let sawExitReward = false;
  for (let t = 0; t < 200; t++) {
    const px = w.player.x | 0, py = w.player.y | 0;
    const d0 = dist[py * lv.w + px];
    if (d0 <= 0) break;
    let best = null, bd = d0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = px + dx, ay = py + dy;
      if (ax < 0 || ay < 0 || ax >= lv.w || ay >= lv.h) continue;
      const d = dist[ay * lv.w + ax];
      if (d >= 0 && d < bd) { bd = d; best = [dx, dy]; }
    }
    if (!best) break;
    // 進行方向を向かせてからテレポート (視界が進行方向に開くように)
    w.player.dirX = best[0]; w.player.dirY = best[1];
    w.player.planeX = -best[1] * 0.66; w.player.planeY = best[0] * 0.66;
    w.player.x = px + best[0] + 0.5;
    w.player.y = py + best[1] + 0.5;
    const wasSeen = env.exitSeen;
    const r = env.step([0, 0, 2, 1, 0, 0, 0]);   // 何もしない行動 (観測と報酬だけ)
    total += r.reward;
    if (!wasSeen && env.exitSeen) sawExitReward = true;
    moved++;
  }
  ok(moved > 3, `最短経路を ${moved} 歩ぶん前進できた`);
  ok(env.exitSeen, '道中で出口スイッチを発見した');
  ok(sawExitReward, '発見の瞬間に発見ボーナスが出た');
  ok(total > 0, `探索しながらの前進で合計報酬が黒字 (${total.toFixed(2)})`);
  // 出口の隣で出口の方を向いて E → クリア
  const px = w.player.x | 0, py = w.player.y | 0;
  w.player.dirX = ex + 0.5 - w.player.x; w.player.dirY = ey + 0.5 - w.player.y;
  const len = Math.hypot(w.player.dirX, w.player.dirY);
  w.player.dirX /= len; w.player.dirY /= len;
  w.player.planeX = -w.player.dirY * 0.66; w.player.planeY = w.player.dirX * 0.66;
  const r = env.step([0, 0, 2, 1, 0, 1, 0]);   // E を押す
  ok(r.terminated && r.info.levelsCleared === 1, `出口スイッチでクリア (報酬 ${r.reward.toFixed(1)})`);
  console.log(`      クリア時カバレッジ ${(r.info.coverage * 100).toFixed(1)}%`);
}

// ---- 7. フロンティア整形の符号 ----
// 出口をまだ見つけていない間、最寄りのフロンティア (未知との境界) へ向かって
// 1タイルずつ進むと、毎ステップ正の報酬になるはず (整形 + 新タイル発見)
console.log('\n[7] フロンティア整形 (出口未発見時の探索の勾配):');
{
  const { computeFrontierField } = ctx;
  const env = new HellgridEnv2({ mazeSize: 15, mazeBraid: 0.15 });
  let seed = 11;
  do { env.reset(seed++); } while (env.exitSeen && seed < 30);   // 出口が最初から見えていない開始を選ぶ
  const w = env.world, lv = w.level;
  let moved = 0, negatives = 0;
  while (moved < 25 && !env.goal.field) {
    const f = computeFrontierField(w, env.mem);
    if (!f.field) break;
    const px = w.player.x | 0, py = w.player.y | 0;
    let best = null, bd = f.field[py * lv.w + px];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = px + dx, ay = py + dy;
      if (ax < 0 || ay < 0 || ax >= lv.w || ay >= lv.h) continue;
      const d = f.field[ay * lv.w + ax];
      if (d >= 0 && d < bd) { bd = d; best = [dx, dy]; }
    }
    if (!best) break;
    w.player.dirX = best[0]; w.player.dirY = best[1];
    w.player.planeX = -best[1] * 0.66; w.player.planeY = best[0] * 0.66;
    w.player.x = px + best[0] + 0.5;
    w.player.y = py + best[1] + 0.5;
    const r = env.step([0, 0, 2, 1, 0, 0, 0]);
    if (r.reward <= 0) negatives++;
    moved++;
    if (r.terminated || r.truncated) break;
  }
  ok(moved > 10, `フロンティアへ ${moved} 歩ぶん前進できた`);
  ok(negatives === 0, `全ステップで報酬が正 (負だったステップ ${negatives}/${moved})`);
}

// ---- 8. 実ステージ (E1M1〜M5) を env2 で回す ----
// 転移学習で使う構成。水路・高さ・ドア・キーカード込みで観測が壊れないこと
console.log('\n[8] 実ステージ x 探索観測 (敵なし・キーカードあり):');
{
  const lcg = s => { let a = s >>> 0; return () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; }; };
  const rnd = lcg(7);
  let bad = 0;
  for (let lv = 0; lv < 5; lv++) {
    const env = new HellgridEnv2({ levels: [lv], noEnemies: true, noItems: true, maxSteps: 200 });
    let o = env.reset(100 + lv);
    for (let t = 0; t < 200; t++) {
      const r = env.step(ACTION_NVEC2.map(n => (rnd() * n) | 0));
      o = r.obs;
      if (r.terminated || r.truncated) break;
    }
    for (let i = 0; i < o.length; i++) {
      if (!Number.isFinite(o[i]) || o[i] < -1.001 || o[i] > 1.001) bad++;
    }
  }
  ok(bad === 0, `E1M1〜M5 で NaN/範囲外なし (${bad}個)`);
  // mazeMix: 同じシードなら迷路/実ステージの選択も含めて決定的
  // 迷路は LEVELS の動的スロット (env ごとに番号が違う) に注入されるので、
  // 「迷路か / どの実ステージか」で比較する
  const mk = () => {
    const env = new HellgridEnv2({ levels: [0, 1, 2, 3, 4], noEnemies: true, mazeMix: 0.5 });
    const kinds = [];
    for (let s = 1; s <= 20; s++) {
      env.reset(s);
      kinds.push(env.world.level.index >= 5 ? 'M' : String(env.world.level.index));
    }
    return kinds.join(',');
  };
  const a = mk(), b = mk();
  ok(a === b, 'mazeMix の選択が決定的 (同シード → 同じ迷路/ステージ列)');
  const mixed = a.includes('M') && /[0-4]/.test(a);
  ok(mixed, `迷路と実ステージが実際に混ざる (${a})`);
  // enemyFraction: エピソードごとに敵密度がばらつき、同シードなら同じ
  const cnt = () => {
    const env = new HellgridEnv2({ levels: [3], enemyFraction: [0.25, 1.0] });
    const ns = [];
    for (let s = 1; s <= 12; s++) { env.reset(s); ns.push(env.world.level.enemies.length); }
    return ns;
  };
  const c1 = cnt(), c2 = cnt();
  const full = new HellgridEnv2({ levels: [3] }); full.reset(1);
  const total = full.world.level.enemies.length;
  ok(c1.join() === c2.join(), `enemyFraction が決定的 (${c1.join(',')})`);
  ok(Math.min(...c1) < Math.max(...c1) && Math.max(...c1) <= total,
    `敵密度がエピソード間でばらつく (全${total}体中 ${Math.min(...c1)}〜${Math.max(...c1)}体)`);
}

// ---- 9. 回復への誘導 (HPゲート付きポテンシャル整形) ----
// 記憶に回復アイテムがあり HP が低いとき、そこへ近づくと正の報酬。
// HP が満タンならゲートが閉じて整形されない
console.log('\n[9] 回復への誘導 (HP低下時の既知マップ整形):');
{
  const { computeHealField } = ctx;
  const mkEnv = (hp, kinds) => {
    const env = new HellgridEnv2({ levels: [0], noEnemies: true, noItems: false, maxSteps: 500 });
    env.reset(3);
    const w = env.world, lv = w.level;
    // 白箱テスト: 全タイルを既知にし、実在するアイテム1個を記憶に注入する
    env.mem.known.fill(1);
    const it = lv.items.find(i => kinds.includes(i.kind));
    const ti = (it.y | 0) * lv.w + (it.x | 0);
    env.mem.itemSeen[ti] = 1;
    env.mem.itemKind[ti] = it.kind.charCodeAt(0);
    env.mem.itemRev++;
    // known を直接書き換えたので、reset 時に張られたフロンティア場を同期し直す
    // (実プレイでは知識が変わる = newTiles > 0 で自動的に張り直される)
    env.frontier = ctx.computeFrontierField(w, env.mem);
    w.player.health = hp;
    env._snapshot();          // prev.hp を反映 (ゲート判定は前後両方を見る)
    return env;
  };
  const walkToward = (env, steps) => {
    const w = env.world, lv = w.level;
    const rewards = [];
    for (let t = 0; t < steps; t++) {
      const f = computeHealField(w, env.mem);
      if (!f.field) break;
      const px = w.player.x | 0, py = w.player.y | 0;
      if (f.field[py * lv.w + px] <= 0) break;
      let best = null, bd = f.field[py * lv.w + px];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ax = px + dx, ay = py + dy;
        if (ax < 0 || ay < 0 || ax >= lv.w || ay >= lv.h) continue;
        const d = f.field[ay * lv.w + ax];
        if (d >= 0 && d < bd) { bd = d; best = [dx, dy]; }
      }
      if (!best || bd < 1) break;   // アイテムを拾う直前で止める (取得報酬を混ぜない)
      w.player.x = px + best[0] + 0.5;
      w.player.y = py + best[1] + 0.5;
      const r = env.step([0, 0, 2, 1, 0, 0, 0]);
      rewards.push(r.reward);
      if (r.terminated || r.truncated) break;
    }
    return rewards;
  };
  const low = walkToward(mkEnv(30, 'hH'), 10);
  ok(low.length >= 5 && low.every(r => r > 0),
    `HP30: 回復へ${low.length}歩、全ステップ正の報酬 (負: ${low.filter(r => r <= 0).length})`);
  // HP満タン: 回復は不要なのでアーマーで場を立てる。healSeek のゲートは閉じている
  const full = walkToward(mkEnv(100, 'pV'), 5);
  ok(full.length >= 3 && full.every(r => r < 0.02),
    `HP100: ゲートが閉じて整形なし (${full.length}歩, 最大報酬 ${full.length ? Math.max(...full).toFixed(3) : '-'})`);
}

// ---- 10. 通し (campaign): ステージ遷移と完走 ----
console.log('\n[10] 通し (campaign モード):');
{
  const exitOf = lv => {
    for (let y = 0; y < lv.h; y++) for (let x = 0; x < lv.w; x++) if (lv.grid[y][x] === 'X') return [x, y];
    return null;
  };
  const pressExit = env => {
    const w = env.world, lv = w.level;
    const [ex, ey] = exitOf(lv);
    // 出口の隣の床に立って出口を向き、E を押す
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = ex + dx, ay = ey + dy;
      if (ax < 0 || ay < 0 || ax >= lv.w || ay >= lv.h || lv.grid[ay][ax] !== null) continue;
      w.player.x = ax + 0.5; w.player.y = ay + 0.5;
      w.player.z = lv.heights[ay][ax];
      w.player.dirX = ex - ax; w.player.dirY = ey - ay;
      w.player.planeX = -w.player.dirY * 0.66; w.player.planeY = w.player.dirX * 0.66;
      return env.step([0, 0, 2, 1, 0, 1, 0]);
    }
    throw new Error('出口の隣に床がない');
  };
  const env = new HellgridEnv2({
    mode: 'campaign', levels: [0], noEnemies: true, noItems: false, maxSteps: 2000,
  });
  env.reset(7);
  env.world.player.health = 55;   // 持ち越しの確認用に減らしておく
  env._snapshot();
  const r1 = pressExit(env);      // E1M1 クリア -> E1M2 へ
  ok(!r1.terminated && env.world.level.index === 1 && r1.info.levelsCleared === 1,
    `E1M1 クリアで終了せず E1M2 へ進む (levelsCleared=${r1.info.levelsCleared})`);
  ok(env.world.player.health === 55, `HP が持ち越される (${env.world.player.health})`);
  ok(env.mem.w === env.world.level.w && env.mem.knownFloor < env.mem.totalFloor,
    `記憶は新しいステージで白紙から (カバレッジ ${(env.mem.knownFloor / env.mem.totalFloor * 100).toFixed(0)}%)`);
  // E1M2 -> M5 を順にクリアして完走まで (キーが要るステージも X 直押しで抜けられる)
  let last = null;
  for (let i = 0; i < 4; i++) last = pressExit(env);
  ok(last.terminated && last.info.levelsCleared === 5,
    `E1M5 で完走・終了 (levelsCleared=${last.info.levelsCleared}, 報酬 ${last.reward.toFixed(1)})`);
  ok(last.reward > 60, `完走ボーナスが出る (+20+50 <= ${last.reward.toFixed(1)})`);
}

// ---- 11. v3: 飛翔弾のレイと被弾方向のスカラー ----
console.log('\n[11] 観測v3 (飛翔弾・被弾方向):');
{
  const { buildObs2, OBS2_DIM } = ctx;
  const RAY_CH = 17, S_OFF = OBS2_DIM - 28;
  const env = new HellgridEnv2({ levels: [0], noEnemies: true, noItems: true, maxSteps: 100 });
  env.reset(5);
  const w = env.world, p = w.player;
  // 正面3タイルから、こちらへ向かってくる火球を注入
  w.level.projectiles.push({
    x: p.x + p.dirX * 3, y: p.y + p.dirY * 3, z: p.z + 0.5,
    dx: -p.dirX * 6, dy: -p.dirY * 6, vz: 0, dmg: [9, 17], t: 0,
  });
  let o = buildObs2(w, env.mem, env.goal, env.obsBuf);
  let best = 1, bi = -1;
  for (let i = 0; i < 24; i++) {
    if (o[i * RAY_CH + 15] < best) { best = o[i * RAY_CH + 15]; bi = i; }
  }
  ok(best < 0.2, `正面の火球がレイに写る (距離 ${(best * 24).toFixed(1)}タイル)`);
  ok(bi >= 0 && o[bi * RAY_CH + 16] > 0.5, `接近速度が正 (${bi >= 0 ? o[bi * RAY_CH + 16].toFixed(2) : '-'})`);
  // 真後ろから撃たれた直後の被弾スカラー
  p.lastHit = { t: w.time, dmg: 20, x: p.x - p.dirX * 3, y: p.y - p.dirY * 3 };
  o = buildObs2(w, env.mem, env.goal, env.obsBuf);
  ok(o[S_OFF + 25] > 0.5, `被弾量スカラー (${o[S_OFF + 25].toFixed(2)})`);
  ok(o[S_OFF + 27] < -0.9, `被弾方向 cos が負 = 背後 (${o[S_OFF + 27].toFixed(2)})`);
  // 2秒経つと薄れて消える
  w.time += 2.5;
  o = buildObs2(w, env.mem, env.goal, env.obsBuf);
  ok(o[S_OFF + 25] === 0 && o[S_OFF + 27] === 0, '被弾情報は2秒で減衰して消える');
}

// ---- 12. キルゲート: 倒すまで出口が作動しない ----
console.log('\n[12] キルゲート (戦闘カリキュラム):');
{
  const env = new HellgridEnv2({
    mazeSize: 13, mazeBraid: 0.15, mazeRooms: 2, mazeEnemies: [2, 2],
    killGate: [1.0, 1.0], maxSteps: 500,
  });
  env.reset(9);
  const w = env.world, lv = w.level;
  ok(lv.enemies.length === 2 && lv.killGate === 2,
    `迷路に敵${lv.enemies.length}体・ゲート${lv.killGate}体`);
  // 出口の隣へテレポートして E → ゲートが閉じているので終わらない
  let ex = -1, ey = -1;
  for (let y = 0; y < lv.h; y++) for (let x = 0; x < lv.w; x++) if (lv.grid[y][x] === 'X') { ex = x; ey = y; }
  const goTo = () => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = ex + dx, ay = ey + dy;
      if (ax < 0 || ay < 0 || ax >= lv.w || ay >= lv.h || lv.grid[ay][ax] !== null) continue;
      w.player.x = ax + 0.5; w.player.y = ay + 0.5; w.player.z = lv.heights[ay][ax];
      w.player.dirX = ex - ax; w.player.dirY = ey - ay;
      w.player.planeX = -w.player.dirY * 0.66; w.player.planeY = w.player.dirX * 0.66;
    }
  };
  goTo();
  let r = env.step([0, 0, 3, 1, 0, 1, 0]);
  ok(!r.terminated && w.state === 'playing', 'ゲートが閉じている間は出口を押しても終わらない');
  // ゲート中は出口が目標にならない (探索が続く)
  ok(env.goal.target !== 'exit', `ゲート中の目標は出口ではない (${env.goal.target})`);
  // 敵を全滅させてから E → クリア
  for (const e of lv.enemies) w.damageEnemy(e, 9999);
  goTo();
  r = env.step([0, 0, 3, 1, 0, 1, 0]);
  ok(r.terminated && r.info.levelsCleared === 1, `全滅後は出口でクリア (報酬 ${r.reward.toFixed(1)})`);

  // 通し + ゲート: 各ステージにゲートがかかり、遷移後も再設定される
  const ce = new HellgridEnv2({
    mode: 'campaign', levels: [0], noEnemies: false, killGate: [0.5, 0.5], maxSteps: 3000,
  });
  ce.reset(3);
  const cl = ce.world.level;
  ok(cl.killGate > 0 && cl.killGate <= cl.totalKills,
    `通しE1M1にゲート ${cl.killGate}/${cl.totalKills}`);

  // ステージ別ゲート上書き: E1M3 (index2) だけゲートなし
  const g3 = new HellgridEnv2({
    levels: [2], noEnemies: false, killGate: [0.5, 0.5], killGateByLevel: { 2: [0, 0] },
  });
  g3.reset(1);
  ok(!g3.world.level.killGate, `E1M3 はゲート上書きで無効 (killGate=${g3.world.level.killGate})`);
  const g1 = new HellgridEnv2({
    levels: [0], noEnemies: false, killGate: [0.5, 0.5], killGateByLevel: { 2: [0, 0] },
  });
  g1.reset(1);
  ok(g1.world.level.killGate > 0, `E1M1 は既定どおりゲートあり (${g1.world.level.killGate})`);
}

// ---- 13. 戦闘スキル強化: 弾薬誘導・火球比率・被弾ペナルティ倍率 ----
console.log('\n[13] 戦闘スキル強化 (弾薬誘導・ストレイフ設定):');
{
  const { computeAmmoField } = ctx;
  // 弾薬誘導: 弾が少なく、記憶に弾薬があれば、そこへ近づくと正の報酬
  const env = new HellgridEnv2({ levels: [0], noEnemies: true, noItems: false, maxSteps: 300 });
  env.reset(3);
  const w = env.world, lv = w.level;
  env.mem.known.fill(1);
  env.frontier = ctx.computeFrontierField(w, env.mem);
  const it = lv.items.find(i => 'aAsS'.includes(i.kind));
  ok(!!it, '弾薬アイテムが存在する');
  if (it) {
    const ti = (it.y | 0) * lv.w + (it.x | 0);
    env.mem.itemSeen[ti] = 1; env.mem.itemKind[ti] = it.kind.charCodeAt(0); env.mem.itemRev++;
    w.player.bullets = 5;    // ammoSeekBelow=20 未満
    env._snapshot();
    const f = computeAmmoField(w, env.mem);
    ok(f.field, '弾薬距離場が張れる');
    // 弾薬へ1歩近づくと正の報酬
    const px = w.player.x | 0, py = w.player.y | 0;
    let best = null, bd = f.field[py * lv.w + px];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = px + dx, ay = py + dy;
      if (ax < 0 || ay < 0 || ax >= lv.w || ay >= lv.h) continue;
      const d = f.field[ay * lv.w + ax];
      if (d >= 0 && d < bd) { bd = d; best = [dx, dy]; }
    }
    if (best && bd >= 1) {
      w.player.x = px + best[0] + 0.5; w.player.y = py + best[1] + 0.5;
      const r = env.step([0, 0, 2, 1, 0, 0, 0]);
      ok(r.reward > 0, `弾薬へ近づくと正の報酬 (${r.reward.toFixed(3)})`);
    } else ok(true, '(弾薬が隣接で近接テストスキップ)');
  }
  // 火球比率: 焔鬼(I)が多く混ざる
  const fire = generateMaze(3, { size: 15, rooms: 2, enemies: [10, 10], fireballRatio: 0.6 });
  const flat = fire.map.join('');
  const imps = (flat.match(/I/g) || []).length, total = (flat.match(/[ZIG]/g) || []).length;
  ok(total >= 8 && imps / total > 0.4, `火球持ちが多数 (焔鬼 ${imps}/${total})`);
  // 被弾ペナルティ倍率: hpDamageScale=2 で被弾報酬が2倍マイナス
  const e2 = new HellgridEnv2({ levels: [0], noEnemies: true, hpDamageScale: 2.0, maxSteps: 100 });
  e2.reset(1); e2.world.player.health = 100; e2._snapshot();
  e2.world.player.health = 80;   // -20 HP
  const r2 = e2.step([0, 0, 2, 1, 0, 0, 0]);
  const e3 = new HellgridEnv2({ levels: [0], noEnemies: true, hpDamageScale: 1.0, maxSteps: 100 });
  e3.reset(1); e3.world.player.health = 100; e3._snapshot();
  e3.world.player.health = 80;
  const r3 = e3.step([0, 0, 2, 1, 0, 0, 0]);
  ok(r2.reward < r3.reward - 0.3, `被弾ペナルティ2倍が効く (scale2 ${r2.reward.toFixed(2)} < scale1 ${r3.reward.toFixed(2)})`);
}

// ---- 14. 銃使用促進: ナイフの至近2倍除外 + 遠距離キル加点 ----
console.log('\n[14] 銃使用促進 (ナイフ密着ボーナス除外・遠距離キル加点):');
{
  // 敵を固定位置に置いて武器と距離だけ変え、キル報酬を測る。prev を _snapshot で
  // 敵が生存の状態に固定し、死体は動かない性質を使って距離を保つ
  const killRew = (weapon, dist, seed = 7) => {
    const env = new HellgridEnv2({ mazeSize: 13, mazeRooms: 3, mazeEnemies: [1, 1], maxSteps: 500 });
    env.reset(seed);
    const w = env.world, lv = w.level, p = w.player, e = lv.enemies[0];
    e.hp = 60;
    env._snapshot();          // prev.enemyHpArr[0] = 60 (生存)
    p.weapon = weapon;
    e.x = p.x + dist; e.y = p.y;
    w.damageEnemy(e, 9999);   // 撃破 (死体は frameSkip で動かない)
    return env.step([0, 0, 2, 1, 0, 0, 0]).reward;   // 移動/射撃なしの no-op
  };
  const kc = killRew('knife', 0.5), pc = killRew('pistol', 0.5);
  const kf = killRew('knife', 5), pf = killRew('pistol', 5);
  // ナイフは距離重みを受けない (至近2倍から除外) ので、至近も遠距離も同じキル報酬
  ok(Math.abs(kc - kf) < 1e-6, `ナイフは距離で報酬が変わらない (至近 ${kc.toFixed(2)} = 遠 ${kf.toFixed(2)})`);
  // 同じ至近距離では銃のキル報酬がナイフを上回る (密着ハックの是正)
  ok(pc > kc + 1.0, `至近で銃 > ナイフ (ピストル ${pc.toFixed(2)} > ナイフ ${kc.toFixed(2)})`);
  // 遠距離でも銃がナイフを上回る = 遠距離キル加点 (rangedKillBonus) が乗る
  ok(pf > kf + 1.0, `遠距離で銃 > ナイフ (ピストル ${pf.toFixed(2)} > ナイフ ${kf.toFixed(2)})`);
}

// ---- 15. 回復ゲート閾値の cfg 上書き (消耗対策) ----
console.log('\n[15] 回復ゲート閾値の上書き (healSeekBelow):');
{
  // healSeekBelow=80 なら HP70 で回復場が張られ、既定(60)では張られない
  const mk = (below) => {
    const cfg = { levels: [0], noEnemies: false, noItems: false, maxSteps: 300 };
    if (below != null) cfg.healSeekBelow = below;
    const env = new HellgridEnv2(cfg);
    env.reset(3);
    env.world.player.health = 70;   // 60 < 70 < 80
    env._snapshot();
    env.world.player.health = 70;
    env.step([0, 0, 2, 1, 0, 0, 0]);
    return env.healField;   // 張られていれば非 null
  };
  ok(mk(null) === null, 'HP70・既定閾値(60) では回復場が張られない');
  ok(mk(80) !== null, 'HP70・閾値80 では回復場が張られる');
}

// ---- 16. ナイフ弱体化 (knifeDamageScale) ----
console.log('\n[16] ナイフ弱体化 (knifeDamageScale):');
{
  // プレイヤーの正面にダミー敵を置き、ナイフ一振りのダメージを scale 別に測る。
  // 同一シード + 同一セットアップなので damage の RNG ロールも一致し、比は scale に等しい
  const knifeHit = (scale) => {
    const env = new HellgridEnv2({ mazeSize: 13, mazeRooms: 3, mazeEnemies: [1, 1], knifeDamageScale: scale, maxSteps: 100 });
    env.reset(5);
    const w = env.world, p = w.player, e = w.level.enemies[0];
    p.pitch = 0;
    e.x = p.x + p.dirX * 1.0; e.y = p.y + p.dirY * 1.0; e.z = p.z;
    e.state = 'idle'; e.dormant = false; e.hp = 1000;
    p.weapon = 'knife'; p.shootCd = 0;
    const before = e.hp;
    w.tryShoot();
    return before - e.hp;
  };
  const d1 = knifeHit(1), d035 = knifeHit(0.35);
  ok(d1 > 0, `既定(1)でナイフが命中してダメージ (${d1.toFixed(1)})`);
  ok(d035 > 0 && d035 < d1 * 0.5, `scale0.35 でダメージが大きく減る (${d035.toFixed(1)} < ${(d1 * 0.5).toFixed(1)})`);
}

// ---- 17. 銃キルゲート (gunKillGate): 銃キルのみが出口を開ける ----
console.log('\n[17] 銃キルゲート (gunKillGate):');
{
  const setup = (gunGate) => {
    const env = new HellgridEnv2({
      mazeSize: 13, mazeBraid: 0.15, mazeRooms: 2, mazeEnemies: [3, 3],
      killGate: [1.0, 1.0], gunKillGate: gunGate, maxSteps: 500,
    });
    env.reset(9);
    return env;
  };
  const goExit = (env) => {
    const w = env.world, lv = w.level;
    let ex = -1, ey = -1;
    for (let y = 0; y < lv.h; y++) for (let x = 0; x < lv.w; x++) if (lv.grid[y][x] === 'X') { ex = x; ey = y; }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = ex + dx, ay = ey + dy;
      if (ax < 0 || ay < 0 || ax >= lv.w || ay >= lv.h || lv.grid[ay][ax] !== null) continue;
      w.player.x = ax + 0.5; w.player.y = ay + 0.5; w.player.z = lv.heights[ay][ax];
      w.player.dirX = ex - ax; w.player.dirY = ey - ay;
      w.player.planeX = -w.player.dirY * 0.66; w.player.planeY = w.player.dirX * 0.66;
    }
  };
  // (a) gunKillGate ON + ナイフ全滅 → gunKills=0 なので出口は開かない
  const ea = setup(true);
  const wa = ea.world, la = wa.level;
  ok(la.killGate === 3 && wa.gunKillGate === true, `銃ゲート有効・ゲート3 (${la.killGate})`);
  for (const e of la.enemies) { wa._dmgIsGun = false; wa.damageEnemy(e, 9999); }
  ok(la.kills === 3 && la.gunKills === 0, `ナイフ3キルで kills=3・gunKills=0`);
  goExit(ea);
  let r = ea.step([0, 0, 3, 1, 0, 1, 0]);
  ok(!r.terminated, `銃ゲート中はナイフ全滅でも出口が開かない`);
  // (b) gunKillGate ON + 銃キル → gunKills 進行・出口が開く
  const eb = setup(true);
  const wb = eb.world, lb = wb.level;
  for (const e of lb.enemies) { wb._dmgIsGun = true; wb.damageEnemy(e, 9999); }
  ok(lb.gunKills === 3, `銃3キルで gunKills=3`);
  goExit(eb);
  r = eb.step([0, 0, 3, 1, 0, 1, 0]);
  ok(r.terminated && r.info.levelsCleared === 1, `銃キルで出口が開く (報酬 ${r.reward.toFixed(1)})`);
  // (c) デフォルト (gunKillGate off) はナイフキルで従来どおり開く (退行なし)
  const ec = setup(false);
  const wc = ec.world, lc = wc.level;
  ok(!wc.gunKillGate, `デフォルトは銃ゲート無効`);
  for (const e of lc.enemies) { wc._dmgIsGun = false; wc.damageEnemy(e, 9999); }
  goExit(ec);
  r = ec.step([0, 0, 3, 1, 0, 1, 0]);
  ok(r.terminated && r.info.levelsCleared === 1, `デフォルトはナイフキルで出口が開く (従来不変)`);
}

// ---- 18. 銃キル直接ボーナス (gunKillBonus) ----
console.log('\n[18] 銃キル直接ボーナス (gunKillBonus):');
{
  // section14 と同じ手法でキル報酬を測る。gunKillBonus は銃キルにのみ乗る
  const killRew = (weapon, bonus) => {
    const env = new HellgridEnv2({ mazeSize: 13, mazeRooms: 3, mazeEnemies: [1, 1], gunKillBonus: bonus, maxSteps: 500 });
    env.reset(7);
    const w = env.world, lv = w.level, p = w.player, e = lv.enemies[0];
    e.hp = 60; env._snapshot();
    p.weapon = weapon; e.x = p.x + 2; e.y = p.y;   // 至近(距離2)で武器差だけ見る
    w.damageEnemy(e, 9999);
    return env.step([0, 0, 2, 1, 0, 0, 0]).reward;
  };
  const gun0 = killRew('pistol', 0), gun1 = killRew('pistol', 1.0);
  const knife1 = killRew('knife', 1.0), knife0 = killRew('knife', 0);
  ok(Math.abs((gun1 - gun0) - 1.0) < 1e-6, `銃キルに gunKillBonus 1.0 が乗る (${(gun1 - gun0).toFixed(2)})`);
  ok(Math.abs(knife1 - knife0) < 1e-6, `ナイフキルには乗らない (差 ${(knife1 - knife0).toFixed(2)})`);
}

console.log(failures ? `\nNG ${failures}件の失敗` : '\nすべてOK');
process.exitCode = failures ? 1 : 0;
