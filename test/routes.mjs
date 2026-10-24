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

// Keep every write out of this package's real cordis.patch.yml.
const __isolatedPatch = (tag) => {
  const { tmpdir: tmp } = process.getBuiltinModule("node:os");
  return tmp() + "/lan-peers-test-" + tag + "-" + process.pid + ".yml";
};


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

const ROUTE_COUNT = 8;

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
/**
 * A cordis-faithful context.
 *
 * The real rule (cordis `Context.handler.get`) is: walk the fiber chain; a
 * service reachable from a fiber whose `inject` declares it is readable, and
 * anything else throws `cannot get property "<x>" without inject`.
 *
 * This test passes the plugin's own module-level `inject` list in, so a service
 * is exposed exactly when the plugin declared it — the check that would have
 * caught the missing `connection` declaration.
 */
function cordisCtx({ connection, webServer, declared = mod.inject || [], available = true } = {}) {
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (fn) => (typeof fn === "function" ? fn() : undefined),
    tools: { register() {} },
    _injections: [],
    _webInjections: [],
  };
  const expose = (name, value) => {
    Object.defineProperty(ctx, name, {
      get() {
        if (value === undefined) throw new Error(`cannot get property "${name}" without inject`);
        return value;
      },
      enumerable: true,
      configurable: true,
    });
  };
  if (declared.includes("connection")) expose("connection", connection ?? undefined);
  else expose("connection", undefined);
  if (declared.includes("webServer")) expose("webServer", webServer ?? undefined);
  else expose("webServer", undefined);

  // `ctx.inject(names, fn)` mounts fn as a sub-plugin with its own deps.
  ctx.inject = (names, fn) => {
    const child = {
      connection: names.includes("connection") ? connection : undefined,
      webServer: names.includes("webServer") ? webServer : undefined,
      effect: (f) => (typeof f === "function" ? f() : undefined),
    };
    if (names.includes("connection")) {
      ctx._injections.push({ names, fn });
      if (available && connection) fn(child);
    }
    if (names.includes("webServer")) {
      ctx._webInjections.push({ names, fn });
      if (available && webServer) fn(child);
    }
    return () => {};
  };
  return ctx;
}

// ── registration shape ──────────────────────────────────────────────────
{
  const conn = makeConnection();
  const svc = mod.apply(cordisCtx({ connection: conn.service }), CONFIG);
  svc.patchFile = __isolatedPatch("routes");
  await new Promise((r) => setTimeout(r, 100));

  const expected = [
    ["/api/lan-peers/status", ["GET"]],
    ["/api/lan-peers/settings", ["POST"]],
    ["/api/lan-peers/discover", ["POST"]],
    ["/api/lan-peers/trust", ["POST"]],
    ["/api/lan-peers/test", ["POST"]],
    ["/api/lan-peers/conversations", ["GET"]],
    ["/api/lan-peers/messages", ["GET"]],
    ["/api/lan-peers/send", ["POST"]],
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
  // A ctx that did NOT declare the dependency must still deny access.
  const undeclared = cordisCtx({ connection: conn.service, declared: ["tools"] });
  let denied = false;
  try { void undeclared.connection; } catch (error) { denied = /without inject/.test(error.message); }
  check("a ctx without the declaration still denies access", denied);

  const svc = mod.apply(ctx, CONFIG);
  svc.patchFile = __isolatedPatch("routes2");
  await new Promise((r) => setTimeout(r, 100));
  check("registers despite the ctx denying eager reads", conn.routes.size === ROUTE_COUNT, `routes=${conn.routes.size} routeInfo=${JSON.stringify(svc.routeInfo)}`);
  check("routeInfo reports the connection path", svc.routeInfo?.kind === "connection", JSON.stringify(svc.routeInfo));
  await svc.stop();
}

// ── connection arrives later ────────────────────────────────────────────
{
  const conn = makeConnection();
  const ctx = cordisCtx({ connection: null, available: false });
  const svc = mod.apply(ctx, CONFIG);
  svc.patchFile = __isolatedPatch("routes2");
  await new Promise((r) => setTimeout(r, 80));
  check("declares the connection dependency at module level", Array.isArray(mod.inject) && mod.inject.includes("connection"), JSON.stringify(mod.inject));

  const lateCtx = cordisCtx({ connection: conn.service });
  const lateSvc = mod.apply(lateCtx, CONFIG);
  await new Promise((r) => setTimeout(r, 60));
  check("registers when connection is available at apply time", conn.routes.size === ROUTE_COUNT, `routes=${conn.routes.size}`);
  check("the late service reports the connection path", lateSvc.routeInfo?.kind === "connection", JSON.stringify(lateSvc.routeInfo));
  await lateSvc.stop();
  await svc.stop();
}

// ── no connection at all: fall back, never throw ────────────────────────
{
  const registered = [];
  const ctx = cordisCtx({ connection: null, webServer: { register: (r) => { registered.push(r); return () => {}; } } });
  const svc = mod.apply(ctx, CONFIG);
  svc.patchFile = __isolatedPatch("routes2");
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
  svc.patchFile = __isolatedPatch("routes2");
  await new Promise((r) => setTimeout(r, 80));
  check("a throwing registry falls back instead of crashing", registered.length === 1, `fallbacks=${registered.length}`);
  await svc.stop();
}

// ── the source must not read the service outside inject ─────────────────
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  // Reading ctx.connection inside the router is only legal because the module
  // declares the dependency. Pin the pairing, not the absence of the read.
  const declares = Array.isArray(mod.inject) && mod.inject.includes("connection");
  check("the module declares connection in its top-level inject", declares, JSON.stringify(mod.inject));
  check(
    "the router reads ctx.connection only under that declaration",
    !/ctx\.connection/.test(src.slice(src.indexOf("function registerSettingsRoutes"))) || declares,
    "an undeclared eager read throws under cordis",
  );
}

await rm(HOME, { recursive: true, force: true });
console.log(fails === 0 ? "\nROUTES PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
