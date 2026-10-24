[CmdletBinding(SupportsShouldProcess=$true)]param()
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$desktop=[Environment]::GetFolderPath('Desktop');$shell=New-Object -ComObject WScript.Shell
$targets=@((Join-Path $root 'SandroneCodex.exe'),(Join-Path $root '一键恢复官方原版.cmd'),(Join-Path $root 'dist\Sandrone-preview.html'))
foreach($name in @('桑多涅 Codex（分享版）.lnk','恢复官方 Codex（分享版）.lnk','桑多涅开屏预览（分享版）.lnk')){
 $path=Join-Path $desktop $name
 if(!(Test-Path -LiteralPath $path)){continue}
 if((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint){throw '快捷方式路径被重定向，停止操作。'}
 $shortcut=$shell.CreateShortcut($path)
 if($shortcut.TargetPath -in $targets){if($PSCmdlet.ShouldProcess($path,'移除本项目快捷方式')){Remove-Item -LiteralPath $path -Force}}
}
Write-Output '只处理指向本文件夹的分享版快捷方式；未删除程序、登录数据或官方快捷方式。'
