[CmdletBinding(SupportsShouldProcess=$true)]
param([switch]$ValidateOnly,[switch]$NoShortcuts)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
if($root.StartsWith('\\')){throw '请解压到本机可写目录后运行。'}
if($WhatIfPreference){Write-Output 'Dry run: no shortcuts, configuration or clients changed.';return}
if(!(Test-Path -LiteralPath (Join-Path $root 'SandroneCodex.exe'))){throw '源码版请先运行 Build-From-Source.ps1；试用版请完整解压 ZIP。'}
for($p=$root;$p;$p=Split-Path $p -Parent){if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw '项目路径含链接/目录重定向，请改用普通本机文件夹。'}}
$node=Join-Path $root 'runtime\node.exe'
$manifestPath=Join-Path $root 'integrity.json'
if(!(Test-Path -LiteralPath $manifestPath)){throw '缺少完整性清单。源码版请先完成构建。'}
$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
$expected=$manifest.PSObject.Properties['runtime/node.exe'].Value
if(!$expected -or !(Test-Path -LiteralPath $node) -or (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -ine $expected){throw 'Node 运行文件不完整；未执行。'}
$sig=Get-AuthenticodeSignature -LiteralPath $node
if($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'OpenJS Foundation'){throw 'Node 签名未通过；请使用官方 Node.js Windows x64 运行时。'}
& $node (Join-Path $root 'verify-integrity.mjs')
if($LASTEXITCODE -ne 0){throw '包完整性校验失败。'}
$official=$null
foreach($package in @(Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue)){
 $candidate=Join-Path $package.InstallLocation 'app\ChatGPT.exe'
 if(!(Test-Path -LiteralPath $candidate)){continue}
 $signature=Get-AuthenticodeSignature -LiteralPath $candidate
 if($signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match 'OpenAI'){$official=$candidate;break}
}
if(!$official){throw '请先安装官方 Windows Codex，并从官方入口正常打开一次。此包不包含 Codex 或账号。'}
if($ValidateOnly){Write-Output '{"pass":true,"portableRoot":true,"runtimeSignature":true,"officialDetected":true,"clientStarted":false,"filesWritten":false}';return}
$config=@{officialExe=$official}|ConvertTo-Json
if($PSCmdlet.ShouldProcess($root,'保存本机安装信息并创建本项目快捷方式')){
 [IO.File]::WriteAllText((Join-Path $root 'machine.json'),$config,(New-Object Text.UTF8Encoding($false)))
 if(!$NoShortcuts){
  $shell=New-Object -ComObject WScript.Shell;$desktop=[Environment]::GetFolderPath('Desktop')
  foreach($entry in @(@('桑多涅 Codex（分享版）.lnk','SandroneCodex.exe'),@('恢复官方 Codex（分享版）.lnk','一键恢复官方原版.cmd'),@('桑多涅开屏预览（分享版）.lnk','dist\Sandrone-preview.html'))){
   $shortcut=$shell.CreateShortcut((Join-Path $desktop $entry[0]));$shortcut.TargetPath=Join-Path $root $entry[1];$shortcut.WorkingDirectory=$root;$shortcut.IconLocation=Join-Path $root 'assets\workshop.ico';$shortcut.Description='SandroneCodex portable';$shortcut.Save()
  }
 }
 Write-Output '配置完成。请先手动退出正在运行的官方 Codex，再从分享版快捷方式启动。没有启动或关闭任何客户端。'
}
