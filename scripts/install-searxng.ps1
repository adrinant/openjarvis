Param()

$ErrorActionPreference = "Stop"

function Write-Section {
  param([string]$Text)
  Write-Host ""
  Write-Host "=== $Text ===" -ForegroundColor Cyan
}

function Exit-WithMessage {
  param(
    [string]$Message,
    [int]$Code = 1
  )
  Write-Host ""
  Write-Host $Message -ForegroundColor Yellow
  Write-Host "Press Enter to close..."
  [void](Read-Host)
  exit $Code
}

Write-Section "OpenJarvis SearXNG Setup"
Write-Host "This installer will set up local SearXNG using Docker."
Write-Host "Container port binding: 127.0.0.1:8080"

$confirm = Read-Host "Continue? (y/N)"
if ($confirm -notin @("y", "Y", "yes", "YES")) {
  Exit-WithMessage "SearXNG setup skipped." 0
}

Write-Section "Checking Docker"
try {
  $null = Get-Command docker -ErrorAction Stop
} catch {
  Exit-WithMessage "Docker is not installed or not in PATH. Install Docker Desktop, then run setup again."
}

try {
  docker info | Out-Null
} catch {
  Exit-WithMessage "Docker is installed but not running. Start Docker Desktop, then run setup again."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @(
  (Join-Path $scriptDir "docker-compose.searxng.yml"),
  (Join-Path $scriptDir "..\docker-compose.searxng.yml"),
  (Join-Path $scriptDir "..\..\docker-compose.searxng.yml")
)

$composeFile = $null
foreach ($candidate in $candidates) {
  if (Test-Path $candidate) {
    $composeFile = (Resolve-Path $candidate).Path
    break
  }
}

if (-not $composeFile) {
  Exit-WithMessage "Cannot find docker-compose.searxng.yml near installer resources."
}

Write-Section "Starting SearXNG"
docker compose -f $composeFile up -d

if ($LASTEXITCODE -ne 0) {
  Exit-WithMessage "Docker compose failed. Check the output above."
}

Write-Host ""
Write-Host "SearXNG is running at: http://127.0.0.1:8080" -ForegroundColor Green
Write-Host "Set MCP SEARXNG_URL to http://127.0.0.1:8080 in mcp-servers.json."
Write-Host ""
Write-Host "Press Enter to close..."
[void](Read-Host)
