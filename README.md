# CrowdTic — Mega Concurrency Fair Ticketing + Blockchain

Platform ticketing berskala mega dengan **anti-bot, fair queue, atomic Redis Lua**, dan **on-chain NFT tickets** untuk keaslian, secondary market, dan ZK-KYC.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        USER BROWSER                                   │
└──────────┬──────────────────────────────────────────────────────────┘
           │
     ┌─────▼──────────────────────────────────────┐
     │  CLOUDFLARE EDGE                           │
     │  Turnstile / reCAPTCHA Enterprise          │
     │  Device Fingerprinting                     │
     │  Rate Limit TokenBucket 2k/s per IP/FP    │
     └──────────────┬─────────────────────────────┘
                    │
     ┌─────────────▼─────────────────────────────┐
     │  VIRTUAL WAITING ROOM (Redis ZSET)         │
     │  Pre-sale → waiting:pool (shuffled random)  │
     │  On-sale  → queue:active (FIFO)            │
     │  Token: HMAC-JWT TTL 45s                   │
     └──────────────┬──────────────────────────────┘
                    │
     ┌─────────────▼──────────────────────────────────────────┐
     │  NEXT.JS STOREFRONT :3000 (Tailwind, Syne+Oswald)   │
     │  Read Service :8081 ← PostgreSQL + Redis cache        │
     └──────────────┬─────────────────────────────────────────┘
                    │ (Hold / Commit)
     ┌─────────────▼──────────────────────────────────────────┐
     │  BOOKING SERVICE Go + pgx + go-redis :8080             │
     │  ┌──────────────────────────────────────────────────┐ │
     │  │  Redis Lua Script — ATOMIC HOT PATH              │ │
     │  │  inventory:{event}:cat  seat:{event}:id          │ │
     │  │  hold.lua (600s TTL) → commit.lua → SOLD         │ │
     │  └──────────────────────────────────────────────────┘ │
     │  NATS JetStream (async, optional)                     │
     └──────────────┬─────────────────────────────────────────┘
                    │ (After commit → NFT Mint)
     ┌─────────────▼──────────────────────────────────────────┐
     │  BLOCKCHAIN LAYER (Layer 2 / Base / Polygon)         │
     │                                                          │
     │  TicketNFT.sol (ERC-721)                               │
     │    → Minted AFTER PostgreSQL commit succeeds            │
     │    → IPFS metadata (seat, event, face value)          │
     │    → Enforces: KYC gate, 120% resale ceiling           │
     │                                                          │
     │  TicketMarketplace.sol                                  │
     │    → Secondary market, auto-royalty 10% to organizer   │
     │    → PullPayment pattern (no reentrancy)               │
     │                                                          │
     │  IdentityRegistry.sol (SBT — Soulbound Token)           │
     │    → ZK-compatible NIK commitment (NIK never on-chain) │
     │    → One SBT per wallet, non-transferable              │
     │                                                          │
     │  CrowdTicToken.sol (ERC-20)                            │
     │    → Staking for queue priority                        │
     │    → 30-day lock, ~1% APY rewards                     │
     └─────────────────────────────────────────────────────────┘
                    │
     ┌─────────────▼──────────────────────────────┐
     │  POSTGRESQL 16 (Partitioned orders)         │
     │  Orders by RANGE (created_at)                │
     │  order_items / payments with FK composite PK  │
     │  audit_logs UNLOGGED + BRIN                  │
     └─────────────────────────────────────────────┘
```

---

## Quick Start — Local (Tanpa Docker)

```powershell
# 1. Start backend services (booking :8080 + read :8081)
.\run-local.ps1

# 2. Seed Redis inventory + Reset seats
.\seed-redis.ps1          # 5500 seats, inventory 500/5000
.\reset-for-retest.ps1     # Reset untuk retest hold→commit

# 3. E2E test (HMAC JWT auto-signed, hold→commit→SOLD)
.\test-e2e.ps1

# 4. Frontend storefront
cd frontend
npm i
npm run dev          # http://localhost:3000
```

**Ports:**
- `:3000` — Storefront (TIKET — Mega Concert Flash Sale)
- `:8080` — Booking Service (HOLD/COMMIT API)
- `:8081` — Read Service (Events/Seats catalog)
- `:6379` — Redis 5.0 (hot inventory + queue)
- `:5432` — PostgreSQL 16 (orders, partitions, audit)

---

## Blockchain Setup

```sh
cd blockchain

# Install dependencies
npm i

# Copy and fill env
cp .env.example .env
# Edit .env: DEPLOYER_PRIVATE_KEY, BASE_SEPOLIA_RPC_URL, BASESCAN_API_KEY

# Compile Solidity contracts
npm run compile

# Run tests
npm run test

# Deploy to local Hardhat node
npm run node              # terminal 1: hardhat node
npm run deploy:local      # terminal 2

# Deploy to Base Sepolia (testnet)
npm run deploy:base-sepolia

