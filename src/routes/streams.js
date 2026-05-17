const db = require('../config/database');
const redis = require('../config/redis');

module.exports = async function (fastify, opts) {
  fastify.get('/api/streams/:matchId', async (request, reply) => {
    const { matchId } = request.params;
    const cacheKey = `streams:${matchId}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      fastify.log.warn('Redis miss for streams', err);
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(matchId)) {
      reply.code(404);
      return { error: 'Match not found' };
    }

    const { rows } = await db.query(
      `SELECT id, url, quality, source_name, priority, is_healthy, last_checked, expires_at, latency_ms
       FROM stream_urls
       WHERE match_id = $1
         AND is_healthy = true
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY
         CASE quality WHEN 'HD' THEN 1 WHEN 'SD' THEN 2 ELSE 3 END ASC,
         priority DESC,
         latency_ms ASC NULLS LAST`,
      [matchId]
    );

    const apiBase = `${request.protocol}://${request.headers.host}`;
    const grouped = { SD: [], HD: [] };
    for (const row of rows) {
      const q = row.quality === 'HD' ? 'HD' : 'SD';
      // Routing:
      //   m3u8 → proxy/stream  (only playlist through server; segments go direct to CDN)
      //   flv  → proxy/flv     (pipes stream with correct Referer header)
      //   other (livepingscorex.com iframe players) → raw URL, rendered as <iframe>
      // The proxy is only needed when the CDN requires a specific Referer header.
      // If DIRECT_STREAMS=true, skip the proxy so the browser fetches CDN URLs
      // directly — useful when the server IP is geo-blocked by the CDN.
      const isM3u8  = row.url.includes('.m3u8');
      const isFlv   = /\.flv(\?|$)/i.test(row.url);
      const direct  = process.env.DIRECT_STREAMS === 'true';
      const proxyUrl = (isM3u8 && !direct) ? `${apiBase}/api/proxy/stream/${row.id}`
                     : (isFlv  && !direct) ? `${apiBase}/api/proxy/flv/${row.id}`
                     : row.url;
      grouped[q].push({
        id:           row.id,
        url:          proxyUrl,
        source_name:  row.source_name,
        priority:     row.priority,
        latency_ms:   row.latency_ms,
        last_checked: row.last_checked,
        expires_at:   row.expires_at,
      });
    }

    try {
      await redis.set(cacheKey, JSON.stringify(grouped), 'EX', 30);
    } catch (err) {
      fastify.log.warn('Failed to cache streams', err);
    }

    return grouped;
  });
};
