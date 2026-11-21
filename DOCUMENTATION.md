# URLPulse: documentation

**Automated URL shortener and uptime-monitoring platform with CI/CD.**
Version 1.0.0 · documentation last verified against the code on 2026-11-20.

This is the **single source of truth** for the project. It says what URLPulse is, how it is designed and why, how to run, ship and extend it, and what has and has not been verified. The deep-dive documents under `docs/design/` hold the long-form detail (full API contract, every setting, every design token, every page state). They are summaries of nothing: each owns its topic. **If a deep dive and this file ever disagree, this file wins, and the deep dive is the one to fix.**

## Contents

1. [How to use this documentation](#how-to-use-this-documentation)
2. [Purpose and scope](#purpose-and-scope)
3. [Quickstart](#quickstart)
4. [Architecture](#architecture)
5. [Repository map](#repository-map)
6. [Requirements traceability](#requirements-traceability)
7. [Decision log](#decision-log)
8. [API summary](#api-summary)
9. [Configuration summary](#configuration-summary)
10. [Security](#security) (includes [Known limitations](#known-limitations))
11. [Scaling](#scaling)
12. [Observability](#observability)
13. [CI/CD](#cicd)
14. [Testing and quality](#testing-and-quality)
15. [Website](#website)
16. [Deployment and operations](#deployment-and-operations)
17. [Roadmap](#roadmap)
18. [Glossary](#glossary)
19. [Verification status](#verification-status)
20. [Keeping this documentation true](#keeping-this-documentation-true)

---

## How to use this documentation

| You want to… | Read |
|---|---|
| Understand the whole system quickly | This file, sections 2 to 7 |
| Build or change the **backend** | [docs/design/BACKEND_DESIGN.md](docs/design/BACKEND_DESIGN.md): architecture, request flows, data model, full API contract, algorithms, every configuration option, how to extend |
| Build or change the **website** | [docs/design/WEBSITE_SPEC.md](docs/design/WEBSITE_SPEC.md): every page, every state, every string; and [docs/design/DESIGN_SYSTEM.md](docs/design/DESIGN_SYSTEM.md): colour, type, space, components, charts, accessibility |
| Operate, deploy, back up, troubleshoot | [docs/design/DEVOPS_RUNBOOK.md](docs/design/DEVOPS_RUNBOOK.md) |
| Understand health, metrics, logs, alerts, dashboards | [docs/design/OBSERVABILITY.md](docs/design/OBSERVABILITY.md) |
| Rebuild the product from scratch | All five deep dives plus the sections below; together they are meant to be enough |

| Document | Owns |
|---|---|
| `DOCUMENTATION.md` (this file) | Purpose, architecture overview, repository map, decisions, requirements traceability, security, scaling, CI/CD set-up, testing, roadmap, glossary, verification status |
| `docs/design/BACKEND_DESIGN.md` | Server design and the API contract |
| `docs/design/WEBSITE_SPEC.md` | Website specification |
| `docs/design/DESIGN_SYSTEM.md` | Visual design system |
| `docs/design/OBSERVABILITY.md` | Health model, metric catalogue, alert rules, dashboard |
| `docs/design/DEVOPS_RUNBOOK.md` | Environments, pipeline operation, server set-up, deploy and rollback, backup, HTTPS, troubleshooting, Kubernetes |
| `README.md` | Short entry point |

## Purpose and scope

URLPulse does two jobs that belong together:

1. **Shortens links.** Paste a long URL, get a short one (random 7-character code, or a custom alias), optionally with an expiry date and a QR code. No account.
2. **Watches them.** For any link you can switch on an uptime check: the server visits the destination on a schedule and shows a heartbeat of passed and failed checks, so you find out when the page behind a short link stops working. Click analytics (browsers, systems, devices, referrers, per day) are included.

It is also a **DevOps capstone**: the project demonstrates containerisation, a CI/CD pipeline with security gates, infrastructure as code, observability and operational runbooks around a real application, and it ships a polished website to show it off.

**In scope:** the application, its website, the container and Compose stack, the pipeline, monitoring, a Render deployment of the app, optional Kubernetes manifests (statically checked only), scripts for deploy/backup/test, and all documentation.

**Out of scope (deliberate):** user accounts, teams or billing; editing a link's destination after creation (create a new link instead); multi-region deployment; exact click counting (counts are eventually consistent, see [Known limitations](#known-limitations)).

**Who it is for:** a developer or student who needs a working, understandable reference implementation and an operator who needs to run it. The tone throughout is "enough to rebuild it", not marketing.

## Quickstart

Three ways in, from least to most infrastructure.

**1. No Docker, no database (fastest).** Needs Node 22 or newer.

```bash
npm ci
npm run dev                # http://localhost:5000
```

With no `MONGO_URI` and no Redis URL set, the app keeps everything in memory. It is the full application (including uptime checks), but data is lost when it stops.

**2. The whole stack in Docker.**

```bash
make up                    # creates .env with generated secrets, builds the image, starts six containers
# Website      http://localhost:8082   (HTTP_PORT changes it)
# Grafana      http://localhost:3001   (login printed once by `make init`)
# Prometheus   http://localhost:9090
make smoke                 # end-to-end check of a running stack
make down                  # stop, keep data     |   make reset   # stop and delete data
```

**3. Production.** Follow [DEVOPS_RUNBOOK.md, section 5](docs/design/DEVOPS_RUNBOOK.md#5-first-time-server-setup); after that, pushing to `main` deploys.

**Verify your checkout:** `npm run lint && npm test` (175 tests, about 2 seconds, no services needed).

`make` lists every shortcut.

## Architecture

### Runtime view

```
                         ┌────────────────────────────────────────────────────────────┐
  Browser ──HTTP──▶ nginx│  rate limit 30 r/s per IP · sets X-Forwarded-For/Request-Id │
                         └──────────────────────────────┬─────────────────────────────┘
                                                        ▼
                         ┌────────────────────────────────────────────────────────────┐
                         │ URLPulse app (Node, Express)                                 │
                         │  website (static) · REST API · GET /:code redirect           │
                         │  /livez · /health · /metrics                                 │
                         │  ClickBuffer (write-behind)   MonitorScheduler (leases)      │
                         └───────┬──────────────────────┬──────────────────┬───────────┘
                                 ▼                      ▼                  ▼
                       Redis (cache only)        MongoDB (source of     Destination URLs
                       url:<code> → {u,e}        truth: links, clicks)  (HEAD probes)

   Prometheus ──scrapes /metrics every 15 s──▶ app          Grafana ──queries──▶ Prometheus
```

Compose networks: `edge` (nginx, app, Prometheus, Grafana) and `data` (`internal: true`: app, MongoDB, Redis). Nothing but nginx is published to the world; Prometheus and Grafana bind to `127.0.0.1`.

**Deployment shapes.** The diagram is the Docker Compose stack (six services), which is the primary demo and the full system. The public demo on Render is smaller: one Docker web service running the same app, with MongoDB Atlas as the database, the in-process memory cache instead of Redis (`CACHE=memory`; it starts empty after each restart and is not shared), and Render's own HTTPS edge and proxy in place of nginx (so there is no nginx request limit there and the app's own rate limits are the only per-IP limits). Prometheus and Grafana run only in Compose and are not deployed to Render. Kubernetes manifests exist as an optional extra and have not been deployed.

### Components

| Component | Responsibility | Technology |
|---|---|---|
| **nginx** | Only public entry; burst/abuse limiting; request id; hides `/metrics` | `nginx-unprivileged` |
| **App** | Website, API, redirect, health, metrics, background workers | Node 24 (image), Express 5, CommonJS, no TypeScript |
| **MongoDB** | Source of truth: links, click events, monitor state | MongoDB 8 via Mongoose 9 |
| **Redis** | Cache of resolved links, including "no such link" markers. Losing it costs speed, never data | Redis 7, ioredis |
| **Prometheus** | Scrapes `/metrics`, evaluates alert rules | Prometheus 3.5 |
| **Grafana** | Provisioned dashboard (24 panels) | Grafana 12.1 |

### Layering inside the app

`routes` (HTTP only) call `services` (business rules), which call `adapters` (MongoDB, Redis, memory) through small interfaces. `container.js` is the **composition root**: the one place that reads configuration and decides which adapter implements each interface. Swap an adapter and nothing above it changes, which is also why tests and `npm run dev` need no containers. Details: [BACKEND_DESIGN.md, section 2](docs/design/BACKEND_DESIGN.md#2-architecture).

### The four flows that matter

**Redirect (the hot path), `GET /:code`.** Normalise and validate the code, then look it up in the cache. A hit returns immediately; a miss reads MongoDB and fills the cache (24 hours, never longer than the link's own expiry). Unknown codes are cached as a negative marker for 60 seconds so scans for random codes do not reach the database. The click is **queued in memory**, never written inline, and the response is a `302` with `Cache-Control: no-store`. An expired link answers `410`. Redirects keep working with Redis down (they read MongoDB), and nothing about a redirect waits on analytics.

**Create, `POST /api/url/shorten`.** Validate the URL (scheme, length, no credentials, no private or internal host, not a loop back to URLPulse) and optional alias (3 to 30 letters, digits or hyphens, not a reserved word), generate a random base-62 code with up to 6 collision retries, store the link with the SHA-256 of a freshly generated management key, and return the key **once**.

**Click recording.** The `ClickBuffer` collects events and writes them in batches: every 2 seconds or at 500 events, whichever comes first, as one `insertMany` plus one `$inc` per link. If MongoDB fails, the batch goes back on the queue and is retried; the queue holds at most 20,000 events (oldest dropped, and counted in a metric); the buffer is flushed on shutdown. Per click, the IP is salted and hashed, the referrer is reduced to its origin, and the user agent is reduced to browser, system and device.

**Uptime monitoring.** A scheduler wakes every 30 seconds and claims due links one at a time with an atomic `findOneAndUpdate` that pushes `nextCheckAt` forward by a *lease*. Two replicas cannot claim the same link, and a replica that dies mid-probe simply lets the lease expire. The probe sends `HEAD` (falling back to a one-byte ranged `GET` when the server rejects `HEAD`), never follows redirects, resolves DNS first and refuses to connect unless **every** address is public. One failed check is `degraded`, two in a row is `down`, one success resets to `up`; the last 48 results are kept as the heartbeat.

### Data model (summary)

| Store | Shape | Notes |
|---|---|---|
| MongoDB `urls` | `shortCode` (unique), `originalUrl`, `customAlias`, `clickCount`, `expiresAt`, `manageTokenHash`, `createdAt`, `updatedAt`, and `monitor{enabled, intervalSec, nextCheckAt, lastCheckedAt, lastStatus, lastLatencyMs, lastOk, lastError, consecutiveFailures, checks, successes, history[48]}` | Partial index `monitor_due` over monitored links makes the scheduler's query cheap |
| MongoDB `click_logs` | `shortCode`, `timestamp`, `ipHash`, `userAgent` (truncated), `referrer` (origin only), `browser`, `os`, `device` | Index `code_time` for analytics; TTL index `click_ttl` deletes documents after 90 days |
| Redis | `url:<code>` → `{"u": destination, "e": expiry or null}`, or the marker `0` | Cache only; TTL 24 h (or less), negative 60 s |
| Memory mode | The same interfaces, in process | Development and tests only |

Complete field lists and indexes: [BACKEND_DESIGN.md, section 4](docs/design/BACKEND_DESIGN.md#4-data-model).

### Health model

| Endpoint | Meaning | Answer |
|---|---|---|
| `/livez` | The process is alive; touches no dependency | always `200` |
| `/health` | Can the service do its job? | `UP` 200; `DEGRADED` 200 (Redis down, redirects slower); `DOWN` 503 (MongoDB down); `DRAINING` 503 (shutting down) |
| `/metrics` | Prometheus exposition | Optional bearer token; not exposed by nginx |

Docker's `HEALTHCHECK` and the Compose health checks use `/health` (a degraded service still counts as healthy: it still serves). Kubernetes uses `/livez` for liveness and `/health` for readiness, so a Redis outage never restarts pods. The status page is the same model rendered for people.

## Repository map

```
urlpulse/
├── DOCUMENTATION.md            this file (master)
├── README.md                   short entry point
├── package.json  package-lock.json  eslint.config.js  jest.config.js  jest.e2e.config.js
├── Dockerfile  .dockerignore   multi-stage, non-root, read-only-friendly image
├── docker-compose.yml          base stack: nginx, app, mongo, redis, prometheus, grafana
├── docker-compose.override.yml development additions (auto-loaded)
├── docker-compose.prod.yml     production additions (image from registry, resource limits)
├── Makefile                    shortcuts (run `make`)
├── .env.example                every operator-facing setting
├── src/
│   ├── server.js               process entry: start, signals, graceful shutdown
│   ├── app.js                  Express app: middleware order, routes, error handling
│   ├── container.js            composition root
│   ├── config/                 loadConfig(env), logger
│   ├── routes/                 api.js, redirect.js, system.js
│   ├── services/               linkService, analyticsService, clickBuffer, monitorService,
│   │                           probe, healthService, statsService, linkView
│   ├── adapters/               mongo/ (models, index), memory/ (repositories), cache/ (redis, memory)
│   ├── middleware/             rateLimiter, errorHandler
│   ├── metrics/                Prometheus registry and metric definitions
│   └── lib/                    validators, crypto, network (SSRF), base62, userAgent, errors
├── public/                     the website (plain HTML, CSS, ES modules; no build step)
│   ├── index.html  dashboard.html  status.html  404.html  expired.html
│   └── assets/                 css/  js/  fonts/  img/
├── tests/                      unit/  integration/  e2e/  helpers/
├── nginx/conf.d/               default.conf, tls.conf.example
├── monitoring/                 prometheus/ (config, alert rules)  grafana/ (provisioning, dashboard JSON)
├── k8s/                        Kubernetes manifests (kustomize)
├── scripts/                    init-env, deploy, backup-mongo, restore-mongo, smoke-test, load-test, ui-check, healthcheck
├── .github/                    workflows/ci-cd.yml, workflows/codeql.yml, dependabot.yml
└── docs/                       design/ (the five deep-dive documents) and screenshots/ (reference renders)
```

## Requirements traceability

The left column is the requirement list recorded from your original `PROJECT_DOCUMENTATION.md` plus the instructions you gave with it. The original file is not stored in this repository; if it contained something that is not listed, add a row here.

| Requirement | Delivered | Where |
|---|---|---|
| Node.js and Express backend (not TypeScript) | Express 5 on Node, CommonJS, no TypeScript anywhere | `src/` |
| MongoDB for persistence | Mongoose 9 adapter; unique and partial indexes; TTL index for clicks | `src/adapters/mongo/` |
| Redis cache | Cache-aside with negative caching; fail-safe (a Redis outage degrades speed only); 500 ms command timeout | `src/adapters/cache/redisCache.js` |
| URL shortening with custom aliases | `POST /api/url/shorten`, alias rules, live availability check, reserved words | `src/services/linkService.js`, `src/lib/validators.js` |
| Click analytics | Write-behind recording; per-day, browser, system, device, referrer; recent clicks; dashboard page | `src/services/analyticsService.js`, `public/dashboard.html` |
| Uptime monitoring (from the project title) | Per-link checks with heartbeat, status model, SSRF-safe probes | `src/services/monitorService.js`, `probe.js` |
| Rate limiting, 100 requests per 15 minutes | Write bucket **100 per 15 min per IP** as specified, plus a separate read bucket of 600 so the website's polling is never throttled; nginx adds burst protection | `src/middleware/rateLimiter.js`, `nginx/conf.d/default.conf` |
| Health endpoint | `/health` (UP, DEGRADED, DOWN, DRAINING) and `/livez` | `src/routes/system.js`, `src/services/healthService.js` |
| Docker and Docker Compose | Multi-stage non-root image; six-service Compose stack with health checks, two networks, dev and prod variants | `Dockerfile`, `docker-compose*.yml` |
| GitHub Actions CI/CD | Test (Node 22 and 24), image build, scan and smoke test, publish, optional deploy with rollback; CodeQL; Dependabot | `.github/` |
| Trivy scan that fails on CRITICAL | Image scan with `severity: CRITICAL`, `exit-code: 1`, `ignore-unfixed: true`; plus an advisory repository scan | `.github/workflows/ci-cd.yml` |
| Publish to Docker Hub | Multi-arch image, tags `sha-<7>`, `latest`, semver; provenance and SBOM attached | `publish` job |
| Prometheus and Grafana | `/metrics`, 13 alert rules, auto-provisioned dashboard | `monitoring/` |
| "Create a complete project structure and build the full project" | This repository | all |
| "Add your own things to make it more efficient and usable" | See the next table | |
| "Maintain full documentation… the only source of truth" | This file and `docs/design/` | |
| "Build the website professionally… UI/UX most important… something great to showcase" | Three-page site on a purpose-built design system ("ECG paper"), light and dark | `public/`, [Website](#website) |
| "Design documentation for each thing… everything I need to build and develop this product" | Five deep dives | `docs/design/` |
| "DevOps concepts and implementations must be included" | Containers, IaC (Compose, Kubernetes), CI/CD with security gates, supply-chain attestations, observability, runbooks, rollback, backups, smoke and load tests | throughout |

**Deliberate differences from the original brief**

| Brief | Built | Why |
|---|---|---|
| Node 20 | Node 24 in the image; tested on 22 and 24; `engines` is `>=22` | Node 20 reached end of life in April 2026 |
| Container health check with a shell tool | `node scripts/healthcheck.js` | No extra package in the image; one fewer thing to scan |
| One health endpoint | `/livez` and `/health` | Liveness must not depend on databases, or a database outage restarts healthy pods |
| Needs MongoDB and Redis to run | Also runs with neither (memory mode) | Zero-setup development and fast tests |
| Fail the build on CRITICAL | Fail on CRITICAL **that has a fix** (`ignore-unfixed`) | A vulnerability nobody can fix yet would block every build for no benefit; unfixed findings are still shown in the advisory scan |
| 100 requests per 15 minutes | 100 for writes, 600 for reads | A dashboard that polls would otherwise exhaust the 100 in minutes |

**What was added beyond the brief**

| Addition | Why it is worth having |
|---|---|
| Management key instead of accounts | Control over a link without sign-up; stored only as a hash |
| Link expiry, QR codes | Usable links for slides and print |
| SSRF protection, reserved aliases, loop and credential rejection | Safe by default |
| Write-behind click buffer | Redirect latency independent of the database |
| Replica-safe monitor leases | Scale to several instances without a queue service |
| `/livez`, DRAINING state, graceful shutdown | Zero-surprise restarts and rollouts |
| Public status page | The product shows its own health honestly |
| Deploy script with automatic rollback; backup and restore scripts | Operations, not just build |
| Kubernetes manifests, CodeQL, Dependabot | Reach beyond a single host; supply-chain hygiene |
| Smoke test, load test, browser check scripts | The same checks in CI, locally and in production |
| Design system and five specification documents | Maintainable and reusable |

## Decision log

| # | Decision | Alternatives considered | Reason |
|---|---|---|---|
| 1 | Express 5 on Node, CommonJS, no TypeScript | NestJS, Fastify, TypeScript | The brief asked for Node and not TypeScript; Express is the most widely understood choice for a teaching and showcase project; CommonJS keeps the runtime simple |
| 2 | MongoDB for links and clicks | PostgreSQL | Matches the brief; documents fit a link with an embedded monitor state and a bounded history; TTL indexes expire clicks for free |
| 3 | Redis is a cache, never a store | Redis as primary for hot data | Losing it must cost speed only; keeps recovery trivial |
| 4 | `302` redirect with `no-store` | `301` | A permanent redirect is cached by browsers, so clicks would stop reaching the server and deleted or expired links would keep working |
| 5 | Management key, no accounts | Login, OAuth | The simplest model that still protects delete and monitor changes; hash-only storage means a database leak reveals no usable keys |
| 6 | Write-behind click buffer | Insert per click; message queue | Keeps the redirect off the database path; a queue service would be disproportionate |
| 7 | Lease-based scheduler in the database | cron container; external queue; one designated scheduler | Replica-safe with no extra infrastructure; a crashed replica heals by itself |
| 8 | Probe with `HEAD`, no redirect following, DNS check of every address | Full `GET`, follow redirects | Cheap, and no path for the probe to be steered at an internal network |
| 9 | Memory adapters behind the same interfaces | Mocks only | The real application runs with zero setup, and integration tests exercise real code |
| 10 | Two health endpoints | One | See "deliberate differences" |
| 11 | nginx in front of the app | App on the public port | Burst limiting, request ids, hides `/metrics`, a place for TLS |
| 12 | `data` network is `internal` | One flat network | Databases are unreachable from anywhere but the app, whatever the host firewall says |
| 13 | Compose for the single-host deployment, Kubernetes manifests as the scale-out path | Only one of them | Compose is what most reviewers can run in a minute; Kubernetes shows rolling updates and probes |
| 14 | Deploy the immutable `sha-<commit>` tag, never `latest` | `latest` | Reproducible and rollback is "run the previous tag" |
| 15 | Image scan gate on CRITICAL with a fix | HIGH and above | A gate that fails on every build gets disabled; critical-with-fix is actionable |
| 16 | Plain HTML, CSS and ES modules for the site; no framework or build | React, Vue, a bundler | Three screens; CSP forbids inline code anyway; nothing to build, maintain or scan |
| 17 | Self-hosted fonts, no third-party requests | Google Fonts | The CSP is `'self'` only, and visitors' IPs are not shared with a font host |
| 18 | One accent colour (violet) for data and links; status colours reserved | Multi-colour charts | Colour carries meaning; see the design system |
| 19 | Prometheus metrics with route-pattern labels | Raw paths | Keeps label cardinality bounded |
| 20 | Dashboards and datasources provisioned from files | Click-built dashboards | Reproducible and reviewable |

## API summary

The complete contract (request and response shapes, validation rules, examples) is in [BACKEND_DESIGN.md, section 5](docs/design/BACKEND_DESIGN.md#5-api-reference). In short:

| Method and path | Purpose | Auth |
|---|---|---|
| `POST /api/url/shorten` | Create a link: `originalUrl`, optional `customAlias`, `expiresInDays` (1 to 365) or `expiresAt`, `monitor`, `monitorIntervalSeconds` (30 to 86400). Returns `201` and the `manageToken` **once** | none |
| `GET /api/availability/:alias` | Is this alias free, taken or reserved? | none |
| `GET /api/url/:code` | Link details and monitor state | none |
| `GET /api/url/:code/qr` | QR code (`format`, `size` 128 to 1024, `download=1`) | none |
| `DELETE /api/url/:code` | Delete a link (`204`) | `X-Manage-Token` |
| `PATCH /api/url/:code/monitor` | `{enabled, intervalSeconds}` | `X-Manage-Token` |
| `GET /api/analytics/:code?days=1..90` | Clicks per day, breakdowns, recent clicks | none |
| `GET /api/stats` | Service statistics for the website | none |
| `GET /:code` | `302` to the destination | none |
| `GET /livez`, `/health`, `/metrics` | Operations | `/metrics`: optional bearer token |

Errors share one envelope with a stable `code`: `VALIDATION_ERROR` 400, `INVALID_JSON` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `ALIAS_TAKEN` 409, `EXPIRED` 410, `PAYLOAD_TOO_LARGE` 413, `RATE_LIMITED` 429, `INTERNAL` 500, `CODE_GENERATION_FAILED` 503. Rate limits are per client IP and use the standard `RateLimit` headers: 100 writes and 600 reads per 15 minutes on `/api`, and 600 requests per minute on the public routes (redirects, pages and the 404 page; static assets, `/livez`, `/health` and `/metrics` are not counted).

## Configuration summary

All configuration is environment variables, read once at start-up into a frozen object; invalid values stop the start with a clear message. The complete table (about 40 settings with defaults) is [BACKEND_DESIGN.md, section 7](docs/design/BACKEND_DESIGN.md#7-configuration-reference); the operator-facing subset is `.env.example`, explained in [DEVOPS_RUNBOOK.md, section 2](docs/design/DEVOPS_RUNBOOK.md#2-configuration-and-secrets).

The ones that matter most: `MONGO_URI` and `REDIS_URL` (absent means memory mode), `BASE_URL` (public address for short links), `TRUST_PROXY` (how many proxies sit in front; wrong values break rate limiting and IP hashing), `HASH_SALT` (**required, 16+ characters, in production**), `RATE_LIMIT_MAX`, `READ_RATE_LIMIT_MAX` and `PUBLIC_RATE_LIMIT_MAX` (write, read and public-route limits), `CORS_ORIGIN` (off by default; explicit origins only, `*` is refused at start-up), `METRICS_TOKEN`.

## Security

### Threat model in one table

| Threat | Mitigation | Where |
|---|---|---|
| **SSRF** through the uptime probe (making the server call internal addresses or cloud metadata) | Creation-time rejection of private, loopback, link-local and metadata hosts (including decimal and hex IP forms, and IPv6 forms that embed an IPv4 address: IPv4-mapped, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4 `2002::/16`, IPv4-compatible `::/96`, which are judged by the embedded address). At probe time the hostname is resolved and **every** returned address must be public. Redirects are not followed. The body is never read. This covers the known cases; it is not a claim that every special-purpose range is covered | `src/lib/network.js`, `probe.js` |
| Abuse of the redirect or API | Per-IP rate limits in the app: 100 writes and 600 reads per 15 min on `/api`, and 600 requests per minute on the public routes (redirects, pages, the 404 page; not static assets, `/livez`, `/health` or `/metrics`, so health checks and scraping are never throttled); in Compose, nginx adds `30 r/s`, burst 60; request bodies limited to 16 KB at nginx and 10 KB of JSON in the app. The app-level limits are the only per-IP limits on Render, which has no nginx | `rateLimiter.js`, `nginx` |
| Cross-origin use of the API from other sites | CORS is off by default. `CORS_ORIGIN` accepts only an explicit comma-separated list; `*` makes the app refuse to start. No credentials are allowed cross-origin (the API uses a header token, not cookies) | `config/index.js`, `app.js` |
| Takeover of someone else's link | Delete and monitor changes need the management key: 24 random bytes, only the SHA-256 stored, compared in constant time, sent in a header (never a URL), redacted from logs | `src/lib/crypto.js` |
| Open redirect, phishing loops, credential links | Only `http` and `https`; URLs with embedded credentials rejected; links back to URLPulse itself rejected; length limit | `validators.js` |
| Path shadowing (a short code taking over `/dashboard` or `/assets`) | Reserved words cannot be aliases; anything with a dot is never a code | `validators.js` |
| Cross-site scripting | Content Security Policy `default-src 'self'` with **no inline script or style**; the front end builds DOM with `createElement` and text nodes and never inserts server data as markup (its one `innerHTML` use is a table of constant icon strings); helmet defaults | `app.js`, `public/assets/js/core.js` |
| Tracking people | IP addresses are salted and hashed before storage (the salt is required in production); referrers are cut to their origin; click records expire after 90 days; the site sets no cookies | `crypto.js`, TTL index |
| Secrets leaking | `.env` is git-ignored; Compose refuses to start without required secrets; logs redact `Authorization`, `Cookie` and `X-Manage-Token`; Trivy scans the repository for committed secrets; secrets are never baked into the image | `.gitignore`, compose, pino config |
| Container breakout and privilege | Non-root user, read-only root filesystem, all capabilities dropped, `no-new-privileges`, npm, npx, yarn and corepack removed from the runtime image, OS packages upgraded at build time | `Dockerfile`, compose |
| Lateral movement | Databases on an `internal` network; Kubernetes network policies; Pod Security `baseline` enforced | compose, `k8s/` |
| Vulnerable dependencies and images | Trivy image gate (fails on fixable CRITICAL), `npm audit`, CodeQL weekly and on every push, Dependabot for npm, Docker and Actions | `.github/` |
| Supply-chain tampering | Immutable `sha-` tags deployed; provenance attestation and SBOM attached to published images; pinned host key for deploys | `ci-cd.yml` |
| Metrics disclosure | `/metrics` is blocked at nginx; optional bearer token; Prometheus and Grafana on loopback | nginx, compose |

### Known limitations

These are real, accepted trade-offs. They are listed so nobody has to discover them.

1. **DNS rebinding gap in probes.** The probe resolves a hostname and checks the addresses, then the HTTP client resolves it again when connecting. A hostile DNS server could answer differently the second time. Closing it needs the probe to connect to the checked address directly. This is on the roadmap.
2. **Management keys live in the browser's `localStorage`.** Any script running on the site's origin could read them, which is why the CSP forbids inline code and the front end never inserts server data as markup. Clearing site data loses the keys, and there is no recovery: a lost key means the link can no longer be deleted or have its monitor changed (it can still expire).
3. **Anyone who knows a short code can read its aggregate statistics** (clicks, breakdowns, uptime). No personal data or IP addresses are exposed, but codes are not secret. The management key protects changes, not viewing.
4. **Click counts are eventually consistent and best effort.** Events are queued in memory: a process crash can lose up to about two seconds of clicks; under a sustained database outage the queue caps at 20,000 events and drops the oldest (counted by `urlpulse_clicks_dropped_total`). Bots and link previews are recorded and labelled "Bot" rather than excluded.
5. **The rate limiter is per process and in memory.** With several replicas the effective limit is up to the replica count times higher, until the limiter uses a shared Redis store (roadmap). Counters reset when the process restarts (on Render, also after every sleep). Limits are keyed on the address Express reports, so they depend on `TRUST_PROXY` being right (known limitation 9).
6. **Metrics are per process.** Prometheus scrapes each replica; aggregate with `sum()`. The cache figures on `/api/stats` describe the replica that answered.
7. **The application connects to MongoDB as the root user** created by the Compose file. A least-privilege user is on the roadmap.
8. **nginx's access log records client IP addresses** (the application's own logs do not). Rotate or disable it if that matters for your jurisdiction.
9. **TLS is not on by default.** The stack speaks HTTP until you add HTTPS (runbook section 8). A proxy in front of the bundled nginx needs real-IP configuration, or all visitors look like one address. On Render, HTTPS is provided by Render's edge; the service is configured with `TRUST_PROXY=1`, but **whether the app then sees each visitor's own address has not been verified** (the application logs do not record client addresses). Until it is, treat per-IP rate limiting on Render as unconfirmed. [DEVOPS_RUNBOOK.md, section 13.3](docs/design/DEVOPS_RUNBOOK.md#133-confirm-client-ip-detection-trust_proxy) gives a safe way to check it.
10. **Single-host deployments have a few seconds of downtime per deploy** (one app container is replaced). Kubernetes avoids this.
11. **No Alertmanager.** Alert rules fire inside Prometheus, but nothing is sent anywhere.
12. **A short link's destination cannot be edited**, by design.
13. **Charts are not keyboard-focusable per mark.** Their data is available as a table, and tooltips are pointer-only. Listed under the roadmap.
14. **No bundled capacity figures.** Nothing here claims requests per second; run `make load` on your hardware.
15. **Free-tier hosting limits (Render).** The service sleeps after about 15 minutes without inbound requests, and uptime checks only run while it is awake; the first request after a sleep is slow; the memory cache and rate-limit counters start empty after every restart; the free instance has little memory, so very large bursts of work are not a goal.

## Scaling

**What is already scale-friendly.** The app keeps no durable state: MongoDB and Redis hold everything shared. The redirect path is cache-first, and clicks are batched so write volume grows with batches, not with traffic. The monitor scheduler is replica-safe by construction (atomic leases). Health, readiness, graceful shutdown (stop accepting, drain, flush clicks, then exit) and a `DRAINING` state make rolling updates safe. Kubernetes manifests include a horizontal autoscaler (2 to 6 replicas at 70% CPU), a pod disruption budget, and rolling updates with zero unavailable pods.

**What is per process** (and what to do about it):

| State | Effect with N replicas | Remedy |
|---|---|---|
| Rate limit counters | Limit is up to N times higher | Switch the limiter to a Redis store (`rate-limit-redis`); the code is structured so this is a one-place change |
| Click buffer | Each replica flushes its own | Nothing to do; flushed on shutdown |
| Metrics | One series per replica | Aggregate in queries; use service discovery for scrape targets |
| `/api/stats` caches | Describes the answering replica | Accept, or compute from Prometheus |

**Where the first bottleneck will be, in order:** the app's CPU on the redirect path (add replicas); Redis memory (it is capped at 128 MB with LRU eviction, so it degrades gracefully; raise it); MongoDB writes (clicks are batched; add `CLICK_BATCH_SIZE`; then a replica set); MongoDB storage (the 90-day TTL bounds clicks; lower `CLICK_RETENTION_DAYS`).

**Code space.** Random 7-character base-62 codes give about 3.5 trillion values; a collision is retried up to six times, after which creation answers `503 CODE_GENERATION_FAILED`. Raise `CODE_LENGTH` long before that matters.

**Growth path, cheapest first:** raise container limits; add replicas behind the load balancer (and move the rate limiter to Redis); managed MongoDB (a replica set) and managed Redis; Prometheus service discovery; a CDN is of limited use because redirects are `302` with `no-store` by design. Multi-region is a non-goal.

## Observability

Three signals, one correlation key.

- **Health:** `/livez`, `/health`, the status page, container and pod probes (see [Health model](#health-model)).
- **Metrics:** `/metrics` in Prometheus format. HTTP request count and latency by route pattern; cache hits and misses; redirects by outcome; links created, deleted, monitored, down; clicks recorded, dropped, queued; flush failures; probe results and duration; dependency up/down for MongoDB and Redis; build info; default Node runtime metrics. Full catalogue with meanings: [OBSERVABILITY.md, section 3](docs/design/OBSERVABILITY.md#3-metrics).
- **Logs:** structured JSON from the app (pino) and nginx; every line carries a `request_id` that nginx generates and returns as `X-Request-Id`, so one request can be followed across both.
- **Alerts:** 13 rules in `monitoring/prometheus/alert_rules.yml`: service down, database down, cache down, restart loop, high error rate, high latency, event-loop lag, high memory, heavy rate limiting, low cache hit ratio, click buffer backing up, click flush failing, clicks dropped. Meanings and first actions: [OBSERVABILITY.md, section 6](docs/design/OBSERVABILITY.md#6-alerts).
- **Dashboard:** Grafana "URLPulse" (24 panels in six rows) is provisioned automatically.
- **Suggested objectives:** availability and redirect latency targets with the queries to track them are in [OBSERVABILITY.md, section 8](docs/design/OBSERVABILITY.md#8-service-level-objectives).

## CI/CD

The pipeline is `.github/workflows/ci-cd.yml`; the operating guide, secrets table and failure-reading table are in [DEVOPS_RUNBOOK.md, section 4](docs/design/DEVOPS_RUNBOOK.md#4-the-pipeline). Overview:

```
 push / pull request                         push to main or v*.*.* tag             main only, opt-in
┌──────────────────────┐   ┌──────────────────────────────┐   ┌───────────────┐   ┌────────────────────┐
│ test                 │──▶│ image                        │──▶│ publish       │──▶│ deploy             │
│ lint · unit · integr.│   │ build · Trivy (fail CRITICAL)│   │ multi-arch    │   │ SSH · pull · health│
│ e2e (Mongo+Redis) ·  │   │ repo scan (advisory) · run   │   │ push to       │   │ wait · rollback ·  │
│ npm audit · Node     │   │ container · smoke test       │   │ Docker Hub    │   │ public smoke test  │
│ 22 and 24            │   │                              │   │ + SBOM, prov. │   │                    │
└──────────────────────┘   └──────────────────────────────┘   └───────────────┘   └────────────────────┘
```

Alongside: **CodeQL** (JavaScript, on push, pull request and weekly) and **Dependabot** (npm, Docker, GitHub Actions).

**Gates.** A pull request cannot merge green unless lint, all tests (with coverage thresholds of 85% statements, 75% branches, 85% functions, 85% lines), the end-to-end tests against real MongoDB and Redis, and the container smoke test pass, and the image has no fixable critical vulnerability. Publishing and deploying only happen from `main`, after the same gates.

**Secrets and variables** (Settings, Secrets and variables, Actions):

| Kind | Name | Required for |
|---|---|---|
| Secret | `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` | Publishing. Without them the publish job warns and skips |
| Secret | `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` | Deploying |
| Variable | `DEPLOY_ENABLED=true`, `DEPLOY_PATH`, `PUBLIC_URL` | Deploying |
| Variable | `ENABLE_CODE_SCANNING=true` | Uploading Trivy results to the Security tab (public repository or GitHub Code Security) |

**Image tags:** `sha-<7>` always; `latest` from `main`; `X.Y.Z` and `X.Y` from a `vX.Y.Z` tag. Production runs the `sha-` tag.

**Action versions** were looked up in each action's own repository at build time (November 2026): `actions/checkout@v7`, `actions/setup-node@v7`, `docker/setup-buildx-action@v4`, `docker/build-push-action@v7`, `docker/login-action@v4`, `docker/setup-qemu-action@v4`, `aquasecurity/trivy-action@v0.36.0`, `github/codeql-action/{init,analyze,upload-sarif}@v4`. Dependabot keeps them current. For stricter supply-chain hygiene, pin them to commit SHAs.

**Status.** The workflow has run on GitHub. The run for commit `cf8d186` (2026-11-17) passed lint and tests on Node 22 and 24, the end-to-end tests against the MongoDB and Redis service containers, the dependency audit, the image build, both Trivy scans, the container smoke test and the publish to Docker Hub (read from the GitHub Actions API on 2026-11-20). The `deploy` job was skipped, because `DEPLOY_ENABLED` is not set; **the SSH deploy path has never run**. Earlier runs on 2026-11-17 failed and were fixed before that one. The run does not show what is inside Docker Hub (tags, digests, the multi-architecture manifest were not inspected). CodeQL also passed for that commit; the two alerts raised against it are covered under Security. See [Verification status](#verification-status).

**Render is deployed separately from this pipeline.** The public demo runs on Render, which builds the repository's `Dockerfile` itself, with Auto-Deploy set to "After CI Checks Pass" on `main`: Render deploys a commit only after the GitHub checks for it succeed. The SSH `deploy` job is an optional alternative for a self-managed server and is not what deploys Render.

## Testing and quality

| Layer | What | Count | Needs |
|---|---|---|---|
| Unit | Validators, crypto, SSRF rules, user agent, base-62 codes, config, memory cache, and the services: links, click buffer, probe, monitor, analytics | 126 | nothing |
| Integration | The real Express app over HTTP (Supertest): creating links, the redirect, management keys, uptime monitoring over HTTP, health endpoints, metrics, stats, security headers and hardening, the static site, public-route rate limiting, CORS | 49 | nothing (memory mode) |
| End-to-end | The Redis adapter; the full stack against real MongoDB (links, clicks, monitor leases, TTL and partial indexes) | 3 and 5 | `REDIS_URL`, `MONGO_URI`; skipped when unset |
| Smoke | Create, redirect, read, reject without key, delete, verify, metrics, against any base URL | 14 checks | a running app |
| Load | Redirect path: p50, p95, p99, errors | n/a | a running app |
| Browser | The real pages at phone width in light and dark: layout, create flow, dashboard, all five status headlines, errors | 60 checks | running app, Playwright |

Commands: `npm test` (unit and integration), `npm run test:coverage` (what CI enforces), `npm run test:e2e`, `make smoke`, `make load`, `make ui-check`. Lint: `npm run lint` (ESLint 10, flat config; browser code is linted as modules with browser globals).

Last run (2026-11-20, Node 24.22.3): 175 unit and integration tests pass (126 unit, 49 integration); coverage is 93.15% statements, 86.21% branches, 89.54% functions and 95.49% lines, against the CI thresholds. Counts and coverage change with every commit: re-run `npm run test:coverage` rather than trusting this line.

**Testing philosophy.** Tests run the real application with in-memory adapters, so they exercise the same routes, services and middleware production uses; the swappable adapter boundary is also where real-service e2e tests plug in. Anything that touches time, randomness or the network is injected, so tests are deterministic.

## Website

Full specification: [WEBSITE_SPEC.md](docs/design/WEBSITE_SPEC.md) (every page, state and string) and [DESIGN_SYSTEM.md](docs/design/DESIGN_SYSTEM.md) (every token and component). The plan in brief:

**Goals.** Make a short link in ten seconds with no sign-up; show what happened to it and whether its destination is alive; show honestly whether the service is healthy; and look finished enough to showcase.

**Site map.**

| Page | Purpose |
|---|---|
| `/` Home | The shortener (URL, alias, expiry, uptime check) with an instant result, copy, QR and management key; what every link gets; how a redirect works with live numbers; the delivery pipeline |
| `/dashboard#<code>` | The user's links, with clicks per day, breakdowns, recent clicks and the destination heartbeat; look up any link by its code; owner controls (uptime switch, delete) when this browser holds the key |
| `/status` | Live health (UP, DEGRADED, DOWN, DRAINING, unreachable), a heartbeat of this browser's own checks, component ledger, deployment facts, cache ratio |
| `404` and `expired` | Honest, correctly status-coded error pages |

**Design concept: "ECG paper".** URLPulse watches whether links are alive, so the interface is a heart monitor's printout: rose-tinted graph paper, ink-dark type, one electric-violet trace. Three rules keep it honest: the trace is **data** (a beat is a passed check, a flat line with a cross is a failed one); colour has jobs (ink for text, violet for data and links, green, amber and red only for status, always with an icon and a word); and graph paper appears only where the service reports on itself.

| Element | Choice |
|---|---|
| Palette (light) | Paper `#fcf7f8`, ink `#1a1438`, pulse `#4b34e0`; status green `#0a7a0a`, amber `#8a5a00`, red `#c42b2b` as text |
| Palette (dark) | Paper `#0f0c1d`, ink `#efebfa`, pulse `#a597ff` |
| Type | Bricolage Grotesque (variable weight and width, headlines heavy and condensed) for everything; Martian Mono only for URLs and hashes; both self-hosted; scale 1.25 from 16 px |
| Shape | Radii follow hierarchy: 4, 8, 14 px, pill; hairlines instead of boxes; no gradients, shadows only on pop-ups |
| Charts | One series colour; thin marks with a rounded data end; hairline grid; tooltip on every mark; a "show as table" view for every chart; legend only with two or more series |
| Themes | Light and dark; follows the system, remembers a manual choice, applied before first paint |

**Quality bars (measured by script and in headless Chromium only: other browsers, screen readers, 320 px width and 200% zoom have not been tested).** Text and control contrast measured and passing WCAG AA (ink on paper 16.5:1; muted text at least 5:1; control borders at least 3:1); visible focus; skip link; reduced motion respected; native dialog and details; no horizontal scroll at 390 px; about 21 to 26 KB of HTML, CSS and JavaScript (gzip) per page plus a 78 KB font; no third-party requests; no cookies.

**How it is built.** Plain HTML, hand-written CSS with design tokens, native ES modules; no framework and no build step. DOM is created with a small `h()` helper and text nodes, so server data can never become markup. Browser storage holds only the links created in this browser (with their management keys) and the theme choice.

## Deployment and operations

Everything operational is in [DEVOPS_RUNBOOK.md](docs/design/DEVOPS_RUNBOOK.md). The shape of it:

- **Single host:** Docker Compose with the production override. The pipeline publishes an image; `scripts/deploy.sh` pulls it, restarts, waits for health, and **rolls back by itself** if the new version does not become healthy.
- **Backups:** `scripts/backup-mongo.sh` (compressed dump, keeps the newest 14) and `scripts/restore-mongo.sh`; schedule it and copy archives off the server.
- **HTTPS:** terminate in nginx (example config included) or in front of it; set `BASE_URL`.
- **Render (public demo):** one free Docker web service built from the repository, MongoDB Atlas for storage, in-memory cache, Render's own HTTPS. Set `BASE_URL`, `TRUST_PROXY=1` and the secrets in the Render dashboard. Prometheus and Grafana are not part of it. See [DEVOPS_RUNBOOK.md, section 13](docs/design/DEVOPS_RUNBOOK.md#13-render-deployment).
- **Kubernetes (optional, not deployed):** `kubectl apply -k k8s/` would give replicas and rolling updates. The manifests are statically checked only; no cluster has run them.
- **Day to day:** the Grafana dashboard, the Prometheus alert page, the status page and `make smoke`.

## Roadmap

Ordered roughly by value for effort.

1. **Alertmanager** with an email or chat receiver, so alerts reach a person.
2. **Shared rate limiting** (`rate-limit-redis`) so limits hold across replicas.
3. **Close the DNS rebinding gap** by connecting the probe to the address it validated.
4. **Least-privilege MongoDB user** for the application instead of root.
5. **Keyboard-focusable chart marks** with the tooltip on focus.
6. **Notification when a link goes down** (email or webhook) on top of the existing status model.
7. **Bot filtering option** for click statistics.
8. **Pin GitHub Actions to commit SHAs.**
9. **A smoke test on a schedule** against production, from outside, as a synthetic check.
10. **Optional features beyond the brief:** per-link analytics export, bulk creation, custom domains, API keys for programmatic use. None is needed for the current goals.

## Glossary

| Term | Meaning |
|---|---|
| **Short code** | The path of a short link: a random 7-character string or a custom alias |
| **Alias** | A short code the user chose (3 to 30 letters, digits, hyphens) |
| **Management key** | The secret returned once at creation, needed to delete a link or change its uptime check; stored only as a SHA-256 hash |
| **Cache-aside** | The app asks the cache first, and on a miss reads the database and fills the cache |
| **Negative cache** | Remembering "this code does not exist" for a short time to protect the database |
| **Write-behind** | Recording clicks in memory and writing them in batches later |
| **Lease** | A time-limited claim on a link's next check, stored in the database; makes the scheduler safe with several replicas |
| **Probe** | One uptime check of a destination |
| **Heartbeat** | The chart of recent probe results: a beat per pass, a flat line with a cross per failure |
| **Degraded** | For a link: one failed check. For the service: Redis is down but redirects still work |
| **Draining** | The server is shutting down and no longer accepting work |
| **SSRF** | Server-side request forgery: tricking a server into calling internal addresses |
| **TTL index** | A MongoDB index that deletes documents after a set time |
| **Composition root** | The single place where configuration decides which concrete parts are wired together |
| **Trivy** | A scanner for vulnerabilities, secrets and misconfiguration in images and repositories |
| **SBOM / provenance** | A bill of materials for an image, and a signed record of how it was built |
| **ECG paper** | The website's visual concept |

## Verification status

Dated 2026-11-20. Each row says how a claim was checked, so nothing is stronger than its evidence. Categories: **fresh** (run on 2026-11-20 for this update), **CI** (read from the GitHub Actions record), **observed** (read from the Render API and application logs on 2026-11-20), **historical** (checked on an earlier date and not repeated), **static** (read or parsed, not executed), **not tested**, **not implemented**.

### Freshly run on 2026-11-20 (Linux sandbox, Node 24.22.3, no MongoDB)

| Check | Result |
|---|---|
| ESLint, whole repository | clean |
| Unit and integration tests, `jest --coverage --runInBand` | 175 of 175 pass (6 suites). Statements 93.15%, branches 86.21%, functions 89.54%, lines 95.49% |
| New regression tests (public-route rate limit, CORS allowlist and wildcard, commit fallback, IPv6 transition ranges) | 14 of them fail against the previous source and pass now |
| Redis adapter end-to-end tests against a local Redis | 3 of 3 pass |
| Full-stack end-to-end suite against MongoDB (5 tests) | **skipped**: no MongoDB in the sandbox (CI runs it, see below) |
| `scripts/smoke-test.sh` with the metrics check, against the app in memory mode | 14 of 14 |
| `scripts/ui-check.js`, headless Chromium, 390 px, light and dark | 60 of 60 |
| `docker compose config` for the base file and for base plus production override | valid |
| Behaviour on a live local server: public path returns 429 with `RateLimit` headers after the limit while `/assets`, `/livez` return 200; `/health` reports the `RENDER_GIT_COMMIT` value; `CORS_ORIGIN='*'` stops start-up | as described |

### Verified by CI (GitHub Actions run for commit `cf8d186`, 2026-11-17, read on 2026-11-20)

| Check | Result |
|---|---|
| Lint, unit and integration tests with coverage thresholds, Node 22 and Node 24 | pass |
| End-to-end tests against real MongoDB and Redis service containers, Node 22 and Node 24 | pass (so the MongoDB adapter has run against a real server) |
| Dependency audit (fail on CRITICAL) | pass |
| Docker image build, Trivy image scan (fail on CRITICAL), Trivy repository scan (advisory), start container, smoke test the container | pass |
| Publish to Docker Hub (multi-architecture build and push) | job passed. The registry contents were not inspected |
| CodeQL for the same commit | passed; the two alerts it raised are described under Security |
| Deploy over SSH | **skipped** (`DEPLOY_ENABLED` not set); never run |

### Observed on Render (service `urlpulse`, 2026-11-20)

| Fact | Source |
|---|---|
| Docker runtime, free plan, region Oregon, branch `main`, health check path `/health`, Auto-Deploy on with trigger "After CI Checks Pass" | Render API |
| One deploy exists, live, commit `cf8d186` (first build, 2026-11-18) | Render API |
| Application logs show `storage: mongo`, `cache: memory`, monitoring on, production mode, the scheduler started, requests served | Render logs |
| Free-tier sleep and wake: the process receives SIGTERM about 15 minutes after the last request, drains, flushes and disconnects from MongoDB, and starts again on the next request | Render logs |
| Reported commit is `dev` (the image build bakes `BUILD_SHA=dev` in); fixed in this update, takes effect on the next deploy | Render logs |
| Data persists in MongoDB Atlas (`urls`, `click_logs`) | Atlas Data Explorer screenshots supplied by the owner, and `/health` reporting `mongo: connected` |

### Historical (checked on or before 2026-11-17, superseded by the fresh run where repeated)

153 tests with coverage 93.0 / 85.5 / 89.2 / 95.4 %, smoke 14 of 14, UI 60 of 60, Redis behaviour on a real Redis (cache key and TTL shape, negative marker, `DEGRADED` with HTTP 200 while Redis is stopped and recovery within seconds), every metric name used by the dashboard and the alert rules against live `/metrics` output, contrast ratios in the design system (computed by script), YAML parse of every Compose, Kubernetes, monitoring and workflow file, `bash -n` on every shell script.

### Statically inspected only

| Item | Note |
|---|---|
| Kubernetes manifests (`k8s/`) | Parsed; never applied to a cluster or schema-validated against one |
| nginx configuration and TLS option A | Read; `nginx -t` has not been run, TLS has not been tried |
| Prometheus rules (`promtool`) and the Grafana dashboard loaded in Grafana | Tools not run; metric names were checked against live output |
| `deploy.sh`, `backup-mongo.sh`, `restore-mongo.sh` | Syntax-checked; never run end to end |

### Not tested

| Item | Why it matters / how to check |
|---|---|
| Atlas database user permissions, Atlas Network Access list, Atlas region | Not readable from the session used for this update (Atlas API access was disabled for the account). Check in the Atlas console; do not assume least privilege |
| Render per-client IP detection with `TRUST_PROXY=1` | Application logs do not record client addresses. Use the procedure in the runbook, section 13.3 |
| Docker Hub tags, digests and the multi-arch manifest | Check the Docker Hub repository page, or run `docker buildx imagetools inspect <your-dockerhub-user>/urlpulse:latest` |
| Restoring a backup | Never run. Test a restore on a spare machine before relying on backups |
| The full Compose stack (`make up`, nginx, Prometheus, Grafana, alerts) | Not started in this session; the Compose files validate. Run `make up && make smoke` |
| Phone QR scan of a generated code; cross-browser (only Chromium) and assisted-technology testing; 320 px and 200% zoom | Manual checks |
| Live sleep and wake timing from a visitor's point of view | Seen only as server log lines |
| Alert delivery | There is no Alertmanager |

### Not implemented

Alertmanager (alerts are visible in Prometheus and go nowhere), shared Redis-backed rate limiting, Prometheus and Grafana on Render, a least-privilege MongoDB user for the Compose stack, closing the DNS-rebinding gap in probes, any claim that the SSRF rules are exhaustive.

## Keeping this documentation true

- **Change code, change docs in the same pull request.** A new setting goes in `.env.example` (if operator-facing) and BACKEND_DESIGN section 7; a new metric in OBSERVABILITY section 3 (and an alert or panel if it deserves one); a new page or state in WEBSITE_SPEC; a new token or component in DESIGN_SYSTEM; a new secret or step in the runbook.
- **Each fact lives in one place.** Link to it rather than copying it. When a number must appear in two places (such as a rate limit), this file is the reference and the other place must match it.
- **Check claims against the code.** Every statement about behaviour in these documents was checked against the implementation when written; do the same when editing, and update the date at the top.
- **Update [Verification status](#verification-status)** whenever something that was not run gets run.
