require('dotenv').config();

/* ==========================================================================
   SECURITY NOTE
   * fail2ban or a similar SSH brute-force protection is recommended on the
     host running this server to block repeated failed login attempts.
   * Sensitive admin routes (/healthz, /youtube-dashboard, /api/youtube/*)
     require a Bearer token via the Authorization header or ?token= query param.
     Set ADMIN_TOKEN in your .env file.
   ========================================================================== */

/* ==========================================================================
   IMPORTS
   ========================================================================== */
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const pLimit = require('p-limit');
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Regular Puppeteer — used for platforms that require JS rendering
const puppeteer = require('puppeteer');

/* ==========================================================================
   CONFIG
   ========================================================================== */
const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL =
  Number(process.env.CHECK_INTERVAL_SECONDS || 300) * 1000;
// API-based fetchers (Kick, Twitch, etc.) are pure I/O — no CPU cost.
// 4 concurrent is safe on a 3-core VPS; they spend 99% of time waiting on network.
const CONCURRENT_LIMIT = Number(process.env.CONCURRENT_LIMIT || 4);
const limit = pLimit(CONCURRENT_LIMIT);

// Puppeteer tasks get their own lower-concurrency pool.
// 3-core VPS: Chrome renderer = 1 process/tab.
//   2 tabs + 1 browser process + Node = 4 processes on 3 cores — optimal.
//   3 tabs would push to 5 processes and cause CDP timeouts ("Network.enable timed out").
const PUPPETEER_CONCURRENT_LIMIT = Number(process.env.PUPPETEER_CONCURRENT_LIMIT || 2);
const puppeteerLimit = pLimit(PUPPETEER_CONCURRENT_LIMIT);

// Kick API rate limiting - prevent 403 errors
const KICK_CONCURRENT_LIMIT = 3; // 3 concurrent Kick API requests (public v1 is tolerant)
const kickLimit = pLimit(KICK_CONCURRENT_LIMIT);
const KICK_REQUEST_DELAY_MS = 400; // 400ms between Kick requests — fast but safe
let lastKickRequestTime = 0;

async function delayForKick() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastKickRequestTime;
  if (timeSinceLastRequest < KICK_REQUEST_DELAY_MS) {
    const delay = KICK_REQUEST_DELAY_MS - timeSinceLastRequest;
    console.log(`Rate limiting Kick API: waiting ${delay}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  lastKickRequestTime = Date.now();
}

/* ==========================================================================
   HELPERS
   ========================================================================== */
const parseList = v =>
  (v || '').split(',').map(s => s.trim()).filter(Boolean);

const makeId = (platform, username) =>
  `${platform}:${username.toLowerCase()}`;

const toNumber = v =>
  Number(String(v || '0').replace(/[^\d]/g, '')) || 0;

const formatViewers = n => {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
};

async function optimizePage(page) {
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      // Check if page is closed before trying to abort/continue
      if (page.isClosed()) {
        return;
      }
      
      const t = req.resourceType();
      if (['image', 'font', 'media'].includes(t)) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });
  } catch (err) {
    console.log('Could not optimize page:', err.message);
  }
}

async function safeWait(page, ms) {
  try {
    await Promise.race([
      new Promise(resolve => setTimeout(resolve, ms)),
      new Promise((_, reject) =>
        page.once('close', () => reject(new Error('page closed')))
      )
    ]);
  } catch (err) {
    if (err.message === 'page closed') {
      throw err;
    }
  }
}



/* ==========================================================================
   DATABASE
   ========================================================================== */
const db = new Database(path.join(__dirname, 'data', 'mydb.sqlite'));
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS streamers (
  id TEXT PRIMARY KEY,
  platform TEXT,
  username TEXT,
  status TEXT,
  viewers TEXT,
  viewers_raw INTEGER,
  title TEXT,
  photo TEXT,
  url TEXT,
  m3u8 TEXT,
  vod_id TEXT,
  last_broadcast_time TEXT,
  updated_at TEXT
);
`);

try {
  db.exec(`ALTER TABLE streamers ADD COLUMN display_name TEXT;`);
  console.log('Migration: Added display_name column');
} catch (err) {
  if (!err.message.includes('duplicate column name')) {
    console.error('Migration error:', err.message);
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS kick_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  updated_at TEXT
);
`);

// Persists PKCE state→verifier pairs across restarts (TTL: 10 minutes)
db.exec(`
CREATE TABLE IF NOT EXISTS kick_pkce_store (
  state      TEXT PRIMARY KEY,
  verifier   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);


// Persists YouTube quota counters across server restarts so the dashboard
// never resets to 0 mid-day or mid-month.
db.exec(`
CREATE TABLE IF NOT EXISTS youtube_quota_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  daily_used      INTEGER NOT NULL DEFAULT 0,
  monthly_used    INTEGER NOT NULL DEFAULT 0,
  api_call_count  INTEGER NOT NULL DEFAULT 0,
  fallback_used   INTEGER NOT NULL DEFAULT 0,
  reset_date      TEXT,
  start_of_month  TEXT,
  history_json    TEXT NOT NULL DEFAULT '[]',
  updated_at      TEXT
);
`);

const upsertStreamer = db.prepare(`
INSERT INTO streamers (
  id, platform, username, display_name, status,
  viewers, viewers_raw, title,
  photo, url, m3u8, vod_id,
  last_broadcast_time,
  updated_at
) VALUES (
  ?,?,?,?,?,?,?,?,?,?,?,?,?,
  strftime('%Y-%m-%dT%H:%M:%SZ','now')
)
ON CONFLICT(id) DO UPDATE SET
  display_name=COALESCE(excluded.display_name, streamers.display_name),
  status=excluded.status,
  viewers=excluded.viewers,
  viewers_raw=excluded.viewers_raw,
  title=CASE
    WHEN excluded.status='online'
    THEN excluded.title
    ELSE streamers.title
  END,
  photo=CASE
    WHEN excluded.photo IS NOT NULL
    THEN excluded.photo
    ELSE streamers.photo
  END,
  url=CASE
    WHEN excluded.status='online' OR streamers.url IS NULL
    THEN excluded.url
    ELSE streamers.url
  END,
  m3u8=CASE
    WHEN excluded.status='online'
    THEN excluded.m3u8
    ELSE streamers.m3u8
  END,
  vod_id=CASE
    WHEN excluded.status='online' OR excluded.vod_id IS NOT NULL
    THEN excluded.vod_id
    ELSE streamers.vod_id
  END,
  last_broadcast_time=CASE
    WHEN excluded.last_broadcast_time IS NOT NULL
    THEN excluded.last_broadcast_time
    WHEN streamers.status='online'
     AND excluded.status='offline'
    THEN strftime('%Y-%m-%dT%H:%M:%SZ','now')
    ELSE streamers.last_broadcast_time
  END,
  updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
`);

const deleteRemovedStreamers = db.prepare(`
DELETE FROM streamers
WHERE id NOT IN (SELECT value FROM json_each(?))
`);

const saveKickTokens = db.prepare(`
INSERT INTO kick_tokens (id, access_token, refresh_token, expires_at, updated_at)
VALUES (1, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
ON CONFLICT(id) DO UPDATE SET
  access_token=excluded.access_token,
  refresh_token=excluded.refresh_token,
  expires_at=excluded.expires_at,
  updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
`);

const getKickTokens = db.prepare(`SELECT * FROM kick_tokens WHERE id = 1`);


// ---- YouTube quota persistence helpers ----
const _saveYoutubeQuotaState = db.prepare(`
  INSERT INTO youtube_quota_state
    (id, daily_used, monthly_used, api_call_count, fallback_used,
     reset_date, start_of_month, updated_at)
  VALUES (1, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  ON CONFLICT(id) DO UPDATE SET
    daily_used     = excluded.daily_used,
    monthly_used   = excluded.monthly_used,
    api_call_count = excluded.api_call_count,
    fallback_used  = excluded.fallback_used,
    reset_date     = excluded.reset_date,
    start_of_month = excluded.start_of_month,
    updated_at     = strftime('%Y-%m-%dT%H:%M:%SZ','now')
`);
const _getYoutubeQuotaState = db.prepare(`SELECT * FROM youtube_quota_state WHERE id = 1`);

// Create youtube_history table before preparing statements that reference it
db.exec(`
CREATE TABLE IF NOT EXISTS youtube_history (
  date TEXT PRIMARY KEY,
  quota_used INTEGER,
  api_calls INTEGER,
  fallback_used INTEGER,
  updated_at TEXT
);
`);

// 2. Save COMPLETED day to history (Permanent)
const _archiveDailyHistory = db.prepare(`
  INSERT INTO youtube_history (date, quota_used, api_calls, fallback_used, updated_at)
  VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  ON CONFLICT(date) DO UPDATE SET
    quota_used    = excluded.quota_used,
    api_calls     = excluded.api_calls,
    fallback_used = excluded.fallback_used,
    updated_at    = strftime('%Y-%m-%dT%H:%M:%SZ','now')
`);

// 3. Get history for the dashboard
const _getHistory = db.prepare(`SELECT * FROM youtube_history ORDER BY date ASC`);
let LAST_SCRAPE_AT = null;
let LAST_SCRAPE_ERROR = null;
const crypto = require('crypto');

// Catch unhandled rejections from puppeteer-extra-plugin-stealth's internal
// "Requesting main frame too early" and "detached Frame" errors so they
// don't bubble up and crash the CDP session / browser connection.
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  if (
    msg.includes('Requesting main frame too early') ||
    msg.includes('detached Frame') ||
    msg.includes('Session closed') ||
    msg.includes('Target closed')
  ) {
    return; // Stealth plugin / CDP lifecycle noise — safe to ignore
  }
  console.error('Unhandled rejection:', reason);
});

// ── API Base URLs (override via .env if endpoints ever change) ──────────────
const KICK_AUTH_BASE    = process.env.KICK_AUTH_BASE    || 'https://id.kick.com';
const KICK_API_BASE     = process.env.KICK_API_BASE     || 'https://api.kick.com';
const KICK_VOD_BASE     = process.env.KICK_VOD_BASE     || 'https://vod.kick.com';
const KICK_WEB_BASE     = process.env.KICK_WEB_BASE     || 'https://kick.com';
const TWITCH_AUTH_BASE  = process.env.TWITCH_AUTH_BASE  || 'https://id.twitch.tv';
const TWITCH_API_BASE   = process.env.TWITCH_API_BASE   || 'https://api.twitch.tv/helix';
const TWITCH_WEB_BASE   = process.env.TWITCH_WEB_BASE   || 'https://twitch.tv';
const VAUGHN_API_BASE   = process.env.VAUGHN_API_BASE   || 'https://api.vaughnsoft.net/v1/stream/vl';

const VAUGHN_WEB_BASE   = process.env.VAUGHN_WEB_BASE   || 'https://vaughn.live';
const YOUTUBE_API_BASE  = process.env.YOUTUBE_API_BASE  || 'https://www.googleapis.com/youtube/v3';
const LIVEPEER_CDN_BASE = process.env.LIVEPEER_CDN_BASE || 'https://livepeercdn.studio/hls';
const PARTI_API_BASE    = process.env.PARTI_API_BASE    || 'https://prod-api.parti.com';
const PARTI_WEB_BASE    = process.env.PARTI_WEB_BASE    || 'https://parti.com';
const PARTI_LIVE_PATH   = process.env.PARTI_LIVE_PATH   || '/parti_v2/profile/get_livestream_channel_info/live';
const PARTI_LIVE_LIMIT  = Number(process.env.PARTI_LIVE_LIMIT  || 100);

const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID;
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET;
const KICK_REDIRECT_URI = process.env.KICK_REDIRECT_URI || 'http://localhost:3000/auth/kick/callback';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

let kickAccessToken = null;
let kickRefreshToken = null;
let kickTokenExpiry = null;

// Track last profile photo refresh time per YouTube channel.
// Photo is re-fetched via YouTube Data API every 6 hours (online AND offline).
// The API always returns the real channel avatar (yt3.googleusercontent.com).
// HTML og:image is NOT used for photos because YouTube replaces it with the
// live-stream video thumbnail (i.ytimg.com) while a channel is broadcasting.
const youtubePhotoRefreshMap = new Map();
const YOUTUBE_PHOTO_REFRESH_MS = 6 * 60 * 60 * 1000; // 6 hours

// ============================================================================
// YOUTUBE API QUOTA TRACKING - UPDATED TO USE 85% MONTHLY BUDGET
// ============================================================================
// Read configuration from environment variables
const youtubeQuotaDailyLimit = Number(process.env.YOUTUBE_QUOTA_DAILY_LIMIT) || 1010000;
const youtubeQuotaMonthlyLimit = Number(process.env.YOUTUBE_QUOTA_MONTHLY_LIMIT) || (youtubeQuotaDailyLimit * 30);
const youtubeMonthlyBudgetPercent = Number(process.env.YOUTUBE_MONTHLY_BUDGET_PERCENT) || 0.85; // Default 85%

// Calculate budgets based on the monthly budget percentage
const youtubeMonthlyBudget = Math.floor(youtubeQuotaMonthlyLimit * youtubeMonthlyBudgetPercent);
const youtubeDailyBudget = Math.floor(youtubeMonthlyBudget / 30);

// Tracking variables — loaded from SQLite on startup so they survive restarts
let youtubeQuotaUsed = 0;
let youtubeQuotaResetTime = null;
let youtubeApiCallCount = 0;
let youtubeApiFallbackUsed = false;
let youtubeQuotaStartOfMonth = null;
let youtubeMonthlyQuotaUsed = 0;
let youtubeQuotaHistory = [];

/**
 * Write current quota state to SQLite so it survives process restarts.
 * Called after every quota increment and after every daily/monthly reset.
 */
function persistYoutubeQuotaState() {
  try {
    // Save current counters
    _saveYoutubeQuotaState.run(
      youtubeQuotaUsed,
      youtubeMonthlyQuotaUsed,
      youtubeApiCallCount,
      youtubeApiFallbackUsed ? 1 : 0,
      youtubeQuotaResetTime,
      youtubeQuotaStartOfMonth
    );
  } catch (err) {
    console.error('Failed to persist YouTube quota state:', err.message);
  }
}

