package handler

import (
	"context"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"time"

	blockchain "tiket-booking/internal/blockchain"
	rlua "tiket-booking/internal/redis"
	"tiket-booking/internal/store"

	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"golang.org/x/crypto/sha3"
)

type CommitHandler struct {
	RDB     *redis.Client
	Store   *store.Store
	Scripts *rlua.Scripts
	NATS    *nats.Conn
	BC      *blockchain.NFTClient // nil if BlockchainEnabled=false
}

type CommitRequest struct {
	HoldID         string   `json:"hold_id" binding:"required"`
	IdempotencyKey string   `json:"idempotency_key" binding:"required"`
	SeatIDs        []string `json:"seat_ids"` // optional, for validation
}

func (h *CommitHandler) Handle(c *gin.Context) {
	var req CommitRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	qUserID, _ := c.Get("queue_user_id")
	qEventID, _ := c.Get("queue_event_id")
	userID, _ := uuid.Parse(qUserID.(string))
	eventID, _ := uuid.Parse(qEventID.(string))
	idem, _ := uuid.Parse(req.IdempotencyKey)

	if existing, found, _ := h.Store.CheckIdempotency(c.Request.Context(), idem, userID); found && existing != nil {
		c.JSON(http.StatusOK, gin.H{"idempotent": true, "order_id": existing.String()})
		return
	}

	// Build keys: need inventory + seats. We fetch seat list from reservation hold key
	// For simplicity, require client to send seat_ids; fallback: lookup from DB via hold_id
	if len(req.SeatIDs) == 0 {
		// Try fetch from Redis hold key
		holdKey := fmt.Sprintf("hold:{%s}:%s", qEventID.(string), req.HoldID)
		m, _ := h.RDB.HGetAll(c.Request.Context(), holdKey).Result()
		if seats, ok := m["seats"]; ok && seats != "" {
			// seats stored as comma-joined keys, extract ids
			// fallback: query DB
		}
		var seatIDs []uuid.UUID
		err := h.Store.Pool.QueryRow(c.Request.Context(), `SELECT seat_ids FROM reservations WHERE hold_id=$1`, req.HoldID).Scan(&seatIDs)
		if err == nil {
			for _, s := range seatIDs {
				req.SeatIDs = append(req.SeatIDs, s.String())
			}
		}
	}

	if len(req.SeatIDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "seat_ids required or hold not found"})
		return
	}

	// Need category for inventory key — fetch from reservation
	var catID uuid.UUID
	_ = h.Store.Pool.QueryRow(c.Request.Context(), `SELECT category_id FROM reservations WHERE hold_id=$1`, req.HoldID).Scan(&catID)
	if catID == uuid.Nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "reservation not found"})
		return
	}

	invKey := fmt.Sprintf("inventory:{%s}:%s", qEventID.(string), catID.String())
	keys := []string{invKey}
	for _, sid := range req.SeatIDs {
		keys = append(keys, fmt.Sprintf("seat:{%s}:%s", qEventID.(string), sid))
	}

	orderID := uuid.New()
	soldAtMs := time.Now().UnixMilli()

	_, err := h.Scripts.ExecCommit(c.Request.Context(), h.RDB, keys,
		req.HoldID, userID.String(), qEventID.(string), orderID.String(), soldAtMs)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}

	// Persist to Postgres (prices fetched from ticket_categories)
	var unitPrice int64 = 0
	_ = h.Store.Pool.QueryRow(c.Request.Context(), `SELECT price FROM ticket_categories WHERE id=$1`, catID).Scan(&unitPrice)
	total := unitPrice * int64(len(req.SeatIDs))
	seatUUIDs := make([]uuid.UUID, 0, len(req.SeatIDs))
	prices := make([]int64, 0, len(req.SeatIDs))
	for _, s := range req.SeatIDs {
		if u, err := uuid.Parse(s); err == nil {
			seatUUIDs = append(seatUUIDs, u)
			prices = append(prices, unitPrice)
		}
	}

	if err := h.Store.InsertOrderTx(c.Request.Context(), orderID, userID, eventID, req.HoldID, total, idem, seatUUIDs, prices); err != nil {
		// If DB fails, we already committed in Redis — log and return 202 for reconciliation
		c.JSON(http.StatusAccepted, gin.H{"order_id": orderID.String(), "warning": "redis committed, db pending reconciliation", "detail": err.Error()})
		return
	}

	if h.NATS != nil {
		_ = h.NATS.Publish("order.paid", []byte(fmt.Sprintf(`{"order_id":"%s","hold_id":"%s","user_id":"%s","event_id":"%s","total":%d}`, orderID, req.HoldID, userID, eventID, total)))
	}
	go h.Store.Audit(c.Request.Context(), &userID, &eventID, c.ClientIP(), c.GetHeader("User-Agent"), "", "COMMIT")

	// Blockchain minting — non-blocking, after PG committed
	if h.BC != nil {
		go h.mintNFTAsync(c.Request.Context(), userID.String(), eventID, req.HoldID, seatUUIDs, unitPrice)
	}

	c.JSON(http.StatusOK, gin.H{"order_id": orderID.String(), "total": total, "status": "PAID"})
}

// mintNFTAsync mints NFT tickets for committed seats. Non-blocking.
func (h *CommitHandler) mintNFTAsync(ctx context.Context, userID string, eventID uuid.UUID, holdID string, seats []uuid.UUID, unitPrice int64) {
	if h.BC == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	for _, seat := range seats {
		metadataURI := fmt.Sprintf("https://tiket.example/nft/%s/%s", eventID.String(), seat.String())
		txHash, tokenID, err := h.BC.MintTicket(
			ctx,
			userID,                             // to address (wallet)
			eventIDToBytes32(eventID.String()), // eventId as bytes32
			0,                                  // seatNumber
			idrToWei(unitPrice),                // faceValue in wei
			false,                              // kycRequired
			metadataURI,
		)
		if err != nil {
			log.Printf("WARN blockchain mint failed seat=%s: %v (PG order still valid)", seat, err)
		} else {
			log.Printf("NFT minted seat=%s tokenID=%s tx=%s", seat, tokenID, txHash)
		}
	}
}

func eventIDToBytes32(s string) [32]byte {
	h := sha3.NewLegacyKeccak256()
	h.Write([]byte(s))
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

// idrToWei converts IDR (smallest unit) to wei (1e18 = 1 ETH).
// For IDR: 1 unit = 1 rupiah. For ETH: 1 ether = 1e18 wei.
// faceValue parameter is in IDR smallest unit; convert to wei at 1:1 for local dev.
func idrToWei(idr int64) *big.Int {
	return new(big.Int).Mul(big.NewInt(idr), weiPerIdrUnit())
}

func weiPerIdrUnit() *big.Int {
	// 1 IDR = 1e12 wei (for demo; real price feed should set this)
	return big.NewInt(1_000_000_000_000) // 1e12
}

// ponytail: weiPerIdrUnit is a fixed demo ratio. In production, fetch from a price oracle
// (e.g. Chainlink ETH/USD + conversion) so NFT faceValue reflects real ETH value.
