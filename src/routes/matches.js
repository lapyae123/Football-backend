const db = require('../config/database');
const redis = require('../config/redis');

const MAIN_LIVE_SOURCE_TABS = ['soco-live', 'china-live', 'loungsan'];
const MAIN_LIVE_LIMIT = 10;

module.exports = async function (fastify, opts) {
  fastify.get('/api/matches', async (request, reply) => {
    const { tab } = request.query;
    const cacheKey = tab ? `matches:${tab}` : 'matches:all';

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      fastify.log.warn('Redis cache miss for matches', err);
    }

    let matches;

    if (tab === 'main-live') {
      // Aggregate top 10 from source tabs, live matches first then soonest upcoming
      const placeholders = MAIN_LIVE_SOURCE_TABS.map((_, i) => `$${i + 1}`).join(', ');
      const result = await db.query(
        `SELECT m.id, m.title, m.home_team, m.away_team, m.home_logo, m.away_logo,
                m.status, m.scheduled_at, m.score_home, m.score_away, m.elapsed_minutes,
                m.league, t.slug AS source_tab
         FROM matches m
         JOIN tabs t ON m.tab_id = t.id
         WHERE t.slug IN (${placeholders})
           AND t.is_active = TRUE
         ORDER BY
           CASE m.status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END ASC,
           CASE
             WHEN m.league ILIKE '%champions league%' OR m.league ILIKE '%ucl%' THEN 0
             WHEN m.league ILIKE '%premier league%'                              THEN 1
             WHEN m.league ILIKE '%la liga%'                                     THEN 2
             WHEN m.league ILIKE '%bundesliga%'                                  THEN 3
             WHEN m.league ILIKE '%serie a%'                                     THEN 4
             WHEN m.league ILIKE '%ligue 1%'                                     THEN 5
             ELSE 9
           END ASC,
           m.scheduled_at ASC
         LIMIT ${MAIN_LIVE_LIMIT}`,
        MAIN_LIVE_SOURCE_TABS
      );
      matches = result.rows;
    } else {
      // All non-main-live queries return the same canonical shape as main-live:
      // source_tab and league are always present so the frontend never needs special-casing.
      const query = tab
        ? `SELECT m.id, m.title, m.home_team, m.away_team, m.home_logo, m.away_logo,
                  m.status, m.scheduled_at, m.score_home, m.score_away, m.elapsed_minutes,
                  m.league, t.slug AS source_tab
           FROM matches m
           JOIN tabs t ON m.tab_id = t.id
           WHERE t.slug = $1
           ORDER BY
             CASE m.status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END ASC,
             m.scheduled_at ASC`
        : `SELECT m.id, m.title, m.home_team, m.away_team, m.home_logo, m.away_logo,
                  m.status, m.scheduled_at, m.score_home, m.score_away, m.elapsed_minutes,
                  m.league, t.slug AS source_tab
           FROM matches m
           JOIN tabs t ON m.tab_id = t.id
           ORDER BY m.scheduled_at ASC`;

      const params = tab ? [tab] : [];
      const result = await db.query(query, params);
      matches = result.rows;
    }

    try {
      await redis.set(cacheKey, JSON.stringify(matches), 'EX', 30);
    } catch (err) {
      fastify.log.warn('Failed to cache matches', err);
    }

    return matches;
  });

  fastify.get('/api/matches/:id', async (request, reply) => {
    const { id } = request.params;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) {
      reply.code(404);
      return { error: 'Match not found' };
    }
    const result = await db.query(
      `SELECT id, tab_id, title, home_team, away_team, home_logo, away_logo,
              status, scheduled_at, score_home, score_away, elapsed_minutes,
              source_match_id, source_name, created_at
       FROM matches WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      reply.code(404);
      return { error: 'Match not found' };
    }

    return result.rows[0];
  });
};
