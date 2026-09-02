$ErrorActionPreference = "Stop"
$psql = "C:\laragon\bin\postgresql\16\bin\psql.exe"
$cli = "C:\laragon\bin\redis\redis-x64-5.0.14.1\redis-cli.exe"

# 1. cek infra
Write-Host "Infra check..." -ForegroundColor Cyan
& $cli ping | Out-Host
& $psql -h localhost -p 5432 -U tiket -d tiket -c "select count(*) from seats;" 2>&1 | Out-Host

# 2. cek services
Write-Host "`nHealth..." -ForegroundColor Cyan
Invoke-RestMethod "http://localhost:8080/health" -TimeoutSec 5 | ConvertTo-Json -Compress | Write-Host
try { Invoke-RestMethod "http://localhost:8081/health" -TimeoutSec 3 | ConvertTo-Json -Compress | Write-Host } catch { Write-Host "read health skip (booking saja yang penting untuk hold/commit)" -ForegroundColor Yellow }

# 3. ambil seat real
$sid = (& $psql -h localhost -p 5432 -U tiket -d tiket -t -A -c "select id from seats where seat_number='VIP-0001';" 2>&1 | Where-Object { $_ -match "-" } | Select-Object -First 1).Trim()
Write-Host "`nVIP-0001 id = $sid"

# 4. bikin queue JWT valid (pakai users id dummy)
$userId = "00000000-0000-0000-0000-000000000001"
$eventId = "550e8400-e29b-41d4-a716-446655440010"
$catId = "550e8400-e29b-41d4-a716-446655440020"
# ensure user exists untuk FK reservations
& $psql -h localhost -p 5432 -U tiket -d tiket -c "insert into users (id, nik_hash, nik_verified) values ('$userId','a' || repeat('0',63), true) on conflict (id) do nothing;" 2>&1 | Out-Null

function B64UrlEncode([byte[]]$b) { [Convert]::ToBase64String($b).TrimEnd("=").Replace("+","-").Replace("/","_") }
$secret = "dev-only-32chars-super-secret-jwt!!"
$header = B64UrlEncode ([Text.Encoding]::UTF8.GetBytes('{"alg":"HS256","typ":"JWT"}'))
$now = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$exp = $now + 600
$jti = [guid]::NewGuid().ToString()
$payloadJson = '{"iss":"tiket-waiting-room","aud":"tiket-checkout","iat":' + $now + ',"nbf":' + $now + ',"exp":' + $exp + ',"jti":"' + $jti + '","user_id":"' + $userId + '","event_id":"' + $eventId + '"}'
$payload = B64UrlEncode ([Text.Encoding]::UTF8.GetBytes($payloadJson))
$data = "$header.$payload"
$hmac = New-Object System.Security.Cryptography.HMACSHA256 (,[Text.Encoding]::UTF8.GetBytes($secret))
$sig = B64UrlEncode ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($data)))
$token = "$data.$sig"
Write-Host "JWT ok jti=$jti"

# 5. HOLD
$holder = @{
  event_id = $eventId
  category_id = $catId
  seat_ids = @($sid)
  idempotency_key = [guid]::NewGuid().ToString()
} | ConvertTo-Json
Write-Host "`nPOST /api/hold -> $holder" -ForegroundColor Yellow
$holdResp = Invoke-RestMethod "http://localhost:8080/api/hold" -Method POST -Headers @{ "Content-Type"="application/json"; "Authorization"="Bearer $token" } -Body $holder -TimeoutSec 10
$holdResp | ConvertTo-Json -Depth 4 | Write-Host
if (-not $holdResp.hold_id) { throw "Hold gagal, no hold_id" }
Write-Host "Hold OK hold_id=$($holdResp.hold_id)" -ForegroundColor Green

# 6. cek Redis inventory bergeser
& $cli HGETALL "inventory:{$eventId}:$catId" | Out-Host
& $cli HGET "seat:{$eventId}:$sid" status | Write-Host
& $cli HGET "seat:{$eventId}:$sid" hold_id | Write-Host

# 7. COMMIT
$commitBody = @{
  hold_id = $holdResp.hold_id
  idempotency_key = [guid]::NewGuid().ToString()
  seat_ids = @($sid)
} | ConvertTo-Json
Write-Host "`nPOST /api/commit -> $commitBody" -ForegroundColor Yellow
$commitResp = Invoke-RestMethod "http://localhost:8080/api/commit" -Method POST -Headers @{ "Content-Type"="application/json"; "Authorization"="Bearer $token" } -Body $commitBody -TimeoutSec 10
$commitResp | ConvertTo-Json -Depth 4 | Write-Host
Write-Host "Commit OK!" -ForegroundColor Green

# 8. verify PG
& $psql -h localhost -p 5432 -U tiket -d tiket -c "select id, status, total_amount from orders order by created_at desc limit 1;" 2>&1 | Out-Host
& $psql -h localhost -p 5432 -U tiket -d tiket -c "select seat_number, status from seats where id='$sid';" 2>&1 | Out-Host
& $cli HGET "seat:{$eventId}:$sid" status | Write-Host
& $cli HGETALL "inventory:{$eventId}:$catId" | Out-Host

Write-Host "`nE2E DONE TANPA DOCKER (Laragon Postgres+Redis)" -ForegroundColor Green
