# dsh-lan-peers — LAN 邻居

让**同一内网**里装了本插件的 DSH 互相提问 / 互相告知。**默认关闭，平时完全不动作**——只有你明确让模型「问其他 DSH」或「告诉其他 DSH」时才会用。

## 一句话行为

| 场合 | 行为 |
|---|---|
| 你没提到别的 DSH | 插件不监听、不发包、模型不调用工具（工具描述里写明了这条约束） |
| 你说「问一下另一台 DSH 现在几点了」 | 模型先 `lan_peer_discover` 扫设备 → 只有一台就直接问；多台就**把清单交给你选** |
| 你说「把这段配置告诉书房的 DSH」 | 模型 `lan_peer_tell` 推过去 |
| 功能没开 | 工具会回答「功能当前关闭，去 设置 → 插件 → LAN 邻居 打开」 |

## 安装

本插件是普通的 DSH profile 插件包，需要**两台（或多台）设备都装**。

### 方式 A：从 GitHub 装（推荐）

在 DSH 的 profile 目录里执行（把 `<profile>` 换成你的 profile 名，桌面版是 `desktop`）：

```powershell
cd $env:USERPROFILE\.dsh\profiles\<profile>
git clone https://github.com/a5899/dsh-lan-peers.git node_modules/dsh-lan-peers
```

然后编辑同一个目录下的 `package.json`，加两处：

```jsonc
{
  "dependencies": {
    // …已有依赖…
    "dsh-lan-peers": "file:./node_modules/dsh-lan-peers"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …已有 bundle…
        "dsh-lan-peers"
      ]
    }
  }
}
```

### 方式 B：插件市场

如果装了 `dshmarket`，在 DSH 的**设置 → 插件**里也能安装/启停。

### 装完之后

1. **重启 DSH**（插件代码只在进程启动时 import，热更新不会加载新包）。
2. 打开 **设置 → 插件 → LAN 邻居**，勾选「启用内网互询」，点「保存并应用」。
3. 首次启用时 Windows 防火墙可能弹窗，**允许** UDP 45714 与 TCP 45715。
4. 两台设备用**同一个口令**（或都留空且在同一网段），然后互相点「扫描内网设备」。

> ⚠️ 三个前提缺一不可：**两端都装了本插件**、**两端都启用了**、**在同一内网**。
> 任何一端没开，另一端都扫不到它。

### 排障：如果按钮报错或页面空白

插件会把启动结果写进 `~/.dsh/plugins/dsh-lan-peers/diagnostics.json`：

- `routeInfo.kind` 为 `connection` → 路由注册正常
- 为 `failed` → 里面带 `error`，直接反映了原因
- `configProblems` 非空 → 宿主给的配置字段类型不对，插件已回退默认值

## 设置页

DSH **设置 → 插件 → 「LAN 邻居」**：

- **启用内网互询**（总开关）
- 本机显示名、口令（两端一致才能互相发现）、允许同网段免口令
- 监听端口 / 发现端口 / 多播地址
- 手动设备地址（`192.168.0.42:45715`，多播被交换机拦时兜底）
- **扫描内网设备**、每台设备的 **信任 / 取消信任 / 阻止**、发测试问题
- 状态（运行中、本机 LAN 地址、标识）、信任 / 阻止列表、最近收发

设置保存在 profile 的 `cordis.patch.yml` 的 `lan-peers` 条目里，重启后保留。

## 工具

| 工具 | 用途 |
|---|---|
| `lan_peer_discover` | 扫描内网设备（名称 / 地址 / 信任状态）。多台时会提示模型问你 |
| `lan_peer_ask` | 向某一台提问并取回回答 |
| `lan_peer_tell` | 把一条信息推给某一台 |
| `lan_peer_state` | 本机标识、地址、已知设备、信任列表、最近收发 |
| `lan_peer_chat` | 和某一台**多轮对话**，沿用同一个 conversation id 保持上下文 |
| `lan_peer_transcript` | 查看两台 DSH 之间聊过什么（会话列表 / 某个会话的完整记录） |

## 对话记录网页

每台设备的对端端口同时提供一个**网页版对话记录**，手机也能直接打开：

```
http://<这台电脑的内网IP>:45715/
```

- 设置页里「对话记录网页」一栏会把它显示成可点的链接。
- 页面列出所有会话，点进去看完整往来（谁问的、谁答的、什么时候）。
- 也能直接在网页上发起对话：选设备 → 输入 → 发送。
- **手机适配**：`viewport` 自适应、刘海安全区、单列布局、按钮 ≥44px 触控尺寸、
  长文本自动换行（不横向滚动）、跟随系统深色模式、忽略缩放。
  已在 390px / 320px / 1280px 三种宽度用真实 Chromium 渲染验证：无横向溢出、无控制台错误。
- 每 5 秒自动刷新一次。
- 网页本身只读 + 发消息，**不能**改设置或信任列表——那些在 DSH 设置页里做。

### 手机怎么连

