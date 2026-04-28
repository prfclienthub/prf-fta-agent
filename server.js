// PRF Management — FTA Portal AI Agent
// Logs into UAE FTA portal with PRF credentials
// Searches clients by TRN, scrapes compliance data
// Runs as a persistent Express server (Railway / Render / VPS)

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const puppeteer  = require('puppeteer-core');

// Claude Vision API for CAPTCHA reading
async function readCaptcha(captchaBase64) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 50,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: captchaBase64 } },
            { type: 'text', text: 'Look at this CAPTCHA image carefully. It contains ONLY digits (numbers 0-9). Read the digits and reply with ONLY those digits, nothing else. No letters, no spaces, no explanation. Just the numbers.' }
          ]
        }]
      })
    });
    const data = await response.json();
    // Extract only digits from response
    const raw = data.content?.[0]?.text?.trim() || '';
    const code = raw.replace(/[^0-9]/g, ''); // strip any non-digits
    console.log('🤖 Claude CAPTCHA raw:', raw, '→ digits only:', code);
    return code || null;
  } catch(e) {
    console.error('CAPTCHA read failed:', e.message);
    return null;
  }
}

const app  = express();
const PORT = process.env.PORT || 3001;
console.log('Starting on PORT:', PORT);

app.use(cors()); // Allow all origins
app.use(express.json());

// ── BROWSER STATE ─────────────────────────────────────────────────────────────
let browser     = null;
let page        = null;
let isLoggedIn  = false;
let currentFtaUser = null;
let lastActivity = Date.now();

const FTA_URL = 'https://eservices.tax.gov.ae/#/Logon';
const API_KEY = process.env.AGENT_API_KEY; // Secret key — set in Railway Variables

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

