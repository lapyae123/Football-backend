const https = require('https');
const db = require('../config/database');
const { resolveLogos } = require('../services/teamLogos');

const CHINA_DEFAULTS = {
  api_base: 'https://json.yyzb456.top',
  referer:  'https://yyzbw8.live/',
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

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

const get = (url, referer = CHINA_DEFAULTS.referer) => new Promise((resolve, reject) => {
  const req = https.get(url, {
    headers: { 'User-Agent': UA, 'Referer': referer },
    timeout: 10000,
  }, (res) => {
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

// ─── Title parser ─────────────────────────────────────────────────────────────

const parseTitle = (raw) => {
  // Handle 〖league〗hometeam ... format — extract and remove the 〖...〗 block
  let cleaned = raw.replace(/〖[^〗]*〗/g, '').replace(/【[^】]*】/g, '').trim();
  // Strip leading emoji / decorators
  cleaned = cleaned.replace(/^[\s\p{Emoji}\p{So}★▲◆●■🔥]+/u, '').trim();
  // Collapse multiple spaces/tabs
  cleaned = cleaned.replace(/\s+/g, ' ');

  // Split on VS separators: " VS ", "▲", "vs", "V"
  const SEP = /\s+[Vv][Ss]\.?\s+|\s*▲\s*|\s+[Vv]\s+/;
  const parts = cleaned.split(SEP);

  if (parts.length >= 2) {
    const left = parts[0].trim();
    const away_team = parts[parts.length - 1].trim();
    // left = "league hometeam" — split off first token as league
    const leftParts = left.split(' ');
    const league = leftParts.length > 1 ? leftParts[0] : '';
    const home_team = leftParts.length > 1 ? leftParts.slice(1).join(' ') : left;
    return { league, home_team, away_team };
  }

  // No spaced separator — try inline "leagueHomevs Away"
  const m = cleaned.match(/^(.+?)\s+(.+?)[Vv][Ss](.+?)$/);
  if (m) return { league: m[1].trim(), home_team: m[2].trim(), away_team: m[3].trim() };

  return { league: '', home_team: cleaned, away_team: '' };
};

// ─── Fetch list ───────────────────────────────────────────────────────────────

const STA_BASE = 'https://sta.yyzb456.top';

// Ensure logo URLs are absolute (some come back as "/file/imgs/..." relative paths)
const absoluteLogo = (url) => {
  if (!url) return null;
  return url.startsWith('http') ? url : `${STA_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
};

// Fetch today's match schedule and return a map of roomNum → match metadata
const fetchSchedule = async (baseApi = CHINA_DEFAULTS.api_base, referer = CHINA_DEFAULTS.referer) => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const url  = `${baseApi}/match/matches_${date}.json?v=${Date.now()}`;
  try {
    const text = await get(url, referer);
    const json = parseJsonp(text);
    const matches = json.data || [];

    const index = new Map(); // roomNum → schedule entry
    for (const m of matches) {
      for (const anchor of m.anchors || []) {
        const roomNum = String(anchor.anchor?.roomNum || anchor.roomNum || '');
        if (roomNum) {
          index.set(roomNum, {
            scheduleId: m.scheduleId,
            league:     m.subCateName  || null,
            home_team:  m.hostName     || null,
            away_team:  m.guestName    || null,
            home_logo:  absoluteLogo(m.hostIcon),
            away_logo:  absoluteLogo(m.guestIcon),
          });
        }
      }
    }
    console.log(`[chinalive] Schedule loaded: ${matches.length} matches, ${index.size} room entries`);
    return index;
  } catch (err) {
    console.warn(`[chinalive] Schedule fetch failed: ${err.message}`);
    return new Map();
  }
};

const fetchRooms = async (baseApi = CHINA_DEFAULTS.api_base, referer = CHINA_DEFAULTS.referer) => {
  const url = `${baseApi}/all_live_rooms.json?v=${Date.now()}`;
  const text = await get(url, referer);
  const json = parseJsonp(text);
  if (json.code !== 200) throw new Error(`API error: ${json.msg}`);

  const rooms = [];
  for (const arr of Object.values(json.data || {})) {
    if (Array.isArray(arr)) rooms.push(...arr);
  }
  return rooms.filter((r) => r.liveStatus === 1 && r.liveTypeParent === 1);
};

// ─── Fetch stream URLs for one room ──────────────────────────────────────────

const fetchStreams = async (roomNum) => {
  const url = `${BASE_API}/room/${roomNum}/detail.json?v=${Date.now()}`;
  try {
    const text = await get(url);
    const json = parseJsonp(text);
    if (json.code !== 200) return [];
    const s    = json.data?.stream || {};
    const seen = new Set();
    const urls = [];

    const add = (val, quality) => {
      if (val && typeof val === 'string' && !seen.has(val)) {
        seen.add(val);
        urls.push({ url: val, quality });
      }
    };

    // Known priority fields first
    add(s.hdM3u8, 'HD');
    add(s.m3u8,   'SD');
    add(s.hdFlv,  'HD');
    add(s.flv,    'SD');

    // Scan every remaining string field for any m3u8 / flv URL
    for (const [key, val] of Object.entries(s)) {
      if (typeof val !== 'string') continue;
      if (!val.includes('.m3u8') && !val.includes('.flv')) continue;
      const isHD = /hd|high|1080|720/i.test(key) || /hd|high|1080|720/i.test(val);
      add(val, isHD ? 'HD' : 'SD');
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

const saveRoom = async (room, streams, tabId, schedule) => {
  const sourceId = String(room.roomNum);
  const sched    = schedule?.get(sourceId);

  // Prefer schedule data (has proper team names + logos); fall back to title parsing
  let home_team, away_team, league, home_logo, away_logo;
  if (sched) {
    home_team = sched.home_team || '';
    away_team = sched.away_team || '';
    league    = sched.league;
    home_logo = sched.home_logo;
    away_logo = sched.away_logo;
  } else {
    const parsed   = parseTitle(room.title);
    home_team      = parsed.home_team;
    away_team      = parsed.away_team;
    league         = parsed.league || null;
    const cover    = room.cutOutCustomCoverUrl || room.cover || null;
    const resolved = await resolveLogos(home_team, away_team, cover, cover);
    home_logo      = resolved.home_logo;
    away_logo      = resolved.away_logo;
  }

  const title = home_team && away_team ? `${home_team} vs ${away_team}` : room.title;

  const existing = await db.query(
    'SELECT id FROM matches WHERE source_match_id = $1 AND source_name = $2 LIMIT 1',
    [sourceId, 'chinalive']
  );

  let matchId;
  if (existing.rows.length > 0) {
    matchId = existing.rows[0].id;
    await db.query(
      `UPDATE matches SET status=$1, title=$2, home_team=$3, away_team=$4,
       home_logo=$5, away_logo=$6, league=$7 WHERE id=$8`,
      ['live', title, home_team || room.title, away_team || '', home_logo, away_logo, league || null, matchId]
    );
  } else {
    const ins = await db.query(
      `INSERT INTO matches
         (tab_id, title, home_team, away_team, home_logo, away_logo, league, status, scheduled_at,
          source_match_id, source_name, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'live',now(),$8,'chinalive',now())
       RETURNING id`,
      [tabId, title, home_team || room.title, away_team || '', home_logo, away_logo, league || null, sourceId]
    );
    matchId = ins.rows[0].id;
  }

  // Upsert stream URLs — match on base URL (ignore auth_key) to avoid duplicates
  for (const s of streams) {
    const ex = await db.query(
      "SELECT id FROM stream_urls WHERE match_id=$1 AND split_part(url,'?',1) = split_part($2,'?',1) LIMIT 1",
      [matchId, s.url]
    );
    if (ex.rows.length === 0) {
      await db.query(
        `INSERT INTO stream_urls
           (match_id, url, quality, source_name, priority, is_healthy, expires_at, created_at)
         VALUES ($1,$2,$3,'chinalive',$4,true,NOW()+interval '50 minutes',now())`,
        [matchId, s.url, s.quality, s.quality === 'HD' ? 2 : 1]
      );
    } else {
      await db.query(
        `UPDATE stream_urls SET url=$1, expires_at=NOW()+interval '50 minutes', is_healthy=true
         WHERE id=$2`,
        [s.url, ex.rows[0].id]
      );
    }
  }
};

const markFinished = async (activeSourceIds) => {
  if (activeSourceIds.length === 0) return;
  const tabId = await getTabId();
  if (!tabId) return;
  const placeholders = activeSourceIds.map((_, i) => `$${i + 2}`).join(',');
  await db.query(
    `UPDATE matches SET status='finished'
     WHERE tab_id=$1 AND source_name='chinalive'
       AND status='live'
       AND source_match_id NOT IN (${placeholders})`,
    [tabId, ...activeSourceIds]
  );
};

// ─── Main run ─────────────────────────────────────────────────────────────────

const run = async () => {
  console.log('[chinalive] Starting scrape…');
  const tabId = await getTabId();
  if (!tabId) { console.warn('[chinalive] china-live tab not found'); return; }

  const { api_base, referer } = await getSourceConfig();

  // Fetch schedule and rooms in parallel
  const [schedule, rooms] = await Promise.all([
    fetchSchedule(api_base, referer),
    fetchRooms(api_base, referer).catch((err) => { console.error('[chinalive] Failed to fetch room list:', err.message); return null; }),
  ]);
  if (!rooms) return;
  console.log(`[chinalive] Found ${rooms.length} live sport rooms`);

  const activeIds = [];

  for (const room of rooms) {
    try {
      const streams = await fetchStreams(room.roomNum);
      await saveRoom(room, streams, tabId, schedule);
      activeIds.push(String(room.roomNum));
      const sched = schedule.get(String(room.roomNum));
      const label = sched ? `${sched.home_team} vs ${sched.away_team}` : room.title;
      console.log(`[chinalive] Saved "${label}" (${streams.length} streams)`);
    } catch (err) {
      console.error(`[chinalive] Error processing room ${room.roomNum}:`, err.message);
    }
  }

  await markFinished(activeIds);
  console.log('[chinalive] Scrape complete');
};

module.exports = { run };
