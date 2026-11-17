# URLPulse

**Shorten a link. Then know if it's still alive.**

URLPulse is an automated URL shortener with built-in uptime monitoring, click analytics and a complete CI/CD pipeline. Paste a long URL, get a short one (random code or your own alias, optional expiry, QR code), and switch on an uptime check to watch the page behind it. No account needed.

It is also a DevOps capstone: containers, a pipeline with security gates, Prometheus and Grafana, runbooks, rollback and backups, all around a real application with a website designed to be shown off.

| | |
|---|---|
| ![Home, light](docs/screenshots/home-light.png) | ![Short link ready, dark](docs/screenshots/home-result-dark.png) |
| ![Dashboard, light](docs/screenshots/dashboard-light.png) | ![Status, dark](docs/screenshots/status-dark.png) |

## Try it

```bash
npm ci
npm run dev                 # http://localhost:5000, nothing else to install (in-memory mode)
```

Or the whole stack (nginx, app, MongoDB, Redis, Prometheus, Grafana):

```bash
make up                     # http://localhost:8080 · Grafana http://localhost:3001 · Prometheus http://localhost:9090
make smoke                  # end-to-end check
```

Needs Node 22 or newer for local development, and Docker for the stack. `make` lists every shortcut.

## What is inside

- **Backend:** Node.js, Express 5, MongoDB, Redis (cache only). No TypeScript.
- **Website:** three pages (shorten, dashboard, status) in plain HTML, CSS and ES modules on a purpose-built design system, light and dark.
- **DevOps:** multi-stage non-root image, Docker Compose, GitHub Actions (test on Node 22 and 24, Trivy scan that fails on fixable critical vulnerabilities, publish to Docker Hub, deploy with automatic rollback), CodeQL, Dependabot, Kubernetes manifests.
- **Observability:** `/livez`, `/health`, Prometheus metrics, 13 alert rules, a provisioned Grafana dashboard, JSON logs with request ids.

## Documentation

Start with **[DOCUMENTATION.md](DOCUMENTATION.md)**, the single source of truth: architecture, decisions, security, scaling, CI/CD, requirements traceability, roadmap, and an honest table of what has and has not been run.

| Deep dive | Topic |
|---|---|
| [docs/design/BACKEND_DESIGN.md](docs/design/BACKEND_DESIGN.md) | Server design, data model, full API, every setting |
| [docs/design/WEBSITE_SPEC.md](docs/design/WEBSITE_SPEC.md) | Every page, state and string |
| [docs/design/DESIGN_SYSTEM.md](docs/design/DESIGN_SYSTEM.md) | Colour, type, components, charts, accessibility |
| [docs/design/OBSERVABILITY.md](docs/design/OBSERVABILITY.md) | Health, metrics, logs, alerts, dashboard |
| [docs/design/DEVOPS_RUNBOOK.md](docs/design/DEVOPS_RUNBOOK.md) | Set-up, deploy, rollback, backup, HTTPS, troubleshooting |

## Project status

153 unit and integration tests pass with about 95% line coverage, and lint is clean. The container image, the GitHub Actions workflow, the MongoDB adapter and the Kubernetes manifests were written and statically checked but have not yet been executed (no Docker daemon or MongoDB was available where this was built); the first run of each will be in CI. Details in [DOCUMENTATION.md, Verification status](DOCUMENTATION.md#verification-status).

## Licence

MIT. Fonts are under the SIL Open Font License (see `public/assets/fonts/`).
