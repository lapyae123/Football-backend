const https = require('https');
const http  = require('http');
const db = require('../config/database');

const CHINA_DEFAULTS = {
  api_base: 'https://json.yyzb456.top',
  referer:  'https://yyzbw8.live/',
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
const jitter    = (min = 500, max = 2000) =>
  new Promise((r) => setTimeout(r, Math.floor(Math.random() * (max - min)) + min));

const getSourceConfig = async () => {
  try {
    const r = await db.query(
      "SELECT config FROM sources WHERE slug = 'chinalive' AND is_active = true LIMIT 1"
    );
    const cfg = r.rows[0]?.config;
    if (cfg?.api_base) return { api_base: cfg.api_base, referer: cfg.referer || CHINA_DEFAULTS.referer };
  } catch (_) {}
  return CHINA_DEFAULTS;
};

// ─── HTTP helper ─────────────────────────────────────────────────────────────

// Optional HTTP proxy for residential IP routing (set SCRAPER_PROXY=http://user:pass@host:port)
const PROXY_URL = process.env.SCRAPER_PROXY || null;

const get = (url, referer = CHINA_DEFAULTS.referer) => new Promise((resolve, reject) => {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';

  const options = {
    headers: {
      'User-Agent': randomUA(),
      'Referer':    referer,
      'Accept':     'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 12000,
  };

  let requester = isHttps ? https : http;

  if (PROXY_URL) {
    const proxy = new URL(PROXY_URL);
    options.host = proxy.hostname;
    options.port = proxy.port;
    options.path = url;
    options.headers['Host'] = parsed.hostname;
    if (proxy.username) {
      const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
      options.headers['Proxy-Authorization'] = `Basic ${auth}`;
    }
    requester = proxy.protocol === 'https:' ? https : http;
  } else {
    options.hostname = parsed.hostname;
    options.path     = parsed.pathname + parsed.search;
  }

  const req = requester.get(options, (res) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => resolve(body));
  });
  req.on('error', reject);
  req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
});

