require('dotenv').config();
const db = require('../config/database');

async function migrate() {
  await db.query(`
    -- ── Subscription Plans ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(100)   NOT NULL,
      duration_days INTEGER        NOT NULL,
      price         DECIMAL(10,2)  NOT NULL,
      currency      VARCHAR(10)    NOT NULL DEFAULT 'MMK',
      description   TEXT,
      features      JSONB          NOT NULL DEFAULT '[]',
      is_active     BOOLEAN        NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW()
    );

    -- ── Telegram Users ───────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS tg_users (
      id          SERIAL    PRIMARY KEY,
      telegram_id BIGINT    UNIQUE NOT NULL,
      username    VARCHAR(255),
      full_name   VARCHAR(255),
      phone       VARCHAR(50),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── Subscriptions ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS subscriptions (
      id         SERIAL  PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES tg_users(id) ON DELETE CASCADE,
      plan_id    INTEGER NOT NULL REFERENCES subscription_plans(id),
      status     VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','active','expired','cancelled')),
      started_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_subs_user_status  ON subscriptions(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_subs_expires       ON subscriptions(expires_at) WHERE status = 'active';

    -- ── Transactions (payment records) ───────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS transactions (
      id                 SERIAL  PRIMARY KEY,
      user_id            INTEGER NOT NULL REFERENCES tg_users(id) ON DELETE CASCADE,
      plan_id            INTEGER NOT NULL REFERENCES subscription_plans(id),
      subscription_id    INTEGER REFERENCES subscriptions(id),
      amount             DECIMAL(10,2) NOT NULL,
      currency           VARCHAR(10)   NOT NULL DEFAULT 'MMK',
      payment_method     VARCHAR(50),        -- 'kpay' | 'wavepay' | 'bank'
      screenshot_file_id TEXT,               -- Telegram file_id (permanent)
      screenshot_url     TEXT,               -- public URL after download/upload
      status             VARCHAR(20) NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','approved','rejected')),
      rejection_reason   TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at        TIMESTAMPTZ,
      verified_by        VARCHAR(255)        -- 'n8n' | admin username
    );

    CREATE INDEX IF NOT EXISTS idx_txn_status     ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_txn_user       ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_txn_created    ON transactions(created_at DESC);
  `);

  // Seed default plans if none exist
  await db.query(`
    INSERT INTO subscription_plans (name, duration_days, price, currency, description, features)
    SELECT * FROM (VALUES
      ('Weekly',  7,  2999, 'MMK', '1 week full access',
       '["All live matches","HD streams","Unlimited devices"]'::jsonb),
      ('Monthly', 30, 7999, 'MMK', '1 month full access',
       '["All live matches","HD streams","Unlimited devices","Priority support"]'::jsonb),
      ('3 Months', 90, 19999, 'MMK', '3 months full access',
       '["All live matches","HD streams","Unlimited devices","Priority support","Best value"]'::jsonb)
    ) AS v(name, duration_days, price, currency, description, features)
    WHERE NOT EXISTS (SELECT 1 FROM subscription_plans LIMIT 1)
  `);

  console.log('[migration] Subscription tables created ✓');
  process.exit(0);
}

migrate().catch((e) => { console.error(e.message); process.exit(1); });
