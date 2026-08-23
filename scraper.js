const { chromium } = require('playwright-chromium');
const fs = require('fs');
const path = require('path');

function formatGoogleDate(dateStr) {
  if (!dateStr) return '';
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  if (typeof dateStr === 'string' && dateStr.includes('-')) {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      const year = parts[0];
      const monthIdx = parseInt(parts[1], 10) - 1;
      const dayNum = parseInt(parts[2], 10);
      if (monthIdx >= 0 && monthIdx <= 11) {
        return `${dayNum} ${months[monthIdx]} ${year}`;
      }
    }
  }
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) {
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  }
  return dateStr;
}

/**
 * Dismiss Google consent banners if present.
 * Google serves "Before you continue" consent pages on datacenter IPs.
 * We handle this by:
 *  1. Pre-injecting SOCS and CONSENT cookies to signal acceptance
 *  2. Clicking any visible consent buttons as a fallback
 */
async function dismissConsentBanner(page) {
  try {
    // Look for consent buttons in the main page
    const consentSelectors = [
      'button:has-text("Accept all")',
      'button:has-text("Accept All")',
      'button:has-text("I agree")',
      'button:has-text("Agree")',
      'button:has-text("Yes, I agree")',
      'button:has-text("Consent")',
      '[aria-label="Accept all"]',
      '[aria-label="Accept All"]',
      '#L2AGLb', // Common Google consent button ID
      '.tHlp8d',  // Another common consent class
    ];

    for (const selector of consentSelectors) {
      try {
        const button = page.locator(selector).first();
        if (await button.isVisible({ timeout: 1000 })) {
          await button.click();
          console.log(`[Consent] Dismissed consent banner via selector: ${selector}`);
          await page.waitForTimeout(2000);
          return true;
        }
      } catch {
        // Selector not found, try next
      }
    }

    // Check for consent inside iframes (Google sometimes uses iframe for consent)
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const frameUrl = frame.url();
        if (frameUrl.includes('consent.google.com') || frameUrl.includes('consent')) {
          for (const selector of consentSelectors) {
            try {
              const button = frame.locator(selector).first();
              if (await button.isVisible({ timeout: 1000 })) {
                await button.click();
                console.log(`[Consent] Dismissed consent banner in iframe via: ${selector}`);
                await page.waitForTimeout(2000);
                return true;
              }
            } catch {
              // Try next selector
            }
          }
        }
      } catch {
        // Frame may have detached
      }
    }
  } catch (err) {
    console.log(`[Consent] Error while trying to dismiss consent: ${err.message}`);
  }
  return false;
}

/**
 * Scrapes prices for a single hotel from its Google Travel URL.
 * @param {Object} hotel - Hotel object containing name and url.
 * @param {string} [targetCheckIn] - Target check-in date in YYYY-MM-DD format.
 * @param {string} [targetCheckOut] - Target check-out date in YYYY-MM-DD format.
 * @returns {Promise<Object>} Scraping result containing success status, timestamp, and prices list.
 */
