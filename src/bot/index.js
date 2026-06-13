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
    `⏱ ${p.duration_days} ရက်`,
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
      `✅ *ကြိုဆိုပါသည်, ${name}!*\n\n` +
      `သင့် *${sub.plan_name}* စာရင်းသွင်းမှု လက်ရှိတက်ကြွနေသည်။\n` +
      `📅 သက်တမ်းကုန်သည့်ရက်: *${exp}*\n\n` +
      `🔗 တိုက်ရိုက်ကြည့်ရန်: ${WEBSITE_URL}`,
      Markup.keyboard([
        ['📋 Plan များ', '📱 ကျွန်ုပ်၏ Status'],
        ['💬 အကူအညီ'],
      ]).resize()
    );
  } else {
    await ctx.replyWithMarkdown(
      `⚽ *BalloneTV မှ ကြိုဆိုပါသည်, ${name}!*\n\n` +
      `ဘောလုံး တိုက်ရိုက်ထုတ်လွှင့်မှုများကို အချိန်မရွေး ကြည့်ရှုနိုင်သည်။\n\n` +
      `*📋 Plan များ* ကိုနှိပ်၍ စာရင်းသွင်းမှု package များကို ကြည့်ရှုပါ။`,
      Markup.keyboard([
        ['📋 Plan များ', '📱 ကျွန်ုပ်၏ Status'],
        ['💬 အကူအညီ'],
      ]).resize()
    );
  }
});

// ── Show plans ────────────────────────────────────────────────────────────────

const sendPlans = async (ctx) => {
  const plans = await apiGet('/api/subscription/plans').catch(() => []);
  if (!plans.length) {
    return ctx.reply('လောလောဆယ် Plan များ မရရှိနိုင်ပါ။ နောက်မှ ထပ်စမ်းကြည့်ပါ။');
  }

  await ctx.replyWithMarkdown(
    `🎯 *သင့် Plan ကို ရွေးချယ်ပါ*\n\n` +
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

bot.hears('📋 Plan များ', sendPlans);
bot.hears('📋 Plans', sendPlans);
bot.command('plans', sendPlans);

// ── Plan selected → payment method chooser ────────────────────────────────────

bot.action(/^SELECT_PLAN:(\d+)$/, async (ctx) => {
  const planId = parseInt(ctx.match[1]);
  const plans  = await apiGet('/api/subscription/plans').catch(() => []);
  const plan   = plans.find((p) => p.id === planId);
  if (!plan) return ctx.answerCbQuery('Plan မတွေ့ပါ');

  const session = getSession(ctx.from.id);
  session.planId = planId;
  session.plan   = plan;
  session.step   = 'choose_payment';

  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
    `သင်ရွေးချယ်သည်: *${plan.name}* — ${fmt(plan.price)} ${plan.currency}\n\n` +
    `ငွေပေးချေမှု နည်းလမ်းကို ရွေးချယ်ပါ:`,
    Markup.inlineKeyboard([
      PAYMENT_KPAY    ? [Markup.button.callback('📱 KPay',          `PAY_METHOD:kpay`)]    : [],
      PAYMENT_WAVEPAY ? [Markup.button.callback('🌊 WavePay',       `PAY_METHOD:wavepay`)] : [],
      PAYMENT_BANK    ? [Markup.button.callback('🏦 ဘဏ်လွှဲပြောင်း', `PAY_METHOD:bank`)]   : [],
    ].filter((row) => row.length))
  );
});

// ── Payment method chosen → show instructions ──────────────────────────────────

bot.action(/^PAY_METHOD:(kpay|wavepay|bank)$/, async (ctx) => {
  const method  = ctx.match[1];
  const session = getSession(ctx.from.id);
  if (!session.planId) return ctx.reply('ကျေးဇူးပြု၍ အရင် Plan ရွေးပါ။ 📋 Plan များ ကိုနှိပ်ပါ။');

  session.paymentMethod = method;
  session.step = 'waiting_screenshot';

  const accountMap = {
    kpay:    { label: 'KPay',          number: PAYMENT_KPAY },
    wavepay: { label: 'WavePay',       number: PAYMENT_WAVEPAY },
    bank:    { label: 'ဘဏ်လွှဲပြောင်း', number: PAYMENT_BANK },
  };
  const acc = accountMap[method];

  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
    `💳 *ငွေပေးချေမှု လမ်းညွှန်*\n\n` +
    `Plan: *${session.plan.name}*\n` +
    `ငွေပမာဏ: *${fmt(session.plan.price)} ${session.plan.currency}*\n` +
    `နည်းလမ်း: *${acc.label}*\n\n` +
    `📲 အောက်ပါ နံပါတ်သို့ ငွေလွှဲပါ:\n` +
    `\`${acc.number}\`\n\n` +
    `⚠️ *ငွေပေးပြီးနောက်:*\n` +
    `ငွေပေးချေမှု အတည်ပြုချက် screenshot ကို ဤနေရာတွင် ပို့ပါ။\n\n` +
    `ကျွန်ုပ်တို့ *၁ နာရီ* အတွင်း စစ်ဆေးပြီး သင့် subscription ကို အသက်သွင်းပေးမည်။`
  );
});

