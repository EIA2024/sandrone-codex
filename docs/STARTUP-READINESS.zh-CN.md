# 原生启动画面与真实阶段进度

此功能属于原生附加包 0.3.1.0，依赖原生集成 PR1。仍只针对 Windows 11 x64 和 Codex 26.1021.3705.0；便携 CDP 启动器保留原播放器。

## 启动与进入

加载器在主窗口导航前注册独立 session preload，不替换官方 preload。页面建立 documentElement 后立即挂载不属于 React 根节点的遮罩，用嵌入式首帧遮住官方 HTML 启动标志。工作区在遮罩下挂载；实际主题注入仍由原生集成协调。

“启动时播放开屏”和“就绪后自动进入”是两个独立选项。旧偏好缺少 `autoEnterOnReady` 时默认开启自动进入。自动模式同时等待真实就绪和完整 5.2 秒片头；手动模式就绪后双击或连续两次空格进入。未就绪时 Esc、双击和空格都不能跳过。片头结束后播放 9 秒循环，不要求慢启动恰好匹配视频时长。

启动检查与动画时间相互独立：

1. 主窗口 preload 与状态通信已建立。
2. 收到本机 app-server 的 initialized 与 connected 消息/快照；不等待无关远程主机和后台列表刷新。
3. 活动工作区主区域与侧栏已挂载，初始占位已消失。
4. 主题 ID、revision、实际 stylesheet、原生 UI 样式、当前主题背景图片及字体加载检查通过。
5. 活动页必要控件具备可用布局与状态；进入前等待绘制机会并再次检查。

每项真实完成后推进一格，不用计时器伪造进度，也不显示精确耗时百分比。服务断连或主题检查失效会撤销就绪。本机服务就绪不代表远程聊天主机、所有云端数据或每项第三方插件已完成加载。

30 秒仍未就绪时显示恢复操作，不自动满格或揭开工作区。登录入口暂时让出画面，工作区出现后重新遮挡并检查；重试重新检查主题图片。显式“切回原生界面”会禁用主题。减少动态效果和坏媒体使用静态图，仍等待真实就绪，不等待无法完成的视频。

## 预渲染与资源

`assets/motion/startup.json` 描述随包的 1920×1080、30 fps、无声 H.264 片头和循环视频，以及首帧和静态回退图。签名、人物描边、粒子和转场已离线合成；运行时仅播放视频和绘制状态控件，不运行旧版 SVG/CSS 装饰动画。

原生路径通过当前 Codex 的 `app://fs/@fs/` 本地媒体路由读取视频，保留 Range 支持，不把整段视频 Base64 序列化到 JavaScript。图片小，允许嵌入首帧以避免等待媒体路由。退出开屏或禁用主题会暂停并释放视频源。视频解码及显示仍消耗资源。

构建核对媒体清单中的尺寸、帧率、字节数与 SHA256；安装不转码。制作工程、时间轴、逐帧样本与本地探针保存在 ignored `dist/opening-authoring/` 和 `dist/local-acceptance/`，不进入包或 PR。重新制作素材后更新清单和来源摘要。

## 验证与限制（2026-10-25）

本轮已运行 Node 回归、独立 Chrome 156 的真实视频/状态测试、原生 runtime + Electron API 适配器检查，以及 Windows PowerShell 5.1 生命周期 fixtures、实际 GCC/N-API 桥接和自包含 MSIX 检查。浏览器 document-start 检查确认遮罩在第一个 animation frame 前存在；这不等同于 Windows 原生窗口首次绘制验收。

可复用检查随代码提交：

```powershell
Get-ChildItem tests -Filter '*.test.mjs' | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { throw $_.Name } }
$env:PLAYWRIGHT_MODULE = '<absolute path to installed playwright>'
$env:CHROMIUM_EXECUTABLE = '<absolute path to installed Chrome>'
node tests/startup.browser.mjs
node tests/native-startup.browser.mjs
node tests/project-colors.browser.mjs
powershell.exe -NoProfile -File tests/native-package.test.ps1
powershell.exe -NoProfile -File tests/native-package-bridge.test.ps1
powershell.exe -NoProfile -File tests/native-package-bundle.test.ps1 -BundleDirectory '<built bundle>'
```

0.3.0.0 于 2026-10-25 安装并从普通入口启动，但用户确认启动与重播都不显示动画。日志只到 `startup-document-created`，未出现 `startup-screen-mounted`。定位发现同步 IPC 处理器先设置 `event.returnValue = null`，再写入配置；真实 Electron 在赋值时发送回复，首个空回复使播放器跳过初始化。旧浏览器适配器用普通可覆盖属性模拟回复，未覆盖该契约。

0.3.1.0 将合法请求改为只回复一次配置。新增同步回复回归已核实旧实现失败、修复后通过；浏览器集成适配器也改为消费首个回复。同版官方二进制的独立解包测试副本已记录开屏挂载、视频首帧，以及真实服务、工作区和主题检查的五项就绪。该测试使用独立 profile，隐藏窗口中的媒体与绘制行为不作为正常显示验收。

2026-10-25 22:08（北京时间），独立安装器成功注册 0.3.1.0，并通过无调试参数的普通 AUMID 入口重开 Codex。实际原生日志记录了早期 preload 注册、遮罩挂载、视频首帧、片头播完、五项就绪和进入工作区；随后一次重播也记录到挂载、视频首帧、片头播完和再次进入。已回读系统包注册确认版本。用户确认当前效果可以提交正式 PR；这不是逐帧录像或独立审查结论。

验证限制与后续工作：尚未录制原生窗口首次绘制，不能量化原生标志或工作区闪现；尚未完成本版完整进程启动与热重播的同条件性能对比、长帧和掉帧采样。原生托盘恢复、登录恢复、两种进入模式及新偏好的完整跨重启矩阵也未全部复测。相关浏览器/适配器回归不代替这些实机检查；历史 0.2.0.0 性能结果不代表本版。