// Path for the JSON backup file (written alongside the SQLite DB)
const YOUTUBE_HISTORY_JSON_PATH = path.join(__dirname, 'data', 'youtube-quota-history.json');

/**
 * Archive a completed day's stats to BOTH the youtube_history SQLite table
 * AND a JSON backup file so history is never lost on restart.
 *
 * @param {string} date       - 'YYYY-MM-DD' of the completed day
 * @param {number} quotaUsed  - Total quota units consumed that day
 * @param {number} apiCalls   - Number of API calls made that day
 * @param {boolean} fallback  - Whether the fallback scraper was used
 */
function archiveDailyHistory(date, quotaUsed, apiCalls, fallback) {
  // 1. Persist to SQLite (primary store)
  try {
    _archiveDailyHistory.run(date, quotaUsed, apiCalls, fallback ? 1 : 0);
    console.log(`YouTube history archived to SQLite for ${date}: ${quotaUsed} units, ${apiCalls} calls`);
  } catch (err) {
    console.error('Failed to archive YouTube daily history to SQLite:', err.message);
  }

  // 2. Write JSON backup file (redundant safety net)
  try {
    const fs = require('fs');
    let backup = {};
    if (fs.existsSync(YOUTUBE_HISTORY_JSON_PATH)) {
      try {
        backup = JSON.parse(fs.readFileSync(YOUTUBE_HISTORY_JSON_PATH, 'utf8'));
      } catch (_) { backup = {}; }
    }
    backup[date] = {
      date,
      quota_used: quotaUsed,
      api_calls: apiCalls,
      fallback_used: !!fallback,
      archived_at: new Date().toISOString()
    };
    // Keep only the last 365 days in the JSON file
    const keys = Object.keys(backup).sort();
    if (keys.length > 365) {
      keys.slice(0, keys.length - 365).forEach(k => delete backup[k]);
    }
    fs.writeFileSync(YOUTUBE_HISTORY_JSON_PATH, JSON.stringify(backup, null, 2));
    console.log(`YouTube history JSON backup updated: ${YOUTUBE_HISTORY_JSON_PATH}`);
  } catch (err) {
    console.error('Failed to write YouTube history JSON backup:', err.message);
  }
}
/**
 * Load quota state from SQLite on startup.
 * - Daily counters are restored only if the saved date matches today (UTC).
 * - Monthly counters are restored only if the saved month matches this month.
 * - History is always restored.
 */
function loadYoutubeQuotaState() {
  try {
    // 1. Load History from the dedicated SQLite table (primary source)
    let historyRows = _getHistory.all();

    // 1b. If SQLite history is empty, try to seed from the JSON backup file
    if (historyRows.length === 0) {
      try {
        const fs = require('fs');
        if (fs.existsSync(YOUTUBE_HISTORY_JSON_PATH)) {
          const backup = JSON.parse(fs.readFileSync(YOUTUBE_HISTORY_JSON_PATH, 'utf8'));
          const entries = Object.values(backup).sort((a, b) => a.date.localeCompare(b.date));
          if (entries.length > 0) {
            console.log(`YouTube quota: SQLite history empty — restoring ${entries.length} days from JSON backup.`);
            for (const e of entries) {
              _archiveDailyHistory.run(e.date, e.quota_used || 0, e.api_calls || 0, e.fallback_used ? 1 : 0);
            }
            historyRows = _getHistory.all(); // Re-read after seeding
          }
        }
      } catch (jsonErr) {
        console.warn('Could not restore YouTube history from JSON backup:', jsonErr.message);
      }
    }

    youtubeQuotaHistory = historyRows.map(row => ({
      date: row.date,
      quota_used: row.quota_used,
      api_calls: row.api_calls,
      fallback_used: !!row.fallback_used
    }));

    // 2. Load Current State
    const row = _getYoutubeQuotaState.get();
    if (!row) {
      console.log('YouTube quota state: no saved state found, starting fresh.');
      return;
    }

    const todayUTC = new Date().toISOString().split('T')[0];
    const currentMonth = new Date().toISOString().substring(0, 7);

    // Check if we need to roll over the day
    if (row.reset_date !== todayUTC) {
      console.log(`New day detected (Last: ${row.reset_date}, Today: ${todayUTC}). Resetting daily counters.`);
      // Archive the previous day before clearing (handles the case where server was down at midnight)
      if (row.reset_date && row.daily_used > 0) {
        archiveDailyHistory(row.reset_date, row.daily_used, row.api_call_count, !!row.fallback_used);
      }
      youtubeQuotaUsed = 0;
      youtubeApiCallCount = 0;
      youtubeApiFallbackUsed = false;
      youtubeQuotaResetTime = todayUTC;
    } else {
      // Same day, restore counters
      youtubeQuotaUsed = row.daily_used || 0;
      youtubeApiCallCount = row.api_call_count || 0;
      youtubeApiFallbackUsed = !!row.fallback_used;
      youtubeQuotaResetTime = row.reset_date;
    }

    // Check if we need to roll over the month
    if (row.start_of_month !== currentMonth) {
      console.log(`New month detected (Last: ${row.start_of_month}, Today: ${currentMonth}). Resetting monthly counters.`);
      youtubeMonthlyQuotaUsed = 0;
      youtubeQuotaStartOfMonth = currentMonth;
    } else {
      youtubeMonthlyQuotaUsed = row.monthly_used || 0;
      youtubeQuotaStartOfMonth = row.start_of_month;
    }

    console.log(`YouTube quota loaded: Daily ${youtubeQuotaUsed}, Monthly ${youtubeMonthlyQuotaUsed}. History length: ${youtubeQuotaHistory.length}`);
    
    // Save the corrected state immediately
    persistYoutubeQuotaState();
  } catch (err) {
    console.error('Failed to load YouTube quota state:', err.message);
  }
}

loadYoutubeQuotaState();

// Log quota configuration on startup
console.log('='.repeat(80));
console.log('YOUTUBE API QUOTA CONFIGURATION');
console.log('='.repeat(80));
console.log(`Daily Quota Limit:        ${youtubeQuotaDailyLimit.toLocaleString()} units/day`);
console.log(`Monthly Quota Limit:      ${youtubeQuotaMonthlyLimit.toLocaleString()} units/month`);
console.log(`Monthly Budget Target:    ${(youtubeMonthlyBudgetPercent * 100).toFixed(0)}%`);
console.log(`Monthly Budget Allocated: ${youtubeMonthlyBudget.toLocaleString()} units/month`);
console.log(`Daily Budget Target:      ${youtubeDailyBudget.toLocaleString()} units/day (avg)`);
console.log('='.repeat(80));



// PKCE storage — persisted to SQLite so it survives PM2 restarts
const _savePkce   = db.prepare(`INSERT OR REPLACE INTO kick_pkce_store (state, verifier, created_at) VALUES (?, ?, ?)`);
const _getPkce    = db.prepare(`SELECT verifier FROM kick_pkce_store WHERE state = ?`);
const _deletePkce = db.prepare(`DELETE FROM kick_pkce_store WHERE state = ?`);
const _prunePkce  = db.prepare(`DELETE FROM kick_pkce_store WHERE created_at < ?`); // prune > 10 min old

function pkceSet(state, verifier) {
  _prunePkce.run(Date.now() - 600_000);
  _savePkce.run(state, verifier, Date.now());
}
function pkceGet(state) {
  const row = _getPkce.get(state);
  return row ? row.verifier : undefined;
}
function pkceDelete(state) {
  _deletePkce.run(state);
}

// Generate PKCE code verifier and challenge
function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  
  return { codeVerifier, codeChallenge };
}

function loadKickTokens() {
  try {
    const row = getKickTokens.get();
    if (row) {
      kickAccessToken = row.access_token;
      kickRefreshToken = row.refresh_token;
      kickTokenExpiry = row.expires_at;
      console.log('Kick tokens loaded from database');
    }
  } catch (err) {
    console.log('No Kick tokens in database');
  }
}

loadKickTokens();

function getKickAuthUrl() {
  // FIXED: Use id.kick.com instead of kick.com
  const baseUrl = `${KICK_AUTH_BASE}/oauth/authorize`;
  
  // Generate PKCE parameters
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');
  
  // Store for later verification (DB-backed, survives restarts)
  pkceSet(state, codeVerifier);
  
  const params = new URLSearchParams({
    client_id: KICK_CLIENT_ID,
    redirect_uri: KICK_REDIRECT_URI,
    response_type: 'code',
    scope: 'user:read channel:read livestream:read',
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });
  
  return `${baseUrl}?${params.toString()}`;
}

async function exchangeKickCode(code, state) {
  try {
    // Get the code verifier from persistent store
    const codeVerifier = pkceGet(state);
    if (!codeVerifier) {
      throw new Error('Invalid state or PKCE verifier not found');
    }
    
    // Clean up
    pkceDelete(state);
    
    // Kick uses OAuth 2.1 with PKCE (public client flow).
    // Do NOT send client_secret — Kick rejects it with 401 invalid_client.
    const body = new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     KICK_CLIENT_ID,
      redirect_uri:  KICK_REDIRECT_URI,
      code:          code,
      code_verifier: codeVerifier
    });

    // Kick requires client_secret even in PKCE flow
    if (KICK_CLIENT_SECRET) body.set('client_secret', KICK_CLIENT_SECRET);

    const response = await fetch(`${KICK_AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    kickAccessToken = data.access_token;
    kickRefreshToken = data.refresh_token;
    kickTokenExpiry = Date.now() + (data.expires_in * 1000);
    
    saveKickTokens.run(kickAccessToken, kickRefreshToken, kickTokenExpiry);
    console.log('Kick OAuth2 tokens obtained and saved');
    return data;
  } catch (error) {
    console.error('Error exchanging Kick code:', error.message);
    throw error;
  }
}

async function refreshKickToken() {
  if (!kickRefreshToken) {
    throw new Error('No refresh token available');
  }

  try {
    // FIXED: Use id.kick.com
    const response = await fetch(`${KICK_AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: KICK_CLIENT_ID,
        // No client_secret — Kick PKCE flow is a public client
        refresh_token: kickRefreshToken
      }).toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    kickAccessToken = data.access_token;
    kickRefreshToken = data.refresh_token || kickRefreshToken;
    kickTokenExpiry = Date.now() + (data.expires_in * 1000);
    
    saveKickTokens.run(kickAccessToken, kickRefreshToken, kickTokenExpiry);
    console.log('Kick token refreshed');
    return data;
  } catch (error) {
    console.error('Error refreshing Kick token:', error.message);
    throw error;
  }
}

async function getKickToken() {
  // Token expiring soon — refresh or re-fetch
  if (kickAccessToken && kickTokenExpiry && Date.now() >= (kickTokenExpiry - 300000)) {
    try {
      if (kickRefreshToken) {
        await refreshKickToken();
      } else {
        await fetchKickAppToken();
      }
    } catch (err) {
      console.error('Failed to refresh Kick token:', err.message);
      kickAccessToken = null;
    }
  }

  // No token at all — bootstrap via client_credentials
  if (!kickAccessToken) {
    await fetchKickAppToken();
  }

  return kickAccessToken;
}

// Separate app-level token for public channel lookups.
// This must NOT be the user OAuth token — using a user token causes the API
// to return that user's own channel regardless of broadcaster_username param.
let kickAppToken = null;
let kickAppTokenExpiry = null;

async function getKickAppToken() {
  if (kickAppToken && kickAppTokenExpiry && Date.now() < kickAppTokenExpiry - 60_000) {
    return kickAppToken;
  }
  const result = await fetchKickAppToken();
  return result;
}

/**
 * Fetch a server-to-server app token via client_credentials grant.
 * Requires no user interaction — auto-bootstraps and auto-refreshes.
 * Updates both the app token slot (kickAppToken) and the main token slot.
 */
