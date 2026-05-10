const db = require('../config/database');
const redis = require('../config/redis');

module.exports = async function (fastify, opts) {
  // GET /api/servers
  // Lists all stream URLs with health status, bandwidth info, and grouping
  // Optional query params: ?tab=soco-live  ?healthy=true  ?matchId=<uuid>
  fastify.get('/api/servers', async (request, reply) => {
    const { tab, healthy, matchId } = request.query;
    const cacheKey = `servers:${tab || 'all'}:${healthy || 'all'}:${matchId || 'all'}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}

    const conditions = ['(su.expires_at IS NULL OR su.expires_at > NOW())'];
    const params = [];

    if (tab) {
      params.push(tab);
      conditions.push(`t.slug = $${params.length}`);
    }
    if (healthy === 'true') {
      conditions.push('su.is_healthy = true');
    } else if (healthy === 'false') {
      conditions.push('su.is_healthy = false');
    }
    if (matchId) {
      params.push(matchId);
      conditions.push(`su.match_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT
         su.id,
         su.url,
         su.quality,
         su.source_name,
         su.priority,
         su.is_healthy,
         su.fail_count,
         su.last_checked,
         su.expires_at,
         su.match_id,
         m.title      AS match_title,
         m.status     AS match_status,
         t.slug       AS tab_slug,
         t.name       AS tab_name
       FROM stream_urls su
       JOIN matches m ON su.match_id = m.id
       JOIN tabs    t ON m.tab_id    = t.id
       ${where}
       ORDER BY su.is_healthy DESC, su.fail_count ASC, su.quality DESC, su.priority ASC`,
      params
    );

    // Summary stats
    const total     = rows.length;
    const healthy_count   = rows.filter((r) => r.is_healthy).length;
    const unhealthy_count = total - healthy_count;
    const hd_count  = rows.filter((r) => r.quality === 'HD').length;
    const sd_count  = rows.filter((r) => r.quality === 'SD').length;

    const response = {
      summary: { total, healthy: healthy_count, unhealthy: unhealthy_count, HD: hd_count, SD: sd_count },
      servers: rows
    };

    try {
      await redis.set(cacheKey, JSON.stringify(response), 'EX', 20);
    } catch (_) {}

    return response;
  });

  // POST /api/servers/check/:streamId
  // Manually trigger a health check for one stream URL
  fastify.post('/api/servers/check/:streamId', async (request, reply) => {
    const { streamId } = request.params;

    const { rows } = await db.query(
      'SELECT id, url, fail_count FROM stream_urls WHERE id = $1 LIMIT 1',
      [streamId]
    );
    if (rows.length === 0) {
      reply.code(404);
      return { error: 'Stream not found' };
    }

    const stream = rows[0];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    let healthy = false;
    let statusCode = null;
    let latencyMs = null;

    const start = Date.now();
    try {
      const res = await fetch(stream.url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
        }
      });
      latencyMs = Date.now() - start;
      statusCode = res.status;
      healthy = res.ok || res.status === 206;
    } catch (err) {
      latencyMs = Date.now() - start;
      statusCode = null;
    } finally {
      clearTimeout(timer);
    }

    const newFailCount = healthy ? 0 : stream.fail_count + 1;
    await db.query(
      `UPDATE stream_urls
       SET is_healthy = $1, fail_count = $2, last_checked = NOW()
       WHERE id = $3`,
      [healthy, newFailCount, streamId]
    );

    // Invalidate server list cache
    try {
      const keys = await redis.keys('servers:*');
      if (keys.length) await redis.del(...keys);
      await redis.del(`streams:${stream.match_id}`);
    } catch (_) {}

    return {
      id:         streamId,
      url:        stream.url,
      healthy,
      status_code: statusCode,
      latency_ms:  latencyMs,
      fail_count:  newFailCount
    };
  });
};
