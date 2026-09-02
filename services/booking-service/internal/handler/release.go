package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	rdb "tiket-booking/internal/redis"
	"tiket-booking/internal/store"

	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/google/uuid"
)

// ReleaseHandler handles explicit release and background reaper.
type ReleaseHandler struct {
	Store     *store.Store
	RDB       *redis.Client
	Scripter  *rdb.Scripts
	Publisher Publisher
}

// DELETE /api/hold/:holdId — explicit cancel by owner
func (h *ReleaseHandler) Release(c *gin.Context) {
	holdID := c.Param("holdId")
	if holdID == "" {
		holdID = c.Param("holdID")
	}
	if holdID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "holdId required"})
		return
	}
	userIDStr := c.GetString("queue_user_id")
	// fallback to user_id for backward compat
	if userIDStr == "" {
		userIDStr = c.GetString("user_id")
	}
	ctx := c.Request.Context()

	res, err := h.Store.GetReservation(ctx, holdID)
	if err != nil {
		slog.Error("get reservation failed", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
		return
	}
	if res == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "hold not found"})
		return
	}
	// Only owner can release (if authenticated)
	if userIDStr != "" {
		if uid, err := uuid.Parse(userIDStr); err == nil && uid != res.UserID {
			c.JSON(http.StatusForbidden, gin.H{"error": "not owner"})
			return
		}
	}

	if err := h.releaseHold(ctx, res); err != nil {
		slog.Error("release hold failed", "err", err, "hold_id", holdID)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to release"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "released", "hold_id": holdID})
}

func mustJSON(v interface{}) []byte { b, _ := json.Marshal(v); return b }

func (h *ReleaseHandler) releaseHold(ctx context.Context, res *store.Reservation) error {
	eventIDStr := res.EventID.String()
	invKey := fmt.Sprintf("inventory:{%s}:%s", eventIDStr, res.CategoryID.String())
	seatKeys := make([]string, 0, len(res.SeatIDs))
	for _, sid := range res.SeatIDs {
		seatKeys = append(seatKeys, fmt.Sprintf("seat:{%s}:%s", eventIDStr, sid.String()))
	}
	keys := append([]string{invKey}, seatKeys...)

	raw, err := h.Scripter.ExecRelease(ctx, h.RDB, keys, res.HoldID, res.UserID.String(), eventIDStr)
	if err != nil {
		return fmt.Errorf("redis release: %w", err)
	}
	if m, err := rdb.ParseReply(raw); err == nil {
		if e, ok := m["err"]; ok && e != nil && fmt.Sprint(e) != "" {
			slog.Warn("release lua returned err", "err", e, "hold_id", res.HoldID)
		}
	}
	if err := h.Store.DeleteReservation(ctx, res.HoldID); err != nil {
		slog.Warn("delete reservation failed after release", "err", err, "hold_id", res.HoldID)
	}
	if h.Publisher != nil {
		if data, err := json.Marshal(map[string]interface{}{"type": "order.hold.released", "hold_id": res.HoldID, "user_id": res.UserID.String()}); err == nil {
			_ = h.Publisher.PublishAsync("order.hold.released", data)
		}
	}
	uid := res.UserID
	eid := res.EventID
	_ = h.Store.InsertAuditLog(ctx, &uid, &eid, "", "", "", "hold.released", mustJSON(map[string]interface{}{"hold_id": res.HoldID}))
	return nil
}

// Reaper runs periodically to release expired holds (cron).
type Reaper struct {
	Store     *store.Store
	RDB       *redis.Client
	Scripter  *rdb.Scripts
	Publisher Publisher
	Interval  time.Duration
	BatchSize int
}

func NewReaper(s *store.Store, rdb2 *redis.Client, scr *rdb.Scripts, pub Publisher, interval time.Duration) *Reaper {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	return &Reaper{Store: s, RDB: rdb2, Scripter: scr, Publisher: pub, Interval: interval, BatchSize: 100}
}

// Start runs the reaper loop until ctx is cancelled.
func (r *Reaper) Start(ctx context.Context) {
	ticker := time.NewTicker(r.Interval)
	defer ticker.Stop()
	slog.Info("hold reaper started", "interval", r.Interval)
	for {
		select {
		case <-ctx.Done():
			slog.Info("hold reaper stopped")
			return
		case <-ticker.C:
			if err := r.SweepOnce(ctx); err != nil {
				slog.Error("reaper sweep failed", "err", err)
			}
		}
	}
}

// SweepOnce releases up to BatchSize expired reservations.
func (r *Reaper) SweepOnce(ctx context.Context) error {
	reservations, err := r.Store.ExpiredReservations(ctx, r.BatchSize)
	if err != nil {
		return fmt.Errorf("fetch expired: %w", err)
	}
	if len(reservations) == 0 {
		return nil
	}
	slog.Info("reaper sweeping", "count", len(reservations))
	for i := range reservations {
		res := &reservations[i]
		// Per-hold release with short timeout
		c2, cancel := context.WithTimeout(ctx, 5*time.Second)
		eventIDStr := res.EventID.String()
		invKey := fmt.Sprintf("inventory:{%s}:%s", eventIDStr, res.CategoryID.String())
		seatKeys := make([]string, 0, len(res.SeatIDs))
		for _, sid := range res.SeatIDs {
			seatKeys = append(seatKeys, fmt.Sprintf("seat:{%s}:%s", eventIDStr, sid.String()))
		}
		keys := append([]string{invKey}, seatKeys...)
		_, _ = r.Scripter.ExecRelease(c2, r.RDB, keys, res.HoldID, res.UserID.String(), eventIDStr)
		_ = r.Store.DeleteReservation(c2, res.HoldID)
		if r.Publisher != nil {
			if data, err := json.Marshal(map[string]interface{}{"type": "order.hold.expired", "hold_id": res.HoldID, "user_id": res.UserID.String()}); err == nil {
				_ = r.Publisher.PublishAsync("order.hold.expired", data)
			}
		}
		cancel()
		slog.Info("reaper released", "hold_id", res.HoldID, "seats", len(res.SeatIDs))
	}
	return nil
}
