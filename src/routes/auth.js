/**
 * Device-token auth — no login required.
 *
 * Flow:
 *  1. Admin approves transaction → generateDeviceToken(userId) called
 *  2. Token stored in tg_users.device_token
 *  3. Bot sends activation URL to user:  https://yoursite.com?activate=TOKEN
 *  4. Web/mobile stores token in localStorage / SecureStore
 *  5. Every page load → GET /api/auth/check?token=TOKEN
 *  6. Returns { is_premium, expires_at, plan_name, full_name }
 *
 * Mobile: identical flow — store token in AsyncStorage/SecureStore,
 *         call the same /api/auth/check endpoint.
 */

const db     = require('../config/database');
const redis  = require('../config/redis');
const crypto = require('crypto');

const WEBSITE_URL = process.env.WEBSITE_URL || 'http://localhost:3000';
const BOT_TOKEN   = process.env.BOT_TOKEN   || '';

// ── Helpers ───────────────────────────────────────────────────────────────────

const genToken = () => crypto.randomBytes(32).toString('hex'); // 64-char hex

const bustCache = async (token) => {
  try { await redis.del(`auth:${token}`) } catch (_) {}
};

// Send Telegram message directly via Bot API (no library needed)
const sendTelegramMsg = async (chatId, text) => {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch (_) {}
};

// Called by approval routes (admin panel + N8N) after subscription is activated
const generateDeviceToken = async (userId, planName, expiresAt) => {
  const token = genToken();
  await db.query(
    `UPDATE tg_users SET device_token=$1, token_generated_at=NOW() WHERE id=$2`,
    [token, userId]
  );

  // Notify user via Telegram with their activation link
  const uRes = await db.query('SELECT telegram_id, full_name FROM tg_users WHERE id=$1', [userId]);
  if (uRes.rows[0]) {
    const { telegram_id, full_name } = uRes.rows[0];
    const activateUrl = `${WEBSITE_URL}?activate=${token}`;
    const expDate     = new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    await sendTelegramMsg(telegram_id,
      `✅ *Premium Activated!*\n\n` +
      `Hello ${full_name || 'there'} 👋\n` +
      `Plan: *${planName}*\n` +
      `Expires: *${expDate}*\n\n` +
      `Tap below to unlock premium on your browser/app:\n` +
      `👉 [Activate Premium](${activateUrl})\n\n` +
      `_This link registers your device. Only 1 device at a time._`
    );
  }

  return token;
};

module.exports = { generateDeviceToken };

// ── Routes ────────────────────────────────────────────────────────────────────

module.exports.routes = async function authRoutes(fastify) {

  // ── GET /api/auth/check?token=xxx ─────────────────────────────────────────
  // Web + Mobile: call this on every app launch / page load
  // Cache result 2 min to avoid DB hit on every navigation
  fastify.get('/api/auth/check', async (request, reply) => {
    const { token } = request.query;
    if (!token) { reply.code(400); return { error: 'token required' }; }

    const cacheKey = `auth:${token}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}

    const { rows } = await db.query(
      `SELECT u.id, u.telegram_id, u.full_name, u.username,
              s.status AS sub_status, s.expires_at,
              p.name   AS plan_name
       FROM tg_users u
       LEFT JOIN LATERAL (
         SELECT s.status, s.expires_at, s.plan_id
         FROM subscriptions s
         WHERE s.user_id = u.id AND s.status = 'active'
         ORDER BY s.expires_at DESC LIMIT 1
       ) s ON true
       LEFT JOIN subscription_plans p ON p.id = s.plan_id
       WHERE u.device_token = $1`,
      [token]
    );

    if (!rows.length) {
      const r = { is_premium: false, reason: 'invalid_token' };
      try { await redis.set(cacheKey, JSON.stringify(r), 'EX', 30) } catch (_) {}
      return r;
    }

    const row        = rows[0];
    const isActive   = row.sub_status === 'active' && new Date(row.expires_at) > new Date();
    const isExpired  = row.sub_status === 'active' && !isActive;

    const result = {
      is_premium:  isActive,
      full_name:   row.full_name  || null,
      username:    row.username   || null,
      plan_name:   row.plan_name  || null,
      expires_at:  row.expires_at || null,
      expired:     isExpired,
      // reason helps frontend show the right message
      reason: isActive ? null : isExpired ? 'expired' : 'no_subscription',
    };

    // Cache shorter if premium so expiry is caught promptly
    const ttl = isActive ? 120 : 30;
    try { await redis.set(cacheKey, JSON.stringify(result), 'EX', ttl) } catch (_) {}

    return result;
  });

  // ── POST /api/auth/activate ───────────────────────────────────────────────
  // Mobile app calls this to register token without URL params
  // Body: { token }
  // Returns same shape as /check
  fastify.post('/api/auth/activate', async (request, reply) => {
    const { token } = request.body || {};
    if (!token) { reply.code(400); return { error: 'token required' }; }
    // Just proxies to the check logic — token is already stored by caller
    const res = await fetch(`http://localhost:${process.env.PORT || 3050}/api/auth/check?token=${token}`);
    return res.json();
  });
};
