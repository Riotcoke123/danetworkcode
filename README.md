<div align="center">
  <h1>🌐 DaNetworkCode Streamer Scraper</h1>
  <p><b>A high-performance, multi-platform livestream monitoring service.</b></p>
  <p>Actively tracks live status, viewer counts, metadata, and VODs across Kick, Twitch, YouTube, Vaughn, Parti, and <b>Pump.fun</b>.</p>
  
  <br>
  
  <img src="https://img.shields.io/badge/Node.js-18+-green.svg?style=for-the-badge&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/Express-Backend-black.svg?style=for-the-badge&logo=express" alt="Express">
  <img src="https://img.shields.io/badge/Puppeteer-Scraper-04D361.svg?style=for-the-badge&logo=puppeteer" alt="Puppeteer">
  <img src="https://img.shields.io/badge/SQLite-Database-003B57.svg?style=for-the-badge&logo=sqlite" alt="SQLite">
  <img src="https://img.shields.io/badge/Docker-Supported-2496ED.svg?style=for-the-badge&logo=docker" alt="Docker">
</div>

<hr>

<h2>✨ Key Features</h2>
<ul>
  <li><b>Multi-Platform Integration:</b> Connects to Kick, Twitch, YouTube, Vaughn, Parti, and Pump.fun via API and web scraping to build a unified streamer database.</li>
  <li><b>Pump.fun Crypto Streaming:</b> Tracks streams tied to Solana mint addresses, complete with intelligent WebSocket/React rendering bypass using Puppeteer to scrape live viewer counts.</li>
  <li><b>Advanced YouTube Quota Management:</b> Features a built-in admin dashboard (<code>/youtube-dashboard</code>) to track daily/monthly usage, archive history, and prevent API exhaustion. Operates on a strict budget target (default 85%).</li>
  <li><b>Kick OAuth2 & PKCE:</b> Fully automated Kick token generation, client credentials usage, and refreshing for reliable data extraction.</li>
  <li><b>Intelligent Puppeteer Fallback:</b> Uses headless browser scraping for platforms that require JS rendering, specifically tuned for low-core VPS environments (auto-restarts to prevent memory leaks).</li>
  <li><b>Crash-Proof Data:</b> Utilizes <code>better-sqlite3</code> in WAL mode for persistent, lightning-fast reads and writes.</li>
  <li><b>Security Hardened:</b> Routes are protected using <code>helmet</code> and <code>express-rate-limit</code>.</li>
  <li><b>Interactive Frontend:</b> Serves a fully responsive UI displaying real-time live status updates, avatars, premiere badges, and viewer counts.</li>
</ul>

<h2>🚀 Installation & Setup</h2>
<p>Ensure you have Node.js version 18 or higher installed on your system, or use Docker for a containerized deployment.</p>

<h3>Option 1: Docker Compose (Recommended)</h3>
<pre><code># 1. Clone and navigate to the directory
git clone https://github.com/Riotcoke123/danetworkcode.git
cd danetworkcode

# 2. Configure environment variables (see below)
cp .env.example .env

# 3. Build and run the container
docker-compose up -d --build
</code></pre>

<h3>Option 2: Standard Node.js / PM2</h3>
<pre><code># 1. Clone the repository
git clone https://github.com/Riotcoke123/danetworkcode.git
cd danetworkcode

2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env

# 4. Start the server
npm start

# OR start with PM2 for production deployments
npm run pm2-start
</code></pre>

<h2>⚙️ Environment Variables (<code>.env</code>)</h2>
<p>You will need to create a <code>.env</code> file in the root directory. Below are the required configurations:</p>

<pre><code># Server Settings
PORT=3000
CHECK_INTERVAL_SECONDS=300
ADMIN_TOKEN=your_secure_random_string_here
TRUST_PROXY_HOPS=1
USER_AGENT=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36

# Concurrency Limits (Tune based on your VPS cores/RAM)
CONCURRENT_LIMIT=4
PUPPETEER_CONCURRENT_LIMIT=2
MAX_SCRAPES_BEFORE_RESTART=20
SCRAPE_TIMEOUT_MS=240000

# Streamer Lists (Comma separated)
KICK_USERNAMES=streamer1,streamer2
TWITCH_USERNAMES=streamer1,streamer2
YOUTUBE_USERNAMES=streamer1,streamer2
VAUGHN_USERNAMES=streamer1,streamer2
PARTI_USER_IDS=12345,67890
PUMPFUN_MINTS=21rKrtBzibPAZHAHQRzGiGDSh7XimCKB2a8VgsjZpump,AnotherMint

# API Keys & Auth Setup
YOUTUBE_API_KEY=your_google_api_key
YOUTUBE_QUOTA_DAILY_LIMIT=1010000
YOUTUBE_MONTHLY_BUDGET_PERCENT=0.85

TWITCH_CLIENT_ID=your_twitch_client_id
TWITCH_CLIENT_SECRET=your_twitch_client_secret

KICK_CLIENT_ID=your_kick_client_id
KICK_CLIENT_SECRET=your_kick_client_secret
KICK_REDIRECT_URI=http://localhost:3000/auth/kick/callback

# Optional Parti API Token
PARTI_AUTH_TOKEN=your_parti_token

# Optional Pump.fun API Key (if required by frontend API)
PUMPFUN_API_KEY=your_pumpfun_api_key
</code></pre>

<h2>🛡️ Admin Dashboard & Endpoints</h2>
<p>This project exposes several endpoints. Admin routes require your <code>ADMIN_TOKEN</code> passed as a Bearer token or as a query parameter (<code>?token=YOUR_TOKEN</code>).</p>

<table border="1" cellspacing="0" cellpadding="8" width="100%">
  <thead>
    <tr>
      <th>Endpoint</th>
      <th>Description</th>
      <th>Access</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>/api/streamers</code></td>
      <td>Returns JSON list of all tracked streamers & their current live status.</td>
      <td>Public</td>
    </tr>
    <tr>
      <td><code>/api/stats</code></td>
      <td>Returns aggregated viewer counts and total active streams.</td>
      <td>Public</td>
    </tr>
    <tr>
      <td><code>/login/kick</code></td>
      <td>OAuth entry point to authorize the Kick API integration.</td>
      <td>Public (Rate Limited)</td>
    </tr>
    <tr>
      <td><code>/youtube-dashboard</code></td>
      <td>Visual HTML dashboard showing YouTube API quota consumption.</td>
      <td><b>Admin Only</b></td>
    </tr>
    <tr>
      <td><code>/api/youtube/quota</code></td>
      <td>Returns current YouTube quota usage and budget status data.</td>
      <td><b>Admin Only</b></td>
    </tr>
    <tr>
      <td><code>/api/youtube/audit</code></td>
      <td>Generates JSON audit history for API compliance checks.</td>
      <td><b>Admin Only</b></td>
    </tr>
    <tr>
      <td><code>/healthz</code></td>
      <td>System health, active scrapers, quota snapshots, and error logs.</td>
      <td><b>Admin Only</b></td>
    </tr>
  </tbody>
</table>

<hr>

<p align="center">
  <i>Developed & Maintained by <a href="https://github.com/Riotcoke123">Riotcoke123</a>. Released under the GNU General Public License v3.0 (GPL-3.0).</i>
</p>
