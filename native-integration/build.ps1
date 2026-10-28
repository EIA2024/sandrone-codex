[CmdletBinding()]
param(
    [string]$OfficialMsix,
    [switch]$InstalledPackage,
    [string]$OutputDirectory,
    [string]$GccPath,
    [string]$MakeAppxPath,
    [string]$NodePath,
    [switch]$RebuildStartupMedia,
    [string]$BridgePath,
    [string]$BridgeSha256,
    [string]$AddonVersion
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'package-common.ps1')
. (Join-Path $PSScriptRoot 'host-package.ps1')
$repoRoot = Split-Path $PSScriptRoot -Parent
$compatibility = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'compatibility.json') -Raw | ConvertFrom-Json
if ($OfficialMsix -and $InstalledPackage) { throw 'Choose OfficialMsix or InstalledPackage, not both.' }
if (!$AddonVersion) { $AddonVersion = $compatibility.addonVersion }
Assert-SandroneVersion $AddonVersion
if ([version]$AddonVersion -lt [version]$compatibility.addonVersion) { throw 'The add-on version cannot precede this source release.' }
if ($BridgePath) {
    if ($BridgeSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Get-SandroneHash $BridgePath) -cne $BridgeSha256) { throw 'A precompiled bridge must match its pinned SHA256.' }
} else { $gcc = Resolve-SandroneCompiler $GccPath }
$makeappx = Resolve-SandroneMakeAppx $MakeAppxPath
if (!$OutputDirectory) { $OutputDirectory = Join-Path $repoRoot ('dist\native-addon\' + [Guid]::NewGuid().ToString('N')) }
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'OutputDirectory must not already exist; builds do not overwrite installed runtimes or previous evidence.' }
foreach ($file in @('runtime\main.cjs', 'runtime\controls.cjs', 'uninstall.ps1', 'install.ps1')) {
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $file))) { throw ('Missing native integration source: ' + $file) }
}
$node = Resolve-SandroneNode $NodePath
$snapshot = Join-Path $output '.source'
$prepared = Export-SandroneHostSource $compatibility $snapshot $OfficialMsix
$target = $prepared.target; $hashes = $prepared.hashes
& $node (Join-Path $PSScriptRoot 'host-compatibility.mjs') $snapshot (Join-Path $PSScriptRoot 'compatibility.json') (Join-Path $output 'compatibility-report.json')
if ($LASTEXITCODE -ne 0) { throw 'The official loading interface is incompatible; no add-on was built or installed.' }
$hostReport = Get-Content -LiteralPath (Join-Path $output 'compatibility-report.json') -Raw | ConvertFrom-Json
$package = Join-Path $output 'package'
$native = Join-Path $package ('VFS\ProgramFilesX64\WindowsApps\' + $target.packageFullName + '\app\resources\native')
$addon = Join-Path $native 'sandrone'
$null = New-Item -ItemType Directory -Path (Join-Path $addon 'management') -Force
$original = Join-Path $native 'windows-updater.original.node'
Copy-Item -LiteralPath (Join-Path $snapshot $compatibility.loader.module) -Destination $original

$renderMode = '--check'
if ($OfficialMsix) { $renderMode = '--ensure' }
if ($RebuildStartupMedia) { $renderMode = '--force' }
& $node (Join-Path $repoRoot 'tools\render-startup.mjs') $renderMode --root $repoRoot
if ($LASTEXITCODE -ne 0) { throw 'Startup media generation/validation failed; no package was created or installed.' }
$startup = Get-Content -LiteralPath (Join-Path $repoRoot 'assets\motion\startup.json') -Raw | ConvertFrom-Json
Copy-SandroneDirectory (Join-Path $PSScriptRoot 'runtime') (Join-Path $addon 'runtime')
foreach ($directory in @('engine', 'vendor', 'themes', 'assets')) {
    Copy-SandroneDirectory (Join-Path $repoRoot $directory) (Join-Path $addon ('theme\' + $directory))
}
foreach ($file in @('LICENSE', 'ASSET-LICENSE.md', 'THIRD-PARTY-NOTICES.md')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $addon 'theme')
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.ps1') -Destination (Join-Path $addon 'management')
$addonFullName = '{0}_{1}_x64__{2}' -f $compatibility.addonName, $AddonVersion, $compatibility.addonPublisherId
$installation = [ordered]@{
    schema = 1
    version = $AddonVersion
    sourceVersion = $compatibility.addonVersion
    addonName = $compatibility.addonName
    addonPackageFullName = $addonFullName
    targetPackage = $target.packageFullName
    targetExecutable = 'app/ChatGPT.exe'
    themeRoot = './theme'
    startupSourceFingerprint = $startup.source.fingerprint
}
Write-SandroneJson (Join-Path $addon 'installation.json') $installation
$proxy = Join-Path $native 'windows-updater.node'
if ($BridgePath) {
    Copy-Item -LiteralPath $BridgePath -Destination $proxy
    if ((Get-SandroneHash $proxy) -cne $BridgeSha256) { throw 'Bridge changed while being copied.' }
} else {
    & $gcc '-shared' '-O2' '-Wall' '-Wextra' '-Werror' '-Wno-cast-function-type' '-static-libgcc' (Join-Path $PSScriptRoot 'bridge.c') '-o' $proxy *> (Join-Path $output 'compile.log')
    if ($LASTEXITCODE -ne 0) { throw ('Native bridge compilation failed. See ' + (Join-Path $output 'compile.log')) }
}
# Validate the PE machine independently of the compiler executable's name.
$stream = [IO.File]::OpenRead($proxy); $binary = New-Object IO.BinaryReader($stream)
try { $stream.Position = 0x3c; $peOffset = $binary.ReadInt32(); $stream.Position = $peOffset; if ($binary.ReadUInt32() -ne 0x00004550 -or $binary.ReadUInt16() -ne 0x8664) { throw 'The compiled native bridge must be an x64 PE image.' } }
finally { $binary.Dispose(); $stream.Dispose() }
$null = New-Item -ItemType Directory -Path (Join-Path $package 'Assets')
Copy-Item -LiteralPath (Join-Path $repoRoot 'assets\characters\sandrone\round-icon.png') -Destination (Join-Path $package 'Assets\Logo.png')
$packageManifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap4="http://schemas.microsoft.com/appx/manifest/uap/windows10/4" xmlns:uap6="http://schemas.microsoft.com/appx/manifest/uap/windows10/6" xmlns:rescap6="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities/6" IgnorableNamespaces="uap4 uap6 rescap6">
  <Identity Name="$($compatibility.addonName)" Publisher="$($compatibility.addonPublisher)" Version="$AddonVersion" ProcessorArchitecture="x64" />
  <Properties><DisplayName>Sandrone Codex native theme</DisplayName><PublisherDisplayName>Sandrone local build</PublisherDisplayName><Logo>Assets/Logo.png</Logo><uap6:AllowExecution>true</uap6:AllowExecution><rescap6:ModificationPackage>true</rescap6:ModificationPackage></Properties>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.22000.0" MaxVersionTested="10.0.26100.0" /><uap4:MainPackageDependency Name="$($target.name)" Publisher="$($target.publisher)" /></Dependencies>
  <Resources><Resource Language="en-us" /></Resources>
</Package>
"@
[IO.File]::WriteAllText((Join-Path $package 'AppxManifest.xml'), $packageManifest, (New-Object Text.UTF8Encoding($false)))
$msix = Join-Path $output ('SandroneCodex.NativeTheme-' + $AddonVersion + '.msix')
& $node (Join-Path $repoRoot 'tools\render-startup.mjs') --check --root $repoRoot
if ($LASTEXITCODE -ne 0) { throw 'Startup sources or media changed during packaging; rebuild from a stable checkout.' }
& $node (Join-Path $repoRoot 'tools\render-startup.mjs') --check-package (Join-Path $addon 'theme') --fingerprint $startup.source.fingerprint
if ($LASTEXITCODE -ne 0) { throw 'Packaged startup inputs or media differ from the verified generation; no package was created.' }
& $makeappx pack /d $package /p $msix /o *> (Join-Path $output 'package.log')
if ($LASTEXITCODE -ne 0) { throw ('MSIX packaging failed. See ' + (Join-Path $output 'package.log')) }
$bundle = [ordered]@{
    schema = 1; version = $AddonVersion; sourceVersion = $compatibility.addonVersion; builtAt = [DateTimeOffset]::Now.ToString('o')
    addonName = $compatibility.addonName; addonPackageFullName = $addonFullName
    addonPublisher = $compatibility.addonPublisher
    targetPackage = $target.packageFullName; targetPublisher = $target.publisher
    officialHashes = $hashes; proxySha256 = Get-SandroneHash $proxy
    packageFile = [IO.Path]::GetFileName($msix); packageSha256 = Get-SandroneHash $msix
    sourceKind = $prepared.sourceKind; sourceMsixSha256 = $prepared.sourceMsixSha256
    compatibility = $hostReport
    startupSourceFingerprint = $startup.source.fingerprint
}
Write-SandroneJson (Join-Path $output 'bundle.json') $bundle
foreach ($file in @('install.ps1', 'uninstall.ps1', 'package-common.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $output }
# This snapshot was created only by this build and is never a linked input.
$snapshotPath = [IO.Path]::GetFullPath($snapshot)
if ($snapshotPath -cne [IO.Path]::GetFullPath((Join-Path $output '.source')) -or !$snapshotPath.StartsWith($output.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe build cleanup path.' }
Remove-Item -LiteralPath $snapshotPath -Recurse -Force
[pscustomobject]@{ status = 'built'; outputDirectory = $output; package = $msix; registered = $false } | ConvertTo-Json -Compress
