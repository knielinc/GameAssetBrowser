# Code-sign one Windows binary. Called per-file by Tauri (see the signCommand in
# src-tauri/tauri.windows.conf.json, which Tauri auto-merges for Windows targets)
# and directly by export-release.ps1 for the portable exe.
#
# Why this matters commercially: an unsigned installer trips SmartScreen with
# "Windows protected your PC", which is the single largest conversion killer for
# a paid desktop app. Signing also stops Smart App Control from blocking freshly
# built binaries outright (the os error 4551 already noted in src-tauri/Cargo.toml).
#
# Configuration is entirely by environment variable, so no secret ever lands in
# the repo and an unconfigured machine still builds - it just builds unsigned.
#
#   GAB_SIGN_METHOD   trustedsigning | signtool | custom   (unset = skip signing)
#
#   trustedsigning (recommended: ~$10/month, no hardware token to babysit, and
#                   the cert is issued per-signature by Azure)
#     GAB_SIGN_ENDPOINT       e.g. https://weu.codesigning.azure.net
#     GAB_SIGN_ACCOUNT        Trusted Signing account name
#     GAB_SIGN_PROFILE        certificate profile name
#     (auth comes from the ambient Azure credential: az login, a service
#      principal's AZURE_* vars, or a GitHub OIDC federated credential)
#
#   signtool (an OV/EV cert on a hardware token or in the local cert store;
#             since June 2023 OV certs require a token or cloud HSM)
#     GAB_SIGN_THUMBPRINT     SHA1 thumbprint of the signing certificate
#
#   custom (any other cloud-HSM provider: SSL.com eSigner, DigiCert KeyLocker...)
#     GAB_SIGN_COMMAND        full command line; {FILE} is replaced with the path
#
#   GAB_SIGN_TIMESTAMP_URL    optional; defaults to DigiCert's RFC-3161 server.
#                             Timestamping is what keeps already-shipped builds
#                             trusted after the certificate itself expires.

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Path
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Path)) { throw "sign: file not found: $Path" }

$method = $env:GAB_SIGN_METHOD
if ([string]::IsNullOrWhiteSpace($method)) {
    Write-Host "sign: GAB_SIGN_METHOD not set - leaving '$([System.IO.Path]::GetFileName($Path))' UNSIGNED" -ForegroundColor Yellow
    exit 0
}

$timestamp = $env:GAB_SIGN_TIMESTAMP_URL
if ([string]::IsNullOrWhiteSpace($timestamp)) { $timestamp = "http://timestamp.digicert.com" }

function Resolve-SignTool {
    # signtool.exe is not on PATH by default; it ships with the Windows SDK and
    # each SDK version gets its own directory, so take the newest x64 one.
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $roots = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "${env:ProgramFiles}\Windows Kits\10\bin"
    )
    foreach ($r in $roots) {
        if (-not (Test-Path $r)) { continue }
        $found = Get-ChildItem $r -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($found) { return $found.FullName }
    }
    throw "sign: signtool.exe not found - install the Windows SDK signing tools"
}

Write-Host "sign: [$method] $([System.IO.Path]::GetFileName($Path))" -ForegroundColor Cyan

switch ($method.ToLowerInvariant()) {
    "trustedsigning" {
        foreach ($v in @("GAB_SIGN_ENDPOINT", "GAB_SIGN_ACCOUNT", "GAB_SIGN_PROFILE")) {
            if ([string]::IsNullOrWhiteSpace((Get-Item "env:$v" -ErrorAction SilentlyContinue).Value)) {
                throw "sign: GAB_SIGN_METHOD=trustedsigning requires $v"
            }
        }
        # The `sign` dotnet global tool (dotnet tool install --global sign) is
        # Microsoft's supported front-end for Trusted Signing.
        $sign = Get-Command sign -ErrorAction SilentlyContinue
        if (-not $sign) { throw "sign: 'sign' tool not found - run: dotnet tool install --global sign" }
        & $sign.Source code trusted-signing $Path `
            --trusted-signing-endpoint $env:GAB_SIGN_ENDPOINT `
            --trusted-signing-account $env:GAB_SIGN_ACCOUNT `
            --trusted-signing-certificate-profile $env:GAB_SIGN_PROFILE `
            --timestamp-url $timestamp `
            --file-digest SHA256
        if ($LASTEXITCODE -ne 0) { throw "sign: trusted signing failed (exit $LASTEXITCODE)" }
    }
    "signtool" {
        if ([string]::IsNullOrWhiteSpace($env:GAB_SIGN_THUMBPRINT)) {
            throw "sign: GAB_SIGN_METHOD=signtool requires GAB_SIGN_THUMBPRINT"
        }
        $tool = Resolve-SignTool
        # /fd + /td SHA256: SHA-1 file digests are no longer accepted by Windows.
        # /tr (RFC 3161) rather than the legacy /t.
        & $tool sign /fd SHA256 /td SHA256 /tr $timestamp /sha1 $env:GAB_SIGN_THUMBPRINT $Path
        if ($LASTEXITCODE -ne 0) { throw "sign: signtool failed (exit $LASTEXITCODE)" }
    }
    "custom" {
        if ([string]::IsNullOrWhiteSpace($env:GAB_SIGN_COMMAND)) {
            throw "sign: GAB_SIGN_METHOD=custom requires GAB_SIGN_COMMAND"
        }
        $cmdLine = $env:GAB_SIGN_COMMAND.Replace("{FILE}", $Path)
        cmd.exe /c $cmdLine
        if ($LASTEXITCODE -ne 0) { throw "sign: custom sign command failed (exit $LASTEXITCODE)" }
    }
    default { throw "sign: unknown GAB_SIGN_METHOD '$method' (expected trustedsigning, signtool, or custom)" }
}

Write-Host "sign: ok" -ForegroundColor Green
