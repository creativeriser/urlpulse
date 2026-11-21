# URLPulse DevOps runbook

Part of the URLPulse documentation set. [DOCUMENTATION.md](../../DOCUMENTATION.md) is the master document; if the two ever disagree, the master wins.

How to run, ship, back up and troubleshoot URLPulse. Every command here is a command that exists in the repository (`Makefile`, `scripts/`, the compose files and the workflow). What each metric and alert means is in [OBSERVABILITY.md](OBSERVABILITY.md); how the application works inside is in [BACKEND_DESIGN.md](BACKEND_DESIGN.md).

Contents: [1 Environments](#1-environments) · [2 Configuration and secrets](#2-configuration-and-secrets) · [3 Run it locally](#3-run-it-locally) · [4 The pipeline](#4-the-pipeline) · [5 First-time server setup](#5-first-time-server-setup) · [6 Deploy and roll back](#6-deploy-and-roll-back) · [7 Backup and restore](#7-backup-and-restore) · [8 HTTPS](#8-https) · [9 Monitoring access](#9-monitoring-access) · [10 Troubleshooting](#10-troubleshooting) · [11 Kubernetes](#11-kubernetes) · [12 Routine upkeep](#12-routine-upkeep) · [13 Render deployment](#13-render-deployment) · [14 If a secret may have been exposed](#14-if-a-secret-may-have-been-exposed)

---

## 1. Environments

| Environment | How it runs | Storage | Use it for |
|---|---|---|---|
| **Local, no Docker** | `npm run dev` (or `make dev`) on port 5000 | In-memory store and cache; data is lost on restart | Writing code, trying the website |
| **Local stack** | `make up`: nginx, app, MongoDB, Redis, Prometheus, Grafana in Docker Compose, app image built from your source | Docker volumes | Seeing the whole system, demos |
| **Production host** | `docker-compose.yml` + `docker-compose.prod.yml` on one Linux server, app image pulled from Docker Hub | Docker volumes, backed up with `scripts/backup-mongo.sh` | The public deployment |
| **Render** (public demo) | One free Docker web service built from the repository's `Dockerfile`; Render's HTTPS edge in front; section 13 | MongoDB Atlas (free tier); in-memory cache | The hosted demo. Not the same shape as the Compose stack: no nginx, no Redis, no Prometheus or Grafana |
| **Kubernetes** (optional, not deployed) | `kubectl apply -k k8s/` | StatefulSet volume for MongoDB | A cluster with several replicas and rolling updates. The manifests are statically checked only |

Compose pattern: `docker-compose.yml` is the base. A plain `docker compose ...` also loads `docker-compose.override.yml` (build from source, loopback ports for the app, MongoDB and Redis). Production passes both files explicitly (`-f docker-compose.yml -f docker-compose.prod.yml`), which skips the override. `make prod-up`, `make prod-down` and `make prod-logs` do exactly that.

Network layout: nginx is the only service published to the outside. The `data` network is `internal: true`, so MongoDB and Redis cannot be reached from anywhere except the app. Prometheus and Grafana are bound to `127.0.0.1` on the host.

## 2. Configuration and secrets

All configuration is environment variables. `.env.example` lists every one with its default; `make init` (which runs `scripts/init-env.sh`) writes a `.env` with freshly generated secrets, mode 600, and never overwrites an existing file. The full reference table of application settings is in [BACKEND_DESIGN.md, section 7](BACKEND_DESIGN.md#7-configuration-reference).

| Variable | Needed | What it does |
|---|---|---|
| `MONGO_USER`, `MONGO_PASSWORD` | Compose | MongoDB root account. Hex only, since it goes into a connection URL |
| `REDIS_PASSWORD` | Compose | Redis `requirepass` |
| `HASH_SALT` | Always in production | Salt for the stored IP hash; at least 16 characters, or the app refuses to start |
| `GRAFANA_USER`, `GRAFANA_PASSWORD` | Compose | Grafana admin login |
| `METRICS_TOKEN` | Optional | Bearer token required for `/metrics`; if set, add it to `monitoring/prometheus/prometheus.yml` too |
| `BASE_URL` | Production | Public address, for example `https://pulse.example.com`; empty means "derive from the Host header" |
| `HTTP_PORT` | Optional | Host port for nginx; `8082` by default (the container listens on 8080), set `80` on a server |
| `IMAGE`, `IMAGE_TAG` | Production | Which image to run, for example `youruser/urlpulse` and `sha-abc1234`; `deploy.sh` rewrites `IMAGE_TAG` |
| `RATE_LIMIT_MAX`, `READ_RATE_LIMIT_MAX`, `PUBLIC_RATE_LIMIT_MAX`, `MONITOR_ENABLED`, `CLICK_RETENTION_DAYS`, `LOG_LEVEL` | Optional | Tuning. The three limits are write and read requests per 15 minutes and public-route (redirect, page, 404) requests per minute, per client IP |
| `TRUST_PROXY` | Behind a proxy | Number of proxies in front of the app. `1` in the Compose stack (set by `docker-compose.yml`) and on Render. Wrong values make every visitor look like one address or let clients spoof theirs |
| `CORS_ORIGIN` | Optional | Off by default. A comma-separated list of explicit origins; `*` is rejected at start-up |
| `BUILD_SHA`, `RENDER_GIT_COMMIT` | Automatic | The commit shown in `/health`. `BUILD_SHA` is set by CI and `make build`; on Render the platform's `RENDER_GIT_COMMIT` is used (a `BUILD_SHA` of `dev` counts as unset) |
| `NGINX_TAG`, `MONGO_TAG`, `REDIS_TAG`, `PROMETHEUS_TAG`, `GRAFANA_TAG` | Optional | Pin third-party image versions |

Required values use `${VAR:?message}` in the compose file, so a missing one stops `docker compose` with a message naming it rather than starting a half-configured stack.

**Rules:** `.env` is git-ignored and must stay that way. Never put a secret in a workflow file, an image or a compose file. Rotating a secret means editing `.env` and running `docker compose up -d` (with the production `-f` flags on a server), which recreates the containers whose configuration changed (a plain `restart` does not re-read `.env`); for a database password, change it inside the database too; rotating `HASH_SALT` makes older click hashes uncorrelated with new ones, which is harmless.

## 3. Run it locally

```bash
npm ci
npm run dev          # http://localhost:5000, in-memory, auto-reload
npm test             # unit and integration tests
npm run lint
npm run test:coverage

make up              # full stack: http://localhost:8082 (app), http://localhost:3001 (Grafana), http://localhost:9090 (Prometheus)
make ps              # container status and health
make smoke           # create, redirect, reject, delete, verify (against PORT, default 8082)
make load            # redirect load test against http://127.0.0.1:5000
make down            # stop, keep data
make reset           # stop and DELETE all data volumes (asks first)
```

`make up` runs `make init` first, which prints the generated Grafana login once.

**End-to-end tests** (`npm run test:e2e`) need real services: export `MONGO_URI` and `REDIS_URL` first. CI provides both as service containers. **Browser check** (`scripts/ui-check.js`) is optional and needs Playwright installed separately; its header says how.

### 3.1 Check that the stack is healthy

```bash
make ps                                                   # every service should be "healthy"
curl -s http://localhost:8082/health                      # status, mongo, redis, commit, version
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8082/metrics   # 404: /metrics is blocked at nginx
curl -s http://127.0.0.1:5003/metrics | head              # the app directly (dev override only); add
                                                          #   -H "Authorization: Bearer $METRICS_TOKEN" if a token is set
make smoke                                                # 14 end-to-end checks
```

`/health` answers `UP`, `DEGRADED` (Redis down, redirects still work) or `DOWN` (MongoDB unreachable, HTTP 503). Prometheus (`http://localhost:9090/targets`) should show the `urlpulse` target as UP, and Grafana (`http://localhost:3001`) holds the provisioned **URLPulse** dashboard (24 panels). Prometheus and Grafana exist only in the Compose stack, not on Render.

## 4. The pipeline

Workflow: `.github/workflows/ci-cd.yml`. CodeQL runs separately (`codeql.yml`), and Dependabot (`dependabot.yml`) proposes updates for npm, Docker and the actions themselves.

| Job | Runs on | What it does | Fails the run when |
|---|---|---|---|
| **test** | every push and pull request; Node 22 and 24 | `npm ci`, lint, unit and integration tests with coverage thresholds, end-to-end tests against MongoDB 8 and Redis 7 service containers, `npm audit --omit=dev --audit-level=critical` (Node 24 only) | any step fails |
| **image** | after test | builds the production image, **Trivy image scan failing on CRITICAL vulnerabilities that have a fix**, an advisory Trivy repository scan (dependencies, secrets, Dockerfile/K8s/Compose misconfiguration), optional SARIF upload, then **starts the built container and runs `scripts/smoke-test.sh` against it** | the image scan finds a fixable critical, or the container does not boot or answer correctly |
| **publish** | pushes to `main` and version tags, not pull requests | multi-arch (amd64, arm64) build and push to Docker Hub with provenance and an SBOM | a build or push error. With no Docker Hub secrets it only warns and skips |
| **deploy** | `main` only, when `DEPLOY_ENABLED` is `true` and publish pushed | SSH to the server, `git pull --ff-only`, `scripts/deploy.sh` with the new tag, then a smoke test of the public URL | the health wait times out (the server rolls itself back first) or the smoke test fails |

Image tags pushed: always `sha-<7 characters of the commit>`; `latest` from `main`; `1.2.3` and `1.2` from a `v1.2.3` tag. Production deploys the immutable `sha-...` tag, never `latest`.

Concurrency: a newer push cancels an older run of the same pull request, but never cancels a run on `main` or a tag; two deploys never run at once and a running deploy is never cancelled.

### 4.1 Set it up (once)

1. **Create the GitHub repository** and push the project to `main`.
2. **Docker Hub:** create an access token (read and write) and add repository **secrets** `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (Settings, Secrets and variables, Actions).
3. **Optional, to see Trivy findings in the Security tab:** set the repository **variable** `ENABLE_CODE_SCANNING` to `true` (needs a public repository or GitHub Code Security).
4. **Optional, to deploy automatically:** do section 5 first, then add:

| Kind | Name | Value |
|---|---|---|
| Secret | `DEPLOY_HOST` | Server address |
| Secret | `DEPLOY_USER` | The deploy user (section 5) |
| Secret | `DEPLOY_SSH_KEY` | Private key of the key pair you created for CI |
| Secret | `DEPLOY_KNOWN_HOSTS` | Output of `ssh-keyscan -t ed25519 <host>`, checked against the host's real fingerprint |
| Variable | `DEPLOY_ENABLED` | `true` |
| Variable | `DEPLOY_PATH` | Where the repository is cloned, for example `/opt/urlpulse` |
| Variable | `PUBLIC_URL` | `https://pulse.example.com` |

5. Create a GitHub **Environment** named `production` (the deploy job uses it), and add required reviewers if you want a manual approval before each deploy.
The host key is pinned from `DEPLOY_KNOWN_HOSTS` and checked with `StrictHostKeyChecking=yes`: there is no trust on first use.

### 4.1a Build and publish an image by hand

CI normally does this. By hand, only when CI is unavailable:

```bash
make build                                                        # builds urlpulse:local with BUILD_SHA and BUILD_DATE
docker tag urlpulse:local <dockerhub-user>/urlpulse:sha-$(git rev-parse --short=7 HEAD)
docker login -u <dockerhub-user>                                  # paste an access token when asked, never on the command line
docker push <dockerhub-user>/urlpulse:sha-$(git rev-parse --short=7 HEAD)
```

A manual push from a laptop builds for the laptop's architecture only; the CI publish job builds amd64 and arm64 with provenance and an SBOM. To inspect what is on Docker Hub: `docker buildx imagetools inspect <dockerhub-user>/urlpulse:latest`.

### 4.2 Reading a failed run

| Symptom | Likely cause | Fix |
|---|---|---|
| Trivy step fails | A fixable CRITICAL in the base image or a dependency | Rebuild to pick up a newer base image (`apk upgrade` runs in the Dockerfile); update the dependency; check the table in the log for the package and fixed version |
| `npm audit` fails | A critical advisory in a production dependency | `npm audit`, then update or replace the package |
| Smoke test fails in the image job | The container did not start or a route regressed | The job prints the container's health status and logs at the end |
| Publish says "nothing was published" | The two Docker Hub secrets are missing | Add them (section 4.1, step 2) |
| Deploy job skipped | `DEPLOY_ENABLED` is not `true`, the ref is not `main`, or publish did not push | Check the variable and the publish job's output |
| Deploy fails and the log says "Rolling back" | The new image never reported healthy within 120 s | See section 10; the previous version is already back |

## 5. First-time server setup

Target: one Linux server (a small VPS is enough: the production compose file sets ceilings that add up to 4 CPUs and about 2.3 GB of memory across the six containers, and idle use is far lower; 2 GB of RAM is a comfortable minimum) with a public IP and a DNS name.

1. **Install Docker Engine and the Compose plugin** from Docker's official instructions for your distribution, and `git`.
2. **Create a deploy user** with no password login, add it to the `docker` group, and put the public half of a new SSH key pair in its `~/.ssh/authorized_keys`. The private half is the `DEPLOY_SSH_KEY` secret. Disable SSH password login and allow only ports 22, 80 and 443 in the firewall.
3. **Clone the repository** (a read-only deploy key is enough if it is private) to the directory you will use as `DEPLOY_PATH`:

```bash
sudo mkdir -p /opt/urlpulse && sudo chown deploy:deploy /opt/urlpulse
git clone https://github.com/<you>/<repo>.git /opt/urlpulse
cd /opt/urlpulse
```

4. **Create the configuration** and fill in production values:

```bash
./scripts/init-env.sh      # writes .env with generated secrets, prints the Grafana login
nano .env                  # set the values below
```

```ini
IMAGE=<dockerhub-username>/urlpulse
IMAGE_TAG=latest            # first start only; deploy.sh replaces it with sha-<commit>
HTTP_PORT=80
BASE_URL=https://pulse.example.com
```

5. **First start:**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps     # every service should become healthy
./scripts/smoke-test.sh http://127.0.0.1
```

6. **Schedule backups** (section 7), then **set up HTTPS** (section 8) and put the pipeline secrets in place (section 4.1).

From now on, pushing to `main` deploys.

## 6. Deploy and roll back

**Automatic:** merge to `main`; the pipeline tests, scans, publishes and then runs `deploy.sh` on the server.

**Manual, on the server:**

```bash
cd /opt/urlpulse
git pull --ff-only
IMAGE_TAG=sha-abc1234 ./scripts/deploy.sh
```

What `deploy.sh` does: reads the running tag from `.env`; validates the new tag (letters, digits, `.`, `_`, `-` only); writes it into `.env`; `docker compose pull app`; `docker compose up -d --remove-orphans`; waits up to 120 s (`DEPLOY_HEALTH_TIMEOUT`) for the app container's health check to pass; on success prunes dangling images. **If it never becomes healthy:** prints the last 40 log lines, puts the previous tag back in `.env`, recreates the app and waits again, then exits non-zero so the pipeline shows a failure. It deliberately removes `IMAGE_TAG` from its own environment so Compose reads the tag from `.env`; otherwise the rollback would be silently overridden.

**Manual rollback to a known-good version** (for example one that is healthy but wrong):

```bash
IMAGE_TAG=sha-<previous-good-commit> ./scripts/deploy.sh
```

Find tags on Docker Hub, or with `git log --oneline` (the tag is `sha-` plus the first 7 characters of the commit).

**Downtime:** Compose replaces the single app container, so there is a gap of a few seconds during which nginx answers 502. For no gap, use the Kubernetes manifests (section 11), which roll replicas one at a time.

**Changes to compose, nginx or monitoring files** are picked up by the `git pull` in the deploy; a change to nginx or Prometheus configuration needs those containers recreated, which `docker compose up -d` does when their configuration changed, and a bind-mounted file that changed on disk needs `docker compose restart nginx` (or `prometheus`).

## 7. Backup and restore

What needs backing up: MongoDB (the links and click history). Redis is a cache and can be lost without harm; Prometheus and Grafana hold only metrics and dashboards (the dashboards are in the repository).

```bash
# on the server, from the project directory
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml ./scripts/backup-mongo.sh
```

- Writes `backups/urlpulse-<UTC timestamp>.archive.gz` (a gzip `mongodump` archive), writes to a `.partial` file first so a failed dump never looks like a backup, and keeps the newest 14 (`BACKUP_KEEP`). `BACKUP_DIR` changes the folder.
- The credentials are read inside the container, so they never appear in the host's process list.
- **Schedule it** (cron, as the deploy user): `17 2 * * * cd /opt/urlpulse && COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml ./scripts/backup-mongo.sh >> backup.log 2>&1`
- **Copy the archives off the server** (object storage, another host). A backup that lives only on the machine it protects is not a backup.

**Restore** (destructive: collections in the `urlpulse` database are dropped and replaced):

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml ./scripts/restore-mongo.sh backups/urlpulse-20260101T020000Z.archive.gz --yes
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart app
# Redis keeps recently used links for up to 24 hours and persists them (AOF). After restoring an older backup,
# empty it so no link deleted since then keeps redirecting:
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning flushall'
```

**Restore precautions.** A restore has **not** been tested for this project: the scripts have been syntax-checked and never run end to end. Before using one for real: take a fresh backup of the current state first (a restore replaces collections); restore on a spare machine or a throw-away stack first and check that links, click history and the indexes (a unique index on the code, the TTL index on click logs) are back; restart the app afterwards; and flush Redis, as above.

**Test a restore** on a spare machine before you need one. It is the only way to know the backups work.

**Backups on Render and Atlas.** The scripts above apply to the Compose stack. The Render service stores data in MongoDB Atlas, outside Render. A manual export from any machine with the MongoDB database tools installed is `mongodump --uri="$MONGO_URI" --db urlpulse --archive=urlpulse.archive.gz --gzip` (set `MONGO_URI` in your shell from the Atlas console; never paste it into a document or a commit). That command has not been run for this project. Check in the Atlas console which backup options your cluster tier actually offers rather than assuming the free tier has automatic snapshots.

## 8. HTTPS

The bundled nginx speaks plain HTTP on port 8080 inside the container (published as `HTTP_PORT`). A public deployment needs HTTPS in front. Pick one:

**A. Terminate TLS in nginx (self-contained).** `nginx/conf.d/tls.conf.example` is a starting point: copy it to `nginx/conf.d/tls.conf`, set `server_name`, and copy the `location` blocks from `default.conf` into the HTTPS `server`. Then, in `docker-compose.prod.yml` (or a new override file), mount `tls.conf` into `/etc/nginx/conf.d/`, mount your certificates read-only at `/etc/nginx/certs/` (`fullchain.pem`, `privkey.pem`, for example from `certbot certonly --standalone`), and publish `443:8443`. Set `BASE_URL=https://your.domain` so short links are issued with https. The unprivileged nginx image cannot bind 443 inside the container, which is why it listens on 8443. Renew certificates with certbot's timer and reload with `docker compose restart nginx`. *This path has not been run in the development environment; test it on a staging domain first.*

**B. A TLS terminator in front** (a cloud load balancer, Cloudflare, Caddy or a host-level nginx). Point it at nginx on `HTTP_PORT`. **One change is required:** the bundled nginx overwrites `X-Forwarded-For` with the address it sees, which would be the terminator's, so every visitor would share one rate limit and one analytics hash. Add to `nginx/conf.d/default.conf`, inside the `server` block, `set_real_ip_from <terminator address or range>;` and `real_ip_header X-Forwarded-For;` (or `CF-Connecting-IP` for Cloudflare), and the app will see real client addresses. Also set `BASE_URL`.

Either way, once HTTPS works, uncomment or add the `Strict-Transport-Security` header (it is already in `tls.conf.example`).

## 9. Monitoring access

Prometheus (`127.0.0.1:9090`) and Grafana (`127.0.0.1:3001`) listen on loopback only. From your computer:

```bash
ssh -L 3001:127.0.0.1:3001 -L 9090:127.0.0.1:9090 deploy@your.server
# then open http://localhost:3001 (Grafana, login from .env) and http://localhost:9090
```

Grafana provisions the Prometheus data source and the **URLPulse** dashboard (uid `urlpulse`, 24 panels) automatically from `monitoring/grafana/`. Alert rules are in `monitoring/prometheus/alert_rules.yml`; there is **no Alertmanager** in the stack, so alerts are visible in Prometheus (Alerts page) but nothing is sent anywhere. Adding Alertmanager with an email or chat receiver is the first item on the roadmap. `/metrics` is blocked at nginx (returns 404 from outside) and reachable only on the internal network.

## 10. Troubleshooting

Start with `make ps` (or the prod compose `ps`), then `make logs` / `make prod-logs`. App logs are JSON, one object per line, each with the `request_id` that nginx also logs and returns in `X-Request-Id`, so one request can be followed across both.

| Symptom | Check | Likely cause and fix |
|---|---|---|
| `docker compose` says a variable is required | The message names it | Add it to `.env` (`make init` creates the file) |
| App container restarts in a loop | `logs app` | `HASH_SALT` shorter than 16 characters or missing in production; MongoDB not reachable (wrong `MONGO_PASSWORD` after the volume was created with an older one: the MongoDB root user is only set on first start, so either restore the old password or `make reset` if the data is disposable) |
| Site answers 502 | `ps`, `logs app` | App is restarting or not yet healthy; during a deploy a few seconds of 502 is expected |
| `/status` says "Running with reduced performance" | `logs redis` | Redis is down; redirects still work from MongoDB, more slowly. Restart Redis; check memory |
| `/status` says "Service outage" | `logs mongo`, disk space | MongoDB is down or full: fix it, the app reconnects by itself |
| Every visitor shows the same IP or is rate limited together | nginx and proxy setup | A proxy in front of nginx without real-IP handling (section 8, option B); on Render, see section 13.3 |
| Short links come out as `http://` | `BASE_URL` | Set it to the https address and restart the app |
| Prometheus target is DOWN | `http://127.0.0.1:9090/targets` | App down, or `METRICS_TOKEN` set but not configured in `prometheus.yml` |
| Dashboards are empty | Grafana data source | Prometheus not reachable from Grafana (both must be on the `edge` network); check the time range |
| No click analytics for new links | `urlpulse_click_flush_failures_total`, app logs | MongoDB write failures; the buffer retries and keeps up to 20,000 events, flushing on shutdown |
| Disk filling up | `docker system df`, `du backups` | Old images (`docker image prune`), log files (compose caps each at 3 files), backups (`BACKUP_KEEP`) |

Useful one-liners (production, from the project directory):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app node scripts/healthcheck.js   # the health check by hand
curl -s http://127.0.0.1/health                                                                      # /health through nginx
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail=100 app
```

## 11. Kubernetes

The manifests in `k8s/` run the same application with two or more replicas and zero-downtime rolling updates. They have been checked for valid YAML (**static validation only**); **they have not been applied to any cluster**, so a real Kubernetes deployment is unverified. Expect to adjust the storage class, ingress class and domain. Kubernetes is optional for this project and is not used by the Compose or Render deployments.

```bash
cd k8s
kustomize edit set image urlpulse=docker.io/<user>/urlpulse:sha-abc1234     # or edit kustomization.yaml
cp secret.example.yaml secret.yaml                                           # fill in real values; secret.yaml is git-ignored
kubectl apply -f namespace.yaml && kubectl apply -f secret.yaml
kubectl apply -k .
kubectl -n urlpulse rollout status deployment/urlpulse
```

| File | Contents |
|---|---|
| `namespace.yaml` | Namespace with Pod Security `baseline` enforced, `restricted` warned |
| `configmap.yaml` | Non-secret settings (`TRUST_PROXY=1`, Redis URL, rate limits, monitoring on). Set `BASE_URL` here |
| `secret.example.yaml` | Template for `urlpulse-secrets` (`HASH_SALT`, `METRICS_TOKEN`, `MONGO_ROOT_USER`, `MONGO_ROOT_PASSWORD`, `MONGO_URI`); deliberately not in the kustomization |
| `app.yaml` | Deployment (rolling update with `maxUnavailable: 0`, startup and liveness probes on `/livez`, readiness on `/health`, `preStop` sleep so in-flight requests finish, non-root user, read-only filesystem), Service, HorizontalPodAutoscaler (2 to 6 pods at 70% CPU), PodDisruptionBudget |
| `data.yaml` | Redis Deployment; MongoDB StatefulSet with a headless Service and a 5 Gi volume claim |
| `ingress.yaml` | nginx ingress for `pulse.example.com`, TLS secret `urlpulse-tls`, optional cert-manager annotation |
| `networkpolicy.yaml` | Default deny for incoming traffic, then allows only: the ingress controller and the `monitoring` namespace to reach the app, the app to reach Redis, and the app to reach MongoDB. Outgoing traffic is not restricted |

Run several replicas only when Redis is shared: the in-process rate limiter counts per replica, so with N replicas the effective limit is up to N times higher. Switching the limiter to a Redis store is on the roadmap ([DOCUMENTATION.md, Scaling](../../DOCUMENTATION.md#scaling)).

## 12. Routine upkeep

| When | Task |
|---|---|
| Daily (automatic) | Backup runs; click documents older than 90 days expire by themselves (TTL index) |
| Weekly | Look at the Grafana dashboard and Prometheus alerts; check that backups are arriving off-server |
| On every Dependabot pull request | Let CI run, read the changelog for major versions, merge |
| Monthly | Pull newer base images by redeploying (the Dockerfile upgrades OS packages at build time, so a rebuild picks up security fixes); `docker image prune` |
| Quarterly | Test a restore; rotate the Docker Hub token and the deploy key; review the pinned versions of MongoDB, Redis, Prometheus and Grafana in `.env.example` |
| Before a major version bump of Node | Change `engines` in `package.json`, `.nvmrc`, the `NODE_VERSION` default in the Dockerfile and the CI matrix together |

## 13. Render deployment

### 13.1 What is deployed

One Render **web service** (Docker runtime, free plan, Oregon) built from this repository's `Dockerfile` on `main`. Render builds the image itself; it does not pull the Docker Hub image. The database is **MongoDB Atlas**; the cache is the in-process memory cache (`CACHE=memory`, health shows `redis: memory`). HTTPS and the public hostname come from Render's edge and proxy, so the Compose nginx is not involved. **Prometheus and Grafana are not deployed**; they run only in the local Compose stack. The Render service's health check path is `/health`.

**Auto-Deploy** is set to *After CI Checks Pass* on `main`: a commit pushed to `main` is deployed only after its GitHub checks succeed. This was confirmed from the Render API on 2026-11-20. Pushing any other branch, or opening a pull request, does not deploy. A docs-only commit merged to `main` **does** trigger a redeploy. The `deploy` job in the GitHub workflow (SSH to a server) is optional, unrelated to Render and skipped unless `DEPLOY_ENABLED=true`.

Do not recreate the service or change its settings to follow this runbook; it describes what exists.

### 13.2 Settings the service needs

Names only. Set the values in the Render dashboard (Environment); never put them in the repository, a document or a chat.

| Name | Purpose |
|---|---|
| `NODE_ENV=production` | Strict checks (requires `HASH_SALT`) |
| `STORAGE=mongo` and `MONGO_URI` | Use Atlas. Without both, production would quietly fall back to memory storage and lose data on restart |
| `HASH_SALT` | Required, 16+ characters |
| `CACHE=memory` | No Redis on Render |
| `TRUST_PROXY=1` | Render's proxy sits in front of the app (see 13.3) |
| `MONITOR_ENABLED=true` | Run uptime checks while the service is awake |
| `METRICS_TOKEN` | Protects `/metrics` on the public address |
| **`BASE_URL`** | The public address (`https://<service>.onrender.com`). **Required for correct short links and QR codes**; if empty, the app derives it from the request `Host` header. In the Environment screenshot of 2026-11-19 it was not among the variables set on the service; check that it is now |

Adding or changing a variable on Render restarts the service (and may redeploy it); that is a deliberate step for the owner, not something a script should do.

### 13.3 Confirm client IP detection (TRUST_PROXY)

Rate limiting and the click IP hash use the address Express reports. With `TRUST_PROXY=1`, Express trusts one proxy hop and takes the next address from the right in `X-Forwarded-For` as the client. That is the visitor's address only if Render's proxy chain has exactly one hop in front of the app; with more hops it is an intermediate address, and then all visitors share one limit. **This has not been verified**; the application logs deliberately do not record client addresses. Do not change `TRUST_PROXY` to "fix" it before measuring, because both too few and too many trusted hops are wrong (too many lets a client choose its own address).

Safe check, using two different networks (for example a laptop on Wi-Fi and a phone on mobile data, Wi-Fi off), against the public address. `GET /api/stats` is counted by the read limiter and returns `RateLimit` headers; it creates nothing:

```bash
# Device A: five requests, then note the last header
for i in 1 2 3 4 5; do curl -s -o /dev/null -D - https://<your-service>.onrender.com/api/stats | grep -i '^ratelimit:'; done
# Device B, within a minute or two: one request
curl -s -o /dev/null -D - https://<your-service>.onrender.com/api/stats | grep -i '^ratelimit:'
```

The header looks like `RateLimit: limit=600, remaining=594, reset=...`. If device B's `remaining` is about 599 (fresh, not continuing from A's count), the two devices are counted separately: detection works. If B continues from A's count (about 594), they share one counter: detection is wrong, do not rely on per-IP limiting, and decide the next step with the owner. A little background traffic from the website's own polling can move the numbers by a few; the difference of five matters. The first request after a sleep also resets the counters, so make the five requests and the one request without a gap longer than 15 minutes.

### 13.4 Free-tier behaviour

| Behaviour | Consequence |
|---|---|
| Sleeps after about 15 minutes without inbound requests (seen as SIGTERM in the logs) | **Uptime checks only run while the service is awake.** Checks do not wake it. A keep-alive pinger would change this and is not part of the project |
| The first request after a sleep starts the process again | Slow first response. The app shuts down cleanly on sleep (drains, flushes click events, disconnects MongoDB) |
| Memory cache and rate-limit counters live in process memory | They start empty after each sleep or deploy |
| Small instance | Not sized for heavy bursts |
| Data lives in Atlas, not on Render | It survives restarts, sleeps and redeploys |

### 13.5 Verify a deploy

```bash
curl -s https://<your-service>.onrender.com/health      # expect status UP, mongo "connected", redis "memory"
curl -s -o /dev/null -w '%{http_code}\n' https://<your-service>.onrender.com/metrics   # expect 401 when METRICS_TOKEN is set (404 if metrics are disabled)
```

`commit` in `/health` shows the deployed commit once this version is live (older builds showed `dev`). Then create a link, follow it, and check the dashboard. Rolling back on Render is done from the Render dashboard (redeploy a previous deploy); this project has not exercised it.

### 13.6 Atlas items to check in the Atlas console

These were not verifiable from the tooling used to prepare this documentation: **Network Access** (the list must allow Render's outbound addresses; `0.0.0.0/0` is the usual choice for a free demo because Render's free-tier addresses change, and it is only as safe as the database credentials); the **database user's role** (read and write on the `urlpulse` database only is enough; avoid an admin role); the **cluster region** (a region far from Oregon adds latency to every request).

## 14. If a secret may have been exposed

A generic checklist. Nothing here has been done automatically, and rotating a secret is always the owner's decision.

1. Do not paste the value anywhere new (chat, issue, commit message). Refer to it by name.
2. Check whether it ever reached a Git commit: `git ls-files | grep -i '\.env'` should list only `.env.example`; confirm `.env` and `.env.save` are ignored with `git check-ignore -v .env .env.save`; for history, run a scanner such as `gitleaks detect` locally (the CI Trivy repository scan also looks for committed secrets, in advisory mode).
3. If it was exposed, rotate it at the source: MongoDB Atlas database user password (Atlas console, Database Access), `HASH_SALT` (harmless: older click hashes simply stop correlating with new ones), `METRICS_TOKEN`, Docker Hub access token (Docker Hub, Account settings, Security), GitHub secrets.
4. Update the new value where it is used (Render Environment tab; GitHub Actions secrets; the local `.env`), then restart or redeploy that service.
5. Check the provider's logs for use you do not recognise (Atlas access history, Docker Hub activity).
6. Never rewrite Git history on `main` as a first reaction: rotating the secret makes the old value worthless, which is the fix that matters.
