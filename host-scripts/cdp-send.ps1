# Sends one Chrome DevTools Protocol command to the running Edge harness page.
#
# The Rust host runs inside WSL and cannot reach Edge's DevTools listener, which
# binds 127.0.0.1 on Windows. This script is executed by Windows PowerShell
# (through WSL interop) and writes the response to stdout as one JSON line.
param(
    [string]$CommandFile = (Join-Path $PSScriptRoot 'cdp-command.json'),
    [int]$Port = 9333,
    [string]$PagePattern = '*127.0.0.1:47821/index.html*'
)

$ErrorActionPreference = 'Stop'
$targets = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $Port + "/json/list") -TimeoutSec 5
$page = $targets |
    Where-Object { $_.type -eq 'page' -and $_.url -like $PagePattern } |
    Select-Object -First 1
if (-not $page) {
    $page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
}
if (-not $page) { throw 'no page target on Edge DevTools' }

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [System.Threading.CancellationToken]::None
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $ct).Wait()

$raw = Get-Content -Raw -LiteralPath $CommandFile
$id = (ConvertFrom-Json $raw).id
$bytes = [System.Text.Encoding]::UTF8.GetBytes($raw)
$segment = New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$bytes)
$ws.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait()

$buffer = New-Object byte[] 262144
$receive = New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$buffer)
for ($i = 0; $i -lt 100; $i++) {
    $result = $ws.ReceiveAsync($receive, $ct).Result
    $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
    Write-Output $text
    if ($text -match ('"id":' + [regex]::Escape([string]$id))) { break }
}
$ws.Dispose()