async function fetchKickAppToken() {
  if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET) {
    console.warn('Kick client_credentials: KICK_CLIENT_ID or KICK_CLIENT_SECRET not set');
    return null;
  }
  try {
    const res = await fetch(`${KICK_AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     KICK_CLIENT_ID,
        client_secret: KICK_CLIENT_SECRET,
      }).toString()
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`Kick client_credentials failed: ${res.status} ${errText}`);
      return null;
    }

    const data = await res.json();
    kickAppToken       = data.access_token;
    kickAppTokenExpiry = Date.now() + ((data.expires_in || 3600) * 1000);
    // Also store in the main token slot for refreshing
    kickAccessToken  = data.access_token;
    kickRefreshToken = data.refresh_token || kickRefreshToken;
    kickTokenExpiry  = kickAppTokenExpiry;
    saveKickTokens.run(kickAccessToken, kickRefreshToken, kickTokenExpiry);
    console.log(`Kick app token obtained via client_credentials (expires in ${data.expires_in}s)`);
    return kickAppToken;
  } catch (err) {
    console.error('Kick client_credentials error:', err.message);
    return null;
  }
}

/**
 * Scrape a Kick channel's profile photo URL using Puppeteer.
 * Only called when no cached photo exists in the DB.
 * Returns the profile picture URL string or null.
 */
async function scrapeKickChannelMeta(username) {
  // Returns { photo, displayName } scraped from the Kick channel page.
  // og:image  → profile picture URL
  // og:title  → "Real Name - Kick" → strip " - Kick" suffix for display name
  if (!browserInstance) {
    console.warn(`scrapeKickChannelMeta(${username}): no browser available`);
    return { photo: null, displayName: null };
  }
  const page = await browserInstance.newPage();
  try {
    await optimizePage(page);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.goto(`${KICK_WEB_BASE}/${encodeURIComponent(username)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });

    const meta = await page.evaluate(() => {
      const ogImage    = document.querySelector('meta[property="og:image"]');
      const ogImageSec = document.querySelector('meta[property="og:image:secure_url"]');
      const ogTitle    = document.querySelector('meta[property="og:title"]');

      // Try og:image / og:image:secure_url first
      let photo = null;
      for (const tag of [ogImage, ogImageSec]) {
        if (tag?.content?.startsWith('http')) {
          photo = tag.content;
          break;
        }
      }

      // Fallback: look for the profile avatar <img> directly in the page.
      // Kick serves profile pictures from their CDN (imagedelivery.net or
      // d2egosedh42y9k.cloudfront.net). When offline, og:image is often
      // absent or a generic placeholder, but the avatar <img> is still rendered.
      if (!photo) {
        const candidates = Array.from(document.querySelectorAll('img[src]'));
        const cdnPatterns = [
          /files\.kick\.com\/images\/user/,   // primary: files.kick.com/images/user/...
          /imagedelivery\.net/,
          /d2egosedh42y9k\.cloudfront\.net/,
          /kick\.com\/storage\/user/,
          /kick-public.*profile/i,
        ];
        for (const img of candidates) {
          const src = img.src || '';
          if (src.startsWith('http') && cdnPatterns.some(p => p.test(src))) {
            photo = src;
            break;
          }
        }
      }

      let displayName = null;
      if (ogTitle?.content) {
        // Strip online suffix: " Stream - Watch Live on Kick" and variants
        // Strip offline suffix: " - Kick"
        displayName = ogTitle.content
          .replace(/\s+Stream\b.*$/i, '')  // online: "Name Stream - Watch Live on Kick" → "Name"
          .replace(/\s*-\s*Kick\s*$/i, '') // offline: "Name - Kick" → "Name"
          .trim() || null;
      }

      return { photo, displayName };
    });

    return meta;
  } catch (err) {
    console.warn(`scrapeKickChannelMeta(${username}): ${err.message}`);
    return { photo: null, displayName: null };
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchKick(username) {
  // Official Kick Public API v1
  // IMPORTANT: Must use client_credentials app token, NOT user OAuth token.
  // Using a user token causes the API to return that user's own channel
  // for every request, ignoring the slug query param.
  try {
    await delayForKick();

    const token = await getKickAppToken();
    if (!token) {
      console.error(`Kick: no app token available, skipping ${username}`);
      return null;
    }

    const headers = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Client-ID': KICK_CLIENT_ID,
    };

    const res = await fetch(
      `${KICK_API_BASE}/public/v1/channels?slug=${encodeURIComponent(username)}`,
      { headers }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`Kick API error for ${username}: ${res.status} ${body}`);
      return null;
    }

    const json = await res.json();
    // API returns { data: [ { ...channel... } ], message: 'OK' }
    const channel = Array.isArray(json.data) ? json.data[0] : null;
    if (!channel) {
      // Try lowercase slug — public v1 API is case-sensitive
      if (username !== username.toLowerCase()) {
        console.log(`Kick: no data for ${username}, retrying with lowercase...`);
        return fetchKick(username.toLowerCase());
      }
      console.log(`Kick: no channel data returned for ${username} (full response: ${JSON.stringify(json).slice(0, 200)})`);
      return null;
    }

    // The stream object always exists even when offline — use is_live field only
    const stream = channel.stream || null;
    const isLive = stream?.is_live === true;
    const viewerCount = isLive ? (stream?.viewer_count || 0) : 0;
    const raw = isLive ? toNumber(viewerCount) : 0;

    // stream_title is at the channel level in public v1
    const title = isLive ? (channel.stream_title || stream?.session_title || null) : null;

    // start_time from stream (zero value "0001-01-01T00:00:00Z" means not live)
    let lastBroadcastTime = null;
    const ts = stream?.start_time || stream?.started_at;
    if (ts && !ts.startsWith('0001')) {
      try {
        const d = new Date(ts);
        if (!isNaN(d.getTime())) lastBroadcastTime = d.toISOString();
      } catch (_) {}
    }

    // m3u8 / VOD: fetch directly via API (no Puppeteer).
    // Check v1 channel data first for playback_url, then hit v2 endpoints.
    const existingRowPre = db.prepare('SELECT photo, display_name, vod_id FROM streamers WHERE id = ?').get(makeId('kick', username));

    // Quick check: v1 channel data sometimes includes playback_url directly
    const v1PlaybackUrl = stream?.playback_url || stream?.url || null;

    // Only call v2 if: live (need fresh m3u8) or no cached VOD yet
    const needsV2 = isLive || !existingRowPre?.vod_id;

    let m3u8 = (isLive && v1PlaybackUrl) ? v1PlaybackUrl : null;
    let kickVodId = existingRowPre?.vod_id || null;

    if (needsV2) {
      const v2Result = await fetchKickV2StreamData(username, isLive, headers);
      if (v2Result.m3u8)   m3u8      = v2Result.m3u8;
      if (v2Result.vod_id) kickVodId = v2Result.vod_id;
    }

    // Profile photo + display name: fetch from Kick Public API v1 /users endpoint.
    // Uses broadcaster_user_id returned by the channels endpoint.
    // Falls back to the existing DB value so we never lose a previously fetched photo.
    const existingRow = existingRowPre; // already fetched above
    const needsPhoto = true; // always refresh profile photo on every pull
    const needsDisplayName = !existingRow?.display_name || existingRow.display_name === username.toLowerCase();

    let photo = existingRow?.photo || null;
    let scrapedDisplayName = existingRow?.display_name || null;

    if ((needsPhoto || needsDisplayName) && channel.broadcaster_user_id) {
      try {
        const userRes = await fetch(
          `${KICK_API_BASE}/public/v1/users?id=${channel.broadcaster_user_id}`,
          { headers }
        );
        if (userRes.ok) {
          const userJson = await userRes.json();
          const user = Array.isArray(userJson.data) ? userJson.data[0] : null;
          if (user) {
            if (needsPhoto && user.profile_picture) {
              photo = user.profile_picture;
              console.log(`Kick ${username}: got profile photo via users API`);
            }
            if (needsDisplayName && user.name) {
              scrapedDisplayName = user.name;
              console.log(`Kick ${username}: display name = "${user.name}" (via users API)`);
            }
            // Always save streamer_channel.playback_url as m3u8 — it is the
            // channel's permanent IVS HLS endpoint and is valid live or offline.
            const userPlaybackUrl = user.streamer_channel?.playback_url || null;
            if (userPlaybackUrl) {
              m3u8 = userPlaybackUrl;
              console.log(`Kick ${username}: m3u8 from users API streamer_channel.playback_url = ${userPlaybackUrl}`);
            }
          }
        } else {
          console.warn(`Kick users API for ${username} (id=${channel.broadcaster_user_id}): ${userRes.status}`);
        }
      } catch (userErr) {
        console.warn(`Kick ${username}: users API fetch failed: ${userErr.message}`);
      }
    }

    const displayName = scrapedDisplayName || channel.slug || username;

    console.log(`Kick ${username}: ${isLive ? 'ONLINE' : 'OFFLINE'} viewers=${raw} photo=${photo ? 'yes' : 'no'}`);

    return {
      id: makeId('kick', username),
      platform: 'kick',
      username: username.toLowerCase(),
      display_name: displayName,
      status: isLive ? 'online' : 'offline',
      viewers_raw: raw,
      viewers: formatViewers(raw),
      title,
      photo,
      url: `${KICK_WEB_BASE}/${username}`,
      m3u8: m3u8,
      vod_id: kickVodId,
      last_broadcast_time: lastBroadcastTime
    };
  } catch (err) {
    console.error(`Kick error for ${username}:`, err.message);
    return null;
  }
}

/**
 * Fetch Kick m3u8 playback URL (when live) and latest VOD URL
 * directly from the Kick v2 API using the authorized Bearer token.
 *
 * No Puppeteer needed — the Bearer token + Client-ID header satisfies
 * Cloudflare's bot checks on the v2 endpoints.
 *
 * - Live:  GET /api/v2/channels/{slug}
 *          → .livestream.playback_url  (HLS m3u8)
 * - VOD:   GET /api/v2/channels/{slug}/videos?sort=date&time=year&page=1&limit=1
 *          → .data[0].video.uuid → https://vod.kick.com/videos/{uuid}/master.m3u8
 *
 * @param {string}  username — channel slug
 * @param {boolean} isLive   — whether the channel is currently live
 * @param {object}  headers  — pre-built headers with Bearer token + Client-ID
 * @returns {Promise<{m3u8: string|null, vod_id: string|null}>}
 */
async function fetchKickV2StreamData(username, isLive, headers) {
  const out = { m3u8: null, vod_id: null };

  const apiHeaders = headers || {
    'Accept': 'application/json',
    'Authorization': `Bearer ${await getKickAppToken()}`,
    'Client-ID': KICK_CLIENT_ID,
  };

  try {
    // ── Live m3u8 ────────────────────────────────────────────────────────
    if (isLive) {
      try {
        const liveRes = await fetch(
          `${KICK_API_BASE}/public/v1/channels?slug=${encodeURIComponent(username)}`,
          { headers: apiHeaders }
        );
        if (liveRes.ok) {
          const liveJson = await liveRes.json();
          const ch = Array.isArray(liveJson.data) ? liveJson.data[0] : null;
          const url = ch?.stream?.playback_url
                   || ch?.livestream?.playback_url
                   || ch?.stream?.url
                   || null;
          if (url && url.includes('.m3u8')) {
            out.m3u8 = url;
            console.log(`Kick ${username}: live m3u8 from v1 API = ${url}`);
          }
        }
      } catch (liveErr) {
        console.warn(`Kick ${username}: v1 live fetch failed: ${liveErr.message}`);
      }

      // Fallback: v2 channel endpoint if v1 didn't return a playback URL
      if (!out.m3u8) {
        try {
          const v2Res = await fetch(
            `${KICK_API_BASE}/v2/channels/${encodeURIComponent(username)}`,
            { headers: apiHeaders }
          );
          if (v2Res.ok) {
            const v2Json = await v2Res.json();
            const url = v2Json?.livestream?.playback_url || null;
            if (url && url.includes('.m3u8')) {
              out.m3u8 = url;
              console.log(`Kick ${username}: live m3u8 from v2 API = ${url}`);
            }
          }
        } catch (v2Err) {
          console.warn(`Kick ${username}: v2 live fetch failed: ${v2Err.message}`);
        }
      }

      // Final fallback: Kick web API — most reliable source for livestream.playback_url
      if (!out.m3u8) {
        try {
          const webRes = await fetch(
            `${KICK_WEB_BASE}/api/v1/channels/${encodeURIComponent(username)}`,
            { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
          );
          if (webRes.ok) {
            const webJson = await webRes.json();
            const url = webJson?.livestream?.playback_url || null;
            if (url && url.includes('.m3u8')) {
              out.m3u8 = url;
              console.log(`Kick ${username}: live m3u8 from web API = ${url}`);
            }
          }
        } catch (webErr) {
          console.warn(`Kick ${username}: web API live fetch failed: ${webErr.message}`);
        }
      }
    }

    // ── Latest VOD ───────────────────────────────────────────────────────
    try {
      const vodRes = await fetch(
        `${KICK_API_BASE}/v2/channels/${encodeURIComponent(username)}/videos?sort=date&time=year&page=1&limit=1`,
        { headers: apiHeaders }
      );
      if (vodRes.ok) {
        const vodJson = await vodRes.json();
        const vodEntry = Array.isArray(vodJson?.data) ? vodJson.data[0] : null;
        if (vodEntry) {
          // Primary: video.uuid → build CDN URL
          const uuid = vodEntry?.video?.uuid || null;
          // Fallbacks: top-level source, or direct url field
          const src  = vodEntry?.source || vodEntry?.url || null;
          if (uuid) {
            out.vod_id = `${KICK_VOD_BASE}/videos/${uuid}/master.m3u8`;
          } else if (src && (src.includes('.m3u8') || src.startsWith('http'))) {
            out.vod_id = src;
          }
          if (out.vod_id) console.log(`Kick ${username}: VOD from v2 API = ${out.vod_id}`);
        }
      } else {
        // Fallback: try v1 video endpoint if it exists
        const vodV1Res = await fetch(
          `${KICK_API_BASE}/public/v1/video?channel_name=${encodeURIComponent(username)}&limit=1`,
          { headers: apiHeaders }
        );
        if (vodV1Res.ok) {
          const vodV1Json = await vodV1Res.json();
          const vodEntry = Array.isArray(vodV1Json?.data) ? vodV1Json.data[0] : null;
          const uuid = vodEntry?.video?.uuid || null;
          const src  = vodEntry?.source || vodEntry?.url || null;
          if (uuid) {
            out.vod_id = `${KICK_VOD_BASE}/videos/${uuid}/master.m3u8`;
          } else if (src) {
            out.vod_id = src;
          }
          if (out.vod_id) console.log(`Kick ${username}: VOD from v1 API = ${out.vod_id}`);
        }
      }
    } catch (vodErr) {
      console.warn(`Kick ${username}: VOD fetch failed: ${vodErr.message}`);
    }

  } catch (err) {
    console.warn(`fetchKickV2StreamData(${username}): ${err.message}`);
  }

  return out;
}

/**
 * Optional: Fetch detailed user information from Kick Users API
 * This is separate from channel data and includes bio, social links, etc.
 * Reference: https://docs.kick.com/apis/users
 * @param {number} userId - The numeric user ID
 * @returns {Promise<Object|null>}
 */
async function fetchKickUser(userId) {
  try {
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    const userRes = await fetch(
      `${KICK_WEB_BASE}/api/v2/users/${userId}`,
      { headers }
    );

    if (!userRes.ok) {
      console.error(`Kick Users API error for ID ${userId}: ${userRes.status}`);
      return null;
    }

    const userData = await userRes.json();
    return userData;
  } catch (err) {
    console.error(`Kick user fetch error for ID ${userId}:`, err.message);
    return null;
  }
}

/* ==========================================================================
   TWITCH
   ========================================================================== */
let twitchToken;

async function getTwitchToken() {
  if (twitchToken) return twitchToken;
  const res = await fetch(
    `${TWITCH_AUTH_BASE}/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  const json = await res.json();
  twitchToken = json.access_token;
  return twitchToken;
}

async function fetchTwitch(username) {
  try {
    const token = await getTwitchToken();
    const headers = {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`
    };

    const userRes = await fetch(
      `${TWITCH_API_BASE}/users?login=${username}`,
      { headers }
    );
    const user = (await userRes.json()).data?.[0];
    if (!user) return null;

    const streamRes = await fetch(
      `${TWITCH_API_BASE}/streams?user_id=${user.id}`,
      { headers }
    );
    const stream = (await streamRes.json()).data?.[0];
    const raw = stream?.viewer_count || 0;

    let vodId = null;
    if (stream) {
      try {
        const videosRes = await fetch(
          `${TWITCH_API_BASE}/videos?user_id=${user.id}&first=1&type=archive`,
          { headers }
        );
        const videos = (await videosRes.json()).data;
        if (videos?.[0]) vodId = videos[0].id;
      } catch (vodErr) {
        console.log(`Failed to fetch VOD for ${username}:`, vodErr.message);
      }
    }

    return {
      id: makeId('twitch', username),
      platform: 'twitch',
   username: username.toLowerCase(),  // <-- Fix: enforce lowercase for the DB
      display_name: user.display_name,   // <-- Fix: explicitly set display_name
      status: stream ? 'online' : 'offline',
      viewers_raw: raw,
      viewers: formatViewers(raw),
      title: stream?.title || null,
      photo: user.profile_image_url,
      url: `${TWITCH_WEB_BASE}/${user.login}`,
      m3u8: null,
      vod_id: vodId,
      last_broadcast_time: null
    };
  } catch (err) {
    console.error(`Twitch error for ${username}:`, err.message);
    return null;
  }
}