1. 手机和电脑在**同一个 Wi-Fi / 内网**；
2. 电脑上打开 DSH 设置 → 插件 → LAN 邻居，确认「已启用」；
3. 手机浏览器输入 `http://<电脑内网IP>:45715/`（IP 在设置页的「状态」里能看到）。
4. Windows 防火墙：DSH 程序本身已有全端口入站放行规则，通常无需额外配置；
   若手机打不开，检查是否被第三方安全软件拦截。

## 记录存哪

所有往来记在 `~/.dsh/plugins/dsh-lan-peers/transcript.jsonl`（一行一条 JSON），
重启不丢、可被网页与工具读取。文件末尾即使被截断也只丢最后一条。

## 网络与安全

- **发现**：UDP 多播 `239.255.77.77:45714`（TTL=1，不跨路由器）+ 全局广播兜底 + 手动地址兜底。
- **对话**：TCP `45715`（可改）。对方通过 HTTP 调 `/peer/ask`、`/peer/tell`。
- **只限同一内网**：
  1. 多播 TTL=1，天然不跨子网；
  2. 无口令模式下，信任判断读的是**本次请求的 TCP 源地址**（不是对方自称的地址），并要求与
     本机 LAN 地址 `sameSubnet`；本机回环地址视为可信（设置页/本机测试用）。
  3. 不同口令的设备互相看不见（设备上报口令的 SHA-256 前 24 位，**口令本身不出本机**）。
- **信任的三个根**（任一满足即可，阻止列表永远优先）：
  1. **设置页显式「信任」**（`approved`，落盘持久）；
  2. **口令一致**——持有同一口令本身就是组成员证明，无需再手工批准；
  3. **无口令 + 允许同网段**（`allowSameSubnet`），且只认本次请求的源地址。
  口令不一致或未获信任的请求一律 403，并进待审列表。
- **不替你花 token、不翻你文件**：对方收到 ask 后由确定性事实接口回答（名称 / 地址 / 版本），不跑模型、不读文件、不读会话。需要推理的问题应由发起方在本机想清楚，再用 `tell` 发出。

> **对方收到提问后不会调用模型。** 早期版本曾提供「用本机模型回复对方的提问」，
> 因为会把宿主进程搞崩而**已在 1.4.0 移除**。现在被问的一方只用确定性的主机信息回答，
> 需要推理的内容请在本机想清楚后，用 `lan_peer_tell` 发过去。

### 首次运行要放行的端口

Windows 防火墙首次会弹框；放行：
- `45714/UDP` 入站（发现）
- `45715/TCP` 入站（对话）

命令（管理员 PowerShell）：

```powershell
New-NetFirewallRule -DisplayName "DSH LAN peers (discovery)" -Direction Inbound -Protocol UDP -LocalPort 45714 -Action Allow
New-NetFirewallRule -DisplayName "DSH LAN peers (peer)" -Direction Inbound -Protocol TCP -LocalPort 45715 -Action Allow
```

## 测试

```powershell
cd dsh-lan-peers     # 本包根目录
npm test             # 全部 10 组，不需要 DSH 在运行
node test/verify-installed.mjs   # 冒烟：插件能否注册全部路由
node test/render-viewer.mjs      # 可选：用本机 Chromium 在手机/桌面宽度截图到 test/shots/
```

> `test/verify-live-config.mjs` 会读取本机真实 profile 的配置，若 45714/45715 已被运行中的
> DSH 占用则直接跳过（这是预期行为）。

| 测试 | 覆盖 |
|---|---|
| `config.mjs` | 配置契约：坏类型/对象/NaN 都上报并回退，schema 不得用 `.volatile()` |
| `routes.mjs` | 设置路由注册形状 + 假 cordis 上下文（未声明 inject 即抛错） |
| `selftest.mjs` | 信任三个根 / 口令隔断 / ask-tell 往返 |
| `live.mjs` | 真 UDP 多播发现 |
| `tools.mjs` | 六个工具 + 网页兜底路由 |
| `e2e-process.mjs` | 跨进程端到端（另一个进程当对端） |
| `chat.mjs` | 对话、双向记录、落盘与重载、容错、网页与 API、手机布局要点 |
| `lan-reach.mjs` | 通过真实局域网 IP 访问网页 |
| `client-contract.mjs` / `client-render.mjs` | DSH 设置页契约与渲染 |

## 回滚

1. 撤销快照 `20261023-210515-6c64`（会把 `cordis.patch.yml` / `package.json` 一起还原）；或
2. 手动：删掉 `cordis.patch.yml` 末尾 `id: lan-peers` 那一段 +
   `profile/package.json` 里 `dsh-lan-peers` 的依赖与 bundles 条目 +
   `node_modules/dsh-lan-peers` 目录，重启 DSH。

本插件**没有**写 `dsh.profile.bundles` 之外的任何全局东西；身份与信任文件在
`~/.dsh/plugins/dsh-lan-peers/`，删掉即彻底重置。
