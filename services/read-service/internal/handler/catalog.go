package handler

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Catalog struct {
	Pool *pgxpool.Pool
	RDB  *redis.Client
}

func (h *Catalog) ListEvents(c *gin.Context) {
	// Cache header for CDN
	c.Header("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60")
	rows, err := h.Pool.Query(c.Request.Context(), `SELECT id, title, slug, on_sale_at, status, max_ticket_per_user FROM events ORDER BY on_sale_at DESC LIMIT 50`)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	type E struct {
		ID         string `json:"id"`
		Title      string `json:"title"`
		Slug       string `json:"slug"`
		OnSaleAt   string `json:"on_sale_at"`
		Status     string `json:"status"`
		MaxPerUser int    `json:"max_per_user"`
	}
	var out []E
	for rows.Next() {
		var e E
		var onSale string
		var max int
		_ = rows.Scan(&e.ID, &e.Title, &e.Slug, &onSale, &e.Status, &max)
		e.OnSaleAt = onSale
		e.MaxPerUser = max
		out = append(out, e)
	}
	c.JSON(200, gin.H{"events": out})
}

func (h *Catalog) GetEvent(c *gin.Context) {
	id := c.Param("id")
	c.Header("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60")
	var title, slug, status, onSale string
	var max int
	err := h.Pool.QueryRow(c.Request.Context(), `SELECT title, slug, status, on_sale_at, max_ticket_per_user FROM events WHERE id=$1 OR slug=$1`, id).Scan(&title, &slug, &status, &onSale, &max)
	if err != nil {
		c.JSON(404, gin.H{"error": "event not found"})
		return
	}
	// inventory from Redis
	ctx := context.Background()
	keys, _ := h.RDB.Keys(ctx, "inventory:{"+id+"}:*").Result()
	inv := []gin.H{}
	for _, k := range keys {
		m, _ := h.RDB.HGetAll(ctx, k).Result()
		inv = append(inv, gin.H{"key": k, "inventory": m})
	}
	c.JSON(200, gin.H{"id": id, "title": title, "slug": slug, "status": status, "on_sale_at": onSale, "max_per_user": max, "inventory": inv})
}

func (h *Catalog) GetSeats(c *gin.Context) {
	id := c.Param("id")
	cat := c.Query("category")
	c.Header("Cache-Control", "public, s-maxage=10, stale-while-revalidate=30")
	q := `SELECT id, seat_number, status, category_id FROM seats WHERE event_id=$1`
	args := []interface{}{id}
	if cat != "" {
		q += ` AND category_id=$2`
		args = append(args, cat)
	}
	q += ` ORDER BY seat_number LIMIT 2000`
	rows, err := h.Pool.Query(c.Request.Context(), q, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	type S struct{ ID, SeatNumber, Status, CategoryID string }
	var out []S
	for rows.Next() {
		var s S
		_ = rows.Scan(&s.ID, &s.SeatNumber, &s.Status, &s.CategoryID)
		out = append(out, s)
	}
	c.JSON(200, gin.H{"event_id": id, "seats": out, "count": len(out)})
}

func Health(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true, "service": "read"}) }
