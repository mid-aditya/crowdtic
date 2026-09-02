-- seed.lua — helper to seed inventory + seats into Redis
-- Usage (redis-cli):
--   EVAL "$(cat redis/seed.lua)" 0 <event_id> <category_id> <quota> <seat_prefix> [price]
-- Example:
--   EVAL "$(cat redis/seed.lua)" 0 550e8400-e29b-41d4-a716-446655440000 cat-vip 500 "A" 1500000
--
-- Keys created:
--   inventory:{event_id}:{category_id}  -> { available, held, sold, quota, price }
--   seat:{event_id}:{category_id}:<prefix>-0001 .. <prefix>-<quota>
--     each seat: { status="AVAILABLE", version=1, category_id, event_id }
--   meta:{event_id}                     -> { on_sale_at } (only if not exists)
--
-- Behavior:
--   - Idempotent-safe: if seats already exist, only missing seats are created.
--   - Seat keys use hash-tag {event_id} for Redis Cluster slot colocation with inventory/hold keys.
--   - Safe to run on Upstash/Redis Cluster. Keys are written one-by-one to keep slot safety.
--
-- ARGV layout: 1=event_id 2=category_id 3=quota 4=seat_prefix 5=price(optional) 6=on_sale_at_iso8601(optional)

local eventId   = ARGV[1]
local catId     = ARGV[2]
local quotaStr  = ARGV[3]
local prefix    = ARGV[4] or "S"
local priceStr  = ARGV[5]
local onSaleIso = ARGV[6]

if not eventId or eventId == "" then return {err="event_id required (ARGV1)"} end
if not catId or catId == "" then return {err="category_id required (ARGV2)"} end
if not quotaStr or quotaStr == "" then return {err="quota required (ARGV3)"} end

local quota = tonumber(quotaStr)
if not quota or quota <= 0 then return {err="quota must be >0"} end
if quota > 50000 then return {err="quota too large (max 50000 per category per seed call)"} end

local invKey = "inventory:{" .. eventId .. "}:" .. catId
local metaKey = "meta:{" .. eventId .. "}"

-- 1) Inventory
local exists = redis.call("EXISTS", invKey)
if exists == 0 then
  local price = tonumber(priceStr or "0") or 0
  redis.call("HMSET", invKey,
    "quota", tostring(quota),
    "available", tostring(quota),
    "held", "0",
    "sold", "0",
    "price", tostring(price),
    "category_id", catId,
    "event_id", eventId
  )
else
  -- if inventory exists, sync quota/available if quota grew
  local curQuota = tonumber(redis.call("HGET", invKey, "quota") or "0")
  local curAvail = tonumber(redis.call("HGET", invKey, "available") or "0")
  local curSold  = tonumber(redis.call("HGET", invKey, "sold") or "0")
  local curHeld  = tonumber(redis.call("HGET", invKey, "held") or "0")
  if quota > curQuota then
    local add = quota - curQuota
    redis.call("HMSET", invKey, "quota", tostring(quota), "available", tostring(curAvail + add))
    if priceStr and priceStr ~= "" then
      redis.call("HSET", invKey, "price", tostring(tonumber(priceStr) or 0))
    end
  end
end

-- 2) Meta (only set if absent and onSaleIso provided)
if onSaleIso and onSaleIso ~= "" then
  local hasMeta = redis.call("HEXISTS", metaKey, "on_sale_at")
  if hasMeta == 0 then
    redis.call("HMSET", metaKey, "on_sale_at", onSaleIso, "event_id", eventId)
  end
end

-- 3) Seats
local pad = #tostring(quota)
if pad < 4 then pad = 4 end

local created = 0
local skipped = 0

for i = 1, quota do
  local num = tostring(i)
  while #num < pad do num = "0" .. num end
  local seatNo = prefix .. "-" .. num
  -- slot-safe key: seat:{event_id}:{category_id}:{seatNo}
  local seatKey = "seat:{" .. eventId .. "}:" .. catId .. ":" .. seatNo

  local st = redis.call("HGET", seatKey, "status")
  if not st then
    redis.call("HMSET", seatKey,
      "status", "AVAILABLE",
      "version", "1",
      "event_id", eventId,
      "category_id", catId,
      "seat_number", seatNo
    )
    created = created + 1
  else
    skipped = skipped + 1
  end
end

local avail = redis.call("HGET", invKey, "available")
local held  = redis.call("HGET", invKey, "held")
local sold  = redis.call("HGET", invKey, "sold")

return {
  ok="SEEDED",
  event_id=eventId,
  category_id=catId,
  quota=quota,
  created=created,
  skipped=skipped,
  inventory={available=tonumber(avail or "0"), held=tonumber(held or "0"), sold=tonumber(sold or "0")}
}
