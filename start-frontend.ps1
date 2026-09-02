$ErrorActionPreference = "Continue"
Set-Location "C:\WORK\Galih\dev\tiket\frontend"
if (Test-Path ".next") { Remove-Item ".next" -Recurse -Force }
Write-Host "start tiket frontend :3000 ..." -ForegroundColor Green
$env:PORT = "3000"
Start-Process -FilePath "C:\laragon\bin\nodejs\node-v22\node.exe" -ArgumentList "C:\laragon\bin\nodejs\node-v22\node_modules\npm\bin\npm-cli.js","run","dev","--","-p","3000" -WorkingDirectory "C:\WORK\Galih\dev\tiket\frontend" -WindowStyle Hidden
Write-Host "waiting 10s for next dev ..."
Start-Sleep 10
netstat -ano | findstr ":3000" | Out-Host
Write-Host "--- fetch :3000 ---"
try {
  $html = (Invoke-WebRequest "http://localhost:3000/" -UseBasicParsing -TimeoutSec 5).Content
  $head = $html.Substring(0, [Math]::Min(800, $html.Length))
  Write-Host $head
  if ($html -match "MEGA") { Write-Host "MEGA FOUND - TIKET OK" -ForegroundColor Green } elseif ($html -match "Kanban") { Write-Host "STILL KANBAN - port masih tabrakan" -ForegroundColor Red } else { Write-Host "unknown content" -ForegroundColor Yellow }
} catch {
  Write-Host "fetch fail: $($_.Exception.Message)" -ForegroundColor Red
}
