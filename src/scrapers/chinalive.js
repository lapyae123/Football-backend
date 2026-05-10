const https = require('https');
const db = require('../config/database');
const { resolveLogos } = require('../services/teamLogos');

const BASE_API = 'https://json.yyzb456.top';
const REFERER  = 'https://yyzbw8.live/';
const UA       = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

// ─── HTTP helper ─────────────────────────────────────────────────────────────

const get = (url) => new Promise((resolve, reject) => {
  const req = https.get(url, {
    headers: { 'User-Agent': UA, 'Referer': REFERER },
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

const fetchRooms = async () => {
  const url = `${BASE_API}/all_live_rooms.json?v=${Date.now()}`;
  const text = await get(url);
  const json = parseJsonp(text);
  if (json.code !== 200) throw new Error(`API error: ${json.msg}`);

  // data is an object keyed "0","1",... each value is an array of rooms
  const rooms = [];
  for (const arr of Object.values(json.data || {})) {
    if (Array.isArray(arr)) rooms.push(...arr);
  }
  // Only live rooms (liveStatus=1), sports category (liveTypeParent=1)
  return rooms.filter((r) => r.liveStatus === 1 && r.liveTypeParent === 1);
};

// ─── Fetch stream URLs for one room ──────────────────────────────────────────

const fetchStreams = async (roomNum) => {
  const url = `${BASE_API}/room/${roomNum}/detail.json?v=${Date.now()}`;
  try {
    const text = await get(url);
    const json = parseJsonp(text);
    if (json.code !== 200) return [];
    const s = json.data?.stream || {};
    const urls = [];
    if (s.hdM3u8)  urls.push({ url: s.hdM3u8, quality: 'HD' });
    if (s.m3u8)    urls.push({ url: s.m3u8,   quality: 'SD' });
    if (s.hdFlv)   urls.push({ url: s.hdFlv,  quality: 'HD' });
    if (s.flv)     urls.push({ url: s.flv,    quality: 'SD' });
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

const saveRoom = async (room, streams, tabId) => {
  const { league, home_team, away_team } = parseTitle(room.title);
  const title = home_team && away_team ? `${home_team} vs ${away_team}` : room.title;
  const sourceId = String(room.roomNum);

  const scrapedHomeLogo = room.cutOutCustomCoverUrl || room.cover || null;
  const { home_logo, away_logo } = await resolveLogos(home_team, away_team, scrapedHomeLogo, null);

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

  // Upsert stream URLs (auth tokens expire in ~1hr, refresh at 50min)
  for (const s of streams) {
    const ex = await db.query(
      'SELECT id FROM stream_urls WHERE match_id=$1 AND url=$2 LIMIT 1',
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
         WHERE match_id=$2 AND id=$3`,
        [s.url, matchId, ex.rows[0].id]
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

  let rooms;
  try {
    rooms = await fetchRooms();
    console.log(`[chinalive] Found ${rooms.length} live sport rooms`);
  } catch (err) {
    console.error('[chinalive] Failed to fetch room list:', err.message);
    return;
  }

  const activeIds = [];

  for (const room of rooms) {
    try {
      const streams = await fetchStreams(room.roomNum);
      await saveRoom(room, streams, tabId);
      activeIds.push(String(room.roomNum));
      console.log(`[chinalive] Saved "${room.title}" (${streams.length} streams)`);
    } catch (err) {
      console.error(`[chinalive] Error processing room ${room.roomNum}:`, err.message);
    }
  }

  await markFinished(activeIds);
  console.log('[chinalive] Scrape complete');
};

module.exports = { run };
