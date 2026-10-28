# 可选 Windows 原生加载附加包

这是一项可选的 Windows MSIX modification package 集成。它在普通官方 Codex 启动时加载桑多涅主题，沿用官方 profile，不要求另开 CDP 调试端口。原有便携启动器继续保留。本方案不是 OpenAI 插件目录中的标准插件，也不是官方支持的主题接口。

原生启动画面现采用独立早期 preload、离线合成视频和真实阶段进度，详见 [启动进度说明](STARTUP-READINESS.zh-CN.md)。0.3.1.0 修复启动握手问题并已安装，普通启动与重播均记录到视频播放和进入工作区。下文标明 0.2.0.0 的结果属于历史版本。

## 使用与退出

安装后的主窗口提供「主题」菜单：选择桑多涅或原生界面、重播开屏、设置启动播放，以及安排卸载。禁用主题不卸载加载器；完全移除需要退出全部 Codex 窗口与托盘进程。

「退出后卸载」先禁用视觉主题，再由本地 worker 等待所有官方 Codex 实例退出。等待阶段可以取消；没有杀进程或强制退出按钮。worker 将固定附加包全名提交给 Windows，不会选择 `OpenAI.Codex` 本体。

Windows 部署使用 `RemovePackageAsync` 的 `DeferRemovalWhenPackagesAreInUse` 选项，覆盖等待结束后又启动新实例、或 helper 仍持有包引用的情况。提交给 Windows 后不可取消：此时显示正在移除，不能把“已提交”当作完成。只有重新查询确认附加包注册已消失，状态才变为完成。Windows 可能继续保留仍被引用的已暂存文件；不会把它们强制删除。[Microsoft 包生命周期](https://learn.microsoft.com/en-us/windows/msix/package/package-lifetime)

偏好和卸载状态保存在官方 `userData` 下的 `sandrone-theme` 目录；退出后卸载不删除这些数据，也不清理官方聊天、登录和其他插件数据。卸载已完成后重装同版本，状态查询会恢复为空闲，用户仍可再次启用主题。

## 支持范围

| 项目 | 当前范围 |
| --- | --- |
| 系统 | Windows 11 x64 |
| 官方主包 | 官方发布者的 x64 包，通过 `windows-updater-napi-v1` 加载契约检查；每个产物只覆盖本次发现的完整版本 |
| 官方来源 | 有效官方签名 MSIX，或独立进程读取 Store 注册包并通过 Windows 内容完整性检查；五个关键文件摘要现场生成 |
| 本地附加包 | `Local.Sandrone.CodexNativeTheme`，版本下限 `0.4.0.0`，维护助手自动递增 |
| 构建依赖 | x64 GCC、Windows SDK MakeAppx、PowerShell、Node.js 24+；视频需要重新生成时另需 Playwright、Chromium/Chrome/Edge、FFmpeg/FFprobe |
| 使用已构建包 | 安装和启动不需要 Node、浏览器或 FFmpeg；播放器使用随包视频 |
| 部署 | 本机开发测试用 unsigned MSIX；可能需要管理员权限，不自动提权 |

本地 unsigned MSIX 用于测试，不是公开发行签名方案。Microsoft 要求正式分发采用签名；这里不导入证书、不放宽系统防护、不更改用户或机器执行策略。菜单调用的 PowerShell 仅设置该子进程的脚本执行策略，组织强制策略仍然优先。[Microsoft unsigned MSIX 说明](https://learn.microsoft.com/en-us/windows/msix/package/unsigned-package)

官方包升级到另一个完整版本时，旧 VFS 路径不会命中新版。构建器检查真实的 updater 加载路径、Node-API 注册导出、导入依赖与 Electron 符号，再生成本次精确版本的路径。文件哈希变化用于记录本次原文件，不直接判为不兼容；未知加载接口则拒绝构建，不部署候选包。安装器仍要求目标版本精确匹配，不降级、不卸载或替换官方 Codex。静态契约检查不能证明未来全部版本兼容，也不能替代官方更新全过程的实机验收。

本机曾用 `0.3.6.0` 一次性适配包修复升级到 `26.1023.6123.0` 后主题失效的问题；`0.4.0.0` 将相同机械步骤自动化。已生成的旧 MSIX 本身仍不跨版本复用，维护助手负责生成和安装新包。偏好格式及 60fps 素材保持不变。

## 构建与安装

在仓库根目录执行，`OfficialMsix` 指向你从官方渠道取得的对应版本安装包：

```powershell
.\native-integration\build.ps1 -OfficialMsix 'D:\Downloads\ChatGPT-26.1023.6123.0-x64.msix'
# 或从独立 Windows PowerShell 5.1 自动发现本机官方包
.\native-integration\build.ps1 -InstalledPackage
```

可通过 `-GccPath`、`-MakeAppxPath`、`-NodePath` 指定工具；默认从 PATH 和 Windows SDK 安装目录查找。`-OutputDirectory` 必须是尚不存在的目录，默认在 `dist/native-addon/` 中生成独立构建目录。构建只生成文件，不注册、启动或卸载任何应用。

构建先核对动画脚本、时间轴、源素材与现有视频的 SHA256；源版本改变或产物不完整时自动重新渲染，`-RebuildStartupMedia` 可强制重做。新视频完整校验后才替换仓库中的发布产物并更新来源清单，失败则停止构建。打包前再次比对实际复制的源素材、视频与构建回执中的来源指纹，防止混入其他版本。渲染依赖和独立检查命令见 [启动进度说明](STARTUP-READINESS.zh-CN.md#构建时生成开屏)。

构建输出包含 MSIX、`bundle.json`、`compatibility-report.json`、安装/卸载脚本及日志。MSIX 内自包含 runtime、原主题素材与管理脚本；不依赖作者安装路径或仓库路径。原官方 updater 字节从验证后的来源取出，仅进入本地生成物，不提交到 Git。原程序、归档和原模块的物理安装文件不被改写。`-BridgePath` 与 `-BridgeSha256` 可复用已验证的预编译桥接模块，省去日常重新编译。

保存工作并从托盘正常退出 Codex 后，在独立 PowerShell 中对构建输出运行：

```powershell
.\install.ps1 -VerifyOnly
.\install.ps1
```

`-VerifyOnly` 只检查版本、签名属性及哈希，不安装。安装在 Codex 运行时拒绝继续；不会强制关闭聊天。已有附加包的包内进程可能看到 VFS 叠加视图，所以应从独立 PowerShell 执行安装，不能把叠加模块误当官方原文件。

## 加载与恢复契约

宿主 URL、界面选择器和私有服务消息集中在 `runtime/host-adapter.cjs`。界面就绪与服务就绪独立记录；服务消息缺失时显示未知，不虚构服务成功。异步 bootstrap 不阻塞页面；开屏探针失败、媒体错误或 30 秒未就绪时移除遮罩，保留可用主题效果及管理入口。正常手动模式在就绪后仍等待用户进入。

MSIX 将 `windows-updater.node` 映射到转接模块，同时提供原模块的字节副本。转接先调用原注册函数并返回原 exports，原模块的异常原样保留；只有额外主题入口的异常会被清除。原模块缺失会显式报错，不悄悄返回空 exports。

主题和 runtime 位于包内 `native/sandrone/`。运行时通过相对路径访问素材。卸载脚本在调用前复制到用户数据目录，避免包移除导致 worker 失去脚本文件。worker 的包身份继承、取消和部署状态必须通过最终实机验收；逻辑测试不能替代部署行为。

需要手动恢复时，先正常退出 Codex，再从构建输出目录执行：

```powershell
.\uninstall.ps1 -Action Remove -StateDirectory '<Codex userData>\sandrone-theme' -ExpectedPackageFullName 'Local.Sandrone.CodexNativeTheme_0.3.6.0_x64__vt89pjxv8jer8'
```

`Status` 查询状态，`Cancel` 取消尚未提交给 Windows 的请求。`Schedule` 安排退出后卸载；`Run` 只供 worker 使用。各操作只接受固定包名前缀、x64 架构及此本地开发发布者的精确完整包名。卸载请求 24 小时未执行会过期并报告错误，进程中止也不会伪报成功。

上述卸载命令的包名只是历史示例；实际操作必须使用待卸载安装的 `bundle.json` 中的 `addonPackageFullName`，不能把不同版本的包当作已经卸载。维护助手生成的版本会递增。

## 独立维护助手

先完成一次构建，在管理员权限的独立 Windows PowerShell 5.1 中安装助手。将 `$bundleDirectory` 设为已验证的构建输出：

```powershell
$bundle = Get-Content (Join-Path $bundleDirectory 'bundle.json') -Raw | ConvertFrom-Json
$bridge = Join-Path $bundleDirectory ('package\VFS\ProgramFilesX64\WindowsApps\' + $bundle.targetPackage + '\app\resources\native\windows-updater.node')
.\native-integration\maintenance.ps1 -Action Install -SourceDirectory $PWD.Path -BridgePath $bridge -BridgeSha256 $bundle.proxySha256
.\native-integration\maintenance.ps1 -Action Status
```

安装会复制源码、既有媒体、Node 和 MakeAppx 到 `%ProgramData%\Sandrone\Maintenance\<SID>` 的受保护快照，并编译包事件监听器；需要现有 Windows SDK，但日常维护无需 GCC、浏览器、FFmpeg、网络下载或持续依赖这个 checkout。按当前用户创建登录任务，使用现有 unsigned MSIX 安装所需的管理员权限，不自动弹出提权请求。

助手订阅官方包安装/更新事件，同时每 30 秒核对状态以补偿遗漏事件。每个目标与源码快照只准备一次；构建失败停止重试，进程中断仅自动恢复一次。应用仍运行时保持 `waiting-for-exit`；全部正常退出后才提交安装，并用延迟注册处理重新启动的竞争。`submitted`、`registered`、`loaded` 分别表示 Windows 接受请求、实际注册确认、该精确版本的运行时回执，不能互相替代。助手不会主动重启 Codex，下一次普通启动会记录回执。

`-Action Stop` 停止维护，`Retry` 明确重试当前目标，`Uninstall` 移除登录任务并停止维护，保留主题、偏好和证据。主题菜单安排卸载或已安装附加包被移除时会暂停自动恢复，避免自动装回。状态与错误位于上述目录的 `state.json`、`worker.json`、`worker-error.json` 和各构建日志。开屏禁用偏好不会禁用自动兼容维护。

真正改变加载接口的官方更新仍需要代码适配。更新后适配尚未完成的首次启动可能显示原生界面；失败时用 `Status` 查看原因，再更新源码快照并重新安装助手。

## 开发验证

```powershell
.\tests\native-package.test.ps1
.\tests\native-package-bridge.test.ps1
.\tests\host-package.test.ps1
.\tests\maintenance.test.ps1
.\tests\maintenance-permissions.test.ps1
.\tests\native-package-bundle.test.ps1 -BundleDirectory '<构建输出目录>'
node --test tests/*.test.mjs
```

- 生命周期 fixtures 覆盖错误目标、仍运行的实例、重复安排、取消、旧 worker token、部署延迟、注册复查和重装，全部使用隔离临时状态与模拟部署，不修改真实 Windows 包。
- 原生 bridge 测试实际编译 DLL，并在 Node N-API fixture 中验证原 exports、主题加载失败、原模块异常与原模块缺失。它不能代替真实 Electron updater 或官方更新流程测试。
- 构建包检查核对 manifest、原模块字节、runtime/资源自包含以及无个人路径和运行状态。
- `tests/native-controls.browser.mjs` 在独立 Chromium 中验证菜单与键盘交互；`tests/native-integration.browser.mjs` 将真实 runtime 接到 Electron API 适配器，验证延迟主界面、菜单动作、主题切换及媒体生命周期。前者接受 `BROWSER_EXECUTABLE`，后者接受 `CHROMIUM_EXECUTABLE`；两者均可用 `PLAYWRIGHT_MODULE` 指定已有 Playwright。集成测试可通过 `SANDRONE_THEME_SOURCE` 指向另一个 checkout，检查与独立开屏优化的组合。适配器验证不代表真实 Electron/AppX 验收。
- 2026-10-25 在 Windows 11 x64（build 26200）、官方 Codex `26.1021.3705.0` 上，将与开屏优化组合的 `0.2.0.0` 包实际安装并通过普通入口启动。确认转接与原 updater 模块加载、主题关闭/启用、菜单及标题栏重播、启动播放偏好写入磁盘，以及安排卸载后取消。取消后 worker 已退出、包仍注册，主题恢复启用。安装预检发现的 Windows PowerShell 5.1 `-File` 默认目录问题已修复，并验证旧实现失败、新实现通过。

- 同日使用独立测试 profile，在真实官方打包进程中通过菜单保存偏好并完整重启进程，验证三种组合：关闭主题且不播放开屏、启用主题但不播放开屏、启用主题且播放开屏。三组均正确读取偏好并呈现对应界面；这不是默认用户 profile 的跨重启验收。

- 2026-10-28 对 `26.1023.6123.0`：`0.3.6.0` 一次性适配包已安装，并经普通入口启动；日志记录 preload 注册、开屏挂载、视频首帧、片头结束及进入工作区。该结果属于修复包，不能替代下面自动维护版本的验收。

- 同日自动适配改造：两个官方签名版本 `26.1021.3705.0`、`26.1023.6123.0` 均在不修改兼容策略的情况下构建成功，桥接模块及 60fps 素材复用；独立计划任务从本机官方包验证并构建也成功。43 项 Node 检查、51 项包生命周期检查、16 项宿主来源检查、34 项维护状态机检查及 53 项 ACL 策略检查通过。两组 Chromium runtime 集成检查复跑通过；故障浏览器检查还覆盖 IPC 缺失、选择器失配、媒体错误和超时，均不代表真实 Electron 的首次绘制性能。

- 维护助手已安装到独立受保护快照，登录任务与 WinRT 事件监听已启动；实机发现并修复 SDK 私有程序集清单缺失和 Windows PowerShell 5.1 的 UTF-8 状态读取问题。助手自动生成 `0.4.0.1`，包内容及安装预检通过，同一目标只有一次构建尝试。2026-10-28 14:49（Asia/Shanghai）正常退出后成功注册，普通入口重开后记录精确包身份的 `runtime-loaded`、开屏挂载、视频首帧、片头结束和 `startup-entered`，本次启动无 error/failed/degraded 事件。Windows 主包依赖确认指向 `0.4.0.1`，五个开屏媒体/清单文件摘要与源码一致。当前偏好为启用主题、启动播放、手动进入；设置文件最后修改于安装前的 14:44，安装后未重写。临时重开任务已移除，维护登录任务仍运行。原始本机证据保存在 ignored `dist/adaptive/acceptance.json`，不作为仓库公共检查。尚未触发一次真实官方升级事件，两个官方版本的构建不能替代完整 Store 升级验收；未独立观察这次界面外观或测量首次绘制性能。

上述实机检查没有执行完整卸载。退出后卸载验收曾安排等待正常退出，随后在执行前取消，已确认 worker 退出且附加包仍注册。合并/发行前仍应补齐退出后真正移除、官方程序恢复启动及主包升级失配测试。实机包组合了独立开屏优化，因此其播放帧率结果不作为本 PR 单独安装时的性能结论；不同 GPU/驱动环境未覆盖。

## 文件与官方依据

构建器和兼容策略在 `native-integration/`；主题交互在其 `runtime/`。0.3.0.0 的原生路径使用新的预渲染播放器；旧 CDP 启动器继续使用原有分块媒体缓存接口。

该机制基于 Microsoft 的 [modification packages](https://learn.microsoft.com/en-us/windows/msix/modification-packages)。普通插件管理、原生主题切换和 Windows 附加包注册是不同层次的能力；文档和 UI 不把它们混称为官方插件。
