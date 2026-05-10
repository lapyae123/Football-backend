const { run } = require('../scrapers/chinalive');

const INTERVAL_MS = parseInt(process.env.SCRAPER_INTERVAL_MS, 10) || 5 * 60 * 1000;

const tick = () =>
  run().catch((err) => console.error('[chinaliveSyncJob] Failed:', err.message));

// Run immediately on startup, then on interval
tick();
setInterval(tick, INTERVAL_MS);
