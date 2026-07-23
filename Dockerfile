# Founder BTC Alpha — Phase 0 capture worker
# Single always-on process. Capture only: no orders, no forecasts.

FROM node:20-slim

# Tini gives us correct PID-1 signal handling so SIGTERM from Railway reaches
# the worker and triggers its graceful final flush instead of killing it dead.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first so the layer caches independently of source changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund 2>/dev/null \
    || npm install --omit=dev --no-audit --no-fund

# Only what the worker actually needs at runtime.
COPY src/ ./src/
COPY data/macro-calendar.json ./data/macro-calendar.json
COPY config/ ./config/

# Drop privileges. The base image ships a `node` user.
RUN mkdir -p /app/data/capture && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    KALSHI_SERIES_TICKER=KXBTC15M \
    CAPTURE_DRY_RUN=false

# No port is exposed: this is a worker, not a service.

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/worker.js"]