# Verify on explorer
npm run verify:base-sepolia
```

**Smart Contracts:**

| Contract | Standard | Purpose |
|---|---|---|
| `TicketNFT.sol` | ERC-721 | One seat = one NFT, minted post-commit |
| `TicketMarketplace.sol` | Custom | Secondary market, 120% ceiling, 10% royalty |
| `IdentityRegistry.sol` | ERC-721 SBT | ZK-compatible KYC, non-transferable |
| `CrowdTicToken.sol` | ERC-20 | Staking priority, governance, loyalty |

---

## Blockchain Flow

```
1. User Register
   Off-chain: SHA256(NIK + pepper) → commitment (NIK never on-chain)
   On-chain:  IdentityRegistry.verifyZKKYC(wallet, commitment)

2. Hold → Commit → NFT Mint
   Redis Lua atomic hold (600s TTL)
        ↓
   PostgreSQL commit (PAID, partitioned orders, idempotency key)
        ↓
   TicketNFT.mintTicket(wallet, eventId, seatId, faceValue, metadataURI)
        ↓
   IPFS: { seat, section, event, organizer, faceValue, QR data }
        ↓
   User receives NFT → owns verifiable, non-counterfeit ticket

3. Secondary Market
   Seller lists ticket ≤ 120% face value
        ↓
   Buyer pays → 90% to seller, 10% organizer royalty
        ↓
   NFT transfers automatically via smart contract

4. Refund / Cancel
   Organizer calls cancelTicket(tokenId) → NFT burned
        ↓
   Payment reversed via off-chain PG

5. Gate Verification
   Scanner reads NFT owner from contract → instant, no DB lookup needed
```

---

## Database Schema (PostgreSQL 16)

```sql
-- Partitioned orders (RANGE by created_at — 1 quarter per partition)
orders(id, hold_id, user_id, event_id, total_amount, status, idempotency_key, created_at)
  PARTITION BY RANGE (created_at)

-- FK references use composite key (order_id, created_at)
order_items(order_id, order_created_at, seat_id, price)
payments(order_id, order_created_at, gateway, amount, status, paid_at)

-- UNLOGGED audit_logs — no WAL overhead, BRIN index
audit_logs(user_id, event_id, ip, user_agent, fingerprint, action, payload, created_at)
```

---

## Load Testing

```sh
# 100M req/min simulation
k6 run loadtest/k6_flash_sale.js
# Distributed: 10-30 k6 injectors
# Thresholds: p95 <800ms, p99 <1500ms, error <5%
```

---

## Project Structure

```
tiket/
├── blockchain/           # Hardhat + Solidity (NFT, Marketplace, SBT KYC, Token)
│   ├── contracts/        # .sol smart contracts
│   ├── scripts/          # deploy.ts, verify.ts
│   ├── test/             # chai tests
│   └── hardhat.config.ts
├── contracts/            # Solidity contracts (root, mirrored)
├── edge/
│   └── waiting-room/     # Cloudflare Workers + wrangler
├── frontend/             # Next.js 14 storefront (Tailwind, Syne+Oswald)
│   └── app/page.tsx      # Ticket stub + seat map + hold/commit UI
├── infra/
│   ├── docker-compose.yml
│   └── k8s/              # KEDA autoscaling 3→100 pods
├── loadtest/             # k6 scripts
├── redis/
│   └── lua/              # hold.lua, commit.lua, release.lua
├── services/
│   ├── booking-service/  # Go + pgx/v5 + go-redis
│   ├── read-service/     # Go read path
│   └── payment-worker/    # NATS consumer
├── sql/                  # Raw PostgreSQL DDL (no ORM)
│   ├── 001_schema.sql    # Full partitioned schema
│   ├── 002_seed.sql      # Demo: GBK, Mega Concert, 5500 seats
│   └── 003_fix_orders_fk.sql
└── docs/
```

---

## Security Design

- **Anti-Bot**: Cloudflare Turnstile + device fingerprint + rate limit per IP/FP/user
- **Fair Queue**: Pre-sale → Redis ZSET shuffled random; Post-sale → FIFO admission
- **Atomic Inventory**: Redis Lua scripts (no `SELECT FOR UPDATE`), TTL hold 600s
- **Idempotency**: UUID key per checkout payload — retry safe, no double-booking
- **NIK Privacy**: SHA256(NIK + pepper) commitment — never stored on-chain
- **NFT Provenance**: ERC-721 minted post-commit — proof of genuine ticket ownership
- **Resale Control**: Smart contract enforces 120% ceiling + automatic royalty

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14, Tailwind CSS, Syne + Oswald fonts |
| Backend | Go 1.26, Gin, pgx/v5, go-redis |
| Database | PostgreSQL 16 (partitioned), Redis 5 (hot path) |
| Queue | NATS JetStream (async commit events) |
| Edge | Cloudflare Workers, Turnstile |
| Blockchain | Hardhat, Solidity 0.8.20, OpenZeppelin v5 |
| Infra | Kubernetes + KEDA, Docker Compose |
| Load Test | k6 |

---

**Repo**: `git@github.com:mid-aditya/crowdtic.git`
