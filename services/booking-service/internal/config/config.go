package config

import (
	"os"
	"strconv"
)

type Config struct {
	Port          string
	PgDSN         string
	PgReadDSN     string
	RedisAddr     string
	RedisPassword string
	NATSUrl       string
	JWTSecret     string
	JWTIssuer     string
	JWTAudience   string
	HoldTTL       int // seconds
	MaxPerUser    int
	Env           string
}

func Load() Config {
	return Config{
		Port:          env("PORT", "8080"),
		PgDSN:         env("PG_DSN", "postgres://tiket:tiket@localhost:5432/tiket?sslmode=disable"),
		PgReadDSN:     env("PG_READ_DSN", ""),
		RedisAddr:     env("REDIS_ADDR", "localhost:6379"),
		RedisPassword: env("REDIS_PASSWORD", ""),
		NATSUrl:       env("NATS_URL", "nats://localhost:4222"),
		JWTSecret:     env("JWT_SECRET", "change-me-super-secret-32chars!!"),
		JWTIssuer:     env("JWT_ISSUER", "tiket-waiting-room"),
		JWTAudience:   env("JWT_AUDIENCE", "tiket-checkout"),
		HoldTTL:       envInt("HOLD_TTL_SEC", 600),
		MaxPerUser:    envInt("MAX_TICKET_PER_USER", 4),
		Env:           env("ENV", "development"),
	}
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func envInt(k string, d int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return d
}
