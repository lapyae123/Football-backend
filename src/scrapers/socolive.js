const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const db = require('../config/database');
const { resolveLogos } = require('../services/teamLogos');

chromium.use(StealthPlugin());

const SOCO_DEFAULTS = [
  process.env.SOCO_BASE_URL   || 'https://www.socolive.tv',
  process.env.SOCO_BASE_URL_2 || 'https://www.barbaramassaad.com',
];

const getBaseUrls = async () => {
  try {
    const r = await db.query(
      "SELECT config FROM sources WHERE slug = 'socolive' AND is_active = true LIMIT 1"
    );
    const urls = r.rows[0]?.config?.base_urls;
    if (Array.isArray(urls) && urls.length) return urls;
  } catch (_) {}
  return SOCO_DEFAULTS;
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const delay = (min = 2000, max = 4000) => {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, ms));
};

const isStartingSoon = (match) => {
  if (!match.scheduled_at) return false;
  const diff = new Date(match.scheduled_at) - Date.now();
  return diff > 0 && diff <= 30 * 60 * 1000;
};

const parseMatchTime = (raw) => {
  if (!raw) return null;
  const m = raw.match(/(\d{1,2}):(\d{2})(?:\s+(\d{1,2})\/(\d{1,2}))?/);
  if (!m) return null;
  const now   = new Date();
  const month = m[4] ? parseInt(m[4], 10) - 1 : now.getMonth();
  const day   = m[3] ? parseInt(m[3], 10)     : now.getDate();
  return new Date(now.getFullYear(), month, day, parseInt(m[1], 10), parseInt(m[2], 10), 0).toISOString();
};

const classifyQuality = (url) => {
  if (/_hd|_lhd|720|1080|uhd|hi/i.test(url)) return 'HD';
  return 'SD';
};

// Parse token expiry embedded in CDN URLs (auth_key=<unix_ts>-...)
const parseTokenExpiry = (url) => {
  const m = url.match(/auth_key=(\d{10})/);
  if (m) {
    const expMs = parseInt(m[1], 10) * 1000;
    if (expMs > Date.now()) return new Date(expMs).toISOString();
  }
  return null;
};

// Known SOCO stream CDN domains
const STREAM_CDNS = [
  'pull.niur.live',
  'pull.niues.live',
];

const isStreamUrl = (url) => {
  if (!url || url.length > 2000) return false;
  if (/\.(js|css|png|jpg|jpeg|gif|ico|woff|woff2|svg|webp)(\?|$)/i.test(url)) return false;
  if (STREAM_CDNS.some((cdn) => url.includes(cdn))) return true;
  return (
    url.includes('.m3u8') ||
    url.includes('.flv')  ||
    (url.includes('playlist') && !url.includes('.js')) ||
    (/\/stream\//i.test(url) && !url.includes('.js'))
  );
};

const extractFromPageSource = async (page) => {
  const found = new Set();
  try {
    const content = await page.content();
    const patterns = [
      /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g,
      /https?:\/\/[^\s"'<>]+\.flv[^\s"'<>]*/g,
      ...STREAM_CDNS.map(
        (cdn) => new RegExp(`https?:\\/\\/${cdn.replace('.', '\\.')}[^\\s"'<>]*`, 'g')
      ),
    ];
    for (const re of patterns) {
      for (const match of content.matchAll(re)) {
        const url = match[0].replace(/['"\\]+$/, '');
        if (isStreamUrl(url)) found.add(url);
      }
    }
  } catch (_) {}
  return [...found];
};

const newBrowser = () =>
  chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

// ─── Part 1: fetchMatchList ───────────────────────────────────────────────────

const fetchMatchList = async (baseUrl = BASE_URLS[0]) => {
  const browser = await newBrowser();
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 720 } });
  const page    = await context.newPage();

  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'font', 'stylesheet', 'media'].includes(type)) route.abort();
    else route.continue();
  });

  try {
    console.log(`[socolive] Loading match list: ${baseUrl}/`);
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('.match-item', { timeout: 15000 }).catch(() => {});

    const matches = await page.$$eval('.match-item', (cards, baseUrl) =>
      cards.map((card) => {
        const homeTeam    = card.querySelector('.match-home .name-team-inner span')?.textContent.trim() || '';
        const awayTeam    = card.querySelector('.match-away .name-team-inner span')?.textContent.trim() || '';
        const homeLogo    = card.querySelector('.logo-home img')?.getAttribute('src') || null;
        const awayLogo    = card.querySelector('.logo-away img')?.getAttribute('src') || null;
        const rawTime     = card.querySelector('.match-item__time span')?.textContent.trim() || null;
        const competition = card.querySelector('.match-item__comp')?.textContent.trim() || null;
        const href        = card.querySelector('a.link-match')?.getAttribute('href') || null;
        const slug        = href ? href.split('/').filter(Boolean).pop() : null;
        const isLive      = card.getAttribute('is-live') === '1';
        const hasLive     = card.getAttribute('has-live') === '1';
        const sourceId    = card.getAttribute('data-match-id') || slug;

        const runningText  = card.querySelector('.match-running')?.textContent.trim() || '';
        const statusByText = /trực tiếp|đang diễn ra/i.test(runningText) ? 'live' : null;
        const status       = isLive ? 'live' : (statusByText || 'scheduled');

        const scoreRaw = card.querySelector('.score-match-data')?.textContent.trim() || null;
        let score_home = null, score_away = null;
        if (scoreRaw) {
          const parts = scoreRaw.split('-').map((s) => parseInt(s.trim(), 10));
          if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            score_home = parts[0];
            score_away = parts[1];
          }
        }

        const timeText        = card.querySelector('.time-text')?.textContent.trim() || null;
        const elapsed_minutes = timeText ? parseInt(timeText.replace(/[^0-9]/g, ''), 10) || null : null;

        const matchUrl = href
          ? href.startsWith('http') ? href : `${baseUrl}${href}`
          : null;

        return {
          slug, sourceId,
          title:     `${homeTeam} vs ${awayTeam}`,
          home_team: homeTeam,
          away_team: awayTeam,
          home_logo: homeLogo,
          away_logo: awayLogo,
          rawTime, competition, status, hasLive, matchUrl,
          score_home, score_away, elapsed_minutes,
        };
      }),
      baseUrl
    );

    console.log(`[socolive] Found ${matches.length} matches on ${baseUrl}`);
    return matches;
  } finally {
    await context.close();
    await browser.close();
  }
};

