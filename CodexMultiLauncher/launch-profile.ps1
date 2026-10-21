param(
    [Parameter(Mandatory = $true)]
    [string]$ProfileRoot,
    [switch]$InPackage,
    [string]$GuiPath
)

$ErrorActionPreference = "Stop"
$profilePath = Join-Path $ProfileRoot "profile.json"
$configPath = Join-Path (Join-Path $ProfileRoot "codex-home") "config.toml"
$profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
$codexHome = Join-Path $ProfileRoot "codex-home"
$roaming = Join-Path $codexHome "appdata\Roaming"
$local = Join-Path $codexHome "appdata\Local"
$logPath = Join-Path $ProfileRoot "launcher.log"

New-Item -ItemType Directory -Force -Path $codexHome, $roaming, $local | Out-Null

function Write-LauncherLog([string]$Message) {
    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value ("{0} {1}" -f (Get-Date -Format o), $Message)
}

function Find-CodexExecutable {
    $packageRegistry = "Registry::HKEY_CURRENT_USER\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages"
    $install = Get-ChildItem -LiteralPath $packageRegistry -ErrorAction SilentlyContinue |
        Where-Object { $_.PSChildName -like "OpenAI.Codex_*_x64__2p2nqsd0c76g0" } |
        ForEach-Object {
            $match = [regex]::Match($_.PSChildName, "^OpenAI\.Codex_(?<version>[0-9.]+)_x64__2p2nqsd0c76g0$")
            $packageInfo = Get-ItemProperty -LiteralPath $_.PSPath
            $candidate = Join-Path $packageInfo.PackageRootFolder "app\ChatGPT.exe"
            if ($match.Success -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                [pscustomobject]@{ Version = [version]$match.Groups["version"].Value; Executable = $candidate }
            }
        } |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $install) {
        throw "没有找到 OpenAI Codex 桌面版，请在配置中填写 ChatGPT.exe 路径。"
    }
    return $install.Executable
}

function Start-CodexProcess([string]$Executable) {
    if (-not (Test-Path -LiteralPath $profile.workspace -PathType Container)) {
        throw "工作区不存在：$($profile.workspace)"
    }
    $tokenSecure = ConvertTo-SecureString $profile.tokenProtected
    $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($tokenSecure)
    try {
        $env:CODEX_HOME = $codexHome
        $env:TOKENAPI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
        $env:APPDATA = $roaming
        $env:LOCALAPPDATA = $local
        $env:TERM = "xterm-256color"
        $encodedPath = [Uri]::EscapeDataString($profile.workspace)
        $started = Start-Process -FilePath $Executable `
            -ArgumentList @("--new-window", "codex://new?path=$encodedPath") `
            -WorkingDirectory $profile.workspace `
            -PassThru
        Write-LauncherLog ("START pid={0} name={1} workspace={2}" -f $started.Id, $profile.name, $profile.workspace)
        $started.WaitForExit()
        Write-LauncherLog ("EXIT pid={0} code={1}" -f $started.Id, $started.ExitCode)
    }
    finally {
        Remove-Item Env:TOKENAPI_API_KEY -ErrorAction SilentlyContinue
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    }
}

try {
    if (-not $profile.tokenProtected) {
        throw "没有配置 TokenAPI Token。"
    }
    $selectedGui = if ($GuiPath) { $GuiPath } elseif ($profile.executablePath) { $profile.executablePath } else { Find-CodexExecutable }
    if (-not (Test-Path -LiteralPath $selectedGui -PathType Leaf)) {
        throw "Codex 可执行文件不存在：$selectedGui"
    }

    if ($InPackage) {
        Start-CodexProcess $selectedGui
        exit 0
    }

    $windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $innerArguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -InPackage -GuiPath "{1}" -ProfileRoot "{2}"' -f $PSCommandPath, $selectedGui, $ProfileRoot
    Invoke-CommandInDesktopPackage `
        -PackageFamilyName "OpenAI.Codex_2p2nqsd0c76g0" `
        -AppId "App" `
        -Command $windowsPowerShell `
        -Args $innerArguments `
        -PreventBreakaway
}
catch {
    Write-LauncherLog ("ERROR {0}" -f $_.Exception.Message)
    exit 1
}
