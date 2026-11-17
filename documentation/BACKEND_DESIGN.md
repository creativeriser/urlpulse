# URLPulse backend design

Part of the URLPulse documentation set. [DOCUMENTATION.md](../../DOCUMENTATION.md) is the master document; if the two ever disagree, the master wins.

This file describes how the server is built and why, and is enough to rebuild it. It covers architecture, request flows, the data model, the complete API contract, the algorithms, and every configuration option. Security is documented once, in [DOCUMENTATION.md, section Security](../../DOCUMENTATION.md#security); health and metrics are in [OBSERVABILITY.md](OBSERVABILITY.md).

Contents: [1 Goals](#1-goals-and-non-goals) · [2 Architecture](#2-architecture) · [3 Request flows](#3-request-flows) · [4 Data model](#4-data-model) · [5 API reference](#5-api-reference) · [6 Algorithms and decisions](#6-algorithms-and-decisions) · [7 Configuration](#7-configuration-reference) · [8 Errors and logging](#8-errors-and-logging) · [9 Extending](#9-extending-the-backend)

---

## 1. Goals and non-goals

**Goals**

1. A redirect must be fast and must keep working when parts of the system are unhealthy. Redirects never wait on analytics.
2. Anyone can create a link with no account. Control over a link is a secret *management key* handed out once, not a login.
3. Uptime monitoring of destination URLs is a first-class feature, safe by construction (no server-side request forgery).
4. The same code runs with zero infrastructure (in-memory mode) and in production (MongoDB + Redis), so developers and tests need no containers.
5. Every behaviour that matters operationally (cache hits, probe results, queue depth, dependency health) is observable.

**Non-goals (deliberate)**

- User accounts, teams, billing, link editing. A link's destination is immutable after creation; to change it, create a new link.
- Exactly-once click counting. Counting is *at least best effort, eventually consistent* (section 6.4).
- Multi-region deployment. The design scales horizontally in one region (see DOCUMENTATION.md, Scaling).

## 2. Architecture

### 2.1 Runtime view

```
                        ┌──────────────────────────────── Docker network "edge" ───────────────────────────┐
 Browser ──HTTP──▶ nginx ──▶ app (Node.js / Express) ──┬──▶ Redis   (cache: url:<code>)      [network "data", internal]
                      │          │  ▲                  ├──▶ MongoDB (urls, click_logs)       [network "data", internal]
                      │          │  └─ background: ClickBuffer flush, MonitorService scheduler
                      │          └──────────────▶ the internet (HEAD/GET probes of monitored URLs)
                      │
       Prometheus ──scrape /metrics──▶ app          Grafana ──▶ Prometheus
```

One Node.js process serves the website, the JSON API, the redirect hot path, and two background workers. Any number of identical replicas can run side by side: shared state lives in MongoDB and Redis, and the only cross-replica coordination (probe scheduling) uses an atomic database lease.

### 2.2 Layering and the composition root

```
routes/        HTTP only: parse input, call a service, shape the response
services/      business rules; know nothing about Express or Mongoose
adapters/      infrastructure: mongo/, memory/, cache/ (redis, memory, null)
lib/           pure helpers: validators, crypto, network checks, user-agent parser
config/        loadConfig(env) (pure, frozen) and the pino logger
metrics/       prom-client registry per container
container.js   composition root: the ONE place concrete adapters are chosen
app.js         builds the Express app from a container (no network I/O)
server.js      process entry: listen, start workers, graceful shutdown
```

Dependencies point inward: routes → services → repository/cache *contracts*. `container.js` picks implementations:

| Concern | `memory` mode (default with no env) | Production |
|---|---|---|
| URL + click storage | `MemoryUrlRepository`, `MemoryClickRepository` | `MongoUrlRepository`, `MongoClickRepository` (Mongoose 9) |
| Cache | `MemoryCache` (or `NullCache` when `CACHE=none`) | `RedisCache` (ioredis) |

The Mongoose driver is `require`d lazily, so memory mode never loads it. Tests build the container with `overrides` to inject fakes (a failing cache, a stubbed probe).

**Repository contract** (both adapters implement it, and the unit tests run against the memory one): `create`, `findByCode`, `deleteByCode`, `incrementClicks`, `setMonitor`, `claimDueMonitors`, `recordProbe`, `counts`, `ping`, `close` for URLs; `insertMany`, `aggregate`, `deleteByCode` for clicks. **Cache contract:** `get`, `set(key, value, ttlSeconds)`, `del`, `ping`, `close`.

**Fail-safe cache.** `RedisCache` uses `commandTimeout: 500` and `enableOfflineQueue: false`, and swallows errors into misses. If Redis disappears, every cache call fails fast (never queues or hangs) and the service falls back to MongoDB: status DEGRADED, not an outage.

### 2.3 Process lifecycle

1. `loadConfig()` validates the environment and exits with a clear message on bad values.
2. `createContainer()` connects to MongoDB (up to 10 attempts, 2 s apart, so the app tolerates starting before the database) and Redis.
3. `createApp()` mounts middleware in this order: request id → request logging → security headers → compression → (optional CORS on `/api`) → metrics → system routes (`/livez`, `/health`, `/metrics`) → JSON API → redirects → static website → 404 → error handler.
4. The server listens, then `startWorkers()` starts the click flusher and the monitor scheduler.
5. On `SIGTERM`/`SIGINT` (or an unhandled error): set `draining = true` so `/health` returns 503 and load balancers stop sending traffic, stop accepting connections, **stop workers, flush all buffered clicks**, close Redis and MongoDB, exit. A watchdog forces exit after `SHUTDOWN_TIMEOUT_MS` (10 s).
6. `keepAliveTimeout` is 65 s (above nginx's and cloud load balancers' 60 s idle timeout, preventing sporadic 502s on reused connections).

## 3. Request flows

### 3.1 Redirect (the hot path): `GET /:shortCode`

```
validate shape (3–30 of A–Z a–z 0–9 -)  ── not a code or reserved word? ──▶ fall through to the website
        │
LinkService.resolve(code)
   ├─ cache.get("url:<code>")
   │     ├─ "0"  (negative marker) ─────────────────────────────▶ 404  (counted as a hit)
   │     ├─ {"u": url, "e": expiry}  ── expired? ───────────────▶ 410
   │     │                              └─ else ────────────────▶ destination (cache hit)
   │     └─ nothing / corrupt ──▶ cache miss
   └─ miss: urlRepo.findByCode
         ├─ none ──▶ cache "0" for 60 s ──▶ 404
         ├─ expired ──▶ 410
         └─ found ──▶ cache.set (TTL = min(24 h, time until expiry)) ──▶ destination
        │
 record metrics, push click into ClickBuffer (memory, O(1), never awaited)
 respond 302 + Cache-Control: no-store
```

- 404/410 answer with the HTML page for browsers and JSON for clients that prefer it (`Accept`).
- `302` (not `301`) and `no-store` are deliberate: a permanent, cacheable redirect would hide clicks from analytics and make deleting or expiring a link ineffective.
- One cache lookup is the whole happy path: no database read, no write.

### 3.2 Create: `POST /api/url/shorten`

validate URL → resolve expiry → resolve monitor options → generate a management token (24 random bytes, base64url) and store only its SHA-256 → create with a random code or the validated alias → on duplicate alias: 409; on duplicate random code: retry up to 6 times, then 503 → clear any cached negative entry for that code → respond 201 with the token **once**.

### 3.3 Analytics: `GET /api/analytics/:code?days=N`

Looks up the link, runs one MongoDB aggregation (`$facet`: total, browsers, OS, devices, referrers, per-day timeline, 10 most recent) over the window of the last N UTC calendar days (including today), zero-fills the timeline so there is one point per day, and adds clicks that are still in the in-memory buffer to `totalClicks`.

### 3.4 Uptime monitoring

```
every MONITOR_TICK_SECONDS (30):  MonitorService.runOnce
   claimDueMonitors(batch 20)      ← atomic lease per link, safe with N replicas
   probe up to 5 at a time         ← SSRF guard → HEAD (→ ranged GET on 403/405/501)
   recordProbe                     ← counters, rolling history, schedule the next check
```

## 4. Data model

### 4.1 MongoDB

**Collection `urls`** (one document per short link; `timestamps: true`, no `__v`):

| Field | Type | Notes |
|---|---|---|
| `shortCode` | string, unique | Random Base62 (length `CODE_LENGTH`, default 7) or a validated custom alias |
| `originalUrl` | string | Normalised by `new URL().toString()`. Immutable. |
| `customAlias` | boolean | |
| `clickCount` | number | Denormalised counter, incremented in batches by the click buffer |
| `expiresAt` | date or null | |
| `manageTokenHash` | string | SHA-256 hex of the management token. The token itself is never stored. |
| `createdAt`, `updatedAt` | date | |
| `monitor.enabled` | boolean | |
| `monitor.intervalSec` | number or null | 30 to 86 400 |
| `monitor.nextCheckAt` | date or null | Due time, doubling as the scheduling lease |
| `monitor.lastCheckedAt`, `lastStatus`, `lastLatencyMs`, `lastOk`, `lastError` | | Result of the latest probe |
| `monitor.consecutiveFailures` | number | Resets to 0 on any success |
| `monitor.checks`, `monitor.successes` | number | Lifetime totals; uptime % = successes / checks |
| `monitor.history` | array of `{t, ok, ms}` | Rolling window of the last **48** probes (`$push` + `$slice: -48`) |

Indexes: unique on `shortCode`; **partial** index `monitor_due` on `monitor.nextCheckAt` where `monitor.enabled` is true, so the scheduler's "what is due?" query stays cheap however many plain links exist.

**Collection `click_logs`** (one document per click):

| Field | Notes |
|---|---|
| `shortCode`, `timestamp` | |
| `ipHash` | `SHA-256(HASH_SALT + ip)`; the IP itself is never stored |
| `userAgent` | Truncated to 300 characters |
| `referrer` | Origin only (scheme + host), never the full URL or query string; empty means Direct |
| `browser`, `os`, `device` | From the built-in user-agent parser (`lib/userAgent.js`) |

Indexes: `code_time` (`shortCode`, `timestamp` descending) for analytics; **`click_ttl`** on `timestamp` with `expireAfterSeconds = CLICK_RETENTION_DAYS × 86 400` (default 90 days). MongoDB deletes old clicks itself, which is the data-retention policy. Deleting a link also deletes its clicks.

### 4.2 Redis

| Key | Value | TTL |
|---|---|---|
| `url:<code>` | `{"u":"<destination>","e":"<ISO expiry or null>"}` | `min(CACHE_TTL_SECONDS (24 h), seconds until expiry)` |
| `url:<code>` | `0` (negative marker: "no such link") | `NEGATIVE_CACHE_TTL_SECONDS` (60 s) |

Redis holds **only** cache entries. Losing it loses nothing; compose runs it with `maxmemory 128mb` and `allkeys-lru` so it evicts instead of failing writes.

### 4.3 In-memory mode

`MemoryUrlRepository`, `MemoryClickRepository` and `MemoryCache` implement the same contracts with Maps. Data is lost on restart (the server logs a warning and the status page says so). Rate-limit counters are always in process memory in every mode (see DOCUMENTATION.md, Scaling).

## 5. API reference

Base path `/api`. Bodies are JSON (`Content-Type: application/json`, 10 KB limit). Every JSON response has `success: true|false`.

### 5.1 Error envelope

```json
{ "success": false, "error": { "code": "ALIAS_TAKEN", "message": "The alias \"promo\" is already taken. Try another one.", "details": { "field": "customAlias" } } }
```

`details` is present for validation errors and names the offending `field` so the UI can mark it.

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad input (message says what to fix; `details.field` says where) |
| 400 | `INVALID_JSON` | Body is not valid JSON |
| 401 | `UNAUTHORIZED` | Management endpoint called without `X-Manage-Token` |
| 403 | `FORBIDDEN` | Token does not match the link |
| 404 | `NOT_FOUND` | Unknown link, malformed code, or unknown `/api/...` endpoint |
| 409 | `ALIAS_TAKEN` | Custom alias already exists |
| 410 | `EXPIRED` | Link past its expiry (redirect route) |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 10 KB |
| 429 | `RATE_LIMITED` | Rate limit hit (see 5.8) |
| 500 | `INTERNAL` | Unexpected error. Logged with context; the client only sees a generic message. |
| 503 | `CODE_GENERATION_FAILED` | Six random-code collisions in a row (practically never) |

### 5.2 `POST /api/url/shorten`: create a link

Request body:

| Field | Type | Required | Rules |
|---|---|---|---|
| `originalUrl` | string | yes | `http` or `https` only, at most `MAX_URL_LENGTH` (2048) characters, no embedded credentials, host not private/loopback/internal (unless `ALLOW_PRIVATE_TARGETS`), not this service's own host |
| `customAlias` | string | no | 3–30 characters, letters, digits and hyphens, no leading or trailing hyphen, not a reserved word. Case-sensitive. |
| `expiresInDays` | integer | no | 1–365. Mutually exclusive with `expiresAt`. |
| `expiresAt` | ISO-8601 string | no | In the future and at most 366 days away |
| `monitor` | boolean | no | `true` switches on uptime monitoring (rejected if the server has it disabled) |
| `monitorIntervalSeconds` | integer | no | 30–86 400, default `MONITOR_INTERVAL_SECONDS` (300). Only used with `monitor`. |

Response `201 Created`, with a `Location` header pointing to the link resource:

```json
{
  "success": true,
  "shortUrl": "https://pulse.example.com/capstone-demo",
  "shortCode": "capstone-demo",
  "originalUrl": "https://example.com/some/long/path",
  "expiresAt": null,
  "qrUrl": "https://pulse.example.com/api/url/capstone-demo/qr",
  "manageToken": "k3Qm…(32 chars)",
  "link": { "…": "same object as GET /api/url/:code" }
}
```

`manageToken` appears in this response **only**. Rate limit: write bucket.

### 5.3 `GET /api/availability/:alias`: live alias check

`200 { "success": true, "alias": "promo2026", "available": true }` or `{ …, "available": false, "reason": "That alias is already taken" }`. Invalid and reserved aliases also return `available: false` with the validation message as `reason`. Read bucket.

### 5.4 `GET /api/url/:shortCode`: link details

```json
{
  "success": true,
  "shortCode": "capstone-demo",
  "shortUrl": "https://pulse.example.com/capstone-demo",
  "originalUrl": "https://example.com/some/long/path",
  "customAlias": true,
  "createdAt": "2026-11-16T09:00:00.000Z",
  "expiresAt": null,
  "expired": false,
  "clickCount": 128,
  "monitor": {
    "enabled": true,
    "status": "up",
    "intervalSeconds": 300,
    "lastCheckedAt": "2026-11-16T09:55:00.000Z",
    "lastStatusCode": 200,
    "lastLatencyMs": 184,
    "lastError": null,
    "consecutiveFailures": 0,
    "checks": 12,
    "uptimePercent": 100,
    "history": [ { "t": "2026-11-16T09:55:00.000Z", "ok": true, "ms": 184 } ]
  }
}
```

- `clickCount` includes clicks still waiting in the in-memory buffer, so the number is current.
- `monitor.status` is derived: `off` (not enabled), `pending` (enabled, no check yet), `up` (last check passed), `degraded` (last check failed, fewer than 2 in a row), `down` (2 or more consecutive failures).
- `uptimePercent` is `successes / checks` to two decimals, or `null` before the first check.
- `history` holds up to 48 entries, oldest first.
- Never returned: `manageTokenHash` and any scheduling field.

### 5.5 `DELETE /api/url/:shortCode`: delete a link

Header `X-Manage-Token: <token>` required. `204 No Content`. Deletes the link, all its click logs and its cache entry. Without a token: 401; wrong token: 403; unknown code: 404. Write bucket.

### 5.6 `PATCH /api/url/:shortCode/monitor`: switch monitoring on or off

Header `X-Manage-Token` required. Body `{ "enabled": true, "intervalSeconds": 300 }`. `enabled` must be a boolean; `intervalSeconds` is optional with the same 30–86 400 rule. Enabling schedules the first check immediately. Returns the updated link (same shape as 5.4). Write bucket.

### 5.7 More read endpoints

- **`GET /api/url/:shortCode/qr`**: the QR code for the short URL. Query: `format=svg|png` (default svg), `size=128..1024` (default 320), `download=1` to send as an attachment named `urlpulse-<code>.<format>`. Error correction level M, 2-module quiet zone. `Cache-Control: public, max-age=86400`.
- **`GET /api/analytics/:shortCode?days=7`**: `days` is a whole number 1–90 (default 7). Response:

```json
{
  "success": true,
  "shortCode": "capstone-demo",
  "originalUrl": "https://example.com/some/long/path",
  "periodDays": 7,
  "totalClicks": 128,
  "clicksInPeriod": 41,
  "clicksByBrowser": { "Chrome": 25, "Safari": 9, "Firefox": 7 },
  "clicksByOS": { "Windows": 18, "iOS": 9, "macOS": 8, "Android": 6 },
  "clicksByDevice": { "desktop": 28, "mobile": 13 },
  "topReferrers": [ { "referrer": "https://news.example.org", "count": 12 }, { "referrer": "Direct", "count": 20 } ],
  "timeline": [ { "date": "2026-11-10", "clicks": 3 }, "… one entry per day, zero-filled …" ],
  "recentClicks": [ { "timestamp": "2026-11-16T09:41:07.000Z", "browser": "Chrome", "os": "Windows", "device": "desktop", "referrer": "Direct" } ],
  "generatedAt": "2026-11-16T09:55:00.000Z"
}
```

  Breakdown maps are sorted by count, descending; blank values are labelled `Unknown` (browser/OS/device) or `Direct` (referrer). `topReferrers` has at most 10 entries and `recentClicks` the 10 newest. `totalClicks` is lifetime and includes buffered clicks; `clicksInPeriod` covers only the requested window.
- **`GET /api/stats`**: public counters used by the landing and status pages; `Cache-Control: public, max-age=5`, backed by a 10 s server-side cache so polling does not become repeated collection scans:

```json
{ "success": true, "links": 1204, "clicks": 98211, "monitoredLinks": 87, "monitoredLinksDown": 2,
  "cache": { "hits": 90012, "misses": 4120, "hitRatio": 0.9562 },
  "features": { "monitoring": true },
  "uptimeSeconds": 86400, "startedAt": "2026-11-15T09:55:00.000Z", "version": "1.0.0", "commit": "9f3c2ab…" }
```

  `cache.hits/misses` are counted per process since it started (`hitRatio` is `null` before any lookup).

### 5.8 Rate limiting

Two buckets per client IP, each in a 15-minute window, answered with the standard `RateLimit` and `RateLimit-Policy` headers (IETF draft 7) and a `429 RATE_LIMITED` body when exceeded:

| Bucket | Applies to | Default |
|---|---|---|
| write | `POST /shorten`, `DELETE`, `PATCH` | 100 |
| read | link details, QR, analytics, availability, stats | 600 |

Separate buckets stop a busy dashboard (many cheap reads) from starving link creation. The **redirect route is not rate limited** by the app (nginx applies a coarse per-IP limit in front of it). Limits are env-configurable and disabled in tests.

### 5.9 Operational endpoints (not part of the API)

`GET /livez`, `GET /health`, `GET /metrics`: see [OBSERVABILITY.md](OBSERVABILITY.md).

## 6. Algorithms and decisions

### 6.1 Short codes

7 characters of Base62 drawn with `crypto.randomInt` (a CSPRNG, so codes cannot be guessed or enumerated by sequence). 62⁷ ≈ 3.5 × 10¹² codes. On a unique-index collision the service retries with a new code up to 6 times. Reserved words are skipped. Because creation relies on the **database's unique index** rather than "check then insert", two simultaneous requests cannot both claim the same code. Reserved aliases (`api`, `health`, `livez`, `metrics`, `status`, `dashboard`, `assets`, `admin`, `login`, … plus `urlpulse` and `pulse`) can never be used, so a short link can never shadow an application route.

### 6.2 Caching

Cache-aside with three refinements: **negative caching** (unknown codes are cached for 60 s as `0`, so a scanner hammering random codes costs one database read per code per minute instead of one per request); **TTL clamped to expiry** (an entry never outlives its link); and **invalidation on write** (create clears any stale negative entry, delete removes the entry). Expiry is re-checked on every cache hit because the entry stores `e`.

### 6.3 Why `302`

See 3.1. The cost is that browsers re-ask the server on every visit, which is the point: that request is the click.

### 6.4 Click recording: write-behind buffer

Persisting a click synchronously would put database writes on the redirect path. Instead `ClickBuffer.record()` appends to an in-memory queue (O(1), no await) and a background flush runs every `CLICK_FLUSH_MS` (2 s) or as soon as `CLICK_BATCH_SIZE` (500) events are waiting:

1. `insertMany` the batch into `click_logs` (`ordered: false`, so one bad document cannot block the rest);
2. one `$inc` of `clickCount` per distinct short code in the batch.

Properties and trade-offs:

- **Eventually consistent** by at most the flush interval. The API adds not-yet-persisted clicks (`pendingClicks`) to counts so the dashboard feels instant.
- **Retry:** if a flush fails the batch is put back at the front of the queue and retried on the next tick (metric `urlpulse_click_flush_failures_total`).
- **Bounded:** the queue holds at most `CLICK_QUEUE_LIMIT` (20 000) events; beyond that the oldest is dropped and `urlpulse_clicks_dropped_total` increments (an alert fires). Memory is bounded; a long database outage loses analytics, never takes the redirect path down.
- **Hard kill loses at most one in-memory batch.** A graceful shutdown (SIGTERM) flushes everything first.
- **Not exactly-once:** if `insertMany` succeeds but the later `$inc` fails, the retry re-inserts the batch, so a click can be recorded twice. Acceptable for analytics; do not use these numbers for billing.

### 6.5 Uptime probes

- **Scheduling:** `claimDueMonitors` runs one atomic `findOneAndUpdate` per link that is due (`monitor.enabled` and `nextCheckAt <= now`, oldest first) and moves `nextCheckAt` forward by a *lease* of `2 × timeout + 30 s`. Another replica running the same query at the same moment cannot claim the same link, and if a replica dies mid-probe, the lease expires and the link becomes due again. Overlapping ticks within a process collapse into one.
- **Probe:** `HEAD`; if the server answers 403, 405 or 501, retry as a `GET` with `Range: bytes=0-0`. Redirects are **not followed** (`redirect: 'manual'`): a 3xx proves the server is alive, and following it could bounce the probe into an internal network. The body is never downloaded. Timeout `MONITOR_TIMEOUT_MS` (8 s). User-Agent `URLPulse-Monitor/1.0`.
- **What counts as up:** status below 400, or 401, 403, 429 (the server is reachable but gating automated clients). Everything else, a timeout, or a network error is a failure, with the reason stored in `lastError`.
- **SSRF guard:** before connecting, the hostname is resolved and **every** address must be public. Rejected ranges: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16` (cloud metadata), `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, multicast and reserved, and IPv6 loopback, unique-local, link-local, multicast and IPv4-mapped forms of all of these. A cheaper DNS-free version of the same check runs at creation time to reject obviously internal URLs early.
- **State machine:** one failure = `degraded`, two consecutive = `down`, one success resets to `up`. One blip never reads as an outage.
- **After each probe:** `checks` and `successes` updated atomically with `$inc`, history appended and trimmed to 48, the next check scheduled `intervalSec` ahead.

### 6.6 Identity and management keys

The management token is 24 bytes from `crypto.randomBytes`, base64url-encoded. Only its SHA-256 is stored; verification hashes the presented token and compares with `timingSafeEqual`. A database leak therefore does not reveal usable keys. The token travels in the `X-Manage-Token` header (never in a URL, so it cannot end up in access logs; the logger also redacts that header). Lost key = no way to manage the link; this is intentional given there are no accounts.

### 6.7 Time

All timestamps are UTC. "Days" in analytics are UTC calendar days. The dashboard formats dates for display only.

## 7. Configuration reference

All configuration is environment variables, read once at start by the pure function `loadConfig(env)` and frozen. Invalid values fail start-up with a clear message.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables strict checks; `test` disables rate limits, monitor and logs |
| `PORT` / `HOST` | `5000` / `0.0.0.0` | Listen address |
| `BASE_URL` | (empty) | Public origin used to build short URLs. Empty = derive from the request (`protocol` + `Host`). Set it in production. |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front of the app (or an Express trust-proxy string). Must be right for correct client IPs: wrong values break rate limiting and IP hashing. |
| `CORS_ORIGIN` | (off) | Comma-separated origins, or `*`, allowed to call `/api` from a browser. Off by default (same-origin site). |
| `STORAGE` | `mongo` if `MONGO_URI` set, else `memory` | `mongo` or `memory` |
| `MONGO_URI` | (empty) | MongoDB connection string |
| `CACHE` | `redis` if a Redis URL is set, else `memory` | `redis`, `memory` or `none` |
| `REDIS_URL` | (empty) | e.g. `redis://:password@redis:6379`. Alternatively `REDIS_HOST` and `REDIS_PORT`. |
| `CACHE_TTL_SECONDS` | `86400` | Cache lifetime of a resolved link |
| `NEGATIVE_CACHE_TTL_SECONDS` | `60` | Cache lifetime of "no such link" (0 disables) |
| `HASH_SALT` | dev default | Salt for the click IP hash. **Required, 16+ characters, when `NODE_ENV=production`.** |
| `MAX_URL_LENGTH` | `2048` | Longest destination URL accepted (16–8192) |
| `ALLOW_PRIVATE_TARGETS` | `false` | Permit private and loopback destinations (and probing them). Only for isolated demos. |
| `CODE_LENGTH` | `7` | Random code length (4–16) |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Window for both buckets |
| `RATE_LIMIT_MAX` | `100` | Write requests per window per IP |
| `READ_RATE_LIMIT_MAX` | `600` | Read requests per window per IP |
| `RATE_LIMIT_ENABLED` | `true` (off in tests) | |
| `CLICK_FLUSH_MS` | `2000` | Click buffer flush interval |
| `CLICK_BATCH_SIZE` | `500` | Events per flush; also triggers an early flush |
| `CLICK_QUEUE_LIMIT` | `20000` | In-memory queue cap before the oldest events are dropped |
| `CLICK_RETENTION_DAYS` | `90` | TTL of click logs in MongoDB |
| `MONITOR_ENABLED` | `true` (off in tests) | Run the probe scheduler and allow monitoring |
| `MONITOR_TICK_SECONDS` | `30` | Scheduler period |
| `MONITOR_BATCH_SIZE` | `20` | Links claimed per tick |
| `MONITOR_CONCURRENCY` | `5` | Parallel probes (max 50) |
| `MONITOR_INTERVAL_SECONDS` | `300` | Default check interval for a new monitor |
| `MONITOR_TIMEOUT_MS` | `8000` | Per-probe timeout |
| `METRICS_ENABLED` | `true` | Serve `/metrics` (404 when false) |
| `METRICS_TOKEN` | (empty) | If set, `/metrics` requires `Authorization: Bearer <token>` |
| `LOG_LEVEL` | `info` (prod), `debug` (dev), `silent` (test) | pino level |
| `LOG_PRETTY` | on in development only | Human-readable logs (needs the dev dependency `pino-pretty`) |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Forced-exit watchdog during graceful shutdown |
| `BUILD_SHA`, `BUILD_DATE` | `dev`, none | Injected at image build; shown in `/api/stats`, `/health`, `urlpulse_build_info` |

Docker Compose and `.env.example` expose the subset an operator normally changes. Anything above can be added to the `app.environment` block.

## 8. Errors and logging

- **Operational errors** are `AppError` instances with an HTTP status and machine-readable `code`; they are returned as the envelope in 5.1. Anything else is a bug: it is logged with request context and answered with a generic `INTERNAL` message so internals never leak.
- **Logging** is structured JSON via pino (one line per request through `pino-http`, correlated by `X-Request-Id`, which is generated if the client or proxy did not send one). `/livez`, `/health` and `/metrics` are not logged. Level by status: 5xx error, 4xx warn, else info. The `Authorization`, `Cookie` and `X-Manage-Token` headers are redacted. Request serializers log only `id`, `method`, `url` and `statusCode`.
- **Unhandled rejections and uncaught exceptions** are logged and trigger the graceful shutdown path with exit code 1, so the orchestrator restarts a clean process rather than leaving a corrupted one running.

## 9. Extending the backend

- **New endpoint:** add the route in `routes/api.js` (choose the read or write limiter), put the logic in a service method, add a Supertest case in `tests/integration/api.test.js` and a unit test for the rule. Document it in section 5.
- **New metric:** add it in `metrics/index.js`, record it from the service, add it to the catalogue in OBSERVABILITY.md and, if it should page someone, to `monitoring/prometheus/alert_rules.yml`.
- **New storage engine:** implement the repository contract (section 2.2), select it in `container.js`, and run the existing service tests against it.
- **Scaling the cache or rate limiter across replicas:** see DOCUMENTATION.md, Scaling.
