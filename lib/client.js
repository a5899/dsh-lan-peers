/**
 * dsh-lan-peers — browser half (delivered through exports["./client"]).
 *
 * Registers a page under Settings → Plugins: master switch, identity, network,
 * passphrase, discovery, and the trust list. Every action calls the host half's
 * loopback route (`/api/lan-peers/*`); the browser never talks to a peer.
 *
 * Plain JavaScript (no JSX): React.createElement only. Colors use theme tokens
 * with plain fallbacks so the page follows the active theme.
 */
window.__ModuleLoader__.load({
  id: "dsh-lan-peers",
  factory: (require) => {
    const React = require("react");
    const { useCallback, useEffect, useRef, useState } = React;

    const NS = "lan-peers";
    const API = "/api/lan-peers/";

    // ── copy ──────────────────────────────────────────────────────────────
    const ZH = {
      title: "LAN 邻居",
      subtitle: "同一内网的 DSH 互相提问、互相告知。只有你明确要求时才启用。",
      enabled: "启用内网互询",
      enabledHint: "关闭时插件不监听任何端口，模型也不会主动联系其他设备。",
      name: "本机显示名",
      nameHint: "对方看到的设备名，留空则用「<主机名> 上的 DSH」。",
      listenPort: "监听端口",
      discoveryPort: "发现端口",
      group: "多播地址",
      passphrase: "口令",
      passphraseHint: "两端口令必须一致才能互相发现。留空则仅同一网段可互信（不加密）。",
      passphraseSet: "已设置（留空保持不变）",
      passphraseClear: "清除口令",
      allowSameSubnet: "允许同一网段免口令互信",
      manualPeers: "手动设备地址",
      manualPeersHint: "逗号分隔，例如 192.168.0.42:45715。多播被拦截时用它兜底。",
      timeout: "提问超时（毫秒）",
      maxChars: "单条最大字数",
      save: "保存并应用",
      saved: "已保存",
      saving: "保存中…",
      discover: "扫描内网设备",
      discovering: "扫描中…",
      peers: "发现的设备",
      peersEmpty: "还没发现设备。点「扫描内网设备」。",
      trust: "信任",
      untrust: "取消信任",
      block: "阻止",
      unblock: "解除阻止",
      test: "发测试问题",
      testing: "发送中…",
      status: "状态",
      running: "运行中",
      stopped: "未启用",
      localAddr: "本机地址",
      peerId: "本机标识",
      recent: "最近收发",
      recentEmpty: "暂无记录。",
      trustList: "信任 / 阻止列表",
      trustEmpty: "（空）",
      approvedTag: "已信任",
      blockedTag: "已阻止",
      untrustedTag: "未信任",
      needEnable: "先启用并保存，才能扫描内网。",
      errDisabled: "功能未启用。",
      err: "失败",
      netErr: "请求失败",
      configNote: "设置会写入 profile 的 cordis.patch.yml（lan-peers 条目），重启后保留。",
    };
    const EN = {
      title: "LAN peers",
      subtitle: "Let DSH installs on the same LAN ask and tell each other — only when you ask for it.",
      enabled: "Enable LAN peer communication",
      enabledHint: "While off, no ports are opened and the model never contacts another device.",
      name: "Display name",
      nameHint: "What peers see. Empty uses \"<hostname>'s DSH\".",
      listenPort: "Listen port",
      discoveryPort: "Discovery port",
      group: "Multicast group",
      passphrase: "Passphrase",
      passphraseHint: "Both ends must match. Empty means same-subnet trust only (unencrypted).",
      passphraseSet: "Already set (leave blank to keep)",
      passphraseClear: "Clear passphrase",
      allowSameSubnet: "Allow same-subnet peers without a passphrase",
      manualPeers: "Manual peer addresses",
      manualPeersHint: "Comma separated, e.g. 192.168.0.42:45715. Fallback when multicast is blocked.",
      timeout: "Ask timeout (ms)",
      maxChars: "Max characters per message",
      save: "Save and apply",
      saved: "Saved",
      saving: "Saving…",
      discover: "Scan LAN",
      discovering: "Scanning…",
      peers: "Discovered devices",
      peersEmpty: "Nothing found yet. Click \"Scan LAN\".",
      trust: "Trust",
      untrust: "Untrust",
      block: "Block",
      unblock: "Unblock",
      test: "Send test question",
      testing: "Sending…",
      status: "Status",
      running: "running",
      stopped: "not enabled",
      localAddr: "Local address",
      peerId: "Local id",
      recent: "Recent traffic",
      recentEmpty: "No traffic yet.",
      trustList: "Trust / block list",
      trustEmpty: "(empty)",
      approvedTag: "trusted",
      blockedTag: "blocked",
      untrustedTag: "untrusted",
      needEnable: "Enable and save first, then scan.",
      errDisabled: "Feature is not enabled.",
      err: "Failed",
      netErr: "Request failed",
      configNote: "Saved into the profile's cordis.patch.yml (lan-peers entry); survives restarts.",
    };
    const COPY = (navigator.language || "").toLowerCase().startsWith("zh") ? ZH : EN;

    // ── styles ────────────────────────────────────────────────────────────
    const css = `
.lp-wrap{display:flex;flex-direction:column;gap:14px;padding:4px 0 24px;font-size:13px;color:var(--dsw-alias-label-primary, inherit)}
.lp-head{display:flex;flex-direction:column;gap:4px}
.lp-title{font-size:15px;font-weight:600}
.lp-sub{font-size:12px;color:var(--dsw-alias-label-tertiary, #888);line-height:1.5}
.lp-card{border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1, transparent)}
.lp-cardTitle{font-size:13px;font-weight:600}
.lp-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.lp-label{min-width:150px;color:var(--dsw-alias-label-secondary, inherit);font-size:12px;flex:none}
.lp-input{height:28px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));background:var(--dsw-alias-bg-base, transparent);color:var(--dsw-alias-label-primary, inherit);border-radius:6px;padding:0 8px;font-size:12px;outline:none;box-sizing:border-box;min-width:160px;flex:1;max-width:360px}
.lp-input:focus{border-color:var(--dsw-alias-state-business-primary, #4a90d9)}
.lp-num{max-width:120px}
.lp-hint{font-size:11px;color:var(--dsw-alias-label-tertiary, #888);flex:1;min-width:180px;line-height:1.5}
.lp-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));background:var(--dsw-specific-tip, transparent);color:var(--dsw-alias-label-primary, inherit);border-radius:7px;height:27px;padding:0 12px;font-size:12px;white-space:nowrap}
.lp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15))}
.lp-btn:disabled{opacity:.45;cursor:default}
.lp-primary{background:var(--dsw-alias-state-business-primary, #4a90d9);border-color:transparent;color:#fff}
.lp-danger{color:var(--dsw-alias-state-error-primary, #e5484d);border-color:rgba(229,72,77,.45)}
.lp-ok{color:var(--dsw-alias-state-success-primary, #30a46c)}
.lp-err{color:var(--dsw-alias-state-error-primary, #e5484d)}
.lp-table{width:100%;border-collapse:collapse;font-size:12px}
.lp-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary, #888);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2));white-space:nowrap}
.lp-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12));vertical-align:middle}
.lp-tag{display:inline-block;font-size:11px;padding:0 6px;border-radius:999px;border:1px solid currentColor;line-height:16px}
.lp-tagOk{color:var(--dsw-alias-state-success-primary, #30a46c)}
.lp-tagBad{color:var(--dsw-alias-state-error-primary, #e5484d)}
.lp-tagIdle{color:var(--dsw-alias-label-tertiary, #888)}
.lp-mono{font-family:var(--dsw-font-family-mono, ui-monospace, Menlo, Consolas, monospace);font-size:11px;color:var(--dsw-alias-label-secondary, inherit)}
.lp-empty{color:var(--dsw-alias-label-tertiary, #888);font-size:12px;padding:8px 0}
.lp-msg{font-size:12px;min-height:18px}
`;
    const TAG_ID = "dsh-lan-peers/settings.css";
    if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG_ID)}]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-lan-peers";
      tag.dataset.pluginCss = TAG_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ── tiny fetch helper ─────────────────────────────────────────────────
    /**
     * Call the host half. The status code is carried into every failure, so a
     * missing host route (404) is distinguishable from a plugin that is merely
     * disabled — both used to surface as `unknown`.
     */
    async function api(path, method, body) {
      try {
        const res = await fetch(API + path, {
          method: method || "GET",
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          credentials: "omit",
        });
        const text = await res.text().catch(() => "");
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
        if (data && typeof data === "object") {
          if (data.ok !== true && typeof data.httpStatus !== "number") data.httpStatus = res.status;
          return data;
        }
        // Non-JSON answer: the route is served by something else (404 from the
        // /api bridge, or a host that has not loaded this plugin).
        return {
          ok: false,
          reason: res.status === 404 ? COPY.hostMissing : `http-${res.status}`,
          message: text.slice(0, 200) || `${COPY.httpStatus} ${res.status}`,
          httpStatus: res.status,
        };
      } catch (error) {
        return { ok: false, reason: COPY.netErr, message: String(error?.message ?? error) };
      }
    }

    // ── the page ──────────────────────────────────────────────────────────
    function LanPeersPage() {
      const [status, setStatus] = useState(null);
      const [draft, setDraft] = useState(null);
      const [passphrase, setPassphrase] = useState("");
      const [message, setMessage] = useState(null);
      const [messageOk, setMessageOk] = useState(true);
      const [busy, setBusy] = useState("");
      const mounted = useRef(true);

      const say = (text, ok) => {
        setMessage(text);
        setMessageOk(ok !== false);
      };

      const applyStatus = useCallback((next) => {
        if (!mounted.current) return;
        setStatus(next);
        setDraft((prev) => prev ?? fromStatus(next));
      }, []);

      const load = useCallback(async () => {
        const data = await api("status");
        if (data?.ok === false && data.error) {
          say(`${COPY.err}: ${data.error}`, false);
          return;
        }
        applyStatus(data);
      }, [applyStatus]);

      useEffect(() => {
        mounted.current = true;
        load();
        return () => {
          mounted.current = false;
        };
      }, [load]);

      const set = (key, value) => setDraft((prev) => ({ ...(prev || {}), [key]: value }));

      const save = async () => {
        if (!draft) return;
        setBusy("save");
        say(COPY.saving, true);
        const body = {
          enabled: draft.enabled,
          displayName: draft.displayName,
          listenPort: draft.listenPort,
          discoveryPort: draft.discoveryPort,
          multicastGroup: draft.multicastGroup,
          allowSameSubnet: draft.allowSameSubnet,
          manualPeers: draft.manualPeers,
          askTimeoutMs: draft.askTimeoutMs,
          maxMessageChars: draft.maxMessageChars,
        };
        if (passphrase !== "") body.passphrase = passphrase;
        const data = await api("settings", "POST", body);
        setBusy("");
        if (data?.ok) {
          setPassphrase("");
          setDraft(fromStatus(data));
          setStatus({ ...data.status, config: data.config ?? fromStatus(data) });
          say(COPY.saved, true);
        } else {
          say(`${COPY.err}: ${data?.reason || data?.message || "unknown"}`, false);
        }
      };

      const discover = async () => {
        setBusy("discover");
        say(COPY.discovering, true);
        const data = await api("discover", "POST", {});
        setBusy("");
        if (data?.ok) {
          setStatus((prev) => ({ ...(prev || {}), peers: data.peers }));
          say(`${COPY.peers}: ${data.peers.length}`, true);
        } else {
          say(data?.reason === "disabled" ? COPY.needEnable : `${COPY.err}: ${data?.reason || data?.message}`, false);
        }
      };

      const trustAction = async (action, id) => {
        const data = await api("trust", "POST", { action, id });
        if (data?.ok) setStatus(data.status);
        else say(`${COPY.err}: ${data?.reason}`, false);
      };

      const sendTest = async (peer) => {
        setBusy(`test:${peer.id}`);
        const data = await api("test", "POST", { target: peer.id, question: "版本" });
        setBusy("");
        if (data?.ok) say(`${peer.name}: ${data.answer?.text || JSON.stringify(data.answer)}`, true);
        else say(`${peer.name}: ${COPY.err} — ${data?.reason || data?.message}`, false);
      };

      const s = status;
      const d = draft;
      const peers = Array.isArray(s?.peers) ? s.peers : [];
      const recent = Array.isArray(s?.recent) ? s.recent : [];
      const approved = Array.isArray(s?.approved) ? s.approved : [];
      const blocked = Array.isArray(s?.blocked) ? s.blocked : [];

      return React.createElement(
        "div",
        { className: "lp-wrap", "data-lan-peers": "1" },
        React.createElement(
          "div",
          { className: "lp-head" },
          React.createElement("div", { className: "lp-title" }, COPY.title),
          React.createElement("div", { className: "lp-sub" }, COPY.subtitle),
        ),
        s === null
          ? React.createElement("div", { className: "lp-empty" }, "…")
          : React.createElement(
              React.Fragment,
              null,
              // master switch + identity
              React.createElement(
                "div",
                { className: "lp-card" },
                React.createElement(
                  "label",
                  { className: "lp-row" },
                  React.createElement("input", {
                    type: "checkbox",
                    checked: Boolean(d?.enabled),
                    onChange: (e) => set("enabled", e.target.checked),
                  }),
                  React.createElement("span", { style: { fontWeight: 600 } }, COPY.enabled),
                  React.createElement("span", { className: "lp-hint" }, COPY.enabledHint),
                ),
                React.createElement(
                  "div",
                  { className: "lp-row" },
                  React.createElement("span", { className: "lp-label" }, COPY.name),
                  React.createElement("input", {
                    className: "lp-input",
                    type: "text",
                    value: d?.displayName ?? "",
                    placeholder: s.name,
                    onChange: (e) => set("displayName", e.target.value),
                  }),
                  React.createElement("span", { className: "lp-hint" }, COPY.nameHint),
                ),
                React.createElement(
                  "div",
                  { className: "lp-row" },
                  React.createElement("span", { className: "lp-label" }, COPY.passphrase),
                  React.createElement("input", {
                    className: "lp-input",
                    type: "password",
                    value: passphrase,
                    placeholder: s.passphraseConfigured ? COPY.passphraseSet : "••••••",
                    onChange: (e) => setPassphrase(e.target.value),
                  }),
                  React.createElement("button", {
                    type: "button",
                    className: "lp-btn",
                    onClick: () => setPassphrase(" "),
                    title: COPY.passphraseClear,
                  }, COPY.passphraseClear),
                  React.createElement("span", { className: "lp-hint" }, COPY.passphraseHint),
                ),
                React.createElement(
                  "label",
                  { className: "lp-row" },
                  React.createElement("input", {
                    type: "checkbox",
                    checked: Boolean(d?.allowSameSubnet),
                    onChange: (e) => set("allowSameSubnet", e.target.checked),
                  }),
                  React.createElement("span", { className: "lp-hint" }, COPY.allowSameSubnet),
                ),
              ),
              // network
              React.createElement(
                "div",
                { className: "lp-card" },
                React.createElement("div", { className: "lp-cardTitle" }, "网络"),
                React.createElement(
                  "div",
                  { className: "lp-row" },
                  React.createElement("span", { className: "lp-label" }, COPY.listenPort),
                  React.createElement("input", {
                    className: "lp-input lp-num",
                    type: "number",
                    min: 0,
                    max: 65535,
                    value: d?.listenPort ?? 45715,
                    onChange: (e) => set("listenPort", Number(e.target.value)),
                  }),
                  React.createElement("span", { className: "lp-label" }, COPY.discoveryPort),
                  React.createElement("input", {
                    className: "lp-input lp-num",
                    type: "number",
                    min: 1024,
                    max: 65535,
                    value: d?.discoveryPort ?? 45714,
                    onChange: (e) => set("discoveryPort", Number(e.target.value)),
                  }),
                ),
                React.createElement(
                  "div",
                  { className: "lp-row" },
                  React.createElement("span", { className: "lp-label" }, COPY.group),
                  React.createElement("input", {
                    className: "lp-input",
                    type: "text",
                    value: d?.multicastGroup ?? "239.255.77.77",
                    onChange: (e) => set("multicastGroup", e.target.value),
                  }),
                ),
                React.createElement(
                  "div",
                  { className: "lp-row" },
                  React.createElement("span", { className: "lp-label" }, COPY.manualPeers),
                  React.createElement("input", {
                    className: "lp-input",
                    type: "text",
                    value: d?.manualPeers ?? "",
                    placeholder: "192.168.0.42:45715",
                    onChange: (e) => set("manualPeers", e.target.value),
                  }),
                  React.createElement("span", { className: "lp-hint" }, COPY.manualPeersHint),
                ),
                React.createElement(
                  "div",
                  { className: "lp-row" },
                  React.createElement("span", { className: "lp-label" }, COPY.timeout),
                  React.createElement("input", {
                    className: "lp-input lp-num",
                    type: "number",
                    min: 1000,
                    max: 600000,
                    step: 1000,
                    value: d?.askTimeoutMs ?? 120000,
                    onChange: (e) => set("askTimeoutMs", Number(e.target.value)),
                  }),
                  React.createElement("span", { className: "lp-label" }, COPY.maxChars),
                  React.createElement("input", {
                    className: "lp-input lp-num",
                    type: "number",
                    min: 200,
                    max: 200000,
                    step: 100,
                    value: d?.maxMessageChars ?? 8000,
                    onChange: (e) => set("maxMessageChars", Number(e.target.value)),
                  }),
                ),
              ),
              // actions
              React.createElement(
                "div",
                { className: "lp-row" },
                React.createElement("button", {
                  type: "button",
                  className: "lp-btn lp-primary",
                  disabled: busy === "save" || d === null,
                  onClick: save,
                }, busy === "save" ? COPY.saving : COPY.save),
                React.createElement("button", {
                  type: "button",
                  className: "lp-btn",
                  disabled: busy === "discover" || !s.enabled,
                  onClick: discover,
                }, busy === "discover" ? COPY.discovering : COPY.discover),
                React.createElement("span", {
                  className: `lp-msg ${messageOk ? "lp-ok" : "lp-err"}`,
                }, message ?? ""),
              ),
              // status strip
              React.createElement(
                "div",
                { className: "lp-card" },
                React.createElement("div", { className: "lp-cardTitle" }, COPY.status),
                React.createElement(
                  "div",
                  { className: "lp-row" },
                  React.createElement("span", { className: "lp-mono" },
                    `${s.enabled ? (s.started ? COPY.running : "…") : COPY.stopped} · ${COPY.localAddr}: ${s.localAddress || "—"} · :${s.listenPort ?? "—"}`),
                ),
                React.createElement("div", { className: "lp-row" },
                  React.createElement("span", { className: "lp-label" }, COPY.peerId),
                  React.createElement("span", { className: "lp-mono" }, s.id || "—"),
                ),
                React.createElement("div", { className: "lp-hint" }, COPY.configNote),
              ),
              // peers
              React.createElement(
                "div",
                { className: "lp-card" },
                React.createElement("div", { className: "lp-cardTitle" }, COPY.peers),
                peers.length === 0
                  ? React.createElement("div", { className: "lp-empty" }, s.enabled ? COPY.peersEmpty : COPY.needEnable)
                  : React.createElement(
                      "table",
                      { className: "lp-table" },
                      React.createElement("thead", null,
                        React.createElement("tr", null,
                          React.createElement("th", null, "名称"),
                          React.createElement("th", null, "地址"),
                          React.createElement("th", null, "标识"),
                          React.createElement("th", null, "状态"),
                          React.createElement("th", null, ""),
                        ),
                      ),
                      React.createElement("tbody", null,
                        peers.map((p) => React.createElement("tr", { key: p.id },
                          React.createElement("td", null, p.name),
                          React.createElement("td", { className: "lp-mono" }, `${p.address || "?"}:${p.httpPort || "?"}`),
                          React.createElement("td", { className: "lp-mono" }, String(p.id).slice(0, 8)),
                          React.createElement("td", null,
                            React.createElement("span", {
                              className: `lp-tag ${p.blocked ? "lp-tagBad" : p.trusted ? "lp-tagOk" : "lp-tagIdle"}`,
                            }, p.blocked ? COPY.blockedTag : p.trusted ? COPY.approvedTag : COPY.untrustedTag),
                          ),
                          React.createElement("td", null,
                            React.createElement("button", {
                              type: "button",
                              className: "lp-btn",
                              disabled: !p.trusted || busy === `test:${p.id}`,
                              onClick: () => sendTest(p),
                            }, busy === `test:${p.id}` ? COPY.testing : COPY.test),
                            " ",
                            p.blocked
                              ? React.createElement("button", {
                                  type: "button", className: "lp-btn", onClick: () => trustAction("unblock", p.id),
                                }, COPY.unblock)
                              : React.createElement(React.Fragment, null,
                                  p.trusted
                                    ? React.createElement("button", {
                                        type: "button", className: "lp-btn", onClick: () => trustAction("untrust", p.id),
                                      }, COPY.untrust)
                                    : React.createElement("button", {
                                        type: "button", className: "lp-btn lp-primary", onClick: () => trustAction("trust", p.id),
                                      }, COPY.trust),
                                  React.createElement("button", {
                                    type: "button", className: "lp-btn lp-danger", onClick: () => trustAction("block", p.id),
                                  }, COPY.block),
                                ),
                          ),
                        )),
                      ),
                    ),
              ),
              // trust / block list
              React.createElement(
                "div",
                { className: "lp-card" },
                React.createElement("div", { className: "lp-cardTitle" }, COPY.trustList),
                React.createElement("div", { className: "lp-row" },
                  React.createElement("span", { className: "lp-label" }, COPY.approvedTag),
                  React.createElement("span", { className: "lp-mono" }, approved.length ? approved.join(", ") : COPY.trustEmpty),
                ),
                React.createElement("div", { className: "lp-row" },
                  React.createElement("span", { className: "lp-label" }, COPY.blockedTag),
                  React.createElement("span", { className: "lp-mono" }, blocked.length ? blocked.join(", ") : COPY.trustEmpty),
                ),
              ),
              // recent traffic
              React.createElement(
                "div",
                { className: "lp-card" },
                React.createElement("div", { className: "lp-cardTitle" }, COPY.recent),
                recent.length === 0
                  ? React.createElement("div", { className: "lp-empty" }, COPY.recentEmpty)
                  : React.createElement(
                      "table",
                      { className: "lp-table" },
                      React.createElement("tbody", null,
                        recent.map((r, i) => React.createElement("tr", { key: i },
                          React.createElement("td", { className: "lp-mono" }, new Date(r.at).toLocaleTimeString()),
                          React.createElement("td", null, `${r.direction === "in" ? "↓" : "↑"} ${r.kind}`),
                          React.createElement("td", null, r.peer?.name || "—"),
                          React.createElement("td", { className: "lp-mono" }, r.detail),
                        )),
                      ),
                    ),
              ),
            ),
      );
    }

    /** Project a status payload into the editable draft. */
    function fromStatus(status) {
      const cfg = (status && status.config) || status || {};
      return {
        enabled: Boolean(cfg.enabled),
        displayName: String(cfg.displayName ?? ""),
        listenPort: Number(cfg.listenPort ?? 45715),
        discoveryPort: Number(cfg.discoveryPort ?? 45714),
        multicastGroup: String(cfg.multicastGroup ?? "239.255.77.77"),
        allowSameSubnet: cfg.allowSameSubnet !== false,
        manualPeers: String(cfg.manualPeers ?? ""),
        askTimeoutMs: Number(cfg.askTimeoutMs ?? 120000),
        maxMessageChars: Number(cfg.maxMessageChars ?? 8000),
        passphraseSet: Boolean(cfg.passphraseSet),
      };
    }

    return {
      name: NS,
      inject: ["slots"],
      apply(ctx) {
        try {
          ctx.slots.inject("plugins.item", () =>
            ctx.slots.register(
              {
                name: "plugins.item",
                id: "lan-peers",
                order: 90,
                label: () => COPY.title,
              },
              LanPeersPage,
            ),
          );
        } catch (error) {
          console.warn("[dsh-lan-peers] settings page registration failed:", String(error?.message ?? error));
        }
      },
    };
  },
});
