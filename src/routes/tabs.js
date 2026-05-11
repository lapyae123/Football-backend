const db = require('../config/database');
const redis = require('../config/redis');

module.exports = async function (fastify, opts) {
  fastify.get('/api/tabs', async (request, reply) => {
    const cacheKey = 'tabs:all';

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      fastify.log.warn('Redis cache miss for tabs', err);
    }

    const result = await db.query(
      `SELECT id, name, slug, position, icon, color, description, config, is_active
       FROM tabs WHERE is_active = TRUE ORDER BY position ASC`
    );

    const tabs = result.rows;

    try {
      await redis.set(cacheKey, JSON.stringify(tabs), 'EX', 60);
    } catch (err) {
      fastify.log.warn('Failed to cache tabs', err);
    }

    return tabs;
  });
};
