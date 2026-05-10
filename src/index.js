require('dotenv').config();
const fastify = require('fastify')({ logger: true });

fastify.register(require('@fastify/env'), {
  dotenv: false,
  schema: {
    type: 'object',
    required: ['DATABASE_URL', 'REDIS_URL', 'PORT', 'NODE_ENV'],
    properties: {
      DATABASE_URL: { type: 'string' },
      REDIS_URL: { type: 'string' },
      PORT: { type: 'number', default: 3050 },
      NODE_ENV: { type: 'string', default: 'development' },
      ADMIN_API_KEY: { type: 'string', default: '' }
    }
  }
});

fastify.register(require('@fastify/cors'), {
  origin: true
});

fastify.register(require('./routes/tabs'));
fastify.register(require('./routes/matches'));
fastify.register(require('./routes/streams'));
fastify.register(require('./routes/english'));
fastify.register(require('./routes/servers'));

require('./jobs/syncMatches');
require('./jobs/socoliveSyncJob');
require('./jobs/chinaliveSyncJob');
require('./jobs/urlHealthJob');

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