const db = require('../config/database');
const { run: rerunSoco }  = require('../scrapers/socolive');
const { run: rerunChina } = require('../scrapers/chinalive');

const CHECK_INTERVAL_MS = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS, 10) || 10 * 60 * 1000;
const FAIL_THRESHOLD    = parseInt(process.env.HEALTH_FAIL_THRESHOLD, 10)    || 10;
const FETCH_TIMEOUT_MS  = 8000;

const checkUrl = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      }
    });
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

const runHealthCheck = async () => {
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
      [ok && newFailCount < FAIL_THRESHOLD, newFailCount, stream.id, latency]
    );

    if (!ok) {
      console.warn(`[urlHealthJob] UNHEALTHY: ${stream.url} (fail_count=${newFailCount})`);
      if (newFailCount >= FAIL_THRESHOLD) {
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

const start = () => {
  const tick = async () => {
    try {
      await expireOldUrls();
      await runHealthCheck();
    } catch (err) {
      console.error('[urlHealthJob] Error:', err.message);
    }
  };

  tick();
  setInterval(tick, CHECK_INTERVAL_MS);
};

start();

module.exports = { runHealthCheck };
