'use strict';

require('dotenv').config();

const express  = require('express');
const { spawn } = require('child_process');
const ffmpeg   = require('fluent-ffmpeg');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const fetch    = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
const Database = require('better-sqlite3');
const os       = require('os');

/* ============================================================
   CONFIG
   ============================================================ */
const CLIP_OUTPUT_DIR    = process.env.CLIP_OUTPUT_DIR  || path.join(__dirname, 'public', 'clips');
const CLIP_TEMP_DIR      = process.env.CLIP_TEMP_DIR    || path.join(__dirname, 'temp');
const KICK_API_BASE      = process.env.KICK_API_BASE    || 'https://api.kick.com';
const KICK_AUTH_BASE     = process.env.KICK_AUTH_BASE   || 'https://id.kick.com';
const KICK_CLIENT_ID     = process.env.KICK_CLIENT_ID   || '';
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
const YOUTUBE_API_KEY    = process.env.YOUTUBE_API_KEY  || '';
const CATBOX_USERHASH    = process.env.CATBOX_USERHASH  || '';
const MAX_CLIP_SECONDS   = Number(process.env.MAX_CLIP_SECONDS)  || 300;
const DEFAULT_CLIP_SECS  = Number(process.env.DEFAULT_CLIP_SECS) || 60;
const DB_PATH            = process.env.DB_PATH || path.join(__dirname, 'clipper.db');

/* ── Security ─────────────────────────────────────────────── */
// Set CLIPPER_API_KEY in your environment to require an Authorization header
// on every mutating request (POST, DELETE).  Server will refuse to start without it.
const API_KEY = process.env.CLIPPER_API_KEY || '';
if (!API_KEY || API_KEY.length < 32) {
  console.error(
    '[Clipper] FATAL: CLIPPER_API_KEY must be set to a string of at least 32 characters.\n' +
    '         Generate one with: node -e "require(\'crypto\').randomBytes(32).toString(\'hex\')|0 && process.stdout.write(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
  process.exit(1);
}

// Maximum simultaneous capture jobs (yt-dlp + ffmpeg processes).
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS) || 5;

// FFmpeg encoding threads per job.
// Half the VPS cores divided by max concurrent jobs keeps total CPU within the "half-cores" budget.
// Override via FFMPEG_THREADS env var.  Default derived at startup from os.cpus().
const HALF_CORES             = Math.max(2, Math.floor(os.cpus().length / 2));
const FFMPEG_THREADS         = Number(process.env.FFMPEG_THREADS) || Math.max(1, Math.floor(HALF_CORES / MAX_CONCURRENT_JOBS));

// yt-dlp parallel HLS fragment downloads per job.
// The single biggest clip-speed win — downloads multiple .ts segments concurrently.
// 3 is safe alongside ffmpeg encoding threads on a 5-core VPS.
const YTDLP_CONCURRENT_FRAGS = Number(process.env.YTDLP_CONCURRENT_FRAGS) || 3;

// Simple in-memory rate limiter: max requests per window per IP.
const RATE_LIMIT_WINDOW_MS  = Number(process.env.RATE_LIMIT_WINDOW_MS)  || 60_000; // 1 min
const RATE_LIMIT_MAX_REQ    = Number(process.env.RATE_LIMIT_MAX_REQ)    || 10;

