# Installs the HealthLink sender as a Windows service with NSSM
# (https://nssm.cc). Run as Administrator from the repo folder after
# `npm install --omit=dev` and creating .env.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
#
param(
  [string]$ServiceName = "HealthLinkSender",
  [string]$Nssm = "nssm"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$node = (Get-Command node).Source
if (-not (Test-Path (Join-Path $root ".env"))) { throw ".env not found in $root — copy .env.example and fill it in first." }
New-Item -ItemType Directory -Force (Join-Path $root "logs") | Out-Null

& $Nssm install $ServiceName $node "--env-file=.env src\index.js"
& $Nssm set $ServiceName AppDirectory $root
& $Nssm set $ServiceName AppStdout (Join-Path $root "logs\service-out.log")
& $Nssm set $ServiceName AppStderr (Join-Path $root "logs\service-err.log")
& $Nssm set $ServiceName AppRotateFiles 1
& $Nssm set $ServiceName AppRotateBytes 10485760
& $Nssm set $ServiceName AppExit Default Restart
& $Nssm set $ServiceName AppRestartDelay 5000
& $Nssm set $ServiceName Start SERVICE_AUTO_START
& $Nssm set $ServiceName Description "VascIQ to HealthLink HMS bridge: HL7 ORU out, ACKs back to VascIQ."
& $Nssm start $ServiceName

Write-Host "Installed and started $ServiceName. Check: curl http://localhost:8443/health"
