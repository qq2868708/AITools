param([switch]$NoBrowser, [int]$Port = 8765)
$ErrorActionPreference = "Stop"
$python = Get-Command py -ErrorAction SilentlyContinue
if ($python) {
    $arguments = @("-3", (Join-Path $PSScriptRoot "server.py"), "--port", $Port)
} else {
    $python = Get-Command python -ErrorAction Stop
    $arguments = @((Join-Path $PSScriptRoot "server.py"), "--port", $Port)
}
if (-not $NoBrowser) { $arguments += "--open" }
& $python.Source @arguments
