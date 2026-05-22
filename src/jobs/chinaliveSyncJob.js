const db           = require('../config/database');
const redis        = require('../config/redis');
const scraperState = require('../config/scraperState');
const { syncSchedule, runForMatch } = require('../scrapers/chinalive');
const { isWithinActiveHours } = require('../config/scraperSchedule');

const SLUG     = 'chinalive';
const TAB_SLUG = 'china-live';

// How long before kickoff to pre-warm stream URLs (ms)
const PREWARM_BEFORE_MS = 10 * 60 * 1000;  // 10 minutes

// How often to re-warm URLs while a match is live (ms)
const REWARM_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// How often to sync today's schedule (ms)
const SCHEDULE_SYNC_INTERVAL_MS = parseInt(process.env.CHINA_SCHEDULE_SYNC_MS, 10) || 6 * 60 * 60 * 1000; // 6 hours

// Redis stream cache TTL — must be < token lifetime (30-50 min) and >= re-warm interval
const STREAM_CACHE_TTL_SEC = 16 * 60; // 16 min (slightly more than 15 min re-warm)

// In-memory set of match IDs that already have timers scheduled this process lifetime
const scheduledPrewarms = new Set();
const rewarmTimers      = new Map(); // dbMatchId → setTimeout handle

// ─── Source/tab active check ──────────────────────────────────────────────────

const getSourceConfig = async () => {
  try {
    const r = await db.query('SELECT config, is_active FROM sources WHERE slug = $1 LIMIT 1', [SLUG]);
    return r.rows[0] || {};
  } catch (_) { return {}; }
};

const shouldRun = async (src) => {
  try {
    const tabRes = await db.query('SELECT is_active FROM tabs WHERE slug = $1 LIMIT 1', [TAB_SLUG]);
    if (src.is_active === false || tabRes.rows[0]?.is_active === false) return false;
  } catch (_) {}

  if (!isWithinActiveHours(src.config)) {
    const hours = src.config?.active_hours;
    console.log(`[chinaliveSyncJob] Skipped — outside active hours (${hours?.from}–${hours?.to})`);
    return false;
  }
  return true;
};

// ─── Redis cache warm/invalidate for a single match ──────────────────────────

const invalidateMatchCache = async (dbMatchId) => {
  try { await redis.del(`streams:${dbMatchId}`); } catch (_) {}
};

// After a successful scrape, write fresh stream URLs straight into Redis so the
// very first user request is a cache HIT (< 1ms) instead of a DB round-trip.
const warmMatchCache = async (dbMatchId, apiBase) => {
  try {
    const { rows } = await db.query(
      `SELECT id, url, quality, source_name, priority, is_healthy, last_checked, expires_at, latency_ms
       FROM stream_urls
       WHERE match_id = $1
         AND is_healthy = true
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY
         CASE quality WHEN 'HD' THEN 1 WHEN 'SD' THEN 2 ELSE 3 END ASC,
         priority DESC, latency_ms ASC NULLS LAST`,
      [dbMatchId]
    );
    if (!rows.length) return;

    const base    = apiBase || process.env.BACKEND_URL || 'http://localhost:3050';
    const direct  = process.env.DIRECT_STREAMS === 'true';
    const grouped = { SD: [], HD: [] };
    for (const row of rows) {
      const q        = row.quality === 'HD' ? 'HD' : 'SD';
      const isM3u8   = row.url.includes('.m3u8');
      const isFlv    = /\.flv(\?|$)/i.test(row.url);
      const proxyUrl = (isM3u8 && !direct) ? `${base}/api/proxy/stream/${row.id}`
                     : (isFlv  && !direct) ? `${base}/api/proxy/flv/${row.id}`
                     : row.url;
      grouped[q].push({ id: row.id, url: proxyUrl, source_name: row.source_name,
                        priority: row.priority, latency_ms: row.latency_ms,
                        last_checked: row.last_checked, expires_at: row.expires_at });
    }
    await redis.set(`streams:${dbMatchId}`, JSON.stringify(grouped), 'EX', STREAM_CACHE_TTL_SEC);
  } catch (_) {}
};

// ─── Re-warm: refresh stream URLs every 15 min while match is live ───────────

