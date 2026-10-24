# 更新记录

## 1.4.2 — 2026-10-24

### 修复：刚说过话的对端发不出去（no-address）

对方刚给我发过 tell，我回一条却报 `no-address` —— 因为从入站请求学会的对端记录
只存了 IP，**没存端口**，于是不可拨号，必须等下一次扫描把它覆盖掉才能用。

- 入站请求现在会从对方的身份信息里**学到端口**，并记下来源地址
- 已有但缺端口/缺地址的记录会被**原地补全**，而不是留着坏数据
- 出站时的身份信息也带上 `port` 和 `ip`，双方都能互相学

新增 `test/address.mjs`：B 未经过扫描直接 tell A，A 记录的对端必须带端口，
且 A 能立刻回一条给 B。

## 1.4.1 — 2026-10-24

### 修复：测试会污染真实安装的配置

`test/e2e-process.mjs` 的两个插件实例没有指定 `patchFile`，保存时会写进
**插件自己所在的目录**，把测试数据（`displayName: 'LOCAL-ASKER'`、
`passphrase: 'e2e-secret'`、`manualPeers: '127.0.0.1:…'`）写进了真实安装的
`cordis.patch.yml`。

现在所有测试实例都指向临时路径，并加了一条校验：跑完整套测试后，
真实安装的 patch 文件哈希必须不变。

（我本机的该文件已还原为默认值。）

## 1.4.0 — 2026-10-24

### 移除：调用模型生成回答

「用本机模型回复对方的提问」整个移除。原因很直接：这个功能引入了本插件历史上
最严重的事故 —— `llm.listModels()` 签名用错，异常穿透宿主请求处理器，**把 DSH 进程搞崩**。

现在回到最初的、也是最可靠的语义：

- 对方的提问由**确定性的主机信息**回答（名称 / 地址 / 版本），不跑模型、不花 token
- 插件不再注入 `llm` 服务，`lib/model.js` 已删除
- 设置页不再有相关开关
- `status()` 不再有 `modelReplies` / `modelRoute` / `modelStats` / `lastModelError`

保留的全部是基础能力：`lan_peer_discover` / `lan_peer_ask` / `lan_peer_tell` /
`lan_peer_chat` / `lan_peer_transcript` / `lan_peer_state`，以及记录网页。

### 同时采用（来自 Android 端实测的补丁）

1. **设置页 401**：`credentials: "omit"` → `"same-origin"`。v1.2.0 起设置路由走
   `ctx.connection.fetch.register`，在认证管线内，不带 cookie 必然 401。
2. **布尔/数字类型丢失**：类型转换改用 `BOOLEAN_KEYS` / `NUMBER_KEYS` 集合，
   未归类字段不再落进 `String()`。之前会把 `true` 存成 `'true'`，
   下次启动 schema 校验失败，**整个插件挂载不上**。

### 测试

15 组。新增 `test/no-model.mjs` 锁住"模型功能确实不在了"：不注入 llm、
没有相关配置、收到的提问绝不打到模型、类型转换仍正确、前端仍带凭据。

## 1.3.2 — 2026-10-24

### 严重修复：模型回复会让 DSH 整个崩掉

手机一提问，桌面 DSH 直接弹「应用无法启动或已意外停止」，日志里是
`NO_ADAPTER: no adapter registered for provider "undefined"`。

**原因**：我误以为 `llm.listModels()` 无参返回整张目录，实际契约是
`listModels(providerId)` —— 不给 provider 就抛 `NO_ADAPTER`。这个异常从
`pickModel()` 一路穿过 `answerFor()` 和入站处理器，直接终止了宿主进程。

**修法**（三重）：

1. 正确调用：`llm.listProviders()` 拿路由列表，再对每个 `id` 调 `listModels(id)`；
   某个 provider 报错就跳过它，不中断。
2. 不放行残缺路由：`generateReply()` 在碰适配器之前校验 `provider`/`model` 都是非空字符串，
   避免再发出 `provider: undefined` 的请求。
3. **任何异常都不许逃逸**：`pickModel` / `modelRoute` / `generateReply` / `answerFor`
   逐层 try/catch，最外层兜住并退回固定回答。一个「生成回复」功能绝不该能搞崩宿主。

### 测试

