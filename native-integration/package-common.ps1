Set-StrictMode -Version Latest

function Get-SandroneHash([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-SandroneJson([string]$Path, $Value) {
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-SandroneTarget($Compatibility, $Identity) {
    if ($Compatibility.schema -ne 2) { throw 'Unsupported compatibility policy schema.' }
    $policy = $Compatibility.host
    $version = [string]$Identity.Version
    if ($Identity.Name -cne $policy.name -or $Identity.Publisher -cne $policy.publisher -or
        $Identity.ProcessorArchitecture -cne $policy.architecture) { throw 'Unsupported official Codex identity, publisher or architecture.' }
    Assert-SandroneVersion $version
    return [pscustomobject]@{
        name = $policy.name; version = $version; publisher = $policy.publisher; architecture = $policy.architecture
        packageFullName = ('{0}_{1}_{2}__{3}' -f $policy.name, $version, $policy.architecture, $policy.publisherId)
        requiredFiles = @($policy.files)
    }
}

function Assert-SandroneVersion([string]$Version) {
    if ($Version -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' -or
        @($Version.Split('.') | Where-Object { [double]$_ -gt 65535 }).Count) { throw 'Expected a four-part MSIX version with components between 0 and 65535.' }
}

function Resolve-SandroneNode([string]$Requested) {
    if ($Requested) { $node = (Get-Item -LiteralPath $Requested).FullName }
    else { $node = (Get-Command node.exe -ErrorAction Stop).Source }
    $version = & $node -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [version]$version -lt [version]'24.0.0') { throw 'Node.js 24 or later is required.' }
    return $node
}

function Assert-SandroneRelativePath([string]$Path) {
    if (!$Path -or [IO.Path]::IsPathRooted($Path) -or $Path -match '(^|[\\/])\.\.([\\/]|$)' -or $Path.Contains(':')) {
        throw 'Package paths must remain relative to the bundle.'
    }
}

function Copy-SandroneDirectory([string]$Source, [string]$Destination) {
    # Reject reparse points, so a package never follows a linked private folder.
    $items = @(Get-Item -LiteralPath $Source) + @(Get-ChildItem -LiteralPath $Source -Recurse -Force)
    foreach ($item in $items) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Linked package input is not supported: ' + $item.FullName) }
    }
    $null = New-Item -ItemType Directory -Path $Destination -Force
    Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Destination -Recurse
}

function Resolve-SandroneCompiler([string]$Requested) {
    if ($Requested) { return (Get-Item -LiteralPath $Requested -ErrorAction Stop).FullName }
    $command = Get-Command gcc.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw 'GCC x64 is required. Add it to PATH or pass -GccPath.'
}

function Resolve-SandroneMakeAppx([string]$Requested) {
    if ($Requested) { return (Get-Item -LiteralPath $Requested -ErrorAction Stop).FullName }
    $command = Get-Command makeappx.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $candidate = Get-ChildItem -LiteralPath $kits -Directory -ErrorAction SilentlyContinue |
        Where-Object Name -match '^\d+\.\d+\.\d+\.\d+$' | Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64\makeappx.exe' } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (!$candidate) { throw 'Windows SDK MakeAppx is required. Install the SDK or pass -MakeAppxPath.' }
    return $candidate
}
