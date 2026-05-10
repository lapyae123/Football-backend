const db = require('../config/database');
const redis = require('../config/redis');

module.exports = async function (fastify, opts) {
  // GET /api/streams/:matchId
  // Returns streams grouped by quality: { SD: [...], HD: [...] }
  fastify.get('/api/streams/:matchId', async (request, reply) => {
    const { matchId } = request.params;
    const cacheKey = `streams:${matchId}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      fastify.log.warn('Redis miss for streams', err);
    }

    // Reject non-UUID values before hitting the DB
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(matchId)) {
      reply.code(404);
      return { error: 'Match not found' };
    }

    const { rows } = await db.query(
      `SELECT id, url, quality, source_name, priority, is_healthy, last_checked, expires_at
       FROM stream_urls
       WHERE match_id = $1
         AND is_healthy = true
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY
         CASE quality WHEN 'HD' THEN 1 WHEN 'SD' THEN 2 ELSE 3 END ASC,
         priority ASC`,
      [matchId]
    );

    const grouped = { SD: [], HD: [] };
    for (const row of rows) {
      const q = row.quality === 'HD' ? 'HD' : 'SD';
      grouped[q].push({
        id:           row.id,
        url:          row.url,
        source_name:  row.source_name,
        priority:     row.priority,
        last_checked: row.last_checked,
        expires_at:   row.expires_at
      });
    }

    try {
      // Short TTL — stream URLs expire quickly
      await redis.set(cacheKey, JSON.stringify(grouped), 'EX', 30);
    } catch (err) {
      fastify.log.warn('Failed to cache streams', err);
    }

    return grouped;
  });
};
