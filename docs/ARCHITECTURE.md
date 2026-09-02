# TIKET — High-Concurrency Ticketing Architecture (Tahap 1-5 Complete)

Semua tahap sudah diimplementasikan. Struktur repo:

```
sql/001_schema.sql          — Raw DDL PostgreSQL (pgx, no ORM)
sql/002_seed.sql            — Demo data
redis/lua/hold.lua          — Atomic HOLD (10m TTL)
redis/lua/release.lua       — Atomic RELEASE
redis/lua/commit.lua        — Atomic COMMIT (HELD→SOLD, idempotent)
redis/seed.lua              — Seed Redis inventory
edge/waiting-room/          — Cloudflare Worker (Fair Queue + Token Bucket + HMAC JWT)
edge/middleware.ts          — Next.js middleware queue token verifier
services/booking-service/   — Go write service (pgxpool + go-redis + NATS)
services/read-service/      — Go read service (catalog, edge-cached)
services/payment-worker/    — NATS consumer placeholder
frontend/                   — Next.js 14 Edge (Tailwind)
infra/docker-compose.yml    — Local stack (pg, redis, nats, services)
infra/k8s/deployment-booking.yaml — KEDA autoscaling 3→100 pods
loadtest/k6_flash_sale.js   — k6 ramp 5k→50k rps
```

## Flow Fair Queue
1. Pre OnSale: `POST /queue/join` → `ZADD waiting:pool:{event} RANDOM`
2. T-0: cron `maybeShufflePool()` Fisher-Yates → `queue:active:{event}`
3. Post OnSale: `ZADD queue:active FIFO (timestamp)`
4. Admission: `tokenBucketConsume(2k/s)` + `ZPOPMIN` → `signQueueToken(HS256, TTL 45s)`
5. Checkout: booking-service `QueueAuth` middleware → `hold.lua` (atomic) → PG reservations → NATS `order.hold.created` → `commit.lua` → PG orders (partitioned) + idempotency.

## Anti-Bot
- Cloudflare Turnstile verify, rate limit per IP/FP (fixed window 60s), HMAC token TTL 45s, max 4 tiket per event (Redis + DB).

## Atomic Inventory
- Semua hot path di Redis Lua (single shard via `{event_id}` hash tag). Postgres `SELECT FOR UPDATE` DILARANG di hot path; hanya commit final via NATS + prepared statements.

## Menjalankan lokal
```sh
cd infra && docker compose up -d
psql $PG_DSN -f ../sql/001_schema.sql
psql $PG_DSN -f ../sql/002_seed.sql
redis-cli EVAL "$(cat ../redis/seed.lua)" 0 <event_id> <cat_id> 500 A 1500000 "2026-08-27T00:00:00Z"
cd ../services/booking-service && go run ./cmd/server
cd ../services/read-service && go run ./cmd/server
cd ../frontend && npm i && npm run dev
wrangler dev edge/waiting-room
k6 run --vus 5000 --duration 10m loadtest/k6_flash_sale.js
```
