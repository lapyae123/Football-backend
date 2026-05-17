const jwt          = require('jsonwebtoken');
const db           = require('../config/database');
const redis        = require('../config/redis');
const scraperLog   = require('../config/scraperLog');
const scraperState = require('../config/scraperState');
const { run: runChinalive } = require('../scrapers/chinalive');
const { run: runSocolive  } = require('../scrapers/socolive');
const { run: runXoilac    } = require('../scrapers/xoilac');

const SCRAPER_RUNNERS = { chinalive: runChinalive, socolive: runSocolive, xoilac: runXoilac };

const JWT_SECRET   = process.env.JWT_SECRET        || 'football-admin-secret-dev';
const ADMIN_USER   = process.env.ADMIN_USERNAME    || 'admin';
const ADMIN_PASS   = process.env.ADMIN_PASSWORD    || '12345';
const TOKEN_TTL    = '24h';

// ─── Auth middleware ──────────────────────────────────────────────────────────

const requireJwt = async (request, reply) => {
  const auth = (request.headers.authorization || '').trim();
  if (!auth.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }
  try {
    request.admin = jwt.verify(auth.slice(7), JWT_SECRET);
  } catch {
    reply.code(401).send({ error: 'Token invalid or expired' });
  }
};

// ─── Cache helpers ────────────────────────────────────────────────────────────

const bust = async (...keys) => {
  try {
    const extra = [];
    for (const k of keys) {
      if (k.includes('*')) extra.push(...(await redis.keys(k)));
      else extra.push(k);
    }
    const all = [...new Set(extra)].filter(Boolean);
    if (all.length) await redis.del(...all);
  } catch (_) {}
};

// ─── Ban detection ───────────────────────────────────────────────────────────

const BAN_SIGNALS = {
  chinalive: {
    urls: async () => {
      try {
        const r = await db.query("SELECT config FROM sources WHERE slug='chinalive' LIMIT 1");
        const base = r.rows[0]?.config?.api_base || 'https://json.yyzb456.top';
        return [`${base}/all_live_rooms.json?v=1`];
      } catch { return ['https://json.yyzb456.top/all_live_rooms.json?v=1']; }
    },
    expect: (body) => body.includes('"code":200') || body.includes('"liveStatus"'),
  },
  socolive: {
    urls: async () => {
      try {
        const r = await db.query("SELECT config FROM sources WHERE slug='socolive' LIMIT 1");
        const urls = r.rows[0]?.config?.base_urls;
        if (Array.isArray(urls) && urls.length) return urls.slice(0, 2);
      } catch {}
      return ['https://www.socolive.tv/', 'https://www.barbaramassaad.com/'];
    },
    expect: (body) => body.includes('match-item') || body.includes('socolive'),
  },
};

