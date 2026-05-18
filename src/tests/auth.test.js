/**
 * Premium Auth System — Test Cases
 * Run: node src/tests/auth.test.js
 *
 * အဓိပ္ပါယ်: Device Token Auth System ကို Test လုပ်တဲ့ Script
 */

require('dotenv').config();
const db = require('../config/database');

const BASE = `http://localhost:${process.env.PORT || 3050}`;
const N8N  = process.env.N8N_WEBHOOK_SECRET || 'n8n-secret-2026';

let passed = 0;
let failed = 0;
const results = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const get  = (path, headers = {}) =>
  fetch(`${BASE}${path}`, { headers }).then((r) => r.json());

const post = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const put = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then((r) => r.json());

async function adminToken() {
  const r = await post('/api/admin/login', {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || '12345',
  });
  return r.token;
}

function assert(name, condition, detail = '') {
  if (condition) {
    passed++;
    results.push({ ok: true,  name });
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    results.push({ ok: false, name, detail });
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ─── Test Suites ──────────────────────────────────────────────────────────────

async function testPublicPlans() {
  console.log('\n📦 Plans API\n───────────────────────────────');

  const plans = await get('/api/subscription/plans');

  assert('Plans returns array',
    Array.isArray(plans));

  assert('Plans are not empty',
    plans.length > 0, `got ${plans.length}`);

  assert('Each plan has required fields',
    plans.every((p) => p.id && p.name && p.price && p.duration_days));

  assert('Plans are sorted by duration (shortest first)',
    plans[0]?.duration_days <= plans[plans.length - 1]?.duration_days);
}

async function testInvalidToken() {
  console.log('\n🔑 Invalid / Missing Token\n───────────────────────────────');

  // Missing token
  const missing = await get('/api/auth/check');
  assert('Missing token → 400',
    missing.error === 'token required');

  // Wrong token
  const wrong = await get('/api/auth/check?token=totally_fake_token_xyz');
  assert('Fake token → is_premium: false',
    wrong.is_premium === false);

  assert('Fake token → reason: invalid_token',
    wrong.reason === 'invalid_token');
}

async function testSubscriptionFlow() {
  console.log('\n💳 Full Subscription Flow\n───────────────────────────────');

  const TG_ID = 999888777; // test user

  // 1. Create transaction via public API (simulates bot)
  const plans = await get('/api/subscription/plans');
  const plan  = plans[0]; // cheapest
  const JWT   = await adminToken();

  const txn = await post('/api/subscription/transaction', {
    telegram_id:        TG_ID,
    username:           'test_user_mm',
    full_name:          'Test User Myanmar',
    plan_id:            plan.id,
    amount:             plan.price,
    currency:           plan.currency,
    payment_method:     'kpay',
    screenshot_file_id: 'TEST_FILE_ID_AUTOTEST',
  });

  assert('Transaction created with pending status',
    txn.transaction_id && txn.status === 'pending',
    JSON.stringify(txn));

  // 2. Check subscription BEFORE approval → should be inactive
  const beforeCheck = await get(`/api/subscription/check?telegram_id=${TG_ID}`);
  assert('Before approval → not active',
    beforeCheck.active === false);

  // 3. Admin approves transaction
  const approval = await put(
    `/api/admin/subscription/transactions/${txn.transaction_id}/approve`,
    {},
    { Authorization: `Bearer ${JWT}` }
  );

  assert('Approval returns ok: true',
    approval.ok === true, JSON.stringify(approval));

  assert('Approval returns expires_at',
    !!approval.expires_at);

  // 4. Check subscription AFTER approval → should be active
  const afterCheck = await get(`/api/subscription/check?telegram_id=${TG_ID}`);
  assert('After approval → is active',
    afterCheck.active === true, JSON.stringify(afterCheck));

  assert('After approval → correct plan name',
    afterCheck.subscription?.plan_name === plan.name);

  // 5. Get device token from DB (in real life bot sends this)
  const uRow = await db.query(
    'SELECT device_token FROM tg_users WHERE telegram_id=$1', [TG_ID]
  );
  const token = uRow.rows[0]?.device_token;

  assert('Device token was generated',
    !!token, 'device_token is null');

  return { token, TG_ID, JWT, txnId: txn.transaction_id };
}

async function testDeviceTokenCheck(token) {
  console.log('\n🌐 Device Token Check (Web + Mobile)\n───────────────────────────────');

  // Valid token → premium
  const check = await get(`/api/auth/check?token=${token}`);
  assert('Valid token → is_premium: true',
    check.is_premium === true, JSON.stringify(check));

  assert('Valid token → has expires_at',
    !!check.expires_at);

  assert('Valid token → has plan_name',
    !!check.plan_name);

  assert('Valid token → no error reason',
    check.reason === null || check.reason === undefined);

  // Caching — second call should return same result
  const check2 = await get(`/api/auth/check?token=${token}`);
  assert('Second check (cached) → still premium',
    check2.is_premium === true);
}

async function testSingleDevice(TG_ID, JWT) {
  console.log('\n📱 Single Device Rule\n───────────────────────────────');

  // Get current token (Device A)
  const before = await db.query(
    'SELECT device_token FROM tg_users WHERE telegram_id=$1', [TG_ID]
  );
  const tokenA = before.rows[0]?.device_token;

  assert('Device A has a token',
    !!tokenA);

  // Simulate new approval (Device B) — generates new token
  // In real life: admin approves renewal or user sends /login to bot
  const subs = await db.query(
    `SELECT s.id, p.name, s.expires_at FROM subscriptions s
     JOIN tg_users u ON u.id = s.user_id
     JOIN subscription_plans p ON p.id = s.plan_id
     WHERE u.telegram_id = $1 AND s.status='active'
     ORDER BY s.created_at DESC LIMIT 1`, [TG_ID]
  );

  const { generateDeviceToken } = require('../routes/auth');
  const userId = (await db.query('SELECT id FROM tg_users WHERE telegram_id=$1', [TG_ID])).rows[0]?.id;
  await generateDeviceToken(userId, subs.rows[0]?.name || 'Test', subs.rows[0]?.expires_at || new Date());

  const after = await db.query(
    'SELECT device_token FROM tg_users WHERE telegram_id=$1', [TG_ID]
  );
  const tokenB = after.rows[0]?.device_token;

  assert('New token generated (Device B)',
    tokenB !== tokenA, `A=${tokenA?.slice(0,8)} B=${tokenB?.slice(0,8)}`);

  // Device A's old token should now be invalid
  const checkA = await get(`/api/auth/check?token=${tokenA}`);
  assert('Device A old token → invalid after new activation',
    checkA.is_premium === false && checkA.reason === 'invalid_token',
    JSON.stringify(checkA));

  // Device B's new token should be valid
  const checkB = await get(`/api/auth/check?token=${tokenB}`);
  assert('Device B new token → premium',
    checkB.is_premium === true);

  return tokenB;
}

async function testExpiredSubscription(TG_ID) {
  console.log('\n⏰ Expiry Logic\n───────────────────────────────');

  // Force-expire the subscription in DB
  await db.query(
    `UPDATE subscriptions SET expires_at = NOW() - INTERVAL '1 hour'
     WHERE user_id = (SELECT id FROM tg_users WHERE telegram_id=$1)
       AND status = 'active'`, [TG_ID]
  );

  // Bust redis cache
  const uRow = await db.query('SELECT device_token FROM tg_users WHERE telegram_id=$1', [TG_ID]);
  const token = uRow.rows[0]?.device_token;

  // Wait a moment for cache to naturally be bypassed or just skip cache check
  const redis = require('../config/redis');
  await redis.del(`auth:${token}`).catch(() => {});

  const check = await get(`/api/auth/check?token=${token}`);
  assert('Expired sub → is_premium: false',
    check.is_premium === false, JSON.stringify(check));

  assert('Expired sub → expired: true',
    check.expired === true);

  // Restore for cleanup
  await db.query(
    `UPDATE subscriptions SET expires_at = NOW() + INTERVAL '30 days'
     WHERE user_id = (SELECT id FROM tg_users WHERE telegram_id=$1)`, [TG_ID]
  );
}

async function testN8NApproval() {
  console.log('\n🤖 N8N Webhook Approval\n───────────────────────────────');

  const TG_ID = 111222333;
  const plans  = await get('/api/subscription/plans');

  // Create pending transaction
  const txn = await post('/api/subscription/transaction', {
    telegram_id:        TG_ID,
    full_name:          'N8N Test User',
    plan_id:            plans[0].id,
    amount:             plans[0].price,
    currency:           plans[0].currency,
    payment_method:     'wavepay',
    screenshot_file_id: 'N8N_TEST_FILE_ID',
  });

  assert('N8N test transaction created',
    !!txn.transaction_id);

  // N8N without secret → 401
  const noAuth = await put(`/api/n8n/transaction/${txn.transaction_id}/approve`, {});
  assert('N8N without secret → unauthorized',
    noAuth.error === 'Unauthorized');

  // N8N with correct secret → ok
  const withAuth = await put(
    `/api/n8n/transaction/${txn.transaction_id}/approve`,
    { verified_by: 'n8n_test' },
    { 'x-n8n-secret': N8N }
  );
  assert('N8N with secret → approved',
    withAuth.ok === true, JSON.stringify(withAuth));

  // Double approve → 409
  const double = await put(
    `/api/n8n/transaction/${txn.transaction_id}/approve`,
    {},
    { 'x-n8n-secret': N8N }
  );
  assert('Double approve → conflict 409',
    double.error?.includes('approved'));
}

async function cleanup(TG_ID) {
  // Remove test users
  await db.query(`
    DELETE FROM transactions WHERE user_id IN (
      SELECT id FROM tg_users WHERE telegram_id IN ($1, 111222333)
    )`, [TG_ID]);
  await db.query(`
    DELETE FROM subscriptions WHERE user_id IN (
      SELECT id FROM tg_users WHERE telegram_id IN ($1, 111222333)
    )`, [TG_ID]);
  await db.query(`
    DELETE FROM tg_users WHERE telegram_id IN ($1, 111222333)`, [TG_ID]);
}

// ─── Run all tests ─────────────────────────────────────────────────────────────

(async () => {
  console.log('\n🧪 Premium Auth — Test Suite');
  console.log('══════════════════════════════════════');

  try {
    await testPublicPlans();
    await testInvalidToken();

    const { token, TG_ID, JWT } = await testSubscriptionFlow();
    await testDeviceTokenCheck(token);
    const newToken = await testSingleDevice(TG_ID, JWT);
    await testExpiredSubscription(TG_ID);
    await testN8NApproval();
    await cleanup(TG_ID);

  } catch (err) {
    console.error('\n💥 Test suite crashed:', err.message);
    failed++;
  }

  // ── Summary ──
  console.log('\n══════════════════════════════════════');
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📊 Total:  ${passed + failed}`);

  if (failed === 0) {
    console.log('\n🎉 အားလုံး အောင်မြင်တယ်!\n');
  } else {
    console.log(`\n⚠️  ${failed} ခု မအောင်မြင်ဘူး။ စစ်ဆေးပါ။\n`);
  }

  process.exit(failed > 0 ? 1 : 0);
})();
