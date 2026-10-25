# 原生启动画面与真实阶段进度

当前原生附加包版本为 0.3.3.0，依赖原生集成 PR1；0.3.1.0 的实机结果单独记录在下文。仍只针对 Windows 11 x64 和 Codex 26.1021.3705.0；便携 CDP 启动器保留原播放器。

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

开屏保留真实进度和进入提示，不显示“重试检查”和“切回原生界面”按钮；持续检测就绪状态，不自动满格或提前揭开工作区。仅需要登录时显示“继续登录”，暂时让出画面，工作区出现后重新遮挡并检查。主题停用仍可通过原生菜单操作。减少动态效果和坏媒体使用静态图，仍等待真实就绪，不等待无法完成的视频。

## 预渲染与资源

`assets/motion/startup.json` 描述随包的 1920×1080、30 fps、无声 H.264 片头和循环视频，以及首帧和静态回退图。签名、人物描边、粒子和转场已离线合成；运行时仅播放视频和绘制状态控件，不运行旧版 SVG/CSS 装饰动画。

原生路径通过当前 Codex 的 `app://fs/@fs/` 本地媒体路由读取视频，保留 Range 支持，不把整段视频 Base64 序列化到 JavaScript。图片小，允许嵌入首帧以避免等待媒体路由。退出开屏或禁用主题会暂停并释放视频源。视频解码及显示仍消耗资源。

制作脚本与时间轴现在保存在仓库 `tools/startup-scene.mjs` 和 `tools/startup-recipe.json`；继续提交四个发布媒体及 `startup.json`，供安装包直接携带。最初的一次性制作脚本、逐帧样本和本机探针留在 ignored `dist/`。安装及日常启动不生成或转码视频。

## 构建时生成开屏

`native-integration/build.ps1` 与 `Build-From-Source.ps1` 都执行以下流程：

1. 对动画 renderer、素材加载代码、生成脚本、时间轴和源素材计算内容指纹，并校验现有四个媒体文件的大小、SHA256 和来源清单。只看文件存在或时间戳不足以判为有效。
2. 输入和产物一致时复用已提交的视频，不启动浏览器或 FFmpeg；输入变化、旧格式清单、输出缺失或损坏时，先在 ignored `dist/startup-render-*` 中生成完整新产物。
3. FFprobe 检查真实编码、1080p 尺寸、30 fps、帧数和无音轨；生成后再次确认输入未变化。完整校验后替换视频、图片及清单；渲染失败保留旧产物并停止构建，不能继续打包旧视频。
4. 打包前检查实际复制的 renderer、源素材和视频是否对应同一来源指纹。原生 `installation.json` 与 `bundle.json` 均记录该指纹，MSIX 本身仍有整包 SHA256。

开发者修改动画后运行正常构建即可，也可单独运行：

```powershell
node tools/render-startup.mjs --ensure # 自动检查，需要时重新生成
node tools/render-startup.mjs --check  # 只检查；过期或损坏时返回非零
node tools/render-startup.mjs --force  # 强制重新生成
node --test tests/startup-generation.test.mjs
```

构建检查使用 Node.js 24+。只有重新生成需要 Playwright、Chromium/Chrome/Edge 和提供 `libx264` 的 FFmpeg，以及 FFprobe。脚本优先读取 `PLAYWRIGHT_MODULE`、`CHROMIUM_EXECUTABLE`、`FFMPEG_PATH`、`FFPROBE_PATH`；未指定时尝试已安装的 Playwright/浏览器和 PATH 中的编码工具。它不会下载依赖或改变用户安装环境；缺少依赖时构建失败并说明缺项。

提交动画修改时一并提交重新生成的视频、`startup.json` 和 `assets/PROVENANCE.json`。来源指纹用于识别输入版本，输出 SHA256 用于识别具体媒体；不同浏览器/编码器版本可能生成不同字节，生成环境记录在清单中，不承诺跨机器字节完全一致。发布新的原生安装包时仍须提升 `compatibility.json` 中的附加包版本，来源指纹不替代 Windows 包版本。

生成过程中有文件锁；异常中止后先确认对应进程已退出，再清理 `dist/startup-render.lock` 并重跑。失败现场与备份仅在本地 `dist/` 保留。生产运行时仍从当前包内的固定相对路径读取媒体，不去寻找旧构建目录或本机缓存。

## 验证与限制

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

2026-10-26 的 0.3.2.0 构建验证：8 项新增生成回归及全部 Node 回归通过，覆盖内容变化、同大小文件损坏、失败保留旧产物、替换失败回滚、并发和来源混用。实际重新生成了片头、循环与两张图片，FFprobe 确认 1080p/30 fps、156/270 帧且无音轨；新的媒体通过 Chrome 启动播放与原生 IPC 适配器回归。Windows PowerShell 5.1 下的完整源码构建、原生 MSIX 构建和包内来源/媒体哈希校验均通过。将渲染依赖路径设为不存在后，未变化产物仍能通过 `--ensure`。其后 0.3.2.0 已安装并从普通入口启动，原生日志记录到视频首帧、片头结束和五项就绪。

验证限制与后续工作：尚未录制原生窗口首次绘制，不能量化原生标志或工作区闪现；尚未完成本版完整进程启动与热重播的同条件性能对比、长帧和掉帧采样。原生托盘恢复、登录恢复、两种进入模式及新偏好的完整跨重启矩阵也未全部复测。相关浏览器/适配器回归不代替这些实机检查；历史 0.2.0.0 性能结果不代表本版。

2026-10-26 02:08（北京时间），0.3.3.0 已成功安装并从普通 AUMID 入口启动；原生日志确认早期 preload、遮罩、视频首帧、片头结束、五项就绪及进入工作区。用户确认移除两个底部按钮后的效果可提交。该修订的本地浏览器预览、原生 IPC 适配器回归、MSIX 构建及包内容校验通过；启动浏览器回归首次等待循环视频解码超时，增加失败诊断后按原检查复跑通过。实际安装结果与系统包注册一致；本轮没有重复执行量化性能与完整跨重启偏好矩阵。
