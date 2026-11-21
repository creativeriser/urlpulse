# URLPulse observability

Part of the URLPulse documentation set. [DOCUMENTATION.md](../../DOCUMENTATION.md) is the master document; if the two ever disagree, the master wins.

How to see what the system is doing: health endpoints, the metric catalogue, logs, alert rules and the Grafana dashboard. The configuration files described here are in `monitoring/` and are mounted by Docker Compose.

Contents: [1 Overview](#1-overview) · [2 Health](#2-health) · [3 Metrics](#3-metrics) · [4 Logs](#4-logs) · [5 Prometheus](#5-prometheus) · [6 Alerts](#6-alerts) · [7 Grafana](#7-grafana-dashboard) · [8 Service level objectives](#8-service-level-objectives) · [9 Queries and scenarios](#9-useful-queries-and-scenarios) · [10 Limitations](#10-limitations)

---

## 1. Overview

| Signal | Where | Consumer |
|---|---|---|
| **Health** | `/livez`, `/health` | Docker `HEALTHCHECK`, Kubernetes probes, the public status page, smoke tests |
| **Metrics** | `/metrics` (Prometheus text format) | Prometheus → Grafana dashboard and alert rules |
| **Logs** | stdout, one JSON object per line | `docker compose logs`, any log shipper |

**Where each signal exists.**

| Deployment | `/livez`, `/health` | `/metrics` | Prometheus, alert rules, Grafana | Logs |
|---|---|---|---|---|
| Docker Compose (local) | yes | app serves it; blocked (404) at nginx; scraped by Prometheus inside the Docker network | **yes**: 13 alert rules, provisioned 24-panel dashboard | `docker compose logs` |
| Render (public demo) | yes (`/health` is also Render's health check path) | served by the app and protected by `METRICS_TOKEN` (401 without the bearer token); **nothing scrapes it** | **no**: Prometheus and Grafana are local-only and are not deployed to Render | Render's log viewer: the same JSON lines |

On Render, health and logs are the monitoring story, plus the product's own status page. Keeping Prometheus and Grafana local is a deliberate scope choice for a free-tier demo, not an omission. `/health` reports `commit` and `version`, which show what is deployed (on Render the commit comes from `RENDER_GIT_COMMIT` once this version is live; older builds showed `dev`).

The system also *is* an observability product: the website's status page and dashboard visualise health and per-link uptime for end users, using the same health model described here.

## 2. Health

### 2.1 Endpoints

| Endpoint | Checks dependencies? | Answers | Used for |
|---|---|---|---|
| `GET /livez` | No | `200 {"status":"alive"}` whenever the process can answer | **Liveness**: "should this process be restarted?" |
| `GET /health` | Yes (MongoDB, Redis) | `200` UP or DEGRADED, `503` DOWN or DRAINING | **Readiness**: "should traffic be routed here?" Docker healthcheck, status page |
| `GET /metrics` | n/a | Prometheus exposition | Scraping |

`/livez` has no dependencies **on purpose**. If liveness depended on MongoDB, a database outage would make an orchestrator restart every healthy app instance, turning a database problem into a full outage. Readiness is where dependencies belong.

### 2.2 The health model

| Status | HTTP | Meaning | Behaviour |
|---|---|---|---|
| `UP` | 200 | MongoDB and Redis reachable | Normal |
| `DEGRADED` | 200 | Redis down, MongoDB fine | Redirects still work, served from MongoDB (slower). Stays in rotation. |
| `DOWN` | 503 | MongoDB unreachable | The service cannot do its job. Removed from rotation. |
| `DRAINING` | 503 | Shutting down (SIGTERM received) | Load balancers stop sending traffic while in-flight requests finish and buffered clicks are flushed |

DEGRADED answers 200 deliberately: removing every app instance from rotation because the *cache* is down would be worse than serving slowly. Alerting on a cache outage is the job of the `CacheDown` alert, not of health.

Response body (the status page reads this, including from 503 responses, which are *data*, not network errors):

```json
{
  "status": "UP",
  "mongo": "connected",
  "redis": "connected",
  "checks": {
    "mongo": { "up": true, "latencyMs": 1.42 },
    "redis": { "up": true, "latencyMs": 0.31 }
  },
  "version": "1.0.0",
  "commit": "9f3c2ab…",
  "uptimeSeconds": 86400,
  "timestamp": "2026-11-16T09:55:00.000Z"
}
```

`mongo` / `redis` state strings: `connected`, `disconnected`, `memory` (in-memory development adapter), `disabled` (`CACHE=none`). A failed check also includes `checks.<dep>.error`.

Implementation notes: each dependency ping has a 1.5 s timeout, and the combined result is cached for 2 seconds with one shared in-flight check, so Docker, Prometheus and several browsers polling at once do not each trigger a round of pings.

### 2.3 Who uses what

| Consumer | Endpoint | Setting |
|---|---|---|
| Docker image `HEALTHCHECK` | `/health` via `node scripts/healthcheck.js` | every 15 s, 5 s timeout, 20 s start period, 3 retries. A Node script, because the Alpine image has no `curl` or `wget`. |
| Compose dependency ordering | container health | nginx waits for a healthy app; app waits for healthy mongo and redis |
| Kubernetes | startup + liveness `/livez`, readiness `/health` | `k8s/app.yaml` |
| Status page (`/status`) | `/health` every 5 s, `/api/stats` every 15 s | paused while the tab is hidden |
| `scripts/deploy.sh` | container health | waits up to 120 s, rolls back otherwise |
| `scripts/smoke-test.sh` | `/health`, `/livez` | after every deploy and in CI |

## 3. Metrics

Defined in one file, `src/metrics/index.js`. Each app instance has its own registry. Node.js default metrics (`process_*`, `nodejs_*`) are included.

### 3.1 Catalogue

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `status_code` | All HTTP requests except `/metrics` and `/livez` |
| `http_request_duration_seconds` | histogram | same | Latency. Buckets: 1, 2.5, 5, 10, 20, 50, 100, 250, 500 ms and 1, 2.5, 5 s |
| `urlpulse_redirect_cache_hits_total` | counter | | Redirect lookups answered from the cache (including cached "not found") |
| `urlpulse_redirect_cache_misses_total` | counter | | Lookups that read MongoDB |
| `urlpulse_redirects_total` | counter | `outcome` = `found`, `not_found`, `expired` | Redirect attempts |
| `urlpulse_links_created_total` | counter | `type` = `random`, `custom` | Links created |
| `urlpulse_links_deleted_total` | counter | | Links deleted by their owner |
| `urlpulse_clicks_recorded_total` | counter | | Click events written to MongoDB |
| `urlpulse_clicks_dropped_total` | counter | | Click events dropped on queue overflow (**data loss**) |
| `urlpulse_click_flush_failures_total` | counter | | Failed flush attempts (batch is retried) |
| `urlpulse_click_queue_size` | gauge | | Events waiting in memory |
| `urlpulse_probe_total` | counter | `result` = `up`, `down` | Uptime probes of monitored destinations |
| `urlpulse_probe_duration_seconds` | histogram | | Probe latency. Buckets 50 ms to 8 s |
| `urlpulse_build_info` | gauge (always 1) | `version`, `commit`, `node_version` | What is running |
| `urlpulse_links` | gauge | | Links stored. Evaluated lazily at scrape time. |
| `urlpulse_monitored_links` | gauge | | Links with monitoring on (lazy) |
| `urlpulse_monitored_links_down` | gauge | | Links with 2+ consecutive failed probes (lazy) |
| `urlpulse_dependency_up` | gauge | `dependency` = `mongo`, `redis` | 1 reachable, 0 not (lazy) |

The lazy gauges are computed when Prometheus scrapes and read through the same short-lived caches as `/health` and `/api/stats`, so scraping does not cause repeated collection scans. A failing collector is swallowed so one broken gauge can never fail the whole scrape.

### 3.2 The `route` label

Labelled with the Express route **pattern**, never the raw path, so cardinality stays bounded (otherwise every short code would create a new time series). Values you will see: `/:shortCode` (redirects), `/api/url/shorten`, `/api/url/:shortCode`, `/api/url/:shortCode/qr`, `/api/url/:shortCode/monitor`, `/api/analytics/:shortCode`, `/api/availability/:alias`, `/api/stats`, `/health`; plus **`static`** (website files) and **`unmatched`** (404s). `/metrics` and `/livez` are not recorded at all.

Dashboards and latency alerts exclude `route="static"` so serving CSS and fonts does not dilute the latency of the application itself. `/health` *is* counted, so Docker and status-page polling appear in request-rate graphs.

### 3.3 Counters reset on restart

Counters restart from zero when a process restarts. Always use `rate()` or `increase()`, never raw values. The cache hit and miss numbers on `/api/stats` and the status page are per-process for the same reason ("since the server started").

## 4. Logs

JSON, one object per line, via pino. Example request line:

```json
{"level":30,"time":1763286900123,"service":"urlpulse","version":"1.0.0","req":{"id":"b1f0…","method":"GET","url":"/Xk3Rm9p"},"res":{"statusCode":302},"responseTime":2,"msg":"request completed"}
```

| Aspect | Behaviour |
|---|---|
| Correlation | `X-Request-Id` is generated per request (or taken from the incoming header; nginx sets it from `$request_id`), echoed in the response, and present on every log line for that request. Quote it when reporting a problem. |
| Level by outcome | 5xx → `error`, 4xx → `warn`, else `info` |
| Not logged | `/livez`, `/health`, `/metrics` (they would drown the signal) |
| Redacted | `Authorization`, `Cookie`, `X-Manage-Token` headers |
| Never logged by the app | Request bodies, visitor IP addresses, management tokens. (nginx's access log does record `remote_addr`: treat those logs as personal data.) |
| Domain events | `link created`, `link deleted`, `short code collision`, `monitored link probe failed`, `click flush failed; will retry`, shutdown lifecycle |
| Development | `pino-pretty` output when `NODE_ENV` is not production or test |

nginx writes its own JSON access log to stdout (`request_id`, `status`, `request_time`, `upstream_time`), so one request can be followed from the edge to the app by `request_id`. Container logs are rotated by Docker (`json-file`, 10 MB × 3 files per service). For a central log store, ship stdout with any agent; the JSON needs no parsing rules.

Useful commands:

```bash
docker compose logs -f app                       # follow the app
docker compose logs app | grep '"level":50'      # errors only
docker compose logs app | grep '"level":40'      # warnings (4xx, failed probes)
```

## 5. Prometheus

`monitoring/prometheus/prometheus.yml`:

- Scrape and rule evaluation every **15 s**; `external_labels: {service: urlpulse}`.
- Job `urlpulse` scrapes `app:5000/metrics` **directly on the internal Docker network**. nginx answers `404` for `/metrics`, so the endpoint is not public. If `METRICS_TOKEN` is set, enable the commented `authorization` block (`type: Bearer`, `credentials_file`) with the token in a file next to the config; the file must not be committed. Without the block, a token-protected `/metrics` answers Prometheus with 401 and the target shows as DOWN.
- Job `prometheus` scrapes itself.
- Retention 15 days (`PROMETHEUS_RETENTION`), data in the `prometheus-data` volume, UI bound to `127.0.0.1:9090` only (reach it with an SSH tunnel).
- Reload after editing rules without restarting: `curl -X POST http://127.0.0.1:9090/-/reload`.

To validate edited rules with the tool shipped in the Prometheus image: `docker compose run --rm --entrypoint promtool prometheus check rules /etc/prometheus/alert_rules.yml`.

## 6. Alerts

`monitoring/prometheus/alert_rules.yml`. Each alert names what is wrong, how bad it is, and where to look first. Thresholds are starting points: tune them against your own baseline.

| Alert | Condition | For | Severity | First response |
|---|---|---|---|---|
| `ServiceDown` | `up{job="urlpulse"} == 0` | 1 m | critical | `docker compose ps`, `docker compose logs app` |
| `DatabaseDown` | `urlpulse_dependency_up{dependency="mongo"} == 0` | 1 m | critical | mongo container and volume; `/health` is 503 |
| `CacheDown` | `urlpulse_dependency_up{dependency="redis"} == 0` | 5 m | warning | Service is DEGRADED, still working; restart redis |
| `RestartLoop` | `changes(process_start_time_seconds) > 2` in 15 m | none | critical | Look for crashes or OOM kills |
| `HighErrorRate` | 5xx share of requests above 5% | 2 m | critical | Recent deploy? Then database health |
| `HighLatencyP99` | p99 above 500 ms (excluding static files) | 3 m | warning | Cache hit ratio, MongoDB load |
| `EventLoopLag` | `nodejs_eventloop_lag_p99_seconds` above 100 ms | 5 m | warning | CPU-bound: scale out or profile |
| `HighMemory` | RSS above 300 MB (limit 384 MB) | 10 m | warning | Approaching OOM kill: click queue size, leak |
| `RateLimitingHeavy` | more than 5 `429` responses per second | 5 m | warning | Abuse or a misbehaving client |
| `LowCacheHitRatio` | hit ratio below 50% over 15 m, with real traffic | 15 m | warning | Redis too small or restarting |
| `ClickBufferBackingUp` | `urlpulse_click_queue_size` above 5000 | 5 m | warning | MongoDB cannot absorb click writes |
| `ClickFlushFailing` | more than 3 flush failures in 5 m | none | warning | Database health and disk space |
| `ClicksDropped` | any dropped clicks in 10 m | none | critical | Analytics data is being lost: fix the database first |

Design notes: availability and error alerts are *symptom* based (users are hurting); `CacheDown`, queue and memory alerts are *cause* based and set to warning so they give an early hint. `LowCacheHitRatio` includes a traffic floor so it does not fire on an idle system where the ratio is meaningless.

**No Alertmanager is bundled.** Alerts are visible in the Prometheus UI (Alerts) and in Grafana. To get notifications (email, Slack), add an Alertmanager service to `docker-compose.yml` and uncomment the `alerting` block in `prometheus.yml`.

## 7. Grafana dashboard

Provisioned automatically (`monitoring/grafana/provisioning/`): a Prometheus data source with the fixed uid `prometheus`, and the dashboard **URLPulse Overview** (uid `urlpulse`) loaded from `monitoring/grafana/dashboards/urlpulse.json`. Dashboards are read-only in the UI (`allowUiUpdates: false`): the JSON file in git is the source of truth. To change one, edit it in Grafana, use *Share → Export → JSON*, and replace the file.

Open Grafana at `http://localhost:3001` (login printed by `make init`; bound to loopback). Default range: last 3 hours, refresh 10 s.

| Row | Panels |
|---|---|
| 1. Golden signals | Service (UP/DOWN), requests per second, 5xx error rate, p95 latency, cache hit ratio, process uptime |
| 2. Dependencies and product | MongoDB, Redis, links stored, links monitored, monitored links down, clicks recorded |
| 3. Traffic and latency | Requests per second by status code (302 blue, 2xx green, 4xx orange, 5xx red), latency p50 / p95 / p99 |
| 4. Redirect hot path | Redirects by outcome, cache hits versus misses, links created by type |
| 5. Pipelines | Click write rate (with dropped and failed flushes), click queue size, uptime probes by result, probe latency p95 |
| 6. Saturation | Resident memory, CPU, event-loop lag |

Stat colours follow the same thresholds as the alerts, so a red tile and a firing alert agree.

## 8. Service level objectives

Suggested targets for a small deployment (the project does not enforce them; they give the alerts a rationale):

| SLI | Measurement | Suggested SLO |
|---|---|---|
| Redirect availability | `1 − 5xx / total` on route `/:shortCode` | 99.9% over 30 days |
| Redirect latency | p99 of `http_request_duration_seconds` on `/:shortCode` | below 100 ms (the alert fires at 500 ms across all application routes) |
| Cache effectiveness | hit ratio | above 90% in steady state |
| Analytics freshness | `urlpulse_click_queue_size` drains | below 5000 for 99% of the time; zero dropped clicks |

The redirect route is the product's core promise, so it carries the strictest objective.

## 9. Useful queries and scenarios

```promql
# redirect p99 latency
histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{route="/:shortCode"}[5m])))

# redirect error ratio
sum(rate(http_requests_total{route="/:shortCode",status_code=~"5.."}[5m])) / sum(rate(http_requests_total{route="/:shortCode"}[5m]))

# share of lookups served from cache
sum(rate(urlpulse_redirect_cache_hits_total[15m])) / (sum(rate(urlpulse_redirect_cache_hits_total[15m])) + sum(rate(urlpulse_redirect_cache_misses_total[15m])))

# probes failing right now
sum(rate(urlpulse_probe_total{result="down"}[15m]))
```

| Symptom | Look at | Likely cause |
|---|---|---|
| Latency up, hit ratio down | Cache panels, `CacheDown` | Redis restarted or evicting; every redirect hits MongoDB |
| 5xx up right after a deploy | Error rate, `urlpulse_build_info` | Bad release: `scripts/deploy.sh` rolls back automatically if health fails; otherwise redeploy the previous tag |
| Analytics counts stall | Click queue size, flush failures | MongoDB slow or down; clicks are buffered, not lost, until the queue limit |
| Many `404`s on `/:shortCode` | Redirects by outcome (`not_found`) | A scanner probing random codes; negative caching absorbs the database cost |
| Monitored links all failing at once | Probe results, app egress | The app host lost outbound network (probes run from the server) |

## 10. Limitations

- **Single Prometheus, no long-term storage.** 15 days of data on one volume. Use remote write for more.
- **No bundled Alertmanager** (section 6): rules fire inside Prometheus and nothing is delivered anywhere.
- **Local only.** Prometheus, the alert rules and the Grafana dashboard are part of the Docker Compose stack and are not deployed to Render.
- **Free-tier hosting gaps.** Where the service sleeps (Render free), uptime probes and metrics stop while it is asleep, and in-process metrics reset on every restart.
- **Per-process counters.** With several replicas, Prometheus scrapes each; aggregate with `sum()`. The in-app `cache` numbers on `/api/stats` describe the replica that answered.
- **Probe metrics measure the probe, not the user's experience.** Latency is from the server's network position.
- **Static Prometheus targets** (`app:5000`). Scaling replicas in Compose needs service discovery (DNS SD or Kubernetes SD); the Kubernetes manifests carry `prometheus.io/*` annotations for that.
