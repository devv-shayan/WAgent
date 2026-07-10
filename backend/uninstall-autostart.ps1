# Removes the WAgent backend auto-start and stops the running backend.
# Run:  powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1

$ErrorActionPreference = "Stop"

$startupDir = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupDir "WAgent Backend.lnk"

if (Test-Path $shortcutPath) {
    Remove-Item $shortcutPath -Force
    Write-Host "Removed startup shortcut: $shortcutPath"
} else {
    Write-Host "No startup shortcut found (already removed)."
}

# Stop the restart-loop cmd FIRST (killing only the server would let the
# .bat loop respawn it), then stop whatever is listening on 8787.
$loops = Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" |
    Where-Object { $_.CommandLine -like "*start-backend.bat*" }
foreach ($loop in $loops) {
    & taskkill /PID $loop.ProcessId /T /F | Out-Null
    Write-Host "Stopped restart loop + backend (PID $($loop.ProcessId))."
}

$conns = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $pids) {
        try {
            & taskkill /PID $procId /T /F | Out-Null
            Write-Host "Stopped backend process tree (PID $procId)."
        } catch {
            Write-Host "Could not stop PID ${procId}: $_"
        }
    }
} elseif (-not $loops) {
    Write-Host "No backend running on port 8787."
}

Write-Host "Done. Auto-start removed."