async function scrapeHotelPrices(hotel, targetCheckIn, targetCheckOut) {
  console.log(`Starting scrap for hotel: ${hotel.name}`);
  const result = {
    hotelId: hotel.id,
    hotelName: hotel.name,
    success: false,
    timestamp: new Date().toISOString(),
    prices: [],
    error: null
  };

  let browser;
  try {
    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
        '--disable-popup-blocking',
      ]
    };

    if (process.env.PROXY_URL) {
      const cleanProxyUrl = process.env.PROXY_URL.replace(/\s+/g, '');
      try {
        const urlObj = new URL(cleanProxyUrl);
        launchOptions.proxy = {
          server: `${urlObj.protocol}//${urlObj.host}`
        };
        if (urlObj.username) {
          launchOptions.proxy.username = decodeURIComponent(urlObj.username);
        }
        if (urlObj.password) {
          launchOptions.proxy.password = decodeURIComponent(urlObj.password);
        }
        console.log(`Routing Playwright browser traffic through proxy: ${urlObj.host}`);
      } catch (err) {
        console.warn(`Failed to parse PROXY_URL using URL parser, falling back to raw value:`, err.message);
        launchOptions.proxy = {
          server: cleanProxyUrl
        };
      }
    }

    browser = await chromium.launch(launchOptions);

    // Create context with realistic Chrome User-Agent fingerprint, Indian headers, and Delhi geolocation
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      geolocation: { latitude: 28.6139, longitude: 77.2090 },
      permissions: ['geolocation'],
      extraHTTPHeaders: {
        'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
      }
    });

    // Pre-inject consent and INR currency preference cookies to force Indian OTAs and INR rates
    await context.addCookies([
      {
        name: 'PREF',
        value: 'f6=40000&hl=en-IN&gl=in&curr=INR',
        domain: '.google.com',
        path: '/',
      },
      {
        name: 'PREF',
        value: 'f6=40000&hl=en-IN&gl=in&curr=INR',
        domain: '.google.co.in',
        path: '/',
      },
      {
        name: 'SOCS',
        value: 'CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5MDEwMDAwUgJlbhgCGgYIgJnPpwY',
        domain: '.google.com',
        path: '/',
      },
      {
        name: 'CONSENT',
        value: 'PENDING+987',
        domain: '.google.com',
        path: '/',
      },
      {
        name: 'SOCS',
        value: 'CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5MDEwMDAwUgJlbhgCGgYIgJnPpwY',
        domain: '.google.co.in',
        path: '/',
      },
      {
        name: 'CONSENT',
        value: 'PENDING+987',
        domain: '.google.co.in',
        path: '/',
      },
    ]);

    const page = await context.newPage();

    // Verify external IP to ensure proxy routing is active
    try {
      const ipPage = await context.newPage();
      await ipPage.goto('https://api.ipify.org?format=json', { timeout: 10000 });
      const ipText = await ipPage.innerText('body');
      console.log(`[Scraper Browser IP]: ${ipText.trim()}`);
      await ipPage.close();
    } catch (ipErr) {
      console.log(`[Scraper Browser IP Check Failed]: ${ipErr.message}`);
    }
    
    // Set navigation timeout to 45s for cloud environments
    page.setDefaultTimeout(45000);
    page.on('console', msg => console.log('[BROWSER CONSOLE]', msg.text()));

    // STEP 1: First navigate to Google.com to establish cookies and session
    console.log(`[Step 1] Warming up Google session...`);
    try {
      await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1500);
      
      // Dismiss any consent banner that appears
      await dismissConsentBanner(page);
      await page.waitForTimeout(1000);
    } catch (warmupErr) {
      console.log(`[Step 1] Warmup navigation warning: ${warmupErr.message}`);
    }

    // STEP 2: Navigate to the hotel search URL
    console.log(`[Step 2] Navigating to Google Hotels search: ${hotel.url}`);
    await page.goto(hotel.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Wait for initial static layout to settle
    await page.waitForTimeout(4000);
    
    // Dismiss consent if it appeared again after redirect
    await dismissConsentBanner(page);
    await page.waitForTimeout(1000);

    // Check if we got redirected to consent.google.com
    const currentUrl = page.url();
    console.log(`[Step 2] Current URL after navigation: ${currentUrl}`);
    if (currentUrl.includes('consent.google.com')) {
      console.log(`[Step 2] Redirected to consent page, attempting to dismiss...`);
      await dismissConsentBanner(page);
      await page.waitForTimeout(3000);
      
      // If still on consent page, try to navigate directly again
      if (page.url().includes('consent.google.com')) {
        console.log(`[Step 2] Still on consent page, retrying navigation...`);
        await page.goto(hotel.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000);
      }
    }

    // Log page title and a snippet of the page content for debugging
    const pageTitle = await page.title();
    console.log(`[Debug] Page title: ${pageTitle}`);
    
    let bodyText = await page.innerText('body');
    let bodyLower = bodyText.toLowerCase();
    
    // Log first 300 chars of body for debugging
    console.log(`[Debug] Page body preview: ${bodyText.substring(0, 300).replace(/\n/g, ' ')}`);
    
    let isDetailView = bodyLower.includes('overview') && (bodyLower.includes('prices') || bodyLower.includes('about') || bodyLower.includes('reviews'));
    
    if (!isDetailView) {
      console.log(`Landed on search list page for ${hotel.name}. Seeking hotel card...`);
      
      // Traverse headings on search results page to click exact target hotel card
      const headingClicked = await page.evaluate((name) => {
        const headings = Array.from(document.querySelectorAll('h2, h3, a, div[role="button"]'));
        const lowerName = name.toLowerCase().trim();
        const cleanName = lowerName.replace(/^the\s+/, '').trim(); // e.g. "orion elite"
        
        const target = headings.find(el => {
          const txt = (el.textContent || '').toLowerCase().trim();
          return txt.includes(cleanName) || txt.includes(lowerName);
        });

        if (target) {
          const anchor = target.closest('a');
          if (anchor) { anchor.click(); } else { target.click(); }
          return true;
        }
        return false;
      }, hotel.name);

      if (headingClicked) {
        console.log(`Triggered card click. Waiting 5s for details drawer...`);
        await page.waitForTimeout(5000);
        isDetailView = true;
      }
    }

    if (!isDetailView) {
      // Capture screenshot for debugging
      const screenshotDir = path.join(__dirname, 'public', 'screenshots');
      if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir, { recursive: true });
      }
      const screenshotPath = path.join(screenshotDir, `${hotel.id}.png`);
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`Saved failure screenshot for ${hotel.name} to public/screenshots/${hotel.id}.png`);
      } catch (screenshotErr) {
        console.error(`Failed to take screenshot for ${hotel.name}:`, screenshotErr.message);
      }
      
      // Also save the full HTML for debugging
      try {
        const htmlContent = await page.content();
        const htmlPath = path.join(screenshotDir, `${hotel.id}.html`);
        fs.writeFileSync(htmlPath, htmlContent, 'utf8');
        console.log(`Saved failure HTML for ${hotel.name} to public/screenshots/${hotel.id}.html`);
      } catch (htmlErr) {
        console.error(`Failed to save HTML for ${hotel.name}:`, htmlErr.message);
      }

      result.error = `Could not access details view panel. Page title: "${pageTitle}". URL: ${page.url()}. Body preview: ${bodyText.substring(0, 200)}`;
      return result;
    }

    // Change dates if requested by user (only after we have successfully loaded the details panel)
    if (targetCheckIn && targetCheckOut) {
      try {
        const ciMatch = formatGoogleDate(targetCheckIn); // e.g. "25 August 2026"
        const coMatch = formatGoogleDate(targetCheckOut); // e.g. "26 August 2026"
        
        if (ciMatch && coMatch) {
          console.log(`Changing search dates to Check-in: "${ciMatch}", Check-out: "${coMatch}"`);
          
          await page.waitForTimeout(2000);

          // 1. Open Calendar modal by clicking parent JS container of active Check-in input
          const modalOpened = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input')).filter(i => (i.getAttribute('aria-label') === 'Check-in' || i.getAttribute('placeholder') === 'Check-in') && i.offsetWidth > 0);
            const input = inputs.pop();
            if (input) {
              let p = input.parentElement;
              while (p && p.tagName !== 'BODY') {
                if (p.getAttribute('jsaction') || p.getAttribute('role') === 'button' || p.classList.contains('NA5Egc') || p.tagName === 'BUTTON') {
                  p.click();
                  return true;
                }
                p = p.parentElement;
              }
              input.click();
              return true;
            }
            return false;
          });
          console.log(`[Dates] Calendar modal opened: ${modalOpened}`);
          await page.waitForTimeout(1500);

          // 2. Click Check-in cell on calendar grid
          const ciClicked = await page.evaluate((match) => {
            const el = Array.from(document.querySelectorAll('[aria-label]')).find(e => e.getAttribute('aria-label').includes(match));
            if (el) { el.click(); return true; }
            return false;
          }, ciMatch);
          console.log(`[Dates] Check-in cell clicked (${ciMatch}): ${ciClicked}`);
          await page.waitForTimeout(500);

          // 3. Click Check-out cell on calendar grid
          const coClicked = await page.evaluate((match) => {
            const el = Array.from(document.querySelectorAll('[aria-label]')).find(e => e.getAttribute('aria-label').includes(match));
            if (el) { el.click(); return true; }
            return false;
          }, coMatch);
          console.log(`[Dates] Check-out cell clicked (${coMatch}): ${coClicked}`);
          await page.waitForTimeout(500);

          // 4. Click "Done" button if present, or Escape to close modal
          await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const doneBtn = btns.find(b => b.textContent.trim().toLowerCase() === 'done');
            if (doneBtn) doneBtn.click();
          });
          await page.keyboard.press('Escape');

          console.log(`[Dates] Waiting for rates to reload...`);
          await page.waitForTimeout(5000);

          // Verify final active dates
          const verifiedDates = await page.evaluate(() => {
            const ciInputs = Array.from(document.querySelectorAll('input')).filter(i => (i.getAttribute('aria-label') === 'Check-in' || i.getAttribute('placeholder') === 'Check-in') && i.offsetWidth > 0);
            const coInputs = Array.from(document.querySelectorAll('input')).filter(i => (i.getAttribute('aria-label') === 'Check-out' || i.getAttribute('placeholder') === 'Check-out') && i.offsetWidth > 0);
            const activeCI = ciInputs.pop();
            const activeCO = coInputs.pop();
            return {
              checkIn: activeCI ? activeCI.value : 'NOT FOUND',
              checkOut: activeCO ? activeCO.value : 'NOT FOUND'
            };
          });
          console.log(`[Dates] Verified - Check-in: ${verifiedDates.checkIn}, Check-out: ${verifiedDates.checkOut}`);
        }
      } catch (dateErr) {
        console.error(`Failed to change search dates for ${hotel.name}:`, dateErr.message);
      }
    }

    // Helper function to parse pricing options from page
    const parsePricesFromPage = async () => {
      // Auto-click "View all prices" / "All rates" / "Show more prices" buttons to reveal MakeMyTrip, Goibibo, Cleartrip, Yatra, EaseMyTrip
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
        const expandBtns = buttons.filter(b => {
          const txt = (b.textContent || '').trim().toLowerCase();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          return txt.includes('view all prices') || txt.includes('all prices') || txt.includes('more prices') || txt.includes('all rates') || aria.includes('view all prices') || aria.includes('all prices');
        });
        expandBtns.forEach(b => b.click());
      });
      await page.waitForTimeout(1500);

      const resList = await page.evaluate(() => {
        const list = [];
        const seen = new Set();

        const knownPartners = [
          'Booking.com', 'Agoda', 'MakeMyTrip.com', 'MakeMyTrip', 'Official website', 'Official site',
          'Expedia.co.in', 'Expedia.com', 'Expedia', 'Akbartravels.com', 'Akbartravels', 'Goibibo.com', 'Goibibo',
          'Cleartrip.com', 'Cleartrip', 'Yatra.com', 'Yatra', 'EaseMyTrip.com', 'EaseMyTrip', 'Tripadvisor.in',
          'Tripadvisor.com', 'Tripadvisor', 'Hotels.com', 'Vio.com', 'Wego', 'ZenHotels.com', 'Skyscanner',
          'Bluepillow.in', 'Bluepillow.nl', 'goseek.com', 'Traveloka.com', 'HomeToGo', 'Qantas Hotels'
        ];

        const allContainers = Array.from(document.querySelectorAll('a, button, div[role="button"], div[jsaction], div'));

        allContainers.forEach(container => {
          const text = (container.textContent || '').trim().replace(/\s+/g, ' ');
          const aria = container.getAttribute('aria-label') || '';
          
          if (text.length > 250) return;

          const prices = text.match(/₹\s*[0-9,.]+|[0-9,.]+\s*(?:EUR|USD|INR|GBP)/g) || [];
          if (prices.length > 0) {
            let partner = '';
            for (const kp of knownPartners) {
              if (text.includes(kp) || aria.includes(kp)) {
                partner = kp;
                break;
              }
            }

            if (partner) {
              const priceVal = prices[0].replace(/\s+/g, '');
              let standardPartner = partner;
              if (partner.toLowerCase() === 'makemytrip') standardPartner = 'MakeMyTrip.com';
              if (partner.toLowerCase() === 'goibibo') standardPartner = 'Goibibo.com';
              if (partner.toLowerCase() === 'cleartrip') standardPartner = 'Cleartrip.com';
              if (partner.toLowerCase() === 'easemytrip') standardPartner = 'EaseMyTrip.com';
              if (partner.toLowerCase().includes('official')) standardPartner = 'Official Site';

              const key = `${standardPartner.toLowerCase()}_${priceVal}`;
              if (!seen.has(key)) {
                seen.add(key);
                list.push({
                  partner: standardPartner,
                  price: priceVal,
                  rawPrice: parseInt(priceVal.replace(/[^0-9]/g, ''), 10)
                });
              }
            }
          }
        });

        return list.sort((a, b) => a.rawPrice - b.rawPrice);
      });
      return resList;
    };

    let parsedPrices = await parsePricesFromPage();

    // Fallback: If 0 prices parsed (e.g. list view side drawer collapsed), click hotel card heading to open drawer & retry
    if (parsedPrices.length === 0) {
      console.log(`[Parse Fallback] 0 options parsed. Re-triggering hotel card click for ${hotel.name}...`);
      await page.evaluate((name) => {
        const headings = Array.from(document.querySelectorAll('h2, h3, a, div[role="button"]'));
        const lowerName = name.toLowerCase().trim();
        const cleanName = lowerName.replace(/^the\s+/, '').trim();
        const target = headings.find(el => (el.textContent || '').toLowerCase().includes(cleanName));
        if (target) {
          const anchor = target.closest('a');
          if (anchor) anchor.click(); else target.click();
        }
      }, hotel.name);
      await page.waitForTimeout(6000);
      parsedPrices = await parsePricesFromPage();
    }

    parsedPrices.sort((a, b) => a.rawPrice - b.rawPrice);

    // Extract dates metadata
    const dates = await page.evaluate(() => {
      let checkIn = '';
      let checkOut = '';
      const checkInInput = document.querySelector('input[aria-label="Check-in"], input[placeholder="Check-in"]');
      const checkOutInput = document.querySelector('input[aria-label="Check-out"], input[placeholder="Check-out"]');
      if (checkInInput) checkIn = checkInInput.value;
      if (checkOutInput) checkOut = checkOutInput.value;
      return { checkIn, checkOut };
    });

    result.checkIn = dates.checkIn || 'N/A';
    result.checkOut = dates.checkOut || 'N/A';
    result.prices = parsedPrices;
    result.success = parsedPrices.length > 0;
    if (!result.success) {
      const pageTitle = await page.title();
      const pageUrl = page.url();
      const bodySnippet = (await page.innerText('body')).substring(0, 300).replace(/\s+/g, ' ');
      console.log(`[Debug Cloud Fail] Hotel: ${hotel.name} | Title: "${pageTitle}" | URL: ${pageUrl} | Body: ${bodySnippet}`);
      result.error = `No pricing rows parsed. Page Title: "${pageTitle}". URL: ${pageUrl}. Body snippet: ${bodySnippet}`;
    }
    console.log(`Successfully scraped ${parsedPrices.length} options for ${hotel.name} (Dates: ${result.checkIn} - ${result.checkOut})`);

  } catch (err) {
    console.error(`Error scraping ${hotel.name}:`, err.message);
    result.error = err.message;
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  return result;
}

module.exports = {
  scrapeHotelPrices
};