// Strip JSONP wrapper  e.g.  all_live_rooms({...})  →  {...}
const parseJsonp = (text) => {
  const m = text.match(/^[^(]+\((.+)\)\s*;?\s*$/s);
  return JSON.parse(m ? m[1] : text);
};

// ─── Logo helper ──────────────────────────────────────────────────────────────

const STA_BASE = 'https://sta.yyzb456.top';

const absoluteLogo = (url) => {
  if (!url) return null;
  return url.startsWith('http') ? url : `${STA_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
};

// ─── Fetch schedule (primary source for match + logo data) ───────────────────

const fetchScheduleMatches = async (baseApi = CHINA_DEFAULTS.api_base, referer = CHINA_DEFAULTS.referer) => {
  // Use Beijing time (UTC+8) — schedule files are organized by Chinese date, not UTC
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  const url  = `${baseApi}/match/matches_${date}.json?v=${Date.now()}`;
  try {
    const text = await get(url, referer);
    const json = parseJsonp(text);
    const matches = json.data || [];
    console.log(`[chinalive] Schedule loaded: ${matches.length} matches`);
    return matches;
  } catch (err) {
    console.warn(`[chinalive] Schedule fetch failed: ${err.message}`);
    return [];
  }
};

// ─── Fetch live rooms → returns Map<roomNum, room> ────────────────────────────

const fetchRooms = async (baseApi = CHINA_DEFAULTS.api_base, referer = CHINA_DEFAULTS.referer) => {
  const url = `${baseApi}/all_live_rooms.json?v=${Date.now()}`;
  const text = await get(url, referer);
  const json = parseJsonp(text);
  if (json.code !== 200) throw new Error(`API error: ${json.msg}`);

  const rooms = [];
  for (const arr of Object.values(json.data || {})) {
    if (Array.isArray(arr)) rooms.push(...arr);
  }
  const live = rooms.filter((r) => r.liveStatus === 1);
  // allRooms includes non-live rooms so we can pre-fetch streams for upcoming matches
  const allRooms = new Map(rooms.map((r) => [String(r.roomNum), r]));
  return { liveMap: new Map(live.map((r) => [String(r.roomNum), r])), allRooms };
};

// ─── Fetch stream URLs for one room ──────────────────────────────────────────

const fetchStreams = async (roomNum, baseApi = CHINA_DEFAULTS.api_base, referer = CHINA_DEFAULTS.referer) => {
  const url = `${baseApi}/room/${roomNum}/detail.json?v=${Date.now()}`;
  try {
    const text = await get(url, referer);
    const json = parseJsonp(text);
    if (json.code !== 200) return [];
    const s    = json.data?.stream || {};
    const seen = new Set();
    const urls = [];

    const add = (val, quality, priority) => {
      if (val && typeof val === 'string' && !seen.has(val)) {
        seen.add(val);
        urls.push({ url: val, quality, priority });
      }
    };

    // Priority: HD m3u8 > SD m3u8 > HD FLV > SD FLV
    add(s.hdM3u8, 'HD', 4);
    add(s.m3u8,   'SD', 3);
    add(s.hdFlv,  'HD', 2);
    add(s.flv,    'SD', 1);

    // Catch any extra stream fields not covered above
    for (const [key, val] of Object.entries(s)) {
      if (typeof val !== 'string') continue;
      if (!val.includes('.m3u8') && !val.includes('.flv')) continue;
      const isHD  = /hd|high|1080|720/i.test(key) || /hd|high|1080|720/i.test(val);
      const isM3u8 = val.includes('.m3u8');
      add(val, isHD ? 'HD' : 'SD', isHD && isM3u8 ? 4 : isM3u8 ? 3 : isHD ? 2 : 1);
    }

    return urls;
  } catch (err) {
    console.warn(`[chinalive] Stream fetch failed for room ${roomNum}: ${err.message}`);
    return [];
  }
};

// ─── Token helpers ────────────────────────────────────────────────────────────

const parseTokenExpiry = (url) => {
  const m = url.match(/auth_key=(\d{10})/);
  if (!m) return null;
  // Always store the actual expiry so expireOldUrls() can correctly hide expired streams.
  // Health checks are skipped for auth_key URLs (urlHealthJob.js), so expireOldUrls()
  // is the only mechanism that marks these streams unhealthy. The scraper will refresh
  // within 2 minutes with a new token.
  return new Date(parseInt(m[1], 10) * 1000).toISOString();
};

// ─── DB helpers ───────────────────────────────────────────────────────────────

let cachedTabId = null;
const getTabId = async () => {
  if (cachedTabId) return cachedTabId;
  const r = await db.query("SELECT id FROM tabs WHERE slug = 'china-live' LIMIT 1");
  cachedTabId = r.rows[0]?.id || null;
  return cachedTabId;
};

const saveMatch = async (sched, streams, tabId, sourceId) => {
  const home_team  = sched.home_team  || '';
  const away_team  = sched.away_team  || '';
  const title      = home_team && away_team ? `${home_team} vs ${away_team}` : home_team;
  const league     = sched.league     || null;
  const home_logo  = sched.home_logo  || null;
  const away_logo  = sched.away_logo  || null;
  const scheduledAt = sched.scheduled_at || null;
  const score_home  = sched.score_home ?? null;
  const score_away  = sched.score_away ?? null;
  const db_status   = sched.db_status || 'live';

  // Upsert match in one round-trip
  const upsertResult = await db.query(
    `INSERT INTO matches
       (tab_id, title, home_team, away_team, home_logo, away_logo, league,
        status, scheduled_at, source_match_id, source_name,
        score_home, score_away, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'chinalive',$11,$12,now())
     ON CONFLICT (source_match_id, source_name) DO UPDATE
       SET status = CASE
             -- Never go backwards from finished
             WHEN matches.status = 'finished' THEN 'finished'
             -- Allow live→scheduled only when match hasn't kicked off yet (future time)
             WHEN matches.status = 'live' AND EXCLUDED.status = 'scheduled'
              AND EXCLUDED.scheduled_at IS NOT NULL
              AND EXCLUDED.scheduled_at > NOW() + INTERVAL '5 minutes' THEN 'scheduled'
             -- Otherwise keep live (prevents flickering mid-match)
             WHEN matches.status = 'live' AND EXCLUDED.status = 'scheduled' THEN 'live'
             ELSE EXCLUDED.status
           END,
           title      = EXCLUDED.title,
           home_team  = EXCLUDED.home_team,
           away_team  = EXCLUDED.away_team,
           home_logo  = EXCLUDED.home_logo,
           away_logo  = EXCLUDED.away_logo,
           league     = EXCLUDED.league,
           score_home = EXCLUDED.score_home,
           score_away = EXCLUDED.score_away,
           scheduled_at = CASE
             WHEN EXCLUDED.scheduled_at IS NOT NULL
              AND ABS(EXTRACT(EPOCH FROM (matches.scheduled_at - matches.created_at))) < 120
             THEN EXCLUDED.scheduled_at
             ELSE matches.scheduled_at
           END
     RETURNING id`,
    [tabId, title, home_team, away_team, home_logo, away_logo, league,
     db_status, scheduledAt, sourceId, score_home, score_away]
  );
  const matchId = upsertResult.rows[0].id;

  if (streams.length === 0) return;

  // Batch-fetch all existing stream rows for this match in one query
  const existing = await db.query(
    "SELECT id, split_part(url,'?',1) AS base_url FROM stream_urls WHERE match_id = $1",
    [matchId]
  );
  const existingMap = new Map(existing.rows.map((r) => [r.base_url, r.id]));

  const toInsert = [];
  const toUpdate = [];

  for (const s of streams) {
    // Use actual token expiry when available; fall back to 30-min TTL so
    // expireOldUrls() can clean up CDN streams that don't carry an auth_key.
    const tokenExpiry = parseTokenExpiry(s.url)
      || new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const prio = s.priority ?? (s.quality === 'HD' ? 2 : 1);
    const baseUrl = s.url.split('?')[0];
    const existId = existingMap.get(baseUrl);

    if (existId) {
      toUpdate.push({ id: existId, url: s.url, prio, tokenExpiry });
    } else {
      toInsert.push({ url: s.url, quality: s.quality, prio, tokenExpiry });
    }
  }

  // Batch insert new streams
  if (toInsert.length > 0) {
    const vals = toInsert.map((s, i) => {
      const b = i * 5;
      return `($${b+1},$${b+2},$${b+3},'chinalive',$${b+4},true,$${b+5}::timestamptz,now())`;
    }).join(',');
    const params = toInsert.flatMap((s) => [matchId, s.url, s.quality, s.prio, s.tokenExpiry]);
    await db.query(
      `INSERT INTO stream_urls (match_id,url,quality,source_name,priority,is_healthy,expires_at,created_at) VALUES ${vals}`,
      params
    );
  }

  // Batch update existing streams one-by-one but async parallel (small arrays, fine to scatter)
  await Promise.all(toUpdate.map((s) =>
    db.query(
      `UPDATE stream_urls
         SET url=$1, priority=$2,
             expires_at=$3::timestamptz,
             is_healthy=true, fail_count=0
       WHERE id=$4`,
      [s.url, s.prio, s.tokenExpiry, s.id]
    )
  ));
};

const markFinished = async () => {
  const tabId = await getTabId();
  if (!tabId) return;

  // Hard safety-net: mark finished after 6 hours regardless.
  await db.query(
    `UPDATE matches SET status='finished'
     WHERE tab_id=$1 AND source_name='chinalive'
       AND status='live'
       AND scheduled_at < NOW() - INTERVAL '6 hours'`,
    [tabId]
  );

  // Soft clean-up: if a live match has had no healthy, non-expired streams for
  // more than 2 hours (broadcaster went offline), hide it — no point showing
  // "No servers available" indefinitely. 2 hours gives time for temporary outages.
  await db.query(
    `UPDATE matches SET status='finished'
     WHERE tab_id=$1 AND source_name='chinalive'
       AND status='live'
       AND scheduled_at < NOW() - INTERVAL '2 hours'
       AND NOT EXISTS (
         SELECT 1 FROM stream_urls su
         WHERE su.match_id = matches.id
           AND su.is_healthy = true
           AND (su.expires_at IS NULL OR su.expires_at > NOW())
       )`,
    [tabId]
  );
};

// matchStatus values from API:
//  -9999 = fake entry (streamer chat room, not a real match) — skip
//  -14   = postponed — skip
//  0     = not started (scheduled)
//  1     = first half   (上半场)
//  2     = half time    (中场)
//  3     = second half  (下半场)
//  4     = extra time   (加时)
//  5     = penalties    (点球)
//  ≥ 10  = finished     (结束) — convention observed in similar APIs
const isLiveStatus     = (s) => s >= 1 && s <= 9;
const isFinishedStatus = (s) => s >= 10;

// ─── Main run ─────────────────────────────────────────────────────────────────

const PRE_FETCH_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const MATCH_CONCURRENCY   = 4;              // process 4 matches in parallel

const processMatch = async (match, { liveMap, allRooms, tabId, api_base, referer, now }) => {
  const ms     = match.matchStatus ?? 0;
  const cutoff = now - 4 * 60 * 60 * 1000;

  if (match.matchTime && match.matchTime < cutoff) return null;
  if (ms === -9999 || ms === -14) return null;

  const liveRoomNums = [];
  for (const anchor of match.anchors || []) {
    const rn = String(anchor.anchor?.roomNum || anchor.roomNum || '');
    if (rn && liveMap.has(rn)) liveRoomNums.push(rn);
  }

  const kickoffSoon = match.matchTime && (match.matchTime - now) <= PRE_FETCH_WINDOW_MS && match.matchTime > now;
  const preFetchRoomNums = [];
  if (kickoffSoon && liveRoomNums.length === 0) {
    for (const anchor of match.anchors || []) {
      const rn = String(anchor.anchor?.roomNum || anchor.roomNum || '');
      if (rn && allRooms.has(rn)) preFetchRoomNums.push(rn);
    }
  }

  if (ms === 0 && liveRoomNums.length === 0 && preFetchRoomNums.length === 0) return null;

  const sourceId = String(match.scheduleId);

  // Only treat live-room presence as 'live' if the match is within 15 min of kickoff.
  // Streamers sometimes go live hours early for test broadcasts — don't promote those.
  const LIVE_WINDOW_MS = 15 * 60 * 1000;
  const matchStartsSoon = !match.matchTime || (now - match.matchTime) >= -LIVE_WINDOW_MS;
  const roomsConfirmLive = liveRoomNums.length > 0 && matchStartsSoon;

  const dbStatus = roomsConfirmLive     ? 'live'
                 : isLiveStatus(ms)     ? 'live'
                 : isFinishedStatus(ms) ? 'finished'
                 : 'scheduled';

  const sched = {
    home_team:    match.hostName    || '',
    away_team:    match.guestName   || '',
    league:       match.subCateName || null,
    home_logo:    absoluteLogo(match.hostIcon),
    away_logo:    absoluteLogo(match.guestIcon),
    scheduled_at: match.matchTime ? new Date(match.matchTime).toISOString() : null,
    score_home:   match.hostScore  != null ? Number(match.hostScore)  : null,
    score_away:   match.guestScore != null ? Number(match.guestScore) : null,
    db_status:    dbStatus,
  };

  const allStreams = [];
  const roomsToFetch = liveRoomNums.length > 0 ? liveRoomNums : preFetchRoomNums;

  if (roomsToFetch.length > 0) {
    const sortedRooms = roomsToFetch
      .map((rn) => ({ rn, views: liveMap.get(rn)?.viewCount || allRooms.get(rn)?.viewCount || 0 }))
      .sort((a, b) => b.views - a.views);

    for (let rank = 0; rank < sortedRooms.length; rank++) {
      await jitter(300, 800);
      const streams = await fetchStreams(sortedRooms[rank].rn, api_base, referer).catch(() => []);
      for (const s of streams) {
        const isHLS = s.url.includes('.m3u8');
        if (!isHLS && rank > 0) continue;
        const priority = isHLS && s.quality === 'HD' ? 10 - rank
                       : isHLS                       ?  6 - rank
                       : s.quality === 'HD'          ?  3
                       :                                2;
        allStreams.push({ ...s, priority });
      }
    }
  }

  await saveMatch(sched, allStreams, tabId, sourceId);
  const tag = preFetchRoomNums.length > 0 && liveRoomNums.length === 0 ? 'pre-fetch' : dbStatus;
  console.log(`[chinalive] ${tag} "${sched.home_team} vs ${sched.away_team}" — ${allStreams.length} streams (status=${ms})`);
};

const runWithConcurrency = async (items, concurrency, fn) => {
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
};

const run = async () => {
  console.log('[chinalive] Starting scrape…');
  const tabId = await getTabId();
  if (!tabId) { console.warn('[chinalive] china-live tab not found'); return; }

  const { api_base, referer } = await getSourceConfig();

  const [scheduleMatches, roomsResult] = await Promise.all([
    fetchScheduleMatches(api_base, referer),
    fetchRooms(api_base, referer).catch((err) => {
      console.error('[chinalive] Failed to fetch rooms:', err.message);
      return null;
    }),
  ]);
  if (!roomsResult) return;

  const { liveMap, allRooms } = roomsResult;
  const now = Date.now();
  console.log(`[chinalive] ${scheduleMatches.length} scheduled, ${liveMap.size} live rooms`);

  const ctx = { liveMap, allRooms, tabId, api_base, referer, now };
  await runWithConcurrency(scheduleMatches, MATCH_CONCURRENCY, async (match) => {
    try {
      await processMatch(match, ctx);
    } catch (err) {
      console.error(`[chinalive] Error processing match ${match.scheduleId}:`, err.message);
    }
  });

  await markFinished();
  console.log('[chinalive] Scrape complete');
};

module.exports = { run };
