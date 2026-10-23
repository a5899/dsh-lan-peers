# dsh-lan-peers — LAN 邻居

让**同一内网**里装了本插件的 DSH 互相提问 / 互相告知。**默认关闭，平时完全不动作**——只有你明确让模型「问其他 DSH」或「告诉其他 DSH」时才会用。

## 一句话行为

| 场合 | 行为 |
|---|---|
| 你没提到别的 DSH | 插件不监听、不发包、模型不调用工具（工具描述里写明了这条约束） |
| 你说「问一下另一台 DSH 现在几点了」 | 模型先 `lan_peer_discover` 扫设备 → 只有一台就直接问；多台就**把清单交给你选** |
| 你说「把这段配置告诉书房的 DSH」 | 模型 `lan_peer_tell` 推过去 |
| 功能没开 | 工具会回答「功能当前关闭，去 设置 → 插件 → LAN 邻居 打开」 |

## 安装位置（本机已装）

```
C:\Users\a5093\.dsh\profiles\desktop\node_modules\dsh-lan-peers\
```

`profile/cordis.patch.yml` 末尾有 `id: lan-peers` 条目（`enabled: false` 起步）。
**装完要重启 DSH** 才会加载（DSH 的插件代码只在进程启动时 import）。

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
cd C:\Users\a5093\Documents\deepseek-harness\default-workspace\lan-peers
node test/selftest.mjs       # 信任门（三个根）/ 口令 / 询问-告知往返（两个实例）
node test/live.mjs           # 真 UDP 多播发现 + 口令隔断
node test/tools.mjs          # 四个工具 + 设置路由（跨站拒绝、阻止、禁用态提示）
node test/e2e-process.mjs    # 跨进程端到端：另起一个进程当对端，真的问/真的告知
node test/client-contract.mjs # 客户端契约（__ModuleLoader__ / plugins.item / 标签函数）
node test/client-render.mjs   # 设置页在假 React 下渲染
```

全部 6 组通过（`npm test` 可一次跑完）。

## 回滚

1. 撤销快照 `20261023-210515-6c64`（会把 `cordis.patch.yml` / `package.json` 一起还原）；或
2. 手动：删掉 `cordis.patch.yml` 末尾 `id: lan-peers` 那一段 +
   `profile/package.json` 里 `dsh-lan-peers` 的依赖与 bundles 条目 +
   `node_modules/dsh-lan-peers` 目录，重启 DSH。

本插件**没有**写 `dsh.profile.bundles` 之外的任何全局东西；身份与信任文件在
`~/.dsh/plugins/dsh-lan-peers/`，删掉即彻底重置。
