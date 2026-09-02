-- HOLD.lua — Atomic Seat Hold (10 menit)
-- KEYS[1] = inventory:{event_id}:{category_id}
-- KEYS[2..N] = seat:{seat_id} (hash slot must be {event_id})
-- ARGV[1] = user_id
-- ARGV[2] = hold_id (ULID)
-- ARGV[3] = ttl seconds (600)
-- ARGV[4] = expires_at_ms (unix ms)
-- ARGV[5] = max_per_user
-- ARGV[6] = event_id (for user limit key)
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

-- hold:{hold_id} -> set with TTL for reaper
redis.call('HMSET', 'hold:{'..ARGV[6]..'}:'..ARGV[2], 'user_id',ARGV[1],'seats', table.concat(KEYS,',',2), 'expires_at',ARGV[4])
redis.call('EXPIRE', 'hold:{'..ARGV[6]..'}:'..ARGV[2], tonumber(ARGV[3]))

return {ok="HELD", hold_id=ARGV[2], seats=need}
