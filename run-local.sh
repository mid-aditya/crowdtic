#!/bin/bash
# TIKET — Run TANPA Docker (mock mode: tetap hidup meski PG/Redis/NATS belum ada)
# Health tetap 200. Hold/commit butuh infra real (lihat docs/RUN_LOCAL.md Opsi B)
set -e
export ENV=development
export JWT_SECRET='dev-only-32chars-super-secret-jwt!!'
export JWT_ISSUER='tiket-waiting-room'
export JWT_AUDIENCE='tiket-checkout'
export HOLD_TTL_SEC=600
export PG_DSN='postgres://tiket:tiket@localhost:5432/tiket?sslmode=disable'
export REDIS_ADDR='localhost:6379'
export NATS_URL='nats://localhost:4222'

echo "== TIKET run-local TANPA Docker =="
echo " PG_DSN=$PG_DSN"
echo " REDIS=$REDIS_ADDR  NATS=$NATS_URL"
echo ""

# start booking :8080
( cd services/booking-service && PORT=8080 go run ./cmd/server > /tmp/booking.log 2>&1 & echo $! > /tmp/booking.pid )
# start read :8081
( cd services/read-service && PORT=8081 go run ./cmd/server > /tmp/read.log 2>&1 & echo $! > /tmp/read.pid )
sleep 4
echo "--- booking.log (WARN PG/Redis/NATS = expected kalau belum install infra) ---"
head -n 12 /tmp/booking.log
echo "--- read.log ---"
cat /tmp/read.log
echo ""
echo "Health:"
curl -s http://localhost:8080/health && echo "  <- booking :8080 OK" || echo "booking DOWN"
curl -s http://localhost:8081/health && echo "  <- read :8081 OK" || echo "read DOWN"
echo ""
echo "Coba tanpa queue token (harus 401):"
curl -s -i http://localhost:8080/api/hold -H "Content-Type: application/json" -d '{"event_id":"x","category_id":"y","seat_ids":["z"],"idempotency_key":"11111111-1111-1111-1111-111111111111"}' | head -n 5
echo ""
echo "Stop: kill \$(cat /tmp/booking.pid) \$(cat /tmp/read.pid)"
echo "Logs: tail -f /tmp/booking.log  |  tail -f /tmp/read.log"
