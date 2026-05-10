const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const redis = require('../config/redis');

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error('REDIS_URL is required for BullMQ');
}

const redisOptions = {
  maxRetriesPerRequest: null
};
if (process.env.REDIS_URL.startsWith('rediss://') || process.env.REDIS_TLS === 'true') {
  redisOptions.tls = { rejectUnauthorized: false };
}

const connection = new IORedis(redisUrl, redisOptions);
const queueName = 'syncMatches';

const queue = new Queue(queueName, {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }
  }
});

const invalidateMatchCache = async () => {
  try {
    const tabsKeys = await redis.keys('tabs:all');
    const matchKeys = await redis.keys('matches:*');
    const streamKeys = await redis.keys('streams:*');
    const allKeys = [...tabsKeys, ...matchKeys, ...streamKeys];
    if (allKeys.length > 0) {
      await redis.del(...allKeys);
    }
    console.log('syncMatches: cache invalidated');
  } catch (err) {
    console.warn('Failed to invalidate Redis cache', err);
  }
};

// Worker placeholder — scraper jobs (SOCO, China) will dispatch work here
new Worker(queueName, async (job) => {
  if (job.name === 'invalidate-cache') {
    await invalidateMatchCache();
  }
}, { connection });

const scheduleSync = async () => {
  await invalidateMatchCache();

  setInterval(async () => {
    try {
      await queue.add('invalidate-cache', {}, { removeOnComplete: true });
    } catch (err) {
      console.error('Failed to enqueue syncMatches job', err);
    }
  }, 5 * 60 * 1000);
};

scheduleSync().catch((err) => {
  console.error('Failed to start syncMatches scheduler', err);
});

module.exports = queue;
