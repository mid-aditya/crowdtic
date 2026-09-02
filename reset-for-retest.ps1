$ErrorActionPreference = "Continue"
$cli = "C:\laragon\bin\redis\redis-x64-5.0.14.1\redis-cli.exe"
$psql = "C:\laragon\bin\postgresql\16\bin\psql.exe"
$event = "550e8400-e29b-41d4-a716-446655440010"
$catVip = "550e8400-e29b-41d4-a716-446655440020"

Write-Host "=== PG: VIP-0001 ==="
& $psql -h localhost -p 5432 -U tiket -d tiket -c "select seat_number, status from seats where seat_number='VIP-0001';"

Write-Host "=== PG: orders ==="
& $psql -h localhost -p 5432 -U tiket -d tiket -c "select id, status, total_amount from orders order by created_at desc limit 2;"

Write-Host "=== Redis inventory VIP (before) ==="
& $cli --raw HGETALL "inventory:{$event}:$catVip"

$sid = (& $psql -h localhost -p 5432 -U tiket -d tiket -t -A -c "select id from seats where seat_number='VIP-0001';" | Where-Object { $_ -match "-" } | Select-Object -First 1).Trim()
Write-Host "sid VIP-0001 = $sid"
Write-Host "=== Redis seat VIP-0001 (before) ==="
& $cli --raw HGETALL "seat:{$event}:$sid"

Write-Host "=== RESET: Redis seat -> AVAILABLE, PG seat -> AVAILABLE, clean orders ==="
& $cli HMSET "seat:{$event}:$sid" status AVAILABLE version 1 | Out-Host
& $cli HDEL "seat:{$event}:$sid" held_by hold_id expires_at sold_at | Out-Host
& $cli PERSIST "seat:{$event}:$sid" | Out-Host
& $psql -h localhost -p 5432 -U tiket -d tiket -c "update seats set status='AVAILABLE', version=1 where seat_number='VIP-0001';" | Out-Host
# clean only test orders/reservations to allow re-hold same seat; keep seats
& $psql -h localhost -p 5432 -U tiket -d tiket -c "delete from payments; delete from order_items; delete from orders; delete from reservations;" | Out-Host
# also clear hold keys in redis
& $cli --raw KEYS "hold:{$event}:*" | ForEach-Object { if ($_ -match "hold:") { & $cli DEL $_ | Out-Null } }
& $cli DEL "user:limit:{$event}:00000000-0000-0000-0000-000000000001" | Out-Host
& $cli HMSET "inventory:{$event}:$catVip" available 500 held 0 sold 0 | Out-Host

Write-Host "=== AFTER: Redis seat ==="
& $cli --raw HGETALL "seat:{$event}:$sid"
& $cli --raw HGETALL "inventory:{$event}:$catVip"
& $psql -h localhost -p 5432 -U tiket -d tiket -c "select seat_number,status from seats where seat_number='VIP-0001';"

Write-Host "RESET DONE"
