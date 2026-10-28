param(
    [switch]$NoBrowser,
    [int]$Port = 8765,
    [string]$DataRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexMultiLauncher')
)
$ErrorActionPreference = "Stop"
$address = "http://127.0.0.1:$Port/"
$healthUrl = "${address}api/health"
$health = $null
try { $health = Invoke-RestMethod $healthUrl -TimeoutSec 2 } catch { }
if (-not ($health.ok -and $health.service -eq 'CodexMultiLauncher')) {
    $python = Get-Command py -ErrorAction SilentlyContinue
    if ($python) {
        $pythonPath = (& $python.Source -3 -c 'import sys; print(sys.executable)').Trim()
    } else {
        $pythonPath = (Get-Command python -ErrorAction Stop).Source
    }
    $serverPath = Join-Path $PSScriptRoot 'server.py'
    $logPath = Join-Path $DataRoot 'server.log'
    $commandLine = '"{0}" "{1}" --port {2} --data-root "{3}" --log-file "{4}"' -f $pythonPath, $serverPath, $Port, $DataRoot, $logPath
    # WMI owns the service process, so closing a Codex process tree cannot kill it.
    # Start-Process/DETACHED_PROCESS alone still retain the caller's parent PID.
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $commandLine
        CurrentDirectory = $PSScriptRoot
        ProcessStartupInformation = $startup
    }
    if ($created.ReturnValue -ne 0) {
        throw "Unable to start controller service (WMI result $($created.ReturnValue))."
    }
    $deadline = (Get-Date).AddSeconds(10)
    do {
        try { $health = Invoke-RestMethod $healthUrl -TimeoutSec 1 } catch { }
        if ($health.ok -and $health.service -eq 'CodexMultiLauncher') { break }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    if (-not ($health.ok -and $health.service -eq 'CodexMultiLauncher')) {
        throw "Controller service did not become ready. Log: $logPath"
    }
}
Write-Output ("Codex Multi Launcher: {0} (PID {1})" -f $address, $health.pid)
if (-not $NoBrowser) { Start-Process $address }
