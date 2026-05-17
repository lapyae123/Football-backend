const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10000,      // evict idle connections aggressively before Neon drops them
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error (will reconnect):', err.message);
});

// Neon serverless pauses after inactivity and drops connections (ECONNRESET).
// Use pool.connect() so we can destroy dead connections and force fresh ones.
const CONNECTION_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', '57P01', '08006', '08001']);

const isConnErr = (err) =>
  CONNECTION_ERRORS.has(err.code) ||
  /ECONNRESET|EPIPE|Connection terminated|terminating connection|server closed/i.test(err.message || '');

const query = async (text, params) => {
  const maxAttempts = 4;
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    let client;
    try {
      client = await pool.connect();
      // Suppress unhandled 'error' events on the checked-out client —
      // these fire when Neon drops the connection mid-query and would
      // otherwise crash the process as an uncaught exception.
      client.on('error', () => {});
      const result = await client.query(text, params);
      client.release();
      return result;
    } catch (err) {
      if (client) client.release(true); // destroy bad connection
      if (isConnErr(err) && i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
};

module.exports = { query, pool };
