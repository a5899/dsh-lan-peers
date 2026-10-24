/**
 * Registration smoke test: apply the plugin to a host-like context and report
 * which routes it managed to register. Useful when a settings or viewer button
 * fails and you want to know whether the registration path itself worked.
 *
 * Runs from any checkout — no absolute paths, no DSH profile required.
 */
import assert from "node:assert/strict";

const mod = await import(new URL("../lib/index.js", import.meta.url).href);

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label} ${extra}`); }
};

const events = [];
// Two independent services, each arriving after a tick — the host may deliver
// them separately, so they must not share a route table.
const routes = new Map();
const ctx = {
  logger: {
    info: (m) => events.push("info " + m),
    warn: (m) => events.push("warn " + m),
    error: (m) => events.push("err " + m),
  },
  effect: (fn) => (typeof fn === "function" ? fn() : undefined),
  tools: { register: () => {} },
  inject(names, fn) {
    events.push("inject " + JSON.stringify(names));
    setTimeout(() => {
      const child = { effect: (f) => (typeof f === "function" ? f() : undefined) };
      if (names.includes("connection")) {
        child.connection = {
          fetch: {
            register(route) {
              routes.set(route.path, route);
              return () => routes.delete(route.path);
            },
          },
        };
      }
      if (names.includes("webServer")) {
        child.webServer = { register: () => () => {} };
      }
      fn(child);
      events.push(`callback ${JSON.stringify(names)} done; total routes=${routes.size}`);
    }, 20);
  },
};

const svc = mod.apply(ctx, {
  enabled: false, displayName: "", listenPort: 45715, discoveryPort: 45714,
  multicastGroup: "239.255.77.77", passphrase: "", allowSameSubnet: true,
  manualPeers: "", askTimeoutMs: 120000, maxMessageChars: 8000,
});

await new Promise((r) => setTimeout(r, 250));

console.log("routeInfo:", JSON.stringify(svc.routeInfo));
console.log("routes registered:", routes.size);
for (const path of routes.keys()) console.log("  -", path);
console.log("events:", events.join(" | "));

const EXPECTED = 8;
check("routeInfo reports the connection path", svc.routeInfo?.kind === "connection", JSON.stringify(svc.routeInfo));
check(`all ${EXPECTED} routes registered`, routes.size === EXPECTED, `got ${routes.size}`);
check("no config problems", (svc.configProblems || []).length === 0, JSON.stringify(svc.configProblems));

await svc.stop();
console.log(fails === 0 ? "\nINSTALLED PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
