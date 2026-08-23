const { chromium } = require('playwright-chromium');
const fs = require('fs');
const path = require('path');

function formatGoogleDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
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
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-features=TranslateUI',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--password-store=basic',
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

    // Create context with a realistic, modern Chrome fingerprint
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      screen: { width: 1920, height: 1080 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      deviceScaleFactor: 1,
      hasTouch: false,
      isMobile: false,
      javaScriptEnabled: true,
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-CH-UA': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      }
    });

    // Pre-inject consent cookies to bypass Google's consent wall
    await context.addCookies([
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
    
    // Comprehensive stealth: override all common automation detection vectors
    await page.addInitScript(() => {
      // Remove webdriver flag
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      
      // Override plugins to look like a real Chrome browser
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          return [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ];
        },
      });
      
      // Override languages
      Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en', 'hi'] });
      
      // Fix chrome runtime detection
      window.chrome = {
        runtime: { onConnect: { addListener: () => {}, removeListener: () => {} } },
        loadTimes: () => ({}),
        csi: () => ({}),
      };
      
      // Override permissions query
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    });

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
    
    // Intercept routes to block only images and fonts (fully safe, avoids script blocking hangs)
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font') {
        route.abort();
      } else {
        route.continue();
      }
    });

    // Set navigation timeout to 45s for cloud environments
    page.setDefaultTimeout(45000);

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
      
      // Traverse headings on search results page to click correct card
      const headingClicked = await page.evaluate((name) => {
        const headings = Array.from(document.querySelectorAll('h2'));
        
        // Refined matching: filter common travel filler words to get unique keywords
        const cleanName = name.toLowerCase();
        const allWords = cleanName.replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
        const fillers = ['hotels', 'hotel', 'delhi', 'mumbai', 'by', 'orion', 'the', 'inn', 'suites', 'homestay', 'junction'];
        const keywords = allWords.filter(w => w.length >= 2 && !fillers.includes(w));
        const finalKeywords = keywords.length > 0 ? keywords : allWords.filter(w => w.length >= 2).slice(0, 2);
        
        for (const h2 of headings) {
          const h2Text = h2.textContent.toLowerCase();
          
          // Check if H2 text contains all final unique keywords
          const isMatch = finalKeywords.every(kw => h2Text.includes(kw));
          
          if (isMatch) {
            // Find parent card container that contains "View prices"
            let card = h2;
            let foundViewPrices = false;
            let viewPricesButton = null;
            
            for (let i = 0; i < 10; i++) {
              if (!card.parentElement) break;
              card = card.parentElement;
              
              const buttons = Array.from(card.querySelectorAll('button, a, div[role="button"]'));
              viewPricesButton = buttons.find(b => {
                const bText = b.textContent.trim().toLowerCase();
                return bText === 'view prices' || bText === 'view details' || bText.includes('price');
              });
              
              if (viewPricesButton) {
                foundViewPrices = true;
                break;
              }
            }
            
            if (foundViewPrices && viewPricesButton) {
              viewPricesButton.click();
              return true;
            } else {
              // Fallback programmatic click on heading or nearest anchor
              const anchor = h2.closest('a');
              if (anchor) {
                anchor.click();
              } else {
                h2.click();
              }
              return true;
            }
          }
        }
        return false;
      }, hotel.name);

      if (headingClicked) {
        console.log(`Triggered card click. Waiting 5s for details container...`);
        await page.waitForTimeout(5000);
        bodyText = await page.innerText('body');
        bodyLower = bodyText.toLowerCase();
        isDetailView = bodyLower.includes('overview') && (bodyLower.includes('prices') || bodyLower.includes('about') || bodyLower.includes('reviews'));
      } else {
        console.log(`✗ Failed to locate hotel card for "${hotel.name}" in search results.`);
        
        // RETRY: Try a simplified search query URL
        const simpleName = hotel.name.replace(/by orion hotels?/gi, '').trim();
        const simpleUrl = `https://www.google.com/travel/search?q=${encodeURIComponent(simpleName)}&hl=en-IN&gl=in`;
        console.log(`[Retry] Trying simplified URL: ${simpleUrl}`);
        
        await page.goto(simpleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000);
        await dismissConsentBanner(page);
        
        bodyText = await page.innerText('body');
        bodyLower = bodyText.toLowerCase();
        isDetailView = bodyLower.includes('overview') && (bodyLower.includes('prices') || bodyLower.includes('about') || bodyLower.includes('reviews'));
        
        if (!isDetailView) {
          // Try clicking on first h2 match again
          const retryClicked = await page.evaluate((name) => {
            const headings = Array.from(document.querySelectorAll('h2'));
            const cleanName = name.toLowerCase();
            const allWords = cleanName.replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
            const fillers = ['hotels', 'hotel', 'delhi', 'mumbai', 'by', 'orion', 'the', 'inn', 'suites', 'homestay', 'junction'];
            const keywords = allWords.filter(w => w.length >= 2 && !fillers.includes(w));
            const finalKeywords = keywords.length > 0 ? keywords : allWords.filter(w => w.length >= 2).slice(0, 2);
            
            for (const h2 of headings) {
              const h2Text = h2.textContent.toLowerCase();
              if (finalKeywords.every(kw => h2Text.includes(kw))) {
                const anchor = h2.closest('a');
                if (anchor) { anchor.click(); } else { h2.click(); }
                return true;
              }
            }
            // If no keyword match, try clicking the very first hotel card
            if (headings.length > 0) {
              const anchor = headings[0].closest('a');
              if (anchor) { anchor.click(); return true; }
            }
            return false;
          }, hotel.name);
          
          if (retryClicked) {
            await page.waitForTimeout(5000);
            bodyText = await page.innerText('body');
            bodyLower = bodyText.toLowerCase();
            isDetailView = bodyLower.includes('overview') && (bodyLower.includes('prices') || bodyLower.includes('about') || bodyLower.includes('reviews'));
          }
        }
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
        const checkInFormatted = formatGoogleDate(targetCheckIn);
        const checkOutFormatted = formatGoogleDate(targetCheckOut);
        
        if (checkInFormatted && checkOutFormatted) {
          console.log(`Changing search dates to Check-in: ${checkInFormatted}, Check-out: ${checkOutFormatted}`);
          
          const checkInLocator = page.locator('input[aria-label="Check-in"]:visible, input[placeholder="Check-in"]:visible').first();
          const checkOutLocator = page.locator('input[aria-label="Check-out"]:visible, input[placeholder="Check-out"]:visible').first();
          
          // Fill Check-in date
          await checkInLocator.fill(checkInFormatted);
          await page.waitForTimeout(200);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(500);
          
          // Dismiss calendar popup to release focus lock
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);

          // Fill Check-out date
          await checkOutLocator.fill(checkOutFormatted);
          await page.waitForTimeout(200);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(500);
          
          // Dismiss calendar popup again
          await page.keyboard.press('Escape');
          
          // Wait for the new rates to load
          await page.waitForTimeout(5000);
        }
      } catch (dateErr) {
        console.error(`Failed to change search dates for ${hotel.name}:`, dateErr.message);
      }
    }

    // Evaluate the page content in the browser context to parse partner pricing rows
    const parsedPrices = await page.evaluate(() => {
      const list = [];
      const seen = new Set();

      const elements = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
      
      elements.forEach(el => {
        const text = (el.textContent || '').trim();
        const ariaLabel = el.getAttribute('aria-label') || '';
        
        const isVisitButton = text === 'Visit site' || text === 'Visit official site' || ariaLabel.toLowerCase().includes('visit site');
        
        if (isVisitButton) {
          let container = el;
          for (let i = 0; i < 5; i++) {
            if (container.parentElement) {
              container = container.parentElement;
            }
          }
          
          const containerText = (container.textContent || '').trim().replace(/\s+/g, ' ');
          
          let partner = '';
          const matchAria = ariaLabel.match(/Visit site for\s+(.+)/i);
          if (matchAria && matchAria[1]) {
            partner = matchAria[1].trim();
          } else {
            const knownPartners = [
              'Booking.com', 'Agoda', 'MakeMyTrip.com', 'MakeMyTrip', 'Official Site', 'Official site',
              'Goibibo.com', 'Goibibo', 'Cleartrip.com', 'Cleartrip', 'Yatra.com', 'Yatra',
              'EaseMyTrip.com', 'EaseMyTrip', 'Expedia.co.in', 'Expedia.com', 'Expedia', 
              'Hotels.com', 'Tripadvisor.in', 'Tripadvisor.com', 'Tripadvisor', 
              'Akbartravels.com', 'Akbartravels', 'Vio.com', 'Wego', 'ZenHotels.com', 'Skyscanner'
            ];
            
            for (const kp of knownPartners) {
              if (containerText.includes(kp)) {
                partner = kp;
                break;
              }
            }
            if (!partner) {
              partner = containerText.split(/Total per night|Free Wi-Fi|Free cancellation/i)[0].trim();
            }
          }

          if (partner.toLowerCase().includes('official site')) {
            partner = 'Official Site';
          }
          if (partner.includes('Official Site') || partner.includes('Official site')) {
            partner = 'Official Site';
          }

          const priceRegex = /[₹$]\s*[0-9,]+/g;
          const prices = containerText.match(priceRegex) || [];
          
          if (partner && prices.length > 0) {
            const priceVal = prices[0].replace(/\s+/g, '');
            
            let standardPartner = partner;
            if (partner.toLowerCase() === 'makemytrip') standardPartner = 'MakeMyTrip.com';
            if (partner.toLowerCase() === 'goibibo') standardPartner = 'Goibibo.com';
            if (partner.toLowerCase() === 'cleartrip') standardPartner = 'Cleartrip.com';
            if (partner.toLowerCase() === 'easemytrip') standardPartner = 'EaseMyTrip.com';
            if (standardPartner.length > 30) standardPartner = standardPartner.substring(0, 30);

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
      
      return list;
    });

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
      result.error = 'No pricing rows could be parsed from the detail view. Google might have blocked or modified the selectors.';
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
