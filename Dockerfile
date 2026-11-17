# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# URLPulse production image
#
#   stage "deps"    installs production dependencies only (npm ci --omit=dev)
#   stage "runtime" copies app + deps onto a clean Alpine image, drops npm/yarn,
#                   runs as the unprivileged "node" user, and ships a HEALTHCHECK
#
# Why this shape: every package left in the final image is a package Trivy can
# flag. No build tools, no package manager, no shell utilities beyond Alpine's
# base, and OS packages are upgraded at build time to pick up fixed CVEs.
# ---------------------------------------------------------------------------
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# BuildKit cache mount: repeat builds reuse the npm download cache
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

FROM node:${NODE_VERSION}-alpine AS runtime

# Injected by CI so /api/stats, /health and urlpulse_build_info report what is running
ARG BUILD_SHA=dev
ARG BUILD_DATE=
ENV NODE_ENV=production \
    PORT=5000 \
    BUILD_SHA=${BUILD_SHA} \
    BUILD_DATE=${BUILD_DATE}

LABEL org.opencontainers.image.title="URLPulse" \
      org.opencontainers.image.description="URL shortener with built-in uptime monitoring" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${BUILD_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"

# Patch OS packages, then remove the package managers the app never uses at
# runtime (npm bundles its own dependency tree, which scanners also report).
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
              /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/healthcheck.js ./scripts/healthcheck.js

USER node
EXPOSE 5000

# Node-based probe: no curl/wget needed. DEGRADED (Redis down) still passes.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "scripts/healthcheck.js"]

# Exec form: node is PID 1 and receives SIGTERM directly (graceful shutdown in server.js)
CMD ["node", "src/server.js"]