/* ==========================================================================
   VAUGHN - FIXED: Properly detect online/offline status
   ========================================================================== */
async function fetchVaughn(username) {
  try {
    const res = await fetch(
      `${VAUGHN_API_BASE}/${username}`
    );
    
    // Check if response is JSON
    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      console.log(`Vaughn API returned non-JSON for ${username}, skipping`);
      return null;
    }
    
    const j = await res.json();
    
    const raw = toNumber(j.viewers);

    let lastBroadcast = null;
    if (j.lastlive && j.lastlive !== "0") {
      try {
        const d = new Date(parseInt(j.lastlive) * 1000);
        if (d && !isNaN(d)) {
          lastBroadcast = d.toISOString();
        }
      } catch {}
    }

    // FIXED: Use the 'live' boolean field - this is the actual live status
    // j.live = true means actively broadcasting
    // j.live = false means offline
    const isOnline = j.live === true;

    // Decode status message if available
    let decodedStatus = null;
    if (j.status_msg) {
      try {
        decodedStatus = Buffer.from(j.status_msg, 'base64').toString('utf-8');
      } catch {}
    }

    return {
      id: makeId('vaughn', username),
      platform: 'vaughn',
      username: username.toLowerCase(),         // <-- Fix
      display_name: j.display_name || username, // <-- Fix
      status: isOnline ? 'online' : 'offline',
      viewers_raw: raw,
      viewers: formatViewers(raw),
      title: decodedStatus || null,
      photo: j.profile_img || null,
      url: j.url || `${VAUGHN_WEB_BASE}/${username}`,
      m3u8: null,
      vod_id: null,
      last_broadcast_time: lastBroadcast
    };
  } catch (err) {
    console.error(`Vaughn error for ${username}:`, err.message);
    return null;
  }
}

/* ==========================================================================
   YOUTUBE (FAST HTTP) - Plain fetch to @username/live, zero Puppeteer, zero quota
   
   YouTube embeds all live-status data in the initial HTML — no JS execution needed.
   
   Flow per channel:
     1. GET https://www.youtube.com/@username/live  (free, ~100ms)
     2. Parse ytInitialData from HTML for: isLive, videoId, title, displayName, photo
     3. If live → fetch viewer count via API (1 quota unit)
     4. Falls back to fetchYouTubeAPI() on any error
   
   vs old Puppeteer approach:
     - Old: 2 concurrent Chrome tabs, ~5-8s per channel, browser crashes cascade
     - New: 4 concurrent HTTP fetches, ~100-300ms per channel, no browser needed
   
   Quota cost:
     - Offline channel: 0 units
     - Live channel:    1 unit (viewer count only)
     - Photo fallback:  100 units (only first time, then cached in DB forever)
   ========================================================================== */
async function fetchYouTubeLive(username) {
  try {
    // Pull cached meta from DB — photo/display_name only fetched once then reused
    const cached = db.prepare('SELECT photo, display_name FROM streamers WHERE id = ?')
                     .get(makeId('youtube', username));

    // ── 1. Fetch /live page — plain HTTP, zero quota ─────────────────────────
    const livePageUrl = `https://www.youtube.com/@${username}/live`;
    const res = await fetch(livePageUrl, {
      headers: {
        'User-Agent': process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      console.warn(`YouTube @${username}: HTTP ${res.status} — trying API fallback`);
      return YOUTUBE_API_KEY ? await fetchYouTubeAPI(username) : null;
    }

    const html = await res.text();

    // ── 2. videoId — from redirect URL, then canonical tag ───────────────────
    // When a channel is live, YouTube redirects /@username/live → /watch?v=ID.
    const finalUrl      = res.url;
    const finalVidMatch = finalUrl.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    let   videoId       = finalVidMatch?.[1] || null;

    if (!videoId) {
      const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)"/);
      const cvid = canonicalMatch?.[1]?.match(/[?&]v=([A-Za-z0-9_-]{11})/);
      if (cvid) videoId = cvid[1];
    }

    // Third fallback: og:url meta tag (reliable for live watch pages)
    if (!videoId) {
      const ogUrlMatch = html.match(/<meta property="og:url" content="([^"]+)"/);
      const ogvid = ogUrlMatch?.[1]?.match(/[?&]v=([A-Za-z0-9_-]{11})/);
      if (ogvid) videoId = ogvid[1];
    }

    // Fourth fallback: scan ytInitialData for the active video's ID
    if (!videoId) {
      const ytVidMatch = html.match(/"currentVideoEndpoint"[^}]{0,300}"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
      if (ytVidMatch) videoId = ytVidMatch[1];
    }

    // Fifth fallback: broadcastId — YouTube embeds this specifically for live streams
    if (!videoId) {
      const broadcastMatch = html.match(/"broadcastId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
      if (broadcastMatch) videoId = broadcastMatch[1];
    }

    // Sixth fallback: videoId adjacent to isLive:true in ytInitialData JSON
    if (!videoId) {
      const liveVidMatch = html.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"[^}]{0,300}"isLive"\s*:\s*true/)
                        || html.match(/"isLive"\s*:\s*true[^}]{0,300}"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
      if (liveVidMatch) videoId = liveVidMatch[1];
    }

    // ── 3. Scheduled check ───────────────────────────────────────────────────
    // Scheduled/waiting streams also redirect to watch?v=ID — must exclude them.
    const isScheduled = !!(videoId && (
      html.includes('"isUpcoming":true')   ||
      html.includes('"isUpcoming": true')  ||
      html.includes('"style":"UPCOMING"')  ||
      html.includes('"style": "UPCOMING"') ||
      html.includes('"text":"1 waiting"')  ||
      html.includes('" waiting"')
    ));

    if (isScheduled) {
      console.log(`YouTube @${username}: scheduled stream — treating as OFFLINE`);
    }

    // ── 4. Live signal detection — STRONG vs WEAK ────────────────────────────
    // STRONG signals only appear during an active live stream.
    const hasStrongLiveSignal = !isScheduled && (
      html.includes('"isLive":true')               ||
      html.includes('"isLive": true')              ||
      html.includes('"isLiveNow":true')            ||
      html.includes('"isLiveNow": true')           ||
      html.includes('"style":"LIVE"')              ||
      html.includes('"style": "LIVE"')             ||
      html.includes('"BADGE_STYLE_TYPE_LIVE_NOW"') ||
      html.includes('{"text":"LIVE"}')             ||
      html.includes('"text":"LIVE"')               ||
      html.includes('"text": "LIVE"')
    );

    // WEAK signals also appear on replay/VOD pages for past livestreams.
    // "liveChatRenderer"  → live chat replay panel is present on VODs.
    // "allowLiveDvr":true → persists on ended-stream VOD pages.
    // "hlsManifestUrl"    → sometimes present on non-live pages.
    // These alone cannot confirm live status — always require API verification.
    const hasWeakLiveSignal = !isScheduled && !hasStrongLiveSignal && (
      html.includes('"hlsManifestUrl"')            ||
      html.includes('"liveStreamabilityRenderer"') ||
      html.includes('"allowLiveDvr":true')         ||
      html.includes('"allowLiveDvr": true')        ||
      html.includes('"liveChatRenderer"')
    );

    const hasLiveSignal = hasStrongLiveSignal || hasWeakLiveSignal;

    // ── 5. Determine live status; API-verify all ambiguous cases ─────────────
    // Strong signal → trust immediately (no quota cost). videoId is NOT required
    // here — the live badge/isLive flag in the HTML is authoritative on its own.
    // Previously this was `!!(videoId && hasStrongLiveSignal)` which caused all
    // streamers to appear offline whenever YouTube stopped redirecting /@user/live
    // to /watch?v=ID for server-side requests (no redirect → no videoId → isLive=false).
    let isLive = hasStrongLiveSignal;
    let apiConfirmedViewers = null;

    if (videoId && !isScheduled && !hasStrongLiveSignal && YOUTUBE_API_KEY) {
      const reason = hasWeakLiveSignal
        ? 'weak HTML signals only — could be a replay/VOD'
        : 'no HTML live signal';
      console.log(`YouTube @${username}: ${reason} — verifying via API (1 unit)`);
      try {
        const verifyUrl = `${YOUTUBE_API_BASE}/videos?part=liveStreamingDetails,snippet&id=${videoId}&key=${YOUTUBE_API_KEY}`;
        const verifyRes  = await fetch(verifyUrl);
        const verifyData = await verifyRes.json();
        youtubeQuotaUsed++;
        youtubeMonthlyQuotaUsed++;
        youtubeApiCallCount++;
        persistYoutubeQuotaState();

        const item = verifyData.items?.[0];
        const lsd  = item?.liveStreamingDetails;
        // actualEndTime absent + actualStartTime present = currently live
        if (lsd?.actualStartTime && !lsd?.actualEndTime) {
          isLive = true;
          // Only use concurrentViewers from this call if it's a real number > 0.
          // When it's absent/null, leave apiConfirmedViewers as null so the dedicated
          // fetchYouTubeViewerCount call below still runs. Setting it to 0 here would
          // cause `apiConfirmedViewers === null` to be false and skip that call entirely.
          apiConfirmedViewers = (lsd.concurrentViewers && parseInt(lsd.concurrentViewers, 10) > 0)
            ? parseInt(lsd.concurrentViewers, 10)
            : null;
          console.log(`YouTube @${username}: API confirmed LIVE (viewers=${apiConfirmedViewers ?? 'pending'})`);
        } else {
          console.log(`YouTube @${username}: API confirmed OFFLINE`);
        }
      } catch (verifyErr) {
        console.warn(`YouTube @${username}: API verify failed — ${verifyErr.message}`);
      }
    }

    if (isLive && hasLiveSignal) {
      const signal =
        (html.includes('"isLive":true') || html.includes('"isLive": true'))             ? 'isLive'            :
        (html.includes('"isLiveNow":true') || html.includes('"isLiveNow": true'))        ? 'isLiveNow'         :
        (html.includes('"style":"LIVE"') || html.includes('"style": "LIVE"'))            ? 'style:LIVE'        :
        html.includes('"BADGE_STYLE_TYPE_LIVE_NOW"')                                     ? 'BADGE_LIVE_NOW'    :
        (html.includes('{"text":"LIVE"}') || html.includes('"text":"LIVE"'))             ? 'text:LIVE'         :
        html.includes('"hlsManifestUrl"')                                                ? 'hlsManifestUrl'    :
        html.includes('"liveStreamabilityRenderer"')                                     ? 'liveStreamability' :
        (html.includes('"allowLiveDvr":true') || html.includes('"allowLiveDvr": true')) ? 'allowLiveDvr'      :
        html.includes('"liveChatRenderer"')                                              ? 'liveChatRenderer'  : 'unknown';
      console.log(`YouTube @${username}: HTML live signal = "${signal}"`);
    }

    // ── 6. Display name — HTML parse, then cached DB value ───────────────────
    let displayName = cached?.display_name || null;
    const dnMatch = html.match(/"channelMetadataRenderer"\s*:\s*\{"title"\s*:\s*"([^"]+)"/);
    if (dnMatch) displayName = dnMatch[1];
    if (!displayName) {
      const m2 = html.match(/"c4TabbedHeaderRenderer"\s*:\s*\{[^}]{0,300}"title"\s*:\s*"([^"]+)"/);
      if (m2) displayName = m2[1];
    }

    // ── 7. Profile photo — refresh every 6 h via YouTube Data API ───────────
    //
    //  ROOT CAUSE OF WRONG PHOTO BUG:
    //  When a channel is LIVE, YouTube replaces og:image in the HTML with the
    //  live-stream video thumbnail (i.ytimg.com/vi/<videoId>/maxresdefault.jpg).
    //  That is NOT the channel avatar.  The Data API channels?part=snippet
    //  endpoint always returns snippet.thumbnails which is the real channel
    //  avatar (yt3.googleusercontent.com / yt3.ggpht.com), regardless of
    //  whether the channel is live or offline.  The API is therefore the only
    //  reliable source and must be called FIRST, not as a fallback.
    //
    //  Strategy (in priority order):
    //    1. YouTube Data API  — primary, always correct, 1 quota unit
    //    2. ytInitialData avatar block — yt3.ggpht.com only (never i.ytimg.com)
    //    3. Cached DB value  — never blank out a previously known avatar
    //
    //  og:image is deliberately NOT used: it carries the video thumbnail when live.
    const lastPhotoRefresh  = youtubePhotoRefreshMap.get(username) || 0;
    const photoNeedsRefresh = (Date.now() - lastPhotoRefresh) >= YOUTUBE_PHOTO_REFRESH_MS;

    // Normalize YouTube avatar URLs: both yt3.ggpht.com and yt3.googleusercontent.com
    // serve the same CDN content — we always store/serve the googleusercontent form.
    // Anything else (i.ytimg.com = video thumbnails) is rejected and returns null.
    const normalizeAvatarUrl = url => {
      if (!url) return null;
      if (url.startsWith('https://yt3.googleusercontent.com/')) return url;
      if (url.startsWith('https://yt3.ggpht.com/'))
        return url.replace('https://yt3.ggpht.com/', 'https://yt3.googleusercontent.com/');
      return null; // i.ytimg.com or anything else — reject
    };

    // Validate/normalize the cached photo before reusing it.
    // A stale i.ytimg.com URL must be discarded rather than served for 6 more hours.
    const cachedPhoto = normalizeAvatarUrl(cached?.photo);
    if (cached?.photo && !cachedPhoto) {
      console.warn(`YouTube @${username}: discarding cached non-avatar photo: ${cached.photo}`);
    }

    let photo = (photoNeedsRefresh ? null : cachedPhoto) || null;

    if (photoNeedsRefresh && YOUTUBE_API_KEY) {
      // ── 1. YouTube Data API (primary) — channels?part=snippet&forHandle ──
      //       Always returns the real channel avatar. Cost: 1 quota unit.
      console.log(`YouTube @${username}: refreshing profile photo via API (6 h interval, ${isLive ? 'ONLINE' : 'OFFLINE'})`);
      const { displayName: apiDN, photo: apiPhoto } = await fetchYouTubeChannelMeta(username);
      if (apiDN)    displayName = displayName || apiDN;
      if (apiPhoto) {
        photo = apiPhoto;
        console.log(`YouTube @${username}: profile photo set from API → ${photo}`);
      } else {
        console.warn(`YouTube @${username}: API returned no photo — trying HTML fallback`);
      }
    } else if (!photoNeedsRefresh && !displayName && YOUTUBE_API_KEY) {
      // displayName still missing but no photo refresh needed — cheap API call
      const { displayName: apiDN } = await fetchYouTubeChannelMeta(username);
      if (apiDN) displayName = apiDN;
    }

    if (!photo) {
      // ── 2. HTML fallback: ytInitialData avatar / channelAvatarUrl ──────────
      //       Accept ONLY yt3.googleusercontent.com URLs.
      //       i.ytimg.com is YouTube's VIDEO thumbnail CDN — explicitly rejected.
      //       yt3.ggpht.com is an older alias and also excluded.
      // Re-use the normalizeAvatarUrl defined above — accepts yt3.ggpht.com
      // and converts it to yt3.googleusercontent.com; rejects everything else.
      const isChannelAvatar = url => !!normalizeAvatarUrl(url);

      // Match avatar blocks — yt3.googleusercontent.com only
      const avatarBlock = html.match(
        /(?:"avatar"|"channelAvatarUrl")\s*:\s*\{"thumbnails"\s*:\s*\[\{"url"\s*:\s*"(https:\/\/yt3\.googleusercontent\.com\/[^"]+)"/
      );
      if (avatarBlock) {
        const candidate = normalizeAvatarUrl(avatarBlock[1].replace(/=s\d+.*$/, ''));
        if (candidate) {
          photo = candidate;
          console.log(`YouTube @${username}: profile photo from ytInitialData avatar block (HTML fallback)`);
        }
      }

      if (!photo) {
        // Broader scan — yt3.googleusercontent.com only, never i.ytimg.com or yt3.ggpht.com
        const anyThumb = html.match(/"url"\s*:\s*"(https:\/\/yt3\.googleusercontent\.com\/[^"]+)"/);
        if (anyThumb) {
          const candidate = normalizeAvatarUrl(anyThumb[1].replace(/=s\d+.*$/, ''));
          if (candidate) {
            photo = candidate;
            console.log(`YouTube @${username}: profile photo from yt3.googleusercontent.com scan (HTML fallback)`);
          }
        }
      }
    }

    // ── 3. Last resort: keep the previously cached avatar so we never go blank ─
    if (photoNeedsRefresh) {
      if (photo) {
        youtubePhotoRefreshMap.set(username, Date.now());
        console.log(`YouTube @${username}: profile photo refresh complete (6 h interval)`);
      } else if (cachedPhoto) {
        // cachedPhoto was already validated as yt3.googleusercontent.com above —
        // safe to fall back to without re-checking.
        photo = cachedPhoto;
        console.log(`YouTube @${username}: API + HTML both failed — retaining cached avatar`);
      } else {
        console.warn(`YouTube @${username}: no valid avatar found — photo will be blank`);
      }
    }
    // ── 8. Stream title (live only) ──────────────────────────────────────────
    let streamTitle = null;
    if (isLive) {
      const titleM = html.match(/"videoPrimaryInfoRenderer"[\s\S]{0,300}?"text"\s*:\s*"([^"]{3,200})"/);
      if (titleM) {
        streamTitle = titleM[1]
          .replace(/\u0026/g, '&')
          .replace(/\u003e/g, '>')
          .replace(/\u003c/g, '<')
          .replace(/\"/g, '"');
      }
      if (!streamTitle) {
        const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/);
        if (ogTitle) streamTitle = ogTitle[1];
      }
    }

    // ── 9. Viewer count — ALWAYS from API when live (1 quota unit per call).
    //    HTML viewer counts are unreliable / not exposed in server-side responses.
    //    apiConfirmedViewers is only set via the weak-signal verification path above;
    //    for strong-signal streams it starts null and gets filled by fetchYouTubeViewerCount.
    let viewersRaw = apiConfirmedViewers ?? 0;

    // When the channel is live but the videoId couldn't be extracted from HTML
    // (YouTube sometimes skips the /@user/live → /watch?v=ID redirect for
    // server-side requests), resolve the active videoId via the API so we can
    // still fetch a real viewer count instead of silently returning 0.
    if (isLive && !videoId && YOUTUBE_API_KEY && apiConfirmedViewers === null) {
      try {
        // Step A: resolve @handle → channelId (1 quota unit)
        const chRes  = await fetch(
          `${YOUTUBE_API_BASE}/channels?part=id&forHandle=${encodeURIComponent('@' + username)}&key=${YOUTUBE_API_KEY}`
        );
        const chData = await chRes.json();
        youtubeQuotaUsed++;
        youtubeMonthlyQuotaUsed++;
        youtubeApiCallCount++;
        persistYoutubeQuotaState();

        const channelId = chData.items?.[0]?.id;
        if (channelId) {
          // Step B: search for the active live video on this channel (100 quota units)
          const srRes  = await fetch(
            `${YOUTUBE_API_BASE}/search?part=id&channelId=${encodeURIComponent(channelId)}&type=video&eventType=live&maxResults=1&key=${YOUTUBE_API_KEY}`
          );
          const srData = await srRes.json();
          youtubeQuotaUsed += 100;
          youtubeMonthlyQuotaUsed += 100;
          youtubeApiCallCount++;
          persistYoutubeQuotaState();

          const resolvedId = srData.items?.[0]?.id?.videoId || null;
          if (resolvedId) {
            videoId = resolvedId;
            console.log(`YouTube @${username}: resolved live videoId via API = ${videoId}`);
          } else {
            console.warn(`YouTube @${username}: live but API search returned no videoId`);
          }
        }
      } catch (lookupErr) {
        console.warn(`YouTube @${username}: live videoId API lookup failed — ${lookupErr.message}`);
      }
    }

    if (isLive && videoId && YOUTUBE_API_KEY && apiConfirmedViewers === null) {
      // Fetch live viewer count from API (1 quota unit). Never use HTML-parsed
      // counts — they are absent from server-side responses.
      viewersRaw = await fetchYouTubeViewerCount(videoId);
    }

    const channelUrl = `https://www.youtube.com/@${username}`;
    const watchUrl   = videoId ? `https://www.youtube.com/watch?v=${videoId}` : channelUrl;

    console.log(`YouTube @${username}: ${isLive ? 'ONLINE' : 'OFFLINE'} viewers=${viewersRaw}${videoId ? ` id=${videoId}` : ''}`);

    return {
      id:                  makeId('youtube', username),
      platform:            'youtube',
      username,
      display_name:        displayName || null,
      status:              isLive ? 'online' : 'offline',
      viewers_raw:         viewersRaw,
      viewers:             formatViewers(viewersRaw),
      title:               streamTitle,
      photo,
      url:                 isLive ? watchUrl : channelUrl,
      m3u8:                null,
      vod_id:              videoId,
      last_broadcast_time: null,
    };

  } catch (err) {
    console.error(`YouTube fetchYouTubeLive error for @${username}:`, err.message);
    if (YOUTUBE_API_KEY) {
      console.log(`YouTube @${username}: exception — falling back to full API`);
      return await fetchYouTubeAPI(username);
    }
    return null;
  }
}

