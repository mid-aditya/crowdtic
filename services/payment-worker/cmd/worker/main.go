package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"tiket-payment-worker/internal/worker"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
	"github.com/nats-io/nats.go"
)

func main() {
	_ = godotenv.Load()
	ctx := context.Background()
	pgDSN := env("PG_DSN", "postgres://tiket:tiket@localhost:5432/tiket?sslmode=disable")
	natsURL := env("NATS_URL", "nats://localhost:4222")

	pool, err := pgxpool.New(ctx, pgDSN)
	if err != nil {
		log.Fatalf("pg: %v", err)
	}
	defer pool.Close()

	nc, err := nats.Connect(natsURL, nats.MaxReconnects(-1))
	if err != nil {
		log.Fatalf("nats: %v", err)
	}
	defer nc.Drain()

	w, err := worker.New(pool, nc)
	if err != nil {
		log.Fatalf("worker init: %v", err)
	}
	if err := w.Start(ctx); err != nil {
		log.Fatalf("worker start: %v", err)
	}
	log.Println("payment-worker running")

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("shutting down payment-worker")
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
