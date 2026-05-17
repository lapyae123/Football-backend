const db = require('../config/database');

const normaliseKey = (name) =>
  name.toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');

const isLatinName = (name) => /[a-zA-Z]/.test(name);

// ─── L1: in-memory cache (survives the process lifetime) ──────────────────────
// key → logo_url  |  null means "confirmed no logo" (don't retry)
const memCache = new Map();

// Warm the memory cache from DB on first use (lazy, once)
let warmed = false;
const warmCache = async () => {
  if (warmed) return;
  warmed = true;
  try {
    const r = await db.query('SELECT team_key, logo_url FROM team_logos');
    for (const row of r.rows) memCache.set(row.team_key, row.logo_url);
  } catch (_) {}
};

// ─── L3: Wikipedia fallback (only for teams with no scraped logo) ─────────────

const WP_UA = 'FootballStreamingApp/1.0 (contact@example.com)';

const fetchLogoFromWikipedia = async (teamName) => {
  try {
    const searchRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent(teamName + ' football club')}` +
      `&format=json&srlimit=3`,
      { headers: { 'User-Agent': WP_UA }, signal: AbortSignal.timeout(6000) }
    );
    const results = (await searchRes.json()).query?.search || [];
    const hit = results.find((r) =>
      /F\.C\.|FC|football|soccer|united|city|athletic|sporting|club/i.test(r.title + r.snippet)
    );
    if (!hit) return null;

    const summaryRes = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
      { headers: { 'User-Agent': WP_UA }, signal: AbortSignal.timeout(6000) }
    );
    return (await summaryRes.json()).thumbnail?.source || null;
  } catch { return null; }
};

// ─── Save to L1 + L2 ──────────────────────────────────────────────────────────

const saveLogo = async (teamName, key, logoUrl) => {
  memCache.set(key, logoUrl);
  try {
    await db.query(
      `INSERT INTO team_logos (team_name, team_key, logo_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (team_key) DO UPDATE SET logo_url = EXCLUDED.logo_url`,
      [teamName, key, logoUrl]
    );
  } catch (_) {}
};

// ─── Main lookup ──────────────────────────────────────────────────────────────
// scrapedUrl: logo URL already provided by the scraper (img.thesports.com, etc.)
// If provided → auto-save immediately, no Wikipedia needed.

const lookupLogo = async (teamName, scrapedUrl) => {
  if (!teamName) return scrapedUrl || null;
  const key = normaliseKey(teamName);
  if (!key) return scrapedUrl || null;

  await warmCache();

  // L1 hit
  if (memCache.has(key)) return memCache.get(key) || scrapedUrl || null;

  // Scraper already gave us a URL → save it and return immediately (no Wikipedia)
  if (scrapedUrl) {
    await saveLogo(teamName, key, scrapedUrl);
    return scrapedUrl;
  }

  // No scraped URL — try Wikipedia (Latin names only)
  if (!isLatinName(teamName)) {
    memCache.set(key, null); // mark as "no logo" to skip next time
    return null;
  }

  const logoUrl = await fetchLogoFromWikipedia(teamName);
  if (logoUrl) {
    await saveLogo(teamName, key, logoUrl);
  } else {
    memCache.set(key, null); // don't retry on next scrape
  }
  return logoUrl || null;
};

// ─── Public API ───────────────────────────────────────────────────────────────

const resolveLogos = async (homeTeam, awayTeam, scrapedHomeLogo, scrapedAwayLogo) => {
  const [home, away] = await Promise.all([
    lookupLogo(homeTeam, scrapedHomeLogo),
    lookupLogo(awayTeam, scrapedAwayLogo),
  ]);
  return { home_logo: home || null, away_logo: away || null };
};

module.exports = { normaliseKey, lookupLogo, resolveLogos };
