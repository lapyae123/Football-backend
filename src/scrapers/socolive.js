const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const db = require('../config/database');
const { resolveLogos } = require('../services/teamLogos');

// ─── League name normalisation (Vietnamese/Chinese → English) ─────────────────
// Mirrors streamzone/lib/leagues.js so DB always stores English names
const LEAGUE_TRANSLATIONS = [
  ['ngoại hạng anh', 'Premier League'], ['giải ngoại hạng anh', 'Premier League'],
  ['tây ban nha', 'La Liga'], ['la liga', 'La Liga'],
  ['đức', 'Bundesliga'], ['bundesliga', 'Bundesliga'],
  ['ý', 'Serie A'], ['serie a italia', 'Serie A'], ['serie a', 'Serie A'],
  ['pháp', 'Ligue 1'], ['ligue 1', 'Ligue 1'],
  ['champions league', 'Champions League'], ['cúp c1', 'Champions League'], ['liga champions', 'Champions League'],
  ['europa league', 'Europa League'], ['cúp c2', 'Europa League'],
  ['conference league', 'Conference League'],
  ['world cup', 'World Cup'], ['copa america', 'Copa America'],
  ['fa cup', 'FA Cup'], ['carabao', 'League Cup'], ['copa del rey', 'Copa del Rey'],
  ['dfb', 'DFB Pokal'], ['coppa italia', 'Coppa Italia'], ['coupe de france', 'Coupe de France'],
  ['eredivisie', 'Eredivisie'], ['primeira liga', 'Primeira Liga'],
  ['mls', 'MLS'], ['saudi', 'Saudi Pro League'], ['brasileirao', 'Brasileirão'],
  ['v.league', 'V.League'], ['vleague', 'V.League'],
  ['thai league', 'Thai League'], ['myanmar', 'Myanmar National League'],
  // Chinese
  ['英超', 'Premier League'], ['西甲', 'La Liga'], ['德甲', 'Bundesliga'],
  ['意甲', 'Serie A'], ['法甲', 'Ligue 1'], ['荷甲', 'Eredivisie'],
  ['欧冠', 'Champions League'], ['欧联', 'Europa League'], ['欧会', 'Conference League'],
  ['世界杯', 'World Cup'], ['足总杯', 'FA Cup'], ['中超', 'Chinese Super League'],
  ['日职联', 'J-League'], ['韩职联', 'K-League'],
];

