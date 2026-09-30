/**
 * Arc-reactor HUD with a "talking" sound wave, drawn on a canvas.
 *
 * Each frame the visualizer asks its `source(mode)` callback for { level, spectrum }:
 * live microphone data while listening, a synthetic speech envelope while Jarvis talks.
 */

const TAU = Math.PI * 2;
const HALF_BARS = 48;
const BAR_GAP = (7 * Math.PI) / 180; // keep bars clear of the horizontal wave line

const PALETTES = {
  offline: { main: [80, 130, 160], accent: [110, 160, 185], glow: 0.3 },
  standby: { main: [0, 196, 255], accent: [120, 228, 255], glow: 0.6 },
  listening: { main: [70, 230, 255], accent: [200, 252, 255], glow: 1 },
  thinking: { main: [0, 186, 255], accent: [255, 176, 58], glow: 0.8 },
  speaking: { main: [40, 220, 255], accent: [175, 246, 255], glow: 0.95 },
  error: { main: [255, 84, 84], accent: [255, 150, 100], glow: 0.9 },
};

const SPIN = { offline: 0.25, standby: 1, listening: 1.6, thinking: 5, speaking: 1.2, error: 1 };

// Layered sine curves; the first is the bright lead line.
const WAVES = [
  { amp: 1.0, freq: 6.0, speed: 2.1, width: 2.4, alpha: 1.0 },
  { amp: -0.72, freq: 7.4, speed: 2.7, width: 1.6, alpha: 0.65 },
  { amp: 0.46, freq: 4.2, speed: 1.5, width: 1.3, alpha: 0.5 },
  { amp: -0.3, freq: 9.3, speed: 3.4, width: 1.0, alpha: 0.35 },
  { amp: 0.18, freq: 11.8, speed: 4.1, width: 0.8, alpha: 0.25 },
];

const ARC_SEGMENTS = [
  [0, 0.8],
  [1.0, 1.7],
  [2.05, 3.3],
  [3.55, 3.85],
  [4.2, 5.75],
];

