# WAgent backend one-command installer (Windows).
#
# Does everything the backend needs in one go:
#   1. Installs uv if missing (official installer from astral.sh).
#   2. Creates .env from .env.example if missing.
#   3. Installs Python dependencies (uv sync).
#   4. Installs Ollama + pulls the local Gemma 4 model (7.2 GB) and makes it
#      the default agent model — fully local text/image AI. Skip with -SkipLocal.
#   5. Installs auto-start (backend runs hidden at login + starts now).
#
# Run from the backend folder:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -SkipLocal   # cloud-only
#
# The Chrome extension still needs to be loaded manually once:
#   chrome://extensions -> Developer mode -> Load unpacked -> repo folder.

param([switch]$SkipLocal)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$LOCAL_MODEL = "gemma4:e2b"   # Gemma 4 2B (effective) - text+image, 128K ctx

Write-Host "=== WAgent backend installer ===" -ForegroundColor Cyan

# 1. uv
if (Get-Command uv -ErrorAction SilentlyContinue) {
    Write-Host "[1/5] uv already installed."
} else {
    Write-Host "[1/5] Installing uv (from astral.sh)..."
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
    # The installer adds uv to PATH for future shells; pick it up now too.
    $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
        Write-Error "uv installed but not found on PATH. Open a new terminal and re-run this script."
    }
}

# 2. .env
if (Test-Path ".env") {
    Write-Host "[2/5] .env already exists - leaving it untouched."
} else {
    Copy-Item ".env.example" ".env"
    Write-Host "[2/5] Created .env from .env.example."
    Write-Host "      Optional: put a GEMINI_API_KEY in backend\.env - or just enter"
    Write-Host "      your key in the extension's Agent settings (gear icon) instead."
}

# 3. dependencies
Write-Host "[3/5] Installing dependencies (uv sync)..."
uv sync
if ($LASTEXITCODE -ne 0) { Write-Error "uv sync failed - see output above." }

# 4. Local model (Ollama + Gemma 4) - default agent model, fully local text AI.
if ($SkipLocal) {
    Write-Host "[4/5] Skipping local model (-SkipLocal). Agent will use the cloud model from .env."
} else {
    Write-Host "[4/5] Setting up the local model (Ollama + $LOCAL_MODEL, ~7.2 GB download)..."

    # 4a. Install Ollama if missing (winget first, direct silent installer as fallback).
    if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
        $installed = $false
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            Write-Host "      Installing Ollama via winget..."
            winget install -e --id Ollama.Ollama --silent --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -eq 0) { $installed = $true }
        }
        if (-not $installed) {
            Write-Host "      Downloading Ollama installer from ollama.com..."
            $setup = Join-Path $env:TEMP "OllamaSetup.exe"
            Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $setup
            Start-Process -FilePath $setup -ArgumentList "/S" -Wait
            Remove-Item $setup -ErrorAction SilentlyContinue
        }
        # Pick up Ollama's install location for this session.
        $env:Path = "$env:LOCALAPPDATA\Programs\Ollama;$env:Path"
        if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
            Write-Error "Ollama installed but not found on PATH. Open a new terminal and re-run this script."
        }
    } else {
        Write-Host "      Ollama already installed."
    }

    # 4b. Make sure the Ollama server is up (it normally starts with the app).
    $up = $false
    for ($i = 0; $i -lt 15; $i++) {
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/version" -TimeoutSec 2 | Out-Null
            $up = $true; break
        } catch {
            if ($i -eq 0) { Start-Process "ollama" -ArgumentList "serve" -WindowStyle Hidden }
            Start-Sleep -Seconds 2
        }
    }
    if (-not $up) { Write-Error "Ollama server did not come up on port 11434." }

    # 4c. Pull the model (large download - shows progress; safe to re-run).
    Write-Host "      Pulling $LOCAL_MODEL (7.2 GB - this can take a while)..."
    ollama pull $LOCAL_MODEL
    if ($LASTEXITCODE -ne 0) { Write-Error "ollama pull $LOCAL_MODEL failed - see output above." }

    # 4d. Make the local model the default agent model in .env.
    # ollama_chat/ (not ollama/) = Ollama's native chat API with real tool
    # calling; the older ollama/ path emulates tools via JSON prompting, which
    # breaks the agent (JSON-wrapped replies, skipped tool calls).
    $envFile = Join-Path $PSScriptRoot ".env"
    $envText = Get-Content $envFile -Raw
    if ($envText -match "(?m)^AGENT_MODEL=") {
        $envText = $envText -replace "(?m)^AGENT_MODEL=.*$", "AGENT_MODEL=ollama_chat/$LOCAL_MODEL"
    } else {
        $envText = $envText.TrimEnd() + "`r`nAGENT_MODEL=ollama_chat/$LOCAL_MODEL`r`n"
    }
    Set-Content -Path $envFile -Value $envText -NoNewline
    Write-Host "      Default agent model set to ollama_chat/$LOCAL_MODEL (fully local text AI)."
    Write-Host "      Note: voice/video transcription still uses Gemini cloud and needs a GEMINI_API_KEY."
}

# 5. autostart (also starts the backend now)
Write-Host "[5/5] Installing auto-start..."
& powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install-autostart.ps1")

Write-Host ""
Write-Host "Backend installed and running (port 8787). It will auto-start at login." -ForegroundColor Green
Write-Host "Next: load the extension in Chrome (chrome://extensions -> Developer mode"
Write-Host "-> Load unpacked -> select the repo folder), open web.whatsapp.com, and"
Write-Host "click the WAgent button."
