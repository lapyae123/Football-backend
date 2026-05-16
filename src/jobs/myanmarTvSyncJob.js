const redis = require('../config/redis');
const { run } = require('../scrapers/myanmarTv');

const SLUG = 'myanmar-tv';
// Refresh every 8 minutes — wmsAuthSign tokens expire in 10 min
const INTERVAL_MS = 8 * 60 * 1000;

const setResult = (status, message = null) =>
  redis.set(`scraper:last_result:${SLUG}`, JSON.stringify({ status, at: Date.now(), message })).catch(() => {});

const tick = async () => {
  const alreadyRunning = await redis.get(`scraper:running:${SLUG}`).catch(() => null);
  if (alreadyRunning) {
    console.log('[myanmarTvSyncJob] Skipped — already running');
    setTimeout(tick, INTERVAL_MS);
    return;
  }

  await redis.set(`scraper:running:${SLUG}`, Date.now().toString(), 'EX', 600).catch(() => {});
  await redis.set(`scraper:last_run:${SLUG}`, Date.now().toString()).catch(() => {});

  try {
    await run();
    await setResult('ok');
  } catch (err) {
    console.error('[myanmarTvSyncJob] Failed:', err.message);
    await setResult('error', err.message);
  } finally {
    await redis.del(`scraper:running:${SLUG}`).catch(() => {});
  }

  setTimeout(tick, INTERVAL_MS);
};

tick();
