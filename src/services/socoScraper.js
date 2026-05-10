const { newPage } = require('./browser');

const SOCO_BASE_URL = process.env.SOCO_BASE_URL || 'https://www.barbaramassaad.com';

// Parse "16:30 10/05" → ISO string
const parseMatchTime = (raw) => {
  if (!raw) return null;
  const m = raw.match(/(\d{1,2}):(\d{2})(?:\s+(\d{1,2})\/(\d{1,2}))?/);
  if (!m) return null;
  const now = new Date();
  const year  = now.getFullYear();
  const month = m[4] ? parseInt(m[4], 10) - 1 : now.getMonth();
  const day   = m[3] ? parseInt(m[3], 10)     : now.getDate();
  return new Date(year, month, day, parseInt(m[1], 10), parseInt(m[2], 10), 0).toISOString();
};

// Intercept .m3u8 requests on a match page
const scrapeStreamUrls = async (matchUrl) => {
  const { page, context } = await newPage();
  const m3u8Urls = [];
  page.on('request', (req) => {
    if (req.url().includes('.m3u8')) m3u8Urls.push(req.url());
  });
  try {
    // Use 'load' not 'networkidle' — video player pages never become idle
    await page.goto(matchUrl, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(6000);
  } catch (err) {
    console.warn(`[socoScraper] Stream scrape failed for ${matchUrl}: ${err.message}`);
  } finally {
    await context.close();
  }
  return [...new Set(m3u8Urls)];
};

const scrapeMatches = async () => {
  const { page, context } = await newPage();
  let rawCards = [];

  try {
    const url = `${SOCO_BASE_URL}/`;
    console.log(`[socoScraper] Fetching ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('.match-item', { timeout: 15000 }).catch(() => {});

    // Extract everything in one in-page JS call — avoids back-and-forth IPC
    rawCards = await page.$$eval('.match-item', (cards) =>
      cards.map((card) => ({
        sourceId:  card.getAttribute('data-match-id'),
        isLive:    card.getAttribute('is-live'),
        hasLive:   card.getAttribute('has-live'),
        homeTeam:  card.querySelector('.match-home .name-team-inner span')?.textContent.trim() || '',
        awayTeam:  card.querySelector('.match-away .name-team-inner span')?.textContent.trim() || '',
        homeLogo:  card.querySelector('.logo-home img')?.src || null,
        awayLogo:  card.querySelector('.logo-away img')?.src || null,
        rawTime:   card.querySelector('.match-item__time span')?.textContent.trim() || null,
        competition: card.querySelector('.match-item__comp')?.textContent.trim() || null,
        matchUrl:  card.querySelector('a.link-match')?.href || null
      }))
    );

    console.log(`[socoScraper] Found ${rawCards.length} match cards`);
  } catch (err) {
    console.error('[socoScraper] Fatal error during listing:', err.message);
  } finally {
    await context.close();
  }

  // Build results and fetch stream URLs for live matches
  const results = [];
  for (const c of rawCards) {
    if (!c.homeTeam && !c.awayTeam) continue;

    const status = c.isLive === '1' ? 'live' : 'scheduled';
    const match = {
      title:            `${c.homeTeam} vs ${c.awayTeam}`,
      home_team:        c.homeTeam,
      away_team:        c.awayTeam,
      home_logo:        c.homeLogo,
      away_logo:        c.awayLogo,
      status,
      scheduled_at:     parseMatchTime(c.rawTime),
      source_match_id:  c.sourceId || `${c.homeTeam}-${c.awayTeam}-${c.rawTime}`,
      source_name:      'soco',
      match_url:        c.matchUrl,
      stream_urls:      []
    };

    if (status === 'live' && c.hasLive === '1' && c.matchUrl) {
      match.stream_urls = await scrapeStreamUrls(c.matchUrl);
    }

    results.push(match);
  }

  console.log(`[socoScraper] Done — ${results.length} matches`);
  return results;
};

module.exports = { scrapeMatches };
