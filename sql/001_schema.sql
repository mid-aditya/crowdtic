-- ============================================
-- HIGH-PERFORMANCE POSTGRESQL DDL — TIKET MEGA PLATFORM
-- Target: 50k TPS commit, zero double-booking
-- Engine: PostgreSQL 16+ / CockroachDB compatible
-- Driver: pgx / pgxpool (Native, No ORM)
-- ============================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ============ 1. USERS ============
CREATE TABLE users (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nik_hash                CHAR(64) NOT NULL,
    nik_verified            BOOLEAN NOT NULL DEFAULT false,
    phone_hash              CHAR(64),
    email                   CITEXT UNIQUE,
    device_fingerprint_hash CHAR(64),
    turnstile_score         SMALLINT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_users_nik_hash ON users (nik_hash) WHERE nik_verified = true;
CREATE INDEX ix_users_fingerprint ON users (device_fingerprint_hash);

-- ============ 2. VENUES & EVENTS ============
CREATE TABLE venues (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    city        TEXT NOT NULL,
    capacity    INT NOT NULL CHECK (capacity > 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id            UUID NOT NULL REFERENCES venues(id),
    title               TEXT NOT NULL,
    slug                TEXT NOT NULL UNIQUE,
    on_sale_at          TIMESTAMPTZ NOT NULL,
    sale_ends_at        TIMESTAMPTZ,
    status              TEXT NOT NULL CHECK (status IN ('DRAFT','SCHEDULED','ON_SALE','SOLD_OUT','ENDED')),
    max_ticket_per_user SMALLINT NOT NULL DEFAULT 4 CHECK (max_ticket_per_user BETWEEN 1 AND 10),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_events_on_sale ON events (on_sale_at);
CREATE INDEX ix_events_status ON events (status);

-- ============ 3. TICKET CATEGORIES & SEATS ============
CREATE TABLE ticket_categories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    price       BIGINT NOT NULL CHECK (price >= 0),
    quota       INT NOT NULL CHECK (quota > 0),
    sold        INT NOT NULL DEFAULT 0,
    held        INT NOT NULL DEFAULT 0,
    UNIQUE(event_id, name)
);
CREATE INDEX ix_cat_event ON ticket_categories (event_id);

CREATE TABLE seats (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    category_id     UUID NOT NULL REFERENCES ticket_categories(id),
    seat_number     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','HELD','RESERVED','SOLD')),
    version         BIGINT NOT NULL DEFAULT 1,
    held_expires_at TIMESTAMPTZ,
    UNIQUE(event_id, seat_number)
);
CREATE INDEX ix_seats_event_status ON seats (event_id, status) WHERE status = 'AVAILABLE';
CREATE INDEX ix_seats_category ON seats (category_id, status);
CREATE INDEX ix_seats_expires ON seats (held_expires_at) WHERE status = 'HELD';

-- ============ 4. RESERVATIONS ============
CREATE TABLE reservations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hold_id     TEXT NOT NULL UNIQUE,
    user_id     UUID NOT NULL REFERENCES users(id),
    event_id    UUID NOT NULL REFERENCES events(id),
    category_id UUID NOT NULL REFERENCES ticket_categories(id),
    seat_ids    UUID[] NOT NULL,
    seat_count  SMALLINT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_expires CHECK (expires_at > created_at)
);
CREATE INDEX ix_reservations_expires ON reservations (expires_at);
CREATE INDEX ix_reservations_user ON reservations (user_id, event_id);

-- ============ 5. ORDERS & PAYMENTS (Partitioned) ============
CREATE TABLE orders (
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    hold_id         TEXT NOT NULL REFERENCES reservations(hold_id),
    user_id         UUID NOT NULL REFERENCES users(id),
    event_id        UUID NOT NULL REFERENCES events(id),
    total_amount    BIGINT NOT NULL CHECK (total_amount >= 0),
    status          TEXT NOT NULL CHECK (status IN ('PENDING','PAID','EXPIRED','CANCELLED','REFUNDED')),
    idempotency_key UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE orders_p2026_q3 PARTITION OF orders FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');
CREATE TABLE orders_p2026_q4 PARTITION OF orders FOR VALUES FROM ('2026-10-01') TO ('2027-01-01');
CREATE UNIQUE INDEX ux_orders_idempotency ON orders (idempotency_key, user_id, created_at);
CREATE INDEX ix_orders_user_event ON orders (user_id, event_id);

CREATE TABLE order_items (
    order_id UUID NOT NULL,
    order_created_at TIMESTAMPTZ NOT NULL,
    seat_id UUID NOT NULL REFERENCES seats(id),
    price BIGINT NOT NULL,
    PRIMARY KEY (order_id, seat_id),
    FOREIGN KEY (order_id, order_created_at) REFERENCES orders(id, created_at) ON DELETE CASCADE
);

CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL,
    order_created_at TIMESTAMPTZ NOT NULL,
    gateway TEXT NOT NULL CHECK (gateway IN ('midtrans','xendit','mock')),
    gateway_ref TEXT UNIQUE,
    amount BIGINT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('INIT','PENDING','SUCCESS','FAILED','EXPIRED')),
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(order_id),
    FOREIGN KEY (order_id, order_created_at) REFERENCES orders(id, created_at) ON DELETE CASCADE
);

-- ============ 6. AUDIT LOGS (UNLOGGED + BRIN) ============
CREATE UNLOGGED TABLE audit_logs (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID,
    event_id        UUID,
    ip              INET NOT NULL,
    user_agent      TEXT,
    fingerprint     TEXT,
    action          TEXT NOT NULL,
    payload         JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX brin_audit_time ON audit_logs USING BRIN (created_at);
CREATE INDEX ix_audit_ip_time ON audit_logs (ip, created_at);

-- ============ 7. QUEUE ADMISSIONS ============
CREATE TABLE queue_admissions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL,
    event_id    UUID NOT NULL REFERENCES events(id),
    token_jti   TEXT NOT NULL UNIQUE,
    admitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);
