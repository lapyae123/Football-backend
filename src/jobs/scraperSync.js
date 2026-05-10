const db = require('../config/database');
const redis = require('../config/redis');
const { scrapeMatches: scrapeSoco } = require('../services/socoScraper');
const { scrapeMatches: scrapeChina } = require('../services/chinaScraper');

const SCRAPER_INTERVAL_MS = parseInt(process.env.SCRAPER_INTERVAL_MS, 10) || 5 * 60 * 1000;

const getTabId = async (slug) => {
  const result = await db.query('SELECT id FROM tabs WHERE slug = $1 AND is_active = TRUE LIMIT 1', [slug]);
  return result.rows.length > 0 ? result.rows[0].id : null;
};

const upsertMatch = async (match, tab_id) => {
  const existing = await db.query(
    'SELECT id FROM matches WHERE source_match_id = $1 AND source_name = $2 LIMIT 1',
    [match.source_match_id, match.source_name]
  );

  let matchId;

  if (existing.rows.length > 0) {
    matchId = existing.rows[0].id;
    await db.query(
      `UPDATE matches SET
        tab_id = $1, title = $2, home_team = $3, away_team = $4,
        home_logo = $5, away_logo = $6, status = $7, scheduled_at = $8
       WHERE id = $9`,
      [
        tab_id, match.title, match.home_team, match.away_team,
        match.home_logo, match.away_logo, match.status, match.scheduled_at,
        matchId
      ]
    );
  } else {
    const ins = await db.query(
      `INSERT INTO matches
        (tab_id, title, home_team, away_team, home_logo, away_logo,
         status, scheduled_at, source_match_id, source_name, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       RETURNING id`,
      [
        tab_id, match.title, match.home_team, match.away_team,
        match.home_logo, match.away_logo, match.status, match.scheduled_at,
        match.source_match_id, match.source_name
      ]
    );
    matchId = ins.rows[0].id;
  }

  return matchId;
};

const upsertStreamUrls = async (matchId, streamUrls) => {
  if (!streamUrls || streamUrls.length === 0) return;

  for (const url of streamUrls) {
    const existing = await db.query(
      'SELECT id FROM stream_urls WHERE match_id = $1 AND url = $2 LIMIT 1',
      [matchId, url]
    );
    if (existing.rows.length === 0) {
      const quality = /_hd|_uhd/i.test(url) ? 'HD' : 'SD';
      await db.query(
        `INSERT INTO stream_urls (match_id, url, quality, source_name, priority, is_healthy, created_at)
         VALUES ($1, $2, $3, $4, 1, TRUE, now())`,
        [matchId, url, quality, 'scraper']
      );
    }
  }
};

const invalidateCache = async () => {
  try {
    const keys = [
      ...(await redis.keys('matches:*')),
      ...(await redis.keys('streams:*'))
    ];
    if (keys.length > 0) await redis.del(...keys);
  } catch (err) {
    console.warn('[scraperSync] Cache invalidation failed:', err.message);
  }
};

const runScraper = async (name, scraperFn, tabSlug) => {
  const tab_id = await getTabId(tabSlug);
  if (!tab_id) {
    console.warn(`[scraperSync] Tab "${tabSlug}" not found, skipping ${name}`);
    return;
  }

  let matches = [];
  try {
    matches = await scraperFn();
  } catch (err) {
    console.error(`[scraperSync] ${name} scraper failed:`, err.message);
    return;
  }

  for (const match of matches) {
    try {
      const matchId = await upsertMatch(match, tab_id);
      await upsertStreamUrls(matchId, match.stream_urls);
    } catch (err) {
      console.warn(`[scraperSync] Failed to save match "${match.title}":`, err.message);
    }
  }

  console.log(`[scraperSync] ${name}: saved ${matches.length} matches`);
};

const syncAll = async () => {
  console.log('[scraperSync] Starting scrape run…');
  await Promise.allSettled([
    runScraper('SOCO', scrapeSoco, 'soco-live'),
    runScraper('China', scrapeChina, 'china-live')
  ]);
  await invalidateCache();
  console.log('[scraperSync] Scrape run complete');
};

// Run immediately on startup, then on interval
syncAll().catch((err) => console.error('[scraperSync] Initial run failed:', err));

setInterval(() => {
  syncAll().catch((err) => console.error('[scraperSync] Interval run failed:', err));
}, SCRAPER_INTERVAL_MS);
