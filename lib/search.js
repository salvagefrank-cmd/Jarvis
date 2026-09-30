/**
 * Web search for J.A.R.V.I.S.
 *
 * Providers, in order of preference:
 *   1. Serper.dev        (SERPER_API_KEY)                 – live Google results, answer boxes, knowledge graph
 *   2. Google CSE        (GOOGLE_API_KEY + GOOGLE_CSE_ID) – Google's Custom Search JSON API (existing keys only;
 *                                                           Google retires it on 2027-01-01)
 *   3. Keyless fallback  – DuckDuckGo Instant Answers + Wikipedia, so the assistant works out of the box
 *
 * Every provider is normalised to: { answer, source, results }
 */

const TIMEOUT_MS = 8000;
const MAX_RESULTS = 5;
const USER_AGENT = 'JarvisVoiceAssistant/1.0 (https://github.com/salvagefrank-cmd/Jarvis)';

export const PROVIDER_LABELS = {
  serper: 'Google (Serper)',
  'google-cse': 'Google (Custom Search)',
  fallback: 'DuckDuckGo + Wikipedia',
};

export class SearchError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SearchError';
    this.status = status;
  }
}

export function pickProvider(env = process.env) {
  if (env.SERPER_API_KEY) return 'serper';
  if (env.GOOGLE_API_KEY && env.GOOGLE_CSE_ID) return 'google-cse';
  return 'fallback';
}

export function googleSearchUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

