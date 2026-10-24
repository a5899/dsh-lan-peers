# 更新记录

## 1.2.0 — 2026-10-24

### 修复：设置保存后重启丢失（感谢手机端 DSH 的排查）

设置只改内存、不写盘，重启即丢。三个原因叠加：

1. `ctx.loader` 在未声明 inject 的上下文里抛 `cannot get property "loader" without inject`；
2. `loader.entries()` 是 **Generator**，对它调 `.find()` 会抛 `TypeError`，异常被外层 catch 吞掉；
3. 即便拿到 entry，bundle 的条目挂在 loader **根 fiber** 下，插件 fiber 向上并不连通；
   而且 `id: lan-peers` 这一行在**插件自己的** patch 文件里
   (`<profile>/node_modules/dsh-lan-peers/cordis.patch.yml`)，改写 profile 根 patch 等于没写。

现在：loader 不可达时，**直接原子重写插件自己的 patch**（tmp + rename），
只替换传入的键、其余行逐字节保留（注释和引号风格都不动）。
写回前用 YAML 解析器**回读校验**，校验不过就拒绝提交并报错。

### 修复：界面谎报"已保存"

- 保存结果现在真实反映是否落盘：失败时 `status.persisted === false`，
  页面显示「已生效，但没写进配置文件（重启会丢）：<原因>」，不再显示"已保存"。
- 路由响应不再用 `service.status()` 覆盖 `reconfigure()` 的持久化结论。

### 修复：状态里的版本号

`version` 原先硬编码 `"1.0.0"`，连续两个版本都没跟上。现在从 `package.json` 读取。

### 开发

- 修复测试会写进真实 `cordis.patch.yml` 的问题：所有测试使用隔离路径，
  并加了"失败写入不得触碰真实安装"的断言。

## 1.1.1 — 2026-10-24

### 修复

- **设置页路由一直注册不上**：cordis 里 `ctx.inject([...], fn)` 不是「等某个服务出现再回调」，
  而是把 `fn` 当成一个带依赖的子插件挂载；依赖一直不满足时子插件**永不激活、不报错**，
  于是每次都静默退到 `/api` 下永远无效的 `webServer` 兜底，按钮一直 404。
  正确做法是把 `connection` 写进**插件模块自己的顶层 `inject`**，让加载器在服务就绪后才启动插件。
- 注册失败时记录真实原因（`connection-missing-fetch` 会带上实际形状），不再伪装成兜底。

## 1.1.0 — 2026-10-24

### 新增

- **跨设备对话**：`lan_peer_chat` 支持多轮对话，用同一个 `conversation` id 保持上下文。
- **对话记录**：所有 ask / tell / answer 双向落盘到 `transcript.jsonl`，重启不丢；
  文件末尾即使被截断也只丢最后一条。
- **网页版记录** `http://<本机内网IP>:45715/`：独立的 HTML 页面，不依赖 DSH 的登录态，
  手机浏览器直接打开。可看会话列表、完整往来，也能选设备直接发消息，5 秒自动刷新。
- **查看记录的工具**：`lan_peer_transcript`，可列会话或读某个会话的完整记录。
- 设置页新增「对话记录网页」卡片，给出可点的链接。

### 手机适配

- 移动优先单列布局、`device-width` viewport、刘海安全区、≥44px 触控尺寸。
- 长文本自动换行，不产生横向滚动；跟随系统深色模式。
- 内联 favicon，浏览器控制台无报错。
- 已在真实 Chromium 的 320px / 390px / 1280px 三种宽度验证：无横向溢出、零控制台错误。

### 修复

- **配置读取**：原先给所有字段加了 `.volatile()`，宿主传给 `apply()` 的是引用对象，
  导致端口变成 `NaN`、多播地址变成 `"[object Object]"`。改为普通字段并逐项做类型校验，
  非法值上报并回退默认值（`configProblems`）。
- **设置路由 404**：`/api` 下由 Connection 按**精确路径**匹配，`prefix` 路由永不被调用。
  改用 `ctx.connection.fetch.register`。
- **未声明 inject 访问服务**：直接读 `ctx.connection` / `ctx.webServer` 会抛
  `cannot get property "x" without inject` 并中断注册。现在只通过 `ctx.inject([...])` 获取。
- 启动结果写入 `diagnostics.json`（`startStage` / `configProblems` / `routeInfo`），
  便于在无法看到日志时定位问题。

## 1.0.0 — 2026-10-23

- 首个版本：UDP 多播发现、TCP 对端接口、同网段信任门、口令隔离。
- 工具：`lan_peer_discover` / `lan_peer_ask` / `lan_peer_tell` / `lan_peer_state`。
- DSH 设置页「LAN 邻居」：开关、显示名、口令、端口、手动地址、信任/阻止、扫描与测试。
