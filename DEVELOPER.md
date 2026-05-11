# Football App — Developer Notes (မြန်မာဘာသာ)

---

## Project Structure

```
football-app/   ← Backend (Node.js + Fastify, port 3050)
streamzone/     ← Frontend (Next.js, port 3000)
```

---

## ၁. Scraping Logic — ဘယ်လိုအလုပ်လုပ်လဲ

### SOCO Live (`src/scrapers/socolive.js`)

Playwright headless Chrome သုံးပြီး page ၂ ဆင့် visit လုပ်တယ်။

**ဆင့် ၁ — Match List**
`https://www.socolive.tv/` homepage ကိုဖွင့်ပြီး `.match-item` CSS selector ကနေ ပွဲတွေ (team name, logo, time, status, score) ထုတ်ယူတယ်။ Fallback URL: `https://www.barbaramassaad.com`

**ဆင့် ၂ — Stream URLs (Live ပွဲတွေအတွက်သာ)**
Individual match page ကိုသွားပြီး:
1. Network request intercept လုပ်ပြီး `.m3u8` / `.flv` URL ဖမ်းတယ်
2. iframe တွေကို real page အဖြစ် ဖွင့်ပြီး play button click လုပ်တယ်
3. မတွေ့ရင် page HTML source ကို regex နဲ့ ရှာတယ်

Live ဖြစ်နေတဲ့ ပွဲ (သို့) kickoff မတိုင်မှီ ၃၀ မိနစ်အတွင်း ပွဲတွေကိုသာ stream fetch လုပ်တယ်။

---

### China Live (`src/scrapers/chinalive.js`)

Browser မလိုဘူး — JSON API ကို HTTP request တိုက်ရိုက်ခေါ်တယ်။

**API ၃ ခု concurrent ဆွဲတယ်:**

```
GET https://json.yyzb456.top/all_live_rooms.json              → live ပွဲစာရင်း (roomNum, title)
GET https://json.yyzb456.top/match/matches_YYYYMMDD.json      → ပွဲဇယား + team logo (per-team badge)
GET https://json.yyzb456.top/room/{roomNum}/detail.json       → stream URLs
```

**Team Logo ရပုံ (Key Logic):**
- `matches_YYYYMMDD.json` ထဲမှာ `anchors[].anchor.roomNum` ပါတယ်
- `all_live_rooms.json` ကနေ roomNum ကိုသုံးပြီး schedule entry lookup လုပ်တယ်
- Schedule hit → `hostIcon` (home badge) + `guestIcon` (away badge) ကို logo အဖြစ်သုံးတယ်
- Logo URL: `https://sta.yyzb456.top/file/imgs/team/football/...` (proper team badges)
- Schedule miss → title parse + broadcast cover image ကို fallback အဖြစ်သုံးတယ်

**Stream URL ထုတ်ယူပုံ:**
- Known fields: `hdM3u8` (HD), `m3u8` (SD), `hdFlv` (HD), `flv` (SD)
- Fallback: stream object ထဲက field တိုင်းကို scan လုပ်ပြီး `.m3u8` / `.flv` URL ပါတာ ယူတယ်
- `hd`, `high`, `1080`, `720` keyword ပါတဲ့ field → HD အဖြစ် classify

Sports category (`liveTypeParent=1`) + live status (`liveStatus=1`) ပွဲတွေကိုသာ စစ်ထုတ်တယ်။

---

## ၂. Database — Stream URL သိမ်းပုံ

`stream_urls` table:

| Field | အဓိပ္ပါယ် |
|---|---|
| `quality` | `HD` သို့မဟုတ် `SD` |
| `priority` | HD=2, SD=1 |
| `is_healthy` | scrape ချိန်မှာ `true` |
| `expires_at` | SOCO: token expiry (auth_key) သို့မဟုတ် +2 hours; China: +50 minutes |
| `fail_count` | health check fail ရေ |

Frontend က stream query လုပ်ရင် SD ဦးစွာ၊ ပြီးမှ HD၊ latency နည်းတာ ဦးစားပေး (SD ကနေ စတင်ကြည့်တာ ပိုကောင်းတဲ့ UX)

---

## ၃. Health Check (`src/jobs/urlHealthJob.js`)

