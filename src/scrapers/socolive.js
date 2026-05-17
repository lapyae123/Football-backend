const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const db = require('../config/database');
const { resolveLogos } = require('../services/teamLogos');

chromium.use(StealthPlugin());

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
];
const randomUA  = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
const PROXY_URL = process.env.SCRAPER_PROXY || null;
const STREAM_CDNS = ['pull.niur.live', 'pull.niues.live', 'pull.niup.live'];
const CONCURRENCY = 3;

// ─── HTTP helper ──────────────────────────────────────────────────────────────

const httpsGet = (url, extraHeaders = {}) => new Promise((resolve) => {
  const { get } = require('https');
  const req = get(url, {
    timeout: 12000,
    headers: {
      'User-Agent': randomUA(),
      'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...extraHeaders,
    },
  }, (res) => {
    // Follow redirects
    if ((res.statusCode === 301 || res.statusCode === 302) && res.headers['location']) {
      const next = res.headers['location'].startsWith('http')
        ? res.headers['location']
        : new URL(res.headers['location'], url).href;
      return resolve(httpsGet(next.replace(/\/$/, ''), extraHeaders));
    }
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body, finalUrl: url }));
  });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
});

// ─── DB helpers ───────────────────────────────────────────────────────────────

const getBaseUrls = async () => {
  try {
    const r = await db.query("SELECT config FROM sources WHERE slug = 'socolive' AND is_active = true LIMIT 1");
    const raw = r.rows[0]?.config?.base_urls || [];
    return raw
      .map((u) => (typeof u === 'string' ? { url: u, enabled: true } : u))
      .filter((u) => u.enabled !== false)
      .map((u) => u.url);
  } catch (_) {}
  return [];
};

const saveDiscoveredUrl = async (url) => {
  try {
    const r = await db.query("SELECT config FROM sources WHERE slug = 'socolive' LIMIT 1");
    const raw = r.rows[0]?.config?.base_urls || [];
    const items = raw.map((u) => (typeof u === 'string' ? { url: u, enabled: true } : u));
    if (items.some((u) => u.url === url)) return;
    items.unshift({ url, enabled: true });
    await db.query(
      `UPDATE sources SET config = jsonb_set(config, '{base_urls}', $1::jsonb) WHERE slug = 'socolive'`,
      [JSON.stringify(items.slice(0, 6))]
    );
    console.log(`[socolive] Saved new mirror: ${url}`);
  } catch (_) {}
};

let cachedTabId = null;
const getTabId = async () => {
  if (cachedTabId) return cachedTabId;
  const r = await db.query("SELECT id FROM tabs WHERE slug = 'soco-live' LIMIT 1");
  cachedTabId = r.rows[0]?.id || null;
  return cachedTabId;
};

// ─── API discovery ────────────────────────────────────────────────────────────

