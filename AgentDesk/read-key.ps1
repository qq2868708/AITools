$ErrorActionPreference = 'Stop'
$keyPath = Join-Path $env:LOCALAPPDATA 'CodexDeepSeek\api-key.dpapi'
if (Test-Path -LiteralPath $keyPath) {
    $encryptedKey = (Get-Content -LiteralPath $keyPath -Raw).Trim()
    $secureKey = ConvertTo-SecureString -String $encryptedKey
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try {
        [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer))
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    }
} else {
    [Console]::Write([Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User'))
}
