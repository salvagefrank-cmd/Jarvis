import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanSnippet,
  fromGoogleCse,
  fromSerper,
  mergeFallback,
  pickProvider,
  search,
  toSpeech,
  toTopic,
} from '../lib/search.js';

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, init });
    const route = routes.find(([pattern]) => href.includes(pattern));
    if (!route) return { ok: false, status: 404, json: async () => ({}) };
    const [, body, status = 200] = route;
    return { ok: status < 400, status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test('pickProvider prefers Serper, then Google CSE, then the keyless fallback', () => {
  assert.equal(pickProvider({ SERPER_API_KEY: 'k', GOOGLE_API_KEY: 'g', GOOGLE_CSE_ID: 'c' }), 'serper');
  assert.equal(pickProvider({ GOOGLE_API_KEY: 'g', GOOGLE_CSE_ID: 'c' }), 'google-cse');
  assert.equal(pickProvider({ GOOGLE_API_KEY: 'g' }), 'fallback');
  assert.equal(pickProvider({ SERPER_API_KEY: '' }), 'fallback');
});

test('fromSerper uses the answer box first', () => {
  const result = fromSerper({
    answerBox: { title: 'Eiffel Tower / Height', answer: '330 m', link: 'https://example.com/eiffel' },
    knowledgeGraph: { title: 'Eiffel Tower', description: 'A wrought-iron lattice tower.' },
    organic: [{ title: 'Eiffel Tower', link: 'https://en.wikipedia.org/wiki/Eiffel_Tower', snippet: 'Tower in Paris.' }],
  });
  assert.equal(result.answer, '330 m');
  assert.deepEqual(result.source, { title: 'Eiffel Tower / Height', link: 'https://example.com/eiffel' });
  assert.equal(result.results.length, 1);
});

test('fromSerper falls back to snippet, knowledge graph, then top organic result', () => {
  assert.equal(
    fromSerper({ answerBox: { snippet: 'Paris is the capital of France.' } }).answer,
    'Paris is the capital of France.',
  );

  const kg = fromSerper({
    knowledgeGraph: {
      title: 'Tony Stark',
      description: 'Tony Stark is a fictional character.',
      descriptionSource: 'Wikipedia',
      descriptionLink: 'https://en.wikipedia.org/wiki/Iron_Man',
    },
  });
  assert.equal(kg.answer, 'Tony Stark is a fictional character.');
  assert.equal(kg.source.link, 'https://en.wikipedia.org/wiki/Iron_Man');

  const organic = fromSerper({
    organic: [{ title: 'Result', link: 'https://example.com', snippet: 'Mar 3, 2024 — The first sentence. The second...' }],
  });
  assert.equal(organic.answer, 'The first sentence.');
  assert.deepEqual(organic.source, { title: 'Result', link: 'https://example.com' });
});

test('fromSerper returns a null answer when nothing is usable', () => {
  assert.deepEqual(fromSerper({}), { answer: null, source: null, results: [] });
});

test('fromGoogleCse reads the first result with a snippet', () => {
  const result = fromGoogleCse({
    items: [
      { title: 'No snippet', link: 'https://a.example' },
      { title: 'Has snippet', link: 'https://b.example', snippet: 'Answer lives here.' },
    ],
  });
  assert.equal(result.answer, 'Answer lives here.');
  assert.equal(result.source.link, 'https://b.example');
  assert.equal(result.results.length, 2);
});

test('mergeFallback prefers DuckDuckGo answers, then abstracts, then Wikipedia', () => {
  const wiki = {
    hits: [{ title: 'Iron Man', snippet: 'a <span class="searchmatch">superhero</span>' }],
    summary: { title: 'Iron Man', extract: 'Iron Man is a superhero.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Iron_Man' } } },
  };
  assert.equal(mergeFallback({ Answer: '42' }, wiki).answer, '42');
  assert.equal(
    mergeFallback({ AbstractText: 'From DDG.', Heading: 'X', AbstractSource: 'Wikipedia', AbstractURL: 'https://x' }, wiki).answer,
    'From DDG.',
  );
  const fromWiki = mergeFallback({}, wiki);
  assert.equal(fromWiki.answer, 'Iron Man is a superhero.');
  assert.equal(fromWiki.results[0].snippet, 'a superhero');
  assert.equal(mergeFallback(undefined, undefined).answer, null);
});

test('search() calls Serper with the API key header and normalises the response', async () => {
  const fetchImpl = fakeFetch([['google.serper.dev', { answerBox: { answer: 'Jon Favreau' } }]]);
  const result = await search('who directed iron man', { env: { SERPER_API_KEY: 'secret' }, fetchImpl });
  assert.equal(result.provider, 'serper');
  assert.equal(result.answer, 'Jon Favreau');
  assert.equal(result.googleUrl, 'https://www.google.com/search?q=who%20directed%20iron%20man');
  const [call] = fetchImpl.calls;
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['X-API-KEY'], 'secret');
  assert.equal(JSON.parse(call.init.body).q, 'who directed iron man');
});

test('search() errors never leak the API key', async () => {
  const fetchImpl = fakeFetch([['googleapis.com', {}, 403]]);
  await assert.rejects(
    search('test', { env: { GOOGLE_API_KEY: 'super-secret', GOOGLE_CSE_ID: 'cx' }, fetchImpl }),
    (err) => err.status === 403 && !err.message.includes('super-secret'),
  );
});

test('search() fallback survives one provider failing', async () => {
  const fetchImpl = fakeFetch([
    ['api.duckduckgo.com', {}, 500],
    ['w/api.php', { query: { search: [{ title: 'Arc reactor', snippet: 'fictional power source' }] } }],
    ['page/summary/Arc_reactor', { title: 'Arc reactor', extract: 'The arc reactor is a fictional power source.' }],
  ]);
  const result = await search('what is an arc reactor', { env: {}, fetchImpl });
  assert.equal(result.provider, 'fallback');
  assert.equal(result.answer, 'The arc reactor is a fictional power source.');
  assert.ok(fetchImpl.calls.some((c) => c.href.includes('srsearch=arc+reactor')));
});

test('cleanSnippet strips markup, entities and date prefixes', () => {
  assert.equal(cleanSnippet('<b>Bold</b> &amp; &quot;quoted&quot;'), 'Bold & "quoted"');
  assert.equal(cleanSnippet('3 days ago — Something happened.'), 'Something happened.');
  assert.equal(cleanSnippet('12 Jan 2025 - News item'), 'News item');
  assert.equal(cleanSnippet('... continues here'), 'continues here');
});

test('toSpeech keeps whole sentences within the length budget', () => {
  const long = 'One two three. '.repeat(40);
  const spoken = toSpeech(long, 60);
  assert.ok(spoken.length <= 60, spoken);
  assert.match(spoken, /\.$/);
  assert.equal(toSpeech('Complete sentence. Cut off mid way...'), 'Complete sentence.');
});

test('toTopic strips question words for Wikipedia', () => {
  assert.equal(toTopic('Who is the president of France?'), 'president of France');
  assert.equal(toTopic("what's an arc reactor"), 'arc reactor');
  assert.equal(toTopic('tell me about Iron Man'), 'Iron Man');
});
