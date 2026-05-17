const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const db = require('../config/database');
const { resolveLogos } = require('../services/teamLogos');

chromium.use(StealthPlugin());

// No hardcoded domains — admin configures base_urls via sources table.
// Auto-discovery (DuckDuckGo search) runs only when all DB URLs fail.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
];
const randomUA  = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
const PROXY_URL = process.env.SCRAPER_PROXY || null;
const STREAM_CDNS = ['pull.niur.live', 'pull.niues.live', 'pull.niup.live'];
const CONCURRENCY   = 3;

// ─── DB helpers ───────────────────────────────────────────────────────────────

const getBaseUrls = async () => {
  try {
    const r = await db.query("SELECT config FROM sources WHERE slug = 'socolive' AND is_active = true LIMIT 1");
    const raw = r.rows[0]?.config?.base_urls || [];
    // Support both old string[] and new {url, enabled}[] formats
    const urls = raw
      .map((u) => (typeof u === 'string' ? { url: u, enabled: true } : u))
      .filter((u) => u.enabled !== false)
      .map((u) => u.url);
    if (urls.length) return urls;
  } catch (_) {}
  return [];
};

const saveDiscoveredUrl = async (url) => {
  try {
    // Add as {url, enabled:true} object; avoid duplicates; keep up to 6
    const r = await db.query("SELECT config FROM sources WHERE slug = 'socolive' LIMIT 1");
    const raw = r.rows[0]?.config?.base_urls || [];
    const items = raw.map((u) => (typeof u === 'string' ? { url: u, enabled: true } : u));
    if (items.some((u) => u.url === url)) return;
    items.unshift({ url, enabled: true });
    await db.query(
      `UPDATE sources SET config = jsonb_set(config, '{base_urls}', $1::jsonb) WHERE slug = 'socolive'`,
      [JSON.stringify(items.slice(0, 6))]
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

// ─── Auto-discovery via DuckDuckGo ───────────────────────────────────────────

const httpsGet = (url, extraHeaders = {}) => new Promise((resolve) => {
  const { get } = require('https');
  const req = get(url, {
    timeout: 10000,
    headers: { 'User-Agent': randomUA(), ...extraHeaders },
  }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body, location: res.headers['location'] }));
  });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
});

// Follow full redirect chain (up to maxHops) without a browser
const followRedirectChain = async (startUrl, maxHops = 5) => {
  let url = startUrl;
  for (let i = 0; i < maxHops; i++) {
    const res = await httpsGet(url);
    if (!res) return null;
    if ((res.status === 301 || res.status === 302) && res.location) {
      url = res.location.startsWith('http') ? res.location : new URL(res.location, url).href;
      url = url.replace(/\/$/, '');
    } else {
      return res.status < 500 ? url.replace(/\/$/, '') : null;
    }
  }
  return url;
};

