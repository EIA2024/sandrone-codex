Set-StrictMode -Version Latest

function Assert-SandroneOutsidePackage {
    if (!('SandronePackageIdentity' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SandronePackageIdentity {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetCurrentPackageFullName(ref uint length, IntPtr name);
}
'@
    }
    [uint32]$length = 0
    if ([SandronePackageIdentity]::GetCurrentPackageFullName([ref]$length, [IntPtr]::Zero) -ne 15700) {
        throw 'Installed-source builds must run from standalone PowerShell or the external maintenance helper, outside an MSIX overlay. Alternatively pass an official signed MSIX.'
    }
}

function Assert-SandroneRegisteredHost($Package, $Compatibility) {
    if (!$Package -or $Package.SignatureKind.ToString() -ne 'Store' -or $Package.Status.ToString() -ne 'Ok' -or $Package.IsDevelopmentMode) {
        throw 'An intact official Codex Store registration is required.'
    }
    $identity = [pscustomobject]@{ Name=$Package.Name; Version=$Package.Version.ToString(); Publisher=$Package.Publisher; ProcessorArchitecture=$Package.Architecture.ToString().ToLowerInvariant() }
    $target = Get-SandroneTarget $Compatibility $identity
    if ($Package.PackageFullName -cne $target.packageFullName) { throw 'Registered Codex identity does not match its expected publisher ID.' }
    return $target
}

function Assert-SandroneInstalledIntegrity([string]$PackageFullName) {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Management.Deployment.PackageManager, Windows.Management.Deployment, ContentType = WindowsRuntime]
    $manager = New-Object Windows.Management.Deployment.PackageManager
    $package = $manager.FindPackageForUser('', $PackageFullName)
    if (!$package) { throw 'The official package disappeared during verification.' }
    $operation = $package.VerifyContentIntegrityAsync()
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    if (!$method) { throw 'Windows package integrity verification is unavailable.' }
    $task = $method.MakeGenericMethod([bool]).Invoke($null, @($operation))
    if (!$task.Wait(300000)) { throw 'Windows package integrity verification timed out.' }
    if (!$task.GetAwaiter().GetResult()) { throw 'Windows reports modified official package content.' }
}

function Export-SandroneHostSource($Compatibility, [string]$Destination, [string]$OfficialMsix) {
    $hashes = [ordered]@{}
    $sourceHash = $null
    if ($OfficialMsix) {
        $source = (Get-Item -LiteralPath $OfficialMsix).FullName
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        # Keep the archive read-locked during signature verification and extraction.
        $archive = [IO.Compression.ZipFile]::OpenRead($source)
        try {
            $signature = Get-AuthenticodeSignature -LiteralPath $source
            if ($signature.Status.ToString() -ne 'Valid' -or $signature.SignerCertificate.Subject -cne $Compatibility.host.publisher) {
                throw 'The source MSIX must have a valid signature from the official Codex publisher.'
            }
            $manifestEntry = $archive.GetEntry('AppxManifest.xml')
            if (!$manifestEntry) { throw 'Source archive has no AppxManifest.xml.' }
            $reader = New-Object IO.StreamReader($manifestEntry.Open())
            try { $xml = New-Object Xml.XmlDocument; $xml.XmlResolver = $null; $xml.LoadXml($reader.ReadToEnd()) } finally { $reader.Dispose() }
            $target = Get-SandroneTarget $Compatibility $xml.Package.Identity
            foreach ($relative in $target.requiredFiles) {
                Assert-SandroneRelativePath $relative
                $entries = @($archive.Entries | Where-Object FullName -CEQ $relative)
                if ($entries.Count -ne 1) { throw ('Missing or ambiguous official file: ' + $relative) }
                $file = Join-Path $Destination $relative
                $null = New-Item -ItemType Directory -Path (Split-Path $file -Parent) -Force
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $file)
                $hashes[$relative] = Get-SandroneHash $file
            }
            $sourceHash = Get-SandroneHash $source
        } finally { $archive.Dispose() }
        $sourceKind = 'signed-msix'
    } else {
        Assert-SandroneOutsidePackage
        $package = Get-AppxPackage -Name $Compatibility.host.name
        $target = Assert-SandroneRegisteredHost $package $Compatibility
        Assert-SandroneInstalledIntegrity $target.packageFullName
        foreach ($relative in $target.requiredFiles) {
            Assert-SandroneRelativePath $relative
            $source = Join-Path $package.InstallLocation $relative
            $item = Get-Item -LiteralPath $source
            if ($item.PSIsContainer -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Invalid official file: ' + $relative) }
            $file = Join-Path $Destination $relative
            $null = New-Item -ItemType Directory -Path (Split-Path $file -Parent) -Force
            Copy-Item -LiteralPath $source -Destination $file
            $hashes[$relative] = Get-SandroneHash $file
            if ($hashes[$relative] -cne (Get-SandroneHash $source)) { throw 'Official package changed during copying.' }
        }
        Assert-SandroneInstalledIntegrity $target.packageFullName
        $after = Assert-SandroneRegisteredHost (Get-AppxPackage -Name $Compatibility.host.name) $Compatibility
        if ($after.packageFullName -cne $target.packageFullName) { throw 'Codex updated during preparation; prepare the newly registered version instead.' }
        $sourceKind = 'installed-store-package'
    }
    return [pscustomobject]@{ target=$target; hashes=$hashes; sourceKind=$sourceKind; sourceMsixSha256=$sourceHash }
}
