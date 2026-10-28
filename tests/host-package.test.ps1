$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
. (Join-Path $repo 'native-integration\package-common.ps1')
. (Join-Path $repo 'native-integration\host-package.ps1')
$policy = Get-Content (Join-Path $repo 'native-integration\compatibility.json') -Raw | ConvertFrom-Json
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('sandrone-host-test-' + [guid]::NewGuid().ToString('N'))
$root = Join-Path $temporary 'official'
$checks = 0
function Check([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message }; $script:checks++ }
function Reject([scriptblock]$Action, [string]$Message) { $failed=$false; try { & $Action | Out-Null } catch { $failed=$true }; Check $failed $Message }
$identity = [pscustomobject]@{ Name='OpenAI.Codex'; Version='27.1.2.3'; Publisher=$policy.host.publisher; ProcessorArchitecture='x64' }
$target = Get-SandroneTarget $policy $identity
$script:package = [pscustomobject]@{ Name=$identity.Name; Version=[version]$identity.Version; Publisher=$identity.Publisher; Architecture='X64'; PackageFullName=$target.packageFullName; SignatureKind='Store'; Status='Ok'; IsDevelopmentMode=$false; InstallLocation=$root }
$script:overlay=$false; $script:intact=$true; $script:queries=0; $script:race=$false; $script:integrityChecks=0
function Assert-SandroneOutsidePackage { if ($script:overlay) { throw 'overlay' } }
function Assert-SandroneInstalledIntegrity([string]$Identity) { $script:integrityChecks++; if (!$script:intact) { throw 'tampered' } }
function Get-AppxPackage { param($Name); $script:queries++; if ($script:race -and $script:queries -gt 1) { $changed=$script:package.PSObject.Copy(); $changed.Version=[version]'27.1.2.4'; $changed.PackageFullName='OpenAI.Codex_27.1.2.4_x64__2p2nqsd0c76g0'; return $changed }; return $script:package }
try {
    foreach ($relative in $policy.host.files) {
        $file = Join-Path $root $relative; $null = New-Item -ItemType Directory -Path (Split-Path $file -Parent) -Force
        [IO.File]::WriteAllText($file, ('fresh original bytes for ' + $relative))
    }
    $result = Export-SandroneHostSource $policy (Join-Path $temporary 'snapshot') ''
    Check ($result.target.packageFullName -ceq $target.packageFullName) 'Discovery must bind the copied files to the exact registered release'
    Check ($result.sourceKind -eq 'installed-store-package' -and $null -eq $result.sourceMsixSha256) 'Installed-source evidence must not claim a downloaded MSIX'
    Check ($script:integrityChecks -eq 2) 'Integrity must be verified before and after copying'
    foreach ($relative in $policy.host.files) { Check ($result.hashes[$relative] -ceq (Get-SandroneHash (Join-Path $root $relative))) 'Hashes must describe the current originals, not a whitelist' }
    $script:overlay=$true
    Reject { Export-SandroneHostSource $policy (Join-Path $temporary 'overlay') '' } 'An overlay process cannot export a bridge as the original updater'
    $script:overlay=$false; $script:intact=$false
    Reject { Export-SandroneHostSource $policy (Join-Path $temporary 'tampered') '' } 'Content verification failure must prevent building'
    $script:intact=$true; $script:queries=0; $script:race=$true
    Reject { Export-SandroneHostSource $policy (Join-Path $temporary 'raced') '' } 'A host update during copying must not produce a stale candidate'
    $script:race=$false
    foreach ($field in @('SignatureKind', 'Status', 'IsDevelopmentMode', 'Publisher', 'PackageFullName')) {
        $bad=$script:package.PSObject.Copy()
        if ($field -eq 'IsDevelopmentMode') { $bad.$field=$true } else { $bad.$field='Other' }
        Reject { Assert-SandroneRegisteredHost $bad $policy } ('Invalid ' + $field + ' must be rejected')
    }
    Write-Output "Host package fixtures: $checks checks passed; no real packages changed."
} finally {
    $resolved=[IO.Path]::GetFullPath($temporary)
    if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('sandrone-host-test-')) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
