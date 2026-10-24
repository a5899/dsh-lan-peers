/**
 * Settings-route contract test.
 *
 * Under DSH, everything below `/api` belongs to Connection: it matches exact
 * fetch routes and hands the rest to the Typert gateway, which answers an
 * unclaimed endpoint with a plain-body 404 `not found`. Registering a `prefix`
 * route there is never reached — that is exactly what the page reported. This
 * test pins the registration shape and drives every route the way the host does.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = await mkdtemp(join(tmpdir(), "lan-peers-routes-"));
process.env.DSH_HOME = HOME;

const mod = await import("../lib/index.js");

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label} ${extra}`); }
};

const CONFIG = {
  enabled: true, displayName: "", listenPort: 0, discoveryPort: 46090,
  multicastGroup: "239.255.77.71", passphrase: "", allowSameSubnet: true,
  manualPeers: "", askTimeoutMs: 5000, maxMessageChars: 8000,
};

/** A fake Connection exposing the exact fetch-route registry. */
function makeConnection() {
  const routes = new Map();
  return {
    routes,
    service: {
      fetch: {
        register(route) {
          if (routes.has(route.path)) throw new Error("route already registered: " + route.path);
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
  };
}

const ctxBase = (extra) => ({
  logger: { info() {}, warn() {}, error() {} },
  effect: (fn) => (typeof fn === "function" ? fn() : undefined),
  tools: { register() {} },
  ...extra,
});

// ── registration shape ──────────────────────────────────────────────────
{
  const conn = makeConnection();
  const svc = mod.apply(ctxBase({ connection: conn.service }), CONFIG);
  await new Promise((r) => setTimeout(r, 120));

  const expected = [
    ["/api/lan-peers/status", ["GET"]],
    ["/api/lan-peers/settings", ["POST"]],
    ["/api/lan-peers/discover", ["POST"]],
    ["/api/lan-peers/trust", ["POST"]],
    ["/api/lan-peers/test", ["POST"]],
  ];
  check("registers on the connection fetch registry", conn.routes.size === expected.length, `${conn.routes.size} routes`);
  for (const [path, methods] of expected) {
    const route = conn.routes.get(path);
    check(`route ${path} exists`, Boolean(route), "missing");
    check(
      `route ${path} declares methods ${methods.join(",")}`,
      route && JSON.stringify(route.methods) === JSON.stringify(methods),
      route ? JSON.stringify(route.methods) : "n/a",
    );
    check(`route ${path} declares a buffered body`, route?.requestBody === "buffered", String(route?.requestBody));
    check(`route ${path} is an exact path, never a prefix`, route?.path === path && !route.path.includes("*"));
  }

  // ── drive the routes the way the host does ───────────────────────────
  const call = async (path, method, body) => {
    const route = conn.routes.get(path);
    if (!route) return { status: 404, body: { reason: "route-missing" } };
    const request = new Request(`http://127.0.0.1:1234${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const response = await route.fetch(request);
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    return { status: response.status, body: parsed };
  };

  const status = await call("/api/lan-peers/status", "GET");
  check("GET status answers 200 with JSON", status.status === 200 && status.body.ok === true, JSON.stringify(status));
  check("GET status exposes the resolved ports", status.body.discoveryPort === 46090, JSON.stringify(status.body.discoveryPort));
  check("GET status includes the public config", status.body.config && status.body.config.discoveryPort === 46090);

  const saved = await call("/api/lan-peers/settings", "POST", {
    enabled: true, displayName: "renamed", listenPort: 0, discoveryPort: 46090,
    multicastGroup: "239.255.77.71", allowSameSubnet: true, manualPeers: "",
    askTimeoutMs: 5000, maxMessageChars: 8000,
  });
  check("POST settings answers 200 and saves", saved.status === 200 && saved.body.ok === true, JSON.stringify(saved).slice(0, 200));
  check("POST settings applies the new display name", saved.body.status?.name === "renamed", JSON.stringify(saved.body.status?.name));
  check("saved response carries no config problems", Array.isArray(saved.body.problems) && saved.body.problems.length === 0, JSON.stringify(saved.body.problems));

  const trust = await call("/api/lan-peers/trust", "POST", { action: "block", id: "peer-blocked-1" });
  check("POST trust answers 200", trust.status === 200 && trust.body.ok === true, JSON.stringify(trust).slice(0, 160));
  check("blocked id is recorded", (trust.body.status?.blocked || []).includes("peer-blocked-1"), JSON.stringify(trust.body.status?.blocked));

  const bad = await call("/api/lan-peers/trust", "POST", { action: "nonsense", id: "x" });
  check("unknown trust action is a 400, not a 404", bad.status === 400 && bad.body.reason === "unknown-action", JSON.stringify(bad));

  const discover = await call("/api/lan-peers/discover", "POST", {});
  check("POST discover answers 200", discover.status === 200, JSON.stringify(discover).slice(0, 160));

  await svc.stop();
}

// ── fallback when Connection is absent ──────────────────────────────────
{
  const registered = [];
  const svc = mod.apply(
    ctxBase({ webServer: { register: (route) => { registered.push(route); return () => {}; } } }),
    { ...CONFIG, enabled: false },
  );
  await new Promise((r) => setTimeout(r, 80));
  check("falls back to the web server without Connection", registered.length === 1 && registered[0].kind === "prefix", JSON.stringify(registered.map((r) => r.kind)));
  await svc.stop();
}

// ── connection failures must not crash the plugin ───────────────────────
{
  const thrown = [];
  const svc = mod.apply(ctxBase({
    connection: { fetch: { register() { throw new Error("registry closed"); } } },
    webServer: { register: (r) => { thrown.push(r); return () => {}; } },
  }), { ...CONFIG, enabled: false });
  await new Promise((r) => setTimeout(r, 80));
  check("a failing connection registry falls back instead of throwing", thrown.length === 1, `fallbacks=${thrown.length}`);
  await svc.stop();
}

// ── connection arrives AFTER apply(): the real DSH ordering ─────────────
{
  const conn = makeConnection();
  let injection = null;
  const svc = mod.apply(ctxBase({
    // No `connection` and no `get()`: the service simply is not there yet.
    inject(names, fn) {
      injection = { names, fn };
    },
  }), { ...CONFIG, enabled: false });
  await new Promise((r) => setTimeout(r, 80));

  check("waits for connection instead of guessing", svc.routeInfo?.kind === "connection-pending", JSON.stringify(svc.routeInfo));
  check("declares the connection dependency", Array.isArray(injection?.names) && injection.names.includes("connection"), JSON.stringify(injection?.names));

  // The service appears: cordis invokes the inject callback with a child ctx.
  const registered = (() => {
    if (!injection) return false;
    injection.fn({ connection: conn.service, effect: (fn) => (typeof fn === "function" ? fn() : undefined) });
    return conn.routes.size === 5;
  })();
  check("registers when connection finally appears", registered, `routes=${conn.routes.size}`);
  check("reports the real routes afterwards", svc.routeInfo?.kind === "connection", JSON.stringify(svc.routeInfo));

  const route = conn.routes.get("/api/lan-peers/status");
  const response = route ? await route.fetch(new Request("http://127.0.0.1:1/api/lan-peers/status", { method: "GET" })) : null;
  const body = response ? await response.json() : null;
  check("late route answers 200", Boolean(body && response.status === 200 && body.ok === true), JSON.stringify(body).slice(0, 120));
  await svc.stop();
}

await rm(HOME, { recursive: true, force: true });
console.log(fails === 0 ? "\nROUTES PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
