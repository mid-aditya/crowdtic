param([switch]$Force)

$pgVer = "16.3-1"
$url = "https://get.enterprisedb.com/postgresql/postgresql-$pgVer-windows-x64-binaries.zip"
$zip = "$env:TEMP\pg16.zip"
$dest = "C:\laragon\bin\postgresql\16"
$data = "C:\laragon\data\postgresql"
$port = 5432

Write-Host "== Setup Postgres $pgVer ke Laragon ==" -ForegroundColor Cyan
Write-Host " dest: $dest"
Write-Host " data: $data"

$psqlPath = Join-Path $dest "bin\psql.exe"
$initdbPath = Join-Path $dest "bin\initdb.exe"
$pgctlPath = Join-Path $dest "bin\pg_ctl.exe"
$pgreadyPath = Join-Path $dest "bin\pg_isready.exe"

if (Test-Path $psqlPath) {
  Write-Host "Postgres sudah ada - skip download" -ForegroundColor Green
} else {
  Write-Host "Download $url ..." -ForegroundColor Yellow
  try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing } catch { Write-Host "Download gagal: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
  Write-Host "Extract..." -ForegroundColor Yellow
  $tmpExtract = "C:\laragon\bin\postgresql\_tmp"
  if (Test-Path $tmpExtract) { Remove-Item $tmpExtract -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmpExtract -Force
  $pgsqlSrc = Join-Path $tmpExtract "pgsql"
  if (Test-Path $pgsqlSrc) {
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Move-Item $pgsqlSrc $dest
  }
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Remove-Item $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Download selesai" -ForegroundColor Green
}

if (-not (Test-Path "$data\PG_VERSION")) {
  Write-Host "initdb ke $data ..." -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  & $initdbPath -D $data -U postgres --auth=trust --encoding=UTF8 --locale=C
  $conf = Get-Content "$data\postgresql.conf" -Raw
  $conf = $conf -replace "#port = 5432","port = $port"
  $conf = $conf -replace "#listen_addresses = 'localhost'","listen_addresses = 'localhost'"
  Set-Content "$data\postgresql.conf" $conf
  Add-Content "$data\pg_hba.conf" "host all all 127.0.0.1/32 trust"
}

Write-Host "Start postgres ..." -ForegroundColor Yellow
Get-Process postgres -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 1
Start-Process -FilePath $pgctlPath -ArgumentList "-D `"$data`" -l `"$data\logfile`" start" -WindowStyle Hidden
Start-Sleep 4
& $pgreadyPath -h localhost -p $port

Write-Host "Buat role/db tiket ..." -ForegroundColor Yellow
& $psqlPath -h localhost -p $port -U postgres -c "CREATE ROLE tiket WITH LOGIN PASSWORD 'tiket' SUPERUSER;" 2>&1 | Out-Host
& $psqlPath -h localhost -p $port -U postgres -c "CREATE DATABASE tiket OWNER tiket;" 2>&1 | Out-Host
& $psqlPath -h localhost -p $port -U postgres -d tiket -c "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;" 2>&1 | Out-Host

Write-Host "Seed sql lokal ..." -ForegroundColor Yellow
$root = $PSScriptRoot
if (-not $root) { $root = "C:\WORK\Galih\dev\tiket" }
& $psqlPath -h localhost -p $port -U tiket -d tiket -f "$root\sql\001_schema.sql" 2>&1 | Select-Object -First 30 | Out-Host
& $psqlPath -h localhost -p $port -U tiket -d tiket -f "$root\sql\002_seed.sql" 2>&1 | Select-Object -First 30 | Out-Host

Write-Host ""
Write-Host "SELESAI. Postgres di localhost:$port" -ForegroundColor Green
Write-Host " Cek: $psqlPath -h localhost -U tiket -d tiket -c 'select count(*) from events;'"
Write-Host " Next: .\run-local.ps1"
