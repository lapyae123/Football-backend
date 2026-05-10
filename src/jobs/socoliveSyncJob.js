const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const { run } = require('../scrapers/socolive');

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is required');

const redisOptions = { maxRetriesPerRequest: null };
if (redisUrl.startsWith('rediss://') || process.env.REDIS_TLS === 'true') {
  redisOptions.tls = { rejectUnauthorized: false };
}

const connection   = new IORedis(redisUrl, redisOptions);
const QUEUE_NAME   = 'socolive-sync';
const INTERVAL_MS  = parseInt(process.env.SOCO_SYNC_INTERVAL_MS, 10) || 5 * 60 * 1000;

const queue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
    attempts: 1
  }
});

new Worker(
  QUEUE_NAME,
  async (job) => {
    console.log(`[socoliveSyncJob] Running job ${job.id}`);
    await run();
  },
  { connection }
);

// Run immediately on startup, then repeat on interval
const start = async () => {
  try {
    await run();
  } catch (err) {
    console.error('[socoliveSyncJob] Initial run failed:', err.message);
  }

  setInterval(async () => {
    try {
      await queue.add('soco-sync', {}, { removeOnComplete: true });
    } catch (err) {
      console.error('[socoliveSyncJob] Failed to enqueue job:', err.message);
    }
  }, INTERVAL_MS);
};

start();

module.exports = queue;
