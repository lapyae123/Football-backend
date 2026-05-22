const db    = require('../config/database');
const redis = require('../config/redis');
const { runForMatch }         = require('../scrapers/chinalive');
const { STREAM_CACHE_TTL_SEC } = require('../jobs/chinaliveSyncJob');

// How long to wait for another process holding the scrape lock (ms)
const LOCK_WAIT_MS    = 15000;
const LOCK_POLL_MS    = 500;
const LOCK_TTL_SEC    = 30;

const buildGrouped = (rows, apiBase) => {
  const grouped = { SD: [], HD: [] };
  for (const row of rows) {
    const q       = row.quality === 'HD' ? 'HD' : 'SD';
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
  return grouped;
};

const queryStreams = async (matchId) => {
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
  return rows;
};

module.exports = async function (fastify, opts) {
  fastify.get('/api/streams/:matchId', async (request, reply) => {
    const { matchId } = request.params;

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(matchId)) {
      reply.code(404);
      return { error: 'Match not found' };
    }

    const cacheKey = `streams:${matchId}`;
    const lockKey  = `lock:china:${matchId}`;
    const apiBase  = (process.env.BACKEND_URL || `${request.protocol}://${request.headers.host}`).replace(/\/$/, '');

    // ── 1. Cache hit → return immediately ────────────────────────────────────
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}

    // ── 2. Check if this is a china-live match ────────────────────────────────
    const matchRow = await db.query(
      "SELECT source_name FROM matches WHERE id = $1 LIMIT 1",
      [matchId]
    );
    const isChina = matchRow.rows[0]?.source_name === 'chinalive';

    if (isChina) {
      // ── 3a. Check DB first — pre-warm may have already saved fresh URLs ──────
      const dbRows = await queryStreams(matchId);
      if (dbRows.length > 0) {
        // Fresh URLs in DB (from pre-warm/re-warm) — cache and return immediately
        const grouped = buildGrouped(dbRows, apiBase);
        try { await redis.set(cacheKey, JSON.stringify(grouped), 'EX', STREAM_CACHE_TTL_SEC); } catch (_) {}
        return grouped;
      }

      // ── 3b. DB empty → on-demand scrape with lock ───────────────────────────
      let gotLock = false;
      try {
        const res = await redis.set(lockKey, '1', 'NX', 'EX', LOCK_TTL_SEC);
        gotLock = res === 'OK';
      } catch (_) {}

      if (gotLock) {
        try {
          await runForMatch(matchId, { fast: true });
        } catch (err) {
          fastify.log.warn('[streams] on-demand scrape failed:', err.message);
        } finally {
          try { await redis.del(lockKey); } catch (_) {}
        }
      } else {
        // Another request is scraping — wait for cache to populate
        const deadline = Date.now() + LOCK_WAIT_MS;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
          try {
            const cached = await redis.get(cacheKey);
            if (cached) return JSON.parse(cached);
          } catch (_) {}
        }
      }
    }

    // ── 4. Query DB → build proxy URLs → cache ────────────────────────────────
    const rows    = await queryStreams(matchId);
    const grouped = buildGrouped(rows, apiBase);

    try {
      const ttl = isChina ? STREAM_CACHE_TTL_SEC : 15;
      await redis.set(cacheKey, JSON.stringify(grouped), 'EX', ttl);
    } catch (_) {}

    return grouped;
  });
};