// Extract the backend API URL from the site's localized sport_data variable.
// This is injected by PHP into every page — if the site changes its API host, we pick it up automatically.
const extractApiUrl = (html) => {
  const m = html.match(/["']api["']\s*:\s*["'](https?:[^"']+football)["']/);
  return m ? m[1].replace(/\\/g, '') : null;
};

// Cache the API URL per base domain so we don't re-fetch the HTML every cycle
const apiUrlCache = new Map(); // baseUrl → { url, fetchedAt }
const API_CACHE_TTL = 30 * 60 * 1000; // 30 min

const getApiUrl = async (baseUrl) => {
  const cached = apiUrlCache.get(baseUrl);
  if (cached && Date.now() - cached.fetchedAt < API_CACHE_TTL) return cached;

  const res = await httpsGet(baseUrl);
  if (!res?.body) return null;
  const api = extractApiUrl(res.body);
  if (api) {
    // Use the final (redirected) URL as the siteBase for building match page paths
    const siteBase = (res.finalUrl || baseUrl).replace(/\/$/, '');
    const entry = { url: api, siteBase, fetchedAt: Date.now() };
    apiUrlCache.set(baseUrl, entry);
    console.log(`[socolive] API endpoint: ${api} (site: ${siteBase})`);
    return entry;
  }
  return null;
};

// ─── Auto-discovery ───────────────────────────────────────────────────────────

const SEARCH_ENGINES = [
  { url: 'https://html.duckduckgo.com/html/?q=', re: /result__url[^>]*>\s*(https?:\/\/([^/\s<"]+))/gi },
  { url: 'https://www.bing.com/search?q=', re: /<cite>(https?:\/\/[^<\s]+)/gi },
];

const searchWeb = async (query) => {
  const domains = new Set();
  for (const engine of SEARCH_ENGINES) {
    const res = await httpsGet(engine.url + encodeURIComponent(query), {
      Accept: 'text/html', Referer: 'https://www.google.com/',
    });
    if (!res?.body) continue;
    let m;
    const re = new RegExp(engine.re.source, engine.re.flags);
    while ((m = re.exec(res.body)) !== null) domains.add(m[1].replace(/\/$/, ''));
    if (domains.size >= 5) break;
  }
  return [...domains];
};

const discoverMirror = async () => {
  console.log('[socolive] Running auto-discovery…');
  const candidates = await searchWeb('socolive truc tiep bong da xem truc tuyen site:*.tv OR site:*.io OR site:*.cv');
  console.log(`[socolive] Candidates: ${candidates.slice(0, 5).join(', ')}`);

  for (const candidate of candidates.slice(0, 10)) {
    try {
      const res = await httpsGet(candidate);
      if (!res?.body) continue;
      const api = extractApiUrl(res.body);
      if (!api) {
        console.log(`[socolive] Skip ${candidate} — no sport_data API`);
        continue;
      }
      const testRes = await httpsGet(api + '/match/detail_live', { Referer: candidate, Origin: candidate });
      const data = testRes?.body ? (() => { try { return JSON.parse(testRes.body); } catch (_) { return null; } })() : null;
      if (!data?.results?.length) continue;
      console.log(`[socolive] Discovered: ${candidate} (${data.results.length} live matches)`);
      await saveDiscoveredUrl(candidate);
      return candidate;
    } catch (_) {}
  }
  console.warn('[socolive] Auto-discovery: no working mirror found');
  return null;
};

// ─── Slug helper (mirrors socolive's stringToSlug) ────────────────────────────

const CHAR_MAP = {
  'à':'a','á':'a','â':'a','ã':'a','ä':'a','å':'a','æ':'ae','ç':'c',
  'è':'e','é':'e','ê':'e','ë':'e','ì':'i','í':'i','î':'i','ï':'i',
  'ð':'d','ñ':'n','ò':'o','ó':'o','ô':'o','õ':'o','ö':'o','ø':'o',
  'ù':'u','ú':'u','û':'u','ü':'u','ý':'y','þ':'th','ß':'ss',
  'ă':'a','â':'a','đ':'d','ê':'e','ô':'o','ơ':'o','ư':'u',
  'ắ':'a','ặ':'a','ầ':'a','ẩ':'a','ẫ':'a','ậ':'a','ả':'a','ạ':'a',
  'ấ':'a','ề':'e','ế':'e','ệ':'e','ể':'e','ễ':'e','ẹ':'e','ẻ':'e',
  'ị':'i','ĩ':'i','ỉ':'i','ọ':'o','ỏ':'o','ố':'o','ồ':'o','ổ':'o',
  'ỗ':'o','ộ':'o','ớ':'o','ờ':'o','ổ':'o','ỡ':'o','ợ':'o',
  'ụ':'u','ủ':'u','ứ':'u','ừ':'u','ử':'u','ữ':'u','ự':'u','ỷ':'y',
  'ỹ':'y','ỵ':'y','ỳ':'y','ý':'y',
  'ə':'e','ş':'s','ı':'i','ğ':'g','ō':'o','ā':'a','ū':'u',
  'ń':'n','ś':'s','ź':'z','ć':'c','ł':'l','ž':'z','š':'s','č':'c',
};

const stringToSlug = (str) => {
  if (!str) return '';
  return str
    .split('')
    .map((c) => CHAR_MAP[c] || CHAR_MAP[c.toLowerCase()] || c)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-');
};

// ─── Match URL builder ────────────────────────────────────────────────────────

const ICT_OFFSET_MS = 7 * 60 * 60 * 1000;

const buildMatchUrl = (match, baseUrl) => {
  const home = stringToSlug(match.home_team?.short_name || match.home_team?.name || '');
  const away = stringToSlug(match.away_team?.short_name || match.away_team?.name || '');
  if (!home || !away) return null;

  const ictDate = new Date(match.match_time * 1000 + ICT_OFFSET_MS);
  const HH  = String(ictDate.getUTCHours()).padStart(2, '0');
  const MM  = String(ictDate.getUTCMinutes()).padStart(2, '0');
  const DD  = String(ictDate.getUTCDate()).padStart(2, '0');
  const mo  = String(ictDate.getUTCMonth() + 1).padStart(2, '0');
  const YY  = ictDate.getUTCFullYear();

  return `${baseUrl}/truc-tiep/${home}-vs-${away}-luc-${HH}${MM}-ngay-${DD}-${mo}-${YY}/`;
};

// ─── Live match list (direct API, no browser needed) ─────────────────────────

const LIVE_STATUS_IDS = new Set([2, 3, 4, 5, 6, 7]);

// Faster httpsGet for bulk match detail fetching (shorter timeout, no redirect)
const httpsGetFast = (url, headers = {}) => new Promise((resolve) => {
  const { get } = require('https');
  const req = get(url, {
    timeout: 5000,
    headers: { 'User-Agent': randomUA(), ...headers },
  }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
});

// detail_live returns only {id, score, status_id} — fetch full details in parallel
// Cap at MAX_DETAIL_FETCH to avoid overloading the API per cycle
const MAX_DETAIL_FETCH = 80;

const fetchMatchDetails = async (api, baseUrl, ids) => {
  const capped = ids.slice(0, MAX_DETAIL_FETCH);
  const limit   = pLimit(15);
  const referer = { Referer: baseUrl + '/', Origin: baseUrl };
  const results = await Promise.all(
    capped.map(({ id, score, status_id }) =>
      limit(async () => {
        const res = await httpsGetFast(`${api}/match/${id}`, referer);
        if (!res?.body) return null;
        try {
          const d = JSON.parse(res.body);
          const m = d.data;
          if (!m?.home_team?.name || !m?.away_team?.name) return null;
          return { ...m, score, status_id };
        } catch (_) { return null; }
      })
    )
  );
  return results.filter(Boolean);
};

const fetchMatchList = async (baseUrl) => {
  const apiEntry = await getApiUrl(baseUrl);
  if (!apiEntry) {
    console.warn(`[socolive] Could not extract API URL from ${baseUrl}`);
    return [];
  }
  const { url: api, siteBase } = apiEntry;

  // Step 1: get all live match IDs + scores
  const liveRes = await httpsGet(`${api}/match/detail_live`, {
    Referer: siteBase + '/',
    Origin: siteBase,
  });
  if (!liveRes?.body) {
    console.warn(`[socolive] API unreachable for ${baseUrl}`);
    return [];
  }

  let liveData;
  try { liveData = JSON.parse(liveRes.body); } catch (_) {
    console.warn(`[socolive] API response not JSON`);
    return [];
  }

  const liveIds = (liveData.results || [])
    .filter((m) => LIVE_STATUS_IDS.has(m.status_id))
    .map((m) => ({ id: m.id, score: m.score, status_id: m.status_id }));

  if (!liveIds.length) {
    console.log(`[socolive] ${baseUrl} → 0 live matches`);
    return [];
  }

  console.log(`[socolive] Fetching details for ${liveIds.length} live matches…`);

  // Step 2: fetch full details (team names, logos, competition)
  const detailed = await fetchMatchDetails(api, siteBase, liveIds);

  // Step 3: normalise — use siteBase (redirect target) not original mirror URL
  const matches = detailed
    .map((m) => {
      const matchPath = buildMatchUrl(m, siteBase);
      if (!matchPath) return null;
      return {
        sourceId:     m.id,
        title:        `${m.home_team.short_name || m.home_team.name} vs ${m.away_team.short_name || m.away_team.name}`,
        home_team:    m.home_team.name || '',
        away_team:    m.away_team.name || '',
        home_logo:    m.home_team.logo || null,
        away_logo:    m.away_team.logo || null,
        league:       m.competition?.name || null,
        status:       'live',
        score_home:   Array.isArray(m.score) ? (m.score[2]?.[1] ?? null) : null,
        score_away:   Array.isArray(m.score) ? (m.score[3]?.[1] ?? null) : null,
        elapsed:      null,
        scheduled_at: m.match_time ? new Date(m.match_time * 1000).toISOString() : null,
        matchPath,
        isLive:       true,
      };
    })
    .filter(Boolean);

  console.log(`[socolive] ${baseUrl} → ${matches.length} live matches`);
  return matches;
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

// ─── Stream URL fetching ──────────────────────────────────────────────────────

const classifyQuality = (url) => /hd|720|1080|high/i.test(url) ? 'HD' : 'SD';

const parseTokenExpiry = (url) => {
  const m = url.match(/auth_key=(\d{10})/);
  if (m) return new Date(parseInt(m[1], 10) * 1000).toISOString();
  return null;
};

// Primary: extract list_stream from the match page HTML — fast, no browser needed.
// Socolive embeds all stream server URLs directly in the page as:
//   var list_stream = [["https://soco.livepingscorex.com/ajax/chanel/..."], ...]
const extractListStream = async (matchUrl) => {
  const res = await httpsGet(matchUrl, { Referer: matchUrl });
  if (!res?.body) return [];
  const m = res.body.match(/var\s+list_stream\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return [];
  try {
    const raw = JSON.parse(m[1].replace(/\\\//g, '/'));
    // raw = [[url1, url2], [url3], ...] — flatten, deduplicate
    const urls = [...new Set(raw.flat().filter((u) => u?.startsWith('http')))];
    return urls.map((url) => ({ url, quality: classifyQuality(url) }));
  } catch (_) { return []; }
};

// Fallback: Playwright-based .m3u8/.flv interception for non-socolive sources
const STREAM_URL_RE = /\.(m3u8|flv)(\?|$)/i;
const STREAM_CDN_RE = new RegExp(STREAM_CDNS.map((c) => c.replace('.', '\\.')).join('|'));

const isStreamUrl = (url) => {
  if (!url || url.length > 2000) return false;
  if (/\.(js|css|png|jpg|jpeg|gif|ico|woff|woff2|svg|webp)(\?|$)/i.test(url)) return false;
  if (STREAM_CDN_RE.test(url)) return STREAM_URL_RE.test(url) || url.includes('playlist');
  return STREAM_URL_RE.test(url);
};

const PLAY_SELECTORS = [
  '.play-btn', '[class*="play-btn"]', '[class*="btnPlay"]',
  'button[aria-label*="play" i]', '.jw-icon-display', '.vjs-big-play-button',
  '[class*="player"] button', 'video',
];

const fetchStreamUrlsViaPlaywright = async (matchUrl, browser) => {
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
    await page.waitForTimeout(2000);
    if (found.size === 0) {
      const iframeSrcs = await page.$$eval('iframe[src]',
        (els) => els.map((e) => e.src).filter((s) => s?.startsWith('http'))
      ).catch(() => []);
      for (const src of iframeSrcs.slice(0, 3)) {
        try {
          const ip = await ctx.newPage();
          await ip.goto(src, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
          await ip.waitForTimeout(2500);
          for (const sel of PLAY_SELECTORS) {
            try { const el = await ip.$(sel); if (el) { await el.click({ timeout: 2000 }); break; } } catch (_) {}
          }
          await ip.waitForTimeout(2000);
          await ip.close().catch(() => {});
          if (found.size > 0) break;
        } catch (_) {}
      }
    }
    return [...found].map((url) => ({ url, quality: classifyQuality(url) }));
  } catch (err) {
    console.warn(`[socolive] Playwright stream error (${matchUrl}):`, err.message);
    return [];
  } finally {
    await ctx.close().catch(() => {});
  }
};

// Main entry: try HTTP first (fast), fall back to Playwright
const fetchStreamUrls = async (matchUrl, browser) => {
  const streams = await extractListStream(matchUrl);
  if (streams.length > 0) {
    console.log(`[socolive] HTTP stream extract: ${streams.length} server(s) for ${matchUrl.split('/').slice(-2, -1)[0]}`);
    return streams;
  }
  // Fallback for non-socolive or JS-only stream pages
  return fetchStreamUrlsViaPlaywright(matchUrl, browser);
};

// ─── DB write helpers ─────────────────────────────────────────────────────────

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

  const existing = await db.query(
    'SELECT id FROM matches WHERE source_match_id = $1 AND source_name = $2 LIMIT 1',
    [match.sourceId, 'socolive']
  );

  let matchId;
  if (existing.rows.length) {
    matchId = existing.rows[0].id;
    await db.query(
      `UPDATE matches SET
         status       = CASE WHEN status = 'finished' THEN 'finished' ELSE $1 END,
         score_home   = $2, score_away   = $3, elapsed_minutes = $4,
         home_logo    = $5, away_logo    = $6,
         league       = COALESCE($7, league)
       WHERE id = $8`,
      [match.status, match.score_home, match.score_away, match.elapsed ?? null,
       home_logo, away_logo, match.league || null, matchId]
    );
  } else {
    const ins = await db.query(
      `INSERT INTO matches (tab_id, title, home_team, away_team, home_logo, away_logo,
         league, status, scheduled_at, source_match_id, source_name,
         score_home, score_away, elapsed_minutes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'socolive',$11,$12,$13,now()) RETURNING id`,
      [tabId, match.title, match.home_team, match.away_team, home_logo, away_logo,
       match.league, match.status, match.scheduled_at, match.sourceId,
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

  console.log(`[socolive] Saved "${match.title}" — ${match.streams.length} stream(s)`);
};

const deleteFinished = async (activeSourceIds, tabId) => {
  if (!tabId) return;
  if (activeSourceIds.length) {
    const placeholders = activeSourceIds.map((_, i) => `$${i + 2}`).join(',');
    await db.query(
      `DELETE FROM matches WHERE tab_id = $1 AND source_name = 'socolive'
       AND status = 'live' AND source_match_id NOT IN (${placeholders})
       AND (scheduled_at IS NULL OR scheduled_at < NOW() - INTERVAL '90 minutes')`,
      [tabId, ...activeSourceIds]
    );
  }
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

  const baseUrls = await getBaseUrls();
  let matches = null;
  let workingBase = null;

  for (const url of baseUrls) {
    try {
      const result = await fetchMatchList(url);
      if (result.length > 0) { matches = result; workingBase = url; break; }
    } catch (err) {
      console.warn(`[socolive] ${url} failed:`, err.message);
    }
  }

  if (!matches?.length) {
    console.warn('[socolive] All mirrors failed — running auto-discovery…');
    const discovered = await discoverMirror();
    if (discovered) {
      try {
        const result = await fetchMatchList(discovered);
        if (result.length > 0) { matches = result; workingBase = discovered; }
      } catch (err) {
        console.warn('[socolive] Discovered URL also failed:', err.message);
      }
    }
  }

  if (!matches?.length) { console.error('[socolive] No live matches found — aborting'); return; }

  console.log(`[socolive] ${matches.length} live matches from ${workingBase}`);

  const browser = await newBrowser();
  const limit   = pLimit(CONCURRENCY);

  try {
    await Promise.all(
      matches.map((match) =>
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

  const activeIds = [];
  for (const match of matches) {
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

  console.log('[socolive] Scrape complete');
};

module.exports = { run, fetchMatchList, fetchStreamUrls, discoverMirror };
