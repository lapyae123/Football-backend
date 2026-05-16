// In-memory drop-in replacement for ioredis.
// Same API surface: get, set (with EX), del, keys.
// Used automatically when REDIS_URL is not set.

const store  = new Map(); // key → { value, expiresAt }
const timers = new Map(); // key → timeout handle

const _del = (key) => {
  store.delete(key);
  if (timers.has(key)) { clearTimeout(timers.get(key)); timers.delete(key); }
};

const _globToRegex = (pattern) =>
  new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

const memcache = {
  get: (key) => {
    const entry = store.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt && Date.now() > entry.expiresAt) { _del(key); return Promise.resolve(null); }
    return Promise.resolve(entry.value);
  },

  set: (key, value, exFlag, ttlSeconds) => {
    _del(key);
    const expiresAt = (exFlag === 'EX' && ttlSeconds) ? Date.now() + ttlSeconds * 1000 : null;
    store.set(key, { value: String(value), expiresAt });
    if (expiresAt) {
      const t = setTimeout(() => _del(key), ttlSeconds * 1000);
      if (t.unref) t.unref();
      timers.set(key, t);
    }
    return Promise.resolve('OK');
  },

  del: (...args) => {
    const keys = args.flat();
    let count = 0;
    for (const key of keys) { if (store.has(key)) { _del(key); count++; } }
    return Promise.resolve(count);
  },

  keys: (pattern) => {
    const re = _globToRegex(pattern);
    return Promise.resolve([...store.keys()].filter((k) => re.test(k)));
  },

  on: () => {},
};

module.exports = memcache;
