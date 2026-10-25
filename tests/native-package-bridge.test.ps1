param([string]$GccPath)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
. (Join-Path $repo 'native-integration\package-common.ps1')
$gcc = Resolve-SandroneCompiler $GccPath
$node = (Get-Command node.exe -ErrorAction Stop).Source
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('sandrone-bridge-test-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $temporary
function Compile([string]$Source, [string]$Destination, [string[]]$Options = @()) {
    & $gcc '-shared' '-O2' '-Wall' '-Wextra' '-Werror' '-Wno-cast-function-type' '-static-libgcc' @Options $Source '-o' $Destination
    if ($LASTEXITCODE -ne 0) { throw 'Native test fixture did not compile.' }
}
try {
    $bridge = Join-Path $temporary 'bridge.node'
    $original = Join-Path $temporary 'windows-updater.original.node'
    Compile (Join-Path $repo 'native-integration\bridge.c') $bridge
    Compile (Join-Path $PSScriptRoot 'native-package-fixture.c') $original
    $test = @'
const assert = require('node:assert/strict');
const path = require('node:path');
const mode = process.argv[2];
if (mode === 'optional-theme-failure') {
  process.type = 'browser';
  process.resourcesPath = path.join(__dirname, 'missing-theme');
}
if (mode === 'original-failure') {
  assert.throws(() => require('./bridge.node'), {code: 'ORIGINAL_FAILURE'});
} else if (mode === 'missing-original') {
  assert.throws(() => require('./bridge.node'), {code: 'SANDRONE_ORIGINAL_MODULE_MISSING'});
} else {
  assert.equal(require('./bridge.node').original, true);
}
console.log('bridge fixture passed:', mode);
'@
    $testPath = Join-Path $temporary 'test.cjs'
    [IO.File]::WriteAllText($testPath, $test, (New-Object Text.UTF8Encoding($false)))
    foreach ($mode in @('original-exports', 'optional-theme-failure')) {
        & $node $testPath $mode; if ($LASTEXITCODE -ne 0) { throw ('Bridge fixture failed: ' + $mode) }
    }
    Compile (Join-Path $PSScriptRoot 'native-package-fixture.c') $original @('-DFAIL_ORIGINAL')
    & $node $testPath 'original-failure'; if ($LASTEXITCODE -ne 0) { throw 'Original exception was not preserved.' }
    Remove-Item -LiteralPath $original
    & $node $testPath 'missing-original'; if ($LASTEXITCODE -ne 0) { throw 'Missing original module did not fail explicitly.' }
} finally {
    $resolved = [IO.Path]::GetFullPath($temporary)
    if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('sandrone-bridge-test-')) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
