package main

import (
	"context"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
	"github.com/nats-io/nats.go"

	"tiket-booking/internal/broker"
	"tiket-booking/internal/config"
	"tiket-booking/internal/handler"
	"tiket-booking/internal/middleware"
	rlua "tiket-booking/internal/redis"
	"tiket-booking/internal/store"
)

func main() {
	_ = godotenv.Load()
	cfg := config.Load()

	ctx := context.Background()

	// Postgres
	pool, err := pgxpool.New(ctx, cfg.PgDSN)
	if err != nil {
		log.Fatalf("pg pool: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		log.Printf("WARN pg ping: %v", err)
	}

	// Redis
	rdb := redis.NewClient(&redis.Options{
		Addr:     cfg.RedisAddr,
		Password: cfg.RedisPassword,
		PoolSize: 100,
	})
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Printf("WARN redis ping: %v", err)
	}
	defer rdb.Close()

	// NATS JetStream (optional)
	var nc *nats.Conn
	nc, err = nats.Connect(cfg.NATSUrl, nats.MaxReconnects(-1))
	if err != nil {
		log.Printf("WARN nats connect: %v (running without broker)", err)
	} else {
		defer nc.Drain()
		if _, err := nc.JetStream(); err != nil {
			log.Printf("WARN nats jetstream: %v", err)
		}
		log.Println("NATS connected:", cfg.NATSUrl)
	}

	st := store.New(pool)
	scripts := rlua.New()

	gin.SetMode(gin.ReleaseMode)
	if cfg.Env == "development" {
		gin.SetMode(gin.DebugMode)
	}
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(gin.Logger())

	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"ok": true, "service": "booking", "time": time.Now().UTC()})
	})

	// Public queue status passthrough (optional)
	r.GET("/api/events/:id/inventory", func(c *gin.Context) {
		eventID := c.Param("id")
		// Try Redis first
		keys, _ := rdb.Keys(ctx, "inventory:{"+eventID+"}:*").Result()
		out := []gin.H{}
		for _, k := range keys {
			m, _ := rdb.HGetAll(ctx, k).Result()
			out = append(out, gin.H{"key": k, "data": m})
		}
		c.JSON(200, gin.H{"event_id": eventID, "inventory": out})
	})

	holdH := &handler.HoldHandler{RDB: rdb, Store: st, Scripts: scripts, NATS: nc, HoldTTL: cfg.HoldTTL}
	commitH := &handler.CommitHandler{RDB: rdb, Store: st, Scripts: scripts, NATS: nc}

	pub := &broker.NATSPublisher{Conn: nc}
	releaseH := &handler.ReleaseHandler{Store: st, RDB: rdb, Scripter: scripts, Publisher: pub}

	// Protected routes — require queue token
	auth := middleware.QueueAuth(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience)
	api := r.Group("/api", auth)
	api.POST("/hold", holdH.Handle)
	api.POST("/commit", commitH.Handle)
	api.DELETE("/hold/:holdId", releaseH.Release)
	api.POST("/payment/webhook", func(c *gin.Context) {
		c.JSON(200, gin.H{"ok": true})
	})

	// Reaper: every 30s release expired holds (fallback if Redis TTL missed)
	reaper := handler.NewReaper(st, rdb, scripts, pub, 30*time.Second)
	go reaper.Start(ctx)
	_ = slog.Default()

	srv := &http.Server{Addr: ":" + cfg.Port, Handler: r}
	go func() {
		log.Printf("booking-service listening on :%s (hold %ds)", cfg.Port, cfg.HoldTTL)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("shutting down...")
	ctx2, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx2)
}
