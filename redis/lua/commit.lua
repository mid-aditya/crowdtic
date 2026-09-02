-- COMMIT.lua — Atomic HELD -> SOLD transition
-- Guarantees: all-or-nothing, idempotent, single round-trip.
--
-- KEYS[1]            = inventory:{event_id}:{category_id}
-- KEYS[2..N]          = seat:{seat_id}  (each key MUST contain hash-tag {event_id}
--                       e.g. seat:{<event_id>}:<category_id>:A-0001)
--
-- ARGV[1] = hold_id     (ULID from HOLD.lua)
-- ARGV[2] = user_id
-- ARGV[3] = event_id    (for hold key & idempotency namespace)
-- ARGV[4] = order_id    (optional, ULID/UUID — enables idempotent retry)
-- ARGV[5] = sold_at_ms  (optional, unix ms; defaults to server TIME)
--
-- Inventory hash fields expected: available, held, sold, quota
-- Seat hash fields expected:  status, held_by, hold_id, expires_at, version
--
-- Returns:
--   {ok="SOLD", hold_id=..., seats=N, order_id=...} on success
--   {ok="ALREADY_COMMITTED", order_id=...}          on idempotent replay
--   {err="INV_NOT_FOUND"}                            if inventory missing
--   {err="HOLD_NOT_FOUND"}                           if hold key missing and seats not already SOLD
--   {err="SEAT_NOT_HELD:<key>:<status>"}             if any seat not HELD (and not already SOLD with same hold)
--   {err="HOLD_MISMATCH:<key>"} / {err="USER_MISMATCH:<key>"}
--   {err="SEAT_ALREADY_SOLD:<key>"}                  if seat sold by another hold
--
-- Notes:
--   - Idempotency: if order_id provided we store order:hold:{event_id}:{hold_id} -> order_id (EX 24h)
--     and order:{event_id}:{order_id} -> hold_id. Replays with same hold_id+order_id return ALREADY_COMMITTED.
--   - If seats are already SOLD with the SAME hold_id+user_id we treat as success (crash-retry safe).
--   - Does NOT touch user:limit:{event_id}:{user_id} — limit stays after purchase (hold already counted it).

local invKey = KEYS[1]
local holdId = ARGV[1]
local userId = ARGV[2]
local eventId = ARGV[3]
local orderId = ARGV[4]
local soldAtMs = ARGV[5]

if not holdId or holdId == "" then return {err="HOLD_ID_REQUIRED"} end
if not userId or userId == "" then return {err="USER_ID_REQUIRED"} end
if not eventId or eventId == "" then return {err="EVENT_ID_REQUIRED"} end

local need = #KEYS - 1
if need <= 0 then return {err="NO_SEATS"} end

-- 0) Inventory must exist
local exists = redis.call("EXISTS", invKey)
if exists == 0 then return {err="INV_NOT_FOUND"} end

-- 1) Idempotency fast-path (if order_id provided)
if orderId and orderId ~= "" then
  local idemKey = "order:hold:{" .. eventId .. "}:" .. holdId
  local existing = redis.call("GET", idemKey)
  if existing then
    if existing == orderId then
      return {ok="ALREADY_COMMITTED", order_id=existing, hold_id=holdId}
    else
      -- same hold committed under different order_id — treat as already sold
      return {ok="ALREADY_COMMITTED", order_id=existing, hold_id=holdId}
    end
  end
  -- Also check reverse index
  local revKey = "order:{" .. eventId .. "}:" .. orderId
  local rev = redis.call("GET", revKey)
  if rev and rev == holdId then
    return {ok="ALREADY_COMMITTED", order_id=orderId, hold_id=holdId}
  end
end

local holdKey = "hold:{" .. eventId .. "}:" .. holdId
local holdExists = redis.call("EXISTS", holdKey)

