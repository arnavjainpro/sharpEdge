# sharpEdge is a single long-lived process — the HTTP server and every background
# scheduler (detectors, sweep, screener, briefings) live in the same runtime, and
# it holds a Finnhub websocket open. That needs a container, not a function.
#
# Pinned to the Bun image rather than Node because the app uses Bun's SQL client
# (src/db.ts), Bun.serve and Bun.password. There is no build step: Bun runs the
# TypeScript directly.
FROM oven/bun:1-alpine

WORKDIR /app

# Dependencies first, so editing source doesn't invalidate the install layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

# Makes auth/middleware.ts add `Secure` to the session cookie.
ENV NODE_ENV=production

# Informational only — the real port comes from $PORT, which config.ts reads.
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
