# 内娱弹幕过滤器（Danmaku Filter）

一个支持 **Chrome / Edge / Firefox / 360 浏览器** 的弹幕过滤插件。内置「内娱人气前 300 名明星」名单，支持：

- ✅ **多人名屏蔽**：勾选多名明星，含其名字的弹幕自动隐藏。
- ✅ **一键反选（仅留一人）**：只保留某一位明星的弹幕，其余 300 人全部屏蔽。
- ✅ **实时过滤**：基于 `MutationObserver` + 定时兜底扫描，新弹幕即时处理。
- ✅ **全局开关 / 单站开关**：可整体关闭，也可仅在某一个网站关闭。
- ✅ **搜索**：300 人名单内快速检索。

> 名单为**人工整理的「人气前 300」种子数据**（见 `data/celebrities.json`），可按需增删；顺序即展示排名，非官方榜单。

---

## 目录结构

```
danmaku-filter/
├── manifest.json            # MV3 清单（含 Firefox gecko 配置）
├── data/
│   └── celebrities.json     # 内娱人气前 300 明星名单（可编辑）
├── popup/
│   ├── popup.html           # 设置面板
│   ├── popup.css
│   └── popup.js
├── content/
│   ├── content.js           # DOM 实时屏蔽（直播等 DOM 弹幕）
│   ├── inject.js            # 主世界注入：拦截 B 站弹幕数据接口（seg.so / list.so）
│   └── content.css
├── background/
│   └── background.js        # service worker（默认设置 + 注入）
├── icons/
│   ├── icon16.png / icon48.png / icon128.png
└── README.md
```

---

## 安装方法

### Chrome
1. 打开 `chrome://extensions/`
2. 右上角开启 **开发者模式（Developer mode）**
3. 点击 **加载已解压的扩展程序（Load unpacked）**
4. 选择本目录 `danmaku-filter/`

### Edge
1. 打开 `edge://extensions/`
2. 左下角开启 **开发人员模式**
3. 点击 **加载解压缩的扩展**
4. 选择本目录

### Firefox
1. 打开 `about:debugging#/runtime/this-firefox`
2. 点击 **临时载入附加组件（Load Temporary Add-on）**
3. 选择本目录下的 `manifest.json`
> 临时加载在重启浏览器后失效；如需常驻，请打包为 `.xpi` 后签名安装（或使用开发者账户）。

### 360 浏览器（360 安全浏览器 / 360 极速浏览器）
1. 打开扩展管理页（通常在菜单 → 扩展管理 / 或地址栏输入扩展页入口）
2. 开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择本目录
> 360 极速浏览器基于 Chromium，对 Chrome 扩展兼容性最好。

---

## 使用方法

1. 点击浏览器工具栏的 **弹** 图标打开设置面板。
2. **搜索** 框输入明星名字快速定位。
3. 勾选要屏蔽的明星（或点 **全选**），含其名字的弹幕会在已打开的视频页即时消失。
4. 点 **反选（仅留一人）**，在弹窗里点选那一位「要保留」的人 → 其余 299 人全部屏蔽。
5. 顶部开关可 **整体启用 / 停用**；面板底部可针对「当前网站」单独关闭过滤。

---

## 工作原理与已知限制

- **B 站主站视频弹幕（Canvas 渲染）—— 拦截点尽量靠前（事前阻断，而非事后隐藏）**：
  设计目标：弹幕在「进入播放器渲染流程之前」就被判断并丢弃，从而**不依赖具体渲染方式**（Canvas / Worker / 重绘机制），也不受播放器改版切换渲染链路的影响。架构：

  ```
  弹幕请求(fetch/XHR)
       ↓ 第 1 层 · 数据层：拦截 seg.so(protobuf) / list.so(XML)，解析前整条剔除含屏蔽词弹幕
  弹幕解析 / 入队（播放器内部 DanmakuEngine.add 等）
       ↓ 第 2 层 · 逻辑层(best-effort)：hook 播放器 add/append，在弹幕进入渲染系统前判断并丢弃
  渲染（Worker / Canvas）
       ↓ 第 3 层 · 兜底：Worker 内 fetch+fillText、主线程 Canvas fillText，仅处理前两层的极少数漏网
  ```

  1. **第 1 层 数据层（主线程 + Worker 内）**：`inject.js` 在页面主世界用 **getter/setter 自修复**地包装 `fetch` / `XMLHttpRequest`，拦截 `api.*.com/.../dm/.../seg.so`（protobuf，文本在 `DanmakuElem.content` field 7）与 `list.so`（XML），在弹幕**绘制前**整条移除含屏蔽词的弹幕。
  2. **第 2 层 逻辑层（best-effort）**：轮询 `window.player.danmaku` 等弹幕引擎对象，hook 其 `add`/`append`/`send` 等方法，在弹幕进入渲染系统前按同一判定逻辑丢弃。命中后弹幕根本不会进入渲染 / Worker。
  3. **第 3 层 兜底（渲染层）**：`inject.js` **Hook `CanvasRenderingContext2D` 与 `OffscreenCanvasRenderingContext2D` 的 `fillText`/`strokeText`**（主线程 + 经重写的 `window.Worker` 注入到 Worker 全局）。仅用于处理前两层的极少数漏网路径；任何异常均回退原始 Worker，不影响网站。
  - 判定逻辑集中在 `judge(text)`，与「如何渲染」解耦；未来若接入更丰富的语义/剧透判断，只需替换该函数，无需改动渲染层。
- **直播 / DOM 弹幕**：由 `content/content.js` 基于 **DOM 文本子串匹配**（去空格/标点/大小写归一化）实时隐藏，配合 `MutationObserver` + 定时兜底扫描。
- **已知限制**：
  - 极少数完全自绘、不经标准接口下发弹幕数据的播放器，仍可能无法拦截。
  - 各站弹幕 DOM 选择器（见 `content.js` 的 `SITE_SELECTORS`）随站点改版可能失效，需同步更新。
  - 名单为静态种子；如需同步最新人气榜，可定期更新 `data/celebrities.json` 后重新加载扩展。

---

## 自定义名单

直接编辑 `data/celebrities.json`（JSON 字符串数组，顺序即排名），保存后重新加载扩展即可生效。

---

## 免责声明

- 本软件以 **MIT 协议**开源，仅供**个人学习与研究**使用。使用本工具修改第三方网站弹幕展示属用户自身行为，**风险自担**。
- 内置明星名单为**人工整理的种子数据，非任何官方 / 第三方权威榜单**，顺序仅代表整理时的主观排序。
- 本工具与 **Bilibili、斗鱼、虎牙、爱奇艺、优酷、腾讯视频、快手、微博、抖音、今日头条** 等任何平台，以及名单中的任何艺人**均无关联、无合作、无授权关系**；相关平台名称仅用于描述本工具所作用的网站。
- 在部分平台（如 B 站主站视频）上，本工具通过拦截弹幕数据接口实现过滤，该行为可能违反对应平台的服务条款；由此产生的任何后果由使用者自行承担。
- 本软件按"现状"提供，作者不对适用性、可靠性及任何后果作出保证。
