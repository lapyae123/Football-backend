const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const db = require('../config/database');
const { resolveLogos } = require('../services/teamLogos');

chromium.use(StealthPlugin());

const DISCOVERY_URL = 'https://s2sprediction.net/';
const SOCO_DEFAULTS = [
  process.env.SOCO_BASE_URL   || 'https://www.socolive.tv',
  process.env.SOCO_BASE_URL_2 || 'https://s2sprediction.net',
];
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
];
const randomUA  = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
const PROXY_URL = process.env.SCRAPER_PROXY || null;
const LIVE_STATUSES = new Set([2, 3, 4, 5, 6, 7]);
const STREAM_CDNS   = ['pull.niur.live', 'pull.niues.live', 'pull.niup.live'];
const CONCURRENCY   = 3;

// ─── DB helpers ───────────────────────────────────────────────────────────────

const getBaseUrls = async () => {
  try {
    const r = await db.query("SELECT config FROM sources WHERE slug = 'socolive' AND is_active = true LIMIT 1");
    const urls = r.rows[0]?.config?.base_urls;
    if (Array.isArray(urls) && urls.length) return urls;
  } catch (_) {}
  return SOCO_DEFAULTS;
};

const saveDiscoveredUrl = async (url) => {
  try {
    await db.query(
      `UPDATE sources SET config = jsonb_set(config, '{base_urls}',
         to_jsonb(ARRAY(SELECT DISTINCT u FROM unnest(
           ARRAY[$1] || ARRAY(SELECT jsonb_array_elements_text(config->'base_urls'))
         ) AS u LIMIT 6))) WHERE slug = 'socolive'`,
      [url]
    );
  } catch (_) {}
};

let cachedTabId = null;
const getTabId = async () => {
  if (cachedTabId) return cachedTabId;
  const r = await db.query("SELECT id FROM tabs WHERE slug = 'soco-live' LIMIT 1");
  cachedTabId = r.rows[0]?.id || null;
  return cachedTabId;
};

// ─── Browser helpers ──────────────────────────────────────────────────────────

const newBrowser = () => {
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
  ];
  if (PROXY_URL) args.push(`--proxy-server=${PROXY_URL}`);
  return chromium.launch({ headless: true, args });
};

const newContext = (browser) =>
  browser.newContext({ userAgent: randomUA(), viewport: { width: 1366, height: 768 }, locale: 'en-US', timezoneId: 'Asia/Bangkok' });

// ─── Auto-discovery ───────────────────────────────────────────────────────────

