!include "LogicLib.nsh"

!macro NSIS_HOOK_POSTINSTALL
  MessageBox MB_YESNO|MB_ICONQUESTION "Install local SearXNG search service now? Requires Docker Desktop." IDYES install_searxng IDNO done

  install_searxng:
    ; Write script at install-time to avoid resource path issues.
    StrCpy $0 "$TEMP\openjarvis-install-searxng.ps1"
    FileOpen $1 $0 w
    IfErrors 0 +3
      MessageBox MB_OK|MB_ICONEXCLAMATION "Failed to create setup script in temp folder."
      Goto done

    FileWrite $1 "$ErrorActionPreference = $\"Stop$\"$\r$\n"
    FileWrite $1 "Write-Host $\"$\"$\r$\n"
    FileWrite $1 "Write-Host $\"=== OpenJarvis SearXNG Setup ===$\" -ForegroundColor Cyan$\r$\n"
    FileWrite $1 "Write-Host $\"This will run local SearXNG on http://127.0.0.1:8080$\"$\r$\n"
    FileWrite $1 "$confirm = Read-Host $\"Continue? (y/N)$\"$\r$\n"
    FileWrite $1 "if ($confirm -notin @($\"y$\",$\"Y$\",$\"yes$\",$\"YES$\")) { Write-Host $\"Skipped.$\"; Read-Host $\"Press Enter to close$\"; exit 0 }$\r$\n"
    FileWrite $1 "try { Get-Command docker -ErrorAction Stop | Out-Null } catch { Write-Host $\"Docker not found. Install Docker Desktop first.$\" -ForegroundColor Yellow; Read-Host $\"Press Enter to close$\"; exit 1 }$\r$\n"
    FileWrite $1 "try { docker info | Out-Null } catch { Write-Host $\"Docker is not running. Start Docker Desktop first.$\" -ForegroundColor Yellow; Read-Host $\"Press Enter to close$\"; exit 1 }$\r$\n"
    FileWrite $1 "docker container inspect openjarvis-searxng *> `$null$\r$\n"
    FileWrite $1 "if ($LASTEXITCODE -eq 0) {$\r$\n"
    FileWrite $1 "  Write-Host $\"Starting existing container...$\"$\r$\n"
    FileWrite $1 "  docker start openjarvis-searxng | Out-Null$\r$\n"
    FileWrite $1 "} else {$\r$\n"
    FileWrite $1 "  Write-Host $\"Creating new container...$\"$\r$\n"
    FileWrite $1 "  docker run -d --name openjarvis-searxng -p 127.0.0.1:8080:8080 -e SEARXNG_BASE_URL=http://127.0.0.1:8080/ --restart unless-stopped docker.io/searxng/searxng:latest | Out-Null$\r$\n"
    FileWrite $1 "}$\r$\n"
    FileWrite $1 "if ($LASTEXITCODE -ne 0) { Write-Host $\"Failed to start SearXNG container.$\" -ForegroundColor Yellow; Read-Host $\"Press Enter to close$\"; exit 1 }$\r$\n"
    FileWrite $1 "Write-Host $\"$\"$\r$\n"
    FileWrite $1 "Write-Host $\"SearXNG is ready at http://127.0.0.1:8080$\" -ForegroundColor Green$\r$\n"
    FileWrite $1 "Write-Host $\"Set SEARXNG_URL to http://127.0.0.1:8080 in mcp-servers.json$\"$\r$\n"
    FileWrite $1 "Read-Host $\"Press Enter to close$\"$\r$\n"
    FileClose $1

    ; Open a terminal-based setup flow so users can choose and see progress.
    ExecShell "open" "$SYSDIR\cmd.exe" '/k powershell -NoExit -ExecutionPolicy Bypass -File "$\"$0$\""'

  done:
!macroend
