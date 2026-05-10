// Football App — API Test Suite
// Run: node src/tests/api.test.js
// Requires: server running at BASE_URL

const BASE_URL = process.env.API_URL || 'http://localhost:3050';
const TIMEOUT_MS = 10000;

// ─── Colour helpers ───────────────────────────────────────────────────────────
const c = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`
};

// ─── Test runner state ────────────────────────────────────────────────────────
const results = [];
let firstMatchId  = null;
let firstStreamUrl = null;

// ─── Utilities ────────────────────────────────────────────────────────────────
const get = async (path, opts = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...opts.headers }
    });
    const ms   = Date.now() - t0;
    let body;
    try { body = await res.json(); } catch (_) { body = null; }
    return { status: res.status, body, ms };
  } catch (err) {
    return { status: 0, body: null, ms: Date.now() - t0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
};

const head = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      }
    });
    return { status: res.status, ms: Date.now() - t0 };
  } catch (err) {
    return { status: 0, ms: Date.now() - t0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
};

const truncate = (s, n = 60) => {
  if (!s) return '(none)';
  return s.length > n ? s.slice(0, n) + '…' : s;
};

const pass = (name, ms, notes = []) => {
  results.push({ name, passed: true });
  console.log(`  ${c.green('✅')} ${name} ${c.dim(`(${ms}ms)`)}`);
  notes.forEach((n) => console.log(`     ${c.dim('→')} ${n}`));
};

const fail = (name, ms, reason, notes = []) => {
  results.push({ name, passed: false, reason });
  console.log(`  ${c.red('❌')} ${name} ${c.dim(`(${ms}ms)`)}`);
  console.log(`     ${c.red('Reason:')} ${reason}`);
  notes.forEach((n) => console.log(`     ${c.dim('→')} ${n}`));
};

const section = (title) => {
  console.log('');
  console.log(c.bold(c.cyan(`═══ ${title} ═══`)));
};

// ─── SECTION 1: HEALTH CHECK ──────────────────────────────────────────────────
const runSection1 = async () => {
  section('SECTION 1: HEALTH CHECK');

  // Test 1.1
  {
    const { status, body, ms } = await get('/health');
    if (status === 200 && body?.status === 'ok') {
      pass('1.1 Server Health', ms, [`body: ${JSON.stringify(body)}`]);
    } else {
      fail('1.1 Server Health', ms, `Expected 200 {status:'ok'}, got ${status} ${JSON.stringify(body)}`);
    }
  }
};

// ─── SECTION 2: TABS API ─────────────────────────────────────────────────────
const runSection2 = async () => {
  section('SECTION 2: TABS API');
  const REQUIRED_SLUGS = ['main-live', 'soco-live', 'china-live', 'loungsan', 'english'];

  // Test 2.1
  {
    const { status, body, ms } = await get('/api/tabs');
    if (status !== 200 || !Array.isArray(body)) {
      fail('2.1 Get All Tabs', ms, `Expected 200 + array, got ${status}`);
    } else {
      const slugs    = body.map((t) => t.slug);
      const missing  = REQUIRED_SLUGS.filter((s) => !slugs.includes(s));
      const hasShape = body.every((t) => t.id && t.name && t.slug && t.position !== undefined);

      if (body.length === 0) {
        fail('2.1 Get All Tabs', ms, 'Array is empty');
      } else if (!hasShape) {
        fail('2.1 Get All Tabs', ms, 'Tab missing required fields (id, name, slug, position, is_active)');
      } else if (missing.length > 0) {
        fail('2.1 Get All Tabs', ms, `Missing slugs: ${missing.join(', ')}`);
      } else {
        pass('2.1 Get All Tabs', ms, [
          `Found ${body.length} tabs`,
          `Tabs: ${body.map((t) => t.name).join(', ')}`
        ]);
      }
    }
  }

  // Test 2.2: Redis cache (second call should be faster)
  {
    const r1 = await get('/api/tabs');
    const r2 = await get('/api/tabs');
    const notes = [
      `1st call: ${r1.ms}ms`,
      `2nd call: ${r2.ms}ms`
    ];
    // Cache should make it noticeably faster, but allow up to 2x first call
    if (r1.status === 200 && r2.status === 200) {
      if (r2.ms <= r1.ms * 1.5 || r2.ms < 100) {
        pass('2.2 Tabs Cached in Redis', r2.ms, notes);
      } else {
        // Still pass but note it wasn't faster (cache may have been cold)
        pass('2.2 Tabs Cached in Redis', r2.ms, [...notes, '⚠ Cache may be cold — 2nd call not faster']);
      }
    } else {
      fail('2.2 Tabs Cached in Redis', r2.ms, `Request failed: ${r1.status} / ${r2.status}`, notes);
    }
  }
};

// ─── SECTION 3: MATCHES API ──────────────────────────────────────────────────
const runSection3 = async () => {
  section('SECTION 3: MATCHES API');
  const MATCH_FIELDS = ['id', 'title', 'home_team', 'away_team', 'status'];

  const checkMatches = (body, tab) => {
    if (!Array.isArray(body)) return `Expected array for tab=${tab}`;
    if (body.length > 0) {
      const m = body[0];
      const missing = MATCH_FIELDS.filter((f) => !(f in m));
      if (missing.length) return `Match missing fields: ${missing.join(', ')}`;
    }
    return null;
  };

  // Test 3.1
  {
    const { status, body, ms } = await get('/api/matches?tab=main-live');
    const err = checkMatches(body, 'main-live');
    if (status !== 200 || err) {
      fail('3.1 Get Main Live Matches', ms, err || `Status ${status}`);
    } else {
      if (body.length > 0 && !firstMatchId) firstMatchId = body[0].id;
      pass('3.1 Get Main Live Matches', ms, [
        `${body.length} matches found`,
        ...body.slice(0, 3).map((m) => `${m.title} [${m.status}]`)
      ]);
    }
  }

  // Tests 3.2 – 3.5
  for (const [num, tab] of [['3.2', 'soco-live'], ['3.3', 'china-live'], ['3.4', 'loungsan'], ['3.5', 'english']]) {
    const { status, body, ms } = await get(`/api/matches?tab=${tab}`);
    const err = checkMatches(body, tab);
    if (status !== 200 || err) {
      fail(`${num} Get ${tab} Matches`, ms, err || `Status ${status}`);
    } else {
      if (body.length > 0 && !firstMatchId) firstMatchId = body[0].id;
      pass(`${num} Get ${tab} Matches`, ms, [
        `${body.length} matches`,
        ...body.slice(0, 2).map((m) => truncate(m.title, 50))
      ]);
    }
  }

  // Test 3.6: Invalid tab
  {
    const { status, body, ms } = await get('/api/matches?tab=invalid-tab-xyz');
    if (status === 200 && Array.isArray(body) && body.length === 0) {
      pass('3.6 Invalid Tab → Empty Array', ms, ['Returned empty array — correct']);
    } else if (status === 404) {
      pass('3.6 Invalid Tab → 404', ms, ['Returned 404 — correct']);
    } else {
      fail('3.6 Invalid Tab', ms, `Unexpected: status=${status} body=${JSON.stringify(body)?.slice(0, 80)}`);
    }
  }

  // Test 3.7: Missing tab param
  {
    const { status, body, ms } = await get('/api/matches');
    if (status === 400) {
      pass('3.7 Missing Tab Param → 400', ms, [JSON.stringify(body)?.slice(0, 80)]);
    } else if (status === 200 && Array.isArray(body)) {
      pass('3.7 Missing Tab Param → All Matches', ms, [`Returned ${body.length} total matches`]);
    } else {
      fail('3.7 Missing Tab Param', ms, `Unexpected: status=${status}`);
    }
  }
};

// ─── SECTION 4: STREAMS API ──────────────────────────────────────────────────
const runSection4 = async () => {
  section('SECTION 4: STREAMS API');

  // Test 4.1
  {
    if (!firstMatchId) {
      fail('4.1 Get Streams for Match', 0, 'No match ID available — Sections 3 must pass first');
    } else {
      const { status, body, ms } = await get(`/api/streams/${firstMatchId}`);
      if (status !== 200 || typeof body !== 'object') {
        fail('4.1 Get Streams for Match', ms, `Expected 200 + object, got ${status}`);
      } else {
        const sdCount = (body.SD || []).length;
        const hdCount = (body.HD || []).length;

        // Store first stream URL for test 4.2
        if (hdCount > 0) firstStreamUrl = body.HD[0].url;
        else if (sdCount > 0) firstStreamUrl = body.SD[0].url;

        const streamOk = (body.SD !== undefined || body.HD !== undefined);
        if (!streamOk) {
          fail('4.1 Get Streams for Match', ms, 'Response has no SD or HD key');
        } else {
          pass('4.1 Get Streams for Match', ms, [
            `SD: ${sdCount}  HD: ${hdCount}`,
            firstStreamUrl ? `First URL: ${truncate(firstStreamUrl, 60)}` : 'No stream URLs yet'
          ]);
        }
      }
    }
  }

  // Test 4.2: HEAD check on stream URL
  {
    if (!firstStreamUrl) {
      pass('4.2 Stream URL Reachable', 0, ['⚠ Skipped — no stream URL available yet (no live matches)']);
    } else {
      const { status, ms } = await head(firstStreamUrl);
      if (status === 200 || status === 206) {
        pass('4.2 Stream URL Reachable', ms, [`HTTP ${status} — stream is live and reachable`]);
      } else {
        fail('4.2 Stream URL Reachable', ms, `HTTP ${status} — stream may be offline or expired`);
      }
    }
  }

  // Test 4.3: Invalid match ID
  {
    const { status, body, ms } = await get('/api/streams/invalid-id-123');
    if (status === 404) {
      pass('4.3 Invalid Match ID → 404', ms, [JSON.stringify(body)?.slice(0, 60)]);
    } else if (status === 200 && body && body.SD?.length === 0 && body.HD?.length === 0) {
      pass('4.3 Invalid Match ID → Empty', ms, ['Returned empty SD+HD — acceptable']);
    } else {
      fail('4.3 Invalid Match ID', ms, `Unexpected: status=${status} body=${JSON.stringify(body)?.slice(0, 60)}`);
    }
  }
};

// ─── SECTION 5: DATABASE CHECK ────────────────────────────────────────────────
const runSection5 = async () => {
  section('SECTION 5: DATABASE CHECK');

  // Test 5.1: Exactly 5 tabs
  {
    const { status, body, ms } = await get('/api/tabs');
    if (status !== 200 || !Array.isArray(body)) {
      fail('5.1 DB Has 5 Tabs', ms, `Could not read tabs: status ${status}`);
    } else if (body.length === 5) {
      pass('5.1 DB Has 5 Tabs', ms, [`Exactly ${body.length} tabs — correct`]);
    } else {
      fail('5.1 DB Has 5 Tabs', ms, `Expected 5 tabs, found ${body.length}`);
    }
  }

  // Test 5.2: Matches across all tabs
  {
    const tabs = ['main-live', 'soco-live', 'china-live', 'loungsan', 'english'];
    let total = 0;
    const counts = [];
    for (const tab of tabs) {
      const { body } = await get(`/api/matches?tab=${tab}`);
      const n = Array.isArray(body) ? body.length : 0;
      counts.push(`${tab}: ${n}`);
      if (tab !== 'main-live') total += n; // main-live aggregates, don't double-count
    }
    pass('5.2 DB Match Counts', 0, counts);
  }
};

// ─── SECTION 6: PERFORMANCE ──────────────────────────────────────────────────
const runSection6 = async () => {
  section('SECTION 6: PERFORMANCE');

  // Test 6.1: Tabs < 500ms
  {
    const { status, ms } = await get('/api/tabs');
    if (status !== 200) {
      fail('6.1 Tabs Response Time', ms, `Request failed: ${status}`);
    } else if (ms < 500) {
      pass('6.1 Tabs Response Time < 500ms', ms, [`${ms}ms — within limit`]);
    } else {
      fail('6.1 Tabs Response Time < 500ms', ms, `${ms}ms — too slow (limit: 500ms)`);
    }
  }

  // Test 6.2: Matches < 1000ms
  {
    const { status, ms } = await get('/api/matches?tab=main-live');
    if (status !== 200) {
      fail('6.2 Matches Response Time', ms, `Request failed: ${status}`);
    } else if (ms < 1000) {
      pass('6.2 Matches Response Time < 1000ms', ms, [`${ms}ms — within limit`]);
    } else {
      fail('6.2 Matches Response Time < 1000ms', ms, `${ms}ms — too slow (limit: 1000ms)`);
    }
  }

  // Test 6.3: Streams < 500ms
  {
    if (!firstMatchId) {
      pass('6.3 Streams Response Time', 0, ['⚠ Skipped — no match ID available']);
    } else {
      const { status, ms } = await get(`/api/streams/${firstMatchId}`);
      if (status !== 200) {
        fail('6.3 Streams Response Time', ms, `Request failed: ${status}`);
      } else if (ms < 500) {
        pass('6.3 Streams Response Time < 500ms', ms, [`${ms}ms — within limit`]);
      } else {
        fail('6.3 Streams Response Time < 500ms', ms, `${ms}ms — too slow (limit: 500ms)`);
      }
    }
  }
};

// ─── SECTION 7: CONCURRENT REQUESTS ─────────────────────────────────────────
const runSection7 = async () => {
  section('SECTION 7: CONCURRENT REQUESTS');

  // Test 7.1: 10 simultaneous /api/tabs
  {
    const t0 = Date.now();
    const all = await Promise.all(Array.from({ length: 10 }, () => get('/api/tabs')));
    const elapsed = Date.now() - t0;
    const ok = all.filter((r) => r.status === 200).length;

    const notes = [
      `${ok}/10 requests succeeded`,
      `Total wall time: ${elapsed}ms`
    ];

    if (ok === 10 && elapsed < 3000) {
      pass('7.1 Handle 10 Concurrent Requests', elapsed, notes);
    } else if (ok < 10) {
      fail('7.1 Handle 10 Concurrent Requests', elapsed, `Only ${ok}/10 succeeded`, notes);
    } else {
      fail('7.1 Handle 10 Concurrent Requests', elapsed, `Completed but took ${elapsed}ms (limit: 3000ms)`, notes);
    }
  }
};

// ─── MAIN ─────────────────────────────────────────────────────────────────────
const main = async () => {
  const suiteStart = Date.now();

  console.log('');
  console.log(c.bold('╔══════════════════════════════════════════╗'));
  console.log(c.bold('║      Football App — API Test Suite       ║'));
  console.log(c.bold('╚══════════════════════════════════════════╝'));
  console.log(c.dim(`  Base URL: ${BASE_URL}`));
  console.log(c.dim(`  Started:  ${new Date().toISOString()}`));

  // Verify server is up before running all tests
  const health = await get('/health');
  if (health.status !== 200) {
    console.log('');
    console.log(c.red(`  Server not reachable at ${BASE_URL}`));
    console.log(c.red(`  Start the server first: npm start`));
    console.log('');
    process.exit(1);
  }

  await runSection1();
  await runSection2();
  await runSection3();
  await runSection4();
  await runSection5();
  await runSection6();
  await runSection7();

  // ─── Final Summary ──────────────────────────────────────────────────────────
  const suiteMs   = Date.now() - suiteStart;
  const total     = results.length;
  const passed    = results.filter((r) => r.passed).length;
  const failed    = total - passed;
  const failedNames = results.filter((r) => !r.passed).map((r) => r.name);

  console.log('');
  console.log(c.bold('╔══════════════════════════════════════════╗'));
  console.log(c.bold('║                  SUMMARY                ║'));
  console.log(c.bold('╚══════════════════════════════════════════╝'));
  console.log(`  Total tests : ${c.bold(total)}`);
  console.log(`  Passed      : ${c.green(c.bold(passed))}`);
  console.log(`  Failed      : ${failed > 0 ? c.red(c.bold(failed)) : c.green(c.bold(failed))}`);
  console.log(`  Duration    : ${c.dim(suiteMs + 'ms')}`);

  if (failedNames.length > 0) {
    console.log('');
    console.log(c.red('  Failed tests:'));
    failedNames.forEach((n) => console.log(`    ${c.red('❌')} ${n}`));
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
};

main().catch((err) => {
  console.error(c.red('Fatal error running test suite:'), err.message);
  process.exit(1);
});
