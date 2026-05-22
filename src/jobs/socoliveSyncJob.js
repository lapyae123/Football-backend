const db           = require('../config/database');
const scraperState = require('../config/scraperState');
const { run }      = require('../scrapers/socolive');
const { isWithinActiveHours } = require('../config/scraperSchedule');

const SLUG     = 'socolive';
const TAB_SLUG = 'soco-live';
const DEFAULT_INTERVAL_MS = parseInt(process.env.SOCO_SYNC_INTERVAL_MS, 10) || 2 * 60 * 1000;

const getSourceConfig = async () => {
  try {
    const r = await db.query('SELECT config, is_active FROM sources WHERE slug = $1 LIMIT 1', [SLUG]);
    return r.rows[0] || {};
  } catch (_) { return {}; }
};

const shouldRun = async (cfg) => {
  try {
    const tabRes = await db.query('SELECT is_active FROM tabs WHERE slug = $1 LIMIT 1', [TAB_SLUG]);
    if (cfg.is_active === false || tabRes.rows[0]?.is_active === false) return false;
  } catch (_) {}

  if (!isWithinActiveHours(cfg.config)) {
    const hours = cfg.config?.active_hours;
    console.log(`[socoliveSyncJob] Skipped — outside active hours (${hours?.from}–${hours?.to})`);
    return false;
  }
  return true;
};

const getIntervalMs = (cfg) => {
  const v = cfg?.sync_interval_ms ?? cfg?.sync_interval;
  if (v && Number.isFinite(v) && v >= 10000) return v;
  return DEFAULT_INTERVAL_MS;
};

const tick = async () => {
  const src = await getSourceConfig();
  if (await shouldRun(src)) {
    if (scraperState.isRunning(SLUG)) {
      console.log(`[socoliveSyncJob] Skipped — already running`);
    } else {
      scraperState.start(SLUG);
      try {
        await run();
        scraperState.finish(SLUG, 'ok');
      } catch (err) {
        console.error('[socoliveSyncJob] Failed:', err.message);
        scraperState.finish(SLUG, 'error', err.message);
      }
    }
  } else {
    scraperState.finish(SLUG, 'skipped');
  }
  setTimeout(tick, getIntervalMs(src.config));
};

// Delay first run 15s so chinalive (HTTP) starts first before Playwright browser launches
setTimeout(tick, 15 * 1000);
