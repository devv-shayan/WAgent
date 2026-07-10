# Installs WAgent backend auto-start for the current user (no admin needed).
#
# What it does:
#   1. Creates a Startup-folder shortcut that runs the backend hidden at login.
#   2. Starts the backend now (hidden), so no reboot is needed.
#
# Run from the backend folder:  powershell -ExecutionPolicy Bypass -File install-autostart.ps1
# Undo with:                    powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1

$ErrorActionPreference = "Stop"

$backendDir = $PSScriptRoot
$vbsPath = Join-Path $backendDir "start-backend-hidden.vbs"
if (-not (Test-Path $vbsPath)) {
    Write-Error "start-backend-hidden.vbs not found next to this script."
}

# Sanity: uv must be on PATH, since the launcher depends on it at login.
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Error "uv is not on PATH. Install it first: https://docs.astral.sh/uv/"
}

$startupDir = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupDir "WAgent Backend.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "wscript.exe"
$shortcut.Arguments = "`"$vbsPath`""
$shortcut.WorkingDirectory = $backendDir
$shortcut.Description = "Starts the WAgent backend hidden at login"
$shortcut.Save()
Write-Host "Installed startup shortcut: $shortcutPath"

# Start it now (hidden) unless something is already listening on 8787.
$listening = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Host "Backend already running on port 8787 - not starting a second one."
} else {
    Start-Process -FilePath "wscript.exe" -ArgumentList "`"$vbsPath`"" -WorkingDirectory $backendDir
    Write-Host "Backend starting in the background (logs: ..\data\backend.log)."
}

Write-Host "Done. The backend will now start automatically when you log in."
