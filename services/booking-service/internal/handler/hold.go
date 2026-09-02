package handler

import (
	"fmt"
	"net/http"
	"time"

	rlua "tiket-booking/internal/redis"
	"tiket-booking/internal/store"

	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
)

type HoldHandler struct {
	RDB     *redis.Client
	Store   *store.Store
	Scripts *rlua.Scripts
	NATS    *nats.Conn
	HoldTTL int
}

type HoldRequest struct {
	EventID        string   `json:"event_id" binding:"required"`
	CategoryID     string   `json:"category_id" binding:"required"`
	SeatIDs        []string `json:"seat_ids" binding:"required"`
	IdempotencyKey string   `json:"idempotency_key" binding:"required"`
}

func (h *HoldHandler) Handle(c *gin.Context) {
	var req HoldRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	qUserID, _ := c.Get("queue_user_id")
	qEventID, _ := c.Get("queue_event_id")
	// Enforce queue event == request event
	if qEventID != req.EventID {
		c.JSON(http.StatusForbidden, gin.H{"error": "queue token event mismatch"})
		return
	}
	userID, err := uuid.Parse(qUserID.(string))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user in queue token"})
		return
	}
	eventID, _ := uuid.Parse(req.EventID)
	catID, _ := uuid.Parse(req.CategoryID)
	idem, _ := uuid.Parse(req.IdempotencyKey)

	// Idempotency check (DB)
	if existing, found, _ := h.Store.CheckIdempotency(c.Request.Context(), idem, userID); found && existing != nil {
		c.JSON(http.StatusOK, gin.H{"idempotent": true, "order_id": existing.String(), "message": "already processed"})
		return
	}

	// Validate seat count vs max per user (from event)
	maxPerUser := 4
	if m, _, err := h.Store.GetEvent(c.Request.Context(), eventID); err == nil {
		maxPerUser = m
	}

	if len(req.SeatIDs) == 0 || len(req.SeatIDs) > maxPerUser {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("seat count must be 1..%d", maxPerUser)})
		return
	}

	// Build Redis keys — must be slot-aligned via {event_id}
	invKey := fmt.Sprintf("inventory:{%s}:%s", req.EventID, req.CategoryID)
	keys := []string{invKey}
	for _, sid := range req.SeatIDs {
		keys = append(keys, fmt.Sprintf("seat:{%s}:%s:%s", req.EventID, req.CategoryID, sid))
		// seat key format: seat:{event}:{cat}:{seatId} — but lua expects seat:{id}
		// We use seat:{event_id}:seat_id style; ensure slot tag
	}
	// Correct seat keys for Lua (slot-safe)
	keys = []string{invKey}
	for _, sid := range req.SeatIDs {
		keys = append(keys, fmt.Sprintf("seat:{%s}:%s", req.EventID, sid))
	}

	holdID := uuid.NewString()
	ttl := h.HoldTTL
	expiresAtMs := time.Now().Add(time.Duration(ttl) * time.Second).UnixMilli()

	_, err = h.Scripts.ExecHold(c.Request.Context(), h.RDB, keys,
		userID.String(), holdID, ttl, expiresAtMs, maxPerUser, req.EventID)
	if err != nil {
		msg := err.Error()
		status := http.StatusConflict
		if contains(msg, "SOLD_OUT") {
			status = http.StatusConflict
		} else if contains(msg, "LIMIT_EXCEEDED") {
			status = http.StatusTooManyRequests
		} else if contains(msg, "SEAT_TAKEN") {
			status = http.StatusConflict
		} else if contains(msg, "INV_NOT_FOUND") {
			status = http.StatusNotFound
		}
		c.JSON(status, gin.H{"error": msg})
		return
	}

	// Mirror to Postgres reservations
	seatUUIDs := make([]uuid.UUID, 0, len(req.SeatIDs))
	for _, s := range req.SeatIDs {
		if u, err := uuid.Parse(s); err == nil {
			seatUUIDs = append(seatUUIDs, u)
		}
	}
	expiresAt := time.UnixMilli(expiresAtMs)
	_ = h.Store.InsertReservation(c.Request.Context(), holdID, userID, eventID, catID, seatUUIDs, expiresAt)

	// Audit + NATS event
	go h.Store.Audit(c.Request.Context(), &userID, &eventID, c.ClientIP(), c.GetHeader("User-Agent"), c.GetHeader("x-fingerprint"), "HOLD")
	if h.NATS != nil {
		_ = h.NATS.Publish("order.hold.created", []byte(fmt.Sprintf(`{"hold_id":"%s","user_id":"%s","event_id":"%s","seat_count":%d,"expires_at":%d}`, holdID, userID, eventID, len(req.SeatIDs), expiresAtMs)))
	}

	c.JSON(http.StatusCreated, gin.H{
		"hold_id":    holdID,
		"expires_at": expiresAt.UTC().Format(time.RFC3339),
		"ttl_sec":    ttl,
		"seats":      len(req.SeatIDs),
	})
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i <= len(s)-len(sub); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
