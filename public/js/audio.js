/**
 * Microphone level/spectrum (for the live waveform) and the HUD's interface chimes.
 */

const CHIMES = {
  wake: [
    [660, 0.0, 0.09],
    [990, 0.08, 0.14],
  ],
  done: [
    [880, 0.0, 0.08],
    [587, 0.07, 0.12],
  ],
  error: [
    [220, 0.0, 0.16],
    [196, 0.14, 0.2],
  ],
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.timeData = null;
    this.freqData = null;
    this.muted = false;
  }

  get micReady() {
    return Boolean(this.analyser);
  }

  async init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  async enableMic() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('Microphone API unavailable'), { name: 'NotSupportedError' });
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (!this.ctx) return;
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
    source.connect(this.analyser);
    this.timeData = new Float32Array(this.analyser.fftSize);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
  }

  setMuted(muted) {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  /** Loudness as 0..1 plus the raw dBFS value. */
  readLevel() {
    if (!this.analyser || this.muted) return { level: 0, db: -Infinity };
    this.analyser.getFloatTimeDomainData(this.timeData);
    let sum = 0;
    for (const sample of this.timeData) sum += sample * sample;
    const rms = Math.sqrt(sum / this.timeData.length);
    const db = 20 * Math.log10(rms || 1e-8);
    const level = Math.min(1, Math.max(0, (db + 58) / 46));
    return { level, db };
  }

  /** Energy in `bins` bands across the voice range (~80 Hz – 4 kHz), each 0..1. */
  readSpectrum(bins) {
    if (!this.analyser || this.muted) return null;
    this.analyser.getByteFrequencyData(this.freqData);
    const hzPerBin = this.ctx.sampleRate / 2 / this.freqData.length;
    const lo = Math.max(1, Math.floor(80 / hzPerBin));
    const hi = Math.min(this.freqData.length, Math.ceil(4000 / hzPerBin));
    const out = new Float32Array(bins);
    const span = (hi - lo) / bins;
    for (let i = 0; i < bins; i++) {
      const start = Math.floor(lo + i * span);
      const end = Math.max(start + 1, Math.floor(lo + (i + 1) * span));
      let peak = 0;
      for (let j = start; j < end; j++) peak = Math.max(peak, this.freqData[j]);
      out[i] = peak / 255;
    }
    return out;
  }

  chime(kind) {
    const notes = CHIMES[kind];
    if (!this.ctx || !notes) return;
    const now = this.ctx.currentTime;
    for (const [freq, offset, length] of notes) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = kind === 'error' ? 'triangle' : 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + length);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + length + 0.02);
    }
  }
}
