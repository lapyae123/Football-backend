require('dotenv').config();
require('./config/scraperLog'); // intercept console before any scraper runs

const path    = require('path');
const fastify = require('fastify')({ logger: true });

fastify.register(require('@fastify/env'), {
  dotenv: false,
  schema: {
    type: 'object',
    required: ['DATABASE_URL', 'PORT', 'NODE_ENV'],
    properties: {
      DATABASE_URL: { type: 'string' },
      REDIS_URL:    { type: 'string', default: '' },
      PORT:         { type: 'number', default: 3050 },
      NODE_ENV:     { type: 'string', default: 'development' },
      ADMIN_API_KEY:{ type: 'string', default: '' }
    }
  }
});

// Allow all origins (public API) — admin panel on Vercel calls /api/admin/* cross-origin
fastify.register(require('@fastify/cors'), {
  origin: true,
  credentials: true,
});

// Rate limiting — 200 req/min globally; login endpoint gets its own tighter limit
fastify.register(require('@fastify/rate-limit'), {
  max: 200,
  timeWindow: '1 minute',
  skipOnError: true,
});

// Serve admin HTML at /admin
fastify.register(require('@fastify/static'), {
  root:   path.join(__dirname, 'public'),
  prefix: '/admin/',
  decorateReply: false,
});
fastify.get('/admin', (req, reply) => reply.sendFile('admin.html', path.join(__dirname, 'public')));

fastify.register(require('./routes/config'));
fastify.register(require('./routes/tabs'));
fastify.register(require('./routes/matches'));
fastify.register(require('./routes/streams'));
fastify.register(require('./routes/admin'));
fastify.register(require('./routes/english'));
fastify.register(require('./routes/servers'));
fastify.register(require('./routes/proxy'));
fastify.register(require('./routes/tv'));

require('./jobs/syncMatches');
require('./jobs/socoliveSyncJob');
require('./jobs/socoliveApiSyncJob');
require('./jobs/chinaliveSyncJob');
require('./jobs/xoilacSyncJob');
// myanmarTvSyncJob disabled — streams are geo-restricted; URLs must be entered manually via Admin → TV & Radio
require('./jobs/urlHealthJob');
require('./jobs/finishedMatchCleanupJob');

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  reply.status(error.statusCode || 500).send({ error: 'Internal Server Error' });
});

const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3050, host: '0.0.0.0' });
    fastify.log.info(`Server listening on ${fastify.server.address().port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();