-- RELEASE.lua — kembalikan stok saat TTL habis / cancel
-- KEYS[1]=inventory:{event_id}:{cat}  KEYS[2..N]=seat:{id}  ARGV[1]=hold_id ARGV[2]=user_id ARGV[3]=event_id
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
return {ok="RELEASED", seats=need}
