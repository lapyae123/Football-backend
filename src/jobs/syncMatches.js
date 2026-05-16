const redis = require('../config/redis');

const invalidateMatchCache = async () => {
  try {
    const keys = [
      ...(await redis.keys('tabs:all')),
      ...(await redis.keys('matches:*')),
      ...(await redis.keys('streams:*')),
      'config:all',
    ];
    if (keys.length > 0) await redis.del(...keys);
    console.log('syncMatches: cache invalidated');
  } catch (err) {
    console.warn('syncMatches: cache invalidation failed', err.message);
  }
};

// When Redis is available, use BullMQ queue so multiple workers stay in sync.
// Without Redis, just run on a plain interval — cache is in-memory anyway.
if (process.env.REDIS_URL) {
  const { Queue, Worker } = require('bullmq');
  const IORedis = require('ioredis');
  const opts = { maxRetriesPerRequest: null };
  if (process.env.REDIS_URL.startsWith('rediss://') || process.env.REDIS_TLS === 'true') {
    opts.tls = { rejectUnauthorized: false };
  }
  const conn  = new IORedis(process.env.REDIS_URL, opts);
  const queue = new Queue('syncMatches', { connection: conn, defaultJobOptions: { removeOnComplete: true, attempts: 3 } });
  new Worker('syncMatches', async (job) => {
    if (job.name === 'invalidate-cache') await invalidateMatchCache();
  }, { connection: conn });
  setInterval(() => queue.add('invalidate-cache', {}, { removeOnComplete: true }).catch(() => {}), 5 * 60 * 1000);
  module.exports = queue;
} else {
  invalidateMatchCache().catch(() => {});
  setInterval(() => invalidateMatchCache().catch(() => {}), 5 * 60 * 1000);
  module.exports = null;
}
