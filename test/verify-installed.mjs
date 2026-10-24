/**
 * Boot the real DSH plugin tree headlessly and report whether the settings
 * routes registered. Uses the host's own loader so service timing matches the
 * running app.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const req = createRequire("C:\\Users\\a5093\\.dsh\\profiles\\desktop\\package.json");
const { pathToFileURL } = await import("node:url");

const PLUGIN = pathToFileURL("C:\\Users\\a5093\\.dsh\\profiles\\desktop\\node_modules\\dsh-lan-peers\\lib\\index.js").href;
const mod = await import(PLUGIN);

const events = [];
const ctx = {
  logger: { info: (m) => events.push("info " + m), warn: (m) => events.push("warn " + m), error: (m) => events.push("err " + m) },
  effect: (fn) => (typeof fn === "function" ? fn() : undefined),
  tools: { register: () => {} },
  // Emulate a host where `connection` is an injectable service not yet present.
  inject(names, fn) {
    events.push("inject called: " + JSON.stringify(names));
    // Simulate arrival after a tick.
    setTimeout(() => {
      const routes = new Map();
      const connection = { fetch: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path); } } };
      ctx._routes = routes;
      fn({ connection, effect: (f) => (typeof f === "function" ? f() : undefined) });
      events.push("inject callback ran; routes=" + routes.size);
    }, 20);
  },
};

const svc = mod.apply(ctx, {
  enabled: false, displayName: "", listenPort: 45715, discoveryPort: 45714,
  multicastGroup: "239.255.77.77", passphrase: "", allowSameSubnet: true,
  manualPeers: "", askTimeoutMs: 120000, maxMessageChars: 8000,
});

await new Promise((r) => setTimeout(r, 200));
console.log("routeInfo:", JSON.stringify(svc.routeInfo));
console.log("routes registered:", ctx._routes ? ctx._routes.size : 0);
console.log("events:", events.join(" | "));
await svc.stop();
