$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'native-integration\maintenance-common.ps1')
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('sandrone-maintenance-tests-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $temporary
$script:checks = 0
function Check([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message }; $script:checks++ }
function New-Fixture {
    $script:root = Join-Path $temporary ([Guid]::NewGuid().ToString('N'))
    foreach ($name in @('jobs', 'builds', 'settings')) { $null = New-Item -ItemType Directory -Path (Join-Path $script:root $name) -Force }
    $script:config = [pscustomobject]@{ sourceFingerprint = ('a' * 64); versionFloor = '0.4.0.0'; settingsRoot = Join-Path $script:root 'settings' }
    $script:hostPackage = [pscustomobject]@{ PackageFullName = 'OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0'; Dependencies = @() }
    $script:addon = [pscustomobject]@{ PackageFullName = 'Local.Sandrone.CodexNativeTheme_0.3.6.0_x64__vt89pjxv8jer8'; Version = [version]'0.3.6.0' }
    $script:builds = 0; $script:deploys = 0; $script:running = @(123); $script:failBuild = $false; $script:failDeployment = $false
    $script:defer = $false; $script:changeHostDuringBuild = $false
}
function Get-MaintenanceHost { return $script:hostPackage }
function Get-MaintenanceAddon { return $script:addon }
function Get-MaintenanceRunningHosts { return $script:running }
function Invoke-MaintenanceBuild($Config, $Job) {
    $script:builds++
    $null = New-Item -ItemType Directory -Path $Job.outputDirectory
    if ($script:failBuild) { throw 'Download or build failed.' }
    Write-MaintenanceJson (Join-Path $Job.outputDirectory 'bundle.json') @{ targetPackage = $Job.targetPackage; version = $Job.version; addonPackageFullName = $Job.addonPackageFullName }
    if ($script:changeHostDuringBuild) { $script:hostPackage.PackageFullName = 'OpenAI.Codex_26.1023.6123.0_x64__2p2nqsd0c76g0'; $script:changeHostDuringBuild = $false }
}
function Test-MaintenanceBundle($Config, $Job) {
    $bundle = Read-MaintenanceJson (Join-Path $Job.outputDirectory 'bundle.json')
    if (!$bundle -or $bundle.targetPackage -cne $Job.targetPackage) { throw 'Fixture bundle mismatch.' }
    return $bundle
}
function Invoke-MaintenanceDeployment($Config, $Job, $Bundle) {
    $script:deploys++
    if ($script:failDeployment) { throw 'Windows deployment rejected the package.' }
    if (!$script:defer) {
        $script:addon = [pscustomobject]@{ PackageFullName = $Job.addonPackageFullName; Version = [version]$Job.version }
        $script:hostPackage.Dependencies = @($script:addon)
    }
}
function Run-Step { return Invoke-MaintenanceReconcile $script:config $script:root @args }
try {
    $unicode = -join @([char]0x7a0b, [char]0x5e8f, [char]0x201c, [char]0x9519, [char]0x8bef, [char]0x201d)
    $stateFile = Join-Path $temporary 'unicode.json'
    Write-MaintenanceJson $stateFile @{ message = $unicode }
    Check ((Read-MaintenanceJson $stateFile).message -ceq $unicode) 'UTF8 error text must round-trip in Windows PowerShell 5.1 regardless of system codepage'
    Check ((Get-MaintenanceNextVersion '0.4.0.0' '0.3.6.0' '') -ceq '0.4.0.0') 'First adaptation must use the new payload version floor'
    Check ((Get-MaintenanceNextVersion '0.4.0.0' '0.4.0.65535' '') -ceq '0.4.1.0') 'MSIX version carry must remain valid'
    Check ((Get-MaintenanceNextVersion '0.4.0.0' '0.4.0.4' '0.4.0.8') -ceq '0.4.0.9') 'Failed or interrupted reservations cannot be reused'

    New-Fixture
    $first = Run-Step
    Check ($first.phase -ceq 'waiting-for-exit' -and $script:builds -eq 1 -and $script:deploys -eq 0) 'Preparation must not register over a running Codex'
    $originalOutput = $first.outputDirectory
    1..3 | ForEach-Object { $null = Run-Step }
    Check ($script:builds -eq 1 -and $script:deploys -eq 0) 'Duplicate events must not rebuild or deploy'
    $script:running = @(); $installed = Run-Step
    Check ($installed.phase -ceq 'registered' -and $script:deploys -eq 1) 'Normal exit must allow one deployment and registration check'
    $null = Run-Step
    Check ($script:deploys -eq 1 -and $script:builds -eq 1) 'A registered package must not be installed repeatedly'
    $eventPath = Join-Path $script:config.settingsRoot 'events.jsonl'
    @{event='runtime-loaded';addonPackageFullName=$installed.addonPackageFullName;targetPackage=$installed.targetPackage;at='2000-01-01T00:00:00Z'} | ConvertTo-Json -Compress | Set-Content $eventPath
    Check ((Run-Step).phase -ceq 'registered') 'An old runtime event cannot confirm the new installation'
    @{event='runtime-loaded';addonPackageFullName=$installed.addonPackageFullName;targetPackage=$installed.targetPackage;at=[DateTimeOffset]::UtcNow.AddSeconds(1).ToString('o')} | ConvertTo-Json -Compress | Add-Content $eventPath
    Check ((Run-Step).phase -ceq 'loaded') 'Loading requires matching target, add-on and fresh timestamp'
    $script:hostPackage.PackageFullName = 'OpenAI.Codex_26.1023.6123.0_x64__2p2nqsd0c76g0'; $script:running = @(333)
    $next = Run-Step
    Check ($next.version -ceq '0.4.0.1' -and $script:builds -eq 2 -and $next.targetPackage -match '26.1023.6123.0') 'A host update must receive a new exact target and monotonic add-on version'
    Check (Test-Path -LiteralPath $originalOutput) 'Prior build evidence must survive preparation of a new target'

    New-Fixture; $script:failBuild = $true
    Check ((Run-Step).phase -ceq 'error') 'Build failure must be recorded'
    $null = Run-Step; $null = Run-Step
    Check ($script:builds -eq 1 -and $script:deploys -eq 0) 'Failed targets must not spin through repeated build attempts'
    $script:failBuild = $false; $retried = Run-Step -Retry
    Check ($retried.phase -ceq 'waiting-for-exit' -and $retried.attempts -eq 2 -and $retried.version -ceq '0.4.0.1') 'Explicit retry must use a new version and preserve the failed output'
    $script:config.sourceFingerprint = ('b' * 64)
    Check ((Run-Step).attempts -eq 1 -and $script:builds -eq 3) 'A deliberate source refresh must have its own job'

    New-Fixture; $script:running = @(); $script:failDeployment = $true
    Check ((Run-Step).phase -ceq 'error') 'Deployment rejection must not be called registered'
    $null = Run-Step
    Check ($script:deploys -eq 1) 'Deployment failure must not auto-repeat'

    New-Fixture; $script:running = @(); $script:defer = $true
    $deferred = Run-Step
    Check ($deferred.phase -ceq 'submitted' -and $deferred.acceptedAt -and !$deferred.registeredAt) 'Windows acceptance must be distinct from registration'
    $null = Run-Step
    Check ($script:deploys -eq 1) 'A pending Windows request must be queried rather than resubmitted'
    $script:addon = [pscustomobject]@{PackageFullName=$deferred.addonPackageFullName;Version=[version]$deferred.version}; $script:hostPackage.Dependencies=@($script:addon)
    Check ((Run-Step).phase -ceq 'registered') 'Deferred registration must be recognized after Windows completes it'

    New-Fixture
    $broken = Run-Step
    $broken.phase='building'; $broken.outputDirectory=Join-Path $script:root 'builds\interrupted-a'
    Write-MaintenanceJson (Join-Path $script:root ('jobs\'+$broken.key+'.json')) $broken
    $recovered = Run-Step
    Check ($script:builds -eq 2 -and $recovered.interruptedRecoveries -eq 1) 'An interrupted build can recover once into a fresh directory'
    $recovered.phase='building'; $recovered.outputDirectory=Join-Path $script:root 'builds\interrupted-b'
    Write-MaintenanceJson (Join-Path $script:root ('jobs\'+$recovered.key+'.json')) $recovered
    Check ((Run-Step).phase -ceq 'interrupted' -and $script:builds -eq 2) 'A second interrupted build must not cause an unattended retry loop'

    New-Fixture
    $unknown=Run-Step; $unknown.phase='submitted'; $unknown.acceptedAt=$null
    Write-MaintenanceJson (Join-Path $script:root ('jobs\'+$unknown.key+'.json')) $unknown
    Check ((Run-Step).phase -ceq 'error' -and $script:deploys -eq 0) 'Unknown deployment outcome requires registration query and explicit retry'

    New-Fixture; $script:changeHostDuringBuild=$true; $script:running=@()
    Check ((Run-Step).phase -ceq 'superseded' -and $script:deploys -eq 0) 'Host changing during preparation must block wrong-target installation'
    Check ((Run-Step).phase -ceq 'registered' -and $script:builds -eq 2) 'The new host can be reconciled independently'

    New-Fixture
    [IO.File]::WriteAllText((Join-Path $script:root 'stop'),'stop')
    $null=Run-Step
    Check ($script:builds -eq 0 -and $script:deploys -eq 0) 'A user stop request must prevent automatic work'

    New-Fixture
    Write-MaintenanceJson (Join-Path $script:config.settingsRoot 'uninstall-request.json') @{schema=1;status='scheduled';packageFullName=$script:addon.PackageFullName}
    Check ((Run-Step).phase -ceq 'paused-for-removal' -and $script:builds -eq 0) 'Theme uninstall must not be undone by maintenance'

    New-Fixture; $script:running=@(); $null=Run-Step; $script:addon=$null
    Check ((Run-Step).phase -ceq 'addon-removed' -and $script:builds -eq 1) 'External add-on removal must not trigger reinstallation'

    foreach ($field in @('key', 'targetPackage', 'sourceFingerprint', 'outputDirectory')) {
        New-Fixture
        $tampered = Run-Step
        $savedPath = Join-Path $script:root ('jobs\' + $tampered.key + '.json')
        if ($field -eq 'outputDirectory') { $tampered.$field = Join-Path $temporary 'outside-protected-builds' }
        else { $tampered.$field = 'untrusted-value' }
        Write-MaintenanceJson $savedPath $tampered
        $script:running = @()
        $rejected = $false
        try { $null = Run-Step } catch { $rejected = $true }
        Check ($rejected -and $script:builds -eq 1 -and $script:deploys -eq 0) ('Tampered job ' + $field + ' must be rejected before bundle access or deployment')
    }
    New-Fixture
    $tampered = Run-Step
    $savedPath = Join-Path $script:root ('jobs\' + $tampered.key + '.json')
    $tampered.outputDirectory = Join-Path $script:root 'builds\..\outside'
    Write-MaintenanceJson $savedPath $tampered
    $rejected = $false
    try { $null = Run-Step } catch { $rejected = $true }
    Check ($rejected -and $script:deploys -eq 0) 'Output path traversal must be rejected after canonicalization'

    Write-Output ("Maintenance lifecycle: $script:checks checks passed; no packages, tasks or processes changed.")
} finally {
    $resolved=[IO.Path]::GetFullPath($temporary)
    if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('sandrone-maintenance-tests-')) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