export async function search(query, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const provider = pickProvider(env);
  let result;
  if (provider === 'serper') {
    result = fromSerper(await fetchSerper(query, env, fetchImpl));
  } else if (provider === 'google-cse') {
    result = fromGoogleCse(await fetchGoogleCse(query, env, fetchImpl));
  } else {
    result = await fallbackSearch(query, fetchImpl);
  }
  return {
    query,
    provider,
    providerLabel: PROVIDER_LABELS[provider],
    googleUrl: googleSearchUrl(query),
    ...result,
  };
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

async function getJson(url, init, fetchImpl) {
  const res = await fetchImpl(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...init?.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // Only the hostname goes into the message: the full URL may carry an API key.
    throw new SearchError(`${new URL(url).hostname} responded with HTTP ${res.status}`, res.status);
  }
  return res.json();
}

function fetchSerper(query, env, fetchImpl) {
  const body = { q: query, num: 10 };
  if (env.SEARCH_COUNTRY) body.gl = env.SEARCH_COUNTRY;
  if (env.SEARCH_LANGUAGE) body.hl = env.SEARCH_LANGUAGE;
  return getJson(
    'https://google.serper.dev/search',
    {
      method: 'POST',
      headers: { 'X-API-KEY': env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  );
}

export function fromSerper(data) {
  const results = toResults(data.organic);
  const box = data.answerBox;
  const kg = data.knowledgeGraph;

  if (box) {
    const highlighted = Array.isArray(box.snippetHighlighted) ? box.snippetHighlighted.join(', ') : '';
    const answer = box.answer || box.snippet || highlighted;
    if (answer) {
      return {
        answer: toSpeech(answer),
        source: box.link ? { title: box.title || hostname(box.link), link: box.link } : null,
        results,
      };
    }
  }

  if (kg?.description) {
    return {
      answer: toSpeech(kg.description),
      source: {
        title: kg.descriptionSource ? `${kg.title} · ${kg.descriptionSource}` : kg.title,
        link: kg.descriptionLink || kg.website || null,
      },
      results,
    };
  }

  return fromTopResult(results);
}

function fetchGoogleCse(query, env, fetchImpl) {
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.search = new URLSearchParams({
    key: env.GOOGLE_API_KEY,
    cx: env.GOOGLE_CSE_ID,
    q: query,
    num: String(MAX_RESULTS),
  });
  return getJson(url.href, {}, fetchImpl);
}

export function fromGoogleCse(data) {
  return fromTopResult(toResults(data.items));
}

async function fallbackSearch(query, fetchImpl) {
  const [ddg, wiki] = await Promise.allSettled([
    fetchDuckDuckGo(query, fetchImpl),
    fetchWikipedia(query, fetchImpl),
  ]);
  if (ddg.status === 'rejected' && wiki.status === 'rejected') {
    throw new SearchError(`Fallback search failed: ${ddg.reason?.message}; ${wiki.reason?.message}`, 502);
  }
  return mergeFallback(ddg.value, wiki.value);
}

function fetchDuckDuckGo(query, fetchImpl) {
  const url = new URL('https://api.duckduckgo.com/');
  url.search = new URLSearchParams({ q: query, format: 'json', no_html: '1', skip_disambig: '1', no_redirect: '1' });
  return getJson(url.href, {}, fetchImpl);
}

async function fetchWikipedia(query, fetchImpl) {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: toTopic(query),
    srlimit: '3',
    format: 'json',
  });
  const found = await getJson(url.href, {}, fetchImpl);
  const hits = found?.query?.search || [];
  let summary = null;
  for (const hit of hits.slice(0, 2)) {
    const page = encodeURIComponent(hit.title.replace(/ /g, '_'));
    const candidate = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${page}`, {}, fetchImpl);
    if (candidate?.extract && candidate.type !== 'disambiguation') {
      summary = candidate;
      break;
    }
  }
  return { hits, summary };
}

export function mergeFallback(ddg, wiki) {
  const results = [];
  if (wiki?.hits) {
    for (const hit of wiki.hits) {
      results.push({
        title: `${hit.title} – Wikipedia`,
        link: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
        snippet: cleanSnippet(hit.snippet || ''),
      });
    }
  }
  for (const topic of flattenTopics(ddg?.RelatedTopics)) {
    if (topic.Text && topic.FirstURL) {
      results.push({ title: topic.Text.split(' - ')[0], link: topic.FirstURL, snippet: cleanSnippet(topic.Text) });
    }
  }

  let answer = null;
  let source = null;
  if (typeof ddg?.Answer === 'string' && ddg.Answer.trim()) {
    answer = ddg.Answer;
    source = { title: 'DuckDuckGo', link: 'https://duckduckgo.com/' };
  } else if (ddg?.AbstractText) {
    answer = ddg.AbstractText;
    source = { title: `${ddg.Heading} · ${ddg.AbstractSource}`, link: ddg.AbstractURL };
  } else if (wiki?.summary?.extract) {
    answer = wiki.summary.extract;
    source = {
      title: `${wiki.summary.title} · Wikipedia`,
      link: wiki.summary.content_urls?.desktop?.page || null,
    };
  } else if (ddg?.Definition) {
    answer = ddg.Definition;
    source = { title: ddg.DefinitionSource || 'Definition', link: ddg.DefinitionURL || null };
  }

  return {
    answer: answer ? toSpeech(answer) : null,
    source,
    results: results.slice(0, MAX_RESULTS),
  };
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

function toResults(items) {
  return (items || [])
    .filter((item) => item?.link)
    .slice(0, MAX_RESULTS)
    .map((item) => ({ title: item.title || hostname(item.link), link: item.link, snippet: cleanSnippet(item.snippet || '') }));
}

function fromTopResult(results) {
  const top = results.find((r) => r.snippet);
  return {
    answer: top ? toSpeech(top.snippet) : null,
    source: top ? { title: top.title, link: top.link } : null,
    results,
  };
}

function flattenTopics(topics = []) {
  return topics.flatMap((t) => (Array.isArray(t.Topics) ? flattenTopics(t.Topics) : [t]));
}

function hostname(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return link;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };

/** Strip markup, entities and Google's "Mar 3, 2024 — " date prefixes from a snippet. */
export function cleanSnippet(text) {
  return String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39|#x27);/g, (_, name) => ENTITIES[name])
    .replace(/\s+/g, ' ')
    .trim()
    .replace(
      /^(?:[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}|\d{1,2} [A-Z][a-z]{2,8}\.? \d{4}|\d+ (?:seconds?|minutes?|hours?|days?|weeks?|months?|years?) ago)\s*[—–-]+\s*/,
      '',
    )
    .replace(/^(?:\.{3}|…)\s*/, '');
}

/** Turn a snippet into something pleasant to read aloud: whole sentences, roughly `maxChars` long. */
export function toSpeech(text, maxChars = 320) {
  let clean = cleanSnippet(text);
  const truncated = /(?:\.{3}|…)$/.test(clean);
  clean = clean.replace(/\s*(?:\.{3}|…)$/, '').trim();

  let sentences = splitSentences(clean);
  if (truncated && sentences.length > 1) sentences = sentences.slice(0, -1);

  let spoken = '';
  for (const sentence of sentences) {
    if (spoken && spoken.length + sentence.length + 1 > maxChars) break;
    spoken = spoken ? `${spoken} ${sentence}` : sentence;
  }
  if (spoken.length > maxChars * 1.5) {
    spoken = `${spoken.slice(0, maxChars).replace(/[\s,;:]+\S*$/, '')}…`;
  }
  return spoken;
}

function splitSentences(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    return Array.from(segmenter.segment(text), (s) => s.segment.trim()).filter(Boolean);
  }
  return text.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((s) => s.trim()).filter(Boolean) || [text];
}

/** "who is the president of france" -> "president of france" (better Wikipedia hits). */
export function toTopic(query) {
  return query
    .trim()
    .replace(/[?!.]+$/, '')
    .replace(/^(?:tell me about|what do you know about|explain)\s+/i, '')
    .replace(/^(?:who|what|where|when|which|how)(?:'s|\s+(?:is|are|was|were|does|do|did))\s+/i, '')
    .replace(/^(?:the|a|an)\s+/i, '');
}
