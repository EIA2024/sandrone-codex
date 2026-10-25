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
    $targets = @($Compatibility.targets | Where-Object {
        $_.name -ceq $Identity.Name -and $_.version -ceq $Identity.Version -and
        $_.publisher -ceq $Identity.Publisher -and $_.architecture -ceq $Identity.ProcessorArchitecture
    })
    if ($targets.Count -ne 1) { throw 'Unsupported official Codex package. Add and verify an explicit compatibility entry before building.' }
    return $targets[0]
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
