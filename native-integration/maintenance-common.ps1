Set-StrictMode -Version Latest

function Get-MaintenanceHash([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-MaintenanceJson([string]$Path, $Value) {
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Read-MaintenanceJson([string]$Path) {
    if (!(Test-Path -LiteralPath $Path)) { return $null }
    $item = Get-Item -LiteralPath $Path
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint -or $item.Length -gt 2MB) { throw 'Invalid maintenance state file.' }
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Assert-MaintenanceChild([string]$Root, [string]$Path) {
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $fullPath = [IO.Path]::GetFullPath($Path)
    if (!$fullPath.StartsWith($rootPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Maintenance path escaped its protected directory.' }
    $cursor = $fullPath
    while ($cursor.Length -ge $rootPath.Length) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Maintenance does not follow reparse points.' }
        }
        $cursor = Split-Path $cursor -Parent
    }
    return $fullPath
}

function Get-MaintenanceFingerprint([string]$Directory) {
    $root = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    $records = foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object FullName) {
        $null = Assert-MaintenanceChild $root $file.FullName
        $relative = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
        $relative + ':' + (Get-MaintenanceHash $file.FullName)
    }
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes(($records -join "`n")))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Get-MaintenanceKey([string]$Fingerprint, [string]$Target) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Fingerprint + ':' + $Target))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Assert-MaintenanceJob($Config, [string]$Root, $Job, [string]$Key, [string]$Target) {
    if ($Job.schema -ne 1 -or $Job.key -cne $Key -or $Job.targetPackage -cne $Target -or
        $Job.sourceFingerprint -cne $Config.sourceFingerprint) { throw 'Maintenance job identity differs from its source and target.' }
    if ($Job.outputDirectory) {
        $buildRoot = Assert-MaintenanceChild $Root (Join-Path $Root 'builds')
        if (![IO.Path]::IsPathRooted($Job.outputDirectory)) { throw 'Maintenance output directory must be absolute.' }
        $null = Assert-MaintenanceChild $buildRoot $Job.outputDirectory
    } elseif ($Job.phase -in @('building', 'prepared', 'waiting-for-exit', 'submitted', 'registered', 'loaded')) {
        throw 'Maintenance job has no protected output directory.'
    }
}