// ── Screenshot received → save transaction ─────────────────────────────────────

bot.on('photo', async (ctx) => {
  const session = getSession(ctx.from.id);

  if (session.step !== 'waiting_screenshot') {
    return ctx.reply('ကျေးဇူးပြု၍ အရင် Plan နှင့် ငွေပေးချေမှု နည်းလမ်းကို ရွေးပါ။ 📋 Plan များ ကိုနှိပ်ပါ။');
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
    return ctx.reply(`❌ အမှား: ${result.error}။ ထပ်မံကြိုးစားပါ သို့မဟုတ် အကူအညီရယူပါ။`);
  }

  clearSession(ctx.from.id);

  await ctx.replyWithMarkdown(
    `✅ *ငွေပေးချေမှု screenshot လက်ခံရရှိပြီ!*\n\n` +
    `Transaction ID: \`${result.transaction_id}\`\n\n` +
    `ကျွန်ုပ်တို့အဖွဲ့ *၁ နာရီ* အတွင်း စစ်ဆေးပြီး သင့် subscription ကို အသက်သွင်းပေးမည်။\n\n` +
    `အတည်ပြုပြီးသည်နှင့် ဤနေရာတွင် အကြောင်းကြားပေးမည်။`
  );

  // Notify admin
  if (ADMIN_CHAT_ID) {
    await ctx.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `🔔 *ငွေပေးချေမှု အသစ်ရရှိသည်*\n\n` +
      `အသုံးပြုသူ: @${ctx.from.username || ctx.from.first_name} (ID: ${ctx.from.id})\n` +
      `Plan: ${session.plan.name} — ${fmt(session.plan.price)} ${session.plan.currency}\n` +
      `နည်းလမ်း: ${session.paymentMethod || 'မသိ'}\n` +
      `Transaction ID: ${result.transaction_id}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    await ctx.telegram.forwardMessage(ADMIN_CHAT_ID, ctx.chat.id, ctx.message.message_id).catch(() => {});
  }
});

// ── /status — check subscription ──────────────────────────────────────────────

const sendStatus = async (ctx) => {
  const check = await apiGet(`/api/subscription/check?telegram_id=${ctx.from.id}`).catch(() => null);
  if (!check) return ctx.reply('Status စစ်ဆေး၍ မရပါ။ နောက်မှ ထပ်စမ်းကြည့်ပါ။');

  if (check.active) {
    const sub  = check.subscription;
    const exp  = new Date(sub.expires_at);
    const days = Math.ceil((exp - Date.now()) / 86400000);
    await ctx.replyWithMarkdown(
      `📱 *သင့် Subscription*\n\n` +
      `Plan: *${sub.plan_name}*\n` +
      `အခြေအနေ: ✅ တက်ကြွနေသည်\n` +
      `သက်တမ်းကုန်သည့်ရက်: *${exp.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}*\n` +
      `ကျန်ရက်: *${days} ရက်*\n\n` +
      `🔗 ယခုကြည့်ရန်: ${WEBSITE_URL}`
    );
  } else {
    await ctx.replyWithMarkdown(
      `❌ *Subscription မရှိသေးပါ*\n\n` +
      `📋 Plan များ ကိုနှိပ်၍ စာရင်းသွင်းပြီး တိုက်ရိုက်ထုတ်လွှင့်မှုများ ကြည့်ရှုပါ။`
    );
  }
};

bot.hears('📱 ကျွန်ုပ်၏ Status', sendStatus);
bot.hears('📱 My Status', sendStatus);
bot.command('status', sendStatus);

// ── Support ───────────────────────────────────────────────────────────────────

bot.hears('💬 အကူအညီ', (ctx) =>
  ctx.replyWithMarkdown(
    `💬 *အကူအညီ*\n\n` +
    `ငွေပေးချေမှု ပြဿနာများ သို့မဟုတ် မေးခွန်းများအတွက် admin ကို တိုက်ရိုက် ဆက်သွယ်ပါ။\n\n` +
    `သင့်တွင် Transaction ID ရှိပါက ထည့်သွင်းဖော်ပြပါ။`
  )
);
bot.hears('💬 Support', (ctx) =>
  ctx.replyWithMarkdown(
    `💬 *အကူအညီ*\n\n` +
    `ငွေပေးချေမှု ပြဿနာများ သို့မဟုတ် မေးခွန်းများအတွက် admin ကို တိုက်ရိုက် ဆက်သွယ်ပါ။\n\n` +
    `သင့်တွင် Transaction ID ရှိပါက ထည့်သွင်းဖော်ပြပါ။`
  )
);

// ── N8N activates subscription → notify user ──────────────────────────────────
// Call this from N8N after approve: POST /api/bot/notify-approved
// (requires BOT_TOKEN on the same server or a separate webhook)

// ── Global error handler ──────────────────────────────────────────────────────

bot.catch((err, ctx) => {
  console.error(`[bot] Error for ${ctx.updateType}:`, err.message);
  ctx.reply('တစ်ခုခု မှားယွင်းနေသည်။ ထပ်မံကြိုးစားပါ။').catch(() => {});
});

bot.launch({ dropPendingUpdates: true });
console.log('[bot] Football Live Bot started ✓');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
