[CmdletBinding()]
param(
    [ValidateSet('Schedule', 'Run', 'Cancel', 'Status', 'Remove')][string]$Action = 'Status',
    [string]$StateDirectory,
    [string]$ExpectedPackageFullName,
    [string]$RequestId,
    [switch]$Library
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-SandroneAddonIdentity([string]$Identity) {
    if ($Identity -cnotmatch '^Local\.Sandrone\.CodexNativeTheme_[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+_x64__vt89pjxv8jer8$') {
        throw 'Only an exact Sandrone native add-on identity can be removed.'
    }
}

function Get-SandroneAddon([string]$Identity) {
    Assert-SandroneAddonIdentity $Identity
    $matches = @(Get-AppxPackage -PackageTypeFilter Optional | Where-Object PackageFullName -CEQ $Identity)
    if ($matches.Count -gt 1) { throw 'Ambiguous Sandrone package registration.' }
    if ($matches.Count -eq 1) { return $matches[0] }
    return $null
}

function Get-SandroneRunningHosts {
    # All official Codex versions are considered, including a restart/update
    # during the wait. Inaccessible process identity is treated conservatively.
    foreach ($process in @(Get-Process ChatGPT -ErrorAction SilentlyContinue)) {
        $filename = $null
        try { $filename = $process.Path } catch {}
        if (!$filename -or $filename -match '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$') {
            $process.Id
        }
    }
}

function Read-SandroneRemoval([string]$Directory) {
    $file = Join-Path $Directory 'uninstall-request.json'
    if (!(Test-Path -LiteralPath $file)) { return $null }
    $item = Get-Item -LiteralPath $file
    if ($item.Length -gt 16384) { throw 'Uninstall request is too large.' }
    $request = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if ($request.schema -ne 1) { throw 'Unsupported uninstall request format.' }
    Assert-SandroneAddonIdentity $request.packageFullName
    return $request
}

function Write-SandroneRemoval([string]$Directory, $Request) {
    $file = Join-Path $Directory 'uninstall-request.json'
    $temporary = $file + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, ($Request | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $file -Force
}

function New-SandroneRemovalMutex([string]$Directory) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $key = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Directory.ToLowerInvariant()))).Replace('-', '') }
    finally { $hasher.Dispose() }
    return New-Object Threading.Mutex($false, ('Local\SandroneThemeRemoval-' + $key))
}

function Enter-SandroneRemovalLock($Mutex) {
    try { $locked = $Mutex.WaitOne(3000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { throw 'Theme removal is busy. Retry after the current operation.' }
}

function Get-SandroneRemovalStatus($Request) {
    if (!$Request) { return [pscustomobject]@{ status = 'idle'; message = 'No theme uninstall is scheduled.' } }
    return [pscustomobject]@{
        status = $Request.status; requestId = $Request.requestId; packageFullName = $Request.packageFullName
        message = $Request.message; error = $Request.error; workerPid = $Request.workerPid
    }
}

function Remove-SandroneAddon([string]$Identity) {
    Assert-SandroneAddonIdentity $Identity
    if (@(Get-SandroneRunningHosts).Count) { throw 'Codex is still running. Exit normally; the uninstaller never terminates it.' }
    $addon = Get-SandroneAddon $Identity
    if ($addon) {
        Invoke-SandroneDeferredRemoval $addon.PackageFullName
        if (Get-SandroneAddon $Identity) {
            return [pscustomobject]@{ status = 'removing'; packageFullName = $Identity; message = 'Windows is deferring removal until remaining package references are released. No application shutdown was requested.' }
        }
    }
    return [pscustomobject]@{ status = 'completed'; packageFullName = $Identity; message = 'Theme add-on removed. Theme preferences and official Codex data are retained.' }
}

function Invoke-SandroneDeferredRemoval([string]$Identity) {
    # Remove-AppxPackage may request application shutdown. The WinRT option
    # closes the restart race and also covers a worker inheriting package identity.
    # This operation cannot be cancelled after submission to Windows.
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Management.Deployment.PackageManager, Windows.Management.Deployment, ContentType = WindowsRuntime]
    $null = [Windows.Management.Deployment.RemovalOptions, Windows.Management.Deployment, ContentType = WindowsRuntime]
    $null = [Windows.Management.Deployment.DeploymentResult, Windows.Management.Deployment, ContentType = WindowsRuntime]
    $null = [Windows.Management.Deployment.DeploymentProgress, Windows.Management.Deployment, ContentType = WindowsRuntime]
    $manager = New-Object Windows.Management.Deployment.PackageManager
    $operation = $manager.RemovePackageAsync($Identity, [Windows.Management.Deployment.RemovalOptions]::DeferRemovalWhenPackagesAreInUse)
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 2 -and $_.GetParameters().Count -eq 1
    } | Select-Object -First 1
    if (!$method) { throw 'Windows Runtime deployment completion adapter is unavailable.' }
    $adapter = $method.MakeGenericMethod([Windows.Management.Deployment.DeploymentResult], [Windows.Management.Deployment.DeploymentProgress])
    $task = $adapter.Invoke($null, @($operation))
    if ($task.Wait(10000)) {
        $result = $task.GetAwaiter().GetResult()
        if ($result.ExtendedErrorCode -and $result.ExtendedErrorCode.HResult -ne 0) { throw ('Windows rejected deferred removal: ' + $result.ErrorText) }
    }
}

