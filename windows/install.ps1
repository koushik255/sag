[CmdletBinding()]
param(
    [string]$ServerUrl,
    [string]$Token,
    [string]$MpvPath
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

if (-not $ServerUrl) {
    $ServerUrl = Read-Host "StopAndGo server URL (for example http://100.x.y.z:8765)"
}
if ($ServerUrl -notmatch '^https?://[^/\s]+(?:/.*)?$') {
    throw "ServerUrl must be a complete http:// or https:// URL."
}

if (-not $Token) {
    $secureToken = Read-Host "StopAndGo application token" -AsSecureString
    $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    try {
        $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    }
}

if (-not $MpvPath) {
    $mpvCommand = Get-Command mpv.exe -ErrorAction SilentlyContinue
    if ($mpvCommand) {
        $MpvPath = $mpvCommand.Source
    }
}

if (-not $MpvPath) {
    $candidates = @(
        "$env:USERPROFILE\scoop\apps\mpv\current\mpv.exe",
        "$env:ProgramFiles\mpv\mpv.exe",
        "$env:LOCALAPPDATA\Programs\mpv\mpv.exe"
    )
    $MpvPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $MpvPath -or -not (Test-Path $MpvPath)) {
    throw "mpv.exe was not found. Install mpv or pass -MpvPath C:\path\to\mpv.exe"
}

if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    throw "curl.exe is required but was not found in PATH."
}

$portableConfig = Join-Path (Split-Path -Parent $MpvPath) "portable_config"
$configDir = if (Test-Path $portableConfig) {
    $portableConfig
} else {
    Join-Path $env:APPDATA "mpv"
}
$scriptsDir = Join-Path $configDir "scripts"
$optionsDir = Join-Path $configDir "script-opts"
New-Item -ItemType Directory -Force -Path $scriptsDir, $optionsDir | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

Copy-Item (Join-Path $projectRoot "client\stopandgo.lua") (Join-Path $scriptsDir "stopandgo.lua") -Force
Copy-Item (Join-Path $projectRoot "client\clip-last.lua") (Join-Path $scriptsDir "clip-last.lua") -Force

$baseUrl = $ServerUrl.TrimEnd("/")
$libraryConfig = @"
api_url=$baseUrl/api/files
clips_api_url=$baseUrl/api/clips
token=$Token
key=Ctrl+b
timeout=10
rows=8
open_on_start=no
"@
[IO.File]::WriteAllText(
    (Join-Path $optionsDir "stopandgo.conf"),
    $libraryConfig,
    $utf8NoBom
)

$exportConfig = @"
clip_key=5
screenshot_key=s
seconds=15
server_url=$baseUrl
token=$Token
timeout=30
"@
[IO.File]::WriteAllText(
    (Join-Path $optionsDir "clip-last.conf"),
    $exportConfig,
    $utf8NoBom
)

# Register the original mpv for Explorer's Open With menu. This is per-user.
& $MpvPath --register

# Add a distinct searchable launcher without changing the original mpv entry.
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$shortcutPath = Join-Path $startMenu "MPV Library.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $MpvPath
$shortcut.Arguments = "--idle=yes --force-window=yes --script-opts=stopandgo-open_on_start=yes"
$shortcut.WorkingDirectory = Split-Path -Parent $MpvPath
$shortcut.IconLocation = "$MpvPath,0"
$shortcut.Description = "Open the StopAndGo movie library in mpv"
$shortcut.Save()

try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri "$baseUrl/healthz"
    if ($response.StatusCode -ne 200) {
        throw "Unexpected health response: $($response.StatusCode)"
    }
} catch {
    Write-Warning "Installed successfully, but the server is not reachable yet: $($_.Exception.Message)"
}

Write-Host "StopAndGo installed in $configDir"
Write-Host "Search for 'MPV Library' in Start, or launch the original mpv for local files."
Write-Host "Ctrl+b opens the library; 5 clips; s saves a server screenshot."
