const db = require('../config/database');
const redis = require('../config/redis');

const MAIN_LIVE_SOURCE_TABS = ['soco-live', 'china-live'];
const MAIN_LIVE_LIMIT = 80;

module.exports = async function (fastify, opts) {
  fastify.get('/api/matches', async (request, reply) => {
    const { tab, search } = request.query;

    // Team name search — skip cache, run direct DB query
    if (search?.trim()) {
      const term = `%${search.trim()}%`;
      const tabFilter = tab ? ' AND t.slug = $2' : '';
      const params = tab ? [term, tab] : [term];
      const { rows } = await db.query(
        `SELECT m.id, m.title, m.home_team, m.away_team, m.home_logo, m.away_logo,
                m.status, m.scheduled_at, m.score_home, m.score_away, m.elapsed_minutes,
                m.league, t.slug AS source_tab
         FROM matches m
         JOIN tabs t ON m.tab_id = t.id
         WHERE (m.home_team ILIKE $1 OR m.away_team ILIKE $1)${tabFilter}
         ORDER BY
           CASE m.status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END ASC,
           m.scheduled_at ASC NULLS LAST
         LIMIT 50`,
        params
      );
      return rows;
    }

    const cacheKey = tab ? `matches:${tab}` : 'matches:all';

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      fastify.log.warn('Redis cache miss for matches', err);
    }

    // Auto-promote scheduled → live for any match whose kick-off time has passed.
    // Runs before the query so the returned data is always consistent with real time.
    await db.query(
      `UPDATE matches SET status = 'live'
       WHERE status = 'scheduled'
         AND scheduled_at IS NOT NULL
         AND scheduled_at <= NOW()`
    ).catch(() => {});

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
           AND m.status != 'finished'
           AND (m.scheduled_at IS NULL OR m.scheduled_at > NOW() - INTERVAL '3 hours')
           AND (m.scheduled_at IS NULL OR m.scheduled_at < NOW() + INTERVAL '24 hours')
         ORDER BY
           CASE m.status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END ASC,
           CASE
             WHEN m.league ILIKE '%premier league%'      OR m.league ILIKE '%英超%' OR m.league ILIKE '%ngoại hạng anh%' THEN 0
             WHEN m.league ILIKE '%la liga%'             OR m.league ILIKE '%西甲%'                                      THEN 1
             WHEN m.league ILIKE '%serie a%'             OR m.league ILIKE '%意甲%'                                      THEN 2
             WHEN m.league ILIKE '%bundesliga%'          OR m.league ILIKE '%德甲%'                                      THEN 3
             WHEN m.league ILIKE '%ligue 1%'             OR m.league ILIKE '%法甲%'                                      THEN 4
             WHEN m.league ILIKE '%champions league%'    OR m.league ILIKE '%ucl%'  OR m.league ILIKE '%欧冠%'           THEN 5
             WHEN m.league ILIKE '%europa league%'       OR m.league ILIKE '%欧联%'                                      THEN 6
             WHEN m.league ILIKE '%conference league%'   OR m.league ILIKE '%欧会%'                                      THEN 7
             WHEN m.league ILIKE '%world cup%'           OR m.league ILIKE '%世界杯%'                                     THEN 8
             WHEN m.league ILIKE '%eredivisie%'          OR m.league ILIKE '%fa cup%'                                   THEN 9
             ELSE 10
           END ASC,
           m.scheduled_at ASC
         LIMIT ${MAIN_LIVE_LIMIT}`,
        MAIN_LIVE_SOURCE_TABS
      );
      matches = result.rows;
    } else {
      const query = tab
        ? `SELECT m.id, m.title, m.home_team, m.away_team, m.home_logo, m.away_logo,
                  m.status, m.scheduled_at, m.score_home, m.score_away, m.elapsed_minutes,
                  m.league, t.slug AS source_tab
           FROM matches m
           JOIN tabs t ON m.tab_id = t.id
           WHERE t.slug = $1
           ORDER BY
             CASE m.status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END ASC,
             m.scheduled_at ASC NULLS LAST,
             m.created_at ASC`
        : `SELECT m.id, m.title, m.home_team, m.away_team, m.home_logo, m.away_logo,
                  m.status, m.scheduled_at, m.score_home, m.score_away, m.elapsed_minutes,
                  m.league, t.slug AS source_tab
           FROM matches m
           JOIN tabs t ON m.tab_id = t.id
           ORDER BY m.scheduled_at ASC`;

      const result = await db.query(query, tab ? [tab] : []);
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
              source_match_id, source_name, stream_page_url, created_at
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
