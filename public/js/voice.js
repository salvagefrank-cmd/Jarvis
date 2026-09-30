/**
 * Browser speech: continuous recognition (for the wake word + commands)
 * and speech synthesis (Jarvis's voice).
 */

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
export const recognitionSupported = Boolean(SpeechRecognitionImpl);
export const synthesisSupported = 'speechSynthesis' in window;

// Errors after which retrying is pointless until the user changes something.
const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported']);

/**
 * Keeps a SpeechRecognition session alive. Chrome ends "continuous" sessions after a
 * pause or about a minute, so we restart them, backing off if they keep failing fast.
 */
export class Recognizer {
  constructor({ lang, onResult, onError } = {}) {
    this.lang = lang || navigator.language || 'en-US';
    this.onResult = onResult;
    this.onError = onError;
    this.wanted = false;
    this.rec = null;
    this.failures = 0;
    this.startedAt = 0;
    this.restartTimer = null;
  }

  start() {
    if (this.wanted || !recognitionSupported) return;
    this.wanted = true;
    this.failures = 0;
    this.spawn();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    try {
      this.rec?.abort();
    } catch {
      /* already stopped */
    }
  }

  spawn() {
    if (!this.wanted || this.rec) return;
    const rec = new SpeechRecognitionImpl();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    rec.lang = this.lang;

    rec.onresult = (event) => {
      this.failures = 0;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcripts = Array.from(result, (alt) => alt.transcript);
        this.onResult?.({
          transcript: transcripts[0] || '',
          alternatives: transcripts.slice(1),
          isFinal: result.isFinal,
        });
      }
    };
    rec.onerror = (event) => {
      if (FATAL_ERRORS.has(event.error)) this.wanted = false;
      if (event.error !== 'no-speech' && event.error !== 'aborted') this.onError?.(event.error);
    };
    rec.onend = () => {
      this.rec = null;
      if (!this.wanted) return;
      const quick = performance.now() - this.startedAt < 1500;
      this.failures = quick ? this.failures + 1 : 0;
      this.restartTimer = setTimeout(() => this.spawn(), Math.min(8000, 150 * 2 ** this.failures));
    };

    this.rec = rec;
    this.startedAt = performance.now();
    try {
      rec.start();
    } catch {
      this.rec = null;
      this.restartTimer = setTimeout(() => this.spawn(), 1000);
    }
  }
}

/* ------------------------------------------------------------------ */

// Voices that sound most like the films' British butler, best first.
const PREFERRED_VOICES = [
  /Google UK English Male/i,
  /Microsoft Ryan Online/i,
  /Microsoft Thomas Online/i,
  /Microsoft George/i,
  /Microsoft Ryan/i,
  /^Daniel\b/i,
  /^Arthur\b/i,
  /^Oliver\b/i,
  /Microsoft Guy Online/i,
];

export function pickDefaultVoice(voices) {
  for (const pattern of PREFERRED_VOICES) {
    const voice = voices.find((v) => pattern.test(v.name));
    if (voice) return voice;
  }
  return (
    voices.find((v) => /^en[-_]GB/i.test(v.lang)) ||
    voices.find((v) => /^en/i.test(v.lang)) ||
    voices[0] ||
    null
  );
}

function splitSentences(text) {
  if (Intl.Segmenter) {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    return Array.from(segmenter.segment(text), (s) => s.segment.trim()).filter(Boolean);
  }
  return text.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((s) => s.trim()) || [text];
}

/** Chrome cuts off long utterances, so speak in chunks of whole sentences. */
function chunkText(text, max = 180) {
  const chunks = [];
  let current = '';
  const push = (piece) => {
    if (current && current.length + piece.length + 1 > max) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  };
  for (const sentence of splitSentences(text)) {
    if (sentence.length <= max) {
      push(sentence);
      continue;
    }
    for (const clause of sentence.split(/(?<=[,;:])\s+/)) push(clause);
  }
  if (current) chunks.push(current);
  return chunks;
}

function estimateMs(text, rate) {
  const words = text.split(/\s+/).length;
  return (words / (2.7 * rate)) * 1000 + 400;
}

export class Speaker {
  constructor() {
    this.synth = synthesisSupported ? window.speechSynthesis : null;
    this.voices = [];
    this.voiceName = '';
    this.rate = 1;
    this.pitch = 0.95;
    this.token = 0;
    this.finishChunk = null;
    this.onVoicesChanged = null;
    if (this.synth) {
      this.refreshVoices();
      this.synth.addEventListener('voiceschanged', () => this.refreshVoices());
    }
  }

  refreshVoices() {
    this.voices = this.synth.getVoices();
    this.onVoicesChanged?.(this.voices);
  }

  get voice() {
    return this.voices.find((v) => v.name === this.voiceName) || pickDefaultVoice(this.voices);
  }

  cancel() {
    this.token++;
    this.synth?.cancel();
    this.finishChunk?.();
  }

  /** Speak `text`. Resolves true when finished, false if interrupted. */
  async speak(text, { onBoundary } = {}) {
    this.cancel();
    const token = this.token;
    for (const chunk of chunkText(text)) {
      if (token !== this.token) return false;
      await this.speakChunk(chunk, onBoundary);
    }
    return token === this.token;
  }

  speakChunk(chunk, onBoundary) {
    return new Promise((resolve) => {
      let watchdog;
      const done = () => {
        clearTimeout(watchdog);
        if (this.finishChunk === done) this.finishChunk = null;
        resolve();
      };
      this.finishChunk = done;
      const expected = estimateMs(chunk, this.rate);

      if (!this.synth) {
        // No speech engine: keep the waveform "talking" for roughly as long as the text would take.
        watchdog = setTimeout(done, expected);
        return;
      }

      const utterance = new SpeechSynthesisUtterance(chunk);
      const voice = this.voice;
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = this.rate;
      utterance.pitch = this.pitch;
      utterance.onend = done;
      utterance.onerror = done;
      utterance.onboundary = (event) => {
        if (!event.name || event.name === 'word') onBoundary?.(event);
      };
      // Some engines never fire onend; don't get stuck "speaking" forever.
      watchdog = setTimeout(done, expected * 2 + 4000);
      if (this.synth.paused) this.synth.resume();
      this.synth.speak(utterance);
    });
  }
}

/* ------------------------------------------------------------------ */

/**
 * The speech engine doesn't expose its audio, so this generates a
 * syllable-like loudness envelope to drive the talking waveform.
 * Word-boundary events (when the voice provides them) add extra punch.
 */
export class SpeechEnvelope {
  constructor() {
    this.active = false;
    this.value = 0;
    this.target = 0;
    this.kick = 0;
    this.nextChange = 0;
    this.last = 0;
  }

  start() {
    this.active = true;
  }

  stop() {
    this.active = false;
  }

  pulse() {
    this.kick = 1;
  }

  sample(now = performance.now()) {
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;

    if (!this.active) {
      this.target = 0;
    } else if (now >= this.nextChange) {
      const pause = Math.random() < 0.12;
      this.target = pause ? 0.04 + Math.random() * 0.08 : 0.35 + Math.random() * 0.65;
      this.nextChange = now + (pause ? 120 + Math.random() * 160 : 70 + Math.random() * 120);
    }

    const rate = this.target > this.value ? 22 : 9;
    this.value += (this.target - this.value) * (1 - Math.exp(-dt * rate));
    this.kick *= Math.exp(-dt * 8);
    return Math.min(1, this.value * 0.85 + this.kick * 0.25);
  }
}