/* ==========================================================================
   YOUTUBE API - VIEWER COUNT ONLY (1 quota unit per call)
   ========================================================================== */
async function fetchYouTubeViewerCount(videoId) {
  if (!YOUTUBE_API_KEY) {
    console.log('YouTube API key not configured - skipping viewer count');
    return 0;
  }

  try {
    // Reset daily quota counter at midnight UTC
    const now = new Date();
    const todayUTC = now.toISOString().split('T')[0];
    const currentMonth = now.toISOString().substring(0, 7); // YYYY-MM
    
    // Daily reset
    if (!youtubeQuotaResetTime || youtubeQuotaResetTime !== todayUTC) {
      // Archive previous day's usage before reset
      if (youtubeQuotaResetTime && youtubeQuotaUsed > 0) {
        // Persist to SQLite + JSON backup (THE FIX: was only pushing to in-memory array)
        archiveDailyHistory(youtubeQuotaResetTime, youtubeQuotaUsed, youtubeApiCallCount, youtubeApiFallbackUsed);

        // Also keep in-memory array up to date for the current session
        youtubeQuotaHistory.push({
          date: youtubeQuotaResetTime,
          quota_used: youtubeQuotaUsed,
          api_calls: youtubeApiCallCount,
          fallback_used: youtubeApiFallbackUsed
        });
        // Keep only last 90 days in memory
        if (youtubeQuotaHistory.length > 90) {
          youtubeQuotaHistory = youtubeQuotaHistory.slice(-90);
        }
      }
      
      youtubeQuotaUsed = 0;
      youtubeQuotaResetTime = todayUTC;
      youtubeApiFallbackUsed = false;
      console.log('YouTube daily quota reset:', todayUTC);
    }
    
    // Monthly reset
    if (!youtubeQuotaStartOfMonth || youtubeQuotaStartOfMonth !== currentMonth) {
      youtubeMonthlyQuotaUsed = 0;
      youtubeQuotaStartOfMonth = currentMonth;
      console.log('YouTube monthly quota tracking reset:', currentMonth);
    }
    persistYoutubeQuotaState();
    
    // Check if we've exceeded our daily budget
    if (youtubeQuotaUsed >= youtubeDailyBudget) {
      console.warn(`YouTube API daily budget reached: ${youtubeQuotaUsed}/${youtubeDailyBudget} units - skipping viewer count`);
      return 0;
    }
    
    // Check monthly budget
    if (youtubeMonthlyQuotaUsed >= youtubeMonthlyBudget) {
      console.warn(`YouTube API monthly budget reached: ${youtubeMonthlyQuotaUsed}/${youtubeMonthlyBudget} units - skipping viewer count`);
      return 0;
    }

    // Fetch ONLY viewer count - Cost: 1 unit
    const videoUrl = `${YOUTUBE_API_BASE}/videos?part=liveStreamingDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`;
    const videoRes = await fetch(videoUrl);

    if (!videoRes.ok) {
      console.warn(`YouTube viewer count HTTP ${videoRes.status} for ${videoId} — skipping`);
      return 0;
    }

    const videoData = await videoRes.json();

    // Guard against API-level errors (quota exceeded, invalid key, etc.)
    if (videoData.error) {
      console.warn(`YouTube viewer count API error for ${videoId}: ${videoData.error.code} ${videoData.error.message}`);
      return 0;
    }

    youtubeQuotaUsed += 1;
    youtubeMonthlyQuotaUsed += 1;
    youtubeApiCallCount++;
    persistYoutubeQuotaState();

    if (!videoData.items?.length) {
      console.warn(`YouTube viewer count: no items returned for videoId=${videoId} (may be ended or private)`);
      return 0;
    }

    const viewersRaw = videoData.items[0]?.liveStreamingDetails?.concurrentViewers
      ? parseInt(videoData.items[0].liveStreamingDetails.concurrentViewers, 10)
      : 0;

    console.log(`YouTube API viewer count for ${videoId}: ${viewersRaw} (Quota: Daily ${youtubeQuotaUsed}/${youtubeDailyBudget}, Monthly ${youtubeMonthlyQuotaUsed}/${youtubeMonthlyBudget})`);

    return viewersRaw;
  } catch (err) {
    console.error(`YouTube API viewer count error for ${videoId}:`, err.message);
    return 0;
  }
}

/* ==========================================================================
   YOUTUBE API - CHANNEL PHOTO (100 quota units per call)
   Used as fallback when Puppeteer fails to get profile photo for offline channels
   ========================================================================== */
/**
 * Fetch channel display name + photo via the channels endpoint.
 * Uses forHandle=@username — costs only 1 quota unit (vs 100 for search).
 * Called on every scrape so display_name stays authoritative from the API.
 * @returns {{ displayName: string|null, photo: string|null }}
 */
