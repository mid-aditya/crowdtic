-- Seed demo: 1 venue, 1 event, 2 categories, seats via SQL (Redis seed via redis/seed.lua for hot path)
INSERT INTO venues (id, name, city, capacity) VALUES
('550e8400-e29b-41d4-a716-446655440001','GBK Stadium','Jakarta', 80000)
ON CONFLICT (id) DO NOTHING;

INSERT INTO events (id, venue_id, title, slug, on_sale_at, sale_ends_at, status, max_ticket_per_user) VALUES
('550e8400-e29b-41d4-a716-446655440010','550e8400-e29b-41d4-a716-446655440001','Mega Concert — Flash Sale Demo','mega-concert-2026', now() + interval '1 hour', now() + interval '7 days','SCHEDULED',4)
ON CONFLICT (id) DO NOTHING;

INSERT INTO ticket_categories (id, event_id, name, price, quota) VALUES
('550e8400-e29b-41d4-a716-446655440020','550e8400-e29b-41d4-a716-446655440010','VIP', 150000000, 500),
('550e8400-e29b-41d4-a716-446655440021','550e8400-e29b-41d4-a716-446655440010','Festival A', 75000000, 5000)
ON CONFLICT (id) DO NOTHING;

-- Generate seats (VIP 500, Festival 5000) — run once
INSERT INTO seats (event_id, category_id, seat_number)
SELECT '550e8400-e29b-41d4-a716-446655440010','550e8400-e29b-41d4-a716-446655440020','VIP-'||lpad(g::text,4,'0') FROM generate_series(1,500) g
ON CONFLICT DO NOTHING;

INSERT INTO seats (event_id, category_id, seat_number)
SELECT '550e8400-e29b-41d4-a716-446655440010','550e8400-e29b-41d4-a716-446655440021','FES-'||lpad(g::text,4,'0') FROM generate_series(1,5000) g
ON CONFLICT DO NOTHING;