// DuckDuckGo HTML search — no API key, no cost
const searchDuckDuckGo = async (query) => {
  const res = await httpsGet(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { Accept: 'text/html', Referer: 'https://duckduckgo.com/' }
  );
  if (!res?.body) return [];
  const domains = new Set();
  const re = /result__url[^>]*>\s*(https?:\/\/([^/\s<"]+))/gi;
  let m;
  while ((m = re.exec(res.body)) !== null) domains.add(m[1].replace(/\/$/, ''));
  return [...domains];
};

const discoverMirror = async () => {
  console.log('[socolive] Running DuckDuckGo auto-discovery…');

  const candidates = await searchDuckDuckGo('socolive truc tiep bong da xem truc tuyen');
  console.log(`[socolive] DDG candidates: ${candidates.slice(0, 5).join(', ')}`);

  for (const candidate of candidates.slice(0, 8)) {
    try {
      const resolved = await followRedirectChain(candidate);
      if (!resolved) continue;
      const page = await httpsGet(resolved);
      if (!page?.body) continue;
      const looksLive = /truc-tiep|bong-da|xem-bong|live-stream|trực tiếp/i.test(page.body);
      if (!looksLive) { console.log(`[socolive] Skipping ${resolved} — not a stream site`); continue; }
      console.log(`[socolive] Discovered: ${resolved}`);
      await saveDiscoveredUrl(resolved);
      return resolved;
    } catch (_) {}
  }

  console.warn('[socolive] Auto-discovery: no valid streaming domain found');
  return null;
};

// ─── Match list ───────────────────────────────────────────────────────────────

// status_id values from socolive: 0=scheduled, 8=finished, 1-7/9=live phase
const LIVE_STATUS_IDS = new Set(['1', '2', '3', '4', '5', '6', '7', '9']);

// ─── Extraction strategies ────────────────────────────────────────────────────

// Strategy 1: stream-player-plugin embeds all matches as <script id="matches-data"> JSON
const extractFromMatchesData = (page, siteBase) => page.evaluate((base) => {
  const el = document.getElementById('matches-data');
  if (!el) return null;
  try {
    const data = JSON.parse(el.textContent);
    const LIVE = new Set(['1','2','3','4','5','6','7','9']);
    const logoBase = `${base}/wp-content/uploads/truc-tiep/logos/football/team/`;
    return data
      .filter((item) => item.sport_id === '1')
      .map((item) => ({
        sourceId:     item.ls_id || item.id,
        title:        `${item.home_name} vs ${item.away_name}`,
        home_team:    item.home_name || '',
        away_team:    item.away_name || '',
        home_logo:    item.home_logo ? logoBase + item.home_logo : null,
        away_logo:    item.away_logo ? logoBase + item.away_logo : null,
        league:       item.match_data?.competition_full || null,
        status:       LIVE.has(item.status_id) ? 'live' : 'scheduled',
        score_home:   null, score_away: null, elapsed: null,
        scheduled_at: item.time ? new Date(parseInt(item.time) * 1000).toISOString() : null,
        matchPath:    item.post_name ? `${base}/truc-tiep/${item.post_name}` : null,
        isLive:       LIVE.has(item.status_id),
      }));
  } catch (_) { return null; }
}, siteBase);

// Strategy 2: DOM link scraping — works on sites with rendered match cards
const extractFromDOM = (page, siteBase) => page.evaluate((base) => {
  // Common match card selectors across socolive-family sites
  const cards = Array.from(document.querySelectorAll(
    '.match-item, .item-match, [class*="match-item"], [class*="item-match"], .list-match li, .match-list li'
  ));
  if (!cards.length) return null;
  return cards.map((card) => {
    const link  = card.querySelector('a[href]');
    const href  = link?.getAttribute('href') || '';
    const matchPath = href ? (href.startsWith('http') ? href : `${base}${href}`) : null;
    const home  = card.querySelector('[class*="home"] [class*="name"], [class*="team-home"] span, .name-home')?.textContent.trim() || '';
    const away  = card.querySelector('[class*="away"] [class*="name"], [class*="team-away"] span, .name-away')?.textContent.trim() || '';
    const isLive = card.getAttribute('is-live') === '1' || card.classList.contains('live') || !!card.querySelector('[class*="live"]');
    const scoreText = card.querySelector('[class*="score"]')?.textContent.trim() || '';
    const scoreParts = scoreText.match(/(\d+)\s*[-:]\s*(\d+)/);
    return {
      sourceId:     card.getAttribute('data-match-id') || card.getAttribute('data-id') || matchPath,
      title:        home && away ? `${home} vs ${away}` : card.textContent.trim().substring(0, 60),
      home_team:    home, away_team: away,
      home_logo:    card.querySelector('[class*="logo-home"] img, [class*="home"] img')?.src || null,
      away_logo:    card.querySelector('[class*="logo-away"] img, [class*="away"] img')?.src || null,
      league:       card.querySelector('[class*="league"], [class*="competition"], [class*="comp"]')?.textContent.trim() || null,
      status:       isLive ? 'live' : 'scheduled',
      score_home:   scoreParts ? parseInt(scoreParts[1]) : null,
      score_away:   scoreParts ? parseInt(scoreParts[2]) : null,
      elapsed:      null, scheduled_at: null,
      matchPath, isLive,
    };
  }).filter((m) => m.matchPath && (m.home_team || m.away_team));
}, siteBase);

// Strategy 3: Intercept any JSON API that looks like a match list
const extractFromNetworkAPI = async (page) => {
  return new Promise((resolve) => {
    const found = [];
    const done  = (r) => { clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => done(found), 8000);

    page.on('response', async (res) => {
      if (found.length > 0) return;
      const url = res.url();
      if (!/api|json|match|live|fixture/i.test(url)) return;
      try {
        const json = await res.json();
        // Look for any array that has team name fields
        const lists = [json, json?.data, json?.result, json?.matches, json?.events, json?.results]
          .filter(Array.isArray);
        for (const list of lists) {
          const sample = list[0] || {};
          const hasTeams = ['home_name','home','team1','T1','Nm','homeTeam'].some((k) => k in sample);
          if (hasTeams && list.length > 0) {
            console.log(`[socolive] Strategy 3 matched API: ${url.substring(0,80)}`);
            done(list.map((e) => ({
              sourceId:  String(e.id || e.Eid || e.match_id || ''),
              title:     `${e.home_name||e.home||e.team1||''} vs ${e.away_name||e.away||e.team2||''}`,
              home_team: e.home_name || e.home || e.team1 || '',
              away_team: e.away_name || e.away || e.team2 || '',
              home_logo: null, away_logo: null, league: e.league || e.competition || null,
              status: 'live', score_home: null, score_away: null,
              elapsed: null, scheduled_at: null,
              matchPath: e.match_url || e.url || e.slug || null,
              isLive: true,
            })));
            return;
          }
        }
      } catch (_) {}
    });
  });
};

// ─── Match list (tries all strategies) ───────────────────────────────────────

const fetchMatchList = async (baseUrl) => {
  const browser = await newBrowser();
  const ctx     = await newContext(browser);
  let matches   = [];

  try {
    const page = await ctx.newPage();
    await page.route('**/*', (route) => {
      if (['image', 'font', 'media', 'stylesheet'].includes(route.request().resourceType())) return route.abort();
      route.continue();
    });

    // Start network listener before navigation (Strategy 3)
    const networkPromise = extractFromNetworkAPI(page);

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Track redirects — save only valid socolive domains
    const finalUrl = page.url().replace(/\/$/, '');
    if (finalUrl && finalUrl !== baseUrl && !finalUrl.includes('ericbauman') && !finalUrl.includes('cf_chl')) {
      console.log(`[socolive] Redirected to: ${finalUrl}`);
      await saveDiscoveredUrl(finalUrl);
    }
    const siteBase = finalUrl || baseUrl;

    // Strategy 1: embedded JSON (fastest — no wait needed)
    const s1 = await extractFromMatchesData(page, siteBase).catch(() => null);
    if (s1?.length) {
      console.log(`[socolive] Strategy 1 (matches-data JSON): ${s1.length} matches on ${siteBase}`);
      matches = s1;
    }

    if (!matches.length) {
      // Strategy 2: DOM scraping
      await page.waitForTimeout(2000);
      const s2 = await extractFromDOM(page, siteBase).catch(() => null);
      if (s2?.length) {
        console.log(`[socolive] Strategy 2 (DOM scrape): ${s2.length} matches on ${siteBase}`);
        matches = s2;
      }
    }

    if (!matches.length) {
      // Strategy 3: network API (already listening — just await the result)
      await page.waitForTimeout(3000);
      const s3 = await networkPromise;
      if (s3?.length) {
        console.log(`[socolive] Strategy 3 (network API): ${s3.length} matches on ${siteBase}`);
        matches = s3;
      }
    }

    if (!matches.length) {
      const title = await page.title().catch(() => '');
      console.warn(`[socolive] All strategies failed on ${siteBase} — title: "${title}"`);
    } else {
      console.log(`[socolive] ${matches.filter((m) => m.isLive).length} live of ${matches.length} total`);
    }
  } catch (err) {
    console.warn(`[socolive] fetchMatchList failed (${baseUrl}):`, err.message);
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return matches;
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

  // Auto-promote: if the site still says "scheduled" but kick-off time has passed, treat as live.
  // SocoLive sometimes keeps status_id=0 for a few minutes after the match starts.
  const effectiveStatus = (match.status === 'scheduled' && scheduledAt && new Date(scheduledAt) <= Date.now())
    ? 'live'
    : match.status;

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
      [effectiveStatus, match.score_home, match.score_away, match.elapsed ?? null,
       home_logo, away_logo, match.league || null, matchId, scheduledAt]
    );
  } else {
    if (effectiveStatus === 'scheduled' && scheduledAt) {
      if (new Date(scheduledAt) < new Date(Date.now() - 2 * 60 * 60 * 1000)) return;
    }
    const ins = await db.query(
      `INSERT INTO matches (tab_id, title, home_team, away_team, home_logo, away_logo,
         league, status, scheduled_at, source_match_id, source_name,
         score_home, score_away, elapsed_minutes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'socolive',$11,$12,$13,now()) RETURNING id`,
      [tabId, match.title, match.home_team, match.away_team, home_logo, away_logo,
       match.league, effectiveStatus, scheduledAt, match.sourceId,
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

// Delete finished matches immediately when they disappear from socolive.
// No external API needed — absence from scrape results IS the signal.
const deleteFinished = async (activeSourceIds, tabId) => {
  if (!tabId) return;
  if (activeSourceIds.length) {
    const placeholders = activeSourceIds.map((_, i) => `$${i + 2}`).join(',');
    // Remove live matches no longer on socolive that kicked off 90+ min ago
    await db.query(
      `DELETE FROM matches WHERE tab_id = $1 AND source_name = 'socolive'
       AND status = 'live' AND source_match_id NOT IN (${placeholders})
       AND (scheduled_at IS NULL OR scheduled_at < NOW() - INTERVAL '90 minutes')`,
      [tabId, ...activeSourceIds]
    );
  }
  // Safety net: delete any socolive live match older than 3 hours
  await db.query(
    `DELETE FROM matches WHERE tab_id = $1 AND source_name = 'socolive'
     AND status = 'live' AND (scheduled_at IS NULL OR scheduled_at < NOW() - INTERVAL '3 hours')`,
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

  await deleteFinished(activeIds, tabId).catch((err) =>
    console.error('[socolive] deleteFinished error:', err.message)
  );

  // Batch auto-promote any "scheduled" match whose kick-off time has now passed.
  // Covers matches already in DB that weren't visited this scrape cycle.
  await db.query(
    `UPDATE matches SET status = 'live'
     WHERE tab_id = $1 AND source_name = 'socolive'
       AND status = 'scheduled'
       AND scheduled_at IS NOT NULL
       AND scheduled_at <= NOW()`,
    [tabId]
  ).catch((err) => console.error('[socolive] auto-promote error:', err.message));

  console.log('[socolive] Scrape complete');
};

module.exports = { run, fetchMatchList, fetchStreamUrls, discoverMirror };
