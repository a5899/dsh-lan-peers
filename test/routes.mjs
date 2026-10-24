/**
 * Settings-route contract test.
 *
 * Two failures are pinned here, both of which shipped at least once:
 *
 * 1. A `prefix` route on `/api` is never reached — Connection matches its
 *    `fetchRoutes` table by exact pathname, and the Typert gateway answers
 *    everything else with a bare 404 `not found`.
 * 2. Cordis only hands out a service to an `inject`ed context. Reading
 *    `ctx.connection` (or `ctx.get('connection')`) from a plugin that never
 *    declared the dependency throws "cannot get property … without inject",
 *    which aborted registration entirely.
 *
 * The fake contexts below enforce (2), so a regression cannot pass silently
 * the way it did before.
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
  enabled: false, displayName: "", listenPort: 0, discoveryPort: 46090,
  multicastGroup: "239.255.77.71", passphrase: "", allowSameSubnet: true,
  manualPeers: "", askTimeoutMs: 5000, maxMessageChars: 8000,
};

const makeConnection = () => {
  const routes = new Map();
  return {
    routes,
    service: {
      fetch: {
        register(route) {
          if (routes.has(route.path)) throw new Error("already registered: " + route.path);
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
  };
};

/**
 * A cordis-faithful context: undeclared services are not exposed, and reading
 * one throws exactly like the runtime does.
 */
function cordisCtx({ connection, webServer, available = true } = {}) {
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (fn) => (typeof fn === "function" ? fn() : undefined),
    tools: { register() {} },
    webServer: webServer ?? { register: () => () => {} },
    _injections: [],
  };
  // Only an injected child may read the service, exactly like cordis.
  Object.defineProperty(ctx, "connection", {
    get() {
      throw new Error('cannot get property "connection" without inject');
    },
    enumerable: true,
    configurable: true,
  });
  ctx.inject = (names, fn) => {
    ctx._injections.push({ names, fn });
    if (!available || !names.includes("connection") || !connection) return () => {};
    fn({
      connection,
      effect: (f) => (typeof f === "function" ? f() : undefined),
    });
    return () => {};
  };
  return ctx;
}

// ── registration shape ──────────────────────────────────────────────────
{
  const conn = makeConnection();
  const svc = mod.apply(cordisCtx({ connection: conn.service }), CONFIG);
  await new Promise((r) => setTimeout(r, 100));

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
    check(`route ${path} exists with methods ${methods.join(",")}`, route && JSON.stringify(route.methods) === JSON.stringify(methods), JSON.stringify(route?.methods));
    check(`route ${path} is buffered and exact`, route?.requestBody === "buffered" && !route.path.includes("*"), `${route?.requestBody} ${route?.path}`);
  }
  check("routeInfo names the connection path", svc.routeInfo?.kind === "connection", JSON.stringify(svc.routeInfo));

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
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    return { status: response.status, body: parsed };
  };

  const saved = await call("/api/lan-peers/settings", "POST", { ...CONFIG, displayName: "renamed" });
  check("POST settings answers 200 and saves", saved.status === 200 && saved.body.ok === true, JSON.stringify(saved).slice(0, 180));
  check("POST settings applies the new display name", saved.body.status?.name === "renamed", JSON.stringify(saved.body.status?.name));

  const trust = await call("/api/lan-peers/trust", "POST", { action: "block", id: "peer-blocked-1" });
  check("POST trust answers 200 and records the block", trust.status === 200 && (trust.body.status?.blocked || []).includes("peer-blocked-1"), JSON.stringify(trust).slice(0, 140));

  const bad = await call("/api/lan-peers/trust", "POST", { action: "nonsense", id: "x" });
  check("unknown trust action is a 400, not the bridge 404", bad.status === 400 && bad.body.reason === "unknown-action", JSON.stringify(bad));

  await svc.stop();
}

// ── the runtime denial must not abort registration ──────────────────────
{
  const conn = makeConnection();
  const ctx = cordisCtx({ connection: conn.service });
  let denied = false;
  try { void ctx.connection; } catch (error) { denied = /without inject/.test(error.message); }
  check("the test ctx really denies undeclared service access", denied);

  const svc = mod.apply(ctx, CONFIG);
  await new Promise((r) => setTimeout(r, 100));
  check("registers despite the ctx denying eager reads", conn.routes.size === 5, `routes=${conn.routes.size} routeInfo=${JSON.stringify(svc.routeInfo)}`);
  check("routeInfo reports the connection path", svc.routeInfo?.kind === "connection", JSON.stringify(svc.routeInfo));
  await svc.stop();
}

// ── connection arrives later ────────────────────────────────────────────
{
  const conn = makeConnection();
  const ctx = cordisCtx({ connection: null, available: false });
  const svc = mod.apply(ctx, CONFIG);
  await new Promise((r) => setTimeout(r, 80));
  check("declares the connection dependency through inject", ctx._injections.length === 1 && ctx._injections[0].names.includes("connection"));

  ctx._injections[0].fn({ connection: conn.service, effect: (fn) => (typeof fn === "function" ? fn() : undefined) });
  check("registers when connection appears", conn.routes.size === 5, `routes=${conn.routes.size}`);
  check("routeInfo reports the connection path", svc.routeInfo?.kind === "connection", JSON.stringify(svc.routeInfo));
  await svc.stop();
}

// ── no connection at all: fall back, never throw ────────────────────────
{
  const registered = [];
  const ctx = cordisCtx({ connection: null, webServer: { register: (r) => { registered.push(r); return () => {}; } } });
  const svc = mod.apply(ctx, CONFIG);
  await new Promise((r) => setTimeout(r, 80));
  check("falls back to the web server", registered.length === 1 && registered[0].kind === "prefix", JSON.stringify(registered.map((r) => r.kind)));
  await svc.stop();
}

// ── a throwing registry degrades instead of crashing ────────────────────
{
  const registered = [];
  const ctx = cordisCtx({
    connection: { fetch: { register() { throw new Error("registry closed"); } } },
    webServer: { register: (r) => { registered.push(r); return () => {}; } },
  });
  const svc = mod.apply(ctx, CONFIG);
  await new Promise((r) => setTimeout(r, 80));
  check("a throwing registry falls back instead of crashing", registered.length === 1, `fallbacks=${registered.length}`);
  await svc.stop();
}

// ── the source must not read the service outside inject ─────────────────
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("function registerSettingsRoutes"), src.indexOf("/** Config as the settings page sees it"));
  // Strip comments so prose about the trap is not mistaken for the trap.
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  check("no eager ctx.connection read in the router", !/ctx\.connection/.test(code), "an eager read throws without inject");
  check("no ctx.get('connection') read", !/ctx\.get\(\s*["']connection["']\s*\)/.test(code), "the same trap through ctx.get");
}

await rm(HOME, { recursive: true, force: true });
console.log(fails === 0 ? "\nROUTES PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