const scheduleRewarm = (dbMatchId, matchLabel) => {
  // Cancel any existing re-warm for this match first
  if (rewarmTimers.has(dbMatchId)) {
    clearTimeout(rewarmTimers.get(dbMatchId));
  }

  const handle = setTimeout(async () => {
    rewarmTimers.delete(dbMatchId);

    // Check if match is still live before re-warming
    try {
      const r = await db.query(
        "SELECT status FROM matches WHERE id = $1 LIMIT 1",
        [dbMatchId]
      );
      const status = r.rows[0]?.status;
      if (!status || status === 'finished') {
        console.log(`[chinaPrewarm] Re-warm skipped — ${matchLabel} finished`);
        return;
      }
    } catch (_) {}

    console.log(`[chinaPrewarm] Re-warming ${matchLabel}…`);
    try {
      const ok = await runForMatch(dbMatchId, { fast: false });
      if (ok) {
        await warmMatchCache(dbMatchId);
        console.log(`[chinaPrewarm] Re-warm done — ${matchLabel}`);
        scheduleRewarm(dbMatchId, matchLabel);
      }
    } catch (err) {
      console.error(`[chinaPrewarm] Re-warm error ${matchLabel}:`, err.message);
      scheduleRewarm(dbMatchId, matchLabel);
    }
  }, REWARM_INTERVAL_MS);

  rewarmTimers.set(dbMatchId, handle);
};

// ─── Pre-warm: fetch stream URLs before kickoff ───────────────────────────────

const schedulePrewarm = (dbMatchId, matchTime, matchLabel) => {
  if (scheduledPrewarms.has(dbMatchId)) return; // already scheduled
  scheduledPrewarms.add(dbMatchId);

  const delay = matchTime - PREWARM_BEFORE_MS - Date.now();

  if (delay < 0) {
    // kickoff already passed or within pre-warm window — run immediately
    console.log(`[chinaPrewarm] Pre-warming now (past window) — ${matchLabel}`);
    runForMatch(dbMatchId, { fast: false })
      .then(async (ok) => {
        if (ok) {
          await warmMatchCache(dbMatchId);
          scheduleRewarm(dbMatchId, matchLabel);
        }
      })
      .catch((err) => console.error(`[chinaPrewarm] Pre-warm error ${matchLabel}:`, err.message));
    return;
  }

  console.log(`[chinaPrewarm] Pre-warm scheduled in ${Math.round(delay / 60000)} min — ${matchLabel}`);
  setTimeout(async () => {
    console.log(`[chinaPrewarm] Pre-warming ${matchLabel}…`);
    try {
      const ok = await runForMatch(dbMatchId, { fast: false });
      if (ok) {
        await warmMatchCache(dbMatchId);
        console.log(`[chinaPrewarm] Pre-warm done — ${matchLabel}`);
        scheduleRewarm(dbMatchId, matchLabel);
      }
    } catch (err) {
      console.error(`[chinaPrewarm] Pre-warm error ${matchLabel}:`, err.message);
    }
  }, delay);
};

// ─── Load upcoming matches from DB and schedule pre-warm timers ──────────────

const scheduleUpcoming = async () => {
  // Look 6 hours ahead (covers the next schedule sync window)
  const { rows } = await db.query(
    `SELECT id, home_team, away_team, scheduled_at, status
     FROM matches
     WHERE source_name = 'chinalive'
       AND status IN ('scheduled', 'live')
       AND scheduled_at > NOW() - INTERVAL '30 minutes'
       AND scheduled_at < NOW() + INTERVAL '6 hours'
     ORDER BY scheduled_at ASC`,
  );

  for (const row of rows) {
    const label     = `${row.home_team} vs ${row.away_team}`;
    const matchTime = new Date(row.scheduled_at).getTime();

    if (row.status === 'live') {
      // Already live — start re-warm cycle immediately
      if (!rewarmTimers.has(row.id)) {
        console.log(`[chinaPrewarm] Starting re-warm cycle for live match — ${label}`);
        scheduleRewarm(row.id, label);
      }
    } else {
      schedulePrewarm(row.id, matchTime, label);
    }
  }
};

// ─── Main schedule sync tick ──────────────────────────────────────────────────

const tick = async () => {
  const src = await getSourceConfig();

  if (!(await shouldRun(src))) {
    setTimeout(tick, SCHEDULE_SYNC_INTERVAL_MS);
    return;
  }

  if (scraperState.isRunning(SLUG)) {
    console.log('[chinaliveSyncJob] Skipped — already running');
    setTimeout(tick, SCHEDULE_SYNC_INTERVAL_MS);
    return;
  }

  scraperState.start(SLUG);
  try {
    await syncSchedule();
    scraperState.finish(SLUG, 'ok');
  } catch (err) {
    console.error('[chinaliveSyncJob] Sync failed:', err.message);
    scraperState.finish(SLUG, 'error', err.message);
  }

  // After every sync, refresh pre-warm timers for newly discovered matches
  try {
    await scheduleUpcoming();
  } catch (err) {
    console.error('[chinaliveSyncJob] scheduleUpcoming failed:', err.message);
  }

  setTimeout(tick, SCHEDULE_SYNC_INTERVAL_MS);
};

tick();

module.exports = { STREAM_CACHE_TTL_SEC };
