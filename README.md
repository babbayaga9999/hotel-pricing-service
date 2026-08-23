# OTA Rate Intelligence Dashboard

A real-time Google Hotels pricing scraping service and dashboard built with Node.js, Express, Playwright-chromium, and Flatpickr.

## Features
- **Dynamic Check-in/Check-out Selectors**: Integrated custom dark-themed interactive calendar date selectors (Flatpickr) to easily select dates.
- **Scraper Controls**: Seqential queue crawler with randomized delays (3-5s) to avoid bot detection.
- **All Rates & Sources Column**: Displays alternative OTAs (Cleartrip, Expedia, Yatra, ZenHotels, etc.) as styled capsule badges, color-coding the cheapest source green.
- **Spreadsheet/CSV Exports**: Includes Check-in Date, Check-out Date, and OTA rates inside downloaded files.
- **Responsive Terminal Log**: Visualizes progress logs in real-time.

## Tech Stack
- **Backend**: Express, Playwright-chromium
- **Frontend**: Vanilla HTML5, CSS3, Javascript, Flatpickr
- **Deployment**: Docker, Playwright environment (Render, Railway, Fly.io)

## Run Locally
1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the Express server:
   ```bash
   node server.js
   ```
4. Access the dashboard at `http://localhost:3000`.

## Live Deployment
Deploy this service directly to **Render** or **Railway** using the provided `Dockerfile`. 
Make sure to allocate at least **512MB RAM** (1GB recommended) to run the Playwright browser context smoothly in headless mode.
