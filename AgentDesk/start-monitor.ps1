$ErrorActionPreference = 'Stop'
$runtimePath = Join-Path $PSScriptRoot '.platform\runtime.json'
if (Test-Path -LiteralPath $runtimePath) {
    try {
        $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
        if ($runtime.port -ge 1024 -and $runtime.port -le 65535) {
            $existingUrl = "http://127.0.0.1:$($runtime.port)"
            $existingHealth = Invoke-RestMethod -Uri "$existingUrl/health" -TimeoutSec 2
            if ($existingHealth.service -eq 'agent-api-platform') {
                Start-Process $existingUrl
                exit 0
            }
        }
    } catch {}
}
$port = 4318
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $url = "http://127.0.0.1:$port"
    try {
        $health = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 2
        if ($health.service -eq 'agent-api-platform') {
            Start-Process $url
            exit 0
        }
    } catch {}
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
    try { $listener.Start(); break } catch { $port++ } finally { $listener.Stop() }
}
$node = (Get-Command node.exe).Source
$env:MONITOR_PORT = "$port"
$entry = Join-Path $PSScriptRoot 'monitor.mjs'
Start-Process -FilePath $node -ArgumentList @("`"$entry`"") -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    try {
        $health = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 2
        if ($health.service -eq 'agent-api-platform') {
            Start-Process $url
            exit 0
        }
    } catch {}
}
throw 'Monitor did not start.'
