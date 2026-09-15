# syntax=docker/dockerfile:1

# Build stage: install all dependencies and bundle assets/ into dist/
FROM node:24-trixie-slim AS build

# Only needed if a prebuilt sqlite3 binary cannot be downloaded and it has to be compiled
RUN apt-get update \
 && apt-get install --quiet --yes --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

# Runtime stage: production dependencies, backend sources and the built frontend only
FROM node:24-trixie-slim

# tini forwards stop signals to Node.js, the sqlite3 CLI is used for online database backups
RUN apt-get update \
 && apt-get install --quiet --yes --no-install-recommends tini sqlite3 \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    MINETRACK_DATABASE_FILE=/data/database.sql \
    MINETRACK_LOG_FILE=

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json main.js config.json servers.json minecraft_versions.json ./
COPY lib ./lib

# Application files stay owned by root and read-only for the app user
# Only /data, where the SQLite database lives, is writable by the unprivileged "node" user (uid 1000)
RUN mkdir -p /data \
 && chown node:node /data
VOLUME /data

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "main.js"]
