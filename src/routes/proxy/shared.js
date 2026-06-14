const db = require('../../config/database');

const STREAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

// SSRF guard — block private/loopback addresses on open proxy endpoints
const PRIVATE_IP_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

// ─── Stream URL record cache ──────────────────────────────────────────────────
// Avoids a DB round-trip on every HLS playlist refresh (every 2-5 s per viewer).
// Entry is valid until 5 min before the CDN token's own expires_at, max 10 min.
const streamCache = new Map(); // id → { url, source_name, match_id, validUntil }

const getStreamRecord = async (id) => {
  const now    = Date.now();
  const cached = streamCache.get(id);
  if (cached && cached.validUntil > now) return cached;

  const { rows } = await db.query(
    'SELECT url, source_name, match_id, expires_at FROM stream_urls WHERE id = $1 LIMIT 1',
    [id]
  );
  if (!rows.length) return null;

  const row        = rows[0];
  const expiresMs  = row.expires_at ? new Date(row.expires_at).getTime() : now + 10 * 60 * 1000;
  const validUntil = Math.min(expiresMs - 5 * 60 * 1000, now + 10 * 60 * 1000);
  const entry      = { url: row.url, source_name: row.source_name, match_id: row.match_id, validUntil };
  streamCache.set(id, entry);
  return entry;
};

const invalidateStream = (id) => streamCache.delete(id);

// After re-warm writes fresh CDN URLs for a match, bust all cached proxy entries for
// that match so the next M3U8 request picks up the new token immediately.
const invalidateMatchStreams = (matchId) => {
  for (const [id, entry] of streamCache.entries()) {
    if (entry.match_id === matchId) streamCache.delete(id);
  }
};

// ─── m3u8 playlist response cache ────────────────────────────────────────────
// HLS players re-fetch the playlist every 2-5 s. Without caching every viewer
// causes a separate server→CDN round-trip. A 4-second cache means N concurrent
// viewers share one CDN fetch, cutting latency proportionally.
const m3u8Cache  = new Map();
const M3U8_TTL_MS = 4000;

const getM3u8Cached = async (cdnUrl, fetcher) => {
  const now    = Date.now();
  const cached = m3u8Cache.get(cdnUrl);
  if (cached && cached.expiresAt > now) return cached.body;
  const body = await fetcher();
  m3u8Cache.set(cdnUrl, { body, expiresAt: now + M3U8_TTL_MS });
  return body;
};

module.exports = { STREAM_UA, PRIVATE_IP_RE, getStreamRecord, invalidateStream, invalidateMatchStreams, getM3u8Cached };
