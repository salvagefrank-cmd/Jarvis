import { AudioEngine } from './audio.js';
import { findWake, greetingFor, interpretCommand, isEcho } from './skills.js';
import { Visualizer } from './visualizer.js';
import { Recognizer, SpeechEnvelope, Speaker, recognitionSupported, synthesisSupported } from './voice.js';

const LISTEN_TIMEOUT_MS = 8000;
const LOG_LIMIT = 40;
const SETTINGS_KEY = 'jarvis.settings';

const $ = (id) => document.getElementById(id);
const els = {
  canvas: $('hud'),
  reactor: $('reactor'),
  statusText: $('status-text'),
  statusHint: $('status-hint'),
  transcript: $('transcript'),
  notice: $('notice'),
  response: $('response'),
  responseTag: $('response-tag'),
  responseQuery: $('response-query'),
  answer: $('answer'),
  answerSource: $('answer-source'),
  results: $('results'),
  googleLink: $('google-link'),
  log: $('log'),
  form: $('command-form'),
  input: $('command-input'),
  micToggle: $('mic-toggle'),
  settingsToggle: $('settings-toggle'),
  settings: $('settings'),
  voiceSelect: $('setting-voice'),
  rate: $('setting-rate'),
  rateValue: $('setting-rate-value'),
  honorific: $('setting-honorific'),
  testVoice: $('setting-test'),
  sysCore: $('sys-core'),
  sysMic: $('sys-mic'),
  sysVoice: $('sys-voice'),
  sysSearch: $('sys-search'),
  sysWake: $('sys-wake'),
  micMeter: $('mic-meter'),
  micDb: $('mic-db'),
  clockTime: $('clock-time'),
  clockDate: $('clock-date'),
};

/* ------------------------------------------------------------------ */
/* Settings (per-browser convenience only)                             */
/* ------------------------------------------------------------------ */

function loadSettings() {
  const defaults = { voice: '', rate: 1, honorific: 'sir' };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable: settings last for this visit only */
  }
}

const settings = loadSettings();

/* ------------------------------------------------------------------ */
/* Engines                                                             */
/* ------------------------------------------------------------------ */

const audio = new AudioEngine();
const speaker = new Speaker();
const envelope = new SpeechEnvelope();
speaker.voiceName = settings.voice;
speaker.rate = settings.rate;

const app = {
  state: 'offline',
  initialized: false,
  initializing: false,
  muted: false,
  micStatus: 'idle',
  listenTimer: null,
  speechToken: 0,
  requestId: 0,
  currentSpeech: '',
  provider: null,
};

let recognizer = null;

const visualizer = new Visualizer(els.canvas, { source: levelFor });
visualizer.start();

