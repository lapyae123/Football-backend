const db = require('../config/database');

// Normalise a team name to a consistent lookup key
const normaliseKey = (name) =>
  name.toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');

/**
 * Look up logo URL from team_logos table.
 * Returns the stored URL or null if no match found.
 */
const lookupLogo = async (teamName) => {
  if (!teamName) return null;
  const key = normaliseKey(teamName);
  if (!key) return null;
  try {
    const r = await db.query(
      'SELECT logo_url FROM team_logos WHERE team_key = $1 LIMIT 1',
      [key]
    );
    return r.rows[0]?.logo_url || null;
  } catch {
    return null;
  }
};

/**
 * Resolve logos for home/away teams.
 * Falls back to the scraped URL if no DB entry exists.
 */
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
