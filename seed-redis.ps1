$ErrorActionPreference = "Continue"
$env:Path = "C:\laragon\bin\postgresql\16\bin;" + $env:Path
$psql = "C:\laragon\bin\postgresql\16\bin\psql.exe"
$cli = "C:\laragon\bin\redis\redis-x64-5.0.14.1\redis-cli.exe"
$event = "550e8400-e29b-41d4-a716-446655440010"
$catVip = "550e8400-e29b-41d4-a716-446655440020"
$catFes = "550e8400-e29b-41d4-a716-446655440021"

Write-Host "Seed inventory..." -ForegroundColor Cyan
& $cli HMSET "inventory:{$event}:$catVip" quota 500 available 500 held 0 sold 0 price 150000000 category_id $catVip event_id $event | Out-Host
& $cli HMSET "inventory:{$event}:$catFes" quota 5000 available 5000 held 0 sold 0 price 75000000 category_id $catFes event_id $event | Out-Host
& $cli HMSET "meta:{$event}" on_sale_at "2026-08-31T00:00:00Z" event_id $event | Out-Host

Write-Host "Seeding 5500 seats (ini 20-30 detik)..." -ForegroundColor Yellow
$rows = & $psql -h localhost -p 5432 -U tiket -d tiket -t -A -F "|" -c "select id, seat_number, category_id from seats order by seat_number;" 2>&1 | Where-Object { $_ -match "\|" }
$i = 0
foreach ($r in $rows) {
  $parts = $r -split "\|"
  $sid = $parts[0]; $snum = $parts[1]; $cid = $parts[2]
  $key = "seat:{$event}:$sid"
  & $cli HMSET $key status AVAILABLE version 1 event_id $event category_id $cid seat_number $snum | Out-Null
  $i++
  if ($i % 1000 -eq 0) { Write-Host " $i..." }
}
Write-Host "Done $i seats" -ForegroundColor Green
& $cli HGETALL "inventory:{$event}:$catVip" | Out-Host
$firstId = & $psql -h localhost -p 5432 -U tiket -d tiket -t -A -c "select id from seats limit 1;" 2>&1 | Where-Object { $_ -match "-" } | Select-Object -First 1
$firstId = $firstId.Trim()
Write-Host "Check seat $firstId : $(& $cli HGET "seat:{$event}:$firstId" status)"