function levelFor(mode) {
  if (mode === 'speaking') return { level: envelope.sample() };
  if (mode === 'thinking') return { level: 0.1 + 0.06 * Math.sin(performance.now() / 110) };
  if (mode === 'listening' || mode === 'standby') {
    const { level } = audio.readLevel();
    // Quieter response while only waiting for the wake word.
    return { level: mode === 'standby' ? level * 0.45 : level, spectrum: audio.readSpectrum(24) };
  }
  return { level: 0 };
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const restingState = () => (app.initialized ? 'standby' : 'offline');
const addressSuffix = () => (settings.honorific ? `, ${settings.honorific}` : '');
const voiceActive = () => Boolean(recognizer) && !app.muted;

function statusCopy(state) {
  switch (state) {
    case 'offline':
      return ['System offline', 'Tap the reactor to initialize'];
    case 'standby':
      if (voiceActive()) return ['Standing by', 'Say “Hey Jarvis” — or tap the reactor'];
      return ['Standing by', app.muted ? 'Microphone off — type a question below' : 'Type a question below'];
    case 'listening':
      return ['Listening', 'Go ahead — ask me anything'];
    case 'thinking':
      return ['Searching', app.provider ? `Querying ${app.provider.providerLabel}…` : 'Querying the web…'];
    case 'speaking':
      return ['Responding', voiceActive() ? 'Say “Hey Jarvis, stop” or tap the reactor to interrupt' : 'Tap the reactor to interrupt'];
    default:
      return ['', ''];
  }
}

const REACTOR_LABELS = {
  offline: 'Initialize Jarvis',
  standby: 'Start listening',
  listening: 'Stop listening',
  thinking: 'Cancel',
  speaking: 'Stop speaking',
};

function setState(next) {
  app.state = next;
  document.body.dataset.state = next;
  visualizer.setMode(next === 'standby' && !voiceActive() ? 'offline' : next);
  const [label, hint] = statusCopy(next);
  els.statusText.textContent = label;
  els.statusHint.textContent = hint;
  els.reactor.setAttribute('aria-label', REACTOR_LABELS[next]);
  els.sysCore.textContent = next === 'offline' ? 'Offline' : `Online · ${label}`;

  clearTimeout(app.listenTimer);
  if (next === 'listening') armListenTimeout();
}

function armListenTimeout() {
  clearTimeout(app.listenTimer);
  app.listenTimer = setTimeout(() => {
    if (app.state !== 'listening') return;
    audio.chime('done');
    showTranscript('', 'ambient');
    setState(restingState());
  }, LISTEN_TIMEOUT_MS);
}

/** Stop whatever Jarvis is doing (speaking or searching). */
function interrupt() {
  app.requestId++;
  app.speechToken++;
  speaker.cancel();
  envelope.stop();
  app.currentSpeech = '';
  if (els.response.dataset.kind === 'pending') els.response.hidden = true;
}

/* ------------------------------------------------------------------ */
/* Initialization                                                      */
/* ------------------------------------------------------------------ */

async function initialize() {
  if (app.initialized || app.initializing) return;
  app.initializing = true;
  els.statusText.textContent = 'Initializing';
  els.statusHint.textContent = 'Requesting microphone access…';

  try {
    await audio.init();
  } catch {
    /* chimes are optional */
  }

  try {
    await audio.enableMic();
    setMicStatus('active');
  } catch (err) {
    setMicStatus(err.name === 'NotAllowedError' ? 'denied' : 'unavailable');
    if (err.name === 'NotAllowedError') {
      showNotice('Microphone access was blocked. Allow it in the address bar to use “Hey Jarvis” — typing still works.');
    } else if (!window.isSecureContext) {
      showNotice('The microphone only works on http://localhost or HTTPS. Open Jarvis through the local server.');
    } else {
      showNotice('No microphone was found. You can still type your questions.');
    }
  }

  if (recognitionSupported && audio.micReady) {
    recognizer = new Recognizer({ onResult: onSpeechResult, onError: onRecognizerError });
    recognizer.start();
    els.sysWake.textContent = '“Hey Jarvis” · armed';
  } else if (!recognitionSupported) {
    els.sysWake.textContent = 'Unsupported browser';
    showNotice('Voice commands need Chrome or Edge (this browser has no speech recognition). You can still type.');
  }

  app.initialized = true;
  app.initializing = false;
  updateMicButton();
  say(greetingFor(new Date(), settings.honorific, { voice: voiceActive() }));
}

function setMicStatus(status) {
  app.micStatus = status;
  const labels = {
    idle: 'Not initialized',
    active: 'Active',
    muted: 'Muted',
    denied: 'Access denied',
    unavailable: 'Unavailable',
  };
  els.sysMic.textContent = labels[status] || status;
  els.sysMic.dataset.status = status;
}

function onRecognizerError(error) {
  const messages = {
    'not-allowed': 'Speech recognition was blocked. Allow microphone access to use “Hey Jarvis”.',
    'service-not-allowed': 'Speech recognition is disabled in this browser. Try Chrome or Edge.',
    'audio-capture': 'No microphone was found for speech recognition.',
    network: 'Speech recognition needs an internet connection — retrying…',
    'language-not-supported': `Speech recognition doesn't support ${navigator.language}.`,
  };
  showNotice(messages[error] || `Speech recognition error: ${error}`);
  if (error !== 'network') {
    recognizer = null;
    els.sysWake.textContent = 'Offline';
    if (app.state === 'standby' || app.state === 'listening') setState('standby');
  }
}

/* ------------------------------------------------------------------ */
/* Voice input                                                         */
/* ------------------------------------------------------------------ */

function onSpeechResult({ transcript, alternatives, isFinal }) {
  if (app.muted) return;
  const text = transcript.trim();
  if (!text) return;
  const wake = findWake(text) || alternatives.map(findWake).find(Boolean) || null;

  // While busy, only a (non-echo) wake phrase gets through — it interrupts Jarvis.
  if (app.state === 'speaking' || app.state === 'thinking') {
    if (!wake || !isFinal) return;
    if (app.state === 'speaking' && isEcho(text, app.currentSpeech)) return;
    interrupt();
    if (wake.remainder) {
      handleCommand(wake.remainder);
    } else {
      audio.chime('wake');
      setState('listening');
    }
    return;
  }

  if (app.state === 'standby') {
    if (!wake) {
      showTranscript(text, 'ambient');
      return;
    }
    audio.chime('wake');
    setState('listening');
  }

  if (app.state === 'listening') {
    const command = wake ? wake.remainder : text;
    armListenTimeout();
    showTranscript(command || '…', isFinal ? 'final' : 'interim');
    if (isFinal && command) handleCommand(command);
  }
}

function showTranscript(text, kind) {
  els.transcript.textContent = kind === 'final' && text ? `“${text}”` : text;
  els.transcript.dataset.kind = kind;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function handleCommand(raw) {
  const text = raw.trim();
  if (!text) return;
  interrupt();
  addLog('user', text);
  showTranscript(text, 'final');

  const intent = interpretCommand(text, { honorific: settings.honorific });
  if (intent.type === 'stop') {
    audio.chime('done');
    setState(restingState());
    return;
  }
  if (intent.type === 'reply') {
    await say(intent.text);
    return;
  }
  await runSearch(intent.query);
}

async function runSearch(query) {
  const id = ++app.requestId;
  setState('thinking');
  showPending(query);

  let data;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.detail || data.error || `HTTP ${res.status}`), { data });
  } catch (err) {
    if (id !== app.requestId) return;
    showError(query, err);
    visualizer.flash('error');
    audio.chime('error');
    await say(`I'm sorry${addressSuffix()}, the search didn't go through. I've put a Google link on screen instead.`);
    return;
  }
  if (id !== app.requestId) return; // superseded or cancelled

  showResult(data);
  let reply = data.answer;
  if (!reply) {
    reply = data.results?.length
      ? `I couldn't find a direct answer${addressSuffix()}, but I've put the top results on screen.`
      : `I'm afraid I couldn't find anything on that${addressSuffix()}.`;
  }
  await say(reply);
}

