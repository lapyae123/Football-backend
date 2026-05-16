const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const db = require('../config/database');

chromium.use(StealthPlugin());

const BASE_SITE = 'https://www.myanmartvchannels.com';

// Map: tv_channels.slug → page path on myanmartvchannels.com
const CHANNEL_PAGES = {
  'mrtv':            '/mrtv.html',
  'mrtv4':           '/mrtv4.html',
  'channel7':        '/channel-7.html',
  'channel9':        '/channel9.html',
  '5plus':           '/5-plus-channel.html',
  'dvb':             '/dvb.html',
  'mitv':            '/mitv.html',
  'mntv':            '/mrtv-news.html',
  'nrc':             '/nrc.html',
  'maharbawdi':      '/mahar-bawdi.html',
  'mrtv-sport':      '/mrtv-sport.html',
  'mrtv-ent':        '/mrtv-entertainment.html',
};

const isStreamUrl = (url) => {
  if (!url || url.length > 3000) return false;
  return (url.includes('.m3u8') || url.includes('.flv') || url.includes('/hls/')) &&
         !url.includes('.ts');
};

// Visit one channel page and intercept the m3u8 stream URL
const fetchStreamUrl = async (browser, pageUrl) => {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
  });

  const found = new Set();

  // Capture ALL network requests including from iframes
  ctx.on('request',  (req) => { if (isStreamUrl(req.url()))  found.add(req.url()); });
  ctx.on('response', (res) => { if (isStreamUrl(res.url()))  found.add(res.url()); });

  try {
    const page = await ctx.newPage();

    // Don't block media — we need to capture the stream request
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (['image', 'font', 'stylesheet'].includes(t)) return route.abort();
      route.continue();
    });

    await page.goto(`${BASE_SITE}${pageUrl}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Find all iframes and open each one in a new page to trigger their players
    const iframeSrcs = await page.$$eval('iframe[src]',
      (els) => els.map((e) => e.src).filter((s) => s && s.startsWith('http'))
    ).catch(() => []);

    for (const src of iframeSrcs) {
      try {
        const iframePage = await ctx.newPage();
        await iframePage.goto(src, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
        await iframePage.waitForTimeout(4000);

        // Click play inside the iframe page
        const playSelectors = [
          '.jw-icon-display', '.vjs-big-play-button', '.play-btn',
          '[class*="play"]', 'video', '.fp-play', '[id*="play"]',
        ];
        for (const sel of playSelectors) {
          try {
            const el = await iframePage.$(sel);
            if (el) { await el.click({ timeout: 2000 }); break; }
          } catch (_) {}
        }
        await iframePage.waitForTimeout(3000);
        await iframePage.close().catch(() => {});
      } catch (_) {}
    }

    // Also try clicking play on the main page
    const playSelectors = [
      '.jw-icon-display', '.vjs-big-play-button', '.play-btn',
      '[class*="play"]', 'video', '.fp-play',
    ];
    for (const sel of playSelectors) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click({ timeout: 2000 }); break; }
      } catch (_) {}
    }
    await page.waitForTimeout(3000);

    return [...found];
  } catch (err) {
    console.warn(`[myanmarTv] Error visiting ${pageUrl}: ${err.message}`);
    return [];
  } finally {
    await ctx.close().catch(() => {});
  }
};

// Run: scrape all channel pages and update stream_url in tv_channels
const run = async () => {
  console.log('[myanmarTv] Starting scrape…');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  let updated = 0;
  const slugs = Object.keys(CHANNEL_PAGES);

  for (const slug of slugs) {
    const pagePath = CHANNEL_PAGES[slug];
    try {
      console.log(`[myanmarTv] Scraping ${slug} (${pagePath})…`);
      const urls = await fetchStreamUrl(browser, pagePath);

      if (urls.length === 0) {
        console.warn(`[myanmarTv] No stream found for ${slug}`);
        continue;
      }

      // Prefer m3u8 over flv; prefer https
      const best = urls.sort((a, b) => {
        const score = (u) => (u.includes('https') ? 2 : 0) + (u.includes('.m3u8') ? 1 : 0);
        return score(b) - score(a);
      })[0];

      await db.query(
        'UPDATE tv_channels SET stream_url = $1, updated_at = NOW() WHERE slug = $2',
        [best, slug]
      );
      console.log(`[myanmarTv] ✓ ${slug}: ${best.slice(0, 80)}…`);
      updated++;

      // Small delay between pages to be polite
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[myanmarTv] Error for ${slug}: ${err.message}`);
    }
  }

  await browser.close().catch(() => {});
  console.log(`[myanmarTv] Done — ${updated}/${slugs.length} channels updated`);
  return updated;
};

module.exports = { run };
