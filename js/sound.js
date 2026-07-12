'use strict';
/* =========================================================================
 * サウンド (WebAudio 手続き生成)。World が emit した 'sound' イベントを
 * main.js が受けて Sound[name]() を呼ぶ。シミュレーションからは切り離されている。
 * ========================================================================= */
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

globalThis.Sound = Sound;
