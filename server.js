// PRF Management — FTA Portal AI Agent
// Logs into UAE FTA portal with PRF credentials
// Searches clients by TRN, scrapes compliance data
// Runs as a persistent Express server (Railway / Render / VPS)

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const puppeteer  = require('puppeteer-core');

const app  = express();
const PORT = process.env.PORT || 3001;
console.log('Starting on PORT:', PORT);

app.use(cors({ origin: process.env.PORTAL_URL || '*' }));
app.use(express.json());

// ── BROWSER STATE ─────────────────────────────────────────────────────────────
let browser     = null;
let page        = null;
let isLoggedIn  = false;
let lastActivity = Date.now();

const FTA_URL    = 'https://eservices.tax.gov.ae/#/Logon';
const FTA_USER   = process.env.FTA_USERNAME;   // PRF's one FTA login
const FTA_PASS   = process.env.FTA_PASSWORD;   // PRF's FTA password
const API_KEY    = process.env.AGENT_API_KEY;  // Secret key portal uses to call this

// ── LAUNCH BROWSER ────────────────────────────────────────────────────────────
async function launchBrowser() {
  if (browser) return;
  console.log('🚀 Launching browser...');
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium' || '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,800'
    ]
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  console.log('✅ Browser ready');
}

// ── LOGIN TO FTA PORTAL ───────────────────────────────────────────────────────
async function loginToFTA() {
  if (isLoggedIn) {
    // Check if session still alive
    try {
      await page.goto(FTA_URL, { waitUntil: 'networkidle2', timeout: 15000 });
      const url = page.url();
      if (!url.includes('Logon') && !url.includes('login')) {
        console.log('✅ Session still active');
        return { success: true, message: 'Session active' };
      }
    } catch {}
    isLoggedIn = false;
  }

  console.log('🔐 Logging into FTA portal...');
  try {
    await page.goto(FTA_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Wait for login form
    await page.waitForSelector('input[type="text"], input[id*="user"], input[name*="user"], input[placeholder*="user"]', { timeout: 15000 });

    // Fill username
    const usernameField = await page.$('input[type="text"]') ||
                          await page.$('input[id*="username"]') ||
                          await page.$('input[name*="username"]');
    if (!usernameField) throw new Error('Username field not found');
    await usernameField.click({ clickCount: 3 });
    await usernameField.type(FTA_USER, { delay: 80 });

    // Fill password
    const passwordField = await page.$('input[type="password"]');
    if (!passwordField) throw new Error('Password field not found');
    await passwordField.click({ clickCount: 3 });
    await passwordField.type(FTA_PASS, { delay: 80 });

    // Click login button
    const loginBtn = await page.$('button[type="submit"]') ||
                     await page.$('input[type="submit"]') ||
                     await page.$('button[id*="login"]') ||
                     await page.$('button[class*="login"]');
    if (!loginBtn) throw new Error('Login button not found');
    await loginBtn.click();

    // Wait for navigation
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
    await page.waitForTimeout(2000);

    const afterUrl = page.url();
    if (afterUrl.includes('Logon') || afterUrl.includes('login')) {
      // Still on login page — check for error message
      const errorMsg = await page.$eval(
        '[class*="error"], [class*="alert"], [class*="message"]',
        el => el.textContent.trim()
      ).catch(() => 'Login failed — check credentials');
      throw new Error(errorMsg);
    }

    isLoggedIn = true;
    lastActivity = Date.now();
    console.log('✅ Logged into FTA portal. URL:', afterUrl);
    return { success: true, message: 'Logged in successfully' };

  } catch (err) {
    isLoggedIn = false;
    console.error('❌ FTA login failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ── SEARCH CLIENT BY TRN ─────────────────────────────────────────────────────
async function searchClientByTRN(trn) {
  console.log(`🔍 Searching TRN: ${trn}`);

  try {
    // Navigate to tax returns / registrant search section
    // FTA portal paths vary — try common navigation
    const searchUrls = [
      'https://eservices.tax.gov.ae/#/TaxAgentMenu',
      'https://eservices.tax.gov.ae/#/ManageClients',
      'https://eservices.tax.gov.ae/#/ClientList',
    ];

    let navigated = false;
    for (const url of searchUrls) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
        await page.waitForTimeout(1500);
        navigated = true;
        break;
      } catch {}
    }

    // Look for search input on current page
    const searchInput = await page.$('input[placeholder*="TRN"], input[placeholder*="trn"], input[placeholder*="Tax"], input[id*="search"], input[name*="search"]');

    if (searchInput) {
      await searchInput.click({ clickCount: 3 });
      await searchInput.type(trn, { delay: 100 });

      // Press Enter or click search button
      const searchBtn = await page.$('button[class*="search"], button[type="submit"]');
      if (searchBtn) await searchBtn.click();
      else await searchInput.press('Enter');

      await page.waitForTimeout(3000);
    }

    lastActivity = Date.now();
    return { found: true, trn, navigated };

  } catch (err) {
    return { found: false, error: err.message };
  }
}

// ── SCRAPE CLIENT COMPLIANCE DATA ────────────────────────────────────────────
async function scrapeComplianceData(trn) {
  const result = {
    trn,
    scrapedAt:    new Date().toISOString(),
    vatReturns:   [],
    penalties:    [],
    openFilings:  [],
    notices:      [],
    rawText:      '',
    screenshot:   null
  };

  try {
    // Take screenshot for reference
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
    result.screenshot = `data:image/png;base64,${screenshot}`;

    // Get all text content from the page
    result.rawText = await page.evaluate(() => document.body.innerText.slice(0, 3000));

    // Try to extract structured data
    // VAT return rows (look for table rows with date/period/status patterns)
    const tableData = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      const rows = [];
      tables.forEach(table => {
        table.querySelectorAll('tr').forEach(row => {
          const cells = Array.from(row.querySelectorAll('td, th')).map(c => c.innerText.trim());
          if (cells.length > 0) rows.push(cells);
        });
      });
      return rows.slice(0, 50);
    });

    // Parse table rows into VAT returns
    tableData.forEach((row, i) => {
      const joined = row.join(' ').toLowerCase();
      if (joined.includes('vat') || joined.includes('return') || joined.includes('period')) {
        result.vatReturns.push({
          rowIndex: i,
          data: row,
          raw: row.join(' | ')
        });
      }
      if (joined.includes('penalty') || joined.includes('fine') || joined.includes('overdue')) {
        result.penalties.push({ rowIndex: i, data: row });
      }
    });

    // Check for open/outstanding items
    const pageText = result.rawText.toLowerCase();
    if (pageText.includes('outstanding') || pageText.includes('overdue') || pageText.includes('pending')) {
      result.hasOutstandingItems = true;
    }
    if (pageText.includes('penalty') || pageText.includes('fine')) {
      result.hasPenalties = true;
    }

    result.allTableRows = tableData;
    return result;

  } catch (err) {
    result.error = err.message;
    return result;
  }
}