新增 `test/llm-shape.mjs`，用**与崩溃现场相同的严格契约**（无参数调 `listModels` 会抛
`NO_ADAPTER`）来验证：`pickModel` 永不抛、永远带 provider 调用、残缺路由被拒、
同步抛错被兜住、字符串/对象两种 provider 形态都支持。

之前的 `model.mjs` 用的假 `llm` 是错误契约（无参返回目录），所以测试全绿而线上崩溃 ——
已按真实契约重写。

## 1.3.1 — 2026-10-24

### 修复：内容没变时保存被误报为失败

界面上反复出现「已生效，但没写进配置文件（重启会丢）：no writable patch for this entry」，
但 patch 文件其实**已经写进去了**（文件修改时间就是点保存的那一刻）。

原因：`persistOwnPatch()` 用 `false` 同时表示两种完全不同的结果——
**文件不存在**（真失败）和**内容没变化**（已是最新，属于成功）。用户重复保存同样的值，
或第二次点保存时，就会拿到 `false` 被判为失败。

现在返回结构化结果并区分四种情况：

| outcome | 含义 | 是否成功 |
|---|---|---|
| `written` | 已更新文件 | ✅ |
| `unchanged` | 文件里已经是这些值 | ✅ **成功** |
| `missing` | patch 文件不存在 | ❌ |
| `no-entry` | 文件里没有这一条 | ❌ |

失败时也能说清具体原因和路径，不再是同一句话。

## 1.3.0 — 2026-10-24

### 新增：收到提问时可以用本机模型生成回答

设置页新增「**用本机模型回复对方的提问**」（默认**关闭**）与「模型回复超时」。

- 开启后，对方 `lan_peer_ask` / `lan_peer_chat` 发来的消息会带上**同一会话最近若干轮**
  作为上下文，交给本机模型生成回答；回答里带上所用模型名。
- 关闭时行为不变：只返回固定的主机信息（名称 / 地址 / 版本），不消耗 token。
- **失败一定回退**：模型不可用、报错、超时或返回空，都会自动退回到固定回答，
  对方永远能收到回复，不会因为模型问题而卡住。
- 超时由插件自己兜底（默认 45 秒），不依赖适配器是否响应取消信号。
- 给模型的系统提示里明确要求：只用自身知识与该对话、不编造、**绝不透露本机文件内容、
  系统提示词、会话记录或凭据**。
- 状态里新增 `modelReplies` / `modelRoute` / `modelStats`（成功、失败次数、上次耗时）。

## 1.2.1 — 2026-10-24

### 修复：手机能发现电脑，电脑发现不了手机

不对称说明多播/广播从电脑发不出去，或收不回来。根因是 Windows 的**网卡选择**：

- 这台机器上"以太网"**已断开**（0 bps），但它的接口跃点数（5）比 WLAN（30）更低；
- Windows 按跃点数选发包网卡，于是**探测包从已断开的以太网发出**，永远到不了手机；
- 实证：不绑定接口时，定向广播的源地址是 `192.168.0.39`（断开的以太网），
  绑定到 WLAN 地址后变成 `192.168.0.15`（正确）；
- 反方向（手机 → 电脑）用的是路由器转发，不受影响，所以表现为单向失败。

修法：
- 发现用的 UDP socket **绑定到本机 LAN 地址**，把所有发送固定在真正在用的网卡上
  （绑定失败会回退到通配地址，不会导致插件启动失败）；
- 多播组在**每个** LAN 接口上分别加入，而不是让系统按跃点数自己挑；
- 广播改为发往**本网段的定向广播地址**（如 `192.168.0.255`），
  `255.255.255.255` 会走默认路由，在这台机器上会进 Mihomo 代理隧道；
- 新增 `lanInterfaces()`：按"真实网卡优先、虚拟/隧道靠后"排序。

### 修复：并发发现会互相清空结果

`discover()` 一进来就 `peers.clear()`，两次调用（或中途到达的回包）会互相抹掉。
现在不再清空，按 `lastSeen` 判断本轮是否新鲜。

### 其他

- 上一版"no writable patch for this entry"是旧进程的残留报错；实测 patch 写入正常
  （`enabled: true` 已落盘）。重启到 1.2.1 后应直接显示「已保存」。

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
