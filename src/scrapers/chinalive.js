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
  return new Map(live.map((r) => [String(r.roomNum), r]));
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

  const existing = await db.query(
    'SELECT id FROM matches WHERE source_match_id = $1 AND source_name = $2 LIMIT 1',
    [sourceId, 'chinalive']
  );

  let matchId;
  if (existing.rows.length > 0) {
    matchId = existing.rows[0].id;
    await db.query(
      `UPDATE matches
         SET status = $1, title = $2,
             home_team = $3, away_team = $4,
             home_logo = $5, away_logo = $6,
             league = $7,
             score_home = $8, score_away = $9,
             scheduled_at = CASE
               WHEN $11::timestamptz IS NOT NULL
                AND ABS(EXTRACT(EPOCH FROM (scheduled_at - created_at))) < 120
               THEN $11::timestamptz
               ELSE scheduled_at
             END
       WHERE id = $10`,
      [db_status, title, home_team, away_team, home_logo, away_logo, league,
       score_home, score_away, matchId, scheduledAt]
    );
  } else {
    const ins = await db.query(
      `INSERT INTO matches
         (tab_id, title, home_team, away_team, home_logo, away_logo, league,
          status, scheduled_at, source_match_id, source_name,
          score_home, score_away, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'chinalive',$11,$12,now())
       RETURNING id`,
      [tabId, title, home_team, away_team, home_logo, away_logo, league,
       db_status, scheduledAt, sourceId, score_home, score_away]
    );
    matchId = ins.rows[0].id;
  }

  for (const s of streams) {
    const ex = await db.query(
      "SELECT id, is_healthy FROM stream_urls WHERE match_id=$1 AND split_part(url,'?',1) = split_part($2,'?',1) LIMIT 1",
      [matchId, s.url]
    );
    if (ex.rows.length === 0) {
      await db.query(
        `INSERT INTO stream_urls
           (match_id, url, quality, source_name, priority, is_healthy, expires_at, created_at)
         VALUES ($1,$2,$3,'chinalive',$4,true,NOW()+interval '50 minutes',now())`,
        [matchId, s.url, s.quality, s.priority ?? (s.quality === 'HD' ? 2 : 1)]
      );
    } else {
      // Always update CDN URL (refreshes auth_key) and priority — players use stable proxy URLs
      await db.query(
        `UPDATE stream_urls
         SET url = $1,
             priority = $2,
             expires_at = NOW() + interval '50 minutes',
             is_healthy = true
         WHERE id = $3`,
        [s.url, s.priority ?? (s.quality === 'HD' ? 2 : 1), ex.rows[0].id]
      );
    }
  }
};

const markFinished = async (activeSourceIds) => {
  if (activeSourceIds.length === 0) return;
  const tabId = await getTabId();
  if (!tabId) return;
  if (activeSourceIds.length > 0) {
    const placeholders = activeSourceIds.map((_, i) => `$${i + 2}`).join(',');
    await db.query(
      `UPDATE matches SET status='finished'
       WHERE tab_id=$1 AND source_name='chinalive'
         AND status='live'
         AND source_match_id NOT IN (${placeholders})`,
      [tabId, ...activeSourceIds]
    );
  }
  // Safety net: any live match scheduled 4+ hours ago is definitely finished
  await db.query(
    `UPDATE matches SET status='finished'
     WHERE tab_id=$1 AND source_name='chinalive'
       AND status='live'
       AND scheduled_at < NOW() - INTERVAL '4 hours'`,
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

const run = async () => {
  console.log('[chinalive] Starting scrape…');
  const tabId = await getTabId();
  if (!tabId) { console.warn('[chinalive] china-live tab not found'); return; }

  const { api_base, referer } = await getSourceConfig();

  const [scheduleMatches, roomMap] = await Promise.all([
    fetchScheduleMatches(api_base, referer),
    fetchRooms(api_base, referer).catch((err) => {
      console.error('[chinalive] Failed to fetch rooms:', err.message);
      return null;
    }),
  ]);
  if (!roomMap) return;

  console.log(`[chinalive] ${scheduleMatches.length} scheduled, ${roomMap.size} live rooms`);

  const activeIds = [];

  const cutoff = Date.now() - 4 * 60 * 60 * 1000; // 4 hours ago

  for (const match of scheduleMatches) {
    const ms = match.matchStatus ?? 0;

    // Skip any match whose kickoff was 4+ hours ago — API never cleans stale live entries
    if (match.matchTime && match.matchTime < cutoff) continue;

    // Skip fake chat-room entries and postponed matches
    if (ms === -9999 || ms === -14) continue;

    // Skip not-started matches that have no live anchors yet
    const liveRoomNums = [];
    for (const anchor of match.anchors || []) {
      const rn = String(anchor.anchor?.roomNum || anchor.roomNum || '');
      if (rn && roomMap.has(rn)) liveRoomNums.push(rn);
    }
    if (ms === 0 && liveRoomNums.length === 0) continue;

    const sourceId  = String(match.scheduleId);
    const dbStatus  = isLiveStatus(ms) ? 'live' : isFinishedStatus(ms) ? 'finished' : 'scheduled';

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

    try {
      // Only fetch streams if anchors are currently live
      const allStreams = [];
      if (liveRoomNums.length > 0) {
        const sortedRooms = liveRoomNums
          .map((rn) => ({ rn, views: roomMap.get(rn)?.viewCount || 0 }))
          .sort((a, b) => b.views - a.views);

        for (let rank = 0; rank < sortedRooms.length; rank++) {
          await jitter(300, 900);
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
      if (dbStatus !== 'finished') activeIds.push(sourceId);
      console.log(`[chinalive] ${dbStatus} "${sched.home_team} vs ${sched.away_team}" — ${allStreams.length} streams (status=${ms})`);
    } catch (err) {
      console.error(`[chinalive] Error processing match ${sourceId}:`, err.message);
    }
  }

  await markFinished(activeIds);
  console.log('[chinalive] Scrape complete');
};

module.exports = { run };