async function say(text) {
  const token = ++app.speechToken;
  addLog('jarvis', text);
  app.currentSpeech = text;
  setState('speaking');
  envelope.start();
  await speaker.speak(text, { onBoundary: () => envelope.pulse() });
  if (token !== app.speechToken) return; // interrupted
  envelope.stop();
  app.currentSpeech = '';
  if (app.state === 'speaking') setState(restingState());
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function safeUrl(link) {
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function hostOf(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function googleUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function showPending(query) {
  els.response.hidden = false;
  els.response.dataset.kind = 'pending';
  els.responseTag.textContent = 'Searching';
  els.responseQuery.textContent = query;
  els.answer.textContent = 'Scanning search results…';
  els.answerSource.hidden = true;
  els.results.replaceChildren();
  els.googleLink.href = googleUrl(query);
}

function showError(query, err) {
  els.response.dataset.kind = 'error';
  els.responseTag.textContent = 'Search offline';
  els.responseQuery.textContent = query;
  if (!err.data) {
    els.answer.textContent = 'Could not reach the Jarvis server. Is “npm start” still running?';
  } else if (/HTTP 40[13]\b/.test(err.message) && app.provider?.provider !== 'fallback') {
    els.answer.textContent = `The search provider rejected the request (${err.message}). Check the API key in your .env file.`;
  } else {
    els.answer.textContent = `The search provider returned an error (${err.message}).`;
  }
  els.answerSource.hidden = true;
  els.results.replaceChildren();
  els.googleLink.href = err.data?.googleUrl || googleUrl(query);
}

function showResult(data) {
  els.response.dataset.kind = 'result';
  els.responseTag.textContent = data.provider === 'fallback' ? 'Web result' : 'Google result';
  els.responseQuery.textContent = data.query;
  els.answer.textContent = data.answer || 'No direct answer — here are the top results.';
  els.googleLink.href = data.googleUrl || googleUrl(data.query);

  const sourceLink = data.source?.link && safeUrl(data.source.link);
  if (data.source && data.answer) {
    els.answerSource.hidden = false;
    els.answerSource.textContent = `Source: ${data.source.title}${sourceLink ? ` · ${hostOf(sourceLink)}` : ''}`;
    if (sourceLink) els.answerSource.href = sourceLink;
    else els.answerSource.removeAttribute('href');
  } else {
    els.answerSource.hidden = true;
  }

  const items = (data.results || []).filter((r) => safeUrl(r.link) && r.link !== data.source?.link).slice(0, 3);
  els.results.replaceChildren(
    ...items.map((result) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = safeUrl(result.link);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = result.title;
      const host = document.createElement('span');
      host.className = 'host';
      host.textContent = hostOf(result.link);
      li.append(a, host);
      if (result.snippet) {
        const p = document.createElement('p');
        p.textContent = result.snippet;
        li.append(p);
      }
      return li;
    }),
  );
}

function addLog(who, text) {
  els.log.querySelector('.log-empty')?.remove();
  const li = document.createElement('li');
  li.className = `log-entry ${who}`;
  const head = document.createElement('span');
  head.className = 'log-head';
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  head.textContent = `${who === 'user' ? 'You' : 'Jarvis'} · ${time}`;
  const body = document.createElement('p');
  body.textContent = text;
  li.append(head, body);
  els.log.prepend(li);
  while (els.log.children.length > LOG_LIMIT) els.log.lastElementChild.remove();
}

let noticeTimer;
function showNotice(message) {
  els.notice.textContent = message;
  els.notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    els.notice.hidden = true;
  }, 9000);
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

function onReactor() {
  switch (app.state) {
    case 'offline':
      initialize();
      break;
    case 'standby':
      if (!voiceActive()) {
        els.input.focus();
        showNotice(app.muted ? 'The microphone is off — turn it on or type a question.' : 'Voice input is unavailable — type a question below.');
        break;
      }
      audio.chime('wake');
      showTranscript('', 'interim');
      setState('listening');
      break;
    case 'listening':
      audio.chime('done');
      setState(restingState());
      break;
    default:
      interrupt();
      setState(restingState());
  }
}

function updateMicButton() {
  const off = app.muted || !audio.micReady;
  els.micToggle.setAttribute('aria-pressed', String(off));
  els.micToggle.setAttribute('aria-label', off ? 'Turn microphone on' : 'Turn microphone off');
  els.micToggle.classList.toggle('is-off', off);
}

function toggleMic() {
  if (!app.initialized) {
    initialize();
    return;
  }
  if (!audio.micReady) {
    showNotice('No microphone is available. Check your browser permissions and reload.');
    return;
  }
  app.muted = !app.muted;
  audio.setMuted(app.muted);
  if (app.muted) recognizer?.stop();
  else if (recognitionSupported) {
    recognizer ??= new Recognizer({ onResult: onSpeechResult, onError: onRecognizerError });
    recognizer.start();
    els.sysWake.textContent = '“Hey Jarvis” · armed';
  }
  setMicStatus(app.muted ? 'muted' : 'active');
  updateMicButton();
  if (app.state === 'standby' || app.state === 'listening') setState('standby');
}

els.reactor.addEventListener('click', onReactor);
els.micToggle.addEventListener('click', toggleMic);

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = '';
  try {
    await audio.init(); // typed commands still get chimes
  } catch {
    /* optional */
  }
  handleCommand(text);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && (app.state === 'speaking' || app.state === 'thinking' || app.state === 'listening')) {
    interrupt();
    setState(restingState());
  }
  const typing = event.target.closest?.('input, textarea, select, button, dialog');
  if (event.code === 'Space' && !typing && !event.repeat) {
    event.preventDefault();
    onReactor();
  }
});

