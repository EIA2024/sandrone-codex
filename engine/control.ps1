param([ValidateSet('launch','restore','official')][string]$Action='launch',[ValidatePattern('^[a-f0-9]{32}$')][string]$Token,[switch]$ActivateWindow)
$ErrorActionPreference='Stop'
$launchClock=[Diagnostics.Stopwatch]::StartNew()
$projectRoot=Split-Path $PSScriptRoot -Parent
$stateRoot=Join-Path $projectRoot 'state'
$null=New-Item -ItemType Directory -Path $stateRoot -Force
$resultPath=Join-Path $stateRoot ('result-'+$Token+'.json')
$utf8=New-Object System.Text.UTF8Encoding($false)
function Result($status,$message,$detail){
 $temp=$resultPath+'.tmp'
 [IO.File]::WriteAllText($temp,(@{status=$status;message=$message;detail=$detail;elapsedMs=$launchClock.ElapsedMilliseconds}|ConvertTo-Json -Compress),$utf8)
 Move-Item -LiteralPath $temp -Destination $resultPath -Force
}
function OfficialExe {
 $candidates=@(Get-Process ChatGPT -ErrorAction SilentlyContinue | ForEach-Object {try{$_.Path}catch{}} | Select-Object -Unique)
 if(Test-Path (Join-Path $projectRoot 'machine.json')){ $candidates+=((Get-Content (Join-Path $projectRoot 'machine.json') -Raw|ConvertFrom-Json).officialExe) }
 foreach($p in $candidates){
  if($p -and $p -match '^[A-Za-z]:\\(?:Program Files\\)?WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' -and (Test-Path -LiteralPath $p)){
   $sig=Get-AuthenticodeSignature -LiteralPath $p
   if($sig.Status -eq 'Valid' -and $sig.SignerCertificate.Subject -match 'OpenAI'){return $p}
  }
 }
 foreach($package in @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue)){
  $p=Join-Path $package.InstallLocation 'app\ChatGPT.exe'
  if($p -match '^[A-Za-z]:\\(?:Program Files\\)?WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' -and (Test-Path -LiteralPath $p)){$sig=Get-AuthenticodeSignature -LiteralPath $p;if($sig.Status -eq 'Valid' -and $sig.SignerCertificate.Subject -match 'OpenAI'){return $p}}
 }
 throw '未找到签名有效的官方 Store 客户端；请更新 machine.json 中的 officialExe，或先打开官方程序。'
}
function NodeExe {
 $p=Join-Path $projectRoot 'runtime\node.exe'
 if(!(Test-Path -LiteralPath $p)){throw '缺少本机 Node 运行时，请重新部署。'}
 return $p
}
function GetManaged {
 $file=Join-Path $stateRoot 'managed.json'
 if(!(Test-Path $file)){return $null}
 return (Get-Content $file -Raw|ConvertFrom-Json)
}
function ImportWindowing {
 $dll=Join-Path $projectRoot 'engine\Sandrone.Windowing.dll'
 $hashes=Get-Content -LiteralPath (Join-Path $projectRoot 'integrity.json') -Raw|ConvertFrom-Json
 $expected=$hashes.PSObject.Properties['engine/Sandrone.Windowing.dll'].Value
 if(!$expected -or (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash -ine $expected){throw '窗口组件校验失败，未加载组件。'}
 if(!('SandroneCodex.NativeWindow' -as [type])){Add-Type -Path $dll}
}
function VerifyManaged($state,$exe){
 if($null -eq $state -or $state.port -ne 19337 -or $state.exe -cne $exe){return $false}
 try {
  $proc=Get-Process -Id $state.ownerPid -ErrorAction Stop
  if($proc.Path -cne $exe -or $proc.StartTime.ToUniversalTime().Ticks.ToString() -cne $state.ownerStarted){return $false}
  if($projectRoot -and (Test-Path -LiteralPath (Join-Path $projectRoot 'engine\Sandrone.Windowing.dll'))){
   ImportWindowing
   if(![SandroneCodex.NativeWindow]::OwnsLoopbackListener(19337,[uint32]$state.ownerPid)){return $false}
  }else{
   $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 19337 -ErrorAction Stop)
   if(!$listeners.Count -or @($listeners|Where-Object {$_.LocalAddress -notin @('127.0.0.1','::1') -or $_.OwningProcess -ne $state.ownerPid}).Count){return $false}
  }
  $version=Invoke-RestMethod 'http://127.0.0.1:19337/json/version' -TimeoutSec 2
  $u=[uri]$version.webSocketDebuggerUrl
  return ($u.Scheme -eq 'ws' -and $u.Host -eq '127.0.0.1' -and $u.Port -eq 19337 -and $u.AbsolutePath -eq ('/devtools/browser/'+$state.browserId))
 }catch{return $false}
}
function Inject($node,$verb,$state){
 # Windows PowerShell 5 turns native stderr into a terminating error under Stop.
 # A renderer starting/reloading is expected: let the caller retry by exit code.
 $ErrorActionPreference='Continue'
 $injectArgs=@((Join-Path $projectRoot 'vendor\dream-skin\windows\scripts\injector.mjs'),$verb,'--port','19337','--browser-id',$state.browserId,'--theme-dir',(Join-Path $projectRoot 'themes\sandrone'),'--timeout-ms','8000')
 $output=& $node @injectArgs 2>&1
 $ok=$LASTEXITCODE -eq 0
 # Upstream output may contain local UI details; retain only exit status in this launcher log.
 return $ok
}
function WaitManaged($state,$exe,[int]$timeoutMs=4000){
 if($null -eq $state){return $false}
 # A stale process record is not a startup race; do not spend seconds retrying it.
 try{$owner=Get-Process -Id $state.ownerPid -ErrorAction Stop;if($state.exe -cne $exe -or $owner.Path -cne $exe -or $owner.StartTime.ToUniversalTime().Ticks.ToString() -cne $state.ownerStarted){return $false}}catch{return $false}
 $clock=[Diagnostics.Stopwatch]::StartNew()
 do{if(VerifyManaged $state $exe){return $true};Start-Sleep -Milliseconds 150}while($clock.ElapsedMilliseconds -lt $timeoutMs)
 return $false
}
function NativeUi($node,$verb,$state){
 $ErrorActionPreference='Continue'
 $nativeOutput=& $node (Join-Path $projectRoot 'engine\session.mjs') $verb --browser-id $state.browserId 2>&1
 $script:NativeExitCode=$LASTEXITCODE
 return ($LASTEXITCODE -eq 0)
}
function ActivateManaged($state,$exe){
 $owner=Get-Process -Id $state.ownerPid -ErrorAction Stop
 if($owner.Path -cne $exe -or $owner.StartTime.ToUniversalTime().Ticks.ToString() -cne $state.ownerStarted){throw '窗口进程身份已变化，未操作窗口。'}
 $dll=Join-Path $projectRoot 'engine\Sandrone.Windowing.dll'
 $hashes=Get-Content -LiteralPath (Join-Path $projectRoot 'integrity.json') -Raw|ConvertFrom-Json
 $expected=$hashes.PSObject.Properties['engine/Sandrone.Windowing.dll'].Value
 if(!$expected -or (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash -ine $expected){throw '窗口恢复组件校验失败，未加载组件。'}
 if(!('SandroneCodex.NativeWindow' -as [type])){Add-Type -Path $dll}
 $null=[SandroneCodex.NativeWindow]::Activate([uint32]$state.ownerPid,$true)
}
function EnsureWatcher($node,$state){
 # Window activation is performed only for explicit desktop launches, before waiting.
 $sessionScript=Join-Path $projectRoot 'engine\session.mjs'
 # The watcher caches the validated theme payload as well as fixed UI code.
 # Refresh it on theme edits so it cannot reapply yesterday's text/style.
 $revisionFiles=@('engine/renderer.mjs','engine/opening-client.mjs','engine/session.mjs','engine/cdp.mjs','engine/target-runner.mjs','engine/watch-signal.mjs','engine/native-ui.css','themes/sandrone/theme.json','themes/sandrone/theme.css','themes/sandrone/manifest.json','themes/sandrone/background.png')
 $revision=($revisionFiles|ForEach-Object {(Get-FileHash -LiteralPath (Join-Path $projectRoot $_) -Algorithm SHA256).Hash}) -join ''
 if($state.watcherPid){
  try{
   $processInfo=Get-CimInstance Win32_Process -Filter ('ProcessId='+$state.watcherPid)
   $watchProcess=Get-Process -Id $state.watcherPid
   if($processInfo.ExecutablePath -ceq $node -and $processInfo.CommandLine.Contains($sessionScript) -and $processInfo.CommandLine.Contains($state.browserId) -and $watchProcess.StartTime.ToUniversalTime().Ticks.ToString() -ceq $state.watcherStarted){
    if($state.watcherRevision -ceq $revision){return}
    # Reload our verified Node watcher when fixed engine code changes; never stop Codex.
    Stop-Process -Id $watchProcess.Id -ErrorAction Stop
   }
  }catch{}
 }
 $watchArgs=@(('"'+$sessionScript+'"'),'--watch','--browser-id',$state.browserId)
 $watchProcess=Start-Process -FilePath $node -ArgumentList $watchArgs -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $stateRoot 'watcher-error.log')
 Start-Sleep -Milliseconds 300
 if($watchProcess.HasExited){throw '主题监视进程提前结束，请查看 state\watcher-error.log。'}
 $state|Add-Member -NotePropertyName watcherPid -NotePropertyValue $watchProcess.Id -Force
 $state|Add-Member -NotePropertyName watcherStarted -NotePropertyValue $watchProcess.StartTime.ToUniversalTime().Ticks.ToString() -Force
 $state|Add-Member -NotePropertyName watcherRevision -NotePropertyValue $revision -Force
 $state|ConvertTo-Json|Set-Content (Join-Path $stateRoot 'managed.json') -Encoding UTF8
}
$mutex=New-Object Threading.Mutex($false,'Local\SandroneCodex.Control')
$locked=$false
try {
 $locked=$mutex.WaitOne(0)
 if(!$locked){if($Action -eq 'launch'){Result 'ready' '启动正在进行' '已合并重复启动请求，请查看官方窗口。';exit 0};Result 'blocked' '另一项启动器操作正在运行' '请等待完成后重试。';exit 2}
 $exe=OfficialExe
 $state=GetManaged
 if($Action -eq 'official'){
  Start-Process -FilePath $exe -WindowStyle Normal | Out-Null
  Result 'ready' '已请求打开官方原版' '使用原有登录与配置；未开启新的调试端口。';exit 0
 }
 if($Action -eq 'restore'){
  if($null -eq $state){Result 'ready' '当前没有此启动器管理的主题会话' '官方配置、登录、MCP 和聊天记录均未修改。';exit 0}
  if(!(VerifyManaged $state $exe)){Result 'blocked' '无法确认主题会话身份' '未操作任何进程。请关闭主题窗口后，从官方快捷方式重开。';exit 3}
  [IO.File]::WriteAllText((Join-Path $stateRoot 'paused'),'paused',$utf8)
  if(!(NativeUi (NodeExe) '--remove' $state)){throw '同窗动画或界面组件移除失败，已保留会话。请手动关闭主题客户端。'}
  if(!(Inject (NodeExe) '--remove' $state)){throw '主题移除未获验证；请关闭主题窗口后重新打开官方版。'}
  if($state.watcherPid){
   $watcher=Get-CimInstance Win32_Process -Filter ('ProcessId='+$state.watcherPid) -ErrorAction SilentlyContinue
   $knownWatcher=$watcher -and ($watcher.CommandLine.Contains((Join-Path $projectRoot 'engine\session.mjs')) -or $watcher.CommandLine.Contains((Join-Path $projectRoot 'vendor\dream-skin\windows\scripts\injector.mjs')))
   if($knownWatcher -and $watcher.ExecutablePath -ceq (NodeExe) -and (Get-Process -Id $state.watcherPid).StartTime.ToUniversalTime().Ticks.ToString() -ceq $state.watcherStarted){Stop-Process -Id $state.watcherPid}
  }
  Result 'ready' '已恢复官方外观' '主题已移除。调试端口将在你关闭该主题窗口后释放；恢复过程不会关闭聊天。';exit 0
 }
 $node=NodeExe
 if(WaitManaged $state $exe 2500){
  if($ActivateWindow){ActivateManaged $state $exe}
  Remove-Item -LiteralPath (Join-Path $stateRoot 'paused') -ErrorAction SilentlyContinue
  if(NativeUi $node '--resume' $state){EnsureWatcher $node $state;Result 'ready' '已连接桑多涅主题窗口' '已复用原会话并请求显示窗口；未重启客户端。';exit 0}
  if($script:NativeExitCode -eq 2){EnsureWatcher $node $state;Result 'waiting' 'Codex 已打开，正在等待可见主界面' '请完成登录或展开窗口，主题会在界面就绪后自动接入，不必重复启动。';exit 0}
  throw '现有主题窗口未通过 renderer 验证。'
 }
 $existing=@(Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object {try{$_.Path -ceq $exe}catch{$false}})
 if($existing.Count){Result 'blocked' '请先手动退出官方 Codex，再重试主题启动' '现有会话保持运行。主题模式将使用独立 profile，首次可能需要你登录；启动器不会复制凭据。';exit 4}
 ImportWindowing
 if([SandroneCodex.NativeWindow]::HasListener(19337)){throw '本机端口 19337 已被占用，已拒绝连接。'}
 $theme=Join-Path $projectRoot 'themes\sandrone'
 & $node (Join-Path $projectRoot 'verify-integrity.mjs')
 if($LASTEXITCODE -ne 0){throw '运行文件完整性校验失败。'}
 $stage=Join-Path $stateRoot ('validate-'+$Token)
 $null=New-Item -ItemType Directory -Path $stage
 & $node (Join-Path $projectRoot 'vendor\dream-skin\runtime\theme-package-validator.mjs') --source $theme --stage $stage --platform windows --client-version 1.5.21 | Out-Null
 if($LASTEXITCODE -ne 0){throw '主题包未通过上游安全校验。'}
 Result 'loading' '正在启动隔离主题会话…' '首次可能需要你登录；不会读取或复制原有凭据。'
 $themeProfile=Join-Path $projectRoot 'profile'
 $owner=Start-Process -FilePath $exe -ArgumentList @('--remote-debugging-address=127.0.0.1','--remote-debugging-port=19337',('--user-data-dir="'+$themeProfile+'"')) -WindowStyle Normal -PassThru
 $deadline=(Get-Date).AddSeconds(25);$version=$null
 do {
  try{$version=Invoke-RestMethod 'http://127.0.0.1:19337/json/version' -TimeoutSec 1}catch{}
  if(!$version){Start-Sleep -Milliseconds 350}
 }while(!$version -and (Get-Date) -lt $deadline -and !$owner.HasExited)
 if(!$version){throw '官方客户端未提供调试接口。请正常打开官方版；不要更改安全策略。'}
 $u=[uri]$version.webSocketDebuggerUrl
 if($u.Scheme -ne 'ws' -or $u.Host -ne '127.0.0.1' -or $u.Port -ne 19337 -or $u.AbsolutePath -notmatch '^/devtools/browser/([A-Za-z0-9._-]{1,200})$'){throw '调试接口身份无效。'}
 $state=[pscustomobject]@{port=19337;browserId=$Matches[1];ownerPid=$owner.Id;ownerStarted=$owner.StartTime.ToUniversalTime().Ticks.ToString();exe=$exe}
 $state|ConvertTo-Json|Set-Content (Join-Path $stateRoot 'managed.json') -Encoding UTF8
 if(!(WaitManaged $state $exe 6000)){throw '调试端口未通过进程及回环绑定校验。请关闭本次主题窗口。'}
 Remove-Item -LiteralPath (Join-Path $stateRoot 'paused') -ErrorAction SilentlyContinue
 Result 'loading' '正在接入同窗动画与主题…' '请查看官方窗口；登录等待不会再重复启动检测进程。'
 $ready=NativeUi $node '--start' $state
 if(!$ready -and $script:NativeExitCode -ne 2){throw '主题组件应用失败。原生窗口保留，可运行恢复入口。'}
 EnsureWatcher $node $state
 if(!$ready){Result 'waiting' 'Codex 已打开，正在等待主界面' '请完成登录或展开窗口；主题监视器会自动接入，无需反复打开启动器。';exit 0}
 Result 'ready' '桑多涅主题已就绪' '官方 renderer 已通过上游可见窗口验证。'
}catch{Result 'error' '主题启动未完成' $_.Exception.Message;exit 1}
finally{if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}