async function fetchYouTubeChannelMeta(username) {
  if (!YOUTUBE_API_KEY) return { displayName: null, photo: null };

  if (youtubeQuotaUsed >= youtubeDailyBudget) {
    console.warn(`YouTube daily budget reached — skipping channel meta for ${username}`);
    return { displayName: null, photo: null };
  }
  if (youtubeMonthlyQuotaUsed >= youtubeMonthlyBudget) {
    console.warn(`YouTube monthly budget reached — skipping channel meta for ${username}`);
    return { displayName: null, photo: null };
  }

  try {
    // forHandle resolves @handle to channel in one call at 1 quota unit
    const url = `${YOUTUBE_API_BASE}/channels?part=snippet&forHandle=${encodeURIComponent('@' + username)}&key=${YOUTUBE_API_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();

    youtubeQuotaUsed++;
    youtubeMonthlyQuotaUsed++;
    youtubeApiCallCount++;
    persistYoutubeQuotaState();

    const snippet = data.items?.[0]?.snippet;
    if (!snippet) {
      console.log(`YouTube API: no channel found for @${username}`);
      return { displayName: null, photo: null };
    }

    const displayName = snippet.title || null;

    // Normalise yt3.ggpht.com (legacy alias) to yt3.googleusercontent.com.
    // The API returns either domain for the channel avatar; we always store
    // the googleusercontent form.  i.ytimg.com (video thumbnails) is rejected.
    const normPhoto = url => {
      if (!url) return null;
      if (url.startsWith('https://yt3.ggpht.com/'))
        return url.replace('https://yt3.ggpht.com/', 'https://yt3.googleusercontent.com/');
      if (url.startsWith('https://yt3.googleusercontent.com/')) return url;
      return null;
    };

    const rawPhoto =
      snippet.thumbnails?.high?.url   ||
      snippet.thumbnails?.medium?.url ||
      snippet.thumbnails?.default?.url || null;

    const photo = normPhoto(rawPhoto);
    if (rawPhoto && !photo) {
      console.warn(`YouTube API meta @${username}: rejected non-avatar photo URL: ${rawPhoto}`);
    }

    console.log(`YouTube API meta @${username}: displayName="${displayName}" photo=${photo ? 'yes' : 'no'} (Daily ${youtubeQuotaUsed}/${youtubeDailyBudget}, Monthly ${youtubeMonthlyQuotaUsed}/${youtubeMonthlyBudget})`);
    return { displayName, photo };
  } catch (err) {
    console.error(`YouTube fetchYouTubeChannelMeta error for ${username}:`, err.message);
    return { displayName: null, photo: null };
  }
}

/** @deprecated Use fetchYouTubeChannelMeta instead */
async function fetchYouTubeChannelPhoto(username) {
  const { photo } = await fetchYouTubeChannelMeta(username);
  return photo;
}

/* ==========================================================================
   YOUTUBE API FALLBACK (FULL) - Used only when Puppeteer completely fails
   ========================================================================== */
async function fetchYouTubeAPI(username) {
  if (!YOUTUBE_API_KEY) {
    console.error('YouTube API key not configured');
    return null;
  }

  try {
    youtubeApiCallCount++;
    
    // Reset daily quota counter at midnight UTC
    const now = new Date();
    const todayUTC = now.toISOString().split('T')[0];
    const currentMonth = now.toISOString().substring(0, 7); // YYYY-MM
    
    // Daily reset
    if (!youtubeQuotaResetTime || youtubeQuotaResetTime !== todayUTC) {
      // Archive previous day's usage before reset
      if (youtubeQuotaResetTime && youtubeQuotaUsed > 0) {
        // Persist to SQLite + JSON backup (THE FIX: was only pushing to in-memory array)
        archiveDailyHistory(youtubeQuotaResetTime, youtubeQuotaUsed, youtubeApiCallCount, youtubeApiFallbackUsed);

        // Also keep in-memory array up to date for the current session
        youtubeQuotaHistory.push({
          date: youtubeQuotaResetTime,
          quota_used: youtubeQuotaUsed,
          api_calls: youtubeApiCallCount,
          fallback_used: youtubeApiFallbackUsed
        });
        // Keep only last 90 days in memory
        if (youtubeQuotaHistory.length > 90) {
          youtubeQuotaHistory = youtubeQuotaHistory.slice(-90);
        }
      }
      
      youtubeQuotaUsed = 0;
      youtubeQuotaResetTime = todayUTC;
      youtubeApiFallbackUsed = false;
      console.log('YouTube daily quota reset:', todayUTC);
    }
    
    // Monthly reset
    if (!youtubeQuotaStartOfMonth || youtubeQuotaStartOfMonth !== currentMonth) {
      youtubeMonthlyQuotaUsed = 0;
      youtubeQuotaStartOfMonth = currentMonth;
      console.log('YouTube monthly quota tracking reset:', currentMonth);
    }
    persistYoutubeQuotaState();
    
    // Check if we've exceeded our daily budget (to stay within 50-60% monthly usage)
    if (youtubeQuotaUsed >= youtubeDailyBudget) {
      console.warn(`YouTube API daily budget reached: ${youtubeQuotaUsed}/${youtubeDailyBudget} units (Monthly: ${youtubeMonthlyQuotaUsed}/${youtubeMonthlyBudget})`);
      youtubeApiFallbackUsed = true;
      return null; // Fall back to web scraping
    }
    
    // Check monthly budget
    if (youtubeMonthlyQuotaUsed >= youtubeMonthlyBudget) {
      console.warn(`YouTube API monthly budget reached: ${youtubeMonthlyQuotaUsed}/${youtubeMonthlyBudget} units (${((youtubeMonthlyQuotaUsed/youtubeQuotaMonthlyLimit)*100).toFixed(1)}% of monthly quota)`);
      youtubeApiFallbackUsed = true;
      return null;
    }
    
    // Warn when approaching daily budget limit (90%)
    if (youtubeQuotaUsed >= youtubeDailyBudget * 0.9 && !youtubeApiFallbackUsed) {
      console.warn(`YouTube API daily budget warning: ${youtubeQuotaUsed}/${youtubeDailyBudget} (${((youtubeQuotaUsed/youtubeDailyBudget)*100).toFixed(1)}%)`);
    }

    // Step 1: Search for channel by username
    // Cost: 100 units
    const searchUrl = `${YOUTUBE_API_BASE}/search?part=snippet&type=channel&q=${encodeURIComponent(username)}&key=${YOUTUBE_API_KEY}`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();
    
    youtubeQuotaUsed += 100;
    youtubeMonthlyQuotaUsed += 100;

    if (!searchData.items || searchData.items.length === 0) {
      console.log(`YouTube API: No channel found for ${username}`);
      return null;
    }

    const channelId = searchData.items[0].id.channelId;
    const channelTitle = searchData.items[0].snippet.title;

    // Normalise yt3.ggpht.com -> yt3.googleusercontent.com; reject i.ytimg.com.
    const _rawThumb = searchData.items[0].snippet.thumbnails?.high?.url ||
                      searchData.items[0].snippet.thumbnails?.default?.url || null;
    const _normThumb = url => {
      if (!url) return null;
      if (url.startsWith('https://yt3.ggpht.com/'))
        return url.replace('https://yt3.ggpht.com/', 'https://yt3.googleusercontent.com/');
      if (url.startsWith('https://yt3.googleusercontent.com/')) return url;
      return null;
    };
    const channelThumbnail = _normThumb(_rawThumb);
    if (_rawThumb && !channelThumbnail) {
      console.warn(`YouTube API (full) @${username}: rejected non-avatar photo URL: ${_rawThumb}`);
    }

    // Step 2: Get channel details to check for live stream
    // Cost: 1 unit
    const channelUrl = `${YOUTUBE_API_BASE}/channels?part=snippet,contentDetails&id=${channelId}&key=${YOUTUBE_API_KEY}`;
    const channelRes = await fetch(channelUrl);
    const channelData = await channelRes.json();
    
    youtubeQuotaUsed += 1;
    youtubeMonthlyQuotaUsed += 1;

    // Step 3: Search for live broadcasts
    // Cost: 100 units
    const liveSearchUrl = `${YOUTUBE_API_BASE}/search?part=snippet&channelId=${channelId}&type=video&eventType=live&key=${YOUTUBE_API_KEY}`;
    const liveSearchRes = await fetch(liveSearchUrl);
    const liveSearchData = await liveSearchRes.json();
    
    youtubeQuotaUsed += 100;
    youtubeMonthlyQuotaUsed += 100;

    console.log(`YouTube API quota used: Daily ${youtubeQuotaUsed}/${youtubeDailyBudget}, Monthly ${youtubeMonthlyQuotaUsed}/${youtubeMonthlyBudget} (${youtubeApiCallCount} API calls)`);
    persistYoutubeQuotaState();

    if (liveSearchData.items && liveSearchData.items.length > 0) {
      // Channel is live
      const liveVideo = liveSearchData.items[0];
      const videoId = liveVideo.id.videoId;
      const videoTitle = liveVideo.snippet.title;

      // Step 4: Get live stream details including viewer count
      // Cost: 1 unit
      const videoUrl = `${YOUTUBE_API_BASE}/videos?part=liveStreamingDetails,snippet&id=${videoId}&key=${YOUTUBE_API_KEY}`;
      const videoRes = await fetch(videoUrl);
      const videoData = await videoRes.json();
      
      youtubeQuotaUsed += 1;
      youtubeMonthlyQuotaUsed += 1;
      persistYoutubeQuotaState();

      const viewersRaw = videoData.items?.[0]?.liveStreamingDetails?.concurrentViewers 
        ? parseInt(videoData.items[0].liveStreamingDetails.concurrentViewers, 10) 
        : 0;

      youtubeApiFallbackUsed = true;

      return {
        id: makeId('youtube', username),
        platform: 'youtube',
        username: username,
        display_name: channelTitle,
        status: 'online',
        viewers_raw: viewersRaw,
        viewers: formatViewers(viewersRaw),
        title: videoTitle,
        photo: channelThumbnail,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        m3u8: null,
        vod_id: videoId,
        last_broadcast_time: null
      };
    } else {
      // Channel is offline - get latest video
      const uploadsPlaylistId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      
      let latestVideoUrl = `https://www.youtube.com/@${username}`;
      
      if (uploadsPlaylistId) {
        // Cost: 1 unit
        const playlistUrl = `${YOUTUBE_API_BASE}/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=1&key=${YOUTUBE_API_KEY}`;
        const playlistRes = await fetch(playlistUrl);
        const playlistData = await playlistRes.json();
        
        youtubeQuotaUsed += 1;
        youtubeMonthlyQuotaUsed += 1;
        persistYoutubeQuotaState();
        
        if (playlistData.items && playlistData.items.length > 0) {
          const latestVideoId = playlistData.items[0].snippet.resourceId.videoId;
          latestVideoUrl = `https://www.youtube.com/watch?v=${latestVideoId}`;
        }
      }

      youtubeApiFallbackUsed = true;

      return {
        id: makeId('youtube', username),
        platform: 'youtube',
        username: username,
        display_name: channelTitle,
        status: 'offline',
        viewers_raw: 0,
        viewers: '0',
        title: null,
        photo: channelThumbnail,
        url: latestVideoUrl,
        m3u8: null,
        vod_id: null,
        last_broadcast_time: null
      };
    }
  } catch (err) {
    console.error(`YouTube API error for ${username}:`, err.message);
    return null;
  }
}



const partiHeaders = () => ({
  'Accept':             'application/json',
  'Authorization':      `Bearer ${process.env.PARTI_AUTH_TOKEN || ''}`,
  'Origin':             'https://parti.com',
  'Referer':            'https://parti.com/',
  'User-Agent':         process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'sec-ch-ua':          '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
  'sec-ch-ua-mobile':   '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest':     'empty',
  'sec-fetch-mode':     'cors',
  'sec-fetch-site':     'same-site',
  'dnt':                '1',
});

// One bulk call returns every currently-live Parti channel (up to PARTI_LIVE_LIMIT).
// We match against PARTI_USER_IDS — present in map = online, absent = offline.
// Per-user profile calls (username + avatar) are made in parallel afterwards so
// that offline users still get fresh display names without per-user live checks.
async function fetchPartiAll() {
  const partiUserIds = parseList(process.env.PARTI_USER_IDS);
  if (!partiUserIds.length) return [];

  const headers = partiHeaders();

  // ── Step 1: single bulk live endpoint call ─────────────────────────────────
  let liveItems = [];
  try {
    const liveRes = await fetch(
      `${PARTI_API_BASE}${PARTI_LIVE_PATH}?limit=${PARTI_LIVE_LIMIT}&offset=0`,
      { headers }
    );
    if (liveRes.ok) {
      const body = await liveRes.json();
      // Handle bare array OR wrapped shapes: { data:[…] } / { items:[…] }
      liveItems = Array.isArray(body)        ? body
                : Array.isArray(body?.data)  ? body.data
                : Array.isArray(body?.items) ? body.items
                : [];
      console.log(`Parti bulk live: ${liveItems.length} live streams returned`);
    } else {
      console.error(`Parti bulk live HTTP ${liveRes.status}`);
    }
  } catch (err) {
    console.error('Parti bulk live fetch error:', err.message);
  }

  // Build lookup: user_id (string) → live item with all stream fields
  const liveMap = new Map(
    liveItems
      .filter(item => item?.user_id != null)
      .map(item => [String(item.user_id), item])
  );

  // ── Step 2: resolve each tracked user in parallel ─────────────────────────
  const results = await Promise.all(partiUserIds.map(async (userId) => {
    try {
      const uid      = String(userId);
      const liveItem = liveMap.get(uid);
      const isLive   = !!liveItem;

      // Prefer profile fields carried in the live payload; fall back to profile API
      let userName = liveItem?.user_name || liveItem?.username || null;
      let photo    = liveItem?.avatar_link || liveItem?.avatar || null;

      if (!userName) {
        // Offline users (or live items missing profile fields) need a profile call
        try {
          const profileRes = await fetch(
            `${PARTI_API_BASE}/parti_v2/profile/user_profile/${uid}`,
            { headers }
          );
          if (profileRes.ok) {
            const profile = await profileRes.json();
            userName = profile.user_name  || uid;
            photo    = profile.avatar_link || photo;
          } else {
            console.warn(`Parti profile HTTP ${profileRes.status} for user ${uid}`);
            userName = uid;
          }
        } catch (profileErr) {
          console.warn(`Parti profile fetch error for ${uid}:`, profileErr.message);
          userName = uid;
        }
      }

      // Extract the four live-stream fields from the bulk response
      const viewersRaw  = isLive ? (Number(liveItem?.viewers_count)                                     || 0)    : 0;
      const eventTitle  = isLive ? (liveItem?.event_title                                                || null) : null;
      const playbackUrl = isLive ? (liveItem?.playback_url || liveItem?.original_playback_url            || null) : null;
      const dvrUrl      = !isLive ? (liveItem?.dvr_url                                                   || null) : null;

      console.log(`Parti ${userName} (id=${uid}): ${isLive ? 'ONLINE' : 'OFFLINE'} viewers=${viewersRaw}`);

      return {
        id:                  makeId('parti', uid),
        platform:            'parti',
        username:            userName,
        display_name:        userName,
        status:              isLive ? 'online' : 'offline',
        viewers_raw:         viewersRaw,
        viewers:             formatViewers(viewersRaw),
        title:               eventTitle,
        photo,
        url:                 `${PARTI_WEB_BASE}/${userName}`,
        m3u8:                playbackUrl,
        vod_id:              dvrUrl,
        last_broadcast_time: null
      };
    } catch (err) {
      console.error(`Parti error for user ${userId}:`, err.message);
      return null;
    }
  }));

  return results.filter(Boolean);
}

