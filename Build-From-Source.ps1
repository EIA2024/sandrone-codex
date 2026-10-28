$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$node=Join-Path $root 'runtime\node.exe'
if(!(Test-Path -LiteralPath $node)){
 $installed=Get-Command node.exe -ErrorAction SilentlyContinue
 if(!$installed){throw '请安装官方 Node.js 24 LTS x64，或把官方 Windows x64 ZIP 内的 node.exe 与 LICENSE 放入 runtime/，再重试。'}
 $sig=Get-AuthenticodeSignature -LiteralPath $installed.Source
 if($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'OpenJS Foundation'){throw 'PATH 中 Node 的签名不符合要求。'}
 $directory=Split-Path $installed.Source -Parent
 $license=@('LICENSE','LICENSE.txt','LICENSE-node.txt')|ForEach-Object {Join-Path $directory $_}|Where-Object {Test-Path -LiteralPath $_}|Select-Object -First 1
 if(!$license){throw '未找到与 Node 配套的许可证。请从官方 Windows ZIP 同时取 node.exe 和 LICENSE 放入 runtime/。'}
 $null=New-Item -ItemType Directory -Path (Join-Path $root 'runtime') -Force
 Copy-Item -LiteralPath $installed.Source -Destination $node
 Copy-Item -LiteralPath $license -Destination (Join-Path $root 'runtime\LICENSE-node.txt') -Force
}
$sig=Get-AuthenticodeSignature -LiteralPath $node
if($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'OpenJS Foundation'){throw 'Node 签名校验失败。'}
$info=& $node -p 'JSON.stringify({major:parseInt(process.versions.node),arch:process.arch})'|ConvertFrom-Json
if($info.major -lt 24 -or $info.arch -ne 'x64'){throw '需要 Node.js 24 或更高版本的 Windows x64 运行时。'}
if(!(Test-Path -LiteralPath (Join-Path $root 'runtime\LICENSE-node.txt'))){
 $license=Join-Path $root 'runtime\LICENSE'
 if(!(Test-Path -LiteralPath $license)){throw '请同时保留 Node 官方 LICENSE。'}
 Copy-Item -LiteralPath $license -Destination (Join-Path $root 'runtime\LICENSE-node.txt')
}
& (Join-Path $root 'build.ps1')
if($LASTEXITCODE -ne 0){throw '编译失败。'}
& $node (Join-Path $root 'tools\render-startup.mjs') --ensure
if($LASTEXITCODE -ne 0){throw '开屏视频生成或版本校验失败，已停止构建。'}
& $node (Join-Path $root 'build-preview.mjs')
if($LASTEXITCODE -ne 0){throw '预览构建失败。'}
& $node (Join-Path $root 'tools\package.mjs')
if($LASTEXITCODE -ne 0){throw '打包校验失败。'}
Write-Output '构建完成；现在可运行 Setup.ps1 创建快捷方式。未启动 Codex。'