// ─── Part 2: fetchStreamUrls ──────────────────────────────────────────────────

const PLAY_SELECTORS = [
  '.play-btn', '[class*="play-btn"]', '[class*="btnPlay"]',
  'button[aria-label*="play" i]', '.jw-icon-display', '.vjs-big-play-button',
  '[class*="player"] button', 'video',
];

const clickPlay = async (p) => {
  for (const sel of PLAY_SELECTORS) {
    try {
      const el = await p.$(sel);
      if (el) { await el.click({ timeout: 2000 }); return true; }
    } catch (_) {}
  }
  return false;
};

const fetchStreamUrls = async (matchUrl) => {
  const browser = await newBrowser();
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 720 } });
  const found   = new Set();

  // Context-level listeners catch requests from ALL pages and cross-origin iframes
  context.on('request',  (req) => { try { if (isStreamUrl(req.url())) found.add(req.url()); } catch (_) {} });
  context.on('response', (res) => { try { if (isStreamUrl(res.url())) found.add(res.url()); } catch (_) {} });

  try {
    console.log(`[socolive] Fetching streams: ${matchUrl}`);
    const page = await context.newPage();
    await page.goto(matchUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);

    await clickPlay(page);
    await page.waitForTimeout(3000);

    const iframeSrcs = await page.$$eval(
      'iframe[src]',
      (els) => els.map((e) => e.src).filter((s) => s && s.startsWith('http'))
    ).catch(() => []);

    for (const src of iframeSrcs) {
      try {
        console.log(`[socolive] Visiting iframe src: ${src}`);
        const iframePage = await context.newPage();
        await iframePage.goto(src, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
        await iframePage.waitForTimeout(4000);
        await clickPlay(iframePage);
        await iframePage.waitForTimeout(5000);

        if (found.size === 0) {
          const fromSource = await extractFromPageSource(iframePage);
          fromSource.forEach((u) => found.add(u));
        }

        await iframePage.close();
      } catch (_) {}
    }

    // Fallback: scan main page source for embedded stream URLs
    if (found.size === 0) {
      const fromSource = await extractFromPageSource(page);
      fromSource.forEach((u) => found.add(u));
    }

    // Final wait for any delayed CDN requests
    await page.waitForTimeout(3000);

    const results = [...found].map((url) => ({ url, quality: classifyQuality(url) }));
    console.log(`[socolive] Captured ${results.length} stream URL(s) for ${matchUrl}`);
    return results;
  } catch (err) {
    console.warn(`[socolive] Stream fetch error for ${matchUrl}: ${err.message}`);
    return [];
  } finally {
    await context.close();
    await browser.close();
  }
};

