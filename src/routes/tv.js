const db    = require('../config/database');
const redis = require('../config/redis');

const CACHE_TTL = 120; // 2 minutes

module.exports = async function (fastify) {

  // ── Public: list all active channels ────────────────────────────────────────
  fastify.get('/api/tv', async (request) => {
    const { type } = request.query; // ?type=tv | ?type=radio
    const cacheKey = `tv:${type || 'all'}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}

    const where = type ? 'WHERE is_active = true AND type = $1' : 'WHERE is_active = true';
    const params = type ? [type] : [];

    const { rows } = await db.query(
      `SELECT id, name, slug, type, category, emoji, color, logo_url, stream_url,
              position, country, language
       FROM tv_channels
       ${where}
       ORDER BY category, position, name`,
      params
    );

    const apiBase = `${request.protocol}://${request.headers.host}`;

    // Group by category; replace stream_url with backend proxy URL so the player
    // never hits the CDN directly (avoids CORS + adds correct Referer header)
    const grouped = {};
    for (const ch of rows) {
      if (!grouped[ch.category]) grouped[ch.category] = [];
      grouped[ch.category].push({
        ...ch,
        stream_url: ch.stream_url ? `${apiBase}/api/proxy/tv/${ch.id}` : null,
      });
    }
    const result = Object.entries(grouped).map(([category, channels]) => ({ category, channels }));

    try { await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL); } catch (_) {}
    return result;
  });

  // ── Public: single channel ───────────────────────────────────────────────────
  fastify.get('/api/tv/:id', async (request, reply) => {
    const { id } = request.params;
    const cacheKey = `tv:channel:${id}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}

    const { rows } = await db.query(
      `SELECT id, name, slug, type, category, emoji, color, logo_url, stream_url
       FROM tv_channels WHERE id = $1 AND is_active = true`,
      [id]
    );

    if (!rows.length) { reply.code(404); return { error: 'Channel not found' }; }

    const ch = rows[0];
    const apiBase = `${request.protocol}://${request.headers.host}`;
    const result = {
      ...ch,
      stream_url: ch.stream_url ? `${apiBase}/api/proxy/tv/${ch.id}` : null,
    };

    try { await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL); } catch (_) {}
    return result;
  });

  // ── Admin: full CRUD ─────────────────────────────────────────────────────────

  const bustCache = async () => {
    try {
      const keys = await redis.keys('tv:*');
      if (keys.length) await redis.del(...keys);
    } catch (_) {}
  };

  fastify.get('/api/admin/tv', async () => {
    const { rows } = await db.query(
      `SELECT id, name, slug, type, category, emoji, color, logo_url, stream_url,
              is_active, position, country, language, created_at, updated_at
       FROM tv_channels
       ORDER BY type, category, position, name`
    );
    return rows;
  });

  fastify.post('/api/admin/tv', async (request, reply) => {
    const {
      name, slug, type = 'tv', category = 'General',
      emoji = '📺', color = '#00FF87', logo_url, stream_url,
      is_active = true, position = 0, country, language,
    } = request.body || {};

    if (!name) { reply.code(400); return { error: 'name is required' }; }

    const autoSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const { rows } = await db.query(
      `INSERT INTO tv_channels
         (name, slug, type, category, emoji, color, logo_url, stream_url,
          is_active, position, country, language)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [name, autoSlug, type, category, emoji, color,
       logo_url || null, stream_url || null, is_active, position,
       country || 'Myanmar', language || 'Burmese']
    );

    await bustCache();
    reply.code(201);
    return rows[0];
  });

  fastify.put('/api/admin/tv/:id', async (request, reply) => {
    const { id } = request.params;
    const {
      name, category, emoji, color, logo_url, stream_url,
      is_active, position, country, language,
    } = request.body || {};

    const { rows } = await db.query(
      `UPDATE tv_channels
       SET name       = COALESCE($1, name),
           category   = COALESCE($2, category),
           emoji      = COALESCE($3, emoji),
           color      = COALESCE($4, color),
           logo_url   = $5,
           stream_url = $6,
           is_active  = COALESCE($7, is_active),
           position   = COALESCE($8, position),
           country    = COALESCE($9, country),
           language   = COALESCE($10, language),
           updated_at = NOW()
       WHERE id = $11
       RETURNING *`,
      [name, category, emoji, color,
       logo_url !== undefined ? (logo_url || null) : undefined,
       stream_url !== undefined ? (stream_url || null) : undefined,
       is_active, position, country, language, id]
    );

    if (!rows.length) { reply.code(404); return { error: 'Channel not found' }; }
    await bustCache();
    return rows[0];
  });

  fastify.delete('/api/admin/tv/:id', async (request, reply) => {
    const { id } = request.params;
    const { rowCount } = await db.query('DELETE FROM tv_channels WHERE id = $1', [id]);
    if (!rowCount) { reply.code(404); return { error: 'Channel not found' }; }
    await bustCache();
    reply.code(204);
    return null;
  });
};
