[CmdletBinding()]
param([string]$BundleDirectory = $PSScriptRoot, [switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'package-common.ps1')
$bundle = Get-Content -LiteralPath (Join-Path $BundleDirectory 'bundle.json') -Raw | ConvertFrom-Json
if ($bundle.schema -ne 1 -or $bundle.addonName -cne 'Local.Sandrone.CodexNativeTheme' -or
    $bundle.targetPackage -notmatch '^OpenAI\.Codex_[0-9.]+_x64__2p2nqsd0c76g0$') { throw 'Unsupported native theme bundle identity.' }
Assert-SandroneRelativePath $bundle.packageFile
$msix = Join-Path $BundleDirectory $bundle.packageFile
if ((Get-SandroneHash $msix) -cne $bundle.packageSha256) { throw 'Native theme package hash mismatch.' }
$package = Get-AppxPackage -Name OpenAI.Codex
if (!$package -or $package.PackageFullName -cne $bundle.targetPackage -or $package.Publisher -cne $bundle.targetPublisher -or
    $package.SignatureKind.ToString() -ne 'Store' -or $package.Status.ToString() -ne 'Ok' -or $package.IsDevelopmentMode) {
    throw 'This build requires its exact intact official Codex Store package. It does not downgrade or replace Codex.'
}
foreach ($entry in $bundle.officialHashes.PSObject.Properties) {
    Assert-SandroneRelativePath $entry.Name
    $actual = Get-SandroneHash (Join-Path $package.InstallLocation $entry.Name)
    if ($actual -cne $entry.Value) {
        throw ('Official file mismatch: ' + $entry.Name + '. Run installation from a standalone PowerShell after exiting Codex, outside an existing package overlay.')
    }
}
if ($VerifyOnly) { [pscustomobject]@{ status = 'verified'; registered = $false; targetPackage = $package.PackageFullName } | ConvertTo-Json -Compress; return }
foreach ($process in @(Get-Process ChatGPT -ErrorAction SilentlyContinue)) {
    $processPath = $null; try { $processPath = $process.Path } catch {}
    if (!$processPath -or $processPath.StartsWith($package.InstallLocation + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Exit Codex normally before installing the add-on. Installation never force-closes running work.'
    }
}
Add-AppxPackage -Path $msix -AllowUnsigned
$addon = @(Get-AppxPackage -PackageTypeFilter Optional | Where-Object PackageFullName -CEQ $bundle.addonPackageFullName)
$after = Get-AppxPackage -Name OpenAI.Codex
if ($addon.Count -ne 1 -or !($after.Dependencies | Where-Object PackageFullName -CEQ $bundle.addonPackageFullName)) { throw 'Native theme package registration did not verify.' }
$receipt = [ordered]@{ status = 'installed'; installedAt = [DateTimeOffset]::Now.ToString('o'); addonPackageFullName = $addon[0].PackageFullName; targetPackage = $after.PackageFullName; restartRequired = $true }
Write-SandroneJson (Join-Path $BundleDirectory 'install-receipt.json') $receipt
$receipt | ConvertTo-Json -Compress
