# run-local.ps1 — TIKET tanpa Docker (PowerShell native, PERSISTENT via Start-Process + go build)
param([switch]$Stop, [switch]$Logs)

$root = $PSScriptRoot
if (-not $root) { $root = "C:\WORK\Galih\dev\tiket" }
$envTemp = [Environment]::GetEnvironmentVariable("TEMP")
$bookingLog = Join-Path $envTemp "tiket-booking.log"
$readLog = Join-Path $envTemp "tiket-read.log"
$bookingErr = Join-Path $envTemp "tiket-booking-err.log"
$readErr = Join-Path $envTemp "tiket-read-err.log"
$pgBin = "C:\laragon\bin\postgresql\16\bin\psql.exe"

function Kill-Port([int]$port) {
  try {
    $out = netstat -ano | findstr ":$port"
    foreach ($line in $out) {
      $parts = $line.Trim() -split '\s+'
      $pidStr = $parts[-1]
      if ($pidStr -match '^\d+$') {
        $pidInt = [int]$pidStr
        if ($pidInt -gt 0) {
          try { Stop-Process -Id $pidInt -Force -ErrorAction SilentlyContinue; Write-Host "Killed pid $pidInt on :$port" -ForegroundColor Yellow } catch {}
        }
      }
    }
  } catch {}
}

if ($Stop) {
  Write-Host "Stopping..." -ForegroundColor Yellow
  Kill-Port 8080
  Kill-Port 8081
  Get-Process -Name "tiket-booking","tiket-read","booking-service","read-service" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped." -ForegroundColor Green
  exit 0
}
if ($Logs) {
  Write-Host "=== booking.log ===" -ForegroundColor Cyan
  Get-Content $bookingLog -Tail 80 -ErrorAction SilentlyContinue | Out-Host
  Write-Host "`n=== booking err ===" -ForegroundColor DarkYellow
  Get-Content $bookingErr -Tail 30 -ErrorAction SilentlyContinue | Out-Host
  Write-Host "`n=== read.log ===" -ForegroundColor Cyan
  Get-Content $readLog -Tail 60 -ErrorAction SilentlyContinue | Out-Host
  Get-Content $readErr -Tail 20 -ErrorAction SilentlyContinue | Out-Host
  exit 0
}

# kill old
Kill-Port 8080
Kill-Port 8081
Start-Sleep 1

$env:ENV = "development"
$env:Path = "C:\laragon\bin\postgresql\16\bin;" + $env:Path
$env:JWT_SECRET = "dev-only-32chars-super-secret-jwt!!"
$env:JWT_ISSUER = "tiket-waiting-room"
$env:JWT_AUDIENCE = "tiket-checkout"
$env:HOLD_TTL_SEC = "600"
if (-not $env:PG_DSN) { $env:PG_DSN = "postgres://tiket:tiket@localhost:5432/tiket?sslmode=disable" }
if (-not $env:REDIS_ADDR) { $env:REDIS_ADDR = "localhost:6379" }
if (-not $env:NATS_URL) { $env:NATS_URL = "nats://localhost:4222" }

Write-Host "== TIKET run-local TANPA Docker (persistent) ==" -ForegroundColor Cyan
Write-Host " PG_DSN : $env:PG_DSN"
Write-Host " REDIS  : $env:REDIS_ADDR"
Write-Host " NATS   : $env:NATS_URL"
Write-Host " root   : $root"
Write-Host " logs   : $bookingLog , $readLog"
Write-Host ""

if (Test-Path $pgBin) {
  Write-Host "[DB] psql seed..." -ForegroundColor Green
  & $pgBin -h localhost -p 5432 -U tiket -d tiket -f "$root\sql\001_schema.sql" 2>&1 | Select-Object -First 12 | Out-Host
  & $pgBin -h localhost -p 5432 -U tiket -d tiket -f "$root\sql\002_seed.sql" 2>&1 | Select-Object -First 12 | Out-Host
  & $pgBin -h localhost -p 5432 -U tiket -d tiket -f "$root\sql\003_fix_orders_fk.sql" 2>&1 | Select-Object -First 12 | Out-Host
} else {
  Write-Host "[DB] psql not found at $pgBin - skip seed" -ForegroundColor Yellow
}

