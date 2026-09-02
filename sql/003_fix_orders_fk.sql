DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
CREATE TABLE order_items (
    order_id UUID NOT NULL,
    order_created_at TIMESTAMPTZ NOT NULL,
    seat_id UUID NOT NULL REFERENCES seats(id),
    price BIGINT NOT NULL,
    PRIMARY KEY (order_id, seat_id),
    FOREIGN KEY (order_id, order_created_at) REFERENCES orders(id, created_at)
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
    FOREIGN KEY (order_id, order_created_at) REFERENCES orders(id, created_at)
);
