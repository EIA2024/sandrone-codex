# 可选 Windows 原生加载附加包

这是一项可选的 Windows MSIX modification package 集成。它在普通官方 Codex 启动时加载桑多涅主题，沿用官方 profile，不要求另开 CDP 调试端口。原有便携启动器继续保留。本方案不是 OpenAI 插件目录中的标准插件，也不是官方支持的主题接口。

## 使用与退出

安装后的主窗口提供「主题」菜单：选择桑多涅或原生界面、重播开屏、设置启动播放，以及安排卸载。禁用主题不卸载加载器；完全移除需要退出全部 Codex 窗口与托盘进程。

「退出后卸载」先禁用视觉主题，再由本地 worker 等待所有官方 Codex 实例退出。等待阶段可以取消；没有杀进程或强制退出按钮。worker 将固定附加包全名提交给 Windows，不会选择 `OpenAI.Codex` 本体。

Windows 部署使用 `RemovePackageAsync` 的 `DeferRemovalWhenPackagesAreInUse` 选项，覆盖等待结束后又启动新实例、或 helper 仍持有包引用的情况。提交给 Windows 后不可取消：此时显示正在移除，不能把“已提交”当作完成。只有重新查询确认附加包注册已消失，状态才变为完成。Windows 可能继续保留仍被引用的已暂存文件；不会把它们强制删除。[Microsoft 包生命周期](https://learn.microsoft.com/en-us/windows/msix/package/package-lifetime)

偏好和卸载状态保存在官方 `userData` 下的 `sandrone-theme` 目录；退出后卸载不删除这些数据，也不清理官方聊天、登录和其他插件数据。卸载已完成后重装同版本，状态查询会恢复为空闲，用户仍可再次启用主题。

## 支持范围

| 项目 | 当前范围 |
| --- | --- |
| 系统 | Windows 11 x64 |
| 官方主包 | `OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0` |
| 官方来源 | 有效 Store 签名 MSIX，发布者及四个关键文件 SHA256 匹配 `native-integration/compatibility.json` |
| 本地附加包 | `Local.Sandrone.CodexNativeTheme`，`0.2.0.0` |
| 构建依赖 | x64 GCC、Windows SDK MakeAppx、PowerShell；不需要 npm 或另带 Node 运行时 |
| 部署 | 本机开发测试用 unsigned MSIX；可能需要管理员权限，不自动提权 |

本地 unsigned MSIX 用于测试，不是公开发行签名方案。Microsoft 要求正式分发采用签名；这里不导入证书、不放宽系统防护、不更改用户或机器执行策略。菜单调用的 PowerShell 仅设置该子进程的脚本执行策略，组织强制策略仍然优先。[Microsoft unsigned MSIX 说明](https://learn.microsoft.com/en-us/windows/msix/package/unsigned-package)

官方包升级到另一个完整版本时，旧 VFS 路径不会命中新版。安装器拒绝未知版本，不降级、不卸载或替换官方 Codex；适配新版本需要新增经过验证的兼容项。原生转接处于 updater 的加载链，保留 exports 并不代表已验证官方更新全过程。

## 构建与安装

在仓库根目录执行，`OfficialMsix` 指向你从官方渠道取得的对应版本安装包：

```powershell
.\native-integration\build.ps1 -OfficialMsix 'D:\Downloads\ChatGPT-26.1021.3705.0-x64.msix'
```

可通过 `-GccPath`、`-MakeAppxPath` 指定工具；默认从 PATH 和 Windows SDK 安装目录查找。`-OutputDirectory` 必须是尚不存在的目录，默认在 `dist/native-addon/` 中生成独立构建目录。构建只生成文件，不注册、启动或卸载任何应用。

构建输出包含 MSIX、`bundle.json`、安装/卸载脚本及日志。MSIX 内自包含 runtime、原主题素材与管理脚本；不依赖作者安装路径或仓库路径。原官方 updater 字节从验证后的官方 MSIX 取出，仅进入本地生成物，不提交到 Git。原程序、归档和原模块的物理安装文件不被改写。

保存工作并从托盘正常退出 Codex 后，在独立 PowerShell 中对构建输出运行：

```powershell
.\install.ps1 -VerifyOnly
.\install.ps1
```

`-VerifyOnly` 只检查版本、签名属性及哈希，不安装。安装在 Codex 运行时拒绝继续；不会强制关闭聊天。已有附加包的包内进程可能看到 VFS 叠加视图，所以应从独立 PowerShell 执行安装，不能把叠加模块误当官方原文件。

## 加载与恢复契约

MSIX 将 `windows-updater.node` 映射到转接模块，同时提供原模块的字节副本。转接先调用原注册函数并返回原 exports，原模块的异常原样保留；只有额外主题入口的异常会被清除。原模块缺失会显式报错，不悄悄返回空 exports。

主题和 runtime 位于包内 `native/sandrone/`。运行时通过相对路径访问素材。卸载脚本在调用前复制到用户数据目录，避免包移除导致 worker 失去脚本文件。worker 的包身份继承、取消和部署状态必须通过最终实机验收；逻辑测试不能替代部署行为。

需要手动恢复时，先正常退出 Codex，再从构建输出目录执行：

```powershell
.\uninstall.ps1 -Action Remove -StateDirectory '<Codex userData>\sandrone-theme' -ExpectedPackageFullName 'Local.Sandrone.CodexNativeTheme_0.2.0.0_x64__vt89pjxv8jer8'
```

`Status` 查询状态，`Cancel` 取消尚未提交给 Windows 的请求。`Schedule` 安排退出后卸载；`Run` 只供 worker 使用。各操作只接受固定包名前缀、x64 架构及此本地开发发布者的精确完整包名。卸载请求 24 小时未执行会过期并报告错误，进程中止也不会伪报成功。

## 开发验证

```powershell
.\tests\native-package.test.ps1
.\tests\native-package-bridge.test.ps1
.\tests\native-package-bundle.test.ps1 -BundleDirectory '<构建输出目录>'
node --test tests/native-manager.test.mjs
```

- 生命周期 fixtures 覆盖错误目标、仍运行的实例、重复安排、取消、旧 worker token、部署延迟、注册复查和重装，全部使用隔离临时状态与模拟部署，不修改真实 Windows 包。
- 原生 bridge 测试实际编译 DLL，并在 Node N-API fixture 中验证原 exports、主题加载失败、原模块异常与原模块缺失。它不能代替真实 Electron updater 或官方更新流程测试。
- 构建包检查核对 manifest、原模块字节、runtime/资源自包含以及无个人路径和运行状态。
- `tests/native-controls.browser.mjs` 在独立 Chromium 中验证菜单与键盘交互；`tests/native-integration.browser.mjs` 将真实 runtime 接到 Electron API 适配器，验证延迟主界面、菜单动作、主题切换及媒体生命周期。前者接受 `BROWSER_EXECUTABLE`，后者接受 `CHROMIUM_EXECUTABLE`；两者均可用 `PLAYWRIGHT_MODULE` 指定已有 Playwright。集成测试可通过 `SANDRONE_THEME_SOURCE` 指向另一个 checkout，检查与独立开屏优化的组合。适配器验证不代表真实 Electron/AppX 验收。
- 本轮整理版本已完成本地编译和无注册打包；尚未替换现有用户安装，未验证新自包含包的真实启动、菜单卸载与升级。旧 `0.1.0` 的本机安装记录只证明旧实现，不能充当这个版本的验收。

合并/发行前应补齐真实普通入口加载、启用/禁用、持久化、退出后卸载/取消、官方程序恢复启动和主包升级失配测试。Windows 版本与应用版本应随验收记录保存。

## 文件与官方依据

构建器和兼容矩阵在 `native-integration/`；主题交互在其 `runtime/`。本 PR 不改变原开屏资源策略，开屏性能优化由独立改动提供。

该机制基于 Microsoft 的 [modification packages](https://learn.microsoft.com/en-us/windows/msix/modification-packages)。普通插件管理、原生主题切换和 Windows 附加包注册是不同层次的能力；文档和 UI 不把它们混称为官方插件。
