const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
const MAX_SIZE = 2 * 1024 * 1024; // 2 MB

module.exports = async function (fastify) {
  fastify.get('/api/proxy/logo', async (request, reply) => {
    const { url } = request.query;
    if (!url) {
      reply.code(400);
      return { error: 'Missing url parameter' };
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reply.code(400);
      return { error: 'Invalid URL' };
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      reply.code(400);
      return { error: 'Only http/https allowed' };
    }

    // Block requests to private/local networks
    const host = parsed.hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
      reply.code(403);
      return { error: 'Forbidden' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Referer':    parsed.origin,
          'Accept':     'image/*,*/*;q=0.8',
        },
      });

      const ct = res.headers.get('content-type') || '';
      if (!ALLOWED_TYPES.some((t) => ct.startsWith(t))) {
        reply.code(415);
        return { error: 'Not an image' };
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_SIZE) {
        reply.code(413);
        return { error: 'Image too large' };
      }

      reply
        .code(200)
        .header('Content-Type', ct.split(';')[0].trim())
        .header('Cache-Control', 'public, max-age=86400')
        .send(buf);
    } catch (err) {
      if (err.name === 'AbortError') {
        reply.code(504);
        return { error: 'Timeout' };
      }
      fastify.log.warn(`[proxy/logo] fetch failed for ${url}: ${err.message}`);
      reply.code(502);
      return { error: 'Request failed' };
    } finally {
      clearTimeout(timer);
    }
  });
};
