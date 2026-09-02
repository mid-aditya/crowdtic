# Run Local TANPA Docker

> Docker cuma shortcut. Semua service Go bisa jalan tanpa Docker.

## Opsi A — Mock (tanpa install apa pun) — untuk cek wiring & health

Go & Node kamu sudah cukup (`go 1.26`, `node 22`). Postgres/Redis/NATS belum ada → service tetap start, cuma log `WARN` dan endpoint `/health` tetap OK. `POST /hold` akan fail `SOLD_OUT/INV_NOT_FOUND` (expected karena Redis kosong).

```powershell
# PowerShell (Windows)
.\run-local.ps1
# cek
curl http://localhost:8080/health
curl http://localhost:8081/health
# logs
Receive-Job booking -Keep | tail -n 50
# stop
Get-Job | Stop-Job; Get-Job | Remove-Job
```

## Opsi B — Real (tanpa Docker, pakai infra lokal/managed)

1. **Postgres**: install via https://www.postgresql.org/download/windows/ atau pakai Neon/Supabase free. Buat DB `tiket` lalu:
   ```powershell
   psql $env:PG_DSN -f sql/001_schema.sql
   psql $env:PG_DSN -f sql/002_seed.sql
   ```
2. **Redis**: install via https://github.com/microsoftarchive/redis/releases atau pakai Upstash (REST). Seed hot inventory:
   ```sh
   redis-cli EVAL "$(cat redis/seed.lua)" 0 <event_id> <cat_id> 500 A 1500000
   ```
3. **NATS**: download `nats-server -js` dari https://nats.io/download/ lalu `nats-server -js`

Set env lalu jalan:
```powershell
$env:PG_DSN="postgres://tiket:tiket@localhost:5432/tiket?sslmode=disable"
$env:REDIS_ADDR="localhost:6379"
$env:NATS_URL="nats://localhost:4222"
$env:JWT_SECRET="ganti-32chars-secret-production!!"
go run ./services/booking-service/cmd/server   # :8080
go run ./services/read-service/cmd/server      # :8081
go run ./services/payment-worker/cmd/worker
cd frontend; npm i; npm run dev                # :3000
```

## Catatan
- `infra/docker-compose.yml` TIDAK wajib. Hapus/abai kan kalau tidak pakai Docker.
- Di production pakai managed: Cloud SQL/CockroachDB + DragonFly/Upstash + NATS Cloud + K8s (KEDA).