const clamp01 = (v) => Math.min(1, Math.max(0, v || 0));
const rgba = (c, a) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${clamp01(a).toFixed(3)})`;

export class Visualizer {
  constructor(canvas, { source } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.source = source || (() => ({ level: 0 }));
    this.mode = 'offline';
    this.flashMode = null;
    this.flashUntil = 0;

    this.main = [...PALETTES.offline.main];
    this.accent = [...PALETTES.offline.accent];
    this.glow = PALETTES.offline.glow;
    this.spin = SPIN.offline;
    this.thinkMix = 0;
    this.level = 0;
    this.rotation = 0;
    this.phases = WAVES.map((_, i) => i * 1.3);
    this.bars = new Float32Array(HALF_BARS);
    this.last = null;

    this.motion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0.3 : 1;

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  setMode(mode) {
    this.mode = mode in PALETTES ? mode : 'standby';
  }

  flash(mode = 'error', ms = 700) {
    this.flashMode = mode;
    this.flashUntil = performance.now() + ms;
  }

  start() {
    const loop = (now) => {
      this.frame(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  frame(now) {
    const dt = Math.min(0.05, (now - (this.last ?? now)) / 1000);
    this.last = now;
    const t = now / 1000;
    const mode = now < this.flashUntil ? this.flashMode : this.mode;
    const palette = PALETTES[mode];

    // Ease colours, glow and spin towards the current mode.
    const ease = 1 - Math.exp(-dt * 5);
    for (let i = 0; i < 3; i++) {
      this.main[i] += (palette.main[i] - this.main[i]) * ease;
      this.accent[i] += (palette.accent[i] - this.accent[i]) * ease;
    }
    this.glow += (palette.glow - this.glow) * ease;
    this.spin += (SPIN[mode] - this.spin) * ease;
    this.thinkMix += ((mode === 'thinking' ? 1 : 0) - this.thinkMix) * ease;

    const { level = 0, spectrum = null } = this.source(this.mode) || {};
    const target = clamp01(level);
    const attack = target > this.level ? 20 : 7;
    this.level += (target - this.level) * (1 - Math.exp(-dt * attack));

    this.rotation += dt * this.spin * this.motion;
    const waveSpeed = (0.6 + this.level * 2.4) * this.motion;
    WAVES.forEach((wave, i) => {
      this.phases[i] += dt * wave.speed * waveSpeed;
    });
    this.updateBars(spectrum, dt, t);
    this.draw(t);
  }

  updateBars(spectrum, dt, t) {
    for (let i = 0; i < HALF_BARS; i++) {
      let target;
      if (spectrum) {
        target = spectrum[Math.floor((i / HALF_BARS) * spectrum.length)] * (0.35 + this.level * 1.3);
      } else {
        const noise = 0.5 + 0.5 * Math.sin(t * 7.3 + i * 0.9) * Math.sin(t * 3.1 + i * 0.37);
        target = this.level * (0.2 + 0.8 * noise);
      }
      target = clamp01(target);
      const rate = target > this.bars[i] ? 25 : 8;
      this.bars[i] += (target - this.bars[i]) * (1 - Math.exp(-dt * rate));
    }
  }

  draw(t) {
    const { ctx, width: w, height: h } = this;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.28;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    this.drawAura(cx, cy, R);
    this.drawBaseline(cx, cy, w);
    this.drawRings(cx, cy, R);
    this.drawBars(cx, cy, R);
    this.drawCore(cx, cy, R);
    this.drawWave(cx, cy, R, w, t);
    ctx.restore();
  }

  drawAura(cx, cy, R) {
    const { ctx } = this;
    const aura = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.9);
    aura.addColorStop(0, rgba(this.main, 0.16 * this.glow + this.level * 0.12));
    aura.addColorStop(0.5, rgba(this.main, 0.05 * this.glow));
    aura.addColorStop(1, rgba(this.main, 0));
    ctx.fillStyle = aura;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  drawBaseline(cx, cy, w) {
    const { ctx } = this;
    const line = ctx.createLinearGradient(0, 0, w, 0);
    line.addColorStop(0, rgba(this.main, 0));
    line.addColorStop(0.5, rgba(this.main, 0.35 * this.glow));
    line.addColorStop(1, rgba(this.main, 0));
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy);
    for (let n = 1, x = 16; x < w / 2; n++, x += 16) {
      const size = n % 5 === 0 ? 6 : 2.5;
      ctx.moveTo(cx + x, cy - size);
      ctx.lineTo(cx + x, cy + size);
      ctx.moveTo(cx - x, cy - size);
      ctx.lineTo(cx - x, cy + size);
    }
    ctx.stroke();
  }

  drawRings(cx, cy, R) {
    const { ctx, rotation: rot, glow } = this;
    const point = (angle, radius) => [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
    const tick = (angle, r1, r2) => {
      ctx.moveTo(...point(angle, r1));
      ctx.lineTo(...point(angle, r2));
    };

    // Outer tick ring.
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(this.main, 0.12 + 0.25 * glow);
    ctx.beginPath();
    for (let i = 0; i < 120; i++) {
      if (i % 10) tick((i / 120) * TAU + rot * 0.12, R * 1.2, R * 1.235);
    }
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgba(this.accent, 0.3 + 0.45 * glow);
    ctx.beginPath();
    for (let i = 0; i < 12; i++) tick((i / 12) * TAU + rot * 0.12, R * 1.19, R * 1.27);
    ctx.stroke();

    // Segmented arcs, counter-rotating.
    ctx.lineWidth = Math.max(2, R * 0.022);
    ctx.strokeStyle = rgba(this.main, 0.25 + 0.5 * glow);
    ctx.beginPath();
    for (const [start, end] of ARC_SEGMENTS) {
      const a = start - rot * 0.35;
      ctx.moveTo(...point(a, R * 1.1));
      ctx.arc(cx, cy, R * 1.1, a, end - rot * 0.35);
    }
    ctx.stroke();

    // Main ring with a soft glow pass.
    const ring = (width, alpha) => {
      ctx.lineWidth = width;
      ctx.strokeStyle = rgba(this.accent, alpha);
      ctx.beginPath();
      for (let q = 0; q < 4; q++) {
        const a = (q / 4) * TAU + rot * 0.05 + 0.04;
        ctx.moveTo(...point(a, R));
        ctx.arc(cx, cy, R, a, a + TAU / 4 - 0.08);
      }
      ctx.stroke();
    };
    ring(Math.max(8, R * 0.08), 0.05 + 0.08 * glow + this.level * 0.1);
    ring(2, 0.35 + 0.55 * glow);

    // Dashed inner ring.
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(this.main, 0.2 + 0.35 * glow);
    ctx.setLineDash([R * 0.03, R * 0.06]);
    ctx.lineDashOffset = -rot * R * 0.25;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.84, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);

    // Innermost ring with three notches (arc reactor).
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(this.main, 0.15 + 0.25 * glow);
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.66, 0, TAU);
    for (let i = 0; i < 3; i++) tick((i / 3) * TAU - rot * 0.2 - Math.PI / 2, R * 0.6, R * 0.72);
    ctx.stroke();

    // Amber "processing" arcs while searching.
    if (this.thinkMix > 0.01) {
      ctx.strokeStyle = rgba([255, 176, 58], 0.85 * this.thinkMix);
      ctx.lineWidth = Math.max(3, R * 0.03);
      ctx.beginPath();
      for (const offset of [0, Math.PI]) {
        const a = rot * 0.9 + offset;
        ctx.moveTo(...point(a, R * 1.1));
        ctx.arc(cx, cy, R * 1.1, a, a + 1.1);
      }
      const b = -rot * 1.3;
      ctx.moveTo(...point(b, R * 0.84));
      ctx.arc(cx, cy, R * 0.84, b, b + 0.7);
      ctx.stroke();
    }
  }

  drawBars(cx, cy, R) {
    const { ctx } = this;
    const r0 = R * 1.32;
    const maxLen = R * 0.34;
    const gradient = ctx.createRadialGradient(cx, cy, r0, cx, cy, r0 + maxLen);
    gradient.addColorStop(0, rgba(this.accent, 0.35 + 0.55 * this.glow));
    gradient.addColorStop(1, rgba(this.main, 0.1));
    ctx.strokeStyle = gradient;
    ctx.lineWidth = Math.max(1.5, R * 0.014);
    ctx.beginPath();
    for (let i = 0; i < HALF_BARS; i++) {
      const offset = BAR_GAP + ((i + 0.5) / HALF_BARS) * (Math.PI - 2 * BAR_GAP);
      const len = 1.5 + this.bars[i] * maxLen;
      for (const angle of [-Math.PI / 2 + offset, -Math.PI / 2 - offset]) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        ctx.moveTo(cx + cos * r0, cy + sin * r0);
        ctx.lineTo(cx + cos * (r0 + len), cy + sin * (r0 + len));
      }
    }
    ctx.stroke();
  }

  drawCore(cx, cy, R) {
    const { ctx } = this;
    const coreR = R * 0.56;
    const intensity = (0.25 + this.level * 0.75) * this.glow;
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    core.addColorStop(0, `rgba(235, 252, 255, ${(0.5 * intensity).toFixed(3)})`);
    core.addColorStop(0.25, rgba(this.accent, 0.3 * intensity));
    core.addColorStop(0.7, rgba(this.main, 0.1 * intensity));
    core.addColorStop(1, rgba(this.main, 0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TAU);
    ctx.fill();
  }

  drawWave(cx, cy, R, w, t) {
    const { ctx } = this;
    const halfW = Math.max(40, Math.min(w / 2 - 8, R * 2.9));
    const idle = this.mode === 'offline' ? 0.012 : 0.03 + 0.015 * Math.sin(t * 1.6);
    const amp = R * 0.9 * Math.min(1, idle + this.level);

    for (let i = WAVES.length - 1; i >= 0; i--) {
      const wave = WAVES[i];
      // Slowly morph each layer so the shape never repeats exactly — reads as a voice.
      const morph = 0.7 + 0.3 * Math.sin(t * (0.8 + i * 0.41) + i * 1.7);
      const a = amp * wave.amp * morph;
      ctx.beginPath();
      for (let px = -halfW; px <= halfW; px += 2) {
        const x = (px / halfW) * 2;
        const attenuation = (4 / (4 + x ** 4)) ** 4;
        const y = cy + a * attenuation * Math.sin(wave.freq * x - this.phases[i]);
        if (px === -halfW) ctx.moveTo(cx + px, y);
        else ctx.lineTo(cx + px, y);
      }
      const color = i === 0 ? this.accent : this.main;
      ctx.lineWidth = wave.width * 4;
      ctx.strokeStyle = rgba(color, wave.alpha * 0.12 * this.glow);
      ctx.stroke();
      ctx.lineWidth = wave.width;
      ctx.strokeStyle = rgba(color, wave.alpha * (0.45 + 0.55 * this.glow));
      ctx.stroke();

      if (i === 0) {
        ctx.lineTo(cx + halfW, cy);
        ctx.lineTo(cx - halfW, cy);
        ctx.closePath();
        ctx.fillStyle = rgba(this.accent, 0.07 * this.glow);
        ctx.fill();
      }
    }
  }
}
