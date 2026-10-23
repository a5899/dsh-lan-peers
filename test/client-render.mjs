/**
 * Render smoke test for the settings page: evaluates lib/client.js inside a fake
 * `window.__ModuleLoader__` with a tiny React stand-in, so a runtime error in
 * the page surfaces here instead of in the DSH GUI.
 *
 * The React stand-in executes function components (calling hooks in order) and
 * records the element tree; it is not a real renderer.
 */
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// --- tiny React stand-in -------------------------------------------------
const hookStates = [];
let hookCursor = 0;
const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat() };
  },
  Fragment: "__FRAGMENT__",
  useState(initial) {
    const i = hookCursor++;
    if (!(i in hookStates)) hookStates[i] = initial;
    const setter = (v) => { hookStates[i] = typeof v === "function" ? v(hookStates[i]) : v; };
    return [hookStates[i], setter];
  },
  useEffect(fn) {
    hookCursor++;
    pendingEffects.push(fn);
    return undefined;
  },
  useRef(initial) {
    const i = hookCursor++;
    if (!(i in hookStates)) hookStates[i] = { current: initial };
    return hookStates[i];
  },
  useCallback(fn) {
    hookCursor++;
    return fn;
  },
};
const pendingEffects = [];

// --- fake loader ---------------------------------------------------------
let registered = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      const exported = factory((name) => {
        if (name === "react") return React;
        throw new Error(`unexpected require(${name})`);
      });
      registered = { id, exported };
    },
  },
};
Object.defineProperty(globalThis, "navigator", { value: { language: "zh-CN" }, configurable: true, writable: true });
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: "" }),
  head: { appendChild() {} },
};
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, enabled: false, peers: [], recent: [], approved: [], blocked: [] }) });

// --- evaluate ------------------------------------------------------------
// The file is a classic script that calls window.__ModuleLoader__.load.
new Function(src)();

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label} ${extra}`); }
};

check("client module registered", registered !== null && registered.id === "dsh-lan-peers");

const exported = registered?.exported ?? {};
check("exports an inject list containing slots", Array.isArray(exported.inject) && exported.inject.includes("slots"), JSON.stringify(exported.inject));
check("exports apply()", typeof exported.apply === "function");

// --- fake slots service: capture the page component ----------------------
let pageComponent = null;
const slots = {
  inject(name, fn) {
    return fn();
  },
  register(spec, Component) {
    check("registers under plugins.item", spec.name === "plugins.item", spec.name);
    check("slot spec has a stable id", spec.id === "lan-peers", spec.id);
    check("slot spec label is a function", typeof spec.label === "function");
    pageComponent = Component;
    return () => {};
  },
};
const ctx = { slots, effect: (fn) => (typeof fn === "function" ? fn() : undefined) };
exported.apply(ctx);
check("page component captured", typeof pageComponent === "function");

// --- render the page -----------------------------------------------------
hookCursor = 0;
hookStates.length = 0;
pendingEffects.length = 0;
let tree;
try {
  tree = pageComponent({});
} catch (error) {
  check("page renders without throwing", false, String(error?.stack || error));
}
if (tree) check("page renders without throwing", true);

// Walk the tree and count recognizable labels.
const walk = (node, into = texts) => {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, into));
  if (typeof node === "string" || typeof node === "number") { into.push(String(node)); return; }
  if (typeof node !== "object") return;
  (node.children || []).forEach((n) => walk(n, into));
  if (node.props && node.props.children) walk(node.props.children, into);
};
const texts = [];
if (tree) walk(tree);
const joined = texts.join(" | ");
check("page shows its title", joined.includes("LAN 邻居") || joined.includes("LAN peers"), joined.slice(0, 120));
// Before the first fetch resolves the page intentionally renders a placeholder;
// the loaded-state assertions below cover the real UI.

// Run the initial-load effect (fetch status) and confirm it is wired.
check("page schedules an initial status load", pendingEffects.length > 0);
for (const effect of pendingEffects) {
  try { effect(); } catch (error) { check("initial load effect runs", false, String(error)); }
}
check("initial load effect runs", true);

// Re-render with a loaded status in place: the page reads it from state, so
// seed the hook state the same way a resolved fetch would.
const loadedStatus = {
  ok: true,
  id: "abc12345-0000-0000-0000-000000000000",
  name: "本机 DSH",
  enabled: true,
  started: true,
  localAddress: "192.168.0.39",
  listenPort: 45715,
  discoveryPort: 45714,
  passphraseConfigured: false,
  peers: [
    { id: "peer-one-1111", name: "书房 DSH", address: "192.168.0.42", httpPort: 45715, trusted: true, blocked: false },
  ],
  approved: ["peer-one-1111"],
  blocked: [],
  recent: [{ at: new Date().toISOString(), direction: "in", kind: "ask", peer: { id: "peer-one-1111", name: "书房 DSH" }, detail: "版本" }],
  config: {
    enabled: true,
    displayName: "",
    listenPort: 45715,
    discoveryPort: 45714,
    multicastGroup: "239.255.77.77",
    allowSameSubnet: true,
    manualPeers: "",
    askTimeoutMs: 120000,
    maxMessageChars: 8000,
    passphraseSet: false,
  },
};
hookStates[0] = loadedStatus;            // status
hookStates[1] = null;                    // draft (null => derived from status)
hookStates[2] = "";                      // passphrase
hookCursor = 0;
let loadedTree;
try {
  loadedTree = pageComponent({});
} catch (error) {
  check("page renders with loaded status", false, String(error?.stack || error));
}
const loadedTexts = [];
if (loadedTree) walk(loadedTree, loadedTexts);
const loadedJoined = loadedTexts.join(" | ");
check("page renders with loaded status", Boolean(loadedTree));
check("master switch copy is shown", loadedJoined.includes("启用内网互询") || loadedJoined.includes("Enable LAN peer"), loadedJoined.slice(0, 200));
check("discovered peer row is shown", loadedJoined.includes("书房 DSH"), loadedJoined.slice(0, 300));
check("trust tag reflects the approved peer", loadedJoined.includes("已信任") || loadedJoined.includes("trusted"), loadedJoined.slice(0, 300));
check("recent traffic row is shown", loadedJoined.includes("ask"), loadedJoined.slice(0, 400));

console.log(fails === 0 ? "\nCLIENT RENDER PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