const normaliseLeague = (raw) => {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  for (const [key, english] of LEAGUE_TRANSLATIONS) {
    if (lower.includes(key.toLowerCase())) return english;
  }
  return raw;
};

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
// Multiple patterns handle different socolive mirror JS structures.
const extractApiUrl = (html) => {
  const patterns = [
    /["']api["']\s*:\s*["'](https?:[^"']+football)["']/,
    /["']api_url["']\s*:\s*["'](https?:[^"']+)["']/,
    /var\s+api_url\s*=\s*["'](https?:[^"']+)["']/,
    /apiUrl\s*[:=]\s*["'](https?:[^"']+)["']/,
    /["']base_url["']\s*:\s*["'](https?:[^"']+football[^"']*)["']/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1].replace(/\\/g, '');
  }
  return null;
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

// Cooldown: only attempt auto-discovery once per 30 min to avoid hammering search engines
let lastDiscoveryAt = 0;
const DISCOVERY_COOLDOWN_MS = 30 * 60 * 1000;

const discoverMirror = async () => {
  const now = Date.now();
  if (now - lastDiscoveryAt < DISCOVERY_COOLDOWN_MS) {
    console.log('[socolive] Auto-discovery skipped — cooldown active');
    return null;
  }
  lastDiscoveryAt = now;

  console.log('[socolive] Running auto-discovery…');
  const queries = [
    'socolive truc tiep bong da xem truc tuyen site:*.tv OR site:*.io OR site:*.cv',
    'socolive football live stream API',
  ];
  const allCandidates = new Set();
  for (const q of queries) {
    for (const c of await searchWeb(q)) allCandidates.add(c);
    if (allCandidates.size >= 10) break;
  }
  const candidates = [...allCandidates];
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

// Socolive slugs are inconsistent — some teams use full name, some use short name.
// Return all 4 combinations so extractListStream can try each one.
const buildMatchUrls = (match, baseUrl) => {
  const hShort = stringToSlug(match.home_team?.short_name || '');
  const hFull  = stringToSlug(match.home_team?.name       || '');
  const aShort = stringToSlug(match.away_team?.short_name || '');
  const aFull  = stringToSlug(match.away_team?.name       || '');
  if ((!hShort && !hFull) || (!aShort && !aFull)) return [];

  const ictDate = new Date(match.match_time * 1000 + ICT_OFFSET_MS);
  const HH = String(ictDate.getUTCHours()).padStart(2, '0');
  const MM = String(ictDate.getUTCMinutes()).padStart(2, '0');
  const DD = String(ictDate.getUTCDate()).padStart(2, '0');
  const mo = String(ictDate.getUTCMonth() + 1).padStart(2, '0');
  const YY = ictDate.getUTCFullYear();
  const suffix = `-luc-${HH}${MM}-ngay-${DD}-${mo}-${YY}`;
  const base   = baseUrl.replace(/\/$/, '');

  const combos = [...new Set([
    `${hFull}-vs-${aShort}`,   // most common: Newcastle United vs West Ham
    `${hShort}-vs-${aShort}`,  // both short
    `${hFull}-vs-${aFull}`,    // both full
    `${hShort}-vs-${aFull}`,   // short vs full
  ])].filter((s) => s !== '-vs-' && !s.startsWith('-') && !s.endsWith('-'));

  // With time suffix (primary — socolive canonical URL format)
  const withTime    = combos.map((s) => `${base}/truc-tiep/${s}${suffix}/`);
  // Without time suffix (fallback — some mirrors omit it or use a different time)
  const withoutTime = combos.slice(0, 2).map((s) => `${base}/truc-tiep/${s}/`);
  return [...withTime, ...withoutTime];
};

// Keep single-URL fallback for compatibility with other callers
const buildMatchUrl = (match, baseUrl) => buildMatchUrls(match, baseUrl)[0] || null;

// ─── Live match list (direct API, no browser needed) ─────────────────────────

// status_id reference: 1=not started, 2=1st half, 3=half-time, 4=2nd half,
// 5=extra time, 6=penalties, 7=finished(full), 8=finished(other), 9=postponed
// We fetch 2-7 as "live" — status 7 included so nearly-finished matches still show streams
const LIVE_STATUS_IDS = new Set([2, 3, 4, 5, 6, 7]);

// Faster httpsGet for bulk match detail fetching — longer timeout, no redirect follow
const httpsGetFast = (url, headers = {}) => new Promise((resolve) => {
  const { get } = require('https');
  const req = get(url, {
    timeout: 10000,
    headers: {
      'User-Agent':      randomUA(),
      'Accept':          'application/json, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...headers,
    },
  }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
});

// detail_live returns only {id, score, status_id} — fetch full details in parallel.
// In-memory cache so repeated cycles don't re-fetch unchanged team/competition data.
const MAX_DETAIL_FETCH = 150;

// Cache: id → { home_team, away_team, competition, match_time, cachedAt }
// Entries kept for 12 hours — team names/logos never change mid-match
// Cleared only on server restart (one cold cycle to refill)
const matchDetailCache = new Map();
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const DETAIL_BATCH = 5;    // small batches to avoid rate-limiting
const BATCH_DELAY  = 300;  // ms between batches

const fetchMatchDetails = async (api, baseUrl, ids) => {
  const all     = ids.slice(0, MAX_DETAIL_FETCH);
  const referer = { Referer: baseUrl + '/', Origin: baseUrl };

  // Split into cache hits vs misses (cache valid for 12h)
  const now    = Date.now();
  const hits   = [];
  const misses = [];
  for (const item of all) {
    const c = matchDetailCache.get(item.id);
    if (c && (now - c.cachedAt) < CACHE_TTL_MS) {
      hits.push({ ...c, id: item.id, score: item.score, status_id: item.status_id });
    } else {
      misses.push(item);
    }
  }

  if (misses.length) {
    console.log(`[socolive] detail cache: ${hits.length} hits, ${misses.length} misses — fetching…`);
  }

  // Fetch misses in small batches with delay to avoid rate-limiting
  const fetched = [];
  for (let i = 0; i < misses.length; i += DETAIL_BATCH) {
    const batch   = misses.slice(i, i + DETAIL_BATCH);
    const results = await Promise.all(
      batch.map(async ({ id, score, status_id }) => {
        const res = await httpsGetFast(`${api}/match/${id}`, referer);
        if (!res?.body) return null;
        try {
          const d = JSON.parse(res.body);
          const m = d.data;
          if (!m?.home_team?.name || !m?.away_team?.name) return null;
          // Save to cache — team names/logos never change mid-match
          matchDetailCache.set(id, {
            home_team:   m.home_team,
            away_team:   m.away_team,
            competition: m.competition,
            match_time:  m.match_time,
            cachedAt:    Date.now(),
          });
          return { ...m, score, status_id };
        } catch (_) { return null; }
      })
    );
    fetched.push(...results.filter(Boolean));
    // Pause between batches so the API doesn't throttle us
    if (i + DETAIL_BATCH < misses.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY));
    }
  }

  const total = hits.length + fetched.length;
  console.log(`[socolive] detail ready: ${total} matches (${hits.length} cached, ${fetched.length} fetched)`);
  return [...hits, ...fetched];
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
      const matchPaths = buildMatchUrls(m, siteBase);
      if (!matchPaths.length) return null;
      return {
        sourceId:     m.id,
        title:        `${m.home_team.short_name || m.home_team.name} vs ${m.away_team.short_name || m.away_team.name}`,
        home_team:    m.home_team.name || '',
        away_team:    m.away_team.name || '',
        home_logo:    m.home_team.logo || null,
        away_logo:    m.away_team.logo || null,
        league:       normaliseLeague(m.competition?.name) || null,
        status:       'live',
        score_home:   Array.isArray(m.score) ? (m.score[2]?.[1] ?? null) : null,
        score_away:   Array.isArray(m.score) ? (m.score[3]?.[1] ?? null) : null,
        elapsed:      null,
        scheduled_at: m.match_time ? new Date(m.match_time * 1000).toISOString() : null,
        matchPath:    matchPaths[0],   // primary (for DB/display)
        matchPaths,                    // all candidates (for stream extraction)
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

// Iframe URLs (livepingscorex.com) have no quality indicator — return null so UI shows "Server N"
const classifyQuality = (url) => {
  if (!url) return null;
  if (/hd|720|1080|high/i.test(url)) return 'HD';
  if (/\.m3u8|\.flv/i.test(url)) return 'SD';
  return null;
};

const parseTokenExpiry = (url) => {
  // auth_key can be 10-digit (China-style) or prefixed e.g. 3000001779174600 (SOCO-style).
  // The actual Unix expiry timestamp is always the last 10 digits before the first '-'.
  const m = url.match(/auth_key=(\d+)/);
  if (!m) return null;
  const ts = parseInt(m[1].slice(-10), 10);
  if (ts < 1700000000) return null; // sanity check — must be a plausible 2024+ timestamp
  return new Date(ts * 1000).toISOString();
};

// Resolve a soco channel iframe URL to the real CDN stream URL.
// Fetches the embed page and extracts `var urlStream = "..."` from the HTML.
const resolveStreamUrl = async (iframeUrl) => {
  const res = await httpsGet(iframeUrl, { Referer: 'https://canetads.com/' });
  if (!res?.body) return null;
  const m = res.body.match(/var\s+urlStream\s*=\s*"([^"]+)"/);
  if (!m) return null;
  const url = m[1].replace(/\\\//g, '/');
  if (!url.includes('.m3u8') && !url.includes('.flv')) return null;
  return url;
};

// Primary: extract list_stream from the match page HTML — fast, no browser needed.
// Tries multiple URL slug combinations since socolive inconsistently uses
// full team name vs short name (e.g. "newcastle-united" vs "newcastle").
// For each iframe URL in list_stream, resolves the real CDN stream URL via API.
const extractListStream = async (matchUrls) => {
  const candidates = Array.isArray(matchUrls) ? matchUrls : [matchUrls];
  for (const matchUrl of candidates) {
    if (!matchUrl) continue;
    const res = await httpsGet(matchUrl, { Referer: matchUrl });
    if (!res?.body) continue;
    const m = res.body.match(/var\s+list_stream\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) continue;
    try {
      const raw = JSON.parse(m[1].replace(/\\\//g, '/'));
      const iframeUrls = [...new Set(raw.flat().filter((u) => u?.startsWith('http')))];
      if (!iframeUrls.length) continue;

      const streams = (await Promise.all(
        iframeUrls.map(async (iframeUrl) => {
          const cdnUrl = await resolveStreamUrl(iframeUrl).catch(() => null);
          if (!cdnUrl) return null;
          return { url: cdnUrl, quality: classifyQuality(cdnUrl), priority: 2 };
        })
      )).filter(Boolean);

      if (streams.length > 0) return streams;
    } catch (_) {}
  }
  return [];
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

// Main entry: try HTTP first across all URL candidates.
// When matchPaths are provided (socolive matches), HTTP extraction is definitive —
// if none of the slug candidates have list_stream, the match has no streams yet.
// Playwright fallback is only for external JS-rendered sources without matchPaths.
const fetchStreamUrls = async (matchUrl, browser, matchPaths) => {
  const candidates = matchPaths?.length ? matchPaths : [matchUrl];
  const streams = await extractListStream(candidates);
  if (streams.length > 0) {
    const slug = candidates[0]?.split('/').slice(-2, -1)[0] || '';
    console.log(`[socolive] HTTP stream extract: ${streams.length} server(s) — ${slug}`);
    return streams;
  }
  // Skip Playwright if we already tried all socolive slug combinations
  if (matchPaths?.length) return [];
  // Fallback for external JS-rendered sources
  return fetchStreamUrlsViaPlaywright(matchUrl, browser);
};

// ─── DB write helpers ─────────────────────────────────────────────────────────

const hasFreshStreams = async (matchId) => {
  const r = await db.query(
    `SELECT 1 FROM stream_urls WHERE match_id = $1 AND is_healthy = true
     AND (expires_at IS NULL OR expires_at > NOW() + INTERVAL '15 minutes') LIMIT 1`,
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
         status          = CASE WHEN status = 'finished' THEN 'finished' ELSE $1 END,
         score_home      = $2, score_away   = $3, elapsed_minutes = $4,
         home_logo       = $5, away_logo    = $6,
         league          = COALESCE($7::text, league),
         stream_page_url = COALESCE($9::text, stream_page_url)
       WHERE id = $8`,
      [match.status, match.score_home, match.score_away, match.elapsed ?? null,
       home_logo, away_logo, match.league || null, matchId, match.matchPath || null]
    );
  } else {
    const ins = await db.query(
      `INSERT INTO matches (tab_id, title, home_team, away_team, home_logo, away_logo,
         league, status, scheduled_at, source_match_id, source_name,
         score_home, score_away, elapsed_minutes, stream_page_url, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'socolive',$11,$12,$13,$14,now()) RETURNING id`,
      [tabId, match.title, match.home_team, match.away_team, home_logo, away_logo,
       match.league, match.status, match.scheduled_at, match.sourceId,
       match.score_home, match.score_away, match.elapsed ?? null, match.matchPath || null]
    );
    matchId = ins.rows[0].id;
  }

  if (!match.streams?.length) return;

  for (const stream of match.streams) {
    // null quality (iframe servers) → stored as 'SD' so streams route groups it correctly
    const quality   = stream.quality || 'SD';
    const expiresAt = parseTokenExpiry(stream.url) || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const dup = await db.query(
      "SELECT id FROM stream_urls WHERE match_id=$1 AND split_part(url,'?',1)=split_part($2,'?',1) LIMIT 1",
      [matchId, stream.url]
    );
    const priority = stream.priority ?? (quality === 'HD' ? 2 : 1);
    if (dup.rows.length) {
      await db.query(
        'UPDATE stream_urls SET url=$1, expires_at=$2, is_healthy=true, fail_count=0, priority=$4 WHERE id=$3',
        [stream.url, expiresAt, dup.rows[0].id, priority]
      );
    } else {
      await db.query(
        `INSERT INTO stream_urls (match_id, url, quality, source_name, priority, is_healthy, expires_at, created_at)
         VALUES ($1,$2,$3,'socolive',$4,true,$5,now())`,
        [matchId, stream.url, quality, priority, expiresAt]
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

  // All matches from fetchMatchList have matchPaths — HTTP-only extraction, no browser needed.
  // Browser is only launched as a last resort for external sources without matchPaths.
  const needsPlaywright = matches.some((m) => !m.matchPaths?.length);
  const browser = needsPlaywright ? await newBrowser() : null;
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
              match.streams = await fetchStreamUrls(match.matchPath, browser, match.matchPaths);
            }
          } catch (err) {
            console.error(`[socolive] Stream fetch failed "${match.title}":`, err.message);
            match.streams = [];
          }
        })
      )
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
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
