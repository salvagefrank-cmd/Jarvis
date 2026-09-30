import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.js';
import { PROVIDER_LABELS, googleSearchUrl, pickProvider, search } from './lib/search.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));

const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
// Bound to localhost by default: browsers only allow microphone access on localhost or HTTPS.
const HOST = process.env.HOST || '127.0.0.1';
const MAX_QUERY_LENGTH = 300;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME_TYPES['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(pathname, res) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'Bad path' });
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

async function handleSearch(url, res) {
  const query = (url.searchParams.get('q') || '').trim();
  if (!query) return sendJson(res, 400, { error: 'Missing ?q= parameter' });
  if (query.length > MAX_QUERY_LENGTH) return sendJson(res, 400, { error: 'Query is too long' });

  try {
    sendJson(res, 200, await search(query));
  } catch (err) {
    console.error(`[search] "${query}" failed: ${err.message}`);
    sendJson(res, 502, { error: 'Search failed', detail: err.message, query, googleUrl: googleSearchUrl(query) });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  if (url.pathname === '/api/status') {
    const provider = pickProvider();
    return sendJson(res, 200, { provider, providerLabel: PROVIDER_LABELS[provider] });
  }
  if (url.pathname === '/api/search') return handleSearch(url, res);
  return serveStatic(url.pathname, res);
});

server.listen(PORT, HOST, () => {
  const provider = pickProvider();
  const shownHost = HOST === '127.0.0.1' || HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\n  J.A.R.V.I.S. online  →  http://${shownHost}:${PORT}`);
  console.log(`  Search provider      →  ${PROVIDER_LABELS[provider]}`);
  if (provider === 'fallback') {
    console.log('\n  No Google key found. Add SERPER_API_KEY to .env to answer from live Google results.');
  }
  console.log('  Open the page in Chrome or Edge, click the reactor, then say "Hey Jarvis".\n');
});
