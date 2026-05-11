const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({ userAgent: UA });
  const page    = await context.newPage();

  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'font', 'stylesheet', 'media'].includes(type)) route.abort();
    else route.continue();
  });

  await page.goto('https://www.barbaramassaad.com/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('.match-item', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const matches = await page.$$eval('.match-item', (cards, baseUrl) =>
    cards.slice(0, 5).map((card) => {
      const homeTeam    = card.querySelector('.match-home .name-team-inner span')?.textContent.trim() || '';
      const awayTeam    = card.querySelector('.match-away .name-team-inner span')?.textContent.trim() || '';
      const rawTime     = card.querySelector('.match-item__time span')?.textContent.trim() || null;
      const competition = card.querySelector('.match-item__comp')?.textContent.trim() || null;
      const href        = card.querySelector('a.link-match')?.getAttribute('href') || null;
      const isLive      = card.getAttribute('is-live') === '1';
      const hasLive     = card.getAttribute('has-live') === '1';
      const sourceId    = card.getAttribute('data-match-id') || null;
      const matchUrl    = href ? (href.startsWith('http') ? href : `${baseUrl}${href}`) : null;
      return { homeTeam, awayTeam, rawTime, competition, isLive, hasLive, sourceId, matchUrl };
    }),
    'https://www.barbaramassaad.com'
  );

  console.log(`Found ${matches.length} (showing first 5):\n`);
  matches.forEach((m, i) => {
    console.log(`[${i}] ${m.homeTeam} vs ${m.awayTeam}`);
    console.log(`     live=${m.isLive} hasLive=${m.hasLive} time=${m.rawTime} comp=${m.competition}`);
    console.log(`     id=${m.sourceId} url=${m.matchUrl}\n`);
  });

  // Test stream fetch on first live match
  const live = matches.find((m) => m.isLive && m.hasLive && m.matchUrl);
  if (live) {
    console.log(`\n=== Testing stream fetch: ${live.homeTeam} vs ${live.awayTeam} ===`);
    const { fetchStreamUrls } = require('./src/scrapers/socolive');
    const streams = await fetchStreamUrls(live.matchUrl);
    console.log(`\nStreams found: ${streams.length}`);
    streams.forEach((s, i) => console.log(`  [${i}] [${s.quality}] ${s.url}`));
  } else {
    console.log('\nNo live match with stream available right now.');
  }

  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
