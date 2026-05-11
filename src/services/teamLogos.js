const db = require('../config/database');

const normaliseKey = (name) =>
  name.toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');

const isLatinName = (name) => /[a-zA-Z]/.test(name);

// ─── Wikipedia logo fetch ─────────────────────────────────────────────────────

const WP_UA = 'FootballStreamingApp/1.0 (contact@example.com)';

const fetchLogoFromWikipedia = async (teamName) => {
  try {
    // Search for the team page
    const searchUrl =
      `https://en.wikipedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent(teamName + ' football club')}` +
      `&format=json&srlimit=3`;

    const searchRes = await fetch(searchUrl, {
      headers: { 'User-Agent': WP_UA },
      signal: AbortSignal.timeout(6000),
    });
    const searchJson = await searchRes.json();
    const results = searchJson.query?.search || [];

    // Pick first result whose title or snippet looks like a football club
    const hit = results.find((r) =>
      /F\.C\.|FC|football|soccer|united|city|athletic|sporting|club/i.test(r.title + r.snippet)
    );
    if (!hit) return null;

    const pageSlug = encodeURIComponent(hit.title.replace(/ /g, '_'));
    const summaryRes = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${pageSlug}`,
      {
        headers: { 'User-Agent': WP_UA },
        signal: AbortSignal.timeout(6000),
      }
    );
    const summaryJson = await summaryRes.json();
    return summaryJson.thumbnail?.source || null;
  } catch {
    return null;
  }
};

// ─── DB helpers ───────────────────────────────────────────────────────────────

const lookupLogo = async (teamName) => {
  if (!teamName) return null;
  const key = normaliseKey(teamName);
  if (!key) return null;

  try {
    const r = await db.query(
      'SELECT logo_url FROM team_logos WHERE team_key = $1 LIMIT 1',
      [key]
    );
    if (r.rows.length > 0) return r.rows[0].logo_url;

    // Cache miss — try Wikipedia (Latin names only; Chinese names won't match)
    if (!isLatinName(teamName)) return null;

    const logoUrl = await fetchLogoFromWikipedia(teamName);
    if (!logoUrl) return null;

    // Cache the result so future scrapes don't re-query Wikipedia
    await db.query(
      `INSERT INTO team_logos (team_name, team_key, logo_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (team_key) DO UPDATE SET logo_url = EXCLUDED.logo_url`,
      [teamName, key, logoUrl]
    );
    return logoUrl;
  } catch {
    return null;
  }
};

const resolveLogos = async (homeTeam, awayTeam, scrapedHomeLogo, scrapedAwayLogo) => {
  const [home, away] = await Promise.all([
    lookupLogo(homeTeam),
    lookupLogo(awayTeam),
  ]);
  return {
    home_logo: home || scrapedHomeLogo || null,
    away_logo: away || scrapedAwayLogo || null,
  };
};

module.exports = { normaliseKey, lookupLogo, resolveLogos };
