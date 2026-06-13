# =============================================================================
# Multi-stage Dockerfile — Node (server.js) + Python (rumble.py) in one image
# Supervisor (supervisord) starts both processes; Node talks to Flask on :5000
# via localhost since they share the same container network namespace.
# =============================================================================

# ─── Stage 1: Node deps (build-only) ─────────────────────────────────────────
FROM node:20-bookworm-slim AS node-deps

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ─── Stage 2: Python deps (build-only) ───────────────────────────────────────
FROM python:3.12-slim-bookworm AS python-deps

WORKDIR /app

COPY requirements.rumble.txt ./
RUN pip install --no-cache-dir -r requirements.rumble.txt

# ─── Stage 3: Combined runtime ────────────────────────────────────────────────
# Base on Node so `node` is on PATH; install Python + system Chromium on top.
FROM node:20-bookworm-slim AS runtime

# ── System packages ───────────────────────────────────────────────────────────
# One apt pass: Chromium (shared by Puppeteer + Playwright), Python 3,
# supervisor, and every Chromium system lib both runtimes need.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libx11-xcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      xdg-utils \
      ca-certificates \
      python3 \
      python3-pip \
      supervisor \
    && rm -rf /var/lib/apt/lists/*

# ── Environment ───────────────────────────────────────────────────────────────
# Both Puppeteer and patchright point at the same system Chromium binary.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_BROWSERS_PATH=/usr/lib \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    # server.js resolves the sidecar on localhost since they share a network ns
    RUMBLE_SIDECAR_URL=http://localhost:5000

WORKDIR /app

# ── Copy pre-built artefacts from earlier stages ──────────────────────────────
COPY --from=node-deps   /app/node_modules          ./node_modules
COPY --from=python-deps /usr/local/lib/python3.12  /usr/local/lib/python3.12
COPY --from=python-deps /usr/local/bin             /usr/local/bin

# ── Copy application source ───────────────────────────────────────────────────
COPY . .

# ── Supervisord config ────────────────────────────────────────────────────────
# Written inline so the Dockerfile stays self-contained (no extra config file).
RUN mkdir -p /etc/supervisor/conf.d /var/log/supervisor && \
    printf '[supervisord]\n\
nodaemon=true\n\
user=appuser\n\
logfile=/var/log/supervisor/supervisord.log\n\
pidfile=/var/run/supervisord.pid\n\
\n\
[program:node]\n\
command=node /app/server.js\n\
directory=/app\n\
autostart=true\n\
autorestart=true\n\
startretries=5\n\
stdout_logfile=/dev/stdout\n\
stdout_logfile_maxbytes=0\n\
stderr_logfile=/dev/stderr\n\
stderr_logfile_maxbytes=0\n\
\n\
[program:rumble]\n\
command=python3 /app/rumble.py\n\
directory=/app\n\
autostart=true\n\
autorestart=true\n\
startretries=5\n\
stdout_logfile=/dev/stdout\n\
stdout_logfile_maxbytes=0\n\
stderr_logfile=/dev/stderr\n\
stderr_logfile_maxbytes=0\n\
' > /etc/supervisor/conf.d/app.conf

# ── Non-root user ─────────────────────────────────────────────────────────────
# Both Puppeteer and Playwright require --no-sandbox when not root.
# supervisord itself runs as appuser (set above in [supervisord] user=).
RUN groupadd -r appuser && useradd -r -g appuser -d /app appuser \
    && chown -R appuser:appuser /app /var/log/supervisor
USER appuser

EXPOSE 3000

# Healthcheck targets the Node API — if Node is up, the container is healthy.
# rumble.py coming up slightly later is fine; server.js retries on error.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/healthz?token='+process.env.ADMIN_TOKEN, r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/app.conf"]