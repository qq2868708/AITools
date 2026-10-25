$ErrorActionPreference = 'Stop'
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $result = @()
    foreach ($value in $request.values) {
        if ($request.action -eq 'protect') {
            $secure = ConvertTo-SecureString -String $value -AsPlainText -Force
            $result += (ConvertFrom-SecureString -SecureString $secure)
        } elseif ($request.action -eq 'unprotect') {
            $secure = ConvertTo-SecureString -String $value.Trim()
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            try {
                $result += [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            } finally {
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
            }
        } else {
            throw 'Invalid vault action'
        }
    }
    [Console]::Write((ConvertTo-Json -InputObject @($result) -Compress))
} catch {
    [Console]::Error.Write('Windows credential protection failed.')
    exit 1
}
