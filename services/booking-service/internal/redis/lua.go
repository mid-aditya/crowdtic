package rlua

import (
	"context"

	"github.com/go-redis/redis/v8"
)

// Scripts holds pre-loaded Lua scripts for atomic inventory operations.
// Field names use *Script suffix to avoid collision with method names.
type Scripts struct {
	HoldScript    *redis.Script
	ReleaseScript *redis.Script
	CommitScript  *redis.Script
}

func New() *Scripts {
	holdSrc := `
local invKey = KEYS[1]
local available = tonumber(redis.call('HGET', invKey, 'available'))
if not available then return {err="INV_NOT_FOUND"} end
local need = #KEYS - 1
if available < need then return {err="SOLD_OUT"} end
local limitKey = 'user:limit:{'..ARGV[6]..'}:'..ARGV[1]
local cur = tonumber(redis.call('GET', limitKey) or "0")
if cur + need > tonumber(ARGV[5]) then return {err="LIMIT_EXCEEDED"} end
for i=2,#KEYS do
  local st = redis.call('HGET', KEYS[i], 'status')
  if st ~= 'AVAILABLE' then return {err="SEAT_TAKEN:"..KEYS[i]} end
end
for i=2,#KEYS do
  redis.call('HMSET', KEYS[i], 'status','HELD','held_by',ARGV[1],'hold_id',ARGV[2],'expires_at',ARGV[4])
  redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[3])*1000)
end
redis.call('HINCRBY', invKey, 'available', -need)
redis.call('HINCRBY', invKey, 'held', need)
redis.call('INCRBY', limitKey, need)
redis.call('EXPIRE', limitKey, 86400)
redis.call('HMSET', 'hold:{'..ARGV[6]..'}:'..ARGV[2], 'user_id',ARGV[1],'seats', table.concat(KEYS,',',2), 'expires_at',ARGV[4])
redis.call('EXPIRE', 'hold:{'..ARGV[6]..'}:'..ARGV[2], tonumber(ARGV[3]))
return {ok="HELD", hold_id=ARGV[2]}
`
	releaseSrc := `
local invKey = KEYS[1]
local need = #KEYS - 1
for i=2,#KEYS do
  local hold = redis.call('HGET', KEYS[i], 'hold_id')
  if hold == ARGV[1] then
    redis.call('HMSET', KEYS[i], 'status','AVAILABLE')
    redis.call('HDEL', KEYS[i], 'held_by','hold_id','expires_at')
    redis.call('PERSIST', KEYS[i])
  end
end
redis.call('HINCRBY', invKey, 'available', need)
redis.call('HINCRBY', invKey, 'held', -need)
local limitKey = 'user:limit:{'..ARGV[3]..'}:'..ARGV[2]
redis.call('DECRBY', limitKey, need)
redis.call('DEL', 'hold:{'..ARGV[3]..'}:'..ARGV[1])
return {ok="RELEASED"}
`
	commitSrc := `
local invKey = KEYS[1]
local need = #KEYS - 1
local orderKey = 'order:hold:{'..ARGV[3]..'}:'..ARGV[1]
local existing = redis.call('GET', orderKey)
if existing then return {ok="ALREADY_COMMITTED", order_id=existing} end
for i=2,#KEYS do
  local st = redis.call('HGET', KEYS[i], 'status')
  local hd = redis.call('HGET', KEYS[i], 'hold_id')
  local hb = redis.call('HGET', KEYS[i], 'held_by')
  if st == 'SOLD' and hd == ARGV[1] and hb == ARGV[2] then
  elseif st ~= 'HELD' or hd ~= ARGV[1] or hb ~= ARGV[2] then
    return {err="HOLD_INVALID:"..KEYS[i]..":"..(st or "nil")}
  end
end
for i=2,#KEYS do
  local st = redis.call('HGET', KEYS[i], 'status')
  if st == 'HELD' then
    redis.call('HMSET', KEYS[i], 'status','SOLD','sold_at',ARGV[5])
    redis.call('PERSIST', KEYS[i])
  end
end
redis.call('HINCRBY', invKey, 'held', -need)
redis.call('HINCRBY', invKey, 'sold', need)
redis.call('SET', orderKey, ARGV[4], 'EX', 86400)
redis.call('SET', 'order:{'..ARGV[3]..'}:'..ARGV[4], ARGV[1], 'EX', 86400)
redis.call('DEL', 'hold:{'..ARGV[3]..'}:'..ARGV[1])
return {ok="COMMITTED", order_id=ARGV[4]}
`
	return &Scripts{
		HoldScript:    redis.NewScript(holdSrc),
		ReleaseScript: redis.NewScript(releaseSrc),
		CommitScript:  redis.NewScript(commitSrc),
	}
}

func (s *Scripts) ExecHold(ctx context.Context, rdb *redis.Client, keys []string, args ...interface{}) (interface{}, error) {
	return s.HoldScript.Run(ctx, rdb, keys, args...).Result()
}
func (s *Scripts) ExecRelease(ctx context.Context, rdb *redis.Client, keys []string, args ...interface{}) (interface{}, error) {
	return s.ReleaseScript.Run(ctx, rdb, keys, args...).Result()
}
func (s *Scripts) ExecCommit(ctx context.Context, rdb *redis.Client, keys []string, args ...interface{}) (interface{}, error) {
	return s.CommitScript.Run(ctx, rdb, keys, args...).Result()
}
