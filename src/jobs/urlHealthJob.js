const db = require('../config/database');
const { run: rerunSoco }  = require('../scrapers/socolive');
const { run: rerunChina } = require('../scrapers/chinalive');

const DEFAULT_INTERVAL_MS  = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS, 10) || 10 * 60 * 1000;
const DEFAULT_failThreshold = parseInt(process.env.HEALTH_failThreshold, 10)  || 10;
const FETCH_TIMEOUT_MS = 8000;

const getHealthConfig = async () => {
  try {
    const r = await db.query("SELECT value FROM app_config WHERE key = 'health' LIMIT 1");
    const cfg = r.rows[0]?.value || {};
    return {
      intervalMs:    (cfg.interval_ms    >= 30000) ? cfg.interval_ms    : DEFAULT_INTERVAL_MS,
      failThreshold: (cfg.fail_threshold >= 1)     ? cfg.fail_threshold : DEFAULT_failThreshold,
    };
  } catch (_) {
    return { intervalMs: DEFAULT_INTERVAL_MS, failThreshold: DEFAULT_failThreshold };
  }
};

const checkUrl = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const start = Date.now();
  try {
    // Try HEAD first; fall back to GET with Range (some CDNs reject HEAD)
    let res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
    });
    if (res.status === 405 || res.status === 403) {
      res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Range': 'bytes=0-1',
        }
      });
    }
    const ok = res.ok || res.status === 206;
    return { ok, latency: ok ? Date.now() - start : null };
  } catch (_) {
    return { ok: false, latency: null };
  } finally {
    clearTimeout(timer);
  }
};

const tryRerun = async (fn, label) => {
  console.log(`[urlHealthJob] Re-scraping ${label}…`);
  try { await fn(); } catch (err) { console.error(`[urlHealthJob] ${label} re-scrape failed:`, err.message); }
};

const runHealthCheck = async (failThreshold) => {
  console.log('[urlHealthJob] Starting health check…');

  const { rows: streams } = await db.query(
    `SELECT su.id, su.url, su.fail_count, su.match_id, m.source_name
     FROM stream_urls su
     JOIN matches m ON su.match_id = m.id
     WHERE su.is_healthy = true
       AND (su.expires_at IS NULL OR su.expires_at > NOW())
       AND (su.last_checked IS NULL OR su.last_checked < NOW() - interval '90 seconds')
     ORDER BY su.last_checked ASC NULLS FIRST
     LIMIT 50`
  );

  if (streams.length === 0) {
    console.log('[urlHealthJob] No streams to check');
    return;
  }

  console.log(`[urlHealthJob] Checking ${streams.length} streams…`);

  let socoFailed  = false;
  let chinaFailed = false;

  await Promise.all(streams.map(async (stream) => {
    const { ok, latency } = await checkUrl(stream.url);
    const newFailCount = ok ? 0 : stream.fail_count + 1;

    await db.query(
      `UPDATE stream_urls
       SET is_healthy   = $1,
           fail_count   = $2,
           last_checked = NOW(),
           latency_ms   = COALESCE($4, latency_ms)
       WHERE id = $3`,
      [ok && newFailCount < failThreshold, newFailCount, stream.id, latency]
    );

    if (!ok) {
      console.warn(`[urlHealthJob] UNHEALTHY: ${stream.url} (fail_count=${newFailCount})`);
      if (newFailCount >= failThreshold) {
        if (stream.source_name === 'socolive')  socoFailed  = true;
        if (stream.source_name === 'chinalive') chinaFailed = true;
      }
    }
  }));

  if (socoFailed)  await tryRerun(rerunSoco,  'socolive');
  if (chinaFailed) await tryRerun(rerunChina, 'chinalive');

  console.log('[urlHealthJob] Health check complete');
};

const expireOldUrls = async () => {
  const { rowCount } = await db.query(
    `UPDATE stream_urls
     SET is_healthy = false
     WHERE expires_at IS NOT NULL AND expires_at < NOW() AND is_healthy = true`
  );
  if (rowCount > 0) console.log(`[urlHealthJob] Expired ${rowCount} stream URL(s)`);
};

const cleanStaleMatches = async () => {
  // Scheduled matches whose kickoff passed 2+ hours ago → finished
  const { rowCount: r1 } = await db.query(
    `UPDATE matches SET status = 'finished'
     WHERE status = 'scheduled' AND scheduled_at < NOW() - INTERVAL '2 hours'`
  );
  // Stuck live matches: kickoff was 4+ hours ago (covers 90min + HT + extra time)
  const { rowCount: r3 } = await db.query(
    `UPDATE matches SET status = 'finished'
     WHERE status = 'live'
       AND scheduled_at IS NOT NULL
       AND scheduled_at < NOW() - INTERVAL '4 hours'`
  );
  // Delete finished matches older than 3 days to keep DB lean
  const { rowCount: r2 } = await db.query(
    `DELETE FROM matches
     WHERE status = 'finished' AND created_at < NOW() - INTERVAL '3 days'`
  );
  if (r1 > 0) console.log(`[urlHealthJob] Marked ${r1} stale scheduled → finished`);
  if (r3 > 0) console.log(`[urlHealthJob] Marked ${r3} stuck live → finished`);
  if (r2 > 0) console.log(`[urlHealthJob] Deleted ${r2} old finished matches`);
};

const start = () => {
  const tick = async () => {
    try {
      const { intervalMs, failThreshold } = await getHealthConfig();
      await expireOldUrls();
      await cleanStaleMatches();
      await runHealthCheck(failThreshold);
      setTimeout(tick, intervalMs);
    } catch (err) {
      console.error('[urlHealthJob] Error:', err.message);
      setTimeout(tick, DEFAULT_INTERVAL_MS);
    }
  };

  tick();
};

start();

module.exports = { runHealthCheck };
