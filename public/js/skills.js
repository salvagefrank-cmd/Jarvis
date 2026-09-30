/**
 * Wake-word detection and command interpretation.
 * Pure functions (no DOM) so they can be unit-tested in Node.
 */

// Speech recognisers often mishear "Jarvis"; accept the common variants.
const WAKE_NAMES = 'jarvis|jarvas|jarvus|jarves|jervis|javis|jarviss|jarvys|jarvi';
const WAKE_RE = new RegExp(
  `\\b(?:(?:hey|hi|hello|ok|okay|yo|oi)[\\s,]+)?(?:${WAKE_NAMES})\\b[\\s,.!?:;-]*`,
  'i',
);
// Words that only count as the wake word when preceded by "hey".
const SOFT_WAKE_RE = /\b(?:hey|hi|ok|okay)[\s,]+(?:travis|jarvis's|service)\b[\s,.!?:;-]*/i;

/**
 * Find the wake phrase in a transcript.
 * Returns { phrase, remainder } where remainder is whatever was said after it, or null.
 */
export function findWake(text) {
  const match = WAKE_RE.exec(text) || SOFT_WAKE_RE.exec(text);
  if (!match) return null;
  const remainder = text
    .slice(match.index + match[0].length)
    .replace(/^[\s,.!?:;-]+/, '')
    .trim();
  return { phrase: match[0].trim(), remainder };
}

function tokenize(text) {
  return text.toLowerCase().match(/[a-z0-9']+/g) || [];
}

/**
 * True when the microphone most likely picked up Jarvis's own voice
 * (most of the heard words appear in what is currently being spoken).
 */
export function isEcho(heard, spoken) {
  if (!spoken) return false;
  const words = tokenize(heard);
  if (!words.length) return false;
  const pool = new Set(tokenize(spoken));
  const hits = words.filter((w) => pool.has(w)).length;
  return hits / words.length >= 0.75;
}

const randomPick = (options) => options[Math.floor(Math.random() * options.length)];

function address(honorific) {
  return honorific ? `, ${honorific}` : '';
}

export function greetingFor(date, honorific, { voice = true } = {}) {
  const hour = date.getHours();
  const part = hour < 5 ? 'evening' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const how = voice ? 'Say "Hey Jarvis" whenever you need me.' : 'Type a question below whenever you need me.';
  return `Good ${part}${address(honorific)}. Jarvis is online and at your service. ${how}`;
}

const STOP_RE = /^(?:stop|cancel|never ?mind|nevermind|quiet|be quiet|shut up|silence|that's all|that is all|nothing|forget it)\b/;
const TIME_RE = /^(?:what(?:'s| is) the (?:current )?time|what time is it|tell me the time|time|current time)(?: now| right now)?$/;
const DATE_RE = /^(?:what(?:'s| is) (?:the |today's )?date(?: today)?|what day is (?:it|today)|what(?:'s| is) today|today's date|date)$/;
const GREETING_RE = /^(?:hi|hello|hey|yo|good (?:morning|afternoon|evening)|greetings)(?: there)?$/;
const HOW_ARE_YOU_RE = /^(?:how are you|how are you doing|how's it going|how are things|you there|are you there)$/;
const IDENTITY_RE = /^(?:who are you|what are you|what(?:'s| is) your name|introduce yourself)$/;
const HELP_RE = /^(?:help|what can you do|what do you do|how do (?:i|you) use (?:this|you))$/;
const THANKS_RE = /^(?:thanks|thank you|cheers|much appreciated|great job|good job|nice work)(?: jarvis)?$/;
const SEARCH_PREFIX_RE = /^(?:search(?: google| the web| online)?(?: for)?|google|look up|find out|find)\s+(.+)$/;
const ABOUT_PREFIX_RE = /^(?:tell me about|what do you know about)\s+(.+)$/;

/**
 * Decide what to do with a command.
 *   { type: 'stop' }
 *   { type: 'reply', text }
 *   { type: 'search', query }
 */
export function interpretCommand(raw, { now = new Date(), honorific = 'sir', pick = randomPick } = {}) {
  const text = raw.trim().replace(/\s+/g, ' ');
  const a = address(honorific);
  const q = text
    .toLowerCase()
    .replace(/[?!.,]+$/, '')
    .replace(/^(?:please|can you|could you|would you|will you)\s+/, '')
    .replace(/\s+please$/, '')
    .trim();

  if (!q || STOP_RE.test(q)) return { type: 'stop' };

  if (TIME_RE.test(q)) {
    const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return { type: 'reply', text: `It's ${time}${a}.` };
  }
  if (DATE_RE.test(q)) {
    const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    return { type: 'reply', text: `Today is ${date}.` };
  }
  if (GREETING_RE.test(q)) {
    return { type: 'reply', text: pick([`Hello${a}. How can I help?`, `At your service${a}.`, `Yes${a}? What do you need?`]) };
  }
  if (HOW_ARE_YOU_RE.test(q)) {
    return { type: 'reply', text: `All systems are fully operational${a}. What can I do for you?` };
  }
  if (IDENTITY_RE.test(q)) {
    return {
      type: 'reply',
      text: "I'm Jarvis — Just A Rather Very Intelligent System. Ask me anything and I'll search the web and read you the answer.",
    };
  }
  if (HELP_RE.test(q)) {
    return {
      type: 'reply',
      text: 'Say "Hey Jarvis" followed by any question, and I will look it up and read you the answer. I can also tell you the time and the date. Say "Hey Jarvis, stop" to interrupt me.',
    };
  }
  if (THANKS_RE.test(q)) {
    return { type: 'reply', text: pick([`You're welcome${a}.`, `Always a pleasure${a}.`, `Happy to help${a}.`]) };
  }

  const searchMatch = SEARCH_PREFIX_RE.exec(q) || ABOUT_PREFIX_RE.exec(q);
  if (searchMatch) {
    // Keep the user's original casing for the query.
    const start = text.toLowerCase().indexOf(searchMatch[1]);
    const query = start >= 0 ? text.slice(start, start + searchMatch[1].length) : searchMatch[1];
    return { type: 'search', query: query.trim() };
  }

  return { type: 'search', query: text.replace(/[.!]+$/, '') };
}