function Invoke-SandroneUninstall([string]$Operation, [string]$Directory, [string]$Identity, [string]$Token) {
    Assert-SandroneAddonIdentity $Identity
    if (!$Directory -or ![IO.Path]::IsPathRooted($Directory)) { throw 'StateDirectory must be an absolute local directory.' }
    $directoryPath = [IO.Path]::GetFullPath($Directory)
    if ($directoryPath.StartsWith('\\') -or $directoryPath.Contains('"') -or $directoryPath -match '[\r\n]') { throw 'StateDirectory must be an absolute local directory.' }
    $null = New-Item -ItemType Directory -Path $directoryPath -Force
    $mutex = New-SandroneRemovalMutex $directoryPath
    try {
        if ($Operation -eq 'Run') {
            if ($Token -cnotmatch '^[a-f0-9]{32}$') { throw 'Invalid uninstall worker request.' }
            while ($true) {
                Enter-SandroneRemovalLock $mutex
                try {
                    $request = Read-SandroneRemoval $directoryPath
                    if (!$request -or $request.requestId -cne $Token -or $request.packageFullName -cne $Identity -or $request.status -ne 'scheduled') { return Get-SandroneRemovalStatus $request }
                    if ([DateTimeOffset]::Parse($request.expiresAt) -lt [DateTimeOffset]::Now) {
                        $request.status = 'error'; $request.error = 'REQUEST_EXPIRED'; $request.message = 'The uninstall request expired; schedule it again from the theme menu.'
                        Write-SandroneRemoval $directoryPath $request
                        return Get-SandroneRemovalStatus $request
                    }
                    if (!@(Get-SandroneRunningHosts).Count) {
                        # Keep the lock across the final check and removal, so a
                        # cancellation cannot report success after removal began.
                        $request.status = 'removing'; $request.message = 'Removing the theme add-on.'
                        Write-SandroneRemoval $directoryPath $request
                        try {
                            $result = Remove-SandroneAddon $Identity
                            $request.status = $result.status; $request.message = $result.message
                        } catch {
                            $request.status = 'error'; $request.error = $_.Exception.Message
                            $request.message = 'Theme removal failed. The official Codex package was not selected for removal.'
                        }
                        Write-SandroneRemoval $directoryPath $request
                        return Get-SandroneRemovalStatus $request
                    }
                } finally { $mutex.ReleaseMutex() }
                Start-Sleep -Milliseconds 750
            }
        }
        Enter-SandroneRemovalLock $mutex
        try {
            $request = Read-SandroneRemoval $directoryPath
            if ($request -and $request.packageFullName -cne $Identity -and $request.status -in @('scheduled', 'removing')) { throw 'Another version already has a pending uninstall request.' }
            if ($Operation -in @('Status', 'Schedule')) {
                if ($request -and $request.status -eq 'scheduled') {
                    $worker = $null
                    if ($request.workerPid) { $worker = Get-Process -Id $request.workerPid -ErrorAction SilentlyContinue }
                    if (!$worker -or $worker.StartTime.ToUniversalTime().Ticks.ToString() -cne $request.workerStarted) {
                        $request.status = 'error'; $request.error = 'WORKER_STOPPED'; $request.message = 'The uninstall worker stopped. Schedule removal again.'
                        Write-SandroneRemoval $directoryPath $request
                    }
                }
                if ($request -and $request.status -eq 'removing' -and !(Get-SandroneAddon $request.packageFullName)) {
                    $request.status = 'completed'; $request.message = 'Theme add-on registration removed. Windows may retain staged files while they remain in use.'
                    Write-SandroneRemoval $directoryPath $request
                }
                if ($request -and $request.status -eq 'completed' -and (Get-SandroneAddon $Identity)) {
                    $request.status = 'idle'; $request.message = 'The theme add-on is installed again; no removal is scheduled.'
                    Write-SandroneRemoval $directoryPath $request
                }
                if ($Operation -eq 'Status') { return Get-SandroneRemovalStatus $request }
            }
            if ($Operation -eq 'Cancel') {
                if ($request -and $request.status -eq 'scheduled') {
                    $request.status = 'cancelled'; $request.message = 'Scheduled theme removal was cancelled.'
                    Write-SandroneRemoval $directoryPath $request
                }
                return Get-SandroneRemovalStatus $request
            }
            if ($Operation -eq 'Remove') { return Remove-SandroneAddon $Identity }
            if ($request -and $request.status -in @('scheduled', 'removing')) { return Get-SandroneRemovalStatus $request }
            if (!(Get-SandroneAddon $Identity)) { return [pscustomobject]@{ status = 'completed'; message = 'This theme add-on is not installed.' } }
            $request = [pscustomobject]@{
                schema = 1; requestId = [Guid]::NewGuid().ToString('N'); status = 'scheduled'; packageFullName = $Identity
                expiresAt = [DateTimeOffset]::Now.AddHours(24).ToString('o'); message = 'Theme removal is scheduled after all Codex windows and tray processes exit.'
                error = $null; workerPid = $null; workerStarted = $null
            }
            Write-SandroneRemoval $directoryPath $request
            # Encode PowerShell source rather than interpolating paths into a
            # command line. Single quotes in filesystem paths are escaped.
            $script = $PSCommandPath.Replace("'", "''")
            $state = $directoryPath.Replace("'", "''")
            $command = "& '$script' -Action Run -StateDirectory '$state' -ExpectedPackageFullName '$Identity' -RequestId '$($request.requestId)'"
            $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
            $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
            try {
                $worker = Start-Process -FilePath $powershell -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) -WindowStyle Hidden -PassThru
                $request.workerPid = $worker.Id; $request.workerStarted = $worker.StartTime.ToUniversalTime().Ticks.ToString()
                Write-SandroneRemoval $directoryPath $request
            } catch {
                $request.status = 'error'; $request.error = $_.Exception.Message; $request.message = 'Could not start the uninstall worker.'
                Write-SandroneRemoval $directoryPath $request
            }
            return Get-SandroneRemovalStatus $request
        } finally { $mutex.ReleaseMutex() }
    } finally { $mutex.Dispose() }
}

if (!$Library) {
    try { Invoke-SandroneUninstall $Action $StateDirectory $ExpectedPackageFullName $RequestId | ConvertTo-Json -Compress }
    catch { [pscustomobject]@{ status = 'error'; error = $_.Exception.Message; message = 'Theme operation did not complete.' } | ConvertTo-Json -Compress; exit 1 }
}