const checkScraperAccess = async (slug) => {
  const signal = BAN_SIGNALS[slug];
  const urlList = typeof signal.urls === 'function' ? await signal.urls() : signal.urls;
  const results = [];

  for (const url of urlList) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/json,*/*',
        },
      });
      clearTimeout(timer);

      const body   = await res.text();
      const ms     = Date.now() - start;
      const valid  = signal.expect(body);
      const isCf   = body.includes('cloudflare') && body.includes('challenge');
      const is403  = res.status === 403 || res.status === 429;

      let status = 'ok';
      let reason = null;
      if (isCf)              { status = 'banned'; reason = 'Cloudflare challenge page'; }
      else if (is403)        { status = 'banned'; reason = `HTTP ${res.status}`; }
      else if (!valid)       { status = 'warning'; reason = 'Unexpected response — site may have changed'; }

      results.push({ url, status, http: res.status, latency_ms: ms, reason });
    } catch (err) {
      const timedOut = err.name === 'AbortError';
      results.push({
        url,
        status: timedOut ? 'timeout' : 'error',
        http:   null,
        latency_ms: Date.now() - start,
        reason: timedOut ? 'Request timed out (10s) — possible IP block' : err.message,
      });
    }
  }

  const worst = results.some((r) => r.status === 'banned')  ? 'banned'
              : results.some((r) => r.status === 'timeout') ? 'timeout'
              : results.some((r) => r.status === 'error')   ? 'error'
              : results.some((r) => r.status === 'warning') ? 'warning'
              : 'ok';

  return { slug, overall: worst, checks: results };
};

// ─── Routes ──────────────────────────────────────────────────────────────────

module.exports = async function adminRoutes(fastify) {

  // ── Login ──────────────────────────────────────────────────────────────────
  fastify.post('/api/admin/login', async (request, reply) => {
    const { username, password } = request.body || {};
    if (username !== ADMIN_USER || password !== ADMIN_PASS) {
      reply.code(401);
      return { error: 'Invalid credentials' };
    }
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    return { token };
  });

  // ── Dashboard stats ────────────────────────────────────────────────────────
  fastify.get('/api/admin/stats', { preHandler: requireJwt }, async () => {
    const [matchRes, streamRes, tabRes] = await Promise.all([
      db.query(`SELECT status, COUNT(*) AS n FROM matches GROUP BY status`),
      db.query(`SELECT is_healthy, COUNT(*) AS n FROM stream_urls GROUP BY is_healthy`),
      db.query(`SELECT t.name, t.slug, COUNT(m.id) AS match_count
                FROM tabs t LEFT JOIN matches m ON m.tab_id = t.id
                GROUP BY t.id ORDER BY t.position`),
    ]);

    const byStatus = Object.fromEntries(matchRes.rows.map((r) => [r.status, +r.n]));
    const healthy  = +streamRes.rows.find((r) => r.is_healthy)?.n  || 0;
    const unhealthy = +streamRes.rows.find((r) => !r.is_healthy)?.n || 0;

    return {
      matches: {
        live:      byStatus.live      || 0,
        scheduled: byStatus.scheduled || 0,
        finished:  byStatus.finished  || 0,
        total:     Object.values(byStatus).reduce((a, b) => a + b, 0),
      },
      streams:  { healthy, unhealthy, total: healthy + unhealthy },
      perTab:   tabRes.rows,
    };
  });

  // ── Tabs ───────────────────────────────────────────────────────────────────
  fastify.get('/api/admin/tabs', { preHandler: requireJwt }, async () => {
    const { rows } = await db.query(
      `SELECT id, name, slug, position, icon, color, description, config, is_active
       FROM tabs ORDER BY position`
    );
    return rows;
  });

  fastify.put('/api/admin/tabs/:id', { preHandler: requireJwt }, async (request, reply) => {
    const { id } = request.params;
    const { name, icon, color, description, config, is_active } = request.body || {};

    const { rows } = await db.query(
      `UPDATE tabs
       SET name        = COALESCE($1, name),
           icon        = COALESCE($2, icon),
           color       = COALESCE($3, color),
           description = COALESCE($4, description),
           config      = COALESCE($5::jsonb, config),
           is_active   = COALESCE($6, is_active)
       WHERE id = $7
       RETURNING id, name, slug, icon, color, description, config, is_active`,
      [name, icon, color, description,
       config != null ? JSON.stringify(config) : null,
       is_active, id]
    );
    if (!rows.length) { reply.code(404); return { error: 'Tab not found' }; }
    await bust('tabs:all', 'config:all');
    return rows[0];
  });

  // ── Matches ────────────────────────────────────────────────────────────────
  fastify.get('/api/admin/matches', { preHandler: requireJwt }, async (request) => {
    const { tab } = request.query;
    const query = tab
      ? `SELECT m.id, m.title, m.home_team, m.away_team, m.home_logo, m.away_logo,
                m.league, m.status, m.scheduled_at, m.score_home, m.score_away,
                t.slug AS source_tab, t.name AS tab_name,
                (SELECT COUNT(*) FROM stream_urls su WHERE su.match_id = m.id) AS stream_count
         FROM matches m JOIN tabs t ON m.tab_id = t.id
         WHERE t.slug = $1
         ORDER BY CASE m.status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
                  m.scheduled_at DESC`
      : `SELECT m.id, m.title, m.home_team, m.away_team,
                m.league, m.status, m.scheduled_at,
                t.slug AS source_tab, t.name AS tab_name,
                (SELECT COUNT(*) FROM stream_urls su WHERE su.match_id = m.id) AS stream_count
         FROM matches m JOIN tabs t ON m.tab_id = t.id
         ORDER BY m.scheduled_at DESC LIMIT 100`;
    const { rows } = await db.query(query, tab ? [tab] : []);
    return rows;
  });

  fastify.post('/api/admin/matches', { preHandler: requireJwt }, async (request, reply) => {
    const {
      tab_slug, title, home_team = '', away_team = '',
      home_logo, away_logo, league, status = 'scheduled', scheduled_at,
    } = request.body || {};

    if (!tab_slug) { reply.code(400); return { error: 'tab_slug is required' }; }
    if (!title && !home_team) { reply.code(400); return { error: 'title or home_team is required' }; }

    const tabRes = await db.query(
      'SELECT id FROM tabs WHERE slug = $1 LIMIT 1', [tab_slug]
    );
    if (!tabRes.rows.length) { reply.code(404); return { error: `Tab "${tab_slug}" not found` }; }
    const tab_id = tabRes.rows[0].id;

    const matchTitle = title || `${home_team} vs ${away_team}`;
    const { rows } = await db.query(
      `INSERT INTO matches
         (tab_id, title, home_team, away_team, home_logo, away_logo, league,
          status, scheduled_at, source_name, source_match_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',gen_random_uuid()::text,now())
       RETURNING id, title, home_team, away_team, league, status, scheduled_at`,
      [tab_id, matchTitle, home_team, away_team,
       home_logo || null, away_logo || null, league || null,
       status, scheduled_at || null]
    );
    await bust(`matches:${tab_slug}`, 'matches:all', 'matches:main-live');
    reply.code(201);
    return rows[0];
  });

  fastify.put('/api/admin/matches/:id', { preHandler: requireJwt }, async (request, reply) => {
    const { id } = request.params;
    const {
      title, home_team, away_team, home_logo, away_logo,
      league, status, scheduled_at, score_home, score_away, elapsed_minutes,
    } = request.body || {};

    const { rows } = await db.query(
      `UPDATE matches
       SET title           = COALESCE($1,  title),
           home_team       = COALESCE($2,  home_team),
           away_team       = COALESCE($3,  away_team),
           home_logo       = COALESCE($4,  home_logo),
           away_logo       = COALESCE($5,  away_logo),
           league          = COALESCE($6,  league),
           status          = COALESCE($7,  status),
           scheduled_at    = COALESCE($8,  scheduled_at),
           score_home      = COALESCE($9,  score_home),
           score_away      = COALESCE($10, score_away),
           elapsed_minutes = COALESCE($11, elapsed_minutes)
       WHERE id = $12
       RETURNING id, title, home_team, away_team, league, status, scheduled_at`,
      [title, home_team, away_team, home_logo, away_logo, league,
       status, scheduled_at, score_home, score_away, elapsed_minutes, id]
    );
    if (!rows.length) { reply.code(404); return { error: 'Match not found' }; }
    await bust('matches:*');
    return rows[0];
  });

  fastify.delete('/api/admin/matches/:id', { preHandler: requireJwt }, async (request, reply) => {
    const { id } = request.params;
    const { rowCount } = await db.query('DELETE FROM matches WHERE id = $1', [id]);
    if (!rowCount) { reply.code(404); return { error: 'Match not found' }; }
    await bust('matches:*', `streams:${id}`);
    reply.code(204);
    return null;
  });

  // ── Streams ────────────────────────────────────────────────────────────────
  fastify.get('/api/admin/matches/:id/streams', { preHandler: requireJwt }, async (request, reply) => {
    const { id } = request.params;
    const { rows } = await db.query(
      `SELECT id, url, quality, source_name, priority, is_healthy, fail_count,
              latency_ms, expires_at, created_at
       FROM stream_urls WHERE match_id = $1
       ORDER BY quality DESC, priority DESC, created_at DESC`,
      [id]
    );
    return rows;
  });

  fastify.post('/api/admin/matches/:id/streams', { preHandler: requireJwt }, async (request, reply) => {
    const { id } = request.params;
    const { url, quality = 'SD', source_name = 'manual', priority = 1 } = request.body || {};

    if (!url) { reply.code(400); return { error: 'url is required' }; }

    const matchRes = await db.query('SELECT id FROM matches WHERE id = $1 LIMIT 1', [id]);
    if (!matchRes.rows.length) { reply.code(404); return { error: 'Match not found' }; }

    const q = /hd/i.test(quality) ? 'HD' : 'SD';
    const { rows } = await db.query(
      `INSERT INTO stream_urls
         (match_id, url, quality, source_name, priority, is_healthy, created_at)
       VALUES ($1,$2,$3,$4,$5,true,now())
       RETURNING id, url, quality, source_name, priority, is_healthy`,
      [id, url, q, source_name, priority]
    );
    await bust(`streams:${id}`);
    reply.code(201);
    return rows[0];
  });

  fastify.delete('/api/admin/streams/:streamId', { preHandler: requireJwt }, async (request, reply) => {
    const { streamId } = request.params;
    const res = await db.query(
      'DELETE FROM stream_urls WHERE id = $1 RETURNING match_id', [streamId]
    );
    if (!res.rowCount) { reply.code(404); return { error: 'Stream not found' }; }
    await bust(`streams:${res.rows[0].match_id}`);
    reply.code(204);
    return null;
  });

  // ── App Config ─────────────────────────────────────────────────────────────
  fastify.get('/api/admin/config', { preHandler: requireJwt }, async () => {
    const { rows } = await db.query('SELECT key, value, updated_at FROM app_config ORDER BY key');
    return Object.fromEntries(rows.map((r) => [r.key, { value: r.value, updated_at: r.updated_at }]));
  });

  fastify.put('/api/admin/config/:key', { preHandler: requireJwt }, async (request, reply) => {
    const { key } = request.params;
    const { value } = request.body || {};
    if (value === undefined) { reply.code(400); return { error: 'value is required' }; }

    const { rows } = await db.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING key, value, updated_at`,
      [key, JSON.stringify(value)]
    );
    await bust('config:all');
    return rows[0];
  });

  // ── Sources (scraper URL management) ──────────────────────────────────────
  fastify.get('/api/admin/sources', { preHandler: requireJwt }, async () => {
    const { rows } = await db.query(
      `SELECT id, name, slug, driver_type, base_domain, is_active,
              health_score, last_checked, config, created_at
       FROM sources ORDER BY name`
    );
    return rows;
  });

  fastify.put('/api/admin/sources/:id', { preHandler: requireJwt }, async (request, reply) => {
    const { id } = request.params;
    const { name, base_domain, is_active, config } = request.body || {};

    const { rows } = await db.query(
      `UPDATE sources
       SET name        = COALESCE($1, name),
           base_domain = COALESCE($2, base_domain),
           is_active   = COALESCE($3, is_active),
           config      = COALESCE($4::jsonb, config)
       WHERE id = $5
       RETURNING id, name, slug, driver_type, base_domain, is_active, config`,
      [name, base_domain, is_active,
       config != null ? JSON.stringify(config) : null,
       id]
    );
    if (!rows.length) { reply.code(404); return { error: 'Source not found' }; }
    return rows[0];
  });

  // ── Scraper Ban Detection ─────────────────────────────────────────────────

  fastify.get('/api/admin/scrapers/ban-check', { preHandler: requireJwt }, async () => {
    const checks = await Promise.all([
      checkScraperAccess('chinalive'),
      checkScraperAccess('socolive'),
    ]);
    return checks;
  });

  // ── Scraper Controls ───────────────────────────────────────────────────────

  fastify.get('/api/admin/scrapers', { preHandler: requireJwt }, async () => {
    const { rows } = await db.query(
      `SELECT id, name, slug, is_active FROM sources WHERE slug IN ('chinalive','socolive') ORDER BY name`
    );

    return rows.map((s) => {
      const state = scraperState.get(s.slug);
      return {
        id:          s.id,
        name:        s.name,
        slug:        s.slug,
        is_active:   s.is_active,
        running:     state.running    ?? false,
        last_run_at: state.lastRunAt  ? new Date(state.lastRunAt).toISOString()  : null,
        last_result: state.lastResult ?? null,
      };
    });
  });

  fastify.post('/api/admin/scrapers/:slug/toggle', { preHandler: requireJwt }, async (request, reply) => {
    const { slug } = request.params;
    if (!['chinalive', 'socolive'].includes(slug)) {
      reply.code(400);
      return { error: 'Unknown scraper slug' };
    }

    const { rows } = await db.query(
      `UPDATE sources SET is_active = NOT is_active
       WHERE slug = $1
       RETURNING id, name, slug, is_active`,
      [slug]
    );
    if (!rows.length) { reply.code(404); return { error: 'Scraper not found' }; }

    return { slug: rows[0].slug, is_active: rows[0].is_active };
  });

  // ── Scraper: trigger manual run ────────────────────────────────────────────
  fastify.post('/api/admin/scrapers/:slug/run', { preHandler: requireJwt }, async (request, reply) => {
    const { slug } = request.params;
    try {
      if (!SCRAPER_RUNNERS[slug]) {
        reply.code(400);
        return { error: 'Unknown scraper slug' };
      }

      if (scraperState.isRunning(slug)) {
        return { slug, status: 'already_running' };
      }

      scraperLog.clear(slug);
      scraperState.start(slug);

      SCRAPER_RUNNERS[slug]()
        .then(() => scraperState.finish(slug, 'ok'))
        .catch((err) => {
          console.error(`[admin] Manual scrape ${slug} failed:`, err.message);
          scraperState.finish(slug, 'error', err.message);
        });

      reply.code(202);
      return { slug, status: 'started' };
    } catch (err) {
      console.error(`[admin] Run scraper ${slug} error:`, err.message);
      reply.code(500);
      return { error: err.message || 'Failed to start scraper' };
    }
  });

  // ── Scraper: live logs ─────────────────────────────────────────────────────
  fastify.get('/api/admin/scrapers/:slug/logs', { preHandler: requireJwt }, async (request) => {
    const { slug } = request.params;
    const since    = parseInt(request.query.since || '0', 10);
    return { slug, running: scraperState.isRunning(slug), lines: scraperLog.read(slug, since) };
  });

  // ── Scraper: status check ──────────────────────────────────────────────────
  fastify.get('/api/admin/scrapers/:slug/status', { preHandler: requireJwt }, async (request) => {
    const { slug } = request.params;
    const s = scraperState.get(slug);
    return {
      slug,
      running:     s.running    ?? false,
      started_at:  s.startedAt  ? new Date(s.startedAt).toISOString()  : null,
      last_run_at: s.lastRunAt  ? new Date(s.lastRunAt).toISOString()  : null,
      last_result: s.lastResult ?? null,
    };
  });

  // ── API Test Runner ────────────────────────────────────────────────────────
  fastify.post('/api/admin/run-tests', { preHandler: requireJwt }, async (request) => {
    const baseUrl = request.body?.base_url || `http://localhost:${process.env.PORT || 3050}`;
    const { runTests } = require('../tests/api.test');
    return runTests(baseUrl);
  });
};
