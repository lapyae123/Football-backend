// China Live proxy — completely different from SOCO/TV:
//   • Self-signed / mismatched SSL certs  → rejectUnauthorized: false
//   • CDN requires Referer + Origin on ALL requests (master, child playlists, segments)
//   • Must use https module (fetch() can't bypass SSL)
//   • CDN tokens in URLs (auth_key=...)   → tokens expire, URLs refresh every ~30 min
//   • All URLs (absolute or relative) routed through our proxy — browser cannot set Referer

const https = require('https');
const http  = require('http');
const { STREAM_UA, PRIVATE_IP_RE } = require('./shared');

const CHINA_REFERER = 'https://yyzbw8.live/';
const CHINA_ORIGIN  = 'https://yyzbw8.live';

// Reuse one SSL agent — avoids creating a new socket pool per request
const SSL_AGENT = new https.Agent({ rejectUnauthorized: false });

// ─── Fetch m3u8 from China CDN ────────────────────────────────────────────────
const fetchM3u8 = (url) => {
  const isHttps = url.startsWith('https');
  const proto   = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = proto.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': STREAM_UA, Referer: CHINA_REFERER, Origin: CHINA_ORIGIN, Accept: '*/*' },
      ...(isHttps ? { agent: SSL_AGENT } : {}),
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(Object.assign(new Error('CDN error'), { status: res.statusCode }));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end',  () => resolve(body));
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error('timeout'), { name: 'AbortError' })); });
  });
};

// ─── Rewrite China m3u8 URLs ──────────────────────────────────────────────────
// All China CDN URLs (absolute or relative) must go through our proxy because
// the CDN requires Referer: https://yyzbw8.live/ on every request — the browser
// cannot send this header directly.
// Child playlists (.m3u8 lines) → china-m3u8 (adds Referer, rewrites segments)
// Segment lines (.ts / other)   → china-ts   (adds Referer, pipes binary)
const rewriteM3u8 = (body, base, basePath, apiBase) =>
  body.replace(/^([^#\r\n].+)$/gm, (line) => {
    const abs = line.startsWith('http') ? line
              : line.startsWith('/')    ? `${base.origin}${line}`
              : `${basePath}${line}`;
    if (abs.includes('.m3u8')) return `${apiBase}/api/proxy/china-m3u8?url=${encodeURIComponent(abs)}`;
    return `${apiBase}/api/proxy/china-ts?url=${encodeURIComponent(abs)}`;
  });

// ─── Fastify plugin — China-specific routes ───────────────────────────────────
const chinaProxy = async (fastify) => {
  // Child m3u8 playlist proxy — fetches server-side, rewrites relative segments to absolute
  // so the browser can pull them directly from the delivery CDN (CORS:*)
  fastify.get('/api/proxy/china-m3u8', async (request, reply) => {
    const { url } = request.query;
    if (!url) { reply.code(400); return { error: 'Missing url' }; }

    let decoded;
    try { decoded = decodeURIComponent(url); } catch { reply.code(400); return { error: 'Bad url' }; }

    let parsedUrl;
    try { parsedUrl = new URL(decoded); } catch { reply.code(400); return { error: 'Invalid URL' }; }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) { reply.code(400); return { error: 'Bad protocol' }; }
    if (PRIVATE_IP_RE.test(parsedUrl.hostname)) { reply.code(403); return { error: 'Forbidden' }; }

    let body;
    try { body = await fetchM3u8(decoded); } catch { reply.code(502); return { error: 'CDN unavailable' }; }

    const base     = new URL(decoded);
    const basePath = base.href.substring(0, base.href.lastIndexOf('/') + 1);
    const apiBase  = (process.env.BACKEND_URL || `${request.protocol}://${request.headers.host}`).replace(/\/$/, '');
    body = body.replace(/^([^#\r\n].+)$/gm, (line) => {
      const abs = line.startsWith('http') ? line
                : line.startsWith('/')    ? `${base.origin}${line}`
                : `${basePath}${line}`;
      if (abs.includes('.m3u8')) return `${apiBase}/api/proxy/china-m3u8?url=${encodeURIComponent(abs)}`;
      return `${apiBase}/api/proxy/china-ts?url=${encodeURIComponent(abs)}`;
    });

    return reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .header('Cache-Control', 'no-store, no-cache')
      .header('Access-Control-Allow-Origin', '*')
      .send(body);
  });

  // .ts segment pipe — SSL bypass + China Referer/Origin, streamed binary (no buffering)
  fastify.get('/api/proxy/china-ts', async (request, reply) => {
    const { url } = request.query;
    if (!url) { reply.code(400); return { error: 'Missing url' }; }

    let decoded;
    try { decoded = decodeURIComponent(url); } catch { reply.code(400); return { error: 'Bad url' }; }

    let parsedUrl;
    try { parsedUrl = new URL(decoded); } catch { reply.code(400); return { error: 'Invalid URL' }; }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) { reply.code(400); return { error: 'Bad protocol' }; }
    if (PRIVATE_IP_RE.test(parsedUrl.hostname)) { reply.code(403); return { error: 'Forbidden' }; }

    const isHttps = decoded.startsWith('https');
    const proto   = isHttps ? https : http;

    return new Promise((resolve) => {
      const req = proto.get(decoded, {
        agent:   isHttps ? SSL_AGENT : undefined,
        timeout: 20000,
        headers: { 'User-Agent': STREAM_UA, Referer: CHINA_REFERER, Origin: CHINA_ORIGIN, Accept: '*/*' },
      }, (upstream) => {
        if (upstream.statusCode !== 200) {
          reply.code(upstream.statusCode === 403 ? 403 : 502).send({ error: `CDN ${upstream.statusCode}` });
          upstream.resume();
          return resolve();
        }
        const ct = upstream.headers['content-type'] || 'video/MP2T';
        reply.raw.writeHead(200, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache, no-store' });
        upstream.pipe(reply.raw);
        reply.raw.on('finish', resolve);
        reply.raw.on('close',  resolve);
        reply.raw.on('error',  resolve);
      });
      req.on('error',   () => { if (!reply.raw.headersSent) reply.code(502).send({ error: 'CDN unreachable' }); resolve(); });
      req.on('timeout', () => { req.destroy(); if (!reply.raw.headersSent) reply.code(504).send({ error: 'Timeout' }); resolve(); });
      request.raw.on('close', () => req.destroy());
    });
  });
};

chinaProxy.fetchM3u8   = fetchM3u8;
chinaProxy.rewriteM3u8 = rewriteM3u8;

module.exports = chinaProxy;
