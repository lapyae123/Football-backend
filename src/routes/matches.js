const db = require('../config/database');
const redis = require('../config/redis');

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
      // Single UNION ALL query: manual matches (priority=0) always first,
      // scraped matches (priority=1) fill the rest — one DB round-trip.
      // Uses bare `league` column (no table alias) because this goes in the outer ORDER BY
      const LEAGUE_RANK = `CASE
             WHEN league ILIKE '%premier league%'      OR league ILIKE '%英超%' OR league ILIKE '%ngoại hạng anh%' THEN 0
             WHEN league ILIKE '%la liga%'             OR league ILIKE '%西甲%'                                     THEN 1
             WHEN league ILIKE '%serie a%'             OR league ILIKE '%意甲%'                                     THEN 2
             WHEN league ILIKE '%bundesliga%'          OR league ILIKE '%德甲%'                                     THEN 3
             WHEN league ILIKE '%ligue 1%'             OR league ILIKE '%法甲%'                                     THEN 4
             WHEN league ILIKE '%champions league%'    OR league ILIKE '%ucl%'  OR league ILIKE '%欧冠%'           THEN 5
             WHEN league ILIKE '%europa league%'       OR league ILIKE '%欧联%'                                     THEN 6
             WHEN league ILIKE '%conference league%'   OR league ILIKE '%欧会%'                                     THEN 7
             WHEN league ILIKE '%world cup%'           OR league ILIKE '%世界杯%'  OR league ILIKE '%fifa world cup%' THEN 8
             WHEN league ILIKE '%eredivisie%'          OR league ILIKE '%fa cup%'                                  THEN 9
             ELSE 10
           END`;
      const result = await db.query(
        `SELECT id, title, home_team, away_team, home_logo, away_logo,
                status, scheduled_at, score_home, score_away, elapsed_minutes,
                league, source_tab
         FROM (
           -- Manually-added main-live matches — no time filter, always shown
           SELECT m.id, m.title, m.home_team, m.away_team, m.home_logo, m.away_logo,
                  m.status, m.scheduled_at, m.score_home, m.score_away, m.elapsed_minutes,
                  m.league, t.slug AS source_tab, 0 AS priority
           FROM matches m JOIN tabs t ON m.tab_id = t.id
           WHERE t.slug = 'main-live' AND t.is_active = TRUE AND m.status != 'finished'

           UNION ALL

           -- Scraped matches from soco-live / china-live
           SELECT m.id, m.title, m.home_team, m.away_team, m.home_logo, m.away_logo,
                  m.status, m.scheduled_at, m.score_home, m.score_away, m.elapsed_minutes,
                  m.league, t.slug AS source_tab, 1 AS priority
           FROM matches m JOIN tabs t ON m.tab_id = t.id
           WHERE t.slug IN ('soco-live', 'china-live')
             AND t.is_active = TRUE
             AND m.status != 'finished'
             AND (m.scheduled_at IS NULL OR m.scheduled_at > NOW() - INTERVAL '3 hours')
             AND (
               m.scheduled_at IS NULL
               OR m.scheduled_at < NOW() + INTERVAL '24 hours'
               OR m.league ILIKE '%world cup%' OR m.league ILIKE '%世界杯%'
               OR m.league ILIKE '%champions league%' OR m.league ILIKE '%欧冠%'
               OR m.league ILIKE '%europa league%'
               OR m.league ILIKE '%euro %' OR m.league ILIKE '%uefa euro%'
               OR m.league ILIKE '%copa america%'
             )
         ) combined
         ORDER BY
           priority ASC,
           CASE status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END ASC,
           ${LEAGUE_RANK} ASC,
           scheduled_at ASC NULLS LAST
         LIMIT ${MAIN_LIVE_LIMIT}`
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
