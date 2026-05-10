const db = require('../config/database');
const redis = require('../config/redis');

const requireAdminKey = (request, reply, done) => {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    reply.code(503).send({ error: 'Admin API not configured' });
    return;
  }
  if (request.headers['x-admin-key'] !== adminKey) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }
  done();
};

const invalidateEnglishCache = async () => {
  try {
    await redis.del('matches:english');
  } catch (_) {}
};

module.exports = async function (fastify, opts) {
  // POST /api/admin/english/matches — add a match to the English tab
  fastify.post('/api/admin/english/matches', { preHandler: requireAdminKey }, async (request, reply) => {
    const { title, home_team = '', away_team = '', home_logo, away_logo, status = 'scheduled', scheduled_at } = request.body || {};

    if (!title) {
      reply.code(400);
      return { error: 'title is required' };
    }

    const englishTab = await db.query("SELECT id FROM tabs WHERE slug = 'english' LIMIT 1");
    if (englishTab.rows.length === 0) {
      reply.code(500);
      return { error: 'English tab not found in database' };
    }
    const tab_id = englishTab.rows[0].id;

    const result = await db.query(
      `INSERT INTO matches (tab_id, title, home_team, away_team, home_logo, away_logo, status, scheduled_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       RETURNING id, title, home_team, away_team, status, scheduled_at`,
      [tab_id, title, home_team, away_team, home_logo || null, away_logo || null, status, scheduled_at || null]
    );

    await invalidateEnglishCache();
    reply.code(201);
    return result.rows[0];
  });

  // DELETE /api/admin/english/matches/:id — remove a match (cascades stream_urls)
  fastify.delete('/api/admin/english/matches/:id', { preHandler: requireAdminKey }, async (request, reply) => {
    const { id } = request.params;

    const existing = await db.query(
      `SELECT m.id FROM matches m
       JOIN tabs t ON m.tab_id = t.id
       WHERE m.id = $1 AND t.slug = 'english'`,
      [id]
    );
    if (existing.rows.length === 0) {
      reply.code(404);
      return { error: 'Match not found in English tab' };
    }

    await db.query('DELETE FROM matches WHERE id = $1', [id]);
    await invalidateEnglishCache();
    reply.code(204);
    return null;
  });

  // POST /api/admin/english/matches/:id/streams — add a stream URL to a match
  fastify.post('/api/admin/english/matches/:id/streams', { preHandler: requireAdminKey }, async (request, reply) => {
    const { id } = request.params;
    const { url, quality = 'SD', source_name, priority = 1 } = request.body || {};

    if (!url) {
      reply.code(400);
      return { error: 'url is required' };
    }

    const existing = await db.query(
      `SELECT m.id FROM matches m
       JOIN tabs t ON m.tab_id = t.id
       WHERE m.id = $1 AND t.slug = 'english'`,
      [id]
    );
    if (existing.rows.length === 0) {
      reply.code(404);
      return { error: 'Match not found in English tab' };
    }

    const normalizedQuality = /hd/i.test(quality) ? 'HD' : 'SD';

    const result = await db.query(
      `INSERT INTO stream_urls (match_id, url, quality, source_name, priority, is_healthy, created_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, now())
       RETURNING id, url, quality, source_name, priority`,
      [id, url, normalizedQuality, source_name || null, priority]
    );

    try {
      await redis.del(`streams:${id}`);
    } catch (_) {}

    reply.code(201);
    return result.rows[0];
  });

  // DELETE /api/admin/english/streams/:streamId — remove a stream URL
  fastify.delete('/api/admin/english/streams/:streamId', { preHandler: requireAdminKey }, async (request, reply) => {
    const { streamId } = request.params;

    const existing = await db.query(
      `SELECT su.id, su.match_id FROM stream_urls su
       JOIN matches m ON su.match_id = m.id
       JOIN tabs t ON m.tab_id = t.id
       WHERE su.id = $1 AND t.slug = 'english'`,
      [streamId]
    );
    if (existing.rows.length === 0) {
      reply.code(404);
      return { error: 'Stream URL not found in English tab' };
    }

    const matchId = existing.rows[0].match_id;
    await db.query('DELETE FROM stream_urls WHERE id = $1', [streamId]);

    try {
      await redis.del(`streams:${matchId}`);
    } catch (_) {}

    reply.code(204);
    return null;
  });
};