/* Settings dialog */

function voiceLabel(voice) {
  return voice ? `${voice.name} (${voice.lang})` : 'Default';
}

function populateVoices() {
  const voices = speaker.voices
    .filter((v) => /^en/i.test(v.lang))
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  const auto = speaker.voiceName ? null : speaker.voice;
  const options = [new Option(`Automatic${auto ? ` — ${auto.name}` : ''}`, '')];
  for (const voice of voices) options.push(new Option(voiceLabel(voice), voice.name));
  els.voiceSelect.replaceChildren(...options);
  els.voiceSelect.value = speaker.voiceName;
  els.sysVoice.textContent = synthesisSupported ? speaker.voice?.name || 'System default' : 'Unavailable';
}

speaker.onVoicesChanged = populateVoices;
populateVoices();

els.rate.value = String(settings.rate);
els.rateValue.textContent = `${Number(settings.rate).toFixed(2)}×`;
els.honorific.value = settings.honorific;

els.settingsToggle.addEventListener('click', () => {
  populateVoices();
  els.settings.showModal();
});
els.voiceSelect.addEventListener('change', () => {
  settings.voice = els.voiceSelect.value;
  speaker.voiceName = settings.voice;
  els.sysVoice.textContent = speaker.voice?.name || 'System default';
  saveSettings();
});
els.rate.addEventListener('input', () => {
  settings.rate = Number(els.rate.value);
  speaker.rate = settings.rate;
  els.rateValue.textContent = `${settings.rate.toFixed(2)}×`;
  saveSettings();
});
els.honorific.addEventListener('input', () => {
  settings.honorific = els.honorific.value.trim();
  saveSettings();
});
els.testVoice.addEventListener('click', () => {
  say(`At your service${addressSuffix()}. This is how I will sound.`);
});

