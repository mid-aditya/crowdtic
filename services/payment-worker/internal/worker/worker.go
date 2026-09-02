package worker

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
)

// PaymentWorker consumes order.hold.created and order.paid events.
// For hold.created it waits for payment; for demo it auto-commits via DB fallback if needed.
// In production this would integrate Midtrans/Xendit webhook → commit.lua → PG.
type PaymentWorker struct {
	Pool *pgxpool.Pool
	NC   *nats.Conn
	JS   nats.JetStreamContext
}

func New(pool *pgxpool.Pool, nc *nats.Conn) (*PaymentWorker, error) {
	js, err := nc.JetStream()
	if err != nil {
		return nil, err
	}
	return &PaymentWorker{Pool: pool, NC: nc, JS: js}, nil
}

func (w *PaymentWorker) Start(ctx context.Context) error {
	// Ensure streams exist
	_, _ = w.JS.AddStream(&nats.StreamConfig{
		Name:     "ORDERS",
		Subjects: []string{"order.*"},
		Storage:  nats.MemoryStorage,
		MaxAge:   24 * time.Hour,
	})
	_, err := w.JS.Subscribe("order.hold.created", func(m *nats.Msg) {
		var evt map[string]any
		_ = json.Unmarshal(m.Data, &evt)
		slog.Info("order.hold.created", "evt", evt)
		_ = m.Ack()
	}, nats.Durable("payment-hold-consumer"), nats.ManualAck())
	if err != nil {
		return err
	}
	_, err = w.JS.Subscribe("order.paid", func(m *nats.Msg) {
		var evt map[string]any
		_ = json.Unmarshal(m.Data, &evt)
		slog.Info("order.paid", "evt", evt)
		// Here: call payment gateway confirm, then ensure PG order state PAID
		_ = m.Ack()
	}, nats.Durable("payment-paid-consumer"), nats.ManualAck())
	return err
}
