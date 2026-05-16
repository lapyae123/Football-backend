const db = require('../config/database');
const redis = require('../config/redis');
const { run } = require('../scrapers/socolive');

const SLUG     = 'socolive';
const TAB_SLUG = 'soco-live';
const DEFAULT_INTERVAL_MS = parseInt(process.env.SOCO_SYNC_INTERVAL_MS, 10) || 2 * 60 * 1000;

let timer = null;

const shouldRun = async () => {
  try {
    const [srcRes, tabRes] = await Promise.all([
      db.query('SELECT is_active FROM sources WHERE slug = $1 LIMIT 1', [SLUG]),
      db.query('SELECT is_active FROM tabs WHERE slug = $1 LIMIT 1', [TAB_SLUG]),
    ]);
    const srcActive = srcRes.rows[0]?.is_active !== false;
    const tabActive = tabRes.rows[0]?.is_active !== false;
    return srcActive && tabActive;
  } catch (_) { return true; } // fail open on DB error
};

const getIntervalMs = async () => {
  try {
    const r = await db.query('SELECT config FROM sources WHERE slug = $1 LIMIT 1', [SLUG]);
    const cfg = r.rows[0]?.config || {};
    const interval = cfg.sync_interval_ms ?? cfg.sync_interval;
    if (interval && Number.isFinite(interval) && interval >= 10000) return interval;
  } catch (_) {}
  return DEFAULT_INTERVAL_MS;
};

const setResult = (status, message = null) =>
  redis.set(`scraper:last_result:${SLUG}`, JSON.stringify({ status, at: Date.now(), message })).catch(() => {});

const tick = async () => {
  const ok = await shouldRun();
  if (ok) {
    // Guard against concurrent runs (e.g. manual admin trigger + scheduled tick)
    const alreadyRunning = await redis.get(`scraper:running:${SLUG}`).catch(() => null);
    if (alreadyRunning) {
      console.log(`[socoliveSyncJob] Skipped — already running`);
    } else {
      await redis.set(`scraper:running:${SLUG}`, Date.now().toString(), 'EX', 300).catch(() => {});
      await redis.set(`scraper:last_run:${SLUG}`, Date.now().toString()).catch(() => {});
      try {
        await run();
        await setResult('ok');
      } catch (err) {
        console.error('[socoliveSyncJob] Failed:', err.message);
        await setResult('error', err.message);
      } finally {
        await redis.del(`scraper:running:${SLUG}`).catch(() => {});
      }
    }
  } else {
    console.log(`[socoliveSyncJob] Skipped — source or tab is inactive`);
    await setResult('skipped');
  }
  // Always wait at least DEFAULT_INTERVAL_MS to prevent tight loop when all mirrors fail fast
  const interval = Math.max(await getIntervalMs(), DEFAULT_INTERVAL_MS);
  timer = setTimeout(tick, interval);
};

tick();
