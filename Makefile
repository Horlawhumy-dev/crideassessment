SHELL := /bin/bash
.DEFAULT_GOAL := help

BEND := cride_bend
FEND := cride_fend

# The e2e harness does not read the dev DATABASE_URL. test/fixtures/env-e2e.ts
# builds its own from TEST_PG_PORT/TEST_REDIS_PORT and points at the `cride_test`
# database on Redis db 1, so the dev host ports have to be handed to it
# explicitly or the suite silently talks to a different server than the app does.
PG_PORT := $(shell sed -n 's/^POSTGRES_HOST_PORT=//p' $(BEND)/.env 2>/dev/null | head -1)
REDIS_PORT := $(shell sed -n 's/^REDIS_HOST_PORT=//p' $(BEND)/.env 2>/dev/null | head -1)
PG_PORT := $(if $(PG_PORT),$(PG_PORT),5434)
REDIS_PORT := $(if $(REDIS_PORT),$(REDIS_PORT),6380)
TEST_URL := postgresql://cride:cride@localhost:$(PG_PORT)/cride_test?schema=public
E2E_ENV := TEST_PG_PORT=$(PG_PORT) TEST_REDIS_PORT=$(REDIS_PORT)

API_URL ?= http://localhost:4000

.PHONY: help install env services-up services-down services-logs services-reset \
        db-migrate db-seed db-studio db-test db-reset \
        dev dev-api dev-worker dev-web \
        build typecheck test test-unit test-e2e \
        verify verify-live gen-api check-api clean

help:
	@echo "C-Ride — monorepo commands. Run any target from the repo root."
	@echo
	@echo "  Setup"
	@echo "    make install        npm ci in both packages"
	@echo "    make env            create .env files from the examples (never overwrites)"
	@echo "    make services-up    start Postgres + Redis in Docker"
	@echo "    make db-test        create and migrate the cride_test database (needed by e2e)"
	@echo "    make db-seed        load the demo users and a few rides"
	@echo
	@echo "  Run"
	@echo "    make dev            API (:4000) and web (:3000) together"
	@echo "    make dev-api        API only, watch mode"
	@echo "    make dev-worker     outbox relay + queue consumers only"
	@echo "    make dev-web        Next.js only"
	@echo
	@echo "  Verify"
	@echo "    make typecheck      tsc in both packages"
	@echo "    make test           unit suites in both packages"
	@echo "    make test-e2e       backend e2e against Postgres + Redis"
	@echo "    make verify         everything CI runs that needs no live API"
	@echo "    make verify-live    verify + the generated-contract drift check (API must be up)"
	@echo "    make gen-api        regenerate cride_fend/lib/generated/api.d.ts from a live API"
	@echo
	@echo "  Teardown"
	@echo "    make services-down  stop Postgres + Redis (volumes kept)"
	@echo "    make clean          remove build output and generated caches"

install:
	cd $(BEND) && npm ci
	cd $(FEND) && npm ci

env:
	@test -f $(BEND)/.env || (cp $(BEND)/.env.example $(BEND)/.env && echo "created $(BEND)/.env")
	@test -f $(FEND)/.env || (cp $(FEND)/.env.example $(FEND)/.env && echo "created $(FEND)/.env")
	@echo "Both .env files exist. Set FIREBASE_* in $(BEND)/.env to enable push; the in-app inbox needs none of it."

services-up:
	cd $(BEND) && docker compose up -d --wait
	@echo "Postgres on $(PG_PORT), Redis on $(REDIS_PORT)."

services-down:
	cd $(BEND) && docker compose down

services-logs:
	cd $(BEND) && docker compose logs -f

services-reset:
	cd $(BEND) && docker compose down -v

db-migrate:
	cd $(BEND) && npm run db:deploy

db-seed:
	cd $(BEND) && npm run db:seed

db-studio:
	cd $(BEND) && npm run db:studio

# Nothing in the repo creates cride_test, and prisma migrate deploy will not
# create a database, only its tables. Without this the e2e suite fails on
# connection rather than on anything it is testing.
db-test:
	@createdb -h localhost -p $(PG_PORT) -U cride cride_test 2>/dev/null \
		&& echo "created cride_test" \
		|| echo "cride_test already exists"
	cd $(BEND) && DATABASE_URL='$(TEST_URL)' npx prisma migrate deploy

db-reset:
	cd $(BEND) && npx prisma migrate reset --force

dev:
	@echo "API on :4000, web on :3000. Ctrl-C stops both."
	@trap 'kill 0' EXIT INT TERM; \
	( cd $(BEND) && npm run start:dev ) & \
	( cd $(FEND) && npm run dev ) & \
	wait

dev-api:
	cd $(BEND) && npm run start:dev

dev-worker:
	cd $(BEND) && npm run worker:dev

dev-web:
	cd $(FEND) && npm run dev

build:
	cd $(BEND) && npm run build
	cd $(FEND) && npm run build

typecheck:
	cd $(BEND) && npm run typecheck
	cd $(FEND) && npm run typecheck

test: test-unit

test-unit:
	cd $(BEND) && npm test -- --runInBand
	cd $(FEND) && npm test

test-e2e:
	cd $(BEND) && $(E2E_ENV) npm run test:e2e

verify:
	cd $(BEND) && npm run verify
	cd $(FEND) && npm run verify

verify-live:
	cd $(FEND) && API_URL=$(API_URL) npm run verify:live

gen-api:
	cd $(FEND) && API_URL=$(API_URL) npm run gen:api

check-api:
	cd $(FEND) && API_URL=$(API_URL) npm run check:api

clean:
	rm -rf $(BEND)/dist $(FEND)/.next $(BEND)/tsconfig.build.tsbuildinfo $(FEND)/tsconfig.tsbuildinfo
