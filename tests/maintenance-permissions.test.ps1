$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'native-integration\maintenance.ps1') -Library
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('sandrone-maintenance-acl-tests-' + [Guid]::NewGuid().ToString('N'))
$originalProgramData = $env:ProgramData
$script:checks = 0
$script:acls = @{}
function Check([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message }; $script:checks++ }
# Use real nested paths with in-memory Windows ACLs. Tests neither require
# elevation nor change permissions on disk or the machine's maintenance tree.
function Set-Acl([string]$LiteralPath, $AclObject) { $script:acls[$LiteralPath] = $AclObject }
function Get-Acl([string]$LiteralPath) { return $script:acls[$LiteralPath] }
function Get-MaintenanceRoot { return $script:root }
try {
    $script:root = Join-Path $temporary 'maintenance'
    $null = New-Item -ItemType Directory -Path (Join-Path $script:root 'snapshots\old\source') -Force
    $null = New-Item -ItemType Directory -Path (Join-Path $script:root 'jobs')
    $null = New-Item -ItemType Directory -Path (Join-Path $script:root 'builds\old') -Force
    [IO.File]::WriteAllText((Join-Path $script:root 'snapshots\old\source\worker.ps1'), 'fixture')
    [IO.File]::WriteAllText((Join-Path $script:root 'jobs\old.json'), '{}')
    [IO.File]::WriteAllText((Join-Path $script:root 'builds\old\bundle.json'), '{}')
    $env:ProgramData = $temporary
    $users = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
    foreach ($item in @(Get-MaintenanceTree $script:root)) {
        $acl = New-MaintenanceAcl $item.PSIsContainer
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users, 'Modify', 'Allow')))
        $script:acls[$item.FullName] = $acl
    }
    Protect-MaintenanceTree $script:root
    foreach ($item in @(Get-MaintenanceTree $script:root)) {
        $acl = $script:acls[$item.FullName]
        $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        Check ($acl.AreAccessRulesProtected -and $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-32-544') 'Every descendant must have protected DACL and Administrators ownership'
        Check ($rules.Count -eq 3) 'Reset must discard inherited and explicit legacy ACL entries'
        foreach ($rule in $rules) {
            $expected = [Security.AccessControl.FileSystemRights]::FullControl
            if ($rule.IdentityReference.Value -eq 'S-1-5-32-545') { $expected = [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize }
            Check ($rule.AccessControlType -eq 'Allow' -and $rule.FileSystemRights -eq $expected) 'Only Administrators/System full control and Users read/execute may remain'
        }
    }
    Assert-MaintenanceProtected $script:root
    Check $true 'The complete protected tree must pass startup verification'
    $nested = Join-Path $script:root 'snapshots\old\source\worker.ps1'
    $script:acls[$nested].AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users, 'Write', 'Allow')))
    $rejected = $false
    try { Assert-MaintenanceProtected $script:root } catch { $rejected = $true }
    Check $rejected 'Startup verification must reject a writable nested snapshot file'
    Protect-MaintenanceTree $script:root
    $nested = Join-Path $script:root 'builds\old'
    $script:acls[$nested].AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users, 'DeleteSubdirectoriesAndFiles', 'Allow')))
    $rejected = $false
    try { Assert-MaintenanceProtected $script:root } catch { $rejected = $true }
    Check $rejected 'Startup verification must reject descendant deletion rights on a nested directory'
    Write-Output ("Maintenance ACL policy: $script:checks checks passed; disk ACLs and system tasks unchanged.")
} finally {
    $env:ProgramData = $originalProgramData
    $resolved = [IO.Path]::GetFullPath($temporary)
    if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('sandrone-maintenance-acl-tests-')) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