// Allowed HTTPS hostnames for user-supplied stream URLs (SSRF guard).
// Add more if you need to support additional platforms.
const ALLOWED_STREAM_HOSTS = new Set([
  'www.youtube.com', 'youtube.com', 'm.youtube.com',
  'www.twitch.tv',   'twitch.tv',
  'kick.com',        'www.kick.com',  'm.kick.com',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_PLATFORMS = ['youtube', 'twitch', 'kick'];
const VALID_QUALITIES  = ['low', 'medium', 'high'];

/* Ensure directories exist */
[CLIP_OUTPUT_DIR, CLIP_TEMP_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/* ============================================================
   JOB STORE  (SQLite-backed)
   ============================================================ */

/**
 * @typedef {Object} ClipJob
 * @property {string}  id
 * @property {string}  platform
 * @property {string}  username
 * @property {number}  duration
 * @property {'pending'|'resolving'|'capturing'|'encoding'|'ready'|'error'} status
 * @property {number}  progress       0–100
 * @property {string|null} outputFile absolute path to finished mp4
 * @property {string|null} downloadUrl relative URL the client can use
 * @property {string|null} error
 * @property {string}  createdAt      ISO timestamp
 */

const db = new Database(DB_PATH);

// WAL mode for better concurrent read/write performance
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    platform    TEXT NOT NULL,
    username    TEXT NOT NULL,
    duration    INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    progress    INTEGER NOT NULL DEFAULT 0,
    outputFile  TEXT,
    downloadUrl TEXT,
    error       TEXT,
    createdAt   TEXT NOT NULL
  )
`);

// Index makes the ORDER BY createdAt DESC in stmtRecent an index scan instead of a full table sort.
db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(createdAt DESC)`);

// Prepared statements
const stmtInsert = db.prepare(`
  INSERT INTO jobs (id, platform, username, duration, status, progress, outputFile, downloadUrl, error, createdAt)
  VALUES (@id, @platform, @username, @duration, @status, @progress, @outputFile, @downloadUrl, @error, @createdAt)
`);

const stmtSelectOne = db.prepare('SELECT * FROM jobs WHERE id = ?');

const stmtUpdate = db.prepare(`
  UPDATE jobs
  SET status      = COALESCE(@status,      status),
      progress    = COALESCE(@progress,    progress),
      outputFile  = COALESCE(@outputFile,  outputFile),
      downloadUrl = COALESCE(@downloadUrl, downloadUrl),
      error       = COALESCE(@error,       error)
  WHERE id = @id
`);

const stmtDelete  = db.prepare('DELETE FROM jobs WHERE id = ?');
const stmtCount   = db.prepare('SELECT COUNT(*) AS n FROM jobs');
const stmtRecent  = db.prepare('SELECT * FROM jobs ORDER BY createdAt DESC LIMIT 100');

/** Parse a raw DB row back into a ClipJob (coerce integer progress). */
function rowToJob(row) {
  if (!row) return null;
  return { ...row, progress: Number(row.progress), duration: Number(row.duration) };
}

/**
 * Thin compatibility shim so the rest of the file can still call
 * jobs.get / jobs.set / jobs.delete / jobs.values / jobs.size.
 */
const jobs = {
  get:    (id)       => rowToJob(stmtSelectOne.get(id)),
  set:    (_id, job) => stmtInsert.run(job),   // only used by createJob
  delete: (id)       => { stmtDelete.run(id); },
  values: ()         => stmtRecent.all().map(rowToJob),
  get size()         { return stmtCount.get().n; },
};

function createJob(platform, username, duration) {
  const id = uuidv4();
  /** @type {ClipJob} */
  const job = {
    id,
    platform,
    username,
    duration,
    status: 'pending',
    progress: 0,
    outputFile: null,
    downloadUrl: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  stmtInsert.run(job);
  return job;
}

function updateJob(id, patch) {
  stmtUpdate.run({
    id,
    status:      patch.status      ?? null,
    progress:    patch.progress    ?? null,
    outputFile:  patch.outputFile  ?? null,
    downloadUrl: patch.downloadUrl ?? null,
    error:       patch.error       ?? null,
  });
}

/* ============================================================
   SECURITY HELPERS
   ============================================================ */

/**
 * Sanitise a channel handle / username:
 *  - strip leading/trailing whitespace
 *  - cap length at 128 chars
 *  - remove characters that are illegal in filenames or HTTP headers
 */
function sanitizeUsername(raw) {
  if (typeof raw !== 'string') throw new Error('username must be a string');
  const s = raw.trim();
  if (!s) throw new Error('username is empty');
  if (s.length > 128) throw new Error('username too long (max 128 chars)');
  // Keep word chars, @, :, ., /, -, and URL query-string chars (?, =, &) — everything else becomes _
  return s.replace(/[^\w@:./?=&-]/g, '_');
}

/**
 * SSRF guard — if the caller supplied a full URL, ensure it points to one of
 * the known-good streaming hostnames and uses HTTPS.
 */
function assertSafeUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new Error(`Invalid URL: ${url}`); }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Only HTTPS URLs are allowed (got ${parsed.protocol})`);
  }
  if (!ALLOWED_STREAM_HOSTS.has(parsed.hostname)) {
    throw new Error(`URL hostname not allowed: ${parsed.hostname}`);
  }
}

/**
 * Validate that a jobId looks like a v4 UUID before hitting the DB.
 */
function assertValidJobId(id) {
  if (!UUID_RE.test(id)) {
    const err = new Error('Invalid job ID');
    err.status = 400;
    throw err;
  }
}

/**
 * Escape a value for use in a Content-Disposition filename parameter.
 */
function safeFilename(name) {
  return '"' + name.replace(/[\\"/\r\n]/g, '_') + '"';
}

/**
 * Strip server-internal fields before sending a job to the client.
 * Removes `outputFile` (absolute disk path) to avoid filesystem disclosure.
 */
function publicJob(job) {
  if (!job) return null;
  const { outputFile: _omit, ...rest } = job;
  return rest;
}

/* ── Simple in-memory rate limiter ────────────────────────── */
const _rateBuckets = new Map(); // ip → { count, resetAt }

function rateLimitMiddleware(req, res, next) {
  const ip  = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = _rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    _rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX_REQ) {
    res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
    return res.status(429).json({ error: 'Too many requests — slow down' });
  }
  next();
}
// Prune stale buckets periodically to avoid memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of _rateBuckets) { if (now > b.resetAt) _rateBuckets.delete(ip); }
}, 300_000).unref();

/* ── API-key guard (always enforced) ─────────────────────── */
function apiKeyMiddleware(req, res, next) {
  const provided = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!provided || provided !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized — valid API key required' });
  }
  next();
}

/* ── Active-job concurrency counter ──────────────────────── */
let _activeJobs = 0;

/* ============================================================
   PLATFORM: STREAM-URL RESOLVERS
   ============================================================ */

/**
 * YouTube — uses the Data API to resolve a handle to a live video ID,
 * then returns type:'ytdlp' with the direct watch?v= URL.
 *
 * The yt-dlp download path uses player_client=android which hits YouTube's InnerTube API
 * mobile innertube API and avoids the [youtube:tab] channel-page scraper
 * that 404s when the live tab is absent or the video is unlisted.
 */
async function resolveYouTube(username) {
  if (username.startsWith('http')) {
    assertSafeUrl(username);
    // Fall through with this as watchUrl so it gets the same HLS pre-resolution below.
    const watchUrl = username;
    try {
      const hlsUrl = await ytDlpGetUrl(watchUrl, [
        '--extractor-args', 'youtube:player_client=android',
        '--format', 'best[protocol^=m3u8][height<=1080]/best[protocol^=m3u8]/best',
      ]);
      console.log(`[YouTube] Resolved HLS URL for ${watchUrl}`);
      return { type: 'hls', url: hlsUrl };
    } catch (err) {
      console.warn(`[YouTube] --get-url failed (${err.message}), falling back to ytdlp mode`);
      return { type: 'ytdlp', url: watchUrl };
    }
  }

  const handle = username.replace(/^@/, '');
  let watchUrl = null;

  if (YOUTUBE_API_KEY) {
    try {
      const chRes = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${YOUTUBE_API_KEY}`
      );
      if (chRes.ok) {
        const channelId = (await chRes.json())?.items?.[0]?.id;
        if (channelId) {
          const srRes = await fetch(
            `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${encodeURIComponent(channelId)}&eventType=live&type=video&key=${YOUTUBE_API_KEY}`
          );
          if (srRes.ok) {
            const videoId = (await srRes.json())?.items?.[0]?.id?.videoId;
            if (videoId) {
              console.log(`[YouTube] Data API: @${handle} -> watch?v=${videoId}`);
              watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[YouTube] Data API failed (${err.message})`);
    }
  }

  if (!watchUrl) {
    console.warn(`[YouTube] Falling back to @${handle}/live`);
    watchUrl = `https://www.youtube.com/@${encodeURIComponent(handle)}/live`;
  }

  // Pre-resolve to a direct HLS manifest URL.
  //
  // Reasons:
  //  1. Avoids the [youtube:tab] channel-page scraper entirely — ios+web player
  //     clients hit YouTube's innertube API directly and work even when the tab
  //     endpoint 404s.
  //  2. Lets captureClip use ffmpeg -t (reliable live clipping) instead of
  //     yt-dlp --download-sections (designed for VODs, unreliable on live HLS).
  try {
    const hlsUrl = await ytDlpGetUrl(watchUrl, [
      '--extractor-args', 'youtube:player_client=android',
      '--format', 'best[protocol^=m3u8][height<=1080]/best[protocol^=m3u8]/best',
    ]);
    console.log(`[YouTube] Resolved HLS URL for ${watchUrl}`);
    return { type: 'hls', url: hlsUrl };
  } catch (err) {
    // Last-ditch fallback: hand the page URL to yt-dlp and let it figure it out.
    console.warn(`[YouTube] --get-url failed (${err.message}), falling back to ytdlp mode`);
    return { type: 'ytdlp', url: watchUrl };
  }
}

/**
 * Twitch — yt-dlp handles OAuth-less public stream extraction perfectly.
 * We never accept a raw URL from the caller to prevent SSRF.
 */
/**
 * Twitch — pre-resolve to a direct HLS URL so captureClip can use
 * ffmpeg -t (live-edge clipping) instead of yt-dlp --download-sections.
 */
async function resolveTwitch(username) {
  const handle = encodeURIComponent(username.replace(/^https?:\/\/[^/]+\//i, '').split('/')[0]);
  const pageUrl = `https://www.twitch.tv/${handle}`;
  try {
    const hlsUrl = await ytDlpGetUrl(pageUrl, ['--format', 'best[protocol^=m3u8]/best']);
    console.log(`[Twitch] Resolved HLS URL for ${handle}`);
    return { type: 'hls', url: hlsUrl };
  } catch (err) {
    console.warn(`[Twitch] --get-url failed (${err.message}), falling back to ytdlp mode`);
    return { type: 'ytdlp', url: pageUrl };
  }
}

async function resolveKick(username) {
  let slug;
  if (username.startsWith('http')) {
    assertSafeUrl(username);
    slug = new URL(username).pathname.replace(/^\//, '').split('/')[0];
  } else {
    slug = username.replace(/^@/, '').split('/')[0].trim();
  }
  const pageUrl = `https://kick.com/${encodeURIComponent(slug)}`;
  try {
    const hlsUrl = await ytDlpGetUrl(pageUrl, ['--format', 'best[protocol^=m3u8]/best']);
    console.log(`[Kick] Resolved HLS URL for ${slug}`);
    return { type: 'hls', url: hlsUrl };
  } catch (err) {
    console.warn(`[Kick] --get-url failed (${err.message}), falling back to ytdlp mode`);
    return { type: 'ytdlp', url: pageUrl };
  }
}


/* ============================================================
   yt-dlp HELPER  — get a direct stream URL without downloading
   ============================================================ */

/**
 * Runs yt-dlp --get-url and resolves with the first URL printed.
 */
function ytDlpGetUrl(pageUrl, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const args = [
      '--get-url',
      '--no-playlist',
      ...extraArgs,
      pageUrl,
    ];
    const proc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      const url = stdout.trim().split('\n')[0];
      if (code !== 0 || !url) {
        reject(new Error(`yt-dlp failed (${code}): ${stderr.trim().slice(0, 200)}`));
      } else {
        resolve(url);
      }
    });
    proc.on('error', err => reject(new Error(`yt-dlp spawn error: ${err.message}`)));
  });
}

/* ============================================================
   CLIPPING ENGINE
   ============================================================ */

/**
 * Unified platform dispatcher — returns { type, url } for a live stream.
 */
async function resolveStreamUrl(platform, username) {
  const p = platform.toLowerCase();
  switch (p) {
    case 'youtube': return resolveYouTube(username);
    case 'twitch':  return resolveTwitch(username);
    case 'kick':    return resolveKick(username);
    default:        throw new Error(`Unsupported platform: "${platform}"`);
  }
}

/**
 * Cut a clip from an HLS or FLV stream.
 *
 * For HLS streams we use yt-dlp (handles manifests, retries, auth).
 * For FLV we pipe ffmpeg directly — yt-dlp can't download raw FLV by time.
 *
 * @param {string} jobId
 * @param {{ type: 'hls'|'flv'|'ytdlp', url: string }} stream
 * @param {number} duration  seconds
 * @param {'low'|'medium'|'high'} quality
 * @returns {Promise<string>} absolute path to the finished mp4
 */
async function captureClip(jobId, stream, duration, quality = 'medium') {
  const outFile = path.join(CLIP_OUTPUT_DIR, `clip_${jobId}.mp4`);
  const tempRaw = path.join(CLIP_TEMP_DIR, `raw_${jobId}`);

  if (stream.type === 'flv' || stream.type === 'hls') {
    // --- Direct-URL path: feed stream URL straight into ffmpeg ---
    // Covers:
    //   'flv'  — raw FLV CDN streams
    //   'hls'  — m3u8 URLs resolved via platform APIs or yt-dlp --get-url
    //            ffmpeg's own HTTP stack is used, bypassing libcurl entirely.
    return new Promise((resolve, reject) => {
      updateJob(jobId, { status: 'capturing', progress: 5 });

      const sizeFilter = quality === 'low'  ? '640:-2'
                       : quality === 'high' ? '1280:-2'
                       : '854:-2';

      ffmpeg(stream.url)
        .inputOptions([
          // Reconnect on dropped segments — essential for live HLS
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
          '-t', String(duration),
        ])
        .videoCodec('libx264')
        .audioCodec('aac')
        .audioBitrate('128k')
        .videoFilter(`scale=${sizeFilter}`)
        .outputOptions([
          '-preset veryfast',
          // Reduces live-stream encode latency without touching quality
          '-tune zerolatency',
          // Pin threads so concurrent jobs don't fight over cores
          `-threads ${FFMPEG_THREADS}`,
          '-movflags +faststart',
          '-avoid_negative_ts make_zero',
        ])
        .output(outFile)
        .on('progress', prog => {
          // prog.percent is always 0 for live streams (no known total duration).
          // Derive real progress from timemark (HH:MM:SS.ms) instead.
          let pct = 0;
          if (prog.timemark) {
            const p = prog.timemark.split(':');
            const secs = (+p[0]) * 3600 + (+p[1]) * 60 + parseFloat(p[2] || 0);
            pct = Math.min(95, Math.round((secs / duration) * 100));
          }
          updateJob(jobId, { status: 'capturing', progress: pct });
        })
        .on('end', () => {
          updateJob(jobId, { status: 'ready', progress: 100, outputFile: outFile });
          resolve(outFile);
        })
        .on('error', err => {
          updateJob(jobId, { status: 'error', error: err.message });
          reject(err);
        })
        .run();
    });
  }

  // --- HLS / yt-dlp path: yt-dlp download → ffmpeg re-encode ---
  const formatArg = quality === 'low'
    ? 'worst[protocol^=m3u8][height>=360]/worst[protocol^=m3u8]/worst[height>=360]/worst'
    : quality === 'high'
    ? 'best[protocol^=m3u8][height<=1080]/best[protocol^=m3u8]/best[height<=1080]/best'
    : 'best[protocol^=m3u8][height<=720]/best[protocol^=m3u8]/best[height<=720]/best';

  const tempFile = `${tempRaw}.mp4`;

  await new Promise((resolve, reject) => {
    updateJob(jobId, { status: 'capturing', progress: 2 });

    const args = [
      '--no-playlist',
      '--socket-timeout', '20',
      '--retries', '3',
      '--fragment-retries', '3',
      // Parallelise HLS segment downloads — biggest single speed-up for clip capture.
      '--concurrent-fragments', String(YTDLP_CONCURRENT_FRAGS),
      // Larger per-fragment buffer cuts I/O round-trips on fast CDNs.
      '--buffer-size', '16M',
      // Skip writing a .part temp file and the rename syscall on completion.
      '--no-part',
      '--format', formatArg,
      // android player_client uses InnerTube without requiring a PO Token,
      // which ios and web both now demand on VPS/datacenter IPs.
      '--extractor-args', 'youtube:player_client=android',
      '--downloader', 'native',
      '--download-sections', `*0-${duration}`,
      '-o', tempFile,
      stream.url,
    ];

    const proc = spawn('yt-dlp', args);
    let stderr = '';

    proc.stdout.on('data', data => {
      const out = data.toString();
      const m = out.match(/(\d+\.?\d*)%/);
      if (m) {
        // Map download progress to 2–70%
        const pct = 2 + Math.min(68, parseFloat(m[1]) * 0.68);
        updateJob(jobId, { progress: Math.round(pct) });
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 2000)}`));
      else resolve();
    });
    proc.on('error', err => reject(new Error(`yt-dlp spawn: ${err.message}`)));
  });

  // Re-encode to normalised mp4
  await new Promise((resolve, reject) => {
    updateJob(jobId, { status: 'encoding', progress: 72 });

    const sizeFilter = quality === 'low'  ? '640:-2'
                     : quality === 'high' ? '1280:-2'
                     : '854:-2';

    ffmpeg(tempFile)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('128k')
      .videoFilter(`scale=${sizeFilter}`)
      .outputOptions([
        '-preset veryfast',
        `-threads ${FFMPEG_THREADS}`,
        '-movflags +faststart',
      ])
      .output(outFile)
      .on('progress', prog => {
        const pct = 72 + Math.min(23, (prog.percent || 0) * 0.23);
        updateJob(jobId, { progress: Math.round(pct) });
      })
      .on('end', () => {
        // Cleanup temp file
        fs.unlink(tempFile, () => {});
        updateJob(jobId, { status: 'ready', progress: 100, outputFile: outFile });
        resolve();
      })
      .on('error', err => {
        fs.unlink(tempFile, () => {});
        updateJob(jobId, { status: 'error', error: err.message });
        reject(err);
      })
      .run();
  });

  return outFile;
}

/* ============================================================
   PUBLIC API — start a clip job
   ============================================================ */

/**
 * Start a clip job asynchronously. Returns the job object immediately.
 *
 * @param {Object} opts
 * @param {string} opts.platform   'youtube'|'twitch'|'kick'
 * @param {string} opts.username   channel handle / URL
 * @param {number} [opts.duration] seconds to capture (capped at MAX_CLIP_SECONDS)
 * @param {'low'|'medium'|'high'} [opts.quality]
 * @returns {ClipJob}
 */
function startClip({ platform, username, duration, quality = 'medium' }) {
  if (!platform || !username) throw new Error('platform and username are required');

  const normalPlatform = platform.toLowerCase();
  if (!VALID_PLATFORMS.includes(normalPlatform)) {
    throw new Error(`Unsupported platform: "${platform}"`);
  }

  const normalQuality = (quality || 'medium').toLowerCase();
  if (!VALID_QUALITIES.includes(normalQuality)) {
    throw new Error(`Invalid quality "${quality}". Valid: ${VALID_QUALITIES.join(', ')}`);
  }

  const safeUser = sanitizeUsername(username);

  const secs = Math.min(
    MAX_CLIP_SECONDS,
    Math.max(5, Number(duration) || DEFAULT_CLIP_SECS)
  );

  if (_activeJobs >= MAX_CONCURRENT_JOBS) {
    throw Object.assign(
      new Error(`Server busy — max ${MAX_CONCURRENT_JOBS} concurrent jobs`),
      { status: 503 }
    );
  }

  const job = createJob(normalPlatform, safeUser, secs);
  _activeJobs++;

  // Fire-and-forget — caller polls /clip/:id for status
  (async () => {
    try {
      const downloadUrl = `/clips/clip_${job.id}.mp4`;
      updateJob(job.id, { status: 'resolving', progress: 1, downloadUrl });

      const stream = await resolveStreamUrl(normalPlatform, safeUser);

      updateJob(job.id, { status: 'capturing', progress: 2 });
      const outFile = await captureClip(job.id, stream, secs, normalQuality);

      updateJob(job.id, { status: 'ready', progress: 100, outputFile: outFile });
      console.log(`[Clipper] Job ${job.id} ready → ${outFile}`);
    } catch (err) {
      console.error(`[Clipper] Job ${job.id} failed:`, err.message);
      updateJob(job.id, { status: 'error', error: err.message });
    } finally {
      _activeJobs--;
    }
  })();

  return jobs.get(job.id);
}

/* ============================================================
   EXPRESS ROUTER
   ============================================================ */
const router = express.Router();

// Apply rate limiting and API-key guard to all routes on this router
router.use(rateLimitMiddleware);

/**
 * POST /api/clipper/clip
 * Body: { platform, username, duration?, quality? }
 * Returns: { jobId, status, message }
 */
router.post('/clip', apiKeyMiddleware, (req, res) => {
  try {
    const { platform, username, duration, quality } = req.body || {};

    if (!platform || !username) {
      return res.status(400).json({ error: 'platform and username are required' });
    }

    if (!VALID_PLATFORMS.includes((platform || '').toLowerCase())) {
      return res.status(400).json({
        error: `Unsupported platform. Valid: ${VALID_PLATFORMS.join(', ')}`,
      });
    }

    const job = startClip({ platform, username, duration, quality });

    res.json({
      jobId: job.id,
      status: job.status,
      message: `Clip job started for ${job.platform}/${job.username} (${job.duration}s)`,
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/clipper/clip/:jobId
 * Returns the current job state (internal paths stripped).
 */
router.get('/clip/:jobId', (req, res) => {
  try { assertValidJobId(req.params.jobId); } catch (e) { return res.status(400).json({ error: e.message }); }
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(publicJob(job));
});

/**
 * GET /api/clipper/clip/:jobId/download
 * Streams the finished mp4 to the client and deletes it afterwards.
 */
router.get('/clip/:jobId/download', (req, res) => {
  try { assertValidJobId(req.params.jobId); } catch (e) { return res.status(400).json({ error: e.message }); }
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'ready') return res.status(409).json({ error: `Job status: ${job.status}` });
  if (!job.outputFile || !fs.existsSync(job.outputFile)) {
    return res.status(410).json({ error: 'Clip file no longer exists' });
  }

  // Sanitize every field that goes into the filename to prevent header injection
  const safePlatform = (job.platform || 'unknown').replace(/[^\w]/g, '_');
  const safeUser     = (job.username || 'unknown').replace(/[^\w@.-]/g, '_');
  const safeDur      = Number(job.duration) || 0;
  const filename     = safeFilename(`clip_${safePlatform}_${safeUser}_${safeDur}s.mp4`);

  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.setHeader('Content-Type', 'video/mp4');

  const stream = fs.createReadStream(job.outputFile);
  stream.pipe(res);
  stream.on('close', () => {
    fs.unlink(job.outputFile, () => {});
    updateJob(job.id, { outputFile: null, downloadUrl: null, status: 'downloaded' });
  });
});

/**
 * POST /api/clipper/clip/:jobId/catbox
 * Server-side proxy: uploads finished mp4 to Catbox.
 */
router.post('/clip/:jobId/catbox', apiKeyMiddleware, async (req, res) => {
  try { assertValidJobId(req.params.jobId); } catch (e) { return res.status(400).json({ error: e.message }); }
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const filePath = job.outputFile;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(410).json({ error: 'Clip file not found on disk' });
  }

  try {
    // fs.readFileSync would block the event loop for the full video read.
    // fs.promises.readFile keeps Node free to handle other requests while the disk I/O runs.
    const fileBuffer = await fs.promises.readFile(filePath);
    const safePlatform = (job.platform || 'unknown').replace(/[^\w]/g, '_');
    const safeUser     = (job.username || 'unknown').replace(/[^\w@.-]/g, '_');
    const filename     = `clip_${safePlatform}_${safeUser}_${Number(job.duration) || 0}s.mp4`;
    const boundary     = 'ClipperBoundary' + Date.now().toString(16);
    const CRLF         = '\r\n';

    const body = Buffer.concat([
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="reqtype"${CRLF}`),
      Buffer.from(CRLF),
      Buffer.from(`fileupload${CRLF}`),
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="userhash"${CRLF}`),
      Buffer.from(CRLF),
      Buffer.from(`${CATBOX_USERHASH}${CRLF}`),
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="fileToUpload"; filename="${filename}"${CRLF}`),
      Buffer.from(`Content-Type: video/mp4${CRLF}`),
      Buffer.from(CRLF),
      fileBuffer,
      Buffer.from(CRLF),
      Buffer.from(`--${boundary}--${CRLF}`),
    ]);

    console.log(`[Catbox] Uploading ${filename} — ${(body.length / 1048576).toFixed(1)} MB`);

    const catboxRes = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      headers: {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
        'User-Agent':     process.env.USER_AGENT || 'Mozilla/5.0',
      },
      body,
    });

    const text = (await catboxRes.text()).trim();
    console.log(`[Catbox] Response ${catboxRes.status}: ${text}`);

    if (!catboxRes.ok) {
      return res.status(502).json({ error: `Catbox HTTP ${catboxRes.status}: ${text}` });
    }
    if (!text.startsWith('https://')) {
      return res.status(502).json({ error: `Unexpected Catbox response: ${text}` });
    }

    res.json({ url: text });
  } catch (err) {
    console.error('[Catbox] Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/clipper/clip/:jobId/quax
 * Server-side proxy: uploads finished mp4 to qu.ax.
 */
router.post('/clip/:jobId/quax', apiKeyMiddleware, async (req, res) => {
  try { assertValidJobId(req.params.jobId); } catch (e) { return res.status(400).json({ error: e.message }); }
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const filePath = job.outputFile;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(410).json({ error: 'Clip file not found on disk' });
  }

  try {
    const fileBuffer = await fs.promises.readFile(filePath);
    const safePlatform = (job.platform || 'unknown').replace(/[^\w]/g, '_');
    const safeUser     = (job.username || 'unknown').replace(/[^\w@.-]/g, '_');
    const filename     = `clip_${safePlatform}_${safeUser}_${Number(job.duration) || 0}s.mp4`;
    const boundary     = 'QuaxBoundary' + Date.now().toString(16);
    const CRLF         = '\r\n';

    const body = Buffer.concat([
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="files[]"; filename="${filename}"${CRLF}`),
      Buffer.from(`Content-Type: video/mp4${CRLF}`),
      Buffer.from(CRLF),
      fileBuffer,
      Buffer.from(CRLF),
      Buffer.from(`--${boundary}--${CRLF}`),
    ]);

    console.log(`[qu.ax] Uploading ${filename} — ${(body.length / 1048576).toFixed(1)} MB`);

    const quaxRes = await fetch('https://qu.ax/upload.php', {
      method: 'POST',
      headers: {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
        'User-Agent':     process.env.USER_AGENT || 'Mozilla/5.0',
      },
      body,
    });

    const text = (await quaxRes.text()).trim();
    console.log(`[qu.ax] Response ${quaxRes.status}: ${text.slice(0, 200)}`);

    if (!quaxRes.ok) {
      return res.status(502).json({ error: `qu.ax HTTP ${quaxRes.status}: ${text}` });
    }

    let url;
    try {
      const json = JSON.parse(text);
      url = json?.files?.[0]?.url || json?.url;
    } catch (_) {
      url = text.startsWith('https://') ? text : null;
    }

    if (!url) {
      return res.status(502).json({ error: `Unexpected qu.ax response: ${text}` });
    }

    res.json({ url });
  } catch (err) {
    console.error('[qu.ax] Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/clipper/clip/:jobId
 * Cancel / discard a job and its output file.
 */
router.delete('/clip/:jobId', apiKeyMiddleware, (req, res) => {
  try { assertValidJobId(req.params.jobId); } catch (e) { return res.status(400).json({ error: e.message }); }
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.outputFile) fs.unlink(job.outputFile, () => {});
  jobs.delete(req.params.jobId);

  res.json({ ok: true, message: `Job ${req.params.jobId} deleted` });
});

/**
 * GET /api/clipper/jobs
 * List all jobs (most recent first, max 100) — internal paths stripped.
 */
router.get('/jobs', (req, res) => {
  const list = jobs.values().map(publicJob);
  res.json({ jobs: list, total: jobs.size });
});

/**
 * GET /api/clipper/platforms
 * Describe supported platforms and expected username format.
 */
router.get('/platforms', (_req, res) => {
  res.json({
    platforms: [
      { id: 'youtube', label: 'YouTube', usernameExample: 'mkbhd  OR  https://youtube.com/@mkbhd/live', method: 'yt-dlp → HLS' },
      { id: 'twitch',  label: 'Twitch',  usernameExample: 'xqc',                                         method: 'yt-dlp → HLS' },
      { id: 'kick',    label: 'Kick',    usernameExample: 'xqc',                                         method: 'Kick API → HLS / yt-dlp fallback' },
    ],
  });
});

router.get('/config', (req, res) => {
  res.json({
    apiKey: process.env.CLIPPER_API_KEY
  });
});

/* ============================================================
   STANDALONE MODE
   ============================================================ */
if (require.main === module) {
  const app  = express();
  const PORT = process.env.PORT || 4242;

  app.use(express.json());
  app.use('/api/clipper', router);

  // Serve finished clips at /clips/<filename>
  app.use('/clips', express.static(CLIP_OUTPUT_DIR));

  // Serve the frontend (clipper.html, clipper.css) from public/
  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
  app.use(express.static(publicDir, { index: 'clipper.html' }));

  // Explicit root: always send clipper.html
  app.get('/', (_req, res) => {
    const page = path.join(publicDir, 'clipper.html');
    fs.existsSync(page)
      ? res.sendFile(page)
      : res.status(404).send('Place clipper.html + clipper.css in the public/ folder.');
  });
  app.listen(PORT, () => {
    console.log(`[Clipper] Standalone server on http://localhost:${PORT}`);
    console.log(`[Clipper] POST http://localhost:${PORT}/api/clipper/clip`);
    console.log(`[Clipper] Clips saved to: ${CLIP_OUTPUT_DIR}`);
    console.log(`[Clipper] Perf: cores=${os.cpus().length} half=${HALF_CORES} ffmpeg_threads=${FFMPEG_THREADS} yt-dlp_frags=${YTDLP_CONCURRENT_FRAGS} max_jobs=${MAX_CONCURRENT_JOBS}`);
  });
}

module.exports = { router, startClip, resolveStreamUrl };