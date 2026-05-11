// Football App — API Test Suite
// CLI:    node src/tests/api.test.js
// Module: const { runTests } = require('./api.test'); await runTests(baseUrl)

const TIMEOUT_MS = 10000;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const request = async (method, url, opts = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: opts.body,
    });
    const ms = Date.now() - t0;
    let body;
    try { body = await res.json(); } catch (_) { body = null; }
    return { status: res.status, body, ms };
  } catch (err) {
    return { status: 0, body: null, ms: Date.now() - t0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
};

const get  = (base, path, opts = {}) => request('GET',  `${base}${path}`, opts);
const post = (base, path, opts = {}) => request('POST', `${base}${path}`, opts);

const head = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'HEAD', signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36' },
    });
    return { status: res.status, ms: Date.now() - t0 };
  } catch (err) {
    return { status: 0, ms: Date.now() - t0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
};

const trunc = (s, n = 60) => (!s ? '(none)' : s.length > n ? s.slice(0, n) + '…' : s);

// ─── Test engine ──────────────────────────────────────────────────────────────

const makeRunner = () => {
  const sections = [];
  let current = null;
  let _matchId = null;
  let _streamUrl = null;

  return {
    sections,
    getMatchId:    () => _matchId,
    getStreamUrl:  () => _streamUrl,
    setMatchId:    (id) => { if (!_matchId) _matchId = id; },
    setStreamUrl:  (u)  => { if (!_streamUrl) _streamUrl = u; },
    section: (name) => { current = { name, tests: [] }; sections.push(current); },
    test: (name, passed, ms, notes = [], reason = '') => {
      current.tests.push({ name, passed, ms, notes: notes.filter(Boolean), reason });
    },
  };
};

// ─── Sections ─────────────────────────────────────────────────────────────────

const s1_health = async (BASE, R) => {
  R.section('Health Check');
  const { status, body, ms } = await get(BASE, '/health');
  R.test('Server health', status === 200 && body?.status === 'ok', ms,
    [`body: ${JSON.stringify(body)}`],
    status !== 200 ? `Expected 200, got ${status}` : '');
};

const s2_config = async (BASE, R) => {
  R.section('Config API (/api/config)');
  const { status, body, ms } = await get(BASE, '/api/config');
  if (status !== 200 || !body?.tabs)
    return R.test('GET /api/config', false, ms, [], `Status ${status}`);

  R.test('GET /api/config shape', true, ms, [
    `${body.tabs.length} tabs returned`,
    `features: ${Object.keys(body.features || {}).join(', ')}`,
    `ui.defaultTab: ${body.ui?.defaultTab}`,
  ]);

  const missing = (body.tabs || []).filter((t) => !t.icon || !t.color).map((t) => t.slug);
  R.test('All tabs have icon + color', missing.length === 0, ms,
    [missing.length ? `Missing: ${missing.join(', ')}` : 'All tabs have icon + color ✓'],
    missing.length ? `Tabs missing metadata: ${missing.join(', ')}` : '');
};

const s3_tabs = async (BASE, R) => {
  R.section('Tabs API (/api/tabs)');
  const REQUIRED = ['main-live', 'soco-live', 'china-live', 'loungsan', 'english'];

  const r1 = await get(BASE, '/api/tabs');
  if (r1.status !== 200 || !Array.isArray(r1.body))
    return R.test('GET /api/tabs', false, r1.ms, [], `Status ${r1.status}`);

  const slugs   = r1.body.map((t) => t.slug);
  const missing = REQUIRED.filter((s) => !slugs.includes(s));
  const hasNewFields = r1.body.every((t) => 'icon' in t && 'color' in t);

  R.test('GET /api/tabs — required slugs + new fields', !missing.length && hasNewFields, r1.ms,
    [`tabs: ${slugs.join(', ')}`, hasNewFields ? 'icon + color fields present ✓' : '⚠ missing icon/color'],
    missing.length ? `Missing slugs: ${missing.join(', ')}` : '');

  const r2 = await get(BASE, '/api/tabs');
  R.test('Redis cache warmth', r2.status === 200, r2.ms,
    [`1st ${r1.ms}ms → 2nd ${r2.ms}ms`, r2.ms < r1.ms ? 'cache hit ✓' : 'already warm']);
};

const s4_matches = async (BASE, R) => {
  R.section('Matches API (/api/matches)');
  const CANONICAL = ['id', 'title', 'home_team', 'away_team', 'status', 'source_tab', 'league'];

  for (const tab of ['main-live', 'soco-live', 'china-live', 'loungsan', 'english']) {
    const { status, body, ms } = await get(BASE, `/api/matches?tab=${tab}`);
    if (status !== 200 || !Array.isArray(body)) {
      R.test(`?tab=${tab}`, false, ms, [], `Status ${status}`); continue;
    }
    if (body.length) R.setMatchId(body[0].id);
    const missingFields = body.length ? CANONICAL.filter((f) => !(f in body[0])) : [];
    R.test(`?tab=${tab}`, !missingFields.length, ms,
      [`${body.length} matches`, ...body.slice(0, 2).map((m) => trunc(m.title, 50))],
      missingFields.length ? `Missing canonical fields: ${missingFields.join(', ')}` : '');
  }

  const inv = await get(BASE, '/api/matches?tab=does-not-exist');
  R.test('Invalid tab → empty array', inv.status === 200 && Array.isArray(inv.body) && !inv.body.length,
    inv.ms, [], inv.status !== 200 ? `Status ${inv.status}` : '');
};

const s5_streams = async (BASE, R) => {
  R.section('Streams API (/api/streams)');
  const matchId = R.getMatchId();

  if (!matchId)
    return R.test('GET /api/streams/:id', false, 0, [], 'No match ID — Matches section must pass first');

  const { status, body, ms } = await get(BASE, `/api/streams/${matchId}`);
  if (status !== 200) return R.test('GET /api/streams/:id', false, ms, [], `Status ${status}`);

  const sd = (body.SD || []).length;
  const hd = (body.HD || []).length;
  if (hd)      R.setStreamUrl(body.HD[0].url);
  else if (sd) R.setStreamUrl(body.SD[0].url);

  R.test('GET /api/streams/:id — shape', 'SD' in body && 'HD' in body, ms,
    [`SD: ${sd}  HD: ${hd}`, R.getStreamUrl() ? trunc(R.getStreamUrl()) : 'no stream URLs yet']);

  const streamUrl = R.getStreamUrl();
  if (!streamUrl) {
    R.test('Stream URL reachable (HEAD)', true, 0, ['⚠ skipped — no live streams right now']);
  } else {
    const h = await head(streamUrl);
    R.test('Stream URL reachable (HEAD)', h.status === 200 || h.status === 206, h.ms,
      [`HTTP ${h.status || 'timeout'}`],
      h.status !== 200 && h.status !== 206 ? `HTTP ${h.status} — stream offline or expired` : '');
  }

  const bad = await get(BASE, '/api/streams/00000000-0000-0000-0000-000000000000');
  R.test('Unknown UUID → empty SD+HD', bad.status === 200 && 'SD' in (bad.body || {}), bad.ms);
};

const s6_admin = async (BASE, R) => {
  R.section('Admin Auth + API');

  const good = await post(BASE, '/api/admin/login',
    { body: JSON.stringify({ username: 'admin', password: '12345' }) });
  const hasToken = good.status === 200 && typeof good.body?.token === 'string';
  R.test('Login with valid credentials → JWT', hasToken, good.ms,
    [hasToken ? 'token received ✓' : JSON.stringify(good.body)]);

  const badLogin = await post(BASE, '/api/admin/login',
    { body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
  R.test('Login with wrong password → 401', badLogin.status === 401, badLogin.ms);

  const unauth = await get(BASE, '/api/admin/stats');
  R.test('No token → 401', unauth.status === 401, unauth.ms);

  if (!hasToken) return;
  const auth = { headers: { Authorization: `Bearer ${good.body.token}` } };

  const stats = await get(BASE, '/api/admin/stats', auth);
  R.test('GET /api/admin/stats (authed)', stats.status === 200 && !!stats.body?.matches, stats.ms,
    stats.body?.matches ? [`live:${stats.body.matches.live}  scheduled:${stats.body.matches.scheduled}  total:${stats.body.matches.total}`] : []);

  const sources = await get(BASE, '/api/admin/sources', auth);
  R.test('GET /api/admin/sources', sources.status === 200 && Array.isArray(sources.body), sources.ms,
    [`${sources.body?.length ?? 0} source(s)`,
     ...(sources.body || []).map((s) => `${s.slug} — ${s.config?.base_urls?.[0] || s.config?.api_base || s.base_domain}`)]);
};

const s7_perf = async (BASE, R) => {
  R.section('Performance');
  for (const [path, limitMs, label] of [
    ['/health',                    100,  'Health'],
    ['/api/tabs',                  500,  'Tabs'],
    ['/api/config',                1500, 'Config'],
    ['/api/matches?tab=main-live', 2000, 'Matches (main-live)'],
  ]) {
    const { status, ms } = await get(BASE, path);
    R.test(`${label} < ${limitMs}ms`, status === 200 && ms < limitMs, ms,
      [`${ms}ms  (limit ${limitMs}ms)`],
      status !== 200 ? `Status ${status}` : ms >= limitMs ? `${ms}ms exceeds ${limitMs}ms limit` : '');
  }
};

const s8_concurrency = async (BASE, R) => {
  R.section('Concurrency');
  const t0  = Date.now();
  const all = await Promise.all(Array.from({ length: 10 }, () => get(BASE, '/api/tabs')));
  const elapsed = Date.now() - t0;
  const ok = all.filter((r) => r.status === 200).length;
  R.test('10 concurrent GET /api/tabs', ok === 10 && elapsed < 3000, elapsed,
    [`${ok}/10 succeeded`, `wall time: ${elapsed}ms`],
    ok < 10 ? `Only ${ok}/10 succeeded` : elapsed >= 3000 ? `Wall time ${elapsed}ms > 3000ms` : '');
};

// ─── Main exported function ───────────────────────────────────────────────────

const runTests = async (baseUrl = 'http://localhost:3050') => {
  const BASE = baseUrl.replace(/\/$/, '');
  const R    = makeRunner();
  const t0   = Date.now();

  const health = await get(BASE, '/health');
  if (health.status !== 200) {
    return { ok: false, error: `Server not reachable at ${BASE}`,
             total: 0, passed: 0, failed: 0, durationMs: Date.now() - t0, sections: [] };
  }

  await s1_health(BASE, R);
  await s2_config(BASE, R);
  await s3_tabs(BASE, R);
  await s4_matches(BASE, R);
  await s5_streams(BASE, R);
  await s6_admin(BASE, R);
  await s7_perf(BASE, R);
  await s8_concurrency(BASE, R);

  const all    = R.sections.flatMap((s) => s.tests);
  const passed = all.filter((t) => t.passed).length;

  return { ok: passed === all.length, total: all.length, passed,
           failed: all.length - passed, durationMs: Date.now() - t0, sections: R.sections };
};

module.exports = { runTests };

// ─── CLI entry ────────────────────────────────────────────────────────────────

if (require.main === module) {
  const BASE_URL = process.env.API_URL || 'http://localhost:3050';
  const c = {
    green: (s) => `\x1b[32m${s}\x1b[0m`, red:  (s) => `\x1b[31m${s}\x1b[0m`,
    cyan:  (s) => `\x1b[36m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
    dim:   (s) => `\x1b[2m${s}\x1b[0m`,
  };

  runTests(BASE_URL).then((result) => {
    if (result.error) { console.error(c.red(result.error)); process.exit(1); }

    console.log('\n' + c.bold('╔══════════════════════════════════════════╗'));
    console.log(c.bold('║      Football App — API Test Suite       ║'));
    console.log(c.bold('╚══════════════════════════════════════════╝'));
    console.log(c.dim(`  Base: ${BASE_URL}\n`));

    for (const section of result.sections) {
      console.log(c.bold(c.cyan(`\n═══ ${section.name} ═══`)));
      for (const t of section.tests) {
        console.log(`  ${t.passed ? c.green('✅') : c.red('❌')} ${t.name} ${c.dim(`(${t.ms}ms)`)}`);
        if (!t.passed && t.reason) console.log(`     ${c.red('→')} ${t.reason}`);
        t.notes.forEach((n) => console.log(`     ${c.dim('→')} ${n}`));
      }
    }

    console.log('\n' + c.bold('╔══════════════════════════════════════════╗'));
    console.log(c.bold('║                  SUMMARY                ║'));
    console.log(c.bold('╚══════════════════════════════════════════╝'));
    console.log(`  Total   : ${c.bold(result.total)}`);
    console.log(`  Passed  : ${c.green(c.bold(result.passed))}`);
    console.log(`  Failed  : ${result.failed > 0 ? c.red(c.bold(result.failed)) : c.green(c.bold(0))}`);
    console.log(c.dim(`  Duration: ${result.durationMs}ms\n`));

    const failed = result.sections.flatMap((s) => s.tests).filter((t) => !t.passed);
    if (failed.length) {
      console.log(c.red('  Failed:'));
      failed.forEach((t) => console.log(`    ${c.red('❌')} ${t.name}: ${t.reason}`));
      console.log('');
    }
    process.exit(result.failed > 0 ? 1 : 0);
  }).catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
}
