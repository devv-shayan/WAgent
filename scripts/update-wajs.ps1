# Updates extension/vendor/wppconnect-wa.js to the latest WA-JS release.
#
#   powershell -ExecutionPolicy Bypass -File scripts/update-wajs.ps1
#   ... -Check    # report only, change nothing
#   ... -Tag v4.4.3  # pin to a specific release instead of latest
#
# WA-JS hooks WhatsApp Web's internals, so a WhatsApp update can break it and a
# WA-JS update can fix it. This only swaps the file - reload the extension at
# chrome://extensions and hard-refresh the WhatsApp tab to actually pick it up.

param(
    [switch]$Check,
    [string]$Tag
)

$ErrorActionPreference = "Stop"

$repoRoot    = Split-Path -Parent $PSScriptRoot
$bundlePath  = Join-Path $repoRoot "extension\vendor\wppconnect-wa.js"
$versionPath = Join-Path $repoRoot "extension\vendor\wa-js.version"

$current = if (Test-Path $versionPath) { (Get-Content $versionPath -Raw).Trim() } else { "unknown" }

$api = if ($Tag) {
    "https://api.github.com/repos/wppconnect-team/wa-js/releases/tags/$Tag"
} else {
    "https://api.github.com/repos/wppconnect-team/wa-js/releases/latest"
}

$release = Invoke-RestMethod $api -Headers @{ "User-Agent" = "WAgent-update-wajs" }
$latest  = $release.tag_name -replace '^v', ''

Write-Host "vendored: $current"
Write-Host "latest:   $latest  ($($release.published_at))"

if ($current -eq $latest) {
    Write-Host "Already up to date." -ForegroundColor Green
    exit 0
}

if ($Check) {
    Write-Host "Update available. Re-run without -Check to apply." -ForegroundColor Yellow
    exit 1
}

$asset = $release.assets | Where-Object { $_.name -eq "wppconnect-wa.js" } | Select-Object -First 1
if (-not $asset) { throw "release $($release.tag_name) has no wppconnect-wa.js asset" }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "wppconnect-wa-$latest.js"
Invoke-WebRequest $asset.browser_download_url -OutFile $tmp -UseBasicParsing

# Sanity-check before overwriting: a truncated or error-page download here would
# silently break every chat read the extension does.
$size = (Get-Item $tmp).Length
if ($size -lt 100000) { throw "downloaded bundle is only $size bytes - looks truncated" }
if ((Get-Content $tmp -Raw) -notmatch 'window\.WPP') { throw "downloaded bundle has no window.WPP - not a WA-JS build" }

Copy-Item $tmp $bundlePath -Force
Set-Content $versionPath "$latest`n" -NoNewline
Remove-Item $tmp -Force

Write-Host ""
Write-Host "Updated WA-JS $current -> $latest ($size bytes)" -ForegroundColor Green
Write-Host "Release notes: $($release.html_url)"
Write-Host ""
Write-Host "To load it: reload the extension at chrome://extensions, then hard-refresh"
Write-Host "the WhatsApp tab (Ctrl+Shift+R). Content scripts don't swap in an open tab."