# Build binaries (lebih stabil daripada go run di background)
Write-Host "`n[build] booking-service ..." -ForegroundColor Green
Push-Location "$root\services\booking-service"
go build -o "$envTemp\tiket-booking.exe" ./cmd/server 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Write-Host "build booking FAILED" -ForegroundColor Red; Pop-Location; exit 1 }
Pop-Location
Write-Host "[build] read-service ..." -ForegroundColor Green
Push-Location "$root\services\read-service"
go build -o "$envTemp\tiket-read.exe" ./cmd/server 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Write-Host "build read FAILED" -ForegroundColor Red; Pop-Location; exit 1 }
Pop-Location

# Clean old logs
Remove-Item $bookingLog -Force -ErrorAction SilentlyContinue
Remove-Item $readLog -Force -ErrorAction SilentlyContinue
Remove-Item $bookingErr -Force -ErrorAction SilentlyContinue
Remove-Item $readErr -Force -ErrorAction SilentlyContinue
New-Item -ItemType File -Path $bookingLog -Force | Out-Null
New-Item -ItemType File -Path $readLog -Force | Out-Null

Write-Host "`n[1] start booking :8080 -> $envTemp\tiket-booking.exe" -ForegroundColor Green
$env:PORT = "8080"
# Start-Process inherits current $env:* — set them globally already
Start-Process -FilePath "$envTemp\tiket-booking.exe" -WindowStyle Hidden -RedirectStandardOutput $bookingLog -RedirectStandardError $bookingErr

Write-Host "[2] start read :8081 -> $envTemp\tiket-read.exe" -ForegroundColor Green
$env:PORT = "8081"
$env:PG_READ_DSN = $env:PG_DSN
Start-Process -FilePath "$envTemp\tiket-read.exe" -WindowStyle Hidden -RedirectStandardOutput $readLog -RedirectStandardError $readErr

Start-Sleep -Seconds 4

Write-Host "`n--- booking.log ---" -ForegroundColor DarkGray
Get-Content $bookingLog -Tail 20 -ErrorAction SilentlyContinue | Out-Host
Get-Content $bookingErr -Tail 20 -ErrorAction SilentlyContinue | Out-Host
Write-Host "--- read.log ---" -ForegroundColor DarkGray
Get-Content $readLog -Tail 15 -ErrorAction SilentlyContinue | Out-Host
Get-Content $readErr -Tail 10 -ErrorAction SilentlyContinue | Out-Host

Write-Host "`nHealth:" -ForegroundColor Cyan
try { $b = Invoke-RestMethod "http://localhost:8080/health" -TimeoutSec 5; Write-Host " booking 8080 => $($b | ConvertTo-Json -Compress)" -ForegroundColor Green } catch { Write-Host " booking 8080 DOWN: $($_.Exception.Message)" -ForegroundColor Red }
try { $r2 = Invoke-RestMethod "http://localhost:8081/health" -TimeoutSec 5; Write-Host " read 8081    => $($r2 | ConvertTo-Json -Compress)" -ForegroundColor Green } catch { Write-Host " read 8081 DOWN: $($_.Exception.Message)" -ForegroundColor Red }

Write-Host "`nGate check (tanpa token harus 401):" -ForegroundColor Cyan
try {
  Invoke-WebRequest "http://localhost:8080/api/hold" -Method POST -Headers @{"Content-Type"="application/json"} -Body '{"event_id":"x","category_id":"y","seat_ids":["z"],"idempotency_key":"11111111-1111-1111-1111-111111111111"}' -UseBasicParsing -ErrorAction Stop | Out-Null
  Write-Host "  FAIL - harusnya 401" -ForegroundColor Red
} catch {
  $code = 0
  try { $code = $_.Exception.Response.StatusCode.Value__ } catch {}
  if ($code -eq 401) { Write-Host "  401 OK gate jalan" -ForegroundColor Green } else { Write-Host "  code $code $($_.Exception.Message)" -ForegroundColor Yellow }
}

Write-Host "`nSelesai. Logs: .\run-local.ps1 -Logs | Stop: .\run-local.ps1 -Stop" -ForegroundColor Cyan
