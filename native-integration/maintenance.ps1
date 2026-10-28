[CmdletBinding()]
param(
    [ValidateSet('Install', 'Run', 'Status', 'Stop', 'Uninstall', 'Retry')][string]$Action = 'Status',
    [string]$SourceDirectory,
    [string]$BridgePath,
    [string]$BridgeSha256,
    [string]$NodePath,
    [string]$MakeAppxPath,
    [switch]$Library
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'maintenance-common.ps1')

function Get-MaintenanceRoot {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    return Join-Path $env:ProgramData ('Sandrone\Maintenance\' + $sid)
}

function Get-MaintenanceTaskName { return 'Sandrone-Maintenance-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }

function Assert-MaintenanceAdministrator {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This unsigned native package requires an elevated standalone PowerShell for maintenance setup or control. No automatic elevation is attempted.'
    }
}

function New-MaintenanceAcl([bool]$Directory) {
    $administrators = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $users = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
    if ($Directory) { $acl = New-Object Security.AccessControl.DirectorySecurity }
    else { $acl = New-Object Security.AccessControl.FileSecurity }
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
    if ($Directory) { $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
    $acl.SetOwner($administrators)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($administrators, $system)) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inheritance, 'None', 'Allow')))
    }
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users, 'ReadAndExecute', $inheritance, 'None', 'Allow')))
    return $acl
}

function Protect-MaintenanceDirectory([string]$Directory) {
    Set-Acl -LiteralPath $Directory -AclObject (New-MaintenanceAcl $true)
}

function Get-MaintenanceTree([string]$Root) {
    $item = Get-Item -LiteralPath $Root -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A protected maintenance snapshot contains a reparse point.' }
    $item
    if ($item.PSIsContainer) {
        foreach ($child in Get-ChildItem -LiteralPath $Root -Force) { Get-MaintenanceTree $child.FullName }
    }
}

function Protect-MaintenanceTree([string]$Root) {
    # Replace the DACL, including explicit rules retained from earlier installs.
    # Changing only ownership leaves old writable descendants executable by the worker.
    foreach ($item in @(Get-MaintenanceTree $Root)) {
        Set-Acl -LiteralPath $item.FullName -AclObject (New-MaintenanceAcl $item.PSIsContainer)
    }
}

function Assert-MaintenanceProtected([string]$Root) {
    $expected = [IO.Path]::GetFullPath((Get-MaintenanceRoot))
    if ([IO.Path]::GetFullPath($Root) -cne $expected) { throw 'Unexpected maintenance root.' }
    $null = Assert-MaintenanceChild $env:ProgramData (Join-Path $Root 'config.json')
    $allowed = @('S-1-5-32-544', 'S-1-5-18')
    foreach ($item in @(Get-MaintenanceTree $Root)) {
        $acl = Get-Acl -LiteralPath $item.FullName
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'Maintenance control files must be owned by Administrators or SYSTEM.' }
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            $write = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
                [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
            if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -and $rule.IdentityReference.Value -notin $allowed) {
                throw 'Maintenance control files are writable by an unprivileged identity.'
            }
        }
    }
}

function Copy-MaintenanceTree([string]$Source, [string]$Destination) {
    foreach ($item in @(Get-Item -LiteralPath $Source) + @(Get-ChildItem -LiteralPath $Source -Recurse -Force)) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked maintenance source folders are not supported.' }
    }
    $null = New-Item -ItemType Directory -Path $Destination -Force
    Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Destination -Recurse
}

function Resolve-MaintenanceTool([string]$Requested, [string]$Name) {
    if ($Requested) { return (Get-Item -LiteralPath $Requested).FullName }
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    if ($Name -eq 'makeappx.exe') {
        $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
        $path = Get-ChildItem -LiteralPath $kits -Directory | Where-Object Name -Match '^\d+\.\d+\.\d+\.\d+$' |
            Sort-Object { [version]$_.Name } -Descending | ForEach-Object { Join-Path $_.FullName 'x64\makeappx.exe' } |
            Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if ($path) { return $path }
    }
    throw ('Required maintenance tool not found: ' + $Name)
}

