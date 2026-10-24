$ErrorActionPreference='Stop'
$sourceRoot=Split-Path $PSScriptRoot -Parent
$node=Join-Path $sourceRoot 'runtime\node.exe'
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $sourceRoot 'engine\control.ps1'),[ref]$null,[ref]$null)
foreach($name in @('NativeUi','Inject')){
 $definition=$ast.Find({param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name},$true)
 . ([scriptblock]::Create($definition.Extent.Text))
}
$projectRoot=Join-Path ([IO.Path]::GetTempPath()) ('Sandrone-launch-test-'+[Guid]::NewGuid().ToString('N'))
try{
 $null=New-Item -ItemType Directory -Path (Join-Path $projectRoot 'engine') -Force
 $null=New-Item -ItemType Directory -Path (Join-Path $projectRoot 'vendor\dream-skin\windows\scripts') -Force
 $fake="process.stderr.write('renderer is starting\n');process.exitCode=9;"
 [IO.File]::WriteAllText((Join-Path $projectRoot 'engine\session.mjs'),$fake)
 [IO.File]::WriteAllText((Join-Path $projectRoot 'vendor\dream-skin\windows\scripts\injector.mjs'),$fake)
 $state=[pscustomobject]@{browserId='test-not-a-live-session'}
 for($attempt=0;$attempt -lt 2;$attempt++){
  if((NativeUi $node '--opening' $state) -ne $false){throw 'Expected retriable native failure'}
  if((Inject $node '--once' $state) -ne $false){throw 'Expected retriable upstream failure'}
 }
 if($ErrorActionPreference -ne 'Stop'){throw 'Helper changed caller error policy'}
 Write-Output 'PASS: native stderr returns false; startup retry continues; caller Stop preserved'
}finally{
 # Only this test-created folder; use one shell and checked absolute temp path.
 $checked=[IO.Path]::GetFullPath($projectRoot)
 $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
 if($checked.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $checked -Leaf) -like 'Sandrone-launch-test-*'){
  Remove-Item -LiteralPath $checked -Recurse -Force
 }
}
