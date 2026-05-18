const db = require('../config/database');

const DEFAULT_INTERVAL_MS      = parseInt(process.env.CLEANUP_INTERVAL_MS, 10)      || 20 * 60 * 1000; // 20 min
const DEFAULT_RETENTION_HOURS  = parseInt(process.env.CLEANUP_RETENTION_HOURS, 10)  || 24;             // delete finished after 24h
const DEFAULT_STUCK_LIVE_HOURS = parseInt(process.env.CLEANUP_STUCK_LIVE_HOURS, 10) || 6;             // live → finished after 6h

const getConfig = async () => {
  try {
    const r = await db.query("SELECT value FROM app_config WHERE key = 'cleanup' LIMIT 1");
    const cfg = r.rows[0]?.value || {};
    return {
      intervalMs:      (cfg.interval_ms      >= 60000) ? cfg.interval_ms      : DEFAULT_INTERVAL_MS,
      retentionHours:  (cfg.retention_hours  >= 1)     ? cfg.retention_hours  : DEFAULT_RETENTION_HOURS,
      stuckLiveHours:  (cfg.stuck_live_hours >= 1)     ? cfg.stuck_live_hours : DEFAULT_STUCK_LIVE_HOURS,
    };
  } catch (_) {
    return { intervalMs: DEFAULT_INTERVAL_MS, retentionHours: DEFAULT_RETENTION_HOURS, stuckLiveHours: DEFAULT_STUCK_LIVE_HOURS };
  }
};

// Mark scheduled → finished when kickoff passed 2+ hours ago
const markStaleScheduled = async () => {
  const { rowCount } = await db.query(
    `UPDATE matches SET status = 'finished'
     WHERE status = 'scheduled'
       AND scheduled_at IS NOT NULL
       AND scheduled_at < NOW() - INTERVAL '2 hours'`
  );
  if (rowCount > 0) console.log(`[cleanupJob] Marked ${rowCount} stale scheduled → finished`);
};

// Mark live → finished when kickoff was N hours ago (covers 90min + halftime + extra time)
const markStuckLive = async (stuckLiveHours) => {
  const { rowCount } = await db.query(
    `UPDATE matches SET status = 'finished'
     WHERE status = 'live'
       AND scheduled_at IS NOT NULL
       AND scheduled_at < NOW() - ($1 * INTERVAL '1 hour')`,
    [stuckLiveHours]
  );
  if (rowCount > 0) console.log(`[cleanupJob] Marked ${rowCount} stuck live → finished`);
};

// Delete finished matches older than retentionHours
const deleteOldFinished = async (retentionHours) => {
  const { rowCount } = await db.query(
    `DELETE FROM matches
     WHERE status = 'finished'
       AND created_at < NOW() - ($1 * INTERVAL '1 hour')`,
    [retentionHours]
  );
  if (rowCount > 0) console.log(`[cleanupJob] Deleted ${rowCount} finished matches (older than ${retentionHours}h)`);
};

// Delete stream_urls whose match no longer exists (orphaned rows)
const deleteOrphanedStreams = async () => {
  const { rowCount } = await db.query(
    `DELETE FROM stream_urls
     WHERE match_id NOT IN (SELECT id FROM matches)`
  );
  if (rowCount > 0) console.log(`[cleanupJob] Deleted ${rowCount} orphaned stream_urls`);
};

// Delete expired unhealthy stream_urls for finished matches — keeps DB lean
const deleteFinishedStreams = async () => {
  const { rowCount } = await db.query(
    `DELETE FROM stream_urls su
     USING matches m
     WHERE su.match_id = m.id
       AND m.status = 'finished'
       AND (su.is_healthy = false OR (su.expires_at IS NOT NULL AND su.expires_at < NOW()))`
  );
  if (rowCount > 0) console.log(`[cleanupJob] Deleted ${rowCount} expired stream_urls for finished matches`);
};

const runCleanup = async (cfg) => {
  console.log('[cleanupJob] Starting cleanup…');
  await markStaleScheduled();
  await markStuckLive(cfg.stuckLiveHours);
  await deleteOldFinished(cfg.retentionHours);
  await deleteFinishedStreams();
  await deleteOrphanedStreams();
  console.log('[cleanupJob] Cleanup complete');
};

const start = () => {
  const tick = async () => {
    try {
      const cfg = await getConfig();
      await runCleanup(cfg);
      setTimeout(tick, cfg.intervalMs);
    } catch (err) {
      console.error('[cleanupJob] Error:', err.message);
      setTimeout(tick, DEFAULT_INTERVAL_MS);
    }
  };

  // Delay first run by 60s — lets scrapers complete their startup cycle first
  setTimeout(tick, 60 * 1000);
};

start();

module.exports = { runCleanup };