/* ==========================================================================
   SCRAPER LOOP WITH KICK SUPPORT
   ========================================================================== */
let RUNNING = false;
let browserInstance = null;
let scrapeCount = 0;
// 3-core VPS: Chrome renderer processes accumulate memory faster under CPU pressure.
// Restart every 20 scrapes (~100 min at 5-min intervals) to stay lean.
const MAX_SCRAPES_BEFORE_RESTART = Number(process.env.MAX_SCRAPES_BEFORE_RESTART || 20);

async function closeBrowserSafely() {
  if (browserInstance) {
    try {
      const pages = await browserInstance.pages();
      await Promise.all(pages.map(page => 
        page.close().catch(e => console.log('Page close error:', e.message))
      ));
      await browserInstance.close();
    } catch (e) {
      console.log('Browser close error:', e.message);
      try {
        if (browserInstance.process()) {
          browserInstance.process().kill('SIGKILL');
        }
      } catch (killErr) {
        console.log('Force kill error:', killErr.message);
      }
    } finally {
      browserInstance = null;
    }
  }
}

async function runScraper() {
  if (RUNNING) {
    console.log('Scraper already running, skipping...');
    return;
  }
  RUNNING = true;

  let browser;
  try {
    // Force browser restart every N scrapes to prevent memory leaks
    if (scrapeCount >= MAX_SCRAPES_BEFORE_RESTART) {
      console.log(`Forcing browser restart after ${scrapeCount} scrapes to prevent memory leaks`);
      await closeBrowserSafely();
      scrapeCount = 0;
    }
    
    await closeBrowserSafely();

    console.log('Launching browser...');

    // ── Browser launch args tuned for 3-core / 12 GB VPS ────────────────────
    // Key constraint: 3 cores shared between Node.js + Chrome browser process
    // + 2 renderer processes (one per concurrent Puppeteer page).
    // Over-allocating threads or concurrency causes "Network.enable timed out".
    const CHROME_ARGS = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // Use /tmp instead of /dev/shm — VPS /dev/shm is usually only 64 MB.
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad',
      '--disable-component-extensions-with-background-pages',
      '--disable-features=TranslateUI,BlinkGenPropertyTrees',
      '--disable-ipc-flooding-protection',
      '--disable-renderer-backgrounding',
      '--enable-features=NetworkService,NetworkServiceInProcess',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--disable-blink-features=AutomationControlled',
      // Smaller viewport = less paint work per page
      '--window-size=1280,720',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials',
      // Limit renderer threads to 1 per process — avoids scheduler thrash
      // across 2 concurrent renderers on only 3 cores
      '--num-raster-threads=1',
      // Renderer process cap matches our PUPPETEER_CONCURRENT_LIMIT
      '--renderer-process-limit=2',
      // JS heap: 1 GB per renderer is plenty; 2 renderers = 2 GB max Chrome heap
      '--js-flags=--max-old-space-size=1024',
      '--disable-webgl',
      '--disable-canvas-aa',
      '--disable-2d-canvas-clip-aa',
      '--disable-gl-drawing-for-tests',
      // Prevent zygote process — reduces process count on low-core VPS
      '--no-zygote'
    ];

    browser = await puppeteer.launch({
      headless: 'new',
      args: CHROME_ARGS,
      // 3 cores = CDP messages can queue longer before being serviced.
      // 120 s gives comfortable headroom for slow-responding pages.
      protocolTimeout: 120000,
      dumpio: false,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      ignoreHTTPSErrors: true
    });
    
    browserInstance = browser;

    browser.on('disconnected', () => {
      console.log('⚠️ Browser disconnected unexpectedly');
      browserInstance = null;
      scrapeCount = 0; // Reset counter when browser disconnects
    });

    browser.on('targetcreated', () => {
      // Monitor target creation
    });

    browser.on('targetdestroyed', () => {
      // Monitor target destruction
    });

    // Mutex: only one concurrent browser restart at a time.
    // Without this, two tasks can both see !browser.isConnected() and both try
    // to spawn Chrome simultaneously → "Failed to open a new tab" cascade.
    let browserRestartPromise = null;

    async function ensureBrowser() {
      if (browser && browser.isConnected()) return;
      // If a restart is already in flight, wait for it instead of spawning another
      if (browserRestartPromise) {
        await browserRestartPromise;
        return;
      }
      browserRestartPromise = (async () => {
        console.log('Browser not connected — restarting...');
        await closeBrowserSafely();
        browser = await puppeteer.launch({
          headless: 'new',
          args: CHROME_ARGS,
          protocolTimeout: 120000,
          dumpio: false,
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
          ignoreHTTPSErrors: true
        });
        browserInstance = browser;
        console.log('Browser restarted successfully');
      })();
      try {
        await browserRestartPromise;
      } finally {
        browserRestartPromise = null;
      }
    }

    const makePageTask = fn =>
      puppeteerLimit(async () => {
        let page;
        let retryCount = 0;
        const maxRetries = 2;
        
        while (retryCount <= maxRetries) {
          try {
            await ensureBrowser();

            page = await browser.newPage();
            
            // Suppress page-level errors (stealth plugin noise, ad-blocker races, etc.)
            page.on('error', err => {
              if (!err.message.includes('Requesting main frame') &&
                  !err.message.includes('detached Frame')) {
                console.log('Page error:', err.message);
              }
            });
            page.on('pageerror', () => {}); // Suppress in-page JS errors

            // Stagger to let the stealth plugin fully initialise the new page before
            // any CDP calls (setUserAgent, goto, etc.) — prevents "Requesting main
            // frame too early" and "Session closed" from the stealth evasions racing
            // against the page lifecycle on a low-core VPS.
            await new Promise(resolve => setTimeout(resolve, 800));

            // Bail out if the page already closed during the stagger (stealth crash)
            if (page.isClosed()) throw new Error('Page closed during init stagger');

            page.setDefaultTimeout(30000);
            page.setDefaultNavigationTimeout(45000);
            
            if (process.env.USER_AGENT && !page.isClosed()) {
              await page.setUserAgent(process.env.USER_AGENT).catch(() => {});
            }
            
            const result = await fn(page);
            
            // Successfully completed
            if (page && !page.isClosed()) {
              await page.close().catch(e => console.log('Page close error:', e.message));
            }
            
            return result;
            
          } catch (err) {
            // "Requesting main frame too early" is pure stealth plugin startup noise —
            // it means the page initialised but the stealth evasion ran a hair too late.
            // Safe to retry without treating as a browser crash.
            const isStealthNoise = err.message.includes('Requesting main frame too early') ||
                                   err.message.includes('detached Frame');

            if (!isStealthNoise) {
              console.error(`Page task error (attempt ${retryCount + 1}/${maxRetries + 1}):`, err.message);
            }
            
            // Clean up page if it exists
            if (page && !page.isClosed()) {
              await page.close().catch(() => {});
            }
            
            // Browser crash — kill and let ensureBrowser() respawn on next attempt
            const isBrowserCrash = !isStealthNoise && (
              err.message.includes('Protocol error') || 
              err.message.includes('Target closed') ||
              err.message.includes('Session closed') ||
              err.message.includes('WebSocket') ||
              err.message.includes('Failed to open a new tab')
            );
            
            if (isBrowserCrash) {
              console.log('Browser crash detected, marking for restart...');
              await closeBrowserSafely();
              browser = null;
              browserInstance = null;
            }
            
            // Retry if we have attempts left
            if (retryCount < maxRetries) {
              retryCount++;
              const delay = Math.pow(2, retryCount) * 1000; // 2s, 4s exponential backoff
              if (!isStealthNoise) console.log(`Retrying in ${delay}ms...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
            
            // Max retries exceeded
            return null;
          }
        }
        
        return null;
      });

    // Build the set of all configured IDs from .env BEFORE running tasks.
    // deleteRemovedStreamers must use this list — NOT results — so that a
    // transient API failure (fetchKick returning null) never deletes the DB
    // row and wipes last_broadcast_time.
    const configuredIds = [
      ...parseList(process.env.KICK_USERNAMES).map(u => makeId('kick', u.toLowerCase())),
      ...parseList(process.env.TWITCH_USERNAMES).map(u => makeId('twitch', u.toLowerCase())),
      ...parseList(process.env.VAUGHN_USERNAMES).map(u => makeId('vaughn', u.toLowerCase())),
      ...parseList(process.env.YOUTUBE_USERNAMES).map(u => makeId('youtube', u.toLowerCase())),
      ...parseList(process.env.PARTI_USER_IDS).map(id => makeId('parti', String(id))),
      // Rumble rows are written by the external rumble_monitor.py process.
      // Include them here so deleteRemovedStreamers never wipes them.
      ...parseList(process.env.RUMBLE_CHANNELS).map(u => makeId('rumble', u.toLowerCase())),
      ...parseList(process.env.RUMBLE_USERS).map(u => makeId('rumble', u.toLowerCase())),
    ];

    const tasks = [
      ...parseList(process.env.KICK_USERNAMES).map(u =>
        kickLimit(() => fetchKick(u))
      ),
      ...parseList(process.env.TWITCH_USERNAMES).map(u =>
        limit(() => fetchTwitch(u))
      ),
      ...parseList(process.env.VAUGHN_USERNAMES).map(u =>
        limit(() => fetchVaughn(u))
      ),
      ...parseList(process.env.YOUTUBE_USERNAMES).map(u =>
        limit(() => fetchYouTubeLive(u))
      ),
      // Parti: one bulk call instead of N per-user calls
      limit(() => fetchPartiAll()),
    ];

    // Master scrape deadline — if any task hangs (e.g. real-browser CF solver),
    // the whole run times out and RUNNING resets so the next interval fires normally.
    // 4 minutes is generous: Kick+Twitch finish in ~30 s, Puppeteer tasks in ~2 min worst-case.
    const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 4 * 60 * 1000);
    const scrapeDeadline = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Scrape timeout after ${SCRAPE_TIMEOUT_MS / 1000}s`)), SCRAPE_TIMEOUT_MS)
    );

    const results = (await Promise.race([Promise.allSettled(tasks), scrapeDeadline]))
      .filter(r => r.status === 'fulfilled' && r.value)
      .flatMap(r => Array.isArray(r.value) ? r.value : [r.value]);

    // The upsertStreamer SQL uses CASE logic to safely merge every update:
    //   - photo/vod_id/last_broadcast_time only overwrite when the new value is non-null
    //   - title/url/m3u8 are preserved from the last online state
    //   - status + viewers are always refreshed
    // Running upsert unconditionally (no skip for offline→offline) ensures that
    // last_broadcast_time, vod_id, and photo are kept up-to-date every scrape cycle.
    db.transaction(() => {
      results.forEach(s => {
        upsertStreamer.run(
          s.id, s.platform, s.username, s.display_name || null, s.status,
          s.viewers, s.viewers_raw,
          s.title, s.photo, s.url,
          s.m3u8, s.vod_id,
          s.last_broadcast_time || null
        );
      });
      // Remove streamers that are no longer in the .env config.
      // Use configuredIds (derived from env vars) — NOT results — so that a
      // transient fetch failure (null return) never nukes a DB row.
      deleteRemovedStreamers.run(JSON.stringify(configuredIds));
    })();

    LAST_SCRAPE_AT = new Date().toISOString();
    LAST_SCRAPE_ERROR = null;
    scrapeCount++; // Increment scrape counter
    console.log(`Scrape completed: ${results.length} streamers updated (scrape #${scrapeCount})`);
  } catch (e) {
    LAST_SCRAPE_ERROR = e.message;
    console.error('Scraper error:', e);
    
    // Force browser restart on error
    if (browser) {
      console.log('Forcing browser close due to error...');
      await closeBrowserSafely();
      scrapeCount = 0; // Reset counter on error
    }
  } finally {
    RUNNING = false;
    if (browser) {
      await closeBrowserSafely();
    }
  }
}

/* ==========================================================================
   SERVER WITH KICK OAUTH
   ========================================================================== */
const app = express();

/* ==========================================================================
   SECURITY MIDDLEWARE
   ========================================================================== */

// Helmet: sets secure HTTP headers (X-Frame-Options, HSTS, CSP, etc.)
// ── Security headers ────────────────────────────────────────────────────────
// CSP: allow same-origin scripts/styles + the CDN hosts this app fetches from.
// Adjust 'script-src' / 'style-src' if you add more CDN dependencies.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'"],   // narrow further once inline scripts are moved to files
      styleSrc:       ["'self'", "'unsafe-inline'"],
      imgSrc:         ["'self'", "data:", "https:"],   // streamer avatars come from many CDNs
      connectSrc:     ["'self'"],
      fontSrc:        ["'self'", "https:", "data:"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],                      // clickjacking protection
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,   // keep off; streamer images are cross-origin
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy:            { policy: 'strict-origin-when-cross-origin' },
  hsts: {
    maxAge:            60 * 60 * 24 * 365, // 1 year
    includeSubDomains: true,
    preload:           true,
  },
}));

