/**
 * Football Live — Telegram Subscription Bot
 *
 * Flow:
 *  /start  → welcome + check subscription status
 *  📋 Plans → show plan cards with pricing
 *  Select plan → show payment instructions
 *  User sends screenshot → save transaction as 'pending'
 *  /status → current subscription info
 *
 * Requires env vars:
 *   BOT_TOKEN          — BotFather token
 *   BOT_USERNAME       — e.g. FootballLiveBot
 *   PAYMENT_KPAY       — KPay phone number
 *   PAYMENT_WAVEPAY    — WavePay phone number
 *   PAYMENT_ACCOUNT    — Bank account (optional)
 *   WEBSITE_URL        — Your website URL
 *   API_BASE           — Backend API base (e.g. http://localhost:3050)
 *   ADMIN_CHAT_ID      — Your Telegram chat ID for new transaction alerts
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN       = process.env.BOT_TOKEN;
const API_BASE        = process.env.API_BASE        || 'http://localhost:3050';
const WEBSITE_URL     = process.env.WEBSITE_URL     || 'https://yoursite.com';
const ADMIN_CHAT_ID   = process.env.ADMIN_CHAT_ID;
const PAYMENT_KPAY    = process.env.PAYMENT_KPAY    || '';
const PAYMENT_WAVEPAY = process.env.PAYMENT_WAVEPAY || '';
const PAYMENT_BANK    = process.env.PAYMENT_BANK    || '';

if (!BOT_TOKEN) { console.error('[bot] BOT_TOKEN is required'); process.exit(1); }

const bot = new Telegraf(BOT_TOKEN);

// ── Helpers ────────────────────────────────────────────────────────────────────

const apiGet  = (path) => fetch(`${API_BASE}${path}`).then((r) => r.json());
const apiPost = (path, body) => fetch(`${API_BASE}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const fmt = (n) => Number(n).toLocaleString('en-US');

const planEmoji = (days) => days <= 7 ? '⚡' : days <= 30 ? '🌟' : '👑';

const formatPlan = (p) => {
  const features = (p.features || []).map((f) => `  ✅ ${f}`).join('\n');
  return [
    `${planEmoji(p.duration_days)} *${p.name}*`,
    `💰 ${fmt(p.price)} ${p.currency}`,
    `⏱ ${p.duration_days} days`,
    features,
  ].join('\n');
};

// ── User session state (in-memory, fine for small bots) ───────────────────────
// For production scale use Redis: key = telegram_id, value = { step, planId, ... }
const sessions = new Map();
const getSession = (id) => {
  if (!sessions.has(id)) sessions.set(id, {});
  return sessions.get(id);
};
const clearSession = (id) => sessions.delete(id);

// ── /start ────────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const tgId = ctx.from.id;

  // Check if user already has active subscription
  const check = await apiGet(`/api/subscription/check?telegram_id=${tgId}`).catch(() => ({ active: false }));

  const name = ctx.from.first_name || 'there';

  if (check.active) {
    const sub  = check.subscription;
    const exp  = new Date(sub.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    await ctx.replyWithMarkdown(
      `✅ *Welcome back, ${name}!*\n\n` +
      `Your *${sub.plan_name}* subscription is active.\n` +
      `📅 Expires: *${exp}*\n\n` +
      `🔗 Watch live: ${WEBSITE_URL}`,
      Markup.keyboard([
        ['📋 Plans', '📱 My Status'],
        ['💬 Support'],
      ]).resize()
    );
  } else {
    await ctx.replyWithMarkdown(
      `⚽ *Welcome to Football Live, ${name}!*\n\n` +
      `Watch premium football live streams anytime.\n\n` +
      `Tap *📋 Plans* to see our subscription packages.`,
      Markup.keyboard([
        ['📋 Plans', '📱 My Status'],
        ['💬 Support'],
      ]).resize()
    );
  }
});

// ── Show plans ────────────────────────────────────────────────────────────────

const sendPlans = async (ctx) => {
  const plans = await apiGet('/api/subscription/plans').catch(() => []);
  if (!plans.length) {
    return ctx.reply('No plans available right now. Try again later.');
  }

  await ctx.replyWithMarkdown(
    `🎯 *Choose Your Plan*\n\n` +
    plans.map(formatPlan).join('\n\n─────────────\n\n'),
    Markup.inlineKeyboard(
      plans.map((p) => [
        Markup.button.callback(
          `${planEmoji(p.duration_days)} ${p.name} — ${fmt(p.price)} ${p.currency}`,
          `SELECT_PLAN:${p.id}`
        )
      ])
    )
  );
};

bot.hears('📋 Plans', sendPlans);
bot.command('plans', sendPlans);

// ── Plan selected → payment method chooser ────────────────────────────────────

bot.action(/^SELECT_PLAN:(\d+)$/, async (ctx) => {
  const planId = parseInt(ctx.match[1]);
  const plans  = await apiGet('/api/subscription/plans').catch(() => []);
  const plan   = plans.find((p) => p.id === planId);
  if (!plan) return ctx.answerCbQuery('Plan not found');

  const session = getSession(ctx.from.id);
  session.planId = planId;
  session.plan   = plan;
  session.step   = 'choose_payment';

  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
    `You selected: *${plan.name}* — ${fmt(plan.price)} ${plan.currency}\n\n` +
    `Choose your payment method:`,
    Markup.inlineKeyboard([
      PAYMENT_KPAY    ? [Markup.button.callback('📱 KPay',     `PAY_METHOD:kpay`)]    : [],
      PAYMENT_WAVEPAY ? [Markup.button.callback('🌊 WavePay',  `PAY_METHOD:wavepay`)] : [],
      PAYMENT_BANK    ? [Markup.button.callback('🏦 Bank Transfer', `PAY_METHOD:bank`)] : [],
    ].filter((row) => row.length))
  );
});

// ── Payment method chosen → show instructions ──────────────────────────────────

bot.action(/^PAY_METHOD:(kpay|wavepay|bank)$/, async (ctx) => {
  const method  = ctx.match[1];
  const session = getSession(ctx.from.id);
  if (!session.planId) return ctx.reply('Please select a plan first. Tap 📋 Plans');

  session.paymentMethod = method;
  session.step = 'waiting_screenshot';

  const accountMap = {
    kpay:    { label: 'KPay',     number: PAYMENT_KPAY },
    wavepay: { label: 'WavePay',  number: PAYMENT_WAVEPAY },
    bank:    { label: 'Bank',     number: PAYMENT_BANK },
  };
  const acc = accountMap[method];

  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
    `💳 *Payment Instructions*\n\n` +
    `Plan: *${session.plan.name}*\n` +
    `Amount: *${fmt(session.plan.price)} ${session.plan.currency}*\n` +
    `Method: *${acc.label}*\n\n` +
    `📲 Send payment to:\n` +
    `\`${acc.number}\`\n\n` +
    `⚠️ *After paying:*\n` +
    `Take a screenshot of your payment confirmation and send it here.\n\n` +
    `We will verify and activate your subscription within *1 hour*.`
  );
});

// ── Screenshot received → save transaction ─────────────────────────────────────

bot.on('photo', async (ctx) => {
  const session = getSession(ctx.from.id);

  if (session.step !== 'waiting_screenshot') {
    return ctx.reply('Please select a plan and payment method first. Tap 📋 Plans');
  }

  // Use highest-resolution photo
  const photo      = ctx.message.photo.at(-1);
  const fileId     = photo.file_id;
  const fileLink   = await ctx.telegram.getFileLink(fileId).catch(() => null);

  const result = await apiPost('/api/subscription/transaction', {
    telegram_id:        ctx.from.id,
    username:           ctx.from.username,
    full_name:          [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
    plan_id:            session.planId,
    amount:             session.plan.price,
    currency:           session.plan.currency,
    payment_method:     session.paymentMethod || null,
    screenshot_file_id: fileId,
    screenshot_url:     fileLink?.href || null,
  });

  if (result.error) {
    return ctx.reply(`❌ Error: ${result.error}. Please try again or contact support.`);
  }

  clearSession(ctx.from.id);

  await ctx.replyWithMarkdown(
    `✅ *Payment screenshot received!*\n\n` +
    `Transaction ID: \`${result.transaction_id}\`\n\n` +
    `Our team will verify your payment and activate your subscription within *1 hour*.\n\n` +
    `You'll receive a confirmation message here once approved.`
  );

  // Notify admin
  if (ADMIN_CHAT_ID) {
    await ctx.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `🔔 *New Payment Received*\n\n` +
      `User: @${ctx.from.username || ctx.from.first_name} (ID: ${ctx.from.id})\n` +
      `Plan: ${session.plan.name} — ${fmt(session.plan.price)} ${session.plan.currency}\n` +
      `Method: ${session.paymentMethod || 'unknown'}\n` +
      `Transaction ID: ${result.transaction_id}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    // Forward the screenshot to admin
    await ctx.telegram.forwardMessage(ADMIN_CHAT_ID, ctx.chat.id, ctx.message.message_id).catch(() => {});
  }
});

// ── /status — check subscription ──────────────────────────────────────────────

const sendStatus = async (ctx) => {
  const check = await apiGet(`/api/subscription/check?telegram_id=${ctx.from.id}`).catch(() => null);
  if (!check) return ctx.reply('Unable to check status. Try again later.');

  if (check.active) {
    const sub  = check.subscription;
    const exp  = new Date(sub.expires_at);
    const days = Math.ceil((exp - Date.now()) / 86400000);
    await ctx.replyWithMarkdown(
      `📱 *Your Subscription*\n\n` +
      `Plan: *${sub.plan_name}*\n` +
      `Status: ✅ Active\n` +
      `Expires: *${exp.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}*\n` +
      `Days remaining: *${days}*\n\n` +
      `🔗 Watch now: ${WEBSITE_URL}`
    );
  } else {
    await ctx.replyWithMarkdown(
      `❌ *No active subscription*\n\n` +
      `Tap 📋 Plans to subscribe and unlock all live streams.`
    );
  }
};

bot.hears('📱 My Status', sendStatus);
bot.command('status', sendStatus);

// ── Support ───────────────────────────────────────────────────────────────────

bot.hears('💬 Support', (ctx) =>
  ctx.replyWithMarkdown(
    `💬 *Support*\n\n` +
    `For payment issues or questions, please contact our admin directly.\n\n` +
    `Include your *Transaction ID* if you have one.`
  )
);

// ── N8N activates subscription → notify user ──────────────────────────────────
// Call this from N8N after approve: POST /api/bot/notify-approved
// (requires BOT_TOKEN on the same server or a separate webhook)

// ── Global error handler ──────────────────────────────────────────────────────

bot.catch((err, ctx) => {
  console.error(`[bot] Error for ${ctx.updateType}:`, err.message);
  ctx.reply('Something went wrong. Please try again.').catch(() => {});
});

bot.launch({ dropPendingUpdates: true });
console.log('[bot] Football Live Bot started ✓');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
