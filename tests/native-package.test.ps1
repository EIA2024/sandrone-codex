$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
. (Join-Path $repo 'native-integration\package-common.ps1')
. (Join-Path $repo 'native-integration\uninstall.ps1') -Library
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('sandrone-package-test-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $temporary
$passed = 0
function Check([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message }; $script:passed++ }
function Reject([scriptblock]$Operation, [string]$Message) { $failed = $false; try { & $Operation | Out-Null } catch { $failed = $true }; Check $failed $Message }
$identity = 'Local.Sandrone.CodexNativeTheme_0.2.0.0_x64__vt89pjxv8jer8'
$script:installed = $true; $script:running = @(); $script:removed = @(); $script:launches = 0; $script:defer = $false
# No fixture invokes AppX deployment, starts a worker, or inspects a real Codex.
function Get-SandroneAddon([string]$Identity) { if ($script:installed) { [pscustomobject]@{ PackageFullName = $Identity } } }
function Get-SandroneRunningHosts { $script:running }
function Invoke-SandroneDeferredRemoval([string]$Identity) { $script:removed += $Identity; if (!$script:defer) { $script:installed = $false } }
function Start-Process { param($FilePath, $ArgumentList, $WindowStyle, [switch]$PassThru); $script:launches++; Check ($WindowStyle -eq 'Hidden') 'Worker must be hidden'; Check ($ArgumentList -contains '-EncodedCommand') 'Paths must be encoded without command-line interpolation'; return Get-Process -Id $PID }
try {
    $compatibility = Get-Content -LiteralPath (Join-Path $repo 'native-integration\compatibility.json') -Raw | ConvertFrom-Json
    $target = $compatibility.targets[0]
    $official = [pscustomobject]@{Name=$target.name;Version=$target.version;Publisher=$target.publisher;ProcessorArchitecture=$target.architecture}
    Check ((Get-SandroneTarget $compatibility $official).packageFullName -eq $target.packageFullName) 'Supported exact official identity must match'
    $official.Version = '99.0.0.0'; Reject { Get-SandroneTarget $compatibility $official } 'Unknown official version must not auto-enable the native module'
    foreach ($relative in @('../profile', 'C:\private', 'asset/../../outside', 'a:b')) { Reject { Assert-SandroneRelativePath $relative } 'Package path escape must fail' }
    foreach ($property in $target.files.PSObject.Properties) { Check ($property.Value -cmatch '^[a-f0-9]{64}$') 'Compatibility hashes must be SHA256' }
    Reject { Assert-SandroneAddonIdentity 'OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0' } 'Cannot uninstall official Codex'
    Reject { Assert-SandroneAddonIdentity 'Local.Sandrone.CodexNativeTheme_*' } 'Cannot uninstall by wildcard'
    $script:running = @(100,200)
    Reject { Remove-SandroneAddon $identity } 'Running official windows must block direct removal'
    Check ($script:removed.Count -eq 0) 'Blocked removal must not invoke Windows'
    $status = Invoke-SandroneUninstall 'Schedule' $temporary $identity ''
    Check ($status.status -eq 'scheduled' -and $script:launches -eq 1) 'Schedule creates one worker'
    $same = Invoke-SandroneUninstall 'Schedule' $temporary $identity ''
    Check ($same.requestId -eq $status.requestId -and $script:launches -eq 1) 'Repeated scheduling is idempotent'
    $cancelled = Invoke-SandroneUninstall 'Cancel' $temporary $identity ''
    Check ($cancelled.status -eq 'cancelled') 'Pending removal must be cancellable'
    $run = Invoke-SandroneUninstall 'Run' $temporary $identity $status.requestId
    Check ($run.status -eq 'cancelled' -and $script:removed.Count -eq 0) 'Cancelled worker must never remove the package'
    $new = Invoke-SandroneUninstall 'Schedule' $temporary $identity ''
    Check ($new.requestId -ne $status.requestId) 'Rescheduling needs a new token'
    $script:running = @()
    $stale = Invoke-SandroneUninstall 'Run' $temporary $identity $status.requestId
    Check ($stale.status -eq 'scheduled' -and $script:removed.Count -eq 0) 'Stale worker token must not remove a later request'
    $script:defer = $true
    $pending = Invoke-SandroneUninstall 'Run' $temporary $identity $new.requestId
    Check ($pending.status -eq 'removing') 'Accepted deferred removal is not completed registration removal'
    $pendingAgain = Invoke-SandroneUninstall 'Schedule' $temporary $identity ''
    Check ($pendingAgain.requestId -eq $new.requestId -and $script:launches -eq 2) 'Scheduling during Windows removal must preserve the submitted request'
    $notCancelled = Invoke-SandroneUninstall 'Cancel' $temporary $identity ''
    Check ($notCancelled.status -eq 'removing') 'Removal submitted to Windows cannot report successful cancellation'
    $script:installed = $false
    $finished = Invoke-SandroneUninstall 'Status' $temporary $identity ''
    Check ($finished.status -eq 'completed') 'Completion requires registration recheck'
    Check ($script:removed.Count -eq 1 -and $script:removed[0] -ceq $identity) 'Only exact intended add-on may reach the deployment API'
    Check ((Remove-SandroneAddon $identity).status -eq 'completed') 'Already removed add-on is idempotent'
    $script:installed = $true
    Check ((Invoke-SandroneUninstall 'Status' $temporary $identity '').status -eq 'idle') 'Reinstall must not retain a completed-removal lockout'
    $restarted = Invoke-SandroneUninstall 'Schedule' $temporary $identity ''
    $request = Read-SandroneRemoval $temporary
    $request.workerPid = $null; $request.workerStarted = $null
    Write-SandroneRemoval $temporary $request
    Check ((Invoke-SandroneUninstall 'Status' $temporary $identity '').status -eq 'error') 'An interrupted worker launch must not remain scheduled forever'
    $restarted = Invoke-SandroneUninstall 'Schedule' $temporary $identity ''
    $request = Read-SandroneRemoval $temporary
    $request.workerStarted = '0'
    Write-SandroneRemoval $temporary $request
    $recovered = Invoke-SandroneUninstall 'Schedule' $temporary $identity ''
    Check ($recovered.requestId -ne $restarted.requestId -and $recovered.status -eq 'scheduled') 'Scheduling must recover a dead worker without a prior status call'
    Write-Output ("Native package lifecycle fixtures: $passed checks passed; no Windows packages changed.")
} finally {
    $resolved = [IO.Path]::GetFullPath($temporary)
    if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('sandrone-package-test-')) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