/* ------------------------------------------------------------------ */
/* Clock, meters, server status                                        */
/* ------------------------------------------------------------------ */

function tickClock() {
  const now = new Date();
  els.clockTime.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  els.clockDate.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}
tickClock();
setInterval(tickClock, 1000);

setInterval(() => {
  const { level, db } = audio.readLevel();
  els.micMeter.style.transform = `scaleX(${level.toFixed(3)})`;
  els.micDb.textContent = db > -100 ? `${Math.round(db)} dB` : '— dB';
}, 100);

async function loadStatus() {
  if (location.protocol === 'file:') {
    els.sysSearch.textContent = 'Server offline';
    showNotice('Start the Jarvis server with “npm start”, then open http://localhost:3000.');
    return;
  }
  try {
    const res = await fetch('/api/status');
    app.provider = await res.json();
    els.sysSearch.textContent = app.provider.providerLabel;
    els.sysSearch.dataset.status = app.provider.provider === 'fallback' ? 'warn' : 'ok';
    if (app.provider.provider === 'fallback') {
      els.sysSearch.title = 'Add SERPER_API_KEY to .env to answer from live Google results';
    }
  } catch {
    els.sysSearch.textContent = 'Server offline';
    els.sysSearch.dataset.status = 'error';
  }
}
loadStatus();
setState('offline');
