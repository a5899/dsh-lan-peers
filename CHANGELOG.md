# 更新记录

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
