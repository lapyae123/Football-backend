const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const db = require('../config/database');

chromium.use(StealthPlugin());

const BASE_URL = process.env.SOCO_BASE_URL || 'https://www.barbaramassaad.com';
const LIST_URL = `${BASE_URL}/`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  const now = new Date();
  const month = m[4] ? parseInt(m[4], 10) - 1 : now.getMonth();
  const day   = m[3] ? parseInt(m[3], 10)     : now.getDate();
  return new Date(now.getFullYear(), month, day, parseInt(m[1], 10), parseInt(m[2], 10), 0).toISOString();
};

const classifyQuality = (url) => {
  if (/_hd|720|1080|uhd|hi/i.test(url)) return 'HD';
  return 'SD';
};

const isStreamUrl = (url) => {
  if (/\.(js|css|png|jpg|gif|ico|woff|svg)(\?|$)/i.test(url)) return false;
  return (
    url.includes('.m3u8') ||
    url.includes('.flv')  ||
    (url.includes('playlist') && !url.includes('.js')) ||
    (/\/stream\//i.test(url) && !url.includes('.js'))
  );
};

const newBrowser = () =>
  chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

// ─── Part 1: fetchMatchList ───────────────────────────────────────────────────

const fetchMatchList = async () => {
  const browser = await newBrowser();
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 720 } });
  const page    = await context.newPage();

  // Block images, fonts, stylesheets to save bandwidth
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  try {
    console.log(`[socolive] Loading match list: ${LIST_URL}`);
    await page.goto(LIST_URL, { waitUntil: 'networkidle', timeout: 30000 });
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

        // "TRỰC TIẾP" in running text = live
        const runningText = card.querySelector('.match-running')?.textContent.trim() || '';
        const statusByText = /trực tiếp|đang diễn ra/i.test(runningText) ? 'live' : null;
        const status = isLive ? 'live' : (statusByText || 'scheduled');

        // Score: "0 - 0" → split into home/away integers
        const scoreRaw = card.querySelector('.score-match-data')?.textContent.trim() || null;
        let score_home = null, score_away = null;
        if (scoreRaw) {
          const parts = scoreRaw.split('-').map(s => parseInt(s.trim(), 10));
          if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            score_home = parts[0];
            score_away = parts[1];
          }
        }

        // Elapsed minutes: "14'" → 14
        const timeText = card.querySelector('.time-text')?.textContent.trim() || null;
        const elapsed_minutes = timeText ? parseInt(timeText.replace(/[^0-9]/g, ''), 10) || null : null;

        const matchUrl = href
          ? href.startsWith('http') ? href : `${baseUrl}${href}`
          : null;

        return {
          slug,
          sourceId,
          title:       `${homeTeam} vs ${awayTeam}`,
          home_team:   homeTeam,
          away_team:   awayTeam,
          home_logo:   homeLogo,
          away_logo:   awayLogo,
          rawTime,
          competition,
          status,
          hasLive,
          matchUrl,
          score_home,
          score_away,
          elapsed_minutes,
        };
      }),
      BASE_URL
    );

    console.log(`[socolive] Found ${matches.length} matches`);
    return matches;
  } finally {
    await context.close();
    await browser.close();
  }
};

// ─── Part 2: fetchStreamUrls ──────────────────────────────────────────────────

const fetchStreamUrls = async (matchUrl) => {
  const browser = await newBrowser();
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 720 } });
  const page    = await context.newPage();

  const found = new Set();

  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (isStreamUrl(url)) found.add(url);
    } catch (_) {}
  });

  try {
    console.log(`[socolive] Fetching streams: ${matchUrl}`);
    await page.goto(matchUrl, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(10000);

    // Try clicking a play button
    const playSelectors = [
      '.play-btn', '[class*="play-btn"]', '[class*="btnPlay"]',
      'button[aria-label*="play" i]', '.jw-icon-display', '.vjs-big-play-button',
      'video'
    ];
    for (const sel of playSelectors) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click({ timeout: 3000 }); break; }
      } catch (_) {}
    }

    await page.waitForTimeout(5000);

    return [...found].map((url) => ({ url, quality: classifyQuality(url) }));
  } catch (err) {
    console.warn(`[socolive] Stream fetch error for ${matchUrl}: ${err.message}`);
    return [];
  } finally {
    await context.close();
    await browser.close();
  }
};

// ─── Part 4: saveMatchToDB ────────────────────────────────────────────────────

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

  // Upsert match
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
           score_home = $3, score_away = $4, elapsed_minutes = $5
       WHERE id = $6`,
      [match.status, scheduled_at, match.score_home, match.score_away, match.elapsed_minutes, matchId]
    );
  } else {
    const ins = await db.query(
      `INSERT INTO matches
         (tab_id, title, home_team, away_team, home_logo, away_logo,
          status, scheduled_at, source_match_id, source_name,
          score_home, score_away, elapsed_minutes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'socolive',$10,$11,$12,now())
       RETURNING id`,
      [
        tab_id, match.title,
        match.home_team || '', match.away_team || '',
        match.home_logo, match.away_logo,
        match.status, scheduled_at,
        match.sourceId,
        match.score_home, match.score_away, match.elapsed_minutes
      ]
    );
    matchId = ins.rows[0].id;
  }

  // Insert stream URLs
  if (match.streams && match.streams.length > 0) {
    for (const stream of match.streams) {
      const alreadyExists = await db.query(
        'SELECT id FROM stream_urls WHERE match_id = $1 AND url = $2 LIMIT 1',
        [matchId, stream.url]
      );
      if (alreadyExists.rows.length === 0) {
        await db.query(
          `INSERT INTO stream_urls
             (match_id, url, quality, source_name, priority, is_healthy, expires_at, created_at)
           VALUES ($1,$2,$3,'socolive',$4,true, NOW() + interval '4 hours', now())`,
          [matchId, stream.url, stream.quality, stream.quality === 'HD' ? 2 : 1]
        );
      } else {
        // Refresh expiry on existing URL
        await db.query(
          "UPDATE stream_urls SET expires_at = NOW() + interval '4 hours', is_healthy = true WHERE match_id = $1 AND url = $2",
          [matchId, stream.url]
        );
      }
    }
    console.log(`[socolive] Saved ${match.streams.length} streams for "${match.title}"`);
  }
};

// ─── Part 5: run ─────────────────────────────────────────────────────────────

const run = async () => {
  try {
    console.log('[socolive] Starting scrape…');
    const matches = await fetchMatchList();
    console.log(`[socolive] Processing ${matches.length} matches`);

    for (const match of matches) {
      try {
        match.streams = [];

        if (match.status === 'live' || isStartingSoon(match)) {
          if (match.hasLive && match.matchUrl) {
            match.streams = await fetchStreamUrls(match.matchUrl);
            console.log(`[socolive] ${match.title}: ${match.streams.length} streams found`);
          }
        }

        await saveMatchToDB(match);
        await delay(2000, 4000);
      } catch (err) {
        console.error(`[socolive] Error processing "${match.title}":`, err.message);
      }
    }

    console.log('[socolive] Scrape complete');
  } catch (err) {
    console.error('[socolive] Scrape failed:', err.message);
  }
};

module.exports = { run, fetchMatchList, fetchStreamUrls, saveMatchToDB };
