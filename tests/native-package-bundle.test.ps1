param([Parameter(Mandatory = $true)][string]$BundleDirectory)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
. (Join-Path $repo 'native-integration\package-common.ps1')
$bundle = Get-Content -LiteralPath (Join-Path $BundleDirectory 'bundle.json') -Raw | ConvertFrom-Json
$file = Join-Path $BundleDirectory $bundle.packageFile
if ((Get-SandroneHash $file) -cne $bundle.packageSha256) { throw 'MSIX digest does not match its build receipt.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($file)
function Read-Entry([string]$Name) {
    $entry = $archive.GetEntry($Name)
    if (!$entry) { throw ('Missing package entry: ' + $Name) }
    $reader = New-Object IO.StreamReader($entry.Open())
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Entry-Hash([string]$Name) {
    $entry = $archive.GetEntry($Name)
    if (!$entry) { throw ('Missing package entry: ' + $Name) }
    $stream = $entry.Open(); $hasher = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Dispose() }
}
try {
    $native = 'VFS/ProgramFilesX64/WindowsApps/' + $bundle.targetPackage + '/app/resources/native/'
    $xml = [xml](Read-Entry 'AppxManifest.xml')
    if ($xml.Package.Identity.Name -cne $bundle.addonName -or $xml.Package.Identity.Version -cne $bundle.version) { throw 'Manifest identity differs from receipt.' }
    if ((Entry-Hash ($native + 'windows-updater.original.node')) -cne $bundle.officialHashes.'app/resources/native/windows-updater.node') { throw 'Original updater bytes changed.' }
    if ((Entry-Hash ($native + 'windows-updater.node')) -cne $bundle.proxySha256) { throw 'Native bridge bytes changed.' }
    $installation = Read-Entry ($native + 'sandrone/installation.json') | ConvertFrom-Json
    if ($installation.addonPackageFullName -cne $bundle.addonPackageFullName -or $installation.targetPackage -cne $bundle.targetPackage) { throw 'Runtime metadata differs from package identity.' }
    if (!$bundle.compatibility.compatible -or $bundle.compatibility.loader -cne 'windows-updater-napi-v1' -or $bundle.sourceKind -notin @('signed-msix', 'installed-store-package')) { throw 'Missing verified source/loading contract evidence.' }
    if ($bundle.sourceKind -ceq 'installed-store-package' -and $null -ne $bundle.sourceMsixSha256) { throw 'Installed-source build cannot claim a downloaded MSIX digest.' }
    $startup = Read-Entry ($native + 'sandrone/theme/assets/motion/startup.json') | ConvertFrom-Json
    if ($startup.source.fingerprint -notmatch '^[a-f0-9]{64}$' -or $startup.source.fingerprint -cne $bundle.startupSourceFingerprint -or $startup.source.fingerprint -cne $installation.startupSourceFingerprint) { throw 'Startup source version differs from the build receipt.' }
    foreach ($inputFile in $startup.source.files) {
        Assert-SandroneRelativePath $inputFile.file
        if ($inputFile.file -match '^(engine|assets)/' -and (Entry-Hash ($native + 'sandrone/theme/' + $inputFile.file)) -cne $inputFile.sha256) { throw ('Packaged startup input differs from the rendered source: ' + $inputFile.file) }
    }
    foreach ($asset in @($startup.intro, $startup.idle, $startup.poster, $startup.still)) {
        if ($asset.file -notmatch '^sandrone-startup-(intro|idle|poster|still)\.(mp4|jpg)$') { throw 'Invalid startup media path.' }
        $entryName = $native + 'sandrone/theme/assets/motion/' + $asset.file
        if ((Entry-Hash $entryName) -cne $asset.sha256 -or $archive.GetEntry($entryName).Length -ne $asset.bytes) { throw ('Packaged startup output differs from its manifest: ' + $asset.file) }
    }
    foreach ($relative in @('runtime/main.cjs', 'runtime/controls.cjs', 'runtime/host-adapter.cjs', 'runtime/startup.cjs', 'runtime/startup-preload.cjs', 'runtime/startup-readiness.cjs', 'management/uninstall.ps1', 'theme/engine/renderer.mjs', 'theme/vendor/dream-skin/windows/scripts/injector.mjs', 'theme/themes/sandrone/manifest.json', 'theme/assets/motion/sandrone-loop-1080p.mp4', 'theme/assets/motion/startup.json', 'theme/assets/motion/sandrone-startup-intro.mp4', 'theme/assets/motion/sandrone-startup-idle.mp4', 'theme/assets/motion/sandrone-startup-poster.jpg', 'theme/assets/motion/sandrone-startup-still.jpg')) {
        if (!$archive.GetEntry($native + 'sandrone/' + $relative)) { throw ('Bundle is not self-contained: ' + $relative) }
    }
    foreach ($entry in $archive.Entries) {
        if ($entry.FullName -match '(^|/)(profile|state|logs|backups|machine\.json)(/|$)') { throw 'Runtime state was included in the package.' }
        if ($entry.FullName -match '\.(cjs|mjs|ps1|json)$') {
            $text = Read-Entry $entry.FullName
            if ($text -match '(?i)[A-Z]:[\\/]+Users[\\/]+[^\\/\s"'']+') { throw ('Personal machine path in package: ' + $entry.FullName) }
        }
    }
    Write-Output 'Native package archive verified: self-contained assets, exact original updater, metadata, and no personal paths/state.'
} finally { $archive.Dispose() }