// ── API MIDDLEWARE ────────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (API_KEY && key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status:       'ok',
    browserReady:  !!browser,
    loggedIn:      isLoggedIn,
    lastActivity:  new Date(lastActivity).toISOString(),
    fta_user:      FTA_USER ? FTA_USER.slice(0, 5) + '***' : 'not set',
    port:          PORT
  });
});

// Root route — Railway sometimes checks /
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'PRF FTA Agent' });
});

// Login to FTA portal
app.post('/api/login', authenticate, async (req, res) => {
  try {
    await launchBrowser();
    const result = await loginToFTA();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check login status + screenshot
app.get('/api/status', authenticate, async (req, res) => {
  try {
    if (!browser || !page) {
      return res.json({ loggedIn: false, message: 'Browser not started' });
    }
    const url        = await page.url();
    const screenshot = await page.screenshot({ encoding: 'base64' });
    res.json({
      loggedIn:  isLoggedIn,
      currentUrl: url,
      screenshot: `data:image/png;base64,${screenshot}`,
      lastActivity: new Date(lastActivity).toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search client by TRN and return compliance data
app.get('/api/client/:trn', authenticate, async (req, res) => {
  const { trn } = req.params;
  if (!trn || trn.length !== 15) {
    return res.status(400).json({ error: 'TRN must be 15 digits' });
  }

  try {
    await launchBrowser();

    // Auto-login if session expired
    if (!isLoggedIn) {
      const loginResult = await loginToFTA();
      if (!loginResult.success) {
        return res.status(401).json({ error: 'FTA login failed: ' + loginResult.error });
      }
    }

    // Search for client
    await searchClientByTRN(trn);

    // Scrape data
    const data = await scrapeComplianceData(trn);
    res.json({ success: true, data });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scan multiple clients (batch)
app.post('/api/scan-batch', authenticate, async (req, res) => {
  const { clients } = req.body; // [{ name, trn }, ...]
  if (!clients || !Array.isArray(clients)) {
    return res.status(400).json({ error: 'Provide clients array: [{ name, trn }]' });
  }

  try {
    await launchBrowser();
    if (!isLoggedIn) {
      const loginResult = await loginToFTA();
      if (!loginResult.success) return res.status(401).json({ error: loginResult.error });
    }

    const results = [];
    for (const client of clients.slice(0, 10)) { // max 10 per batch
      console.log(`📋 Scanning: ${client.name} (${client.trn})`);
      await searchClientByTRN(client.trn);
      const data = await scrapeComplianceData(client.trn);
      results.push({ name: client.name, trn: client.trn, ...data });
      await page.waitForTimeout(2000); // Polite delay between requests
    }

    res.json({ success: true, results, count: results.length });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Take screenshot of current FTA page
app.get('/api/screenshot', authenticate, async (req, res) => {
  try {
    if (!page) return res.status(400).json({ error: 'Browser not started' });
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
    res.json({ screenshot: `data:image/png;base64,${screenshot}`, url: page.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logout and close browser
app.post('/api/logout', authenticate, async (req, res) => {
  try {
    if (browser) { await browser.close(); browser = null; page = null; isLoggedIn = false; }
    res.json({ success: true, message: 'Browser closed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AUTO-REFRESH SESSION every 30 minutes ────────────────────────────────────
setInterval(async () => {
  if (isLoggedIn && Date.now() - lastActivity > 25 * 60 * 1000) {
    console.log('🔄 Refreshing FTA session...');
    try {
      await page.goto(FTA_URL, { waitUntil: 'networkidle2', timeout: 15000 });
      const url = page.url();
      if (url.includes('Logon') || url.includes('login')) {
        isLoggedIn = false;
        console.log('⚠️ Session expired — will re-login on next request');
      } else {
        console.log('✅ Session refreshed');
      }
    } catch {}
  }
}, 30 * 60 * 1000);

// ── START SERVER ──────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🏢 PRF FTA Agent running on port ${PORT}`);
  console.log(`📋 FTA User: ${FTA_USER ? FTA_USER.slice(0,5)+'***' : '⚠️ NOT SET'}`);
  console.log(`🔑 API Key: ${API_KEY ? '✅ Set' : '⚠️ NOT SET — all requests allowed'}`);
  console.log(`\n📡 Endpoints:`);
  console.log(`   GET  /health`);
  console.log(`   POST /api/login`);
  console.log(`   GET  /api/status`);
  console.log(`   GET  /api/client/:trn`);
  console.log(`   POST /api/scan-batch`);
  console.log(`   GET  /api/screenshot\n`);

  // Browser launches on first API request — not on startup
  // This lets Railway health check pass immediately
  console.log('⏳ Browser will launch on first /api/login request');
});
