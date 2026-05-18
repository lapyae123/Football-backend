/**
 * Debug script for the xoilac scraper stream pipeline.
 * Run: node test-xoilac.js
 *
 * Traces: homepage → match page → channel proxy → CDN stream URL
 * No DB required — all output goes to stdout.
 */

const https = require('https');
const http  = require('http');

const BASE_URL    = 'https://xoilacct.tv';
const REFERER     = 'https://xoilacct.tv/';
const API_BASE    = 'https://fb-api.sportliveapiz.com';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── HTTP helper ──────────────────────────────────────────────────────────────
const get = (url, referer = REFERER, timeoutMs = 15000) =>
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
        console.log(`  HTTP ${res.statusCode} ← ${url.slice(0, 80)}`);
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
          console.log(`  Redirect → ${next.slice(0, 80)}`);
          return get(next, referer, timeoutMs).then(resolve).catch(reject);
        }
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });

// ─── Parse homepage → live matches only ──────────────────────────────────────
const LIVE_IDS = new Set([2, 3, 4, 5, 6, 7]);

const parseHomepage = (html) => {
  const matches = [];
  const seen    = new Set();
  const cardRe  = /id="match-child-([a-z0-9]+)"([\s\S]*?)(?=id="match-child-[a-z0-9]|<\/body>)/g;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const matchId = m[1];
    if (seen.has(matchId)) continue;
    seen.add(matchId);
    const before = html.slice(Math.max(0, m.index - 200), m.index);
    const after  = m[2];
    const card   = before + after;
    const slugM  = after.match(/href="\/truc-tiep\/([^"]+)"/);
    if (!slugM) continue;
    const slug      = slugM[1].replace(/\/$/, '');
    const statusIdRaw = (card.match(/data-status="(\d+)"/) || [])[1];
    const statusId  = statusIdRaw != null ? parseInt(statusIdRaw) : 1;
    const homeNameM = after.match(/teambox__team-home-name[^>]*>([^<]{1,80})</);
    const awayNameM = after.match(/teambox__team-away-name[^>]*>([^<]{1,80})</);
    const home_team = homeNameM ? homeNameM[1].trim() : slug.split('-vs-')[0];
    const away_team = awayNameM ? awayNameM[1].trim() : (slug.split('-vs-')[1] || '?').split('-')[0];
    const league    = (card.match(/data-league="([^"]+)"/) || [])[1] || null;
    matches.push({ matchId, slug, statusId, home_team, away_team, league });
  }
  return matches;
};

// ─── Parse match page → list_stream URLs ─────────────────────────────────────
const parseMatchPage = (html) => {
  const streamM = html.match(/var list_stream\s*=\s*(\[[\s\S]+?\]);/);
  if (!streamM) return { streamUrls: [], raw: null };
  let raw = streamM[1];
  let streamUrls = [];
  try {
    const parsed = JSON.parse(raw);
    for (const group of parsed) {
      if (Array.isArray(group)) streamUrls.push(...group.filter(Boolean));
      else if (typeof group === 'string' && group) streamUrls.push(group);
    }
  } catch (e) {
    console.warn('  JSON parse error for list_stream:', e.message);
  }
  return { streamUrls, raw };
};

// ─── Fetch CDN URL from channel proxy page ────────────────────────────────────
const fetchStreamUrl = async (channelUrl) => {
  const { status, body } = await get(channelUrl, REFERER, 12000);
  // Try both common patterns
  const m1 = body.match(/var urlStream\s*=\s*"([^"]+)"/);
  const m2 = body.match(/var urlStream\s*=\s*'([^']+)'/);
  const url = m1 ? m1[1] : (m2 ? m2[1] : null);
  if (!url) {
    // Show a snippet to help identify the actual variable name
    const snippet = body.slice(0, 3000).replace(/\s+/g, ' ');
    console.log('  [!] urlStream not found. Body snippet:\n    ', snippet.slice(0, 800));
  }
  return url;
};

