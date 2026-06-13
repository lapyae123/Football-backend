const { Pool, types } = require('pg');

// Force timestamp without timezone (OID 1114) to be treated as UTC.
// By default node-postgres parses these as local server time, which causes a
// 30-min countdown error for Myanmar users (UTC+6:30) when times are stored in UTC.
types.setTypeParser(1114, (val) => val ? new Date(val + 'Z').toISOString() : null);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 8,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 30000, // Neon free tier needs up to 20s to wake from suspension
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
  const maxAttempts = 3;
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    let client;
    try {
      client = await pool.connect();
      client.removeAllListeners('error');
      client.on('error', () => {});
      const result = await client.query(text, params);
      client.release();
      return result;
    } catch (err) {
      if (client) client.release(true);
      if (isConnErr(err) && i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
};

// Wake up Neon immediately on startup, then keep alive every 4 min
const wakeUp = () => pool.query('SELECT 1').catch(() => {});
wakeUp();
setInterval(wakeUp, 4 * 60 * 1000);

module.exports = { query, pool };
