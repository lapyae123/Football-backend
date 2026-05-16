// Global console interceptor — captures scraper logs into per-slug ring buffers.
// No changes needed in scrapers or jobs: they just use console.log as usual.
// Intercepts lines prefixed with [slugName] or [slugNameSyncJob].

const MAX_LINES = 500;
const buf = {}; // slug → [{ ts, level, msg }]

const SLUG_NORMALIZE = {
  socolivesynccjob: 'socolive', socolivesynccJob: 'socolive', socoliveSyncJob: 'socolive',
  chinalivesynccjob: 'chinalive', chinaliveSyncJob: 'chinalive',
  xoilacsynccjob: 'xoilac', xoilacSyncJob: 'xoilac',
  myanmartvsynccjob: 'myanmartv', myanmarTvSyncJob: 'myanmartv',
  urlhealthjob: 'health', urlHealthJob: 'health',
  syncmatches: 'sync', syncMatches: 'sync',
};

const slugFrom = (raw) => {
  if (!raw) return null;
  return SLUG_NORMALIZE[raw] || SLUG_NORMALIZE[raw.toLowerCase()] || raw.toLowerCase().replace(/syncjob$/, '');
};

const push = (slug, level, msg) => {
  if (!buf[slug]) buf[slug] = [];
  buf[slug].push({ ts: Date.now(), level, msg });
  if (buf[slug].length > MAX_LINES) buf[slug].shift();
};

const PREFIX_RE = /^\[([^\]]+)\]\s*/;

const intercept = (level, origFn) => (...args) => {
  origFn(...args);
  const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const m   = msg.match(PREFIX_RE);
  if (m) push(slugFrom(m[1]), level, msg);
};

console.log   = intercept('info',  console.log.bind(console));
console.info  = intercept('info',  console.info.bind(console));
console.warn  = intercept('warn',  console.warn.bind(console));
console.error = intercept('error', console.error.bind(console));

module.exports = {
  read:  (slug, since = 0) => (buf[slug] || []).filter((e) => e.ts > since),
  clear: (slug)            => { buf[slug] = []; },
  all:   ()                => buf,
};
