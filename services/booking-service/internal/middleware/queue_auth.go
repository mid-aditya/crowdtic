package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

func QueueAuth(secret, issuer, audience string) gin.HandlerFunc {
	return func(c *gin.Context) {
		tokenStr := ""
		if h := c.GetHeader("Authorization"); strings.HasPrefix(h, "Bearer ") {
			tokenStr = strings.TrimPrefix(h, "Bearer ")
		} else if h := c.GetHeader("x-queue-token"); h != "" {
			tokenStr = h
		} else if ck, err := c.Cookie("queue_token"); err == nil {
			tokenStr = ck
		} else {
			tokenStr = c.Query("queue_token")
		}
		if tokenStr == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "queue_token required", "hint": "join waiting room first"})
			return
		}
		tok, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
			return []byte(secret), nil
		}, jwt.WithIssuer(issuer), jwt.WithAudience(audience), jwt.WithLeeway(5e9))
		if err != nil || !tok.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid queue token", "detail": errString(err)})
			return
		}
		claims, ok := tok.Claims.(jwt.MapClaims)
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid claims"})
			return
		}
		uid, _ := claims["user_id"].(string)
		eid, _ := claims["event_id"].(string)
		jti, _ := claims["jti"].(string)
		c.Set("queue_user_id", uid)
		c.Set("queue_event_id", eid)
		c.Set("queue_jti", jti)
		c.Set("queue_claims", claims)
		c.Header("x-queue-user-id", uid)
		c.Next()
	}
}

func errString(err error) string {
	if err == nil {
		return "unauthorized"
	}
	return err.Error()
}
