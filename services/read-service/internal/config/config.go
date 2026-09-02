package config

import "os"

type Config struct {
	Port      string
	PgReadDSN string
	RedisAddr string
	Env       string
}

func Load() Config {
	return Config{
		Port:      env("PORT", "8081"),
		PgReadDSN: env("PG_READ_DSN", env("PG_DSN", "postgres://tiket:tiket@localhost:5432/tiket?sslmode=disable")),
		RedisAddr: env("REDIS_ADDR", "localhost:6379"),
		Env:       env("ENV", "development"),
	}
}
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
