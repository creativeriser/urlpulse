# ---------------------------------------------------------------------------
# URLPulse developer and operator shortcuts.   Run `make` to list them.
# ---------------------------------------------------------------------------
.DEFAULT_GOAL := help
.PHONY: help init install dev lint test coverage e2e ui-check up down restart logs ps build scan smoke load \
        backup prod-up prod-down prod-logs clean reset

COMPOSE      ?= docker compose
COMPOSE_PROD ?= docker compose -f docker-compose.yml -f docker-compose.prod.yml
PORT         ?= 8080
UI_URL       ?= http://127.0.0.1:5000

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# --- Setup -------------------------------------------------------------------
init: ## Create .env with generated secrets (never overwrites an existing one)
	@./scripts/init-env.sh

install: ## Install Node dependencies
	npm ci

# --- Local development (no Docker needed: in-memory storage and cache) -------
dev: ## Run the app with auto-reload on http://localhost:5000
	npm run dev

lint: ## Lint the code
	npm run lint

test: ## Unit and integration tests
	npm test

coverage: ## Tests with coverage thresholds (what CI enforces)
	npm run test:coverage

e2e: ## End-to-end tests (needs MONGO_URI and REDIS_URL pointing at real services)
	npm run test:e2e

ui-check: ## Browser check of the website (needs a running app and Playwright, see scripts/ui-check.js)
	node scripts/ui-check.js $(UI_URL)

# --- Docker Compose stack ------------------------------------------------------
up: init ## Build and start the full stack (nginx, app, mongo, redis, prometheus, grafana)
	$(COMPOSE) up -d --build
	@echo ""
	@echo "  App        http://localhost:$(PORT)"
	@echo "  Grafana    http://localhost:3001   (login is printed by 'make init')"
	@echo "  Prometheus http://localhost:9090"

down: ## Stop the stack (data volumes are kept)
	$(COMPOSE) down

restart: ## Restart the app container only
	$(COMPOSE) restart app

logs: ## Follow logs from every service
	$(COMPOSE) logs -f --tail=100

ps: ## Show container status and health
	$(COMPOSE) ps

build: ## Build the production image locally
	docker build -t urlpulse:local --build-arg BUILD_SHA=$$(git rev-parse --short HEAD 2>/dev/null || echo dev) \
		--build-arg BUILD_DATE=$$(date -u +%Y-%m-%dT%H:%M:%SZ) .

scan: build ## Scan the local image with Trivy, failing on CRITICAL (same gate as CI)
	trivy image --severity CRITICAL --ignore-unfixed --exit-code 1 urlpulse:local

smoke: ## Smoke-test a running stack (override with PORT=...)
	./scripts/smoke-test.sh http://127.0.0.1:$(PORT)

load: ## Load-test the redirect path of a running app (http://127.0.0.1:5000 by default)
	node scripts/load-test.js

backup: ## Dump MongoDB to ./backups
	./scripts/backup-mongo.sh

# --- Production host -------------------------------------------------------------
prod-up: ## Start the production stack from the pulled image
	$(COMPOSE_PROD) up -d

prod-down: ## Stop the production stack
	$(COMPOSE_PROD) down

prod-logs: ## Follow production logs
	$(COMPOSE_PROD) logs -f --tail=100

# --- Cleanup ---------------------------------------------------------------------
clean: ## Remove generated files (coverage, backups are kept)
	rm -rf coverage

reset: ## DESTROY the stack and all its data volumes
	@printf "This deletes every link, click and metric stored in Docker volumes. Type 'yes' to continue: " && read ans && [ "$$ans" = "yes" ]
	$(COMPOSE) down -v