const discoverMirror = async () => {
  console.log('[socolive] Trying auto-discovery via', DISCOVERY_URL);
  const browser = await newBrowser();
  const ctx     = await newContext(browser);
  try {
    const page      = await ctx.newPage();
    await page.goto(DISCOVERY_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const discovered = await page.evaluate(() => {
      const link = document.querySelector('link[rel="alternate"][media]');
      return link ? link.href : null;
    });
    if (discovered?.startsWith('http')) {
      console.log('[socolive] Discovered mirror:', discovered);
      await saveDiscoveredUrl(discovered);
      return discovered;
    }
    const hasMatches = await page.evaluate(() => document.querySelectorAll('.match-item').length > 0);
    return hasMatches ? DISCOVERY_URL : null;
  } catch (err) {
    console.warn('[socolive] Auto-discovery failed:', err.message);
    return null;
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
};

// ─── Match list ───────────────────────────────────────────────────────────────

const fetchMatchList = async (baseUrl) => {
  const browser = await newBrowser();
  const ctx     = await newContext(browser);
  const matches = [];
  let resolved  = false;

  return new Promise(async (resolve) => {
    const finish  = (r) => { if (!resolved) { resolved = true; resolve(r); } };
    const timeout = setTimeout(() => finish(matches), 35000);

    try {
      ctx.on('response', async (res) => {
        if (!res.url().includes('apiscoreflow.com/football')) return;
        try {
          const json   = await res.json();
          const stages = json?.Stages || json?.data?.Stages || [];
          for (const stage of stages) {
            for (const event of (stage.Events || [])) {
              const status  = event.Eps ?? event.status ?? 0;
              const startMs = event.Esd ? (event.Esd > 1e12 ? event.Esd : event.Esd * 1000) : null;
              matches.push({
                sourceId:     String(event.Eid || event.id || ''),
                title:        `${event.T1?.[0]?.Nm || ''} vs ${event.T2?.[0]?.Nm || ''}`,
                home_team:    event.T1?.[0]?.Nm  || '',
                away_team:    event.T2?.[0]?.Nm  || '',
                home_logo:    event.T1?.[0]?.Img ? `https://lsm-static-prod.livescore.com/medium/${event.T1[0].Img}` : null,
                away_logo:    event.T2?.[0]?.Img ? `https://lsm-static-prod.livescore.com/medium/${event.T2[0].Img}` : null,
                league:       stage.Snm || null,
                status:       LIVE_STATUSES.has(status) ? 'live' : 'scheduled',
                score_home:   event.Tr1 != null ? +event.Tr1 : null,
                score_away:   event.Tr2 != null ? +event.Tr2 : null,
                elapsed:      startMs ? Math.max(0, Math.floor((Date.now() - startMs) / 60000)) : null,
                scheduled_at: startMs ? new Date(startMs).toISOString() : null,
                matchPath:    event.slug || event.Scd || null,
                isLive:       LIVE_STATUSES.has(status),
              });
            }
          }
          if (matches.length > 0) { clearTimeout(timeout); finish(matches); }
        } catch (_) {}
      });

      const page = await ctx.newPage();
      await page.route('**/*', (route) => {
        if (['image', 'font', 'media', 'stylesheet'].includes(route.request().resourceType())) return route.abort();
        route.continue();
      });
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);

      if (matches.length === 0) {
        await page.waitForSelector('.match-item', { timeout: 10000 }).catch(() => {});
        const domMatches = await page.$$eval('.match-item', (cards, base) =>
          cards.map((card) => {
            const homeTeam = card.querySelector('.match-home .name-team-inner span')?.textContent.trim() || '';
            const awayTeam = card.querySelector('.match-away .name-team-inner span')?.textContent.trim() || '';
            const href     = card.querySelector('a.link-match')?.getAttribute('href') || null;
            const slug     = href ? href.split('/').filter(Boolean).pop() : null;
            const isLive   = card.getAttribute('is-live') === '1';
            const sourceId = card.getAttribute('data-match-id') || slug;
            const scoreRaw = card.querySelector('.score-match-data')?.textContent.trim() || null;
            let score_home = null, score_away = null;
            if (scoreRaw) {
              const parts = scoreRaw.split('-').map((s) => parseInt(s.trim(), 10));
              if (parts.length === 2 && !isNaN(parts[0])) { score_home = parts[0]; score_away = parts[1]; }
            }
            const timeRaw   = card.querySelector('.time-text, .match-minute, [class*="minute"], [class*="time-live"]')?.textContent.trim() || null;
            const elapsed   = timeRaw ? (parseInt(timeRaw.replace(/[^0-9]/g, ''), 10) || null) : null;
            const rawTime   = card.querySelector('.match-item__time span, .match-time')?.textContent.trim() || null;
            return {
              sourceId, slug,
              title: `${homeTeam} vs ${awayTeam}`,
              home_team: homeTeam, away_team: awayTeam,
              home_logo: card.querySelector('.logo-home img')?.src || null,
              away_logo: card.querySelector('.logo-away img')?.src || null,
              league:    card.querySelector('.match-item__comp, .competition-name, [class*="league"]')?.textContent.trim() || null,
              status:    isLive ? 'live' : 'scheduled',
              score_home, score_away, elapsed, rawTime, isLive,
              matchPath: href ? (href.startsWith('http') ? href : `${base}${href}`) : null,
            };
          }), baseUrl
        ).catch(() => []);
        matches.push(...domMatches);
      }

      clearTimeout(timeout);
      finish(matches);
    } catch (err) {
      clearTimeout(timeout);
      console.warn(`[socolive] fetchMatchList failed (${baseUrl}):`, err.message);
      finish(matches);
    } finally {
      await ctx.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  });
};

// ─── Stream URL fetching ──────────────────────────────────────────────────────

const isStreamUrl = (url) => {
  if (!url || url.length > 2000) return false;
  if (/\.(js|css|png|jpg|jpeg|gif|ico|woff|woff2|svg|webp|ts)(\?|$)/i.test(url)) return false;
  if (STREAM_CDNS.some((cdn) => url.includes(cdn))) {
    return url.includes('.m3u8') || url.includes('.flv') || url.includes('playlist');
  }
  return url.includes('.m3u8') || url.includes('.flv');
};

const classifyQuality = (url) => /hd|720|1080|high/i.test(url) ? 'HD' : 'SD';

const parseTokenExpiry = (url) => {
  const m = url.match(/auth_key=(\d{10})/);
  if (m) return new Date(parseInt(m[1], 10) * 1000).toISOString();
  return null;
};

const PLAY_SELECTORS = [
  '.play-btn', '[class*="play-btn"]', '[class*="btnPlay"]',
  'button[aria-label*="play" i]', '.jw-icon-display', '.vjs-big-play-button',
  '[class*="player"] button', 'video',
];

// Reuses the shared browser — only context is created/destroyed per match
const fetchStreamUrls = async (matchUrl, browser) => {
  const ctx   = await newContext(browser);
  const found = new Set();

  ctx.on('request',  (req) => { try { if (isStreamUrl(req.url()))  found.add(req.url()); } catch (_) {} });
  ctx.on('response', (res) => { try { if (isStreamUrl(res.url()))  found.add(res.url()); } catch (_) {} });

  try {
    const page = await ctx.newPage();
    await page.goto(matchUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);

    for (const sel of PLAY_SELECTORS) {
      try { const el = await page.$(sel); if (el) { await el.click({ timeout: 2000 }); break; } } catch (_) {}
    }
    await page.waitForTimeout(1500);

    if (found.size === 0) {
      const iframeSrcs = await page.$$eval('iframe[src]',
        (els) => els.map((e) => e.src).filter((s) => s?.startsWith('http'))
      ).catch(() => []);

      for (const src of iframeSrcs.slice(0, 2)) {
        try {
          const iframePage = await ctx.newPage();
          await iframePage.goto(src, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
          await iframePage.waitForTimeout(2000);
          for (const sel of PLAY_SELECTORS) {
            try { const el = await iframePage.$(sel); if (el) { await el.click({ timeout: 2000 }); break; } } catch (_) {}
          }
          await iframePage.waitForTimeout(2000);
          await iframePage.close().catch(() => {});
          if (found.size > 0) break;
        } catch (_) {}
      }
    }

    return [...found].map((url) => ({ url, quality: classifyQuality(url) }));
  } catch (err) {
    console.warn(`[socolive] Stream fetch error (${matchUrl}):`, err.message);
    return [];
  } finally {
    await ctx.close().catch(() => {});
  }
};

// ─── DB write helpers ─────────────────────────────────────────────────────────

const ICT_OFFSET_MS = 7 * 60 * 60 * 1000;

const parseMatchTime = (raw) => {
  if (!raw) return null;
  try {
    const m = raw.match(/(\d{1,2}):(\d{2})(?:.*?(\d{1,2})\/(\d{1,2}))?/);
    if (!m) return null;
    const nowIct = new Date(Date.now() + ICT_OFFSET_MS);
    const hour   = parseInt(m[1], 10);
    const min    = parseInt(m[2], 10);
    const day    = m[3] ? parseInt(m[3], 10)     : nowIct.getUTCDate();
    const month  = m[4] ? parseInt(m[4], 10) - 1 : nowIct.getUTCMonth();
    const d = new Date(Date.UTC(nowIct.getUTCFullYear(), month, day, hour, min, 0) - ICT_OFFSET_MS);
    if (d.getTime() < Date.now() - 12 * 60 * 60 * 1000) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  } catch (_) { return null; }
};

const hasFreshStreams = async (matchId) => {
  const r = await db.query(
    `SELECT 1 FROM stream_urls WHERE match_id = $1 AND is_healthy = true
     AND (expires_at IS NULL OR expires_at > NOW() + INTERVAL '30 minutes') LIMIT 1`,
    [matchId]
  );
  return r.rows.length > 0;
};

const saveMatchToDB = async (match, tabId) => {
  const { home_logo, away_logo } = await resolveLogos(
    match.home_team, match.away_team, match.home_logo, match.away_logo
  );
  const scheduledAt = match.scheduled_at || parseMatchTime(match.rawTime)
    || (match.Esd ? new Date(match.Esd).toISOString() : null);

  const existing = await db.query(
    'SELECT id FROM matches WHERE source_match_id = $1 AND source_name = $2 LIMIT 1',
    [match.sourceId, 'socolive']
  );

  let matchId;
  if (existing.rows.length) {
    matchId = existing.rows[0].id;
    await db.query(
      `UPDATE matches SET
         status          = CASE WHEN status = 'finished' THEN 'finished' ELSE $1 END,
         score_home      = $2, score_away      = $3, elapsed_minutes = $4,
         home_logo       = $5, away_logo       = $6,
         league          = COALESCE($7, league),
         scheduled_at    = COALESCE($9, scheduled_at)
       WHERE id = $8`,
      [match.status, match.score_home, match.score_away, match.elapsed ?? null,
       home_logo, away_logo, match.league || null, matchId, scheduledAt]
    );
  } else {
    if (match.status === 'scheduled' && scheduledAt) {
      if (new Date(scheduledAt) < new Date(Date.now() - 2 * 60 * 60 * 1000)) return;
    }
    const ins = await db.query(
      `INSERT INTO matches (tab_id, title, home_team, away_team, home_logo, away_logo,
         league, status, scheduled_at, source_match_id, source_name,
         score_home, score_away, elapsed_minutes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'socolive',$11,$12,$13,now()) RETURNING id`,
      [tabId, match.title, match.home_team, match.away_team, home_logo, away_logo,
       match.league, match.status, scheduledAt, match.sourceId,
       match.score_home, match.score_away, match.elapsed ?? null]
    );
    matchId = ins.rows[0].id;
  }

  if (!match.streams?.length) return;

  for (const stream of match.streams) {
    const expiresAt = parseTokenExpiry(stream.url) || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const dup = await db.query(
      "SELECT id FROM stream_urls WHERE match_id=$1 AND split_part(url,'?',1)=split_part($2,'?',1) LIMIT 1",
      [matchId, stream.url]
    );
    if (dup.rows.length) {
      await db.query('UPDATE stream_urls SET url=$1, expires_at=$2, is_healthy=true WHERE id=$3',
        [stream.url, expiresAt, dup.rows[0].id]);
    } else {
      await db.query(
        `INSERT INTO stream_urls (match_id, url, quality, source_name, priority, is_healthy, expires_at, created_at)
         VALUES ($1,$2,$3,'socolive',$4,true,$5,now())`,
        [matchId, stream.url, stream.quality, stream.quality === 'HD' ? 2 : 1, expiresAt]
      );
    }
  }

  console.log(`[socolive] Saved "${match.title}" — ${match.streams.length} streams`);
};

const markFinished = async (activeSourceIds, tabId) => {
  if (!tabId) return;
  if (activeSourceIds.length) {
    const placeholders = activeSourceIds.map((_, i) => `$${i + 2}`).join(',');
    await db.query(
      `UPDATE matches SET status = 'finished'
       WHERE tab_id = $1 AND source_name = 'socolive' AND status = 'live'
         AND source_match_id NOT IN (${placeholders})
         AND (scheduled_at IS NULL OR scheduled_at < NOW() - INTERVAL '2 hours 30 minutes')`,
      [tabId, ...activeSourceIds]
    );
  }
  await db.query(
    `UPDATE matches SET status = 'finished'
     WHERE tab_id = $1 AND source_name = 'socolive' AND status = 'live'
       AND (scheduled_at IS NULL OR scheduled_at < NOW() - INTERVAL '3 hours')`,
    [tabId]
  );
};

// ─── Concurrency limiter ──────────────────────────────────────────────────────

const pLimit = (n) => {
  let active = 0;
  const queue = [];
  const next = () => {
    while (active < n && queue.length) {
      active++;
      const { task, resolve, reject } = queue.shift();
      task().then(resolve, reject).finally(() => { active--; next(); });
    }
  };
  return (task) => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); next(); });
};

