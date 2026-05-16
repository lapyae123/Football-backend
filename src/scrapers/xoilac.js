const https = require('https');
const http  = require('http');
const db    = require('../config/database');

// ─── Defaults (overridden by sources table config) ────────────────────────────
const DEFAULTS = {
  base_url:    'https://xoilacct.tv',
  stream_host: 'https://xl365.livepingscorex.com',
  api_base:    'https://fb-api.sportliveapiz.com',
  referer:     'https://xoilacct.tv/',
};

// status_id from fb-api: 2–7 = live, 8+ = finished, 1 = not started
const LIVE_IDS     = new Set([2, 3, 4, 5, 6, 7]);
const FINISHED_IDS = new Set([8, 9, 10, 11, 12, 13]);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter   = (min = 300, max = 1000) => sleep(Math.floor(Math.random() * (max - min)) + min);

// ─── Config from DB ───────────────────────────────────────────────────────────
const getConfig = async () => {
  try {
    const r = await db.query(
      "SELECT config FROM sources WHERE slug = 'xoilac' AND is_active = true LIMIT 1"
    );
    const cfg = r.rows[0]?.config || {};
    return {
      base_url:    cfg.base_url    || DEFAULTS.base_url,
      stream_host: cfg.stream_host || DEFAULTS.stream_host,
      api_base:    cfg.api_base    || DEFAULTS.api_base,
      referer:     cfg.referer     || DEFAULTS.referer,
    };
  } catch (_) {
    return DEFAULTS;
  }
};

// ─── HTTP helper ──────────────────────────────────────────────────────────────
const get = (url, referer = DEFAULTS.referer, timeoutMs = 12000) =>
  new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const req = (isHttps ? https : http).get(
      {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        headers:  {
          'User-Agent':      randomUA(),
          'Referer':         referer,
          'Accept':          'text/html,application/json,*/*',
          'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
        },
        timeout: timeoutMs,
      },
      (res) => {
        // Follow one redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
          return get(next, referer, timeoutMs).then(resolve).catch(reject);
        }
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(body));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });

// ─── Parse homepage → ALL matches from the full match grid ───────────────────
// Each card: id="match-child-{id}" with data-fid, data-league, data-status,
// data-runtime, team name <p> elements, and logo img src attributes.
const parseHomepage = (html) => {
  const matches = [];
  const seen    = new Set();

  // Split by match card boundaries using the unique id="match-child-..." marker
  const cardRe = /id="match-child-([a-z0-9]+)"([\s\S]*?)(?=id="match-child-[a-z0-9]|<\/body>)/g;
  let m;

  while ((m = cardRe.exec(html)) !== null) {
    const matchId = m[1];
    if (seen.has(matchId)) continue;
    seen.add(matchId);

    // Look back up to 200 chars before the id for data-* attributes on the parent div
    const before = html.slice(Math.max(0, m.index - 200), m.index);
    const after  = m[2];
    const card   = before + after;

    // Slug from href="/truc-tiep/..."
    const slugM = after.match(/href="\/truc-tiep\/([^"]+)"/);
    if (!slugM) continue;
    const slug = slugM[1].replace(/\/$/, '');

    // Data attributes (sit on the parent div, in `before` or early in `after`)
    const league     = (card.match(/data-league="([^"]+)"/)    || [])[1] || null;
    const runtimeM   =  card.match(/data-runtime="(\d+)"/);
    const statusIdRaw = (card.match(/data-status="(\d+)"/)     || [])[1];
    const statusId   = statusIdRaw != null ? parseInt(statusIdRaw) : 1;

    const scheduled_at = runtimeM
      ? new Date(parseInt(runtimeM[1]) * 1000).toISOString()
      : null;

    // Team names from <p> inside gmd-home_team / gmd-away_team
    const homeTeamBlock = after.match(/gmd-home_team[\s\S]{0,500}?<\/div>\s*<\/div>/);
    const awayTeamBlock = after.match(/gmd-away_team[\s\S]{0,500}?<\/div>\s*<\/div>/);
    const homeNameM = homeTeamBlock && homeTeamBlock[0].match(/<p>([^<]+)<\/p>/);
    const awayNameM = awayTeamBlock && awayTeamBlock[0].match(/<p>([^<]+)<\/p>/);
    const home_team = homeNameM ? homeNameM[1].trim() : null;
    const away_team = awayNameM ? awayNameM[1].trim() : null;

    // Logos from img src inside team-logo-group-home/away-logo
    const homeLogoM = after.match(/team-logo-group-home-logo[\s\S]{0,200}?src='([^']+)'/);
    const awayLogoM = after.match(/team-logo-group-away-logo[\s\S]{0,200}?src='([^']+)'/);
    const home_logo = homeLogoM ? homeLogoM[1] : null;
    const away_logo = awayLogoM ? awayLogoM[1] : null;

    // League logo
    const compLogoM = after.match(/gmd-comp_logo[^>]*>[\s\S]{0,50}?src="([^"]+)"/);
    const comp_logo = compLogoM ? compLogoM[0].match(/src="([^"]+)"/)?.[1] : null;
    const league_logo = (after.match(/gmd-match-league[\s\S]{0,300}?<img[^>]+src="([^"]+)"/) || [])[1] || null;

    matches.push({
      matchId, slug, league, league_logo,
      scheduled_at, statusId,
      home_team, away_team, home_logo, away_logo,
    });
  }

  return matches;
};

