# 开屏预加载与缓存

原生附加包 0.3.1.0 已改用早期 preload、本地文件视频和真实阶段检测，并完成普通启动与重播的功能验证，见 [启动进度说明](STARTUP-READINESS.zh-CN.md)。以下缓存接口仍供便携 CDP 启动器使用；历史性能结果不能当作新原生播放器的验收。

此改动将媒体传输、解码准备和首次布局移到可见动画之前，并复用当前窗口的媒体供重播。素材、1080p 分辨率、SVG 签名与人物描边保持不变；不引入逐像素 Canvas 处理。

## 行为与资源取舍

- 素材按项分块传入渲染进程，每块最多 256 KiB 字符，避免把全部 base64 素材放进一次 JavaScript 编译。视频转换为窗口内 Blob URL；缓存摘要同时覆盖素材与播放器代码。
- 媒体准备与主题样式安装并行，首次可见播放在主题安装及验证之后开始。媒体就绪、图片解码与隐藏布局均有等待上限；失败媒体使用静态回退，减少动态效果模式不准备视频。
- 预加载的两个视频从帧零开始，显色时不重新 seek；描边同步仅调整小幅播放速率。开屏结束暂停播放与动画，保留一个隐藏场景和媒体解码缓存；重播复用视频元素，不重新传输素材。
- 缓存会占用窗口内存，换取重播时减少传输与解码准备；这不是零成本的常驻资源。禁用/恢复主题会取消进行中的准备、移除场景和视频源、撤销 Blob URL。窗口销毁时由 Chromium 释放窗口资源。
- Esc、双击、连续两次空格/Enter、焦点恢复与真实启动就绪门控继续有效。准备或播放过程中恢复主题也不会由迟到回调重新显示开屏。

## 共用调用接口

`engine/opening-client.mjs` 可由现有 CDP 启动器及可选原生集成共用，不依赖原生集成文件。

```js
import {prepareOpening, showOpening, releaseOpening} from './engine/opening-client.mjs';

// evaluate(code, options) must resolve the renderer's promise and return its value.
const evaluate = (code, options) => session.evaluate(code, options);
const prepared = await prepareOpening(evaluate, assets);
await showOpening(evaluate, assets, {replay: true}, prepared);
await releaseOpening(evaluate);
```

同一窗口复用稳定的 `evaluate` 函数；素材对象应在该会话中保持不可变。调用方单独预加载后，应将准备结果作为 `showOpening` 的第四个参数传回，保留这次操作的取消状态；显示前会在渲染进程中核对准备时的取消代次与播放器版本。原有三个参数的调用继续自动准备并播放。准备和显示的调用会传入 `{timeoutMs: 15000}`，供 CDP 保留媒体等待余量；Electron 的 `executeJavaScript` 包装可忽略该选项，但必须等待渲染端 Promise。普通 CDP 命令仍使用原有 3 秒超时。直接序列化渲染函数的离线预览先调用 `prepareOpening`，再调用 `showOpening`。

## 验证

无浏览器回归：

```powershell
Get-ChildItem tests -Filter '*.test.mjs' | ForEach-Object { node $_.FullName }
node build-preview.mjs
```

真实媒体回归需一个已安装的 Playwright 包和 Chromium。环境变量可省略，默认分别使用 `playwright` 与其管理的浏览器。浏览器以独立 headless profile 启动，不连接当前 Codex 会话。

```powershell
$env:PLAYWRIGHT_MODULE = '<absolute path to playwright package>'
$env:CHROMIUM_EXECUTABLE = '<absolute path to Chrome or Chromium executable>'
node tests/opening.browser.mjs
```

浏览器回归检查并发播放所有权、1920×1080 解码、SVG 素材、显色连续性、跳过与焦点、重播缓存、真实就绪门控、恢复清理、减少动态效果、坏媒体回退及恢复竞态；同时打印准备耗时、首播传输次数、单次表达式大小和重播表达式大小。时间仅代表该次隔离浏览器运行，不代表真实客户端启动耗时。

2026-10-25 在 Windows 上使用独立 headless Chrome 156.0.8078.47，以上浏览器回归、全部 7 个 `*.test.mjs`、离线预览构建及其实际加载/重播检查通过。该次浏览器准备耗时 183 ms；首播 73 次调用，最大表达式 262343 字符；重播 3 次调用，最大 422 字符。这组数据没有旧版同条件耗时基线，不能换算为性能提升百分比。

同日在 Windows 11 x64（build 26200）、官方 Codex `26.1021.3705.0` 上安装与原生集成组合的 `0.2.0.0` 包，并从普通入口启动。实机确认菜单与标题栏重播均能显示开场动画，主题关闭/启用后可再次播放，启动播放偏好可关闭并恢复。这组功能检查本身未采集性能数据。后续同日已在真实官方打包测试进程中，以相同素材、窗口和 DPR 交错比较旧 renderer 与 81b4901，共 12 次：释放媒体后触发到可见的中位数为 574.1 → 832.2 ms；热重播为 528.3 → 170.6 ms；可见最大帧间隔中位数分别为 140.1 → 28.7 ms、141.2 → 25.7 ms。新版 6 次均未出现超过 50 ms 的可见间隔，但首次显示更慢约 258 ms，描边掉帧并非全部改善。这不是清空系统缓存后的应用冷启动，也不证明整体无回退。该历史对比不包含本次 0.3.0.0 预渲染播放器。

这些结果验证资源生命周期、优化路径及实机基本播放，不等于真实 Codex 首启/重播的主观流畅度验收，也不能据此宣布所有卡顿已解决。GPU/驱动差异、冷文件缓存与真实工作负载下的表现仍须在目标客户端单独测量。
