package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	Pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{Pool: pool} }

// Prepared-statement style queries (pgx caches automatically)

func (s *Store) CheckIdempotency(ctx context.Context, idem uuid.UUID, userID uuid.UUID) (existingOrderID *uuid.UUID, found bool, err error) {
	var id uuid.UUID
	err = s.Pool.QueryRow(ctx, `SELECT id FROM orders WHERE idempotency_key=$1 AND user_id=$2`, idem, userID).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return &id, true, nil
}

func (s *Store) InsertReservation(ctx context.Context, holdID string, userID, eventID, catID uuid.UUID, seatIDs []uuid.UUID, expiresAt time.Time) error {
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO reservations (hold_id, user_id, event_id, category_id, seat_ids, seat_count, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (hold_id) DO NOTHING`,
		holdID, userID, eventID, catID, seatIDs, len(seatIDs), expiresAt)
	return err
}

func (s *Store) InsertOrderTx(ctx context.Context, orderID, userID, eventID uuid.UUID, holdID string, total int64, idem uuid.UUID, seatIDs []uuid.UUID, prices []int64) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Partitioned orders: ON CONFLICT tidak bisa pakai unique index tanpa partition key.
	// Idempotency via cek manual + INSERT tanpa ON CONFLICT.
	var exists uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM orders WHERE idempotency_key=$1 AND user_id=$2`, idem, userID).Scan(&exists)
	if err == nil {
		return nil // sudah ada, treat as idempotent success
	}
	var orderCreatedAt time.Time
	err = tx.QueryRow(ctx, `INSERT INTO orders (id, hold_id, user_id, event_id, total_amount, status, idempotency_key, created_at)
		VALUES ($1,$2,$3,$4,$5,'PAID',$6, now()) RETURNING created_at`,
		orderID, holdID, userID, eventID, total, idem).Scan(&orderCreatedAt)
	if err != nil {
		return err
	}
	for i, sid := range seatIDs {
		price := int64(0)
		if i < len(prices) {
			price = prices[i]
		}
		if _, err := tx.Exec(ctx, `INSERT INTO order_items (order_id, order_created_at, seat_id, price) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, orderID, orderCreatedAt, sid, price); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE seats SET status='SOLD', version=version+1 WHERE id=$1`, sid); err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO payments (order_id, order_created_at, gateway, amount, status, paid_at) VALUES ($1,$2,'mock',$3,'SUCCESS', now()) ON CONFLICT (order_id) DO NOTHING`, orderID, orderCreatedAt, total)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) Audit(ctx context.Context, userID *uuid.UUID, eventID *uuid.UUID, ip, ua, fp, action string) {
	_, _ = s.Pool.Exec(ctx, `INSERT INTO audit_logs (user_id, event_id, ip, user_agent, fingerprint, action) VALUES ($1,$2,$3,$4,$5,$6)`,
		userID, eventID, ip, ua, fp, action)
}

func (s *Store) GetEvent(ctx context.Context, eventID uuid.UUID) (maxPerUser int, onSaleAt time.Time, err error) {
	err = s.Pool.QueryRow(ctx, `SELECT max_ticket_per_user, on_sale_at FROM events WHERE id=$1`, eventID).Scan(&maxPerUser, &onSaleAt)
	return
}

// Reservation mirrors DB row for reaper/release
type Reservation struct {
	HoldID     string
	UserID     uuid.UUID
	EventID    uuid.UUID
	CategoryID uuid.UUID
	SeatIDs    []uuid.UUID
	ExpiresAt  time.Time
}

func (s *Store) GetReservation(ctx context.Context, holdID string) (*Reservation, error) {
	var r Reservation
	err := s.Pool.QueryRow(ctx, `SELECT hold_id, user_id, event_id, category_id, seat_ids, expires_at FROM reservations WHERE hold_id=$1`, holdID).
		Scan(&r.HoldID, &r.UserID, &r.EventID, &r.CategoryID, &r.SeatIDs, &r.ExpiresAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &r, nil
}

func (s *Store) DeleteReservation(ctx context.Context, holdID string) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM reservations WHERE hold_id=$1`, holdID)
	return err
}

func (s *Store) ExpiredReservations(ctx context.Context, limit int) ([]Reservation, error) {
	rows, err := s.Pool.Query(ctx, `SELECT hold_id, user_id, event_id, category_id, seat_ids, expires_at FROM reservations WHERE expires_at < now() LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Reservation
	for rows.Next() {
		var r Reservation
		if err := rows.Scan(&r.HoldID, &r.UserID, &r.EventID, &r.CategoryID, &r.SeatIDs, &r.ExpiresAt); err != nil {
			continue
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) InsertAuditLog(ctx context.Context, userID *uuid.UUID, eventID *uuid.UUID, ip, ua, fp, action string, payload []byte) error {
	_, err := s.Pool.Exec(ctx, `INSERT INTO audit_logs (user_id, event_id, ip, user_agent, fingerprint, action, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, userID, eventID, ip, ua, fp, action, string(payload))
	return err
}
