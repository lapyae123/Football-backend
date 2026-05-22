# Football Live Streaming App — CLAUDE.md

## Project Overview
Sports live streaming aggregator with a Myanmar focus. Users watch live football via proxied stream URLs aggregated from multiple scraped sources. Premium access is gated by a Telegram-bot subscription flow.

---

## Repository Layout

```
/Football/
  football-app/   ← Node.js + Fastify backend (this repo, port 3050)
  streamzone/     ← Next.js 14 frontend (port 3000)
```

The frontend lives in a **sibling folder** (`../streamzone`), not inside `football-app`.  
Admin dashboard: `localhost:3000/admin`

---

## Tech Stack

| Layer      | Technology                          |
|------------|-------------------------------------|
| Backend    | Node.js + Fastify 5                 |
| Database   | PostgreSQL via Neon (serverless)     |
| Cache      | Redis via Upstash (ioredis)          |
| Scraper    | Playwright + playwright-extra-stealth|
| Auth       | JWT (admin) + device-token (users)   |
| Bot        | Telegram bot (`src/bot/`)           |
| Payment    | n8n webhook → subscription activate |
| Frontend   | Next.js 14 App Router (streamzone)  |

---

## Backend Entry Point

`src/index.js` — registers all Fastify routes and starts all background jobs on boot:

```
Routes registered:
  /api/config        config.js
  /api/tabs          tabs.js
  /api/matches       matches.js
  /api/streams       streams.js
  /api/admin/*       admin.js         (JWT-protected)
  /api/english       english.js
  /api/servers       servers.js
  /api/proxy/*       proxy.js         (stream + FLV + image proxy)
  /api/tv            tv.js
  /api/subscription  subscription.js
  /api/auth          auth.js

Jobs started on boot:
  syncMatches.js          — streamed.su API sync
  socoliveSyncJob.js      — SOCO scraper scheduler
  chinaliveSyncJob.js     — China scraper scheduler + pre-warm timers
  urlHealthJob.js         — stream URL health checker
  finishedMatchCleanupJob.js — match lifecycle manager
```

---

## Data Sources / Tabs

| Tab slug     | Source         | Method              | Notes                              |
|--------------|----------------|---------------------|------------------------------------|
| `main-live`  | streamed.su API| HTTP JSON           | syncMatches.js                     |
| `soco-live`  | socolive site  | Playwright scrape   | socoliveSyncJob.js                 |
| `china-live` | yyzbw8.live    | Playwright scrape   | chinaliveSyncJob.js + pre-warm     |
| `english`    | filtered view  | DB query            | English commentary matches only    |
| TV & Radio   | manual entry   | Admin UI            | geo-restricted, entered manually   |

---

## Scraper Scheduler System

Both scraper jobs (`socoliveSyncJob`, `chinaliveSyncJob`) run a `setTimeout` tick loop. On every tick:

1. Read `sources` table row for their slug — get `config` (JSONB) and `is_active`
2. Read `tabs` table — check tab `is_active`
3. Call `isWithinActiveHours(config)` from `src/config/scraperSchedule.js`
4. If outside the window → log "Skipped" and set next timer. No DB writes, no Redis reads, no Playwright launch.
5. Check `scraperState.isRunning(slug)` — skip if already running
6. Run the scraper, update `scraperState`
7. Reschedule: `setTimeout(tick, config.sync_interval_ms ?? DEFAULT)`

**Schedule config shape** (stored in `sources.config` JSONB):
```json
{
  "active_hours": { "from": "18:00", "to": "09:00" },
  "sync_interval_ms": 300000
}
```
- If `active_hours` is absent → runs 24/7
- Overnight windows supported: `from > to` wraps midnight (e.g. 18:00→09:00 = evenings + night, skip daytime)
- Changes take effect on the **next tick** — no restart needed

**Admin endpoints for scheduler:**
```
GET  /api/admin/scrapers/:slug/schedule   — read active_hours + sync_interval_ms
PUT  /api/admin/scrapers/:slug/schedule   — update (merges into config, leaves other keys intact)
```

