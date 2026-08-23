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
        '--disable-blink-features=AutomationControlled'
      ]
    };

    if (process.env.PROXY_URL) {
      launchOptions.proxy = {
        server: process.env.PROXY_URL
      };
      console.log(`Routing Playwright browser traffic through proxy...`);
    }

    browser = await chromium.launch(launchOptions);

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const page = await context.newPage();
    
    // Override webdriver property to bypass bot detection
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
    });
    
    // Intercept routes to block only images and fonts (fully safe, avoids script blocking hangs)
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font') {
        route.abort();
      } else {
        route.continue();
      }
    });

    // Set navigation timeout to 30s for safety
    page.setDefaultTimeout(30000);

    console.log(`Navigating to Google Hotels search: ${hotel.url}`);
    await page.goto(hotel.url, { waitUntil: 'domcontentloaded' });
    
    // Wait for initial static layout to settle
    await page.waitForTimeout(3000);
    
    let bodyText = await page.innerText('body');
    let bodyLower = bodyText.toLowerCase();
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
        await page.screenshot({ path: screenshotPath });
        console.log(`Saved failure screenshot for ${hotel.name} to public/screenshots/${hotel.id}.png`);
      } catch (screenshotErr) {
        console.error(`Failed to take screenshot for ${hotel.name}:`, screenshotErr.message);
      }

      result.error = 'Could not access details view panel for this hotel. Google is showing general search results.';
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