-- 2) Validate each seat
local alreadySoldCount = 0
for i = 2, #KEYS do
  local seatKey = KEYS[i]
  local st = redis.call("HGET", seatKey, "status")

  if st == "SOLD" then
    -- Idempotent replay: same hold+user already marked SOLD
    local hid = redis.call("HGET", seatKey, "hold_id")
    local hb  = redis.call("HGET", seatKey, "held_by")
    if hid == holdId and hb == userId then
      alreadySoldCount = alreadySoldCount + 1
    else
      return {err="SEAT_ALREADY_SOLD:" .. seatKey}
    end
  elseif st ~= "HELD" then
    -- If hold key gone and seat not SOLD, it's an expiry — surface clearly
    if holdExists == 0 and alreadySoldCount == 0 then
      -- check if seat is AVAILABLE again (released by reaper)
      return {err="HOLD_NOT_FOUND"}
    end
    return {err="SEAT_NOT_HELD:" .. seatKey .. ":" .. (st or "nil")}
  else
    local hid = redis.call("HGET", seatKey, "hold_id")
    if hid ~= holdId then
      return {err="HOLD_MISMATCH:" .. seatKey}
    end
    local hb = redis.call("HGET", seatKey, "held_by")
    if hb ~= userId then
      return {err="USER_MISMATCH:" .. seatKey}
    end
    -- Optional: check expires_at still in future (defensive; Redis PEXPIRE is source of truth)
    -- we do not fail on stale expires_at — if PEXPIRE hasn't fired, HELD is still valid
  end
end

-- All seats already SOLD with same hold => pure idempotent replay (no hold key maybe already deleted)
if alreadySoldCount == need then
  if orderId and orderId ~= "" then
    -- ensure idempotency keys exist for future replays
    redis.call("SET", "order:hold:{" .. eventId .. "}:" .. holdId, orderId, "EX", 86400)
    redis.call("SET", "order:{" .. eventId .. "}:" .. orderId, holdId, "EX", 86400)
  end
  return {ok="ALREADY_COMMITTED", hold_id=holdId, seats=need, order_id=orderId or ""}
end

-- 3) Resolve sold timestamp
local ts = soldAtMs
if not ts or ts == "" then
  local t = redis.call("TIME")
  -- t = {seconds, microseconds}
  ts = tostring(tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000))
end

-- 4) Transition HELD -> SOLD (only seats still HELD)
for i = 2, #KEYS do
  local seatKey = KEYS[i]
  local st = redis.call("HGET", seatKey, "status")
  if st == "HELD" then
    redis.call("HMSET", seatKey,
      "status", "SOLD",
      "sold_at", ts,
      "sold_by", userId
    )
    redis.call("HDEL", seatKey, "expires_at")
    redis.call("PERSIST", seatKey)
    -- bump version for optimistic concurrency in DB sync
    redis.call("HINCRBY", seatKey, "version", 1)
  end
end

-- 5) Inventory accounting: held -> sold (available already deducted at HOLD time)
-- Use HINCRBY which creates field if missing; ensure held doesn't go negative
local heldRaw = redis.call("HGET", invKey, "held")
local heldVal = tonumber(heldRaw or "0")
-- Clamp decrement to actual held to avoid negative on crash-retry partial states
local decr = need
if heldVal < need then decr = heldVal end
if decr > 0 then
  redis.call("HINCRBY", invKey, "held", -decr)
end
redis.call("HINCRBY", invKey, "sold", need)
-- available stays as-is (already -need at HOLD)

-- 6) Cleanup hold key
redis.call("DEL", holdKey)

-- 7) Idempotency ledger (24h)
if orderId and orderId ~= "" then
  redis.call("SET", "order:hold:{" .. eventId .. "}:" .. holdId, orderId, "EX", 86400)
  redis.call("SET", "order:{" .. eventId .. "}:" .. orderId, holdId, "EX", 86400)
end

return {ok="SOLD", hold_id=holdId, seats=need, order_id=orderId or ""}
