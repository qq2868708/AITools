$ErrorActionPreference = 'Stop'
Write-Host 'DeepSeek official API setup'
Write-Host 'The key will be encrypted for your Windows account. Input is hidden.'
$secureKey = Read-Host 'Paste your DeepSeek API key' -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
    if ([string]::IsNullOrWhiteSpace($plainKey)) { throw 'No key entered.' }
    $models = Invoke-RestMethod -Uri 'https://api.deepseek.com/models' -Headers @{
        Authorization = "Bearer $plainKey"
    } -TimeoutSec 30
    $keyDirectory = Join-Path $env:LOCALAPPDATA 'CodexDeepSeek'
    New-Item -ItemType Directory -Path $keyDirectory -Force | Out-Null
    $normalizedKey = ConvertTo-SecureString -String $plainKey -AsPlainText -Force
    $normalizedKey | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $keyDirectory 'api-key.dpapi') -Encoding ASCII
    Write-Host 'Saved. Authentication succeeded.'
    Write-Host ('Available models: ' + (($models.data | ForEach-Object { $_.id }) -join ', '))
    Write-Host 'Return to Codex. Restart Codex once if the deepseek MCP tools are not visible.'
} catch {
    Write-Host 'Setup failed. Check your key and network connection; existing credentials were not replaced.'
    exit 1
} finally {
    $plainKey = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
}