// General rate limiter — 200 requests per 5 minutes per IP
const generalLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use(generalLimiter);

// Strict limiter for auth/OAuth routes — 10 requests per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later.' },
});

// Dedicated limiter for admin/sensitive routes — 30 requests per 10 minutes per IP
const adminLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests, please try again later.' },
});

// Admin auth middleware — checks Authorization: Bearer <token> or ?token=<token>
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// Warn loudly at startup if the token is still the default placeholder
if (!ADMIN_TOKEN || ADMIN_TOKEN === 'CHANGE_ME_TO_A_STRONG_RANDOM_SECRET') {
  console.error(
    '\n⚠️  WARNING: ADMIN_TOKEN is not set or is still the default placeholder.\n' +
    '   All admin routes (/healthz, /youtube-dashboard, /api/youtube/*) will return 503.\n' +
    '   Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n'
  );
}

function requireAdminToken(req, res, next) {
  if (!ADMIN_TOKEN || ADMIN_TOKEN === 'CHANGE_ME_TO_A_STRONG_RANDOM_SECRET') {
    return res.status(503).json({ error: 'Admin access not configured.' });
  }
  const authHeader = req.headers['authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const queryToken = req.query.token;
  const provided = bearer || queryToken;

  // Use timing-safe comparison to prevent timing-based token enumeration attacks
  if (!provided) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  try {
    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(ADMIN_TOKEN);
    // timingSafeEqual requires same length buffers
    const match =
      providedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(providedBuf, expectedBuf);
    if (!match) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
  } catch {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  // Remove token from query so it doesn't leak into downstream logs
  delete req.query.token;
  next();
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// Never advertise the server stack
app.disable('x-powered-by');

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/Policy.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'Policy.html'));
});

app.get('/tos.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'tos.html'));
});

app.get('/donos.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'donos.html'));
});

app.get('/login/kick', authLimiter, (req, res) => {
  const authUrl = getKickAuthUrl();
  res.redirect(authUrl);
});

app.get('/auth/kick/callback', authLimiter, async (req, res) => {
  const { code, error, state } = req.query;
  
  if (error) {
    return res.status(400).send(`OAuth error: ${error}`);
  }
  
  if (!code || !state) {
    return res.status(400).send('No authorization code or state received');
  }
  
  try {
    await exchangeKickCode(code, state);
    res.send('Kick authorization successful! Tokens saved. You can close this window.');
  } catch (err) {
    console.error('Kick callback error:', err.message);
    res.status(500).send('Token exchange failed. Check server logs for details.');
  }
});

app.get('/auth/kick', (req, res) => {
  res.json({
    authorized: !!kickAccessToken,
    token_expiry: kickTokenExpiry ? new Date(kickTokenExpiry).toISOString() : null,
    auth_url: `/login/kick`   // client should redirect to this route, which generates a fresh PKCE pair
  });
});

app.get('/api/streamers', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM streamers
    ORDER BY status='online' DESC, viewers_raw DESC
  `).all();
  res.json({ streamers: rows });
});

app.get('/api/stats', (req, res) => {
  const s = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(status='online') AS online,
      SUM(viewers_raw) AS viewers
    FROM streamers
  `).get();

  res.json({
    ...s,
    viewers_formatted: formatViewers(s.viewers || 0),
    last_scrape_at: LAST_SCRAPE_AT
  });
});
setInterval(async () => {
    try {
        // Triggering the Python scraper every 70 seconds
        await fetch('http://localhost:5000/scrape-rumble');
        console.log(`[${new Date().toISOString()}] Rumble scrape triggered`);
    } catch (e) {
        console.error('Failed to trigger Rumble scrape. Is the Python app running on port 5000?', e.message);
    }
}, 70000); // 70 seconds
app.get('/youtube-dashboard', adminLimiter, requireAdminToken, (req, res) => {
     res.sendFile(path.join(__dirname, 'youtube-quota-dashboard.html'));
   });
app.get('/api/youtube/quota', adminLimiter, requireAdminToken, (req, res) => {
  const dailyQuotaRemaining = youtubeQuotaDailyLimit - youtubeQuotaUsed;
  const dailyBudgetRemaining = youtubeDailyBudget - youtubeQuotaUsed;
  const monthlyBudgetRemaining = youtubeMonthlyBudget - youtubeMonthlyQuotaUsed;
  
  const dailyQuotaPercentUsed = ((youtubeQuotaUsed / youtubeQuotaDailyLimit) * 100).toFixed(2);
  const dailyBudgetPercentUsed = ((youtubeQuotaUsed / youtubeDailyBudget) * 100).toFixed(2);
  const monthlyBudgetPercentUsed = ((youtubeMonthlyQuotaUsed / youtubeMonthlyBudget) * 100).toFixed(2);
  const monthlyQuotaPercentUsed = ((youtubeMonthlyQuotaUsed / youtubeQuotaMonthlyLimit) * 100).toFixed(2);
  
  // Calculate time until daily reset (midnight UTC)
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  const hoursUntilDailyReset = ((tomorrow - now) / 1000 / 60 / 60).toFixed(1);
  
  // Calculate time until monthly reset
  const nextMonth = new Date(now);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  nextMonth.setUTCDate(1);
  nextMonth.setUTCHours(0, 0, 0, 0);
  const daysUntilMonthlyReset = Math.ceil((nextMonth - now) / 1000 / 60 / 60 / 24);

  res.json({
    api_key_configured: !!YOUTUBE_API_KEY,
    
    // Daily limits (YouTube imposed)
    daily_quota_limit: youtubeQuotaDailyLimit,
    daily_quota_used: youtubeQuotaUsed,
    daily_quota_remaining: dailyQuotaRemaining,
    daily_quota_percent_used: parseFloat(dailyQuotaPercentUsed),
    hours_until_daily_reset: parseFloat(hoursUntilDailyReset),
    
    // Daily budget (self-imposed to stay within monthly target)
    daily_budget: youtubeDailyBudget,
    daily_budget_remaining: dailyBudgetRemaining,
    daily_budget_percent_used: parseFloat(dailyBudgetPercentUsed),
    
    // Monthly tracking
    monthly_quota_limit: youtubeQuotaMonthlyLimit,
    monthly_quota_used: youtubeMonthlyQuotaUsed,
    monthly_quota_percent_used: parseFloat(monthlyQuotaPercentUsed),
    monthly_budget: youtubeMonthlyBudget,
    monthly_budget_percent: youtubeMonthlyBudgetPercent * 100,
    monthly_budget_remaining: monthlyBudgetRemaining,
    monthly_budget_percent_used: parseFloat(monthlyBudgetPercentUsed),
    days_until_monthly_reset: daysUntilMonthlyReset,
    
    // Status
    quota_reset_date: youtubeQuotaResetTime,
    api_call_count: youtubeApiCallCount,
    fallback_used: youtubeApiFallbackUsed,
    status: monthlyBudgetPercentUsed >= 95 ? 'critical' : monthlyBudgetPercentUsed >= 80 ? 'warning' : 'ok',
    
    // Recent history summary
    history_days_tracked: youtubeQuotaHistory.length,
    history_total_quota_used: youtubeQuotaHistory.reduce((sum, h) => sum + h.quota_used, 0)
  });
});

// YouTube API Audit Endpoint - For YouTube compliance audits
app.get('/api/youtube/audit', adminLimiter, requireAdminToken, (req, res) => {
  const { days, format } = req.query;
  const daysToShow = Math.min(Math.max(parseInt(days) || 90, 1), 365); // clamp 1–365
  
  // Get history for requested number of days
  const history = youtubeQuotaHistory.slice(-daysToShow);
  
  // Calculate statistics
  const totalQuotaUsed = history.reduce((sum, h) => sum + h.quota_used, 0);
  const totalApiCalls = history.reduce((sum, h) => sum + h.api_calls, 0);
  const avgDailyUsage = history.length > 0 ? Math.round(totalQuotaUsed / history.length) : 0;
  const daysWithFallback = history.filter(h => h.fallback_used).length;
  
  // Monthly breakdown
  const monthlyBreakdown = {};
  history.forEach(h => {
    const month = h.date.substring(0, 7); // YYYY-MM
    if (!monthlyBreakdown[month]) {
      monthlyBreakdown[month] = {
        quota_used: 0,
        api_calls: 0,
        days_tracked: 0,
        days_with_fallback: 0
      };
    }
    monthlyBreakdown[month].quota_used += h.quota_used;
    monthlyBreakdown[month].api_calls += h.api_calls;
    monthlyBreakdown[month].days_tracked++;
    if (h.fallback_used) monthlyBreakdown[month].days_with_fallback++;
  });
  
  // Add percentages to monthly breakdown
  Object.keys(monthlyBreakdown).forEach(month => {
    const data = monthlyBreakdown[month];
    data.quota_percent_of_monthly_limit = ((data.quota_used / youtubeQuotaMonthlyLimit) * 100).toFixed(2);
    data.quota_percent_of_monthly_budget = ((data.quota_used / youtubeMonthlyBudget) * 100).toFixed(2);
    data.avg_daily_usage = Math.round(data.quota_used / data.days_tracked);
  });
  
  const auditData = {
    audit_timestamp: new Date().toISOString(),
    quota_grant_info: {
      project_id: '780609930257',
      daily_quota_limit: youtubeQuotaDailyLimit,
      monthly_quota_limit: youtubeQuotaMonthlyLimit,
      grant_expiry: '2025-08-03', // 6 months from Feb 3, 2025
      terms_compliance: 'https://developers.google.com/youtube/terms/api-services-terms-of-service'
    },
    self_imposed_limits: {
      monthly_budget: youtubeMonthlyBudget,
      monthly_budget_percent: (youtubeMonthlyBudgetPercent * 100) + '%',
      daily_budget: youtubeDailyBudget,
      purpose: `Optimal quota utilization targeting ${(youtubeMonthlyBudgetPercent * 100).toFixed(0)}% of monthly quota allocation`
    },
    current_usage: {
      daily_quota_used: youtubeQuotaUsed,
      daily_quota_remaining: youtubeQuotaDailyLimit - youtubeQuotaUsed,
      monthly_quota_used: youtubeMonthlyQuotaUsed,
      monthly_quota_remaining: youtubeQuotaMonthlyLimit - youtubeMonthlyQuotaUsed,
      api_call_count: youtubeApiCallCount,
      fallback_active: youtubeApiFallbackUsed
    },
    historical_statistics: {
      days_tracked: history.length,
      date_range: {
        from: history.length > 0 ? history[0].date : null,
        to: history.length > 0 ? history[history.length - 1].date : null
      },
      total_quota_used: totalQuotaUsed,
      total_api_calls: totalApiCalls,
      avg_daily_quota_usage: avgDailyUsage,
      days_with_fallback: daysWithFallback,
      fallback_usage_percent: history.length > 0 ? ((daysWithFallback / history.length) * 100).toFixed(2) : 0
    },
    monthly_breakdown: monthlyBreakdown,
    use_case: {
      description: 'Multi-platform livestream monitoring service',
      monitored_channels: parseList(process.env.YOUTUBE_USERNAMES).length,
      check_interval_seconds: CHECK_INTERVAL / 1000,
      platforms_monitored: ['YouTube', 'Kick', 'Twitch', 'Rumble', 'Vaughn', 'Parti']
    }
  };
  
  // Include full daily history if requested
  if (format === 'detailed') {
    auditData.daily_history = history;
  }
  
  res.json(auditData);
});
app.get('/youtube-quota-dashboard.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'youtube-quota-dashboard.css'));
});
app.get('/healthz', adminLimiter, requireAdminToken, (req, res) => {
  const dailyQuotaPercentUsed = ((youtubeQuotaUsed / youtubeQuotaDailyLimit) * 100).toFixed(2);
  const monthlyBudgetPercentUsed = ((youtubeMonthlyQuotaUsed / youtubeMonthlyBudget) * 100).toFixed(2);
  
  res.status(LAST_SCRAPE_ERROR ? 503 : 200).json({
    ok: !LAST_SCRAPE_ERROR,
    running: RUNNING,
    last_scrape_at: LAST_SCRAPE_AT,
    error: LAST_SCRAPE_ERROR,
    kick_authorized: !!kickAccessToken,
    youtube_api: {
      configured: !!YOUTUBE_API_KEY,
      daily_quota_used: youtubeQuotaUsed,
      daily_quota_limit: youtubeQuotaDailyLimit,
      daily_quota_percent: parseFloat(dailyQuotaPercentUsed),
      monthly_quota_used: youtubeMonthlyQuotaUsed,
      monthly_budget: youtubeMonthlyBudget,
      monthly_budget_percent: parseFloat(monthlyBudgetPercentUsed),
      fallback_active: youtubeApiFallbackUsed
    }
  });
});

// ── Catch-all 404 — don't expose route structure or stack traces ──────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// ── Global error handler ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('Unhandled express error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Kick OAuth URL: ${getKickAuthUrl()}`);
  console.log(`Kick authorized: ${!!kickAccessToken}`);
  console.log(`YouTube API configured: ${!!YOUTUBE_API_KEY}`);
  console.log(`YouTube Daily quota limit: ${youtubeQuotaDailyLimit} units/day`);
  console.log(`YouTube Monthly quota limit: ${youtubeQuotaMonthlyLimit} units/month`);
  console.log(`YouTube Monthly budget (${(youtubeMonthlyBudgetPercent * 100)}%): ${youtubeMonthlyBudget} units/month`);
  console.log(`YouTube Daily budget: ~${youtubeDailyBudget} units/day`);
  runScraper();
  setInterval(runScraper, CHECK_INTERVAL);
});

async function gracefulShutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully...`);
  await closeBrowserSafely();
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));