// ─── Main run ─────────────────────────────────────────────────────────────────

const run = async () => {
  console.log('[socolive] Starting scrape…');
  const tabId = await getTabId();
  if (!tabId) { console.warn('[socolive] soco-live tab not found'); return; }

  let matches = null;
  const baseUrls = await getBaseUrls();

  for (const url of baseUrls) {
    try {
      console.log(`[socolive] Trying mirror: ${url}`);
      const result = await fetchMatchList(url);
      if (result.length > 0) { matches = result; break; }
      console.warn(`[socolive] ${url} returned 0 matches`);
    } catch (err) {
      console.warn(`[socolive] ${url} failed:`, err.message);
    }
  }

  if (!matches?.length) {
    console.warn('[socolive] All mirrors failed — running auto-discovery…');
    const discovered = await discoverMirror();
    if (discovered && !baseUrls.includes(discovered)) {
      try {
        const result = await fetchMatchList(discovered);
        if (result.length > 0) matches = result;
      } catch (err) {
        console.warn('[socolive] Discovered URL also failed:', err.message);
      }
    }
  }

  if (!matches?.length) { console.error('[socolive] No matches found — aborting'); return; }

  const liveMatches = matches.filter((m) => m.isLive && m.matchPath);
  const browser     = await newBrowser();
  const limit       = pLimit(CONCURRENCY);
  const activeIds   = [];

  try {
    await Promise.all(
      liveMatches.map((match) =>
        limit(async () => {
          try {
            const existing = await db.query(
              'SELECT id FROM matches WHERE source_match_id=$1 AND source_name=$2 LIMIT 1',
              [match.sourceId, 'socolive']
            );
            const matchId = existing.rows[0]?.id;
            if (matchId && await hasFreshStreams(matchId)) {
              match.streams = [];
            } else {
              match.streams = await fetchStreamUrls(match.matchPath, browser);
            }
          } catch (err) {
            console.error(`[socolive] Stream fetch failed "${match.title}":`, err.message);
            match.streams = [];
          }
        })
      )
    );
  } finally {
    await browser.close().catch(() => {});
  }

  for (const match of matches) {
    if (!match.isLive) match.streams = [];
    try {
      await saveMatchToDB(match, tabId);
      if (match.sourceId) activeIds.push(match.sourceId);
    } catch (err) {
      console.error(`[socolive] Save failed "${match.title}":`, err.message);
    }
  }

  await markFinished(activeIds, tabId).catch((err) =>
    console.error('[socolive] markFinished error:', err.message)
  );

  console.log('[socolive] Scrape complete');
};

module.exports = { run, fetchMatchList, fetchStreamUrls, discoverMirror };
