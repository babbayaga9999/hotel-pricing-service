// --- Orion Intelligence Client Script ---

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const btnRunScraper = document.getElementById('btn-run-scraper');
  const btnExportCsv = document.getElementById('btn-export-csv');
  const btnClearLogs = document.getElementById('btn-clear-logs');
  const statusBadge = document.getElementById('status-badge');
  const lastUpdateTime = document.getElementById('last-update-time');
  
  const progressWrapper = document.getElementById('progress-wrapper');
  const progressHotelName = document.getElementById('progress-hotel-name');
  const progressValText = document.getElementById('progress-val-text');
  const progressBarFill = document.getElementById('progress-bar-fill');
  
  const consoleLogs = document.getElementById('console-logs');
  const comparisonTbody = document.getElementById('comparison-tbody');
  
  const addHotelForm = document.getElementById('add-hotel-form');
  const hotelNameInput = document.getElementById('hotel-name');
  const hotelUrlInput = document.getElementById('hotel-url');
  const registryTbody = document.getElementById('registry-tbody');
  const hotelCount = document.getElementById('hotel-count');

  let pollingInterval = null;
  let hotelsList = [];
  let scrapeResults = {};

  // Standard OTAs we want to compare in columns
  const standardOTAs = ['Booking.com', 'Agoda', 'MakeMyTrip.com', 'Official Site'];

  // Initialize
  init();

  async function init() {
    await fetchHotels();
    await fetchResults();
    await checkScraperStatus();
    
    // Set default dates with Flatpickr calendar pickers
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const dayAfter = new Date(tomorrow);
    dayAfter.setDate(dayAfter.getDate() + 1);

    const fpCheckIn = flatpickr("#scrape-checkin", {
      defaultDate: tomorrow,
      minDate: "today",
      dateFormat: "Y-m-d",
      altInput: true,
      altFormat: "d-m-Y",
      onChange: function(selectedDates, dateStr, instance) {
        if (selectedDates.length > 0) {
          const nextDay = new Date(selectedDates[0]);
          nextDay.setDate(nextDay.getDate() + 1);
          fpCheckOut.set("minDate", nextDay);
          
          const currentCheckout = fpCheckOut.selectedDates[0];
          if (currentCheckout && currentCheckout <= selectedDates[0]) {
            fpCheckOut.setDate(nextDay);
          }
        }
      }
    });

    const fpCheckOut = flatpickr("#scrape-checkout", {
      defaultDate: dayAfter,
      minDate: tomorrow,
      dateFormat: "Y-m-d",
      altInput: true,
      altFormat: "d-m-Y"
    });
    
    // Set up listeners
    btnRunScraper.addEventListener('click', startScrapeJob);
    btnExportCsv.addEventListener('click', exportToCSV);
    btnClearLogs.addEventListener('click', () => {
      consoleLogs.innerHTML = '<div class="log-entry system">Logs cleared.</div>';
    });
    addHotelForm.addEventListener('submit', addHotel);
  }

  // --- API Functions ---

  async function fetchHotels() {
    try {
      const response = await fetch('/api/hotels');
      hotelsList = await response.json();
      renderRegistry();
    } catch (err) {
      logToConsole(`Error loading registry: ${err.message}`, 'error');
    }
  }

  async function fetchResults() {
    try {
      const response = await fetch('/api/scrape/results');
      scrapeResults = await response.json();
      renderComparisonMatrix();
    } catch (err) {
      logToConsole(`Error loading results: ${err.message}`, 'error');
    }
  }

  async function checkScraperStatus() {
    try {
      const response = await fetch('/api/scrape/status');
      const state = await response.json();
      updateScraperUI(state);
      
      if (state.status === 'running') {
        startPolling();
      } else {
        stopPolling();
      }
    } catch (err) {
      console.error('Error checking status:', err);
    }
  }

  async function startScrapeJob() {
    if (hotelsList.length === 0) {
      alert('Please add at least one hotel to the registry first!');
      return;
    }

    const checkInVal = document.getElementById('scrape-checkin').value;
    const checkOutVal = document.getElementById('scrape-checkout').value;

    if (!checkInVal || !checkOutVal) {
      alert('Please select both Check-in and Check-out dates before starting.');
      return;
    }
    
    try {
      btnRunScraper.disabled = true;
      const response = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkIn: checkInVal, checkOut: checkOutVal })
      });
      const data = await response.json();
      
      if (response.ok) {
        logToConsole(`Scraper job triggered successfully for ${data.total} hotels.`, 'system');
        startPolling();
      } else {
        logToConsole(`Failed to start job: ${data.error}`, 'error');
        btnRunScraper.disabled = false;
      }
    } catch (err) {
      logToConsole(`Error triggering scraper: ${err.message}`, 'error');
      btnRunScraper.disabled = false;
    }
  }

  async function addHotel(e) {
    e.preventDefault();
    const name = hotelNameInput.value.trim();
    const url = hotelUrlInput.value.trim();
    
    if (!name || !url) return;

    try {
      const response = await fetch('/api/hotels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url })
      });
      const data = await response.json();

      if (response.ok) {
        logToConsole(`Added hotel "${name}" to database.`, 'success');
        hotelNameInput.value = '';
        hotelUrlInput.value = '';
        await fetchHotels();
      } else {
        alert(data.error || 'Failed to add hotel.');
      }
    } catch (err) {
      logToConsole(`Error adding hotel: ${err.message}`, 'error');
    }
  }

  async function deleteHotel(id, name) {
    if (!confirm(`Are you sure you want to remove "${name}" from the registry?`)) return;

    try {
      const response = await fetch(`/api/hotels/${id}`, { method: 'DELETE' });
      const data = await response.json();

      if (response.ok) {
        logToConsole(`Removed hotel "${name}" from database.`, 'system');
        await fetchHotels();
        await fetchResults(); // Reload results since the hotel was deleted
      } else {
        alert(data.error || 'Failed to delete hotel.');
      }
    } catch (err) {
      logToConsole(`Error deleting hotel: ${err.message}`, 'error');
    }
  }

  // --- Polling Logic ---

  function startPolling() {
    if (pollingInterval) return;
    pollingInterval = setInterval(async () => {
      try {
        const response = await fetch('/api/scrape/status');
        const state = await response.json();
        updateScraperUI(state);
        
        if (state.status === 'idle') {
          stopPolling();
          logToConsole('Scraper job completed.', 'success');
          await fetchResults(); // reload table matrix
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 1500);
  }

  function stopPolling() {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
    btnRunScraper.disabled = false;
  }

  // --- UI Update Helpers ---

  function updateScraperUI(state) {
    if (state.status === 'running') {
      statusBadge.textContent = '● Running';
      statusBadge.className = 'status-indicator running';
      btnRunScraper.disabled = true;
      progressWrapper.classList.remove('hidden');
      
      // Update progress details
      const percent = Math.round((state.current / state.total) * 100) || 0;
      progressHotelName.textContent = `Scraping: ${state.activeHotel || 'Connecting...'}`;
      progressValText.textContent = `${percent}% (${state.current}/${state.total})`;
      progressBarFill.style.width = `${percent}%`;
    } else {
      statusBadge.textContent = '● Idle';
      statusBadge.className = 'status-indicator idle';
      btnRunScraper.disabled = false;
      progressWrapper.classList.add('hidden');
    }

    if (state.endTime) {
      lastUpdateTime.textContent = `Last run: ${new Date(state.endTime).toLocaleTimeString()}`;
    } else if (state.startTime) {
      lastUpdateTime.textContent = `Started: ${new Date(state.startTime).toLocaleTimeString()}`;
    }

    // Refresh logs
    if (state.logs && state.logs.length > 0) {
      // Find logs not already in the console
      const existingLogsCount = consoleLogs.querySelectorAll('.log-entry').length;
      if (state.logs.length !== existingLogsCount) {
        consoleLogs.innerHTML = '';
        state.logs.forEach(log => {
          const logEl = document.createElement('div');
          logEl.className = 'log-entry';
          if (log.includes('✓')) logEl.className = 'log-entry success';
          if (log.includes('✗') || log.includes('error')) logEl.className = 'log-entry error';
          if (log.includes('Started') || log.includes('finished')) logEl.className = 'log-entry system';
          logEl.textContent = log;
          consoleLogs.appendChild(logEl);
        });
        // Scroll to bottom
        consoleLogs.scrollTop = consoleLogs.scrollHeight;
      }
    }
  }

  function logToConsole(message, type = '') {
    const logEl = document.createElement('div');
    logEl.className = `log-entry ${type}`;
    logEl.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    consoleLogs.appendChild(logEl);
    consoleLogs.scrollTop = consoleLogs.scrollHeight;
  }

  // --- Data Rendering ---

  function renderRegistry() {
    hotelCount.textContent = hotelsList.length;
    registryTbody.innerHTML = '';

    if (hotelsList.length === 0) {
      registryTbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--text-muted);">No hotels registered. Add one below.</td></tr>';
      return;
    }

    hotelsList.forEach(hotel => {
      const tr = document.createElement('tr');
      
      const nameTd = document.createElement('td');
      nameTd.className = 'hotel-cell';
      nameTd.textContent = hotel.name;
      
      const urlTd = document.createElement('td');
      const a = document.createElement('a');
      a.href = hotel.url;
      a.target = '_blank';
      a.className = 'btn-link';
      a.innerHTML = `Search Page 
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
          <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/>
        </svg>`;
      urlTd.appendChild(a);
      
      const actionTd = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-delete';
      delBtn.textContent = 'Remove';
      delBtn.addEventListener('click', () => deleteHotel(hotel.id, hotel.name));
      actionTd.appendChild(delBtn);

      tr.appendChild(nameTd);
      tr.appendChild(urlTd);
      tr.appendChild(actionTd);
      registryTbody.appendChild(tr);
    });
  }

  function renderComparisonMatrix() {
    comparisonTbody.innerHTML = '';
    const hotelKeys = Object.keys(scrapeResults);

    if (hotelKeys.length === 0) {
      btnExportCsv.disabled = true;
      comparisonTbody.innerHTML = `
        <tr>
          <td colspan="8" class="table-placeholder">
            <div class="placeholder-content">
              <svg viewBox="0 0 24 24" width="48" height="48" class="pulse-icon">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" fill="currentColor"/>
              </svg>
              <p>No pricing intelligence loaded. Run the scraper to populate details.</p>
            </div>
          </td>
        </tr>`;
      return;
    }

    btnExportCsv.disabled = false;

    // Loop through each hotel in the registry to build the row
    hotelsList.forEach(hotel => {
      const result = scrapeResults[hotel.id];
      const tr = document.createElement('tr');

      // Hotel Name
      const nameTd = document.createElement('td');
      nameTd.className = 'hotel-cell';
      
      const nameDiv = document.createElement('div');
      nameDiv.className = 'hotel-title-text';
      nameDiv.textContent = hotel.name;
      nameTd.appendChild(nameDiv);
      
      if (result && result.success && result.checkIn && result.checkOut) {
        const datesDiv = document.createElement('div');
        datesDiv.className = 'hotel-dates';
        datesDiv.textContent = `📅 ${result.checkIn} – ${result.checkOut}`;
        nameTd.appendChild(datesDiv);
      }
      tr.appendChild(nameTd);

      if (!result) {
        // No results yet for this hotel
        const pendingTd = document.createElement('td');
        pendingTd.colSpan = 7;
        pendingTd.className = 'table-placeholder';
        pendingTd.style.padding = '0.5rem';
        pendingTd.style.color = 'var(--text-muted)';
        pendingTd.textContent = 'Pending scraping run...';
        tr.appendChild(pendingTd);
        comparisonTbody.appendChild(tr);
        return;
      }

      if (!result.success) {
        // Failed scraping run
        const errorTd = document.createElement('td');
        errorTd.colSpan = 7;
        errorTd.className = 'price-cell error';
        errorTd.textContent = result.error || 'Failed to fetch details.';
        tr.appendChild(errorTd);
        comparisonTbody.appendChild(tr);
        return;
      }

      // We have successful prices!
      // Map standard partner names to their extracted prices
      const partnerPrices = {};
      result.prices.forEach(p => {
        partnerPrices[p.partner] = p;
      });

      // Find the absolute cheapest rate overall
      let cheapestVal = Infinity;
      let cheapestPartner = '';

      result.prices.forEach(p => {
        if (p.rawPrice < cheapestVal) {
          cheapestVal = p.rawPrice;
          cheapestPartner = p.partner;
        }
      });

      // Render cells for standard columns (Booking, Agoda, MakeMyTrip, Official Site)
      standardOTAs.forEach(ota => {
        const td = document.createElement('td');
        td.className = 'price-cell';

        const priceObj = partnerPrices[ota];
        if (priceObj) {
          td.textContent = priceObj.price;
          // Check if this OTA is the cheapest option
          if (priceObj.partner === cheapestPartner) {
            td.className = 'price-cell cheapest';
          }
        } else {
          td.textContent = '-';
          td.style.color = 'var(--text-muted)';
        }
        tr.appendChild(td);
      });

      // Cheapest column
      const cheapestTd = document.createElement('td');
      cheapestTd.className = 'price-cell';
      const bestPriceObj = result.prices.find(p => p.partner === cheapestPartner);
      
      if (bestPriceObj) {
        cheapestTd.innerHTML = `<span class="cheapest-badge">${bestPriceObj.price} (${cheapestPartner})</span>`;
      } else {
        cheapestTd.textContent = '-';
      }
      tr.appendChild(cheapestTd);

      // All Rates & Sources column (Sleek capsule list of all parsed sources)
      const allRatesTd = document.createElement('td');
      const ratesListContainer = document.createElement('div');
      ratesListContainer.className = 'rates-list-container';
      
      result.prices.forEach(p => {
        const capsule = document.createElement('div');
        capsule.className = 'rate-capsule';
        if (p.partner === cheapestPartner) {
          capsule.className = 'rate-capsule cheapest-badge-mini';
        }
        
        capsule.innerHTML = `
          <span class="rate-capsule-partner">${p.partner}:</span>
          <span class="rate-capsule-price">${p.price}</span>
        `;
        ratesListContainer.appendChild(capsule);
      });
      allRatesTd.appendChild(ratesListContainer);
      tr.appendChild(allRatesTd);

      // Variance (Savings) column
      // Let's compute price saving margin: ((Highest Rate - Cheapest Rate) / Cheapest Rate) * 100
      const varianceTd = document.createElement('td');
      varianceTd.className = 'variance-cell';
      
      const highestPrice = Math.max(...result.prices.map(p => p.rawPrice));
      if (highestPrice > 0 && cheapestVal < Infinity && highestPrice !== cheapestVal) {
        const savingPercent = Math.round(((highestPrice - cheapestVal) / highestPrice) * 100);
        varianceTd.className = 'variance-cell positive';
        varianceTd.textContent = `${savingPercent}% Saving`;
      } else {
        varianceTd.className = 'variance-cell neutral';
        varianceTd.textContent = '0%';
      }
      tr.appendChild(varianceTd);

      comparisonTbody.appendChild(tr);
    });
  }

  // --- CSV Export Helper ---

  function exportToCSV() {
    const headers = ['Hotel Name', 'Check-in Date', 'Check-out Date', 'Booking.com', 'Agoda', 'MakeMyTrip.com', 'Official Site', 'Cheapest Price', 'Cheapest Provider', 'All Rates & Sources', 'Max Savings'];
    const csvRows = [headers.join(',')];

    hotelsList.forEach(hotel => {
      const result = scrapeResults[hotel.id];
      if (!result || !result.success) return;

      const partnerPrices = {};
      result.prices.forEach(p => {
        partnerPrices[p.partner] = p.price.replace(/[^0-9]/g, '');
      });

      // Find cheapest details
      let cheapestVal = Infinity;
      let cheapestPartner = '';
      result.prices.forEach(p => {
        if (p.rawPrice < cheapestVal) {
          cheapestVal = p.rawPrice;
          cheapestPartner = p.partner;
        }
      });

      const highestPrice = Math.max(...result.prices.map(p => p.rawPrice));
      const savingPercent = (highestPrice !== cheapestVal) 
        ? `${Math.round(((highestPrice - cheapestVal) / highestPrice) * 100)}%` 
        : '0%';

      const allRatesStr = result.prices.map(p => `${p.partner}:${p.price.replace(/[^0-9]/g, '')}`).join(' | ');

      const row = [
        `"${hotel.name}"`,
        `"${result.checkIn || 'N/A'}"`,
        `"${result.checkOut || 'N/A'}"`,
        partnerPrices['Booking.com'] ? `"${partnerPrices['Booking.com']}"` : '""',
        partnerPrices['Agoda'] ? `"${partnerPrices['Agoda']}"` : '""',
        partnerPrices['MakeMyTrip.com'] ? `"${partnerPrices['MakeMyTrip.com']}"` : '""',
        partnerPrices['Official Site'] ? `"${partnerPrices['Official Site']}"` : '""',
        `"${cheapestVal}"`,
        `"${cheapestPartner}"`,
        `"${allRatesStr}"`,
        `"${savingPercent}"`
      ];

      csvRows.push(row.join(','));
    });

    const csvString = csvRows.join('\n');
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `hotel_rates_intelligence_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
});
