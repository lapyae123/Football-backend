const db = require('../config/database');
const { run: rerunSoco }  = require('../scrapers/socolive');
const { run: rerunChina } = require('../scrapers/chinalive');

const DEFAULT_INTERVAL_MS  = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS, 10) || 5 * 60 * 1000;
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

const REFERER_BY_SOURCE = {
  chinalive: 'https://yyzbw8.live/',
  socolive:  'https://soco.buzzscorelinez.com/',
};

// China CDNs frequently use self-signed / mismatched SSL certs — fetch() throws SSL errors
// and incorrectly marks healthy streams as unhealthy. Use the https module directly with
// rejectUnauthorized: false so we get the actual HTTP status code instead of an SSL error.
const checkChinaUrl = (url, referer) => {
  const { Agent, get: httpsGet } = require('https');
  const { get: httpGet } = require('http');
  const isHttps = url.startsWith('https');
  const proto   = isHttps ? httpsGet : httpGet;
  const start   = Date.now();
  return new Promise((resolve) => {
    const req = proto(url, {
      method:  'HEAD',
      timeout: FETCH_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        Referer: referer,
        Origin:  'https://yyzbw8.live',
        Accept:  '*/*',
      },
      ...(isHttps ? { agent: new Agent({ rejectUnauthorized: false }) } : {}),
    }, (res) => {
      res.resume();
      // 2xx or 206 = healthy; 403 = token expired = unhealthy
      const ok = res.statusCode < 400 || res.statusCode === 206;
      resolve({ ok, latency: ok ? Date.now() - start : null });
    });
    req.on('error',   () => resolve({ ok: false, latency: null }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, latency: null }); });
  });
};

const checkUrl = async (url, sourceName) => {
  const referer = REFERER_BY_SOURCE[sourceName] || null;
  // China CDNs need SSL bypass — use dedicated checker
  if (sourceName === 'chinalive') return checkChinaUrl(url, referer || 'https://yyzbw8.live/');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const start   = Date.now();
  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    ...(referer ? { Referer: referer } : {}),
  };
  try {
    // Try HEAD first; fall back to GET with Range (some CDNs reject HEAD)
    let res = await fetch(url, { method: 'HEAD', signal: controller.signal, headers: baseHeaders });
    if (res.status === 405 || res.status === 403) {
      res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { ...baseHeaders, Range: 'bytes=0-1' },
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
     LIMIT 25`
  );

  if (streams.length === 0) {
    console.log('[urlHealthJob] No streams to check');
    return;
  }

  console.log(`[urlHealthJob] Checking ${streams.length} streams…`);

  let socoFailed  = false;
  let chinaFailed = false;

  // Separate browser-only (skip check) from checkable streams.
  // China live streams are fully managed by the re-warm cycle (chinaliveSyncJob) —
  // health-checking them would race against token rotation and falsely mark healthy
  // streams unhealthy. expireOldUrls() handles token expiry; re-warm handles renewal.
  const browserOnly = streams.filter((s) =>
    s.source_name === 'chinalive'
    || s.url.includes('buzzscorelinez.com')
    || /[?&]auth_key=\d/.test(s.url)
    || /wsSecret=/.test(s.url)
    || s.url.includes('pullsgp.yyzb456.top')
    || s.url.includes('procdnlive.com')
    || s.url.includes('yyzb456.top')
  );
  const checkable = streams.filter((s) => !browserOnly.includes(s));

  // Check all checkable streams concurrently
  const results = await Promise.all(
    checkable.map(async (stream) => {
      const { ok, latency } = await checkUrl(stream.url, stream.source_name);
      const newFailCount = ok ? 0 : stream.fail_count + 1;
      // Only hide a stream after consecutive failures — one transient error shouldn't
      // remove all servers. Previously `ok && ...` meant first failure = immediate hide.
      const isHealthy    = ok || newFailCount < failThreshold;

      if (!ok) {
        console.warn(`[urlHealthJob] UNHEALTHY: ${stream.url} (fail_count=${newFailCount})`);
        if (newFailCount >= failThreshold) {
          if (stream.source_name === 'socolive')  socoFailed  = true;
          if (stream.source_name === 'chinalive') chinaFailed = true;
        }
      }
      return { id: stream.id, isHealthy, newFailCount, latency };
    })
  );

  // Batch UPDATE all checked streams in one query using UNNEST
  if (results.length > 0) {
    const ids        = results.map((r) => r.id);
    const healthyArr = results.map((r) => r.isHealthy);
    const failArr    = results.map((r) => r.newFailCount);
    const latencyArr = results.map((r) => r.latency ?? null);
    await db.query(
      `UPDATE stream_urls su
       SET is_healthy   = v.is_healthy,
           fail_count   = v.fail_count,
           last_checked = NOW(),
           latency_ms   = COALESCE(v.latency_ms, su.latency_ms)
       FROM UNNEST($1::uuid[], $2::bool[], $3::int[], $4::int[])
         AS v(id, is_healthy, fail_count, latency_ms)
       WHERE su.id = v.id`,
      [ids, healthyArr, failArr, latencyArr]
    );
  }

  // Batch touch browser-only streams (single query)
  if (browserOnly.length > 0) {
    await db.query(
      'UPDATE stream_urls SET last_checked = NOW() WHERE id = ANY($1::uuid[])',
      [browserOnly.map((s) => s.id)]
    );
  }

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

// Match lifecycle (scheduled → live → finished) is owned by finishedMatchCleanupJob.
// urlHealthJob only manages stream URL health — no match status changes here.

const start = () => {
  let running = false;

  const tick = async () => {
    if (running) {
      console.warn('[urlHealthJob] Previous run still in progress — skipping tick');
      setTimeout(tick, DEFAULT_INTERVAL_MS);
      return;
    }
    running = true;
    try {
      const { intervalMs, failThreshold } = await getHealthConfig();
      await expireOldUrls();
      await runHealthCheck(failThreshold);
      setTimeout(tick, intervalMs);
    } catch (err) {
      console.error('[urlHealthJob] Error:', err.message);
      setTimeout(tick, DEFAULT_INTERVAL_MS);
    } finally {
      running = false;
    }
  };

  tick();
};

start();

module.exports = { runHealthCheck };
