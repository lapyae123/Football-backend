const db    = require('../config/database');
const redis = require('../config/redis');

module.exports = async function (fastify) {
  fastify.get('/api/config', async (request, reply) => {
    const cacheKey = 'config:all';

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}

    const [tabsResult, configResult] = await Promise.all([
      db.query(
        `SELECT id, name, slug, position, source_type,
                icon, color, description, config, is_active
         FROM tabs
         WHERE is_active = TRUE
         ORDER BY position ASC`
      ),
      db.query('SELECT key, value FROM app_config'),
    ]);

    const appConfig = {};
    for (const row of configResult.rows) appConfig[row.key] = row.value;

    const payload = {
      tabs:     tabsResult.rows,
      features: appConfig.features || {},
      ui:       appConfig.ui       || {},
      limits:   appConfig.limits   || {},
      ads:      appConfig.ads      || { enabled: false, publisher_id: '', pages: [], slots: {} },
    };

    try {
      const ttl = appConfig.limits?.configCacheTTL ?? 60;
      await redis.set(cacheKey, JSON.stringify(payload), 'EX', ttl);
    } catch (_) {}

    return payload;
  });
};