function Set-MaintenancePhase([string]$Root, $Job, [string]$Phase, [string]$Message = '') {
    $Job.phase = $Phase; $Job.message = $Message; $Job.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Write-MaintenanceJson (Join-Path $Root ('jobs\' + $Job.key + '.json')) $Job
    Write-MaintenanceJson (Join-Path $Root 'state.json') $Job
}

function Get-MaintenanceNextVersion([string]$Floor, [string]$Installed, [string]$Reserved) {
    $minimum = [version]$Floor
    $highest = [version]'0.0.0.0'
    foreach ($candidate in @($Installed, $Reserved)) {
        if ($candidate -and [version]$candidate -gt $highest) { $highest = [version]$candidate }
    }
    if ($minimum -gt $highest) { return $minimum.ToString(4) }
    $parts = @($highest.Major, $highest.Minor, $highest.Build, $highest.Revision)
    for ($index = 3; $index -ge 0; $index--) {
        if ($parts[$index] -lt 65535) { $parts[$index]++; return $parts -join '.' }
        $parts[$index] = 0
    }
    throw 'No higher MSIX version is available.'
}

function Get-MaintenanceHost { return Get-AppxPackage -Name OpenAI.Codex }

function Get-MaintenanceAddon {
    $items = @(Get-AppxPackage -PackageTypeFilter Optional | Where-Object Name -CEQ 'Local.Sandrone.CodexNativeTheme')
    if ($items.Count -gt 1) { throw 'Ambiguous Sandrone package registration.' }
    if ($items.Count) { return $items[0] }
    return $null
}

function Get-MaintenanceRunningHosts {
    foreach ($process in @(Get-Process ChatGPT -ErrorAction SilentlyContinue)) {
        $filename = $null; try { $filename = $process.Path } catch {}
        if (!$filename -or $filename -match '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$') { $process.Id }
    }
}

function Test-MaintenanceRegistration($HostPackage, $Addon, [string]$Expected) {
    return [bool]($HostPackage -and $Addon -and $Addon.PackageFullName -ceq $Expected -and
        @($HostPackage.Dependencies | Where-Object PackageFullName -CEQ $Expected).Count -eq 1)
}

function Get-MaintenanceRuntimeReceipt($Config, $Job) {
    $file = Join-Path $Config.settingsRoot 'events.jsonl'
    if (!(Test-Path -LiteralPath $file) -or !$Job.registeredAt) { return $null }
    foreach ($line in (Get-Content -LiteralPath $file -Tail 300 -Encoding UTF8)) {
        try {
            $event = $line | ConvertFrom-Json
            if ($event.event -ceq 'runtime-loaded' -and $event.addonPackageFullName -ceq $Job.addonPackageFullName -and
                $event.targetPackage -ceq $Job.targetPackage -and [DateTimeOffset]::Parse($event.at) -ge [DateTimeOffset]::Parse($Job.registeredAt)) { return $event }
        } catch { }
    }
    return $null
}

function Test-MaintenanceRemoval($Config, $Addon) {
    $request = Read-MaintenanceJson (Join-Path $Config.settingsRoot 'uninstall-request.json')
    if (!$request -or $request.schema -ne 1) { return $false }
    if ($request.status -ceq 'scheduled' -and $request.PSObject.Properties['expiresAt'] -and
        [DateTimeOffset]::Parse($request.expiresAt) -le [DateTimeOffset]::UtcNow) { return $false }
    return [bool]($request.status -in @('scheduled', 'removing', 'completed') -and
        (!$Addon -or $request.packageFullName -ceq $Addon.PackageFullName))
}

function Assert-MaintenanceInputs($Config) {
    foreach ($tool in @(@($Config.nodePath, $Config.nodeSha256), @($Config.makeAppxPath, $Config.makeAppxSha256), @($Config.bridgePath, $Config.bridgeSha256))) {
        if ((Get-MaintenanceHash $tool[0]) -cne $tool[1]) { throw ('Maintenance input changed: ' + $tool[0]) }
    }
    if ((Get-MaintenanceFingerprint $Config.sourceRoot) -cne $Config.sourceFingerprint) { throw 'Protected maintenance sources changed. Run maintenance Install again to accept new sources.' }
    # Never render in the background. A source refresh must bring verified,
    # pre-rendered media; build's ensure step can then only reuse these files.
    & $Config.nodePath (Join-Path $Config.sourceRoot 'tools\render-startup.mjs') --check --root $Config.sourceRoot | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Maintenance startup media preflight failed.' }
}

function Invoke-MaintenanceBuild($Config, $Job) {
    Assert-MaintenanceInputs $Config
    $build = Join-Path $Config.sourceRoot 'native-integration\build.ps1'
    & $build -InstalledPackage -OutputDirectory $Job.outputDirectory -BridgePath $Config.bridgePath -BridgeSha256 $Config.bridgeSha256 `
        -AddonVersion $Job.version -NodePath $Config.nodePath -MakeAppxPath $Config.makeAppxPath *>&1 |
        Out-File -LiteralPath ($Job.outputDirectory + '.log') -Encoding utf8
    if (!(Test-Path -LiteralPath (Join-Path $Job.outputDirectory 'bundle.json'))) { throw 'Maintenance build did not produce a complete bundle.' }
}

function Test-MaintenanceBundle($Config, $Job) {
    $bundle = Read-MaintenanceJson (Join-Path $Job.outputDirectory 'bundle.json')
    if (!$bundle -or $bundle.targetPackage -cne $Job.targetPackage -or $bundle.version -cne $Job.version -or
        $bundle.addonPackageFullName -cne $Job.addonPackageFullName) { throw 'Prepared bundle identity differs from the maintenance job.' }
    $file = Assert-MaintenanceChild $Job.outputDirectory (Join-Path $Job.outputDirectory $bundle.packageFile)
    if ((Get-MaintenanceHash $file) -cne $bundle.packageSha256 -or $bundle.proxySha256 -cne $Config.bridgeSha256) { throw 'Prepared bundle digest differs from the verified build.' }
    & (Join-Path $Config.sourceRoot 'native-integration\install.ps1') -BundleDirectory $Job.outputDirectory -VerifyOnly | Out-Null
    return $bundle
}

function Invoke-MaintenanceDeployment($Config, $Job, $Bundle) {
    # Reopening Codex in the final race must defer registration rather than
    # force-close a window. API success alone is never recorded as installed.
    Add-AppxPackage -Path (Join-Path $Job.outputDirectory $Bundle.packageFile) -AllowUnsigned -DeferRegistrationWhenPackagesAreInUse
}

function Invoke-MaintenanceReconcile($Config, [string]$Root, [switch]$Retry) {
    if (Test-Path -LiteralPath (Join-Path $Root 'stop')) { return }
    $hostPackage = Get-MaintenanceHost
    if (!$hostPackage) { return }
    $target = $hostPackage.PackageFullName
    if ($target -cnotmatch '^OpenAI\.Codex_[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+_x64__2p2nqsd0c76g0$') { throw 'Unexpected installed Codex identity.' }
    $key = Get-MaintenanceKey $Config.sourceFingerprint $target
    $path = Join-Path $Root ('jobs\' + $key + '.json')
    $job = Read-MaintenanceJson $path
    if ($job) { Assert-MaintenanceJob $Config $Root $job $key $target }
    $addon = Get-MaintenanceAddon
    if (!$job) {
        $job = [pscustomobject][ordered]@{
            schema = 1; key = $key; sourceFingerprint = $Config.sourceFingerprint; targetPackage = $target
            phase = 'new'; message = ''; updatedAt = ''; attempts = 0; interruptedRecoveries = 0
            version = ''; outputDirectory = ''; addonPackageFullName = ''; submittedAt = $null; acceptedAt = $null; registeredAt = $null; loadedAt = $null
        }
    }
    if (Test-MaintenanceRemoval $Config $addon) {
        Set-MaintenancePhase $Root $job 'paused-for-removal' 'Theme uninstall was requested. Maintenance will not reinstall it.'
        return $job
    }
    $prior = Read-MaintenanceJson (Join-Path $Root 'last-registration.json')
    if (!$addon -and $prior -and !$Retry) {
        Set-MaintenancePhase $Root $job 'addon-removed' 'The installed add-on was removed. Explicit Retry is required to reinstall it.'
        return $job
    }
    if ($Retry -and $job.phase -in @('error', 'interrupted', 'addon-removed', 'paused-for-removal', 'superseded')) {
        $job.phase = 'new'; $job.interruptedRecoveries = 0
    }
    if ($job.phase -in @('error', 'interrupted', 'addon-removed', 'paused-for-removal', 'superseded')) {
        Write-MaintenanceJson (Join-Path $Root 'state.json') $job
        return $job
    }
    if ($job.phase -in @('submitted', 'registered', 'loaded')) {
        if (Test-MaintenanceRegistration $hostPackage $addon $job.addonPackageFullName) {
            if (!$job.registeredAt) {
                $job.registeredAt = [DateTimeOffset]::UtcNow.ToString('o')
                Write-MaintenanceJson (Join-Path $Root 'last-registration.json') @{ addonPackageFullName = $job.addonPackageFullName; targetPackage = $target }
                Set-MaintenancePhase $Root $job 'registered' 'Registered. Waiting for an ordinary Codex launch.'
            }
            $loaded = Get-MaintenanceRuntimeReceipt $Config $job
            if ($loaded -and $job.phase -cne 'loaded') {
                $job.loadedAt = $loaded.at
                Set-MaintenancePhase $Root $job 'loaded' 'The target runtime reported loading after registration; visual acceptance is separate.'
            }
        } elseif ($job.phase -eq 'submitted' -and !$job.acceptedAt) {
            Set-MaintenancePhase $Root $job 'error' 'Deployment outcome is unknown after an interrupted request. Registration was checked; explicit Retry is required.'
        } elseif ($job.phase -ne 'submitted') {
            Set-MaintenancePhase $Root $job 'superseded' 'Registration no longer matches this job. Explicit Retry is required.'
        }
        return $job
    }
    try {
        if ($job.phase -eq 'building') {
            if (Test-Path -LiteralPath (Join-Path $job.outputDirectory 'bundle.json')) {
                $null = Test-MaintenanceBundle $Config $job
                Set-MaintenancePhase $Root $job 'prepared' 'Recovered a complete bundle after a worker interruption.'
            } elseif ($job.interruptedRecoveries -lt 1) {
                $job.interruptedRecoveries++; $job.phase = 'new'
            } else {
                Set-MaintenancePhase $Root $job 'interrupted' 'A second interrupted build requires explicit Retry; previous output is preserved.'
                return $job
            }
        }
        if ($job.phase -eq 'new') {
            $job.submittedAt = $job.acceptedAt = $job.registeredAt = $job.loadedAt = $null
            $reserved = Read-MaintenanceJson (Join-Path $Root 'version.json')
            $installedVersion = ''; if ($addon) { $installedVersion = $addon.Version.ToString() }
            $reservedVersion = ''; if ($reserved) { $reservedVersion = $reserved.version }
            $job.version = Get-MaintenanceNextVersion $Config.versionFloor $installedVersion $reservedVersion
            Write-MaintenanceJson (Join-Path $Root 'version.json') @{ version = $job.version }
            $job.outputDirectory = Join-Path $Root ('builds\' + $key + '-' + [Guid]::NewGuid().ToString('N'))
            $job.addonPackageFullName = 'Local.Sandrone.CodexNativeTheme_' + $job.version + '_x64__vt89pjxv8jer8'
            $job.attempts++
            Set-MaintenancePhase $Root $job 'building' 'Preparing an exact-target bundle from verified installed files.'
            Invoke-MaintenanceBuild $Config $job
            $null = Test-MaintenanceBundle $Config $job
            Set-MaintenancePhase $Root $job 'prepared' 'Bundle verified; no Windows registration has changed.'
        }
        $current = Get-MaintenanceHost
        if (!$current -or $current.PackageFullName -cne $target) {
            Set-MaintenancePhase $Root $job 'superseded' 'Codex changed during preparation; this bundle will not be installed.'
            return $job
        }
        if (Test-Path -LiteralPath (Join-Path $Root 'stop')) { return $job }
        if (@(Get-MaintenanceRunningHosts).Count) {
            if ($job.phase -ne 'waiting-for-exit') { Set-MaintenancePhase $Root $job 'waiting-for-exit' 'Exit Codex normally to install. No process will be force-closed.' }
            return $job
        }
        $bundle = Test-MaintenanceBundle $Config $job
        # There is no unattended retry after the deployment request: a worker
        # restart must query registration before considering another operation.
        $job.submittedAt = [DateTimeOffset]::UtcNow.ToString('o')
        Set-MaintenancePhase $Root $job 'submitted' 'Submitting registration to Windows; completion is not yet confirmed.'
        Invoke-MaintenanceDeployment $Config $job $bundle
        $job.acceptedAt = [DateTimeOffset]::UtcNow.ToString('o')
        Set-MaintenancePhase $Root $job 'submitted' 'Windows accepted the request; registration completion is not yet confirmed.'
        $afterHost = Get-MaintenanceHost; $afterAddon = Get-MaintenanceAddon
        if (Test-MaintenanceRegistration $afterHost $afterAddon $job.addonPackageFullName) {
            $job.registeredAt = [DateTimeOffset]::UtcNow.ToString('o')
            Write-MaintenanceJson (Join-Path $Root 'last-registration.json') @{ addonPackageFullName = $job.addonPackageFullName; targetPackage = $target }
            Set-MaintenancePhase $Root $job 'registered' 'Registered. Waiting for an ordinary Codex launch.'
        }
    } catch {
        $message = $_.Exception.Message
        # A concurrent launch may make registration defer. Never label it an
        # error if the intended identity is already registered.
        $afterHost = Get-MaintenanceHost; $afterAddon = Get-MaintenanceAddon
        if ($job.addonPackageFullName -and (Test-MaintenanceRegistration $afterHost $afterAddon $job.addonPackageFullName)) {
            $job.registeredAt = [DateTimeOffset]::UtcNow.ToString('o')
            Write-MaintenanceJson (Join-Path $Root 'last-registration.json') @{ addonPackageFullName = $job.addonPackageFullName; targetPackage = $target }
            Set-MaintenancePhase $Root $job 'registered' 'Registration was confirmed after an interrupted deployment response.'
        } else { Set-MaintenancePhase $Root $job 'error' $message }
    }
    return $job
}
