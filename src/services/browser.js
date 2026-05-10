const { chromium } = require('playwright');

let browserInstance = null;

const getBrowser = async () => {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run'
    ]
  };

  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }

  browserInstance = await chromium.launch(launchOptions);

  browserInstance.on('disconnected', () => {
    browserInstance = null;
  });

  return browserInstance;
};

const newPage = async (extraHeaders = {}) => {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: extraHeaders
  });
  const page = await context.newPage();
  return { page, context };
};

const closeBrowser = async () => {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
};

module.exports = { getBrowser, newPage, closeBrowser };