// ─── Extract clean team name (reject JS template vars like {$home}) ────────────
const cleanName = (raw) => {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || s.startsWith('{$') || s.startsWith('{/') || s === '-') return null;
  return s;
};

// ─── Parse team names from slug as fallback ───────────────────────────────────
// slug: "werder-bremen-vs-dortmund-luc-2030-ngay-16-05-2026"
const teamsFromSlug = (slug) => {
  const vsParts = slug.replace(/\.html$/, '').split('-vs-');
  if (vsParts.length < 2) return { home: null, away: null };
  const title = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  const home  = title(vsParts[0]);
  // Strip trailing date/time: -luc-HHMM-ngay-...
  const away  = title(vsParts[1].replace(/-luc-\d{4}-ngay-.*/, '').replace(/-\d{2}-\d{2}-\d{4}.*/, ''));
  return { home, away };
};

// ─── Parse status from match page HTML (Vietnamese text) ─────────────────────
// Status element: class="teambox__status" — text indicates game state
const LIVE_VI   = /hiệp|hiep|phạt|phat|thêm|them|\d{1,3}['′]/i;
const FINISH_VI = /kết thúc|ket thuc|full time|ft\b/i;

const parseStatusFromHtml = (html) => {
  const m = html.match(/teambox__status[^>]*>([\s\S]{1,50}?)<\/text/i)
         || html.match(/teambox__status[^>]*>([\s\S]{1,50}?)<\//i);
  if (!m) return null;
  const text = m[1].trim();
  if (LIVE_VI.test(text))   return 'live';
  if (FINISH_VI.test(text)) return 'finished';
  return 'scheduled';
};

// ─── Parse match page → team names, logos, time, streams ─────────────────────
const parseMatchPage = (html) => {
  // Match ID
  const idMatch = html.match(/id="match_id"\s+value="([a-z0-9]+)"/);
  const matchId = idMatch ? idMatch[1] : null;

  // Team names — look specifically inside the teambox section to avoid sidebar template vars
  const teamboxM = html.match(/<div class="teambox"[\s\S]{0,8000}/);
  const scope    = teamboxM ? teamboxM[0] : html;

  const homeNameM = scope.match(/teambox__team-home-name[^>]*>([^<]{1,80})</);
  const awayNameM = scope.match(/teambox__team-away-name[^>]*>([^<]{1,80})</);
  const home_team = cleanName(homeNameM ? homeNameM[1] : null);
  const away_team = cleanName(awayNameM ? awayNameM[1] : null);

  // Team logos
  const homeLogoM = scope.match(/team-logo-group-home-logo[^>]*>[\s\S]{0,200}?<img[^>]+src="([^"]+)"/);
  const awayLogoM = scope.match(/team-logo-group-away-logo[^>]*>[\s\S]{0,200}?<img[^>]+src="([^"]+)"/);
  const home_logo = homeLogoM ? homeLogoM[1] : null;
  const away_logo = awayLogoM ? awayLogoM[1] : null;

  // Scheduled date from data-date="2026/05/16 20:30:00" (Vietnam UTC+7)
  const dateM = html.match(/data-date="(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})"/);
  let scheduled_at = null;
  if (dateM) {
    scheduled_at = new Date(dateM[1].replace(/\//g, '-') + '+07:00').toISOString();
  }

  // League name
  const leagueM = html.match(/class="[^"]*competition[^"]*"[^>]*>[\s\S]{0,300}?<span[^>]*>([^<]{3,80})<\/span>/);
  const league  = leagueM ? leagueM[1].trim() : null;

  // Status from page HTML (most reliable — works even when API is empty)
  const htmlStatus = parseStatusFromHtml(html);

  // Stream links: var list_stream = [["url1"], ["url2"]]
  const streamM = html.match(/var list_stream\s*=\s*(\[[\s\S]+?\]);/);
  let streamUrls = [];
  if (streamM) {
    try {
      const parsed = JSON.parse(streamM[1]);
      for (const group of parsed) {
        if (Array.isArray(group)) streamUrls.push(...group.filter(Boolean));
        else if (typeof group === 'string' && group) streamUrls.push(group);
      }
    } catch (_) {}
  }

  return { matchId, home_team, away_team, home_logo, away_logo, scheduled_at, league, htmlStatus, streamUrls };
};

// ─── Fetch actual stream URL from channel proxy page ─────────────────────────
const fetchStreamUrl = async (channelUrl, referer) => {
  try {
    const html = await get(channelUrl, referer, 10000);
    // var urlStream = "https://...flv?..."  or  "https://....m3u8?..."
    const m = html.match(/var urlStream\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
};

// ─── Fetch live scores from football API ─────────────────────────────────────
const fetchLiveScores = async (apiBase) => {
  try {
    const json = JSON.parse(await get(`${apiBase}/football/match`, DEFAULTS.referer, 10000));
    const map = new Map();
    for (const item of json.results || []) {
      // score array: [matchId, statusId, homeScoreArr, awayScoreArr, halfStart, ...]
      const s = item.score || [];
      const statusId  = s[1] ?? item.status_id;
      const homeTotal = Array.isArray(s[2]) ? s[2][3] ?? s[2][0] : null;
      const awayTotal = Array.isArray(s[3]) ? s[3][3] ?? s[3][0] : null;
      map.set(item.id, { statusId, score_home: homeTotal, score_away: awayTotal });
    }
    return map;
  } catch (_) {
    return new Map();
  }
};

// ─── DB helpers ───────────────────────────────────────────────────────────────
let cachedTabId = null;
const getTabId = async () => {
  if (cachedTabId) return cachedTabId;
  const r = await db.query("SELECT id FROM tabs WHERE slug = 'xoilac' LIMIT 1");
  cachedTabId = r.rows[0]?.id || null;
  return cachedTabId;
};

const saveMatch = async (data, tabId) => {
  const {
    matchId, home_team, away_team, home_logo, away_logo,
    league, scheduled_at, status, score_home, score_away, streams,
  } = data;

  const title = home_team && away_team ? `${home_team} vs ${away_team}` : (home_team || 'Match');

  const existing = await db.query(
    'SELECT id FROM matches WHERE source_match_id = $1 AND source_name = $2 LIMIT 1',
    [matchId, 'xoilac']
  );

  let dbMatchId;
  if (existing.rows.length > 0) {
    dbMatchId = existing.rows[0].id;
    await db.query(
      `UPDATE matches
         SET status = $1, title = $2,
             home_team = $3, away_team = $4,
             home_logo = $5, away_logo = $6,
             league = $7, score_home = $8, score_away = $9
       WHERE id = $10`,
      [status, title, home_team, away_team, home_logo, away_logo,
       league, score_home, score_away, dbMatchId]
    );
  } else {
    const ins = await db.query(
      `INSERT INTO matches
         (tab_id, title, home_team, away_team, home_logo, away_logo,
          league, status, scheduled_at, source_match_id, source_name,
          score_home, score_away, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'xoilac',$11,$12,now())
       RETURNING id`,
      [tabId, title, home_team, away_team, home_logo, away_logo,
       league, status, scheduled_at, matchId, score_home, score_away]
    );
    dbMatchId = ins.rows[0].id;
  }

  // Upsert streams
  for (let i = 0; i < streams.length; i++) {
    const { url, quality } = streams[i];
    const priority = quality === 'HD' ? streams.length - i + 10 : streams.length - i;
    const ex = await db.query(
      "SELECT id FROM stream_urls WHERE match_id=$1 AND split_part(url,'?',1)=split_part($2,'?',1) LIMIT 1",
      [dbMatchId, url]
    );
    if (ex.rows.length === 0) {
      await db.query(
        `INSERT INTO stream_urls
           (match_id, url, quality, source_name, priority, is_healthy, expires_at, created_at)
         VALUES ($1,$2,$3,'xoilac',$4,true,NOW()+interval '50 minutes',now())`,
        [dbMatchId, url, quality, priority]
      );
    } else {
      await db.query(
        `UPDATE stream_urls
           SET url=$1, priority=$2, expires_at=NOW()+interval '50 minutes', is_healthy=true
         WHERE id=$3`,
        [url, priority, ex.rows[0].id]
      );
    }
  }
};

const markFinished = async (activeIds, tabId) => {
  if (!tabId) return;
  if (activeIds.length > 0) {
    const ph = activeIds.map((_, i) => `$${i + 2}`).join(',');
    await db.query(
      `UPDATE matches SET status='finished'
       WHERE tab_id=$1 AND source_name='xoilac' AND status='live'
         AND source_match_id NOT IN (${ph})`,
      [tabId, ...activeIds]
    );
  }
  await db.query(
    `UPDATE matches SET status='finished'
     WHERE tab_id=$1 AND source_name='xoilac' AND status='live'
       AND scheduled_at < NOW() - INTERVAL '4 hours'`,
    [tabId]
  );
};

// ─── Detect quality from URL ──────────────────────────────────────────────────
const detectQuality = (url = '') => {
  if (/hd|high|1080|720/i.test(url)) return 'HD';
  return 'SD';
};

// ─── Main run ─────────────────────────────────────────────────────────────────
const run = async () => {
  console.log('[xoilac] Starting scrape…');

  const tabId = await getTabId();
  if (!tabId) { console.warn('[xoilac] xoilac tab not found in DB'); return; }

  const cfg = await getConfig();

  // Fetch homepage + live scores in parallel
  const [homepageHtml, liveScores] = await Promise.all([
    get(cfg.base_url + '/', cfg.referer).catch(() => ''),
    fetchLiveScores(cfg.api_base),
  ]);

  const matches = parseHomepage(homepageHtml);
  console.log(`[xoilac] Found ${matches.length} matches on homepage`);

  const activeIds = [];

  for (const card of matches) {
    try {
      const { matchId, slug, league, scheduled_at, statusId,
              home_logo, away_logo } = card;

      // Team names from homepage card; slug as fallback
      const slugTeams = teamsFromSlug(slug);
      const home_team = cleanName(card.home_team) || slugTeams.home;
      const away_team = cleanName(card.away_team) || slugTeams.away;

      // Status from data-status on the homepage card (same codes as fb-api)
      const scoreData = liveScores.get(matchId) || {};
      let status = 'scheduled';
      const sid = scoreData.statusId ?? statusId;
      if (sid != null) {
        if (LIVE_IDS.has(sid))          status = 'live';
        else if (FINISHED_IDS.has(sid)) status = 'finished';
      }

      // Only fetch match page for streams when live
      const streams = [];
      if (status === 'live') {
        await jitter(300, 900);
        const matchHtml = await get(`${cfg.base_url}/truc-tiep/${slug}`, cfg.referer).catch(() => '');
        if (matchHtml) {
          const parsed = parseMatchPage(matchHtml);
          for (const channelUrl of parsed.streamUrls.slice(0, 4)) {
            await jitter(200, 600);
            const streamUrl = await fetchStreamUrl(channelUrl, cfg.referer);
            if (streamUrl) streams.push({ url: streamUrl, quality: detectQuality(streamUrl) });
          }
        }
      }

      await saveMatch({
        matchId, home_team, away_team, home_logo, away_logo,
        league, scheduled_at, status,
        score_home: scoreData.score_home ?? null,
        score_away: scoreData.score_away ?? null,
        streams,
      }, tabId);

      if (status !== 'finished') activeIds.push(matchId);
      console.log(`[xoilac] ${status} "${home_team} vs ${away_team}" — ${streams.length} streams`);
    } catch (err) {
      console.error(`[xoilac] Error processing ${card.slug}:`, err.message);
    }
  }

  await markFinished(activeIds, tabId);
  console.log('[xoilac] Scrape complete');
};

module.exports = { run };