**Interval: 10 မိနစ်တစ်ကြိမ်**

- DB ထဲက `is_healthy=true` stream တွေကို HEAD request ဆက်ပို့ပြီး စစ်တယ်
- Response မလာ / error → `fail_count++`
- **`fail_count >= 10`** ဆိုမှ `is_healthy = false` → dead mark
- SOCO stream fail → `rerunSoco()` re-scrape
- China stream fail → `rerunChina()` re-scrape
- Expired URL (`expires_at < NOW()`) → `is_healthy = false`

---

## ၄. Playback Logic — Frontend

### Network Tier Detection (`VideoPlayer.js`)

User ဝင်တဲ့အချိန် `navigator.connection` ကိုကြည့်ပြီး network tier ဆုံးဖြတ်တယ်:

```
4G + downlink > 4 Mbps  →  "fast"   → buffer 60s,  auto quality
3G / downlink < 2 Mbps  →  "slow"   → buffer 90s,  SD ကနေစ, ABR conservative
ကြားက               →  "medium"
```

### Server Order

```
allUrls = [SD 1, SD 2, ..., HD 1, HD 2, ...]
```

SD ဦးစွာ auto select လုပ်တယ်။ User bandwidth ကောင်းရင် HD ကို ကိုယ်တိုင် ရွေးနိုင်တယ်။

### Auto Switch (Silent)

Link error ဖြစ်ရင် — user ဘာမှ မနှိပ်ရဘဲ — next server ကို auto switch လုပ်တယ်:

```
Error ဖြစ်
    ↓
next server ရှိသေးလား?
    ├── ရှိတယ် → spinner ပြ၊ next server ကို silently switch
    └── မရှိ  → "Stream unavailable" error screen ပြ
```

Error ရှာပုံ (မည်သည့်အချိန်မဆို trigger ဖြစ်နိုင်):
- Stream load 40 seconds ထဲ မရောက်
- HLS / FLV fatal error
- Video `currentTime` 40 seconds ကြာ မပြောင်း (stall)

### Manual Server Select

`ServerSelector` component က SD/HD button grid ပြတယ်။ User ရွေးရင် `localStorage` မှာ သိမ်းထားတဲ့အတွက် page refresh / browser ပြန်ဖွင့်ပါ — **ရွေးထားတဲ့ server ကပဲ ပြန်ဖွင့်တယ်**။

### Exhausted State

Server အားလုံး fail ဆိုမှ error screen ပြ + ServerSelector ဖြင့် user ကိုယ်တိုင် ထပ်ရွေးနိုင်တယ်။ Streams ၆၀ seconds တစ်ကြိမ် refresh ဖြစ်ရင် exhausted state ကို reset လုပ်တယ် (scraper က URL သစ်ရလာနိုင်လို့)။

### Live Catchup

Live stream မှာ lag > 8 seconds ဆိုရင် `currentTime` ကို live edge ကို auto jump တယ် (4 seconds တစ်ကြိမ် check)။

---

## ၅. Tabs / Categories

| Tab | Source | Scrape Method |
|---|---|---|
| Main Live | streamed.su API | API call |
| SOCO Live | socolive.tv | Playwright browser |
| China Live | yyzbw8.live / yyzb456.top | HTTP JSON API |
| Loungsan | aggregated | multiple sources |
| English | filtered | commentary filter |

---

## ၆. Caching

- Stream list: Redis `EX 30` seconds
- Match list: Redis cache → DB query fallback
- Cache invalidate: sync job run တိုင်း `streams:{matchId}` key delete

---

## ၇. Environment Variables

```env
SOCO_BASE_URL          # default: https://www.socolive.tv
SOCO_BASE_URL_2        # fallback: https://www.barbaramassaad.com
HEALTH_CHECK_INTERVAL_MS  # default: 600000 (10 min)
HEALTH_FAIL_THRESHOLD     # default: 10
DATABASE_URL           # PostgreSQL (Neon)
REDIS_URL              # Upstash Redis
```

---

## ၈. Dev Commands

```bash
# Backend start
cd football-app && npm run dev

# Frontend start
cd streamzone && npm run dev
```

---

_ဤ file ကို app logic ပြောင်းတိုင်း update လုပ်ပေးပါ။_
