const db = require('../config/database');
const { run: rerunSoco } = require('../scrapers/socolive');

const CHECK_INTERVAL_MS = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS, 10) || 2 * 60 * 1000;
const FAIL_THRESHOLD    = parseInt(process.env.HEALTH_FAIL_THRESHOLD, 10)    || 3;
const FETCH_TIMEOUT_MS  = 8000;

const checkUrl = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      }
    });
    return res.ok || res.status === 206; // 206 = partial content (range request)
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const runHealthCheck = async () => {
  console.log('[urlHealthJob] Starting health check…');

  // Only check URLs that haven't been checked in the last 90 seconds and haven't expired
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

  const failedMatchIds = new Set();

  for (const stream of streams) {
    const healthy = await checkUrl(stream.url);
    const newFailCount = healthy ? 0 : stream.fail_count + 1;

    await db.query(
      `UPDATE stream_urls
       SET is_healthy   = $1,
           fail_count   = $2,
           last_checked = NOW()
       WHERE id = $3`,
      [healthy && newFailCount < FAIL_THRESHOLD, newFailCount, stream.id]
    );

    if (!healthy) {
      console.warn(`[urlHealthJob] UNHEALTHY: ${stream.url} (fail_count=${newFailCount})`);
      if (newFailCount >= FAIL_THRESHOLD && stream.source_name === 'socolive') {
        failedMatchIds.add(stream.match_id);
      }
    }
  }

  // Trigger re-scrape for matches with too many failed streams
  if (failedMatchIds.size > 0) {
    console.log(`[urlHealthJob] Re-scraping ${failedMatchIds.size} match(es) with failed streams…`);
    try {
      await rerunSoco();
    } catch (err) {
      console.error('[urlHealthJob] Re-scrape failed:', err.message);
    }
  }

  console.log('[urlHealthJob] Health check complete');
};

// Mark expired stream URLs as unhealthy
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
