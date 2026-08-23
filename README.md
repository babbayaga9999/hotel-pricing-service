# OTA Rate Intelligence Dashboard

A real-time Google Hotels pricing scraping service and dashboard built with Node.js, Express, Playwright-chromium, and Flatpickr.

## Features
- **Dynamic Check-in/Check-out Selectors**: Integrated custom dark-themed interactive calendar date selectors (Flatpickr) to easily select dates.
- **Scraper Controls**: Sequential queue crawler with randomized delays (3-5s) to avoid bot detection.
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

---

## Live Deployment (Free Services)

Playwright runs real Chromium browsers, meaning it requires at least **512MB RAM (1GB recommended)** to scrape prices reliably without out-of-memory crashes.

Here are the best free deployment services for this Dockerized application:

### Option A: Koyeb (100% Free Nano Container)
Koyeb provides a **100% free Nano container instance** (512MB RAM, 0.1 vCPU, 2GB SSD, 100GB traffic/month) that supports Docker build instructions natively.

[![Deploy to Koyeb](https://www.koyeb.com/static/images/deploy/button.svg)](https://app.koyeb.com/deploy?repository=github.com/babbayaga9999/hotel-pricing-service&branch=master&name=hotel-pricing-service)

1. Click the **Deploy to Koyeb** button above.
2. Sign in with GitHub.
3. Keep the build defaults (Docker builder will automatically use our `Dockerfile` and expose port `3000`).
4. Click **Deploy**. Your live URL will be ready in 1-2 minutes.

---

### Option B: Hugging Face Spaces (Free 16GB RAM container — RECOMMENDED)
Hugging Face Spaces offers custom Docker containers with **16GB RAM and 2 vCPUs completely free**. This is the most powerful free resource available, ensuring Playwright never runs out of memory.

1. Go to [Hugging Face Spaces](https://huggingface.co/spaces) and log in.
2. Click **New Space**.
3. Set the name to `hotel-pricing-service`, select **Docker** as the SDK, and choose **Blank** template.
4. Set visibility to **Public** or **Private**, and click **Create Space**.
5. Go to the "Files and versions" tab, click **Add file** -> **Upload files**, and upload the files of this repository (`server.js`, `scraper.js`, `package.json`, `package-lock.json`, `Dockerfile`, `README.md`, `data/`, `public/`).
6. Hugging Face will automatically detect the `Dockerfile`, build it, and launch your live dashboard instantly.

---

### Option C: Railway (Free $5 Credits)
Railway is extremely easy to use and provides $5 free trial credits.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/babbayaga9999/hotel-pricing-service)