// ─── Verify stream URL is reachable (HEAD request) ───────────────────────────
const checkStream = (url) =>
  new Promise((resolve) => {
    try {
      const parsed  = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const req = (isHttps ? https : http).request(
        { method: 'HEAD', hostname: parsed.hostname, path: parsed.pathname + parsed.search,
          headers: { 'User-Agent': randomUA(), 'Referer': REFERER }, timeout: 8000 },
        (res) => resolve({ ok: res.statusCode < 400, status: res.statusCode })
      );
      req.on('error', () => resolve({ ok: false, status: 'error' }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 'timeout' }); });
      req.end();
    } catch (_) {
      resolve({ ok: false, status: 'invalid-url' });
    }
  });

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n=== STEP 1: Fetch homepage ===');
  const { body: homepageHtml } = await get(BASE_URL + '/').catch((e) => {
    console.error('Homepage fetch failed:', e.message); process.exit(1);
  });
  console.log(`  Homepage size: ${homepageHtml.length} bytes`);

  const allMatches = parseHomepage(homepageHtml);
  const liveMatches = allMatches.filter((m) => LIVE_IDS.has(m.statusId));
  console.log(`\n  Total matches: ${allMatches.length}, Live: ${liveMatches.length}`);

  if (allMatches.length === 0) {
    console.log('  [!] No matches parsed — regex may need updating. Saving homepage sample...');
    require('fs').writeFileSync('/tmp/xoilac-homepage.html', homepageHtml);
    console.log('  Saved to /tmp/xoilac-homepage.html for inspection.');
    process.exit(1);
  }

  console.log('\n  All matches:');
  allMatches.forEach((m, i) =>
    console.log(`  [${i}] status=${m.statusId} ${m.home_team} vs ${m.away_team} | ${m.slug}`)
  );

  // Pick a live match, else the first scheduled for stream testing
  const target = liveMatches[0] || allMatches[0];
  if (!target) { console.log('No matches to test.'); process.exit(0); }

  console.log(`\n=== STEP 2: Fetch match page → ${target.home_team} vs ${target.away_team} ===`);
  const matchUrl = `${BASE_URL}/truc-tiep/${target.slug}`;
  console.log(`  URL: ${matchUrl}`);
  await sleep(600);
  const { body: matchHtml } = await get(matchUrl, REFERER).catch((e) => {
    console.error('Match page fetch failed:', e.message); process.exit(1);
  });
  console.log(`  Match page size: ${matchHtml.length} bytes`);

  const { streamUrls, raw } = parseMatchPage(matchHtml);
  console.log(`\n  list_stream raw: ${raw ? raw.slice(0, 200) : '(not found)'}`);
  console.log(`  Channel proxy URLs (${streamUrls.length}):`);
  streamUrls.forEach((u, i) => console.log(`    [${i}] ${u}`));

  if (streamUrls.length === 0) {
    console.log('\n  [!] No stream URLs found — saving match page for inspection.');
    require('fs').writeFileSync('/tmp/xoilac-matchpage.html', matchHtml);
    console.log('  Saved to /tmp/xoilac-matchpage.html');
    process.exit(0);
  }

  console.log('\n=== STEP 3: Fetch CDN URL from each channel proxy ===');
  const results = [];
  for (let i = 0; i < Math.min(streamUrls.length, 5); i++) {
    const proxyUrl = streamUrls[i];
    console.log(`\n  [${i}] Proxy: ${proxyUrl}`);
    await sleep(400);
    try {
      const cdnUrl = await fetchStreamUrl(proxyUrl);
      if (cdnUrl) {
        console.log(`  CDN URL: ${cdnUrl}`);
        console.log('  Checking reachability…');
        const { ok, status: s } = await checkStream(cdnUrl);
        console.log(`  Reachable: ${ok} (HTTP ${s})`);
        results.push({ proxyUrl, cdnUrl, ok });
      } else {
        results.push({ proxyUrl, cdnUrl: null, ok: false });
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
      results.push({ proxyUrl, cdnUrl: null, ok: false, error: e.message });
    }
  }

  console.log('\n=== SUMMARY ===');
  results.forEach((r, i) => {
    const label = r.ok ? '✓' : '✗';
    console.log(`  [${i}] ${label} ${r.cdnUrl ? r.cdnUrl.slice(0, 90) : 'NO URL'}`);
  });
  const working = results.filter((r) => r.ok);
  console.log(`\n  Working streams: ${working.length} / ${results.length}`);
})().catch((e) => { console.error('\nFatal:', e.message); process.exit(1); });
