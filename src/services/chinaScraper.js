const { newPage } = require('./browser');

const CHINA_BASE_URL = process.env.CHINA_BASE_URL || 'https://yyzbw8.live';
const DEBUG_SCRAPER = process.env.DEBUG_SCRAPER === 'true';

// ─── Selector candidates (adjust after running debug mode) ───────────────────
//
// Run with DEBUG_SCRAPER=true once to dump the real HTML, then update these.
//
const MATCH_CARD_SELECTORS = [
  '.live-item',
  '.match-item',
  '.item',
  '.game-item',
  '.event-item',
  '[class*="live-item"]',
  '[class*="match"]',
  '[class*="game"]'
];

const FIELD = {
  homeTeam:  ['.home .name', '.team-a .name', '.home-team', '.team:first-child .name', '.vs-team:first-child'],
  awayTeam:  ['.away .name', '.team-b .name', '.away-team', '.team:last-child .name', '.vs-team:last-child'],
  homeLogo:  ['.home img', '.team-a img', '.team:first-child img'],
  awayLogo:  ['.away img', '.team-b img', '.team:last-child img'],
  time:      ['.time', '.match-time', '.start-time', '.kickoff', 'time', '.schedule-time'],
  status:    ['.status', '.live-tag', '.badge', '[class*="live"]', '[class*="status"]'],
  title:     ['.title', '.match-title', '.event-title', 'h3', 'h4'],
  link:      ['a[href*="/live"]', 'a[href*="/match"]', 'a[href*="/game"]', 'a']
};

const tryText = async (el, selectors) => {
  for (const sel of selectors) {
    try {
      const text = await el.$eval(sel, (e) => e.textContent?.trim());
      if (text) return text;
    } catch (_) {}
  }
  return null;
};

const tryAttr = async (el, selectors, attr) => {
  for (const sel of selectors) {
    try {
      const val = await el.$eval(sel, (e, a) => e.getAttribute(a), attr);
      if (val) return val;
    } catch (_) {}
  }
  return null;
};

const resolveStatus = (rawStatus, rawTime) => {
  const text = ((rawStatus || '') + ' ' + (rawTime || '')).toLowerCase();
  // Chinese: 直播中 (live), 已结束 (finished), 未开始 (not started)
  if (/直播|live|进行|上半|下半|h1|h2/.test(text)) return 'live';
  if (/结束|finished|ft|end|完/.test(text)) return 'finished';
  return 'scheduled';
};

const parseScheduledAt = (rawTime) => {
  if (!rawTime) return null;
  const now = new Date();
  const timeOnly = rawTime.match(/(\d{1,2}):(\d{2})/);
  if (!timeOnly) return null;

  const date = new Date(now);
  date.setHours(parseInt(timeOnly[1], 10), parseInt(timeOnly[2], 10), 0, 0);
  if (date < now) date.setDate(date.getDate() + 1);

  return date.toISOString();
};

const findMatchCards = async (page) => {
  for (const sel of MATCH_CARD_SELECTORS) {
    const count = await page.$$eval(sel, (els) => els.length).catch(() => 0);
    if (count > 0) {
      console.log(`[chinaScraper] Using selector: ${sel} (${count} matches found)`);
      return page.$$(sel);
    }
  }
  return [];
};

const scrapeMatchPage = async (matchUrl) => {
  const { page, context } = await newPage();
  const m3u8Urls = [];

  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('.m3u8')) m3u8Urls.push(url);
  });

  try {
    await page.goto(matchUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000);
    return [...new Set(m3u8Urls)];
  } catch (err) {
    console.warn(`[chinaScraper] Failed to scrape streams from ${matchUrl}: ${err.message}`);
    return [];
  } finally {
    await context.close();
  }
};

// Try the "All Live" page first, then fall back to homepage
const PAGES_TO_TRY = [
  '/allLive',
  '/all-live',
  '/',
  '/index'
];

const scrapeMatches = async () => {
  const { page, context } = await newPage({
    'Accept-Language': 'zh-CN,zh;q=0.9'
  });
  const results = [];

  try {
    let cards = [];
    let landed = false;

    for (const path of PAGES_TO_TRY) {
      const url = `${CHINA_BASE_URL}${path}`;
      try {
        console.log(`[chinaScraper] Trying ${url}`);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
        await page.waitForTimeout(3000);
        cards = await findMatchCards(page);
        if (cards.length > 0) {
          landed = true;
          break;
        }
      } catch (err) {
        console.warn(`[chinaScraper] Failed to load ${url}: ${err.message}`);
      }
    }

    if (DEBUG_SCRAPER) {
      const html = await page.content();
      console.log('[chinaScraper] PAGE HTML DUMP:\n', html.slice(0, 8000));
    }

    if (!landed || cards.length === 0) {
      console.warn('[chinaScraper] No match cards found. Set DEBUG_SCRAPER=true and check the HTML dump.');
      return results;
    }

    for (const card of cards) {
      try {
        const homeTeam = await tryText(card, FIELD.homeTeam);
        const awayTeam = await tryText(card, FIELD.awayTeam);
        const rawTitle = await tryText(card, FIELD.title);
        const homeLogo = await tryAttr(card, FIELD.homeLogo, 'src');
        const awayLogo = await tryAttr(card, FIELD.awayLogo, 'src');
        const rawTime = await tryText(card, FIELD.time);
        const rawStatus = await tryText(card, FIELD.status);
        const href = await tryAttr(card, FIELD.link, 'href');

        if (!homeTeam && !awayTeam && !rawTitle) continue;

        const title = homeTeam && awayTeam
          ? `${homeTeam} vs ${awayTeam}`
          : rawTitle || 'Unknown Match';

        const status = resolveStatus(rawStatus, rawTime);
        const scheduled_at = parseScheduledAt(rawTime);
        const matchUrl = href
          ? href.startsWith('http') ? href : `${CHINA_BASE_URL}${href}`
          : null;

        const match = {
          title,
          home_team: homeTeam || '',
          away_team: awayTeam || '',
          home_logo: homeLogo || null,
          away_logo: awayLogo || null,
          status,
          scheduled_at,
          source_match_id: matchUrl ? matchUrl.split('/').filter(Boolean).pop() : title,
          source_name: 'china',
          match_url: matchUrl,
          stream_urls: []
        };

        if (status === 'live' && matchUrl) {
          match.stream_urls = await scrapeMatchPage(matchUrl);
        }

        results.push(match);
      } catch (err) {
        console.warn('[chinaScraper] Error parsing match card:', err.message);
      }
    }

    console.log(`[chinaScraper] Scraped ${results.length} matches`);
    return results;
  } catch (err) {
    console.error('[chinaScraper] Fatal scrape error:', err.message);
    return results;
  } finally {
    await context.close();
  }
};

module.exports = { scrapeMatches };