function Install-Maintenance([string]$Source, [string]$Bridge, [string]$BridgeHash, [string]$Node, [string]$MakeAppx) {
    Assert-MaintenanceAdministrator
    if (!$Bridge -or $BridgeHash -cnotmatch '^[a-f0-9]{64}$' -or (Get-MaintenanceHash $Bridge) -cne $BridgeHash) {
        throw 'Pass the tested precompiled bridge and its exact SHA256.'
    }
    $Source = (Get-Item -LiteralPath $Source).FullName
    $nodeSource = Resolve-MaintenanceTool $Node 'node.exe'
    $makeAppxSource = Resolve-MaintenanceTool $MakeAppx 'makeappx.exe'
    & $nodeSource (Join-Path $Source 'tools\render-startup.mjs') --check --root $Source | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Build the startup media before installing maintenance.' }
    $root = Get-MaintenanceRoot
    $null = Assert-MaintenanceChild $env:ProgramData (Join-Path $root 'config.json')
    foreach ($directory in @((Join-Path $env:ProgramData 'Sandrone'), (Join-Path $env:ProgramData 'Sandrone\Maintenance'), $root)) {
        $null = New-Item -ItemType Directory -Path $directory -Force
        Protect-MaintenanceDirectory $directory
    }
    # Every refresh gets its own immutable source/tool snapshot. A running
    # worker is stopped only through its own fixed scheduled task, never Codex.
    $taskName = Get-MaintenanceTaskName
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        $expectedScript = Join-Path $root 'maintenance.ps1'
        if ($existing.Actions.Execute -cne (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -or
            $existing.Actions.Arguments -notlike ('*"' + $expectedScript + '"*')) { throw 'An unrelated scheduled task uses the maintenance name.' }
        Stop-ScheduledTask -TaskName $taskName
    }
    Protect-MaintenanceTree $root
    Assert-MaintenanceProtected $root
    $snapshot = Join-Path $root ('snapshots\' + [Guid]::NewGuid().ToString('N'))
    $sourceRoot = Join-Path $snapshot 'source'
    foreach ($name in @('native-integration', 'engine', 'vendor', 'themes', 'assets', 'tools')) {
        Copy-MaintenanceTree (Join-Path $Source $name) (Join-Path $sourceRoot $name)
    }
    foreach ($name in @('LICENSE', 'ASSET-LICENSE.md', 'THIRD-PARTY-NOTICES.md')) { Copy-Item -LiteralPath (Join-Path $Source $name) -Destination $sourceRoot }
    $bin = Join-Path $snapshot 'bin'; $sdk = Join-Path $bin 'sdk'
    $null = New-Item -ItemType Directory -Path $sdk -Force
    Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $bin 'node.exe')
    Copy-Item -LiteralPath $Bridge -Destination (Join-Path $bin 'bridge.node')
    Copy-Item -LiteralPath $makeAppxSource -Destination (Join-Path $sdk 'makeappx.exe')
    Get-ChildItem -LiteralPath (Split-Path $makeAppxSource -Parent) -File -Filter '*.dll' | Copy-Item -Destination $sdk
    # MakeAppx resolves SDK-private assemblies through side-by-side manifests.
    Get-ChildItem -LiteralPath (Split-Path $makeAppxSource -Parent) -File -Filter '*.manifest' | Copy-Item -Destination $sdk
    $makeAppxHelp = & (Join-Path $sdk 'makeappx.exe') /?
    # The SDK returns 1 for its help command, including a successful launch.
    if ($LASTEXITCODE -notin @(0, 1) -or ($makeAppxHelp -join "`n") -notmatch 'MakeAppx') { throw 'The copied MakeAppx runtime failed its startup check.' }
    $winmd = Get-ChildItem -LiteralPath (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\UnionMetadata') -Directory |
        Where-Object Name -Match '^\d+\.\d+\.\d+\.\d+$' | Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName 'Windows.winmd' } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (!$winmd) { throw 'Windows SDK metadata is required once to build the package event watcher.' }
    $framework = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
    $watcherPath = Join-Path $bin 'maintenance-watcher.dll'
    & (Join-Path $framework 'csc.exe') /nologo /target:library ('/out:' + $watcherPath) ('/reference:' + $winmd) `
        ('/reference:' + (Join-Path $framework 'System.Runtime.dll')) ('/reference:' + (Join-Path $framework 'System.Runtime.WindowsRuntime.dll')) `
        ('/reference:' + (Join-Path $framework 'System.Runtime.InteropServices.WindowsRuntime.dll')) (Join-Path $sourceRoot 'native-integration\maintenance-watcher.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Package event watcher compilation failed.' }
    $compatibility = Read-MaintenanceJson (Join-Path $sourceRoot 'native-integration\compatibility.json')
    $config = [ordered]@{
        schema = 1; installedAt = [DateTimeOffset]::UtcNow.ToString('o'); ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        sourceRoot = $sourceRoot; sourceFingerprint = Get-MaintenanceFingerprint $sourceRoot; versionFloor = $compatibility.addonVersion
        nodePath = Join-Path $bin 'node.exe'; nodeSha256 = Get-MaintenanceHash (Join-Path $bin 'node.exe')
        makeAppxPath = Join-Path $sdk 'makeappx.exe'; makeAppxSha256 = Get-MaintenanceHash (Join-Path $sdk 'makeappx.exe')
        bridgePath = Join-Path $bin 'bridge.node'; bridgeSha256 = $BridgeHash
        watcherPath = $watcherPath; watcherSha256 = Get-MaintenanceHash $watcherPath
        settingsRoot = Join-Path $env:LOCALAPPDATA 'Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Roaming\Codex\web\Codex\sandrone-theme'
    }
    foreach ($directory in @('jobs', 'builds')) { $null = New-Item -ItemType Directory -Path (Join-Path $root $directory) -Force }
    foreach ($name in @('maintenance.ps1', 'maintenance-common.ps1')) { Copy-Item -LiteralPath (Join-Path $sourceRoot ('native-integration\' + $name)) -Destination $root -Force }
    Write-MaintenanceJson (Join-Path $root 'config.json') $config
    $stop = Join-Path $root 'stop'; if (Test-Path -LiteralPath $stop) { Remove-Item -LiteralPath $stop }
    Protect-MaintenanceTree $root
    Assert-MaintenanceProtected $root
    $executable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $root 'maintenance.ps1') + '" -Action Run'
    $action = New-ScheduledTaskAction -Execute $executable -Argument $arguments
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $null = Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force
    Start-ScheduledTask -TaskName $taskName
    return [pscustomobject]@{ status = 'maintenance-installed'; taskName = $taskName; root = $root; sourceFingerprint = $config.sourceFingerprint; applicationInstalled = $false }
}

function Run-Maintenance([string]$Root) {
    Assert-MaintenanceAdministrator
    Assert-MaintenanceProtected $Root
    $config = Read-MaintenanceJson (Join-Path $Root 'config.json')
    if (!$config -or $config.schema -ne 1 -or $config.ownerSid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Maintenance configuration does not belong to the current user.' }
    foreach ($name in @('sourceRoot', 'nodePath', 'makeAppxPath', 'bridgePath', 'watcherPath')) { $null = Assert-MaintenanceChild $Root $config.$name }
    $lock = $null; $watcher = $null
    try {
        try { $lock = [IO.File]::Open((Join-Path $Root 'worker.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { return }
        if ((Get-MaintenanceHash $config.watcherPath) -cne $config.watcherSha256) { throw 'Package watcher digest changed.' }
        try {
            Add-Type -Path $config.watcherPath
            $watcher = New-Object Sandrone.Maintenance.PackageWatcher
            Write-MaintenanceJson (Join-Path $Root 'worker.json') @{ pid = $PID; startedAt = [DateTimeOffset]::UtcNow.ToString('o'); events = $true; fallbackSeconds = 30 }
        } catch {
            Write-MaintenanceJson (Join-Path $Root 'worker.json') @{ pid = $PID; startedAt = [DateTimeOffset]::UtcNow.ToString('o'); events = $false; fallbackSeconds = 30; eventError = $_.Exception.Message }
        }
        while (!(Test-Path -LiteralPath (Join-Path $Root 'stop'))) {
            $retryPath = Join-Path $Root 'retry'
            $retry = Test-Path -LiteralPath $retryPath
            if ($retry) { Remove-Item -LiteralPath $retryPath }
            try { $null = Invoke-MaintenanceReconcile $config $Root -Retry:$retry }
            catch { Write-MaintenanceJson (Join-Path $Root 'worker-error.json') @{ at = [DateTimeOffset]::UtcNow.ToString('o'); message = $_.Exception.Message } }
            if ($watcher) { $null = $watcher.Wait(30000) } else { Start-Sleep -Seconds 30 }
        }
    } finally {
        if ($watcher) { $watcher.Dispose() }
        if ($lock) { $lock.Dispose() }
    }
}

if (!$Library) {
    $root = Get-MaintenanceRoot
    switch ($Action) {
        'Install' {
            if (!$SourceDirectory) { $SourceDirectory = Split-Path $PSScriptRoot -Parent }
            Install-Maintenance $SourceDirectory $BridgePath $BridgeSha256 $NodePath $MakeAppxPath | ConvertTo-Json -Depth 5 -Compress
        }
        'Status' {
            [ordered]@{ root = $root; task = @(Get-ScheduledTask -TaskName (Get-MaintenanceTaskName) -ErrorAction SilentlyContinue | Select-Object TaskName, State); state = Read-MaintenanceJson (Join-Path $root 'state.json'); worker = Read-MaintenanceJson (Join-Path $root 'worker.json') } | ConvertTo-Json -Depth 8
        }
        'Run' { Run-Maintenance $root }
        'Stop' { Assert-MaintenanceAdministrator; Assert-MaintenanceProtected $root; [IO.File]::WriteAllText((Join-Path $root 'stop'), 'User requested maintenance stop.'); Write-Output 'Maintenance will stop after its current bounded operation. Codex is not closed.' }
        'Retry' {
            Assert-MaintenanceAdministrator; Assert-MaintenanceProtected $root
            $stop = Join-Path $root 'stop'; if (Test-Path -LiteralPath $stop) { Remove-Item -LiteralPath $stop }
            [IO.File]::WriteAllText((Join-Path $root 'retry'), [DateTimeOffset]::UtcNow.ToString('o'))
            Start-ScheduledTask -TaskName (Get-MaintenanceTaskName)
            Write-Output 'One explicit retry was queued for the current target.'
        }
        'Uninstall' {
            Assert-MaintenanceAdministrator; Assert-MaintenanceProtected $root
            [IO.File]::WriteAllText((Join-Path $root 'stop'), 'Maintenance was uninstalled.')
            Unregister-ScheduledTask -TaskName (Get-MaintenanceTaskName) -Confirm:$false -ErrorAction SilentlyContinue
            Write-Output 'Maintenance logon task removed. The worker will stop, and the theme, preferences and evidence remain unchanged.'
        }
    }
}