**China Live special logic** (`chinaliveSyncJob.js`):
- Schedule sync: every 6 hours (syncs today's match list from the API)
- Pre-warm: 10 min before kickoff → scrapes stream URLs and writes to Redis
- Re-warm: every 15 min while match is `live` → refreshes expiring CDN tokens
- Redis stream cache TTL: 16 min (`streams:{matchId}`)

---

## Stream URL Flow

```
User requests /api/streams/:matchId
  → check Redis key  streams:{matchId}
  → if HIT: return cached grouped { SD: [...], HD: [...] }
  → if MISS: query DB stream_urls, build grouped, cache 16 min
  → if no streams exist: trigger on-demand scrape (chinalive only), wait up to 15s
  → URLs are proxied: m3u8 → /api/proxy/stream/:id, FLV → /api/proxy/flv/:id
```

Stream proxy (`src/routes/proxy.js`):
- In-memory cache avoids DB round-trip on every HLS playlist refresh
- China CDN: SSL bypass (`rejectUnauthorized: false`) + Referer/Origin headers
- Image proxy: validates content-type, max 2 MB

---

## Health Check Job (`urlHealthJob.js`)

- Runs every 5 min (configurable via `app_config.health`)
- Checks up to 25 `is_healthy = true` streams per tick
- HEAD request first; falls back to GET with `Range: bytes=0-1`
- China CDNs use dedicated `checkChinaUrl` (https module, SSL bypass)
- Browser-only URLs (embed iframes, CDN auth-key URLs) → skipped, just update `last_checked`
- If `fail_count >= threshold` → marks unhealthy, triggers re-scrape of that source
- Also expires CDN URLs where `expires_at < NOW()`

---

## Match Lifecycle (`finishedMatchCleanupJob.js`)

- Runs every 20 min
- `scheduled` → `finished` if kickoff was > 2 hours ago and still not live
- `live` → `finished` if live for > 6 hours (stuck-live guard)
- Deletes `finished` matches older than 24 hours (retention window)
- All thresholds configurable via `app_config.cleanup`

---

## Subscription & Auth System

**User flow:**
1. User sends `/subscribe` to Telegram bot
2. Bot shows plans, user picks one, sends payment proof
3. Admin verifies in `localhost:3000/admin/subscriptions/transactions`
4. Admin approves → `generateDeviceToken(userId)` called → bot sends activation URL
5. User opens URL → frontend stores `device_token` in localStorage
6. Every page load → `GET /api/auth/check?token=TOKEN` → returns `{ is_premium, expires_at, plan_name }`

**Admin JWT auth:**  
`POST /api/admin/login` → 24h JWT → `Authorization: Bearer <token>` on all `/api/admin/*` calls

**Subscription cache:** `sub:{telegram_id}` in Redis (busted on approve/reject)

---

## Database Key Tables

| Table                | Purpose                                      |
|----------------------|----------------------------------------------|
| `tabs`               | Categories (soco-live, china-live, etc.)     |
| `sources`            | Scraper config per source (URLs, schedule)   |
| `matches`            | All matches with status + scores             |
| `stream_urls`        | CDN URLs per match (SD/HD, health, expiry)   |
| `app_config`         | Key-value config (health, cleanup settings)  |
| `tg_users`           | Telegram users + device tokens               |
| `subscriptions`      | Active subscription records                  |
| `subscription_plans` | Plan definitions (price, duration)           |
| `transactions`       | Payment records awaiting admin verification  |
| `tv_channels`        | Manual TV & Radio stream entries             |

---

## Admin Panel Pages (`localhost:3000/admin`)

| Page          | Route                                | Purpose                                      |
|---------------|--------------------------------------|----------------------------------------------|
| Dashboard     | `/admin`                             | Stats, scraper status, per-tab counts        |
| Matches       | `/admin/matches`                     | Add / edit / delete matches & stream URLs    |
| TV & Radio    | `/admin/tv`                          | Manual TV channel management                 |
| Sources       | `/admin/sources`                     | Scraper URLs + IP ban check                  |
| Scheduler     | `/admin/scrapers`                    | Active hours + sync interval per scraper     |
| Config        | `/admin/config`                      | app_config key-value editor                  |
| Tests         | `/admin/tests`                       | Run API test suite                           |
| Plans         | `/admin/subscriptions/plans`         | Subscription plan management                 |
| Members       | `/admin/subscriptions/members`       | User list + subscription status              |
| Transactions  | `/admin/subscriptions/transactions`  | Approve / reject payment proofs              |

---

## Environment Variables

```bash
# Backend (football-app/.env)
DATABASE_URL=           # Neon PostgreSQL connection string
REDIS_URL=              # Upstash Redis URL (omit → in-memory fallback)
PORT=3050
NODE_ENV=production
JWT_SECRET=             # Admin panel JWT signing secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=         # Admin panel login password
BACKEND_URL=            # Public backend URL (used in proxy URLs)
WEBSITE_URL=            # Frontend URL (used in activation links)
BOT_TOKEN=              # Telegram bot token
N8N_WEBHOOK_SECRET=     # Shared secret for n8n subscription webhook
DIRECT_STREAMS=false    # true = return raw CDN URLs, no proxy

# Frontend (streamzone/.env.local)
NEXT_PUBLIC_API_URL=http://localhost:3050
```

---

## Coding Standards

- Always `async/await` — never raw `.then()` chains in new code
- Check Redis before every DB query (cache-first)
- All secrets via environment variables — never hardcoded
- Error handling on every DB and API call — log with `[jobName]` prefix
- Do not push to git without running locally first
- Do not `git push` without explicit user approval