// ─── Part 3: saveMatchToDB ────────────────────────────────────────────────────

let cachedTabId = null;
const getTabId = async () => {
  if (cachedTabId) return cachedTabId;
  const res = await db.query("SELECT id FROM tabs WHERE slug = 'soco-live' LIMIT 1");
  cachedTabId = res.rows[0]?.id || null;
  return cachedTabId;
};

const saveMatchToDB = async (match) => {
  const tab_id = await getTabId();
  if (!tab_id) { console.warn('[socolive] soco-live tab not found'); return; }

  const scheduled_at = parseMatchTime(match.rawTime);
  const { home_logo, away_logo } = await resolveLogos(
    match.home_team, match.away_team, match.home_logo, match.away_logo
  );
  const league = match.competition || null;

  const existing = await db.query(
    'SELECT id FROM matches WHERE source_match_id = $1 AND source_name = $2 LIMIT 1',
    [match.sourceId, 'socolive']
  );

  let matchId;
  if (existing.rows.length > 0) {
    matchId = existing.rows[0].id;
    await db.query(
      `UPDATE matches
         SET status = $1, scheduled_at = $2,
             score_home = $3, score_away = $4, elapsed_minutes = $5,
             home_logo = $6, away_logo = $7, league = $8
       WHERE id = $9`,
      [match.status, scheduled_at, match.score_home, match.score_away,
       match.elapsed_minutes, home_logo, away_logo, league, matchId]
    );
  } else {
    const ins = await db.query(
      `INSERT INTO matches
         (tab_id, title, home_team, away_team, home_logo, away_logo, league,
          status, scheduled_at, source_match_id, source_name,
          score_home, score_away, elapsed_minutes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'socolive',$11,$12,$13,now())
       RETURNING id`,
      [
        tab_id, match.title,
        match.home_team || '', match.away_team || '',
        home_logo, away_logo, league,
        match.status, scheduled_at, match.sourceId,
        match.score_home, match.score_away, match.elapsed_minutes,
      ]
    );
    matchId = ins.rows[0].id;
  }

  if (!match.streams || match.streams.length === 0) return;

  for (const stream of match.streams) {
    // Honour token expiry from the URL; default to 2 hours if not parseable
    const tokenExpiry = parseTokenExpiry(stream.url);
    const expiresAt   = tokenExpiry || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const existing = await db.query(
      "SELECT id FROM stream_urls WHERE match_id = $1 AND split_part(url,'?',1) = split_part($2,'?',1) LIMIT 1",
      [matchId, stream.url]
    );

    if (existing.rows.length === 0) {
      await db.query(
        `INSERT INTO stream_urls
           (match_id, url, quality, source_name, priority, is_healthy, expires_at, created_at)
         VALUES ($1,$2,$3,'socolive',$4,true,$5,now())`,
        [matchId, stream.url, stream.quality, stream.quality === 'HD' ? 2 : 1, expiresAt]
      );
    } else {
      await db.query(
        'UPDATE stream_urls SET url=$1, expires_at=$2, is_healthy=true WHERE id=$3',
        [stream.url, expiresAt, existing.rows[0].id]
      );
    }
  }

  console.log(`[socolive] Saved ${match.streams.length} streams for "${match.title}"`);
};

// ─── Part 4: run ─────────────────────────────────────────────────────────────

const run = async () => {
  console.log('[socolive] Starting scrape…');

  const BASE_URLS = await getBaseUrls();
  let matches = null;
  for (const baseUrl of BASE_URLS) {
    try {
      const result = await fetchMatchList(baseUrl);
      if (result && result.length > 0) { matches = result; break; }
      console.warn(`[socolive] ${baseUrl} returned 0 matches, trying next…`);
    } catch (err) {
      console.warn(`[socolive] ${baseUrl} failed (${err.message}), trying next…`);
    }
  }

  if (!matches || matches.length === 0) {
    console.error('[socolive] All source URLs failed or returned no matches');
    return;
  }

  console.log(`[socolive] Processing ${matches.length} matches`);

  for (const match of matches) {
    try {
      match.streams = [];

      if ((match.status === 'live' || isStartingSoon(match)) && match.hasLive && match.matchUrl) {
        match.streams = await fetchStreamUrls(match.matchUrl);
      }

      await saveMatchToDB(match);
      await delay(2000, 4000);
    } catch (err) {
      console.error(`[socolive] Error processing "${match.title}":`, err.message);
    }
  }

  console.log('[socolive] Scrape complete');
};

module.exports = { run, fetchMatchList, fetchStreamUrls, saveMatchToDB };
