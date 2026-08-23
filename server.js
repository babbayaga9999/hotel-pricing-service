const express = require('express');
const fs = require('fs');
const path = require('path');
const { scrapeHotelPrices } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Silence favicon 404 logs
app.get('/favicon.ico', (req, res) => res.status(204).end());

// File paths
const HOTELS_FILE = path.join(__dirname, 'data', 'hotels.json');
const RESULTS_FILE = path.join(__dirname, 'data', 'results.json');

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// Global scraping state
let scrapeState = {
  status: 'idle', // 'idle' or 'running'
  total: 0,
  current: 0,
  activeHotel: null,
  logs: [],
  startTime: null,
  endTime: null
};

// Helper: Add logs to state
function addLog(message) {
  const logEntry = `[${new Date().toLocaleTimeString()}] ${message}`;
  console.log(logEntry);
  scrapeState.logs.push(logEntry);
  // Keep logs to latest 100 entries to prevent memory leak
  if (scrapeState.logs.length > 100) {
    scrapeState.logs.shift();
  }
}

// Helper: Load hotels database
function loadHotels() {
  try {
    if (fs.existsSync(HOTELS_FILE)) {
      const data = fs.readFileSync(HOTELS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading hotels file:', err);
  }
  return [];
}

// Helper: Save hotels database
function saveHotels(hotels) {
  try {
    fs.writeFileSync(HOTELS_FILE, JSON.stringify(hotels, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving hotels file:', err);
    return false;
  }
}

// Helper: Load scraping results
function loadResults() {
  try {
    if (fs.existsSync(RESULTS_FILE)) {
      const data = fs.readFileSync(RESULTS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading results file:', err);
  }
  return {};
}

// Helper: Save scraping results
function saveResults(results) {
  try {
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving results file:', err);
    return false;
  }
}

// API Routes

// 1. Get List of Hotels
app.get('/api/hotels', (req, res) => {
  const hotels = loadHotels();
  res.json(hotels);
});

// 2. Add New Hotel
app.post('/api/hotels', (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'Name and Google Travel URL are required.' });
  }

  // Simple validation for URL format
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return res.status(400).json({ error: 'Invalid URL. Must begin with http:// or https://' });
  }

  const hotels = loadHotels();
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  
  if (hotels.find(h => h.id === id)) {
    return res.status(400).json({ error: 'A hotel with a similar name already exists.' });
  }

  const newHotel = { id, name, url };
  hotels.push(newHotel);
  if (saveHotels(hotels)) {
    res.status(201).json(newHotel);
  } else {
    res.status(500).json({ error: 'Failed to write hotel to database.' });
  }
});

// 3. Delete a Hotel
app.delete('/api/hotels/:id', (req, res) => {
  const { id } = req.params;
  let hotels = loadHotels();
  const exists = hotels.some(h => h.id === id);
  
  if (!exists) {
    return res.status(404).json({ error: 'Hotel not found.' });
  }

  hotels = hotels.filter(h => h.id !== id);
  if (saveHotels(hotels)) {
    // Clean up results for this hotel too if applicable
    const results = loadResults();
    if (results[id]) {
      delete results[id];
      saveResults(results);
    }
    res.json({ success: true, message: 'Hotel deleted successfully.' });
  } else {
    res.status(500).json({ error: 'Failed to update database.' });
  }
});

// 4. Get Current Scraper Status
app.get('/api/scrape/status', (req, res) => {
  res.json(scrapeState);
});

// 5. Get Latest Scrape Results
app.get('/api/scrape/results', (req, res) => {
  const results = loadResults();
  res.json(results);
});

// 6. Trigger Scraping Process
app.post('/api/scrape', (req, res) => {
  if (scrapeState.status === 'running') {
    return res.status(400).json({ error: 'Scraping job is already in progress.' });
  }

  const hotels = loadHotels();
  if (hotels.length === 0) {
    return res.status(400).json({ error: 'No hotels found. Add hotels before scraping.' });
  }

  const { checkIn, checkOut } = req.body;

  // Start background scraping job
  scrapeState = {
    status: 'running',
    total: hotels.length,
    current: 0,
    activeHotel: null,
    logs: [],
    startTime: new Date().toISOString(),
    endTime: null
  };

  if (checkIn && checkOut) {
    addLog(`Started scraping job for ${hotels.length} hotels. Target Dates: ${checkIn} to ${checkOut}`);
  } else {
    addLog(`Started scraping job for ${hotels.length} hotels.`);
  }

  // Execute in the background
  (async () => {
    const results = loadResults();

    for (let i = 0; i < hotels.length; i++) {
      const hotel = hotels[i];
      scrapeState.current = i + 1;
      scrapeState.activeHotel = hotel.name;
      
      addLog(`[${i + 1}/${hotels.length}] Scraping ${hotel.name}...`);
      
      try {
        const scrapeResult = await scrapeHotelPrices(hotel, checkIn, checkOut);
        results[hotel.id] = scrapeResult;
        saveResults(results);
        
        if (scrapeResult.success) {
          addLog(`✓ Successfully scraped ${hotel.name}. Found ${scrapeResult.prices.length} price options.`);
        } else {
          addLog(`⚠ Warning: ${hotel.name} scrape did not find prices. Error: ${scrapeResult.error}`);
        }
      } catch (err) {
        addLog(`✗ Error scraping ${hotel.name}: ${err.message}`);
        results[hotel.id] = {
          hotelId: hotel.id,
          hotelName: hotel.name,
          success: false,
          timestamp: new Date().toISOString(),
          prices: [],
          error: err.message
        };
        saveResults(results);
      }

      // Add a small delay between hotels to mimic user browsing and reduce rate-limit chance
      if (i < hotels.length - 1) {
        const delay = 3000 + Math.random() * 2000; // 3-5 seconds
        addLog(`Waiting ${Math.round(delay/1000)}s before next hotel to avoid anti-bot trigger...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    scrapeState.status = 'idle';
    scrapeState.activeHotel = null;
    scrapeState.endTime = new Date().toISOString();
    addLog(`Scraping job finished. Results saved.`);
  })().catch(err => {
    console.error('Fatal background job error:', err);
    scrapeState.status = 'idle';
    scrapeState.activeHotel = null;
    scrapeState.endTime = new Date().toISOString();
    addLog(`✗ Fatal Error: ${err.message}`);
  });

  res.json({ message: 'Scraping started.', total: hotels.length });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
