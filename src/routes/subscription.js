const db    = require('../config/database');
const redis = require('../config/redis');
const { generateDeviceToken } = require('./auth');

const N8N_SECRET = process.env.N8N_WEBHOOK_SECRET || '';

// ── Guard: N8N calls must include the shared secret ───────────────────────────
const requireN8nSecret = (request, reply) => {
  if (request.headers['x-n8n-secret'] !== N8N_SECRET || !N8N_SECRET) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
};

// ── Invalidate cached subscription status for a telegram user ─────────────────
const bustSubCache = async (telegramId) => {
  try { await redis.del(`sub:${telegramId}`) } catch (_) {}
};

module.exports = async function subscriptionRoutes(fastify) {

  // ── GET /api/subscription/plans ───────────────────────────────────────────────
  // Public — website uses this to show pricing
  fastify.get('/api/subscription/plans', async () => {
    const { rows } = await db.query(
      `SELECT id, name, duration_days, price, currency, description, features
       FROM subscription_plans WHERE is_active = true ORDER BY duration_days`
    );
    return rows;
  });

  // ── GET /api/subscription/check?telegram_id=xxx ───────────────────────────────
  // Bot + website uses this to verify if a user has an active subscription
  fastify.get('/api/subscription/check', async (request, reply) => {
    const { telegram_id } = request.query;
    if (!telegram_id) { reply.code(400); return { error: 'telegram_id required' }; }

    const cacheKey = `sub:${telegram_id}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}

    const { rows } = await db.query(
      `SELECT s.id, s.status, s.expires_at, p.name AS plan_name, p.duration_days
       FROM subscriptions s
       JOIN tg_users u ON u.id = s.user_id
       JOIN subscription_plans p ON p.id = s.plan_id
       WHERE u.telegram_id = $1
         AND s.status = 'active'
         AND s.expires_at > NOW()
       ORDER BY s.expires_at DESC
       LIMIT 1`,
      [telegram_id]
    );

    const result = rows[0]
      ? { active: true,  subscription: rows[0] }
      : { active: false, subscription: null   };

    try { await redis.set(cacheKey, JSON.stringify(result), 'EX', 60) } catch (_) {}
    return result;
  });

  // ── POST /api/subscription/transaction ────────────────────────────────────────
  // Bot calls this after user sends payment screenshot
  fastify.post('/api/subscription/transaction', async (request, reply) => {
    const { telegram_id, username, full_name, plan_id,
            amount, currency, payment_method,
            screenshot_file_id, screenshot_url } = request.body || {};

    if (!telegram_id || !plan_id || !screenshot_file_id) {
      reply.code(400);
      return { error: 'telegram_id, plan_id, screenshot_file_id required' };
    }

    // Upsert Telegram user
    const userRes = await db.query(
      `INSERT INTO tg_users (telegram_id, username, full_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id) DO UPDATE
         SET username  = COALESCE(EXCLUDED.username,  tg_users.username),
             full_name = COALESCE(EXCLUDED.full_name, tg_users.full_name),
             updated_at = NOW()
       RETURNING id`,
      [telegram_id, username || null, full_name || null]
    );
    const userId = userRes.rows[0].id;

    // Fetch plan to get canonical price
    const planRes = await db.query(
      'SELECT price, currency FROM subscription_plans WHERE id = $1 AND is_active = true LIMIT 1',
      [plan_id]
    );
    if (!planRes.rows.length) { reply.code(404); return { error: 'Plan not found' }; }
    const plan = planRes.rows[0];

    // Create pending transaction
    const txnRes = await db.query(
      `INSERT INTO transactions
         (user_id, plan_id, amount, currency, payment_method, screenshot_file_id, screenshot_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
       RETURNING id, created_at`,
      [userId, plan_id, amount || plan.price, currency || plan.currency,
       payment_method || null, screenshot_file_id, screenshot_url || null]
    );

    reply.code(201);
    return { transaction_id: txnRes.rows[0].id, status: 'pending' };
  });

  // ── PUT /api/n8n/transaction/:id/approve ─────────────────────────────────────
  // N8N calls this after verifying the payment screenshot
  fastify.put('/api/n8n/transaction/:id/approve',
    { preHandler: requireN8nSecret },
    async (request, reply) => {
      const { id } = request.params;
      const { verified_by } = request.body || {};

      // Fetch transaction + plan
      const txnRes = await db.query(
        `SELECT t.*, p.duration_days
         FROM transactions t
         JOIN subscription_plans p ON p.id = t.plan_id
         WHERE t.id = $1`,
        [id]
      );
      if (!txnRes.rows.length) { reply.code(404); return { error: 'Transaction not found' }; }
      const txn = txnRes.rows[0];
      if (txn.status !== 'pending') { reply.code(409); return { error: `Already ${txn.status}` }; }

      const startsAt  = new Date();
      const expiresAt = new Date(startsAt.getTime() + txn.duration_days * 86400 * 1000);

      // Create active subscription
      const subRes = await db.query(
        `INSERT INTO subscriptions (user_id, plan_id, status, started_at, expires_at)
         VALUES ($1,$2,'active',$3,$4)
         RETURNING id`,
        [txn.user_id, txn.plan_id, startsAt, expiresAt]
      );

      // Mark transaction approved
      await db.query(
        `UPDATE transactions
         SET status='approved', subscription_id=$1, verified_at=NOW(), verified_by=$2
         WHERE id=$3`,
        [subRes.rows[0].id, verified_by || 'n8n', id]
      );

      const uRes = await db.query('SELECT telegram_id FROM tg_users WHERE id=$1', [txn.user_id]);
      if (uRes.rows[0]) await bustSubCache(uRes.rows[0].telegram_id);
      await generateDeviceToken(txn.user_id, txn.plan_name || '', expiresAt).catch(() => {});

      return {
        ok: true,
        subscription_id: subRes.rows[0].id,
        telegram_id:     uRes.rows[0]?.telegram_id,
        expires_at:      expiresAt,
      };
    }
  );

  // ── PUT /api/n8n/transaction/:id/reject ──────────────────────────────────────
  fastify.put('/api/n8n/transaction/:id/reject',
    { preHandler: requireN8nSecret },
    async (request, reply) => {
      const { id } = request.params;
      const { reason, verified_by } = request.body || {};

      const txnRes = await db.query(
        `UPDATE transactions
         SET status='rejected', rejection_reason=$1, verified_at=NOW(), verified_by=$2
         WHERE id=$3 AND status='pending'
         RETURNING user_id`,
        [reason || null, verified_by || 'n8n', id]
      );
      if (!txnRes.rowCount) { reply.code(404); return { error: 'Not found or already processed' }; }

      const uRes = await db.query('SELECT telegram_id FROM tg_users WHERE id=$1', [txnRes.rows[0].user_id]);
      if (uRes.rows[0]) await bustSubCache(uRes.rows[0].telegram_id);

      return { ok: true, telegram_id: uRes.rows[0]?.telegram_id };
    }
  );

  // ── GET /api/n8n/transactions/pending ─────────────────────────────────────────
  // N8N polls this to get transactions that need review
  fastify.get('/api/n8n/transactions/pending',
    { preHandler: requireN8nSecret },
    async () => {
      const { rows } = await db.query(
        `SELECT t.id, t.amount, t.currency, t.payment_method,
                t.screenshot_file_id, t.screenshot_url, t.created_at,
                p.name AS plan_name, p.duration_days,
                u.telegram_id, u.username, u.full_name
         FROM transactions t
         JOIN tg_users u ON u.id = t.user_id
         JOIN subscription_plans p ON p.id = t.plan_id
         WHERE t.status = 'pending'
         ORDER BY t.created_at ASC`
      );
      return rows;
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN ROUTES  (JWT-protected — reuse the admin JWT guard from admin.js)
  // ═══════════════════════════════════════════════════════════════════════════

  const jwt        = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET;

  const requireJwt = async (request, reply) => {
    const auth = (request.headers.authorization || '').trim();
    if (!auth.startsWith('Bearer ')) { reply.code(401).send({ error: 'Unauthorized' }); return; }
    try { request.admin = jwt.verify(auth.slice(7), JWT_SECRET); }
    catch { reply.code(401).send({ error: 'Token invalid or expired' }); }
  };

  // ── Plans CRUD ────────────────────────────────────────────────────────────

  fastify.get('/api/admin/subscription/plans', { preHandler: requireJwt }, async () => {
    const { rows } = await db.query(
      `SELECT id, name, duration_days, price, currency, description, features, is_active, created_at
       FROM subscription_plans ORDER BY duration_days`
    );
    return rows;
  });

  fastify.post('/api/admin/subscription/plans', { preHandler: requireJwt }, async (request, reply) => {
    const { name, duration_days, price, currency = 'MMK', description, features = [] } = request.body || {};
    if (!name || !duration_days || !price) { reply.code(400); return { error: 'name, duration_days, price required' }; }
    const { rows } = await db.query(
      `INSERT INTO subscription_plans (name, duration_days, price, currency, description, features)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [name, duration_days, price, currency, description || null, JSON.stringify(features)]
    );
    reply.code(201); return rows[0];
  });

  fastify.put('/api/admin/subscription/plans/:id', { preHandler: requireJwt }, async (request, reply) => {
    const { id } = request.params;
    const { name, duration_days, price, currency, description, features, is_active } = request.body || {};
    const { rows } = await db.query(
      `UPDATE subscription_plans
       SET name          = COALESCE($1, name),
           duration_days = COALESCE($2, duration_days),
           price         = COALESCE($3, price),
           currency      = COALESCE($4, currency),
           description   = COALESCE($5, description),
           features      = COALESCE($6::jsonb, features),
           is_active     = COALESCE($7, is_active)
       WHERE id = $8 RETURNING *`,
      [name, duration_days, price, currency, description,
       features != null ? JSON.stringify(features) : null,
       is_active, id]
    );
    if (!rows.length) { reply.code(404); return { error: 'Plan not found' }; }
    return rows[0];
  });

  fastify.delete('/api/admin/subscription/plans/:id', { preHandler: requireJwt }, async (request, reply) => {
    const { rowCount } = await db.query('DELETE FROM subscription_plans WHERE id=$1', [request.params.id]);
    if (!rowCount) { reply.code(404); return { error: 'Not found' }; }
    reply.code(204); return null;
  });

  // ── Members ───────────────────────────────────────────────────────────────

  fastify.get('/api/admin/subscription/members', { preHandler: requireJwt }, async (request) => {
    const { status } = request.query;
    const { rows } = await db.query(
      `SELECT u.id, u.telegram_id, u.username, u.full_name, u.created_at,
              s.id AS sub_id, s.status AS sub_status, s.expires_at,
              p.name AS plan_name
       FROM tg_users u
       LEFT JOIN LATERAL (
         SELECT s.*, p.name FROM subscriptions s
         JOIN subscription_plans p ON p.id = s.plan_id
         WHERE s.user_id = u.id
         ORDER BY s.created_at DESC LIMIT 1
       ) s ON true
       LEFT JOIN subscription_plans p ON p.id = (
         SELECT plan_id FROM subscriptions WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1
       )
       WHERE ($1::text IS NULL OR s.status = $1)
       ORDER BY u.created_at DESC`,
      [status || null]
    );
    return rows;
  });

  // Manual activate / extend subscription
  fastify.post('/api/admin/subscription/members/:userId/activate', { preHandler: requireJwt }, async (request, reply) => {
    const { userId } = request.params;
    const { plan_id, days } = request.body || {};
    if (!plan_id && !days) { reply.code(400); return { error: 'plan_id or days required' }; }

    let duration = days;
    if (!duration) {
      const p = await db.query('SELECT duration_days FROM subscription_plans WHERE id=$1', [plan_id]);
      if (!p.rows.length) { reply.code(404); return { error: 'Plan not found' }; }
      duration = p.rows[0].duration_days;
    }

    const startsAt  = new Date();
    const expiresAt = new Date(startsAt.getTime() + duration * 86400 * 1000);

    const { rows } = await db.query(
      `INSERT INTO subscriptions (user_id, plan_id, status, started_at, expires_at)
       VALUES ($1, $2, 'active', $3, $4) RETURNING id`,
      [userId, plan_id || null, startsAt, expiresAt]
    );

    const uRes = await db.query('SELECT telegram_id FROM tg_users WHERE id=$1', [userId]);
    if (uRes.rows[0]) await bustSubCache(uRes.rows[0].telegram_id);

    reply.code(201); return { subscription_id: rows[0].id, expires_at: expiresAt };
  });

  // Cancel subscription
  fastify.put('/api/admin/subscription/members/:userId/cancel', { preHandler: requireJwt }, async (request, reply) => {
    const { userId } = request.params;
    await db.query(
      `UPDATE subscriptions SET status='cancelled' WHERE user_id=$1 AND status='active'`, [userId]
    );
    const uRes = await db.query('SELECT telegram_id FROM tg_users WHERE id=$1', [userId]);
    if (uRes.rows[0]) await bustSubCache(uRes.rows[0].telegram_id);
    return { ok: true };
  });

  // ── Transactions (admin view — all statuses) ──────────────────────────────

  fastify.get('/api/admin/subscription/transactions', { preHandler: requireJwt }, async (request) => {
    const { status } = request.query;
    const { rows } = await db.query(
      `SELECT t.id, t.amount, t.currency, t.payment_method,
              t.screenshot_file_id, t.screenshot_url,
              t.status, t.rejection_reason, t.created_at, t.verified_at, t.verified_by,
              p.name AS plan_name, p.duration_days,
              u.telegram_id, u.username, u.full_name
       FROM transactions t
       JOIN tg_users u ON u.id = t.user_id
       JOIN subscription_plans p ON p.id = t.plan_id
       WHERE ($1::text IS NULL OR t.status = $1)
       ORDER BY t.created_at DESC
       LIMIT 200`,
      [status || null]
    );
    return rows;
  });

  // Admin approve (same logic as N8N but JWT-protected)
  fastify.put('/api/admin/subscription/transactions/:id/approve', { preHandler: requireJwt }, async (request, reply) => {
    const { id } = request.params;
    const txnRes = await db.query(
      `SELECT t.*, p.duration_days FROM transactions t JOIN subscription_plans p ON p.id=t.plan_id WHERE t.id=$1`, [id]
    );
    if (!txnRes.rows.length) { reply.code(404); return { error: 'Not found' }; }
    const txn = txnRes.rows[0];
    if (txn.status !== 'pending') { reply.code(409); return { error: `Already ${txn.status}` }; }

    const startsAt  = new Date();
    const expiresAt = new Date(startsAt.getTime() + txn.duration_days * 86400 * 1000);
    const subRes = await db.query(
      `INSERT INTO subscriptions (user_id, plan_id, status, started_at, expires_at) VALUES ($1,$2,'active',$3,$4) RETURNING id`,
      [txn.user_id, txn.plan_id, startsAt, expiresAt]
    );
    await db.query(
      `UPDATE transactions SET status='approved', subscription_id=$1, verified_at=NOW(), verified_by='admin' WHERE id=$2`,
      [subRes.rows[0].id, id]
    );
    const uRes = await db.query('SELECT telegram_id FROM tg_users WHERE id=$1', [txn.user_id]);
    if (uRes.rows[0]) await bustSubCache(uRes.rows[0].telegram_id);
    await generateDeviceToken(txn.user_id, txn.plan_name || '', expiresAt).catch(() => {});
    return { ok: true, expires_at: expiresAt, telegram_id: uRes.rows[0]?.telegram_id };
  });

  fastify.put('/api/admin/subscription/transactions/:id/reject', { preHandler: requireJwt }, async (request, reply) => {
    const { reason } = request.body || {};
    const { rowCount, rows } = await db.query(
      `UPDATE transactions SET status='rejected', rejection_reason=$1, verified_at=NOW(), verified_by='admin'
       WHERE id=$2 AND status='pending' RETURNING user_id`, [reason || null, request.params.id]
    );
    if (!rowCount) { reply.code(404); return { error: 'Not found or already processed' }; }
    const uRes = await db.query('SELECT telegram_id FROM tg_users WHERE id=$1', [rows[0].user_id]);
    if (uRes.rows[0]) await bustSubCache(uRes.rows[0].telegram_id);
    return { ok: true };
  });
};