// ── LOGIN TO FTA PORTAL — credentials passed per request ──────────────────────
async function loginToFTA(username, password) {
  const ftaUser = username || process.env.FTA_USERNAME;
  const ftaPass = password || process.env.FTA_PASSWORD;

  if (!ftaUser || !ftaPass) {
    return { success: false, error: 'FTA credentials not provided. Enter username and password in the portal.' };
  }

  // Check if already logged in
  if (isLoggedIn) {
    try {
      const url = page.url();
      if (!url.includes('Logon') && !url.includes('login') && !url.includes('UAE_PASS')) {
        console.log('✅ Session still active');
        return { success: true, message: 'Session active' };
      }
    } catch {}
    isLoggedIn = false;
  }

  console.log('🔐 Navigating to FTA portal as:', ftaUser.slice(0,5) + '***');

  try {
    // Step 1: Go to FTA portal
    await page.goto('https://eservices.tax.gov.ae/#/Logon', {
      waitUntil: 'networkidle2', timeout: 30000
    });
    await page.waitForTimeout(3000);
    console.log('📄 FTA page loaded. URL:', page.url());

    // Take screenshot to see what we have
    const shot1 = await page.screenshot({ encoding: 'base64' });
    console.log('📸 Initial screenshot taken');

    // Step 2: Click "Login here" (Non UAE PASS users link)
    // Try multiple selectors for this link
    const loginLinkSelectors = [
      'a[href*="login"]',
      'a:contains("Login here")',
      'a[href*="Logon"]',
      '.login-link',
      'a[ng-click*="login"]',
    ];

    let clicked = false;

    // Use page.evaluate to find and click the "Login here" link
    clicked = await page.evaluate(() => {
      // Find all links and look for "Login here" text
      const links = Array.from(document.querySelectorAll('a'));
      const loginLink = links.find(a =>
        a.textContent.includes('Login here') ||
        a.textContent.includes('login here') ||
        a.textContent.toLowerCase().includes('non uae pass') ||
        a.href.includes('username') ||
        a.href.includes('credentials')
      );
      if (loginLink) {
        loginLink.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      // Try XPath
      const [loginHereLink] = await page.$x('//a[contains(text(), "Login here") or contains(text(), "login here")]');
      if (loginHereLink) {
        await loginHereLink.click();
        clicked = true;
        console.log('✅ Clicked Login here via XPath');
      }
    }

    if (!clicked) {
      console.log('⚠️ Could not find Login here link — trying direct URL');
      // Try navigating directly to the credentials login page
      await page.goto('https://eservices.tax.gov.ae/#/Logon', { waitUntil: 'networkidle2', timeout: 15000 });
    }

    await page.waitForTimeout(2000);
    console.log('📄 After clicking Login here. URL:', page.url());

    // Step 3: Wait for username/password form to appear
    try {
      await page.waitForSelector('input[type="text"], input[type="email"], input[name*="user"], input[id*="user"], input[placeholder*="user"], input[placeholder*="email"]',
        { timeout: 10000 });
    } catch {
      console.log('⚠️ No text input found after clicking Login here');
      // Take screenshot to see current state
      const shot2 = await page.screenshot({ encoding: 'base64' });
      console.log('📸 Screenshot after login click taken');
    }

    // Step 4: Fill email
    const emailField = await page.$('input[type="email"]') ||
                       await page.$('input[placeholder*="E-Mail"]') ||
                       await page.$('input[placeholder*="email"]') ||
                       await page.$('input[placeholder*="Email"]') ||
                       await page.$('input[type="text"]');

    if (!emailField) {
      const pageText = await page.evaluate(() => document.body.innerText.slice(0,300));
      throw new Error('Email field not found. Page: ' + pageText);
    }
    await emailField.click({ clickCount: 3 });
    await emailField.type(ftaUser, { delay: 100 });
    console.log('✅ Email filled');

    // Step 5: Fill password
    const passwordField = await page.$('input[type="password"]');
    if (!passwordField) throw new Error('Password field not found');
    await passwordField.click({ clickCount: 3 });
    await passwordField.type(ftaPass, { delay: 100 });
    console.log('✅ Password filled');

    // Step 6: Read and fill CAPTCHA using Claude Vision
    await page.waitForTimeout(1500);

    // Find the CAPTCHA number image (the image showing digits like 747104)
    const captchaImgs = await page.$$('img');
    let captchaImg = null;
    for (const img of captchaImgs) {
      const box = await img.boundingBox();
      // CAPTCHA images are typically wide and short — look for that shape
      if (box && box.width > 60 && box.width < 300 && box.height > 20 && box.height < 80) {
        captchaImg = img;
        console.log('🔍 Found CAPTCHA image:', box.width, 'x', box.height);
        break;
      }
    }

    if (!captchaImg) {
      // Fallback: take full page screenshot and let Claude find the CAPTCHA
      captchaImg = null;
    }

    const captchaInput = await page.$('input[placeholder*="Security"]') ||
                         await page.$('input[placeholder*="security"]') ||
                         await page.$('input[placeholder*="Code"]') ||
                         await page.$('input[placeholder*="code"]') ||
                         await page.$('input[id*="captcha"]') ||
                         await page.$('input[id*="security"]');

    if (captchaInput) {
      console.log('🔍 CAPTCHA input found — reading code with Claude Vision...');

      let captchaCode = null;

      if (captchaImg) {
        // Screenshot just the CAPTCHA image
        const captchaBase64 = await captchaImg.screenshot({ encoding: 'base64' });
        captchaCode = await readCaptcha(captchaBase64);
      }

      if (!captchaCode) {
        // Fallback: screenshot full page area around input
        const fullBase64 = await page.screenshot({ encoding: 'base64' });
        // Ask Claude to find and read the security code from the full page
        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-opus-4-6',
              max_tokens: 50,
              messages: [{
                role: 'user',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fullBase64 } },
                  { type: 'text', text: 'This is a UAE FTA portal login page. There is a security code / CAPTCHA showing some digits next to an "Enter Security Code" input field. Find those digits and reply with ONLY those digits. Nothing else.' }
                ]
              }]
            })
          });
          const data = await response.json();
          const raw = data.content?.[0]?.text?.trim() || '';
          captchaCode = raw.replace(/[^0-9]/g, '');
          console.log('🤖 Full-page CAPTCHA read:', raw, '→', captchaCode);
        } catch(e) {
          console.error('Full-page CAPTCHA read failed:', e.message);
        }
      }

      if (captchaCode && captchaCode.length >= 4) {
        await captchaInput.click({ clickCount: 3 });
        await captchaInput.type(captchaCode, { delay: 150 });
        console.log('✅ CAPTCHA filled:', captchaCode);
      } else {
        console.log('⚠️ Could not read CAPTCHA code — length:', captchaCode?.length);
      }
    } else {
      console.log('ℹ️ No CAPTCHA input field found');
    }

    // Step 7: Click Login button
    const loginBtn = await page.$('button[type="submit"]') ||
                     await page.$('input[type="submit"]') ||
                     await page.$('button:contains("Login")') ||
                     await page.evaluateHandle(() => {
                       const btns = Array.from(document.querySelectorAll('button'));
                       return btns.find(b => b.textContent.includes('Login'));
                     });

    if (!loginBtn || !loginBtn.asElement()) throw new Error('Login button not found');
    await (loginBtn.asElement ? loginBtn.asElement().click() : loginBtn.click());
    console.log('✅ Login button clicked');

    // Step 6: Wait for navigation
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    console.log('📄 Final URL:', finalUrl);

    if (finalUrl.includes('Logon') || finalUrl.includes('login') || finalUrl.includes('UAE_PASS')) {
      // Still on login page — check error
      const errText = await page.evaluate(() => {
        const errEl = document.querySelector('[class*="error"], [class*="alert"], [class*="invalid"], [class*="wrong"]');
        return errEl ? errEl.textContent.trim() : null;
      });
      throw new Error(errText || 'Login failed — still on login page. Check credentials.');
    }

    isLoggedIn = true;
    currentFtaUser = ftaUser;
    lastActivity = Date.now();
    console.log('✅ FTA login successful!');
    return { success: true, message: 'Logged in to FTA portal successfully' };

  } catch (err) {
    isLoggedIn = false;
    console.error('❌ FTA login error:', err.message);
    // Take screenshot on failure
    try {
      const failShot = await page.screenshot({ encoding: 'base64' });
      return { success: false, error: err.message, screenshot: 'data:image/png;base64,' + failShot };
    } catch {
      return { success: false, error: err.message };
    }
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
    status:        'ok',
    browserReady:  !!browser,
    loggedIn:      isLoggedIn,
    currentUser:   currentFtaUser ? currentFtaUser.slice(0,5) + '***' : null,
    lastActivity:  new Date(lastActivity).toISOString(),
    port:          PORT,
    ready:         true
  });
});

// Root route — Railway sometimes checks /
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'PRF FTA Agent' });
});

// Login to FTA portal — credentials sent from portal, not stored on server
app.post('/api/login', authenticate, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    await launchBrowser();
    const result = await loginToFTA(username, password);
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
  console.log(`📋 FTA credentials: Managed from ClientHub portal (not stored on server)`);
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
