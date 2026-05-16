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

// Retry wrapper — Neon serverless can drop idle connections mid-flight (ECONNRESET).
// On connection errors we wait briefly and retry with a fresh connection.
const CONNECTION_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', '57P01', '08006', '08001']);

const query = async (text, params) => {
  const maxAttempts = 3;
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      const isConnErr = CONNECTION_ERRORS.has(err.code) || err.message?.includes('ECONNRESET');
      if (isConnErr && i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
};

module.exports = { query, pool };
