/**
 * Behaviour pins after the model-reply feature was removed.
 *
 * The feature caused the most serious bug in this plugin's history: a wrong
 * `llm.listModels()` signature threw inside the host's request handler and
 * killed the DSH process. It is gone now, and these checks make sure nothing
 * creeps back:
 *
 *   - no module reaches for `ctx.llm` / the model, and `llm` is not injected;
 *   - an inbound question is answered by the deterministic host-facts reply,
 *     with no model in the path at all;
 *   - the settings route still keeps boolean/number types (the bug that made
 *     `modelReplies` persist as 'true' also lived here, so it is pinned);
 *   - the browser half sends credentials, because /api routes are authenticated.
 */
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = await mkdtemp(join(tmpdir(), "lan-peers-nomodel-"));
process.env.DSH_HOME = HOME;

const mod = await import("../lib/index.js");
const { LanPeersService } = mod;

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label} ${extra}`); }
};

const cfg = (over) => ({
  enabled: true, displayName: "本机", listenPort: 0, discoveryPort: 46180,
  multicastGroup: "239.255.77.74", passphrase: "", allowSameSubnet: true,
  manualPeers: "", askTimeoutMs: 5000, maxMessageChars: 8000, ...over,
});

// ── the feature is really gone ──────────────────────────────────────────
{
  const index = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
  const client = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  check("no llm model module exists", await readFile(new URL("../lib/model.js", import.meta.url), "utf8").then(() => false, () => true));
  check("the plugin does not inject the llm service", !(mod.inject || []).includes("llm"), JSON.stringify(mod.inject));
  check("index.js never reads ctx.llm", !/ctx\.llm/.test(index));
  check("index.js has no model reply settings", !/modelReplies|modelTimeoutMs/.test(index));
  // The page may still say the model will not contact peers on its own; what
  // must be gone is any control that makes the model generate a reply.
  check("the settings page has no model-reply controls", !/modelReplies|modelTimeout|用本机模型|本机模型回复/.test(client), "a model control remains");
  check("no ask handler path generates a reply", !/generateReply|pickModel|answerFor/.test(index));
}

// ── answers are deterministic host facts ────────────────────────────────
{
  const svc = new LanPeersService({ logger: { info() {}, warn() {}, error() {} }, effect: (f) => (typeof f === "function" ? f() : undefined) }, cfg());
  svc.patchFile = join(tmpdir(), "lan-peers-nomodel-a.yml");
  await svc.start();

  // No llm is attached; the service must not even look for one.
  svc.llm = { stream() { throw new Error("the model must never be called"); } };

  const answer = svc.cannedAnswer("版本");
  check("a question is answered from host facts", typeof answer.text === "string" && answer.from !== "model", JSON.stringify(answer));
  check("the answer names the machine", answer.text.includes("本机") || answer.text.includes("DESKTOP") || answer.text.includes("IP"), answer.text);
  check("status carries no model fields", !("modelReplies" in svc.status()) && !("modelStats" in svc.status()), JSON.stringify(Object.keys(svc.status()).filter((k) => k.startsWith("model"))));
  await svc.stop();
}

// ── an inbound ask never touches a model ────────────────────────────────
{
  const svc = new LanPeersService({ logger: { info() {}, warn() {}, error() {} }, effect: (f) => (typeof f === "function" ? f() : undefined) }, cfg({ enabled: true }));
  svc.patchFile = join(tmpdir(), "lan-peers-nomodel-b.yml");
  await svc.start();

  let modelCalls = 0;
  svc.llm = { stream() { modelCalls += 1; throw new Error("must not be called"); } };

  const body = JSON.stringify({
    magic: "DSH-LAN-PEERS/1",
    from: { id: "peer-0001", name: "对方" },
    pass: null,
    question: "你那边状态如何？",
    conversation: "conv-nomodel",
  });
  const req = {
    method: "POST",
    url: "/peer/ask",
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    on(event, fn) {
      if (event === "data") queueMicrotask(() => fn(Buffer.from(body)));
      if (event === "end") queueMicrotask(() => fn());
      return this;
    },
  };
  const response = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { this.body = text; this.done?.(text); } };
  const done = new Promise((resolve) => { response.done = resolve; });
  await svc.handleInbound(req, response);
  await done;

  const parsed = JSON.parse(response.body);
  check("an inbound ask is answered", response.statusCode === 200 && parsed.ok === true, JSON.stringify(parsed).slice(0, 160));
  check("the answer is not from a model", parsed.answer?.from !== "model", JSON.stringify(parsed.answer));
  check("the model was never called", modelCalls === 0, `${modelCalls} calls`);
  await svc.stop();
}

// ── the settings route still applies the right types ────────────────────
{
  const routes = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (f) => (typeof f === "function" ? f() : undefined),
    tools: { register() {} },
    inject: () => () => {},
  };
  Object.defineProperty(ctx, "connection", {
    get: () => ({ fetch: { register(r) { routes.set(r.path, r); return () => routes.delete(r.path); } } }),
    enumerable: true,
    configurable: true,
  });
  const svc = mod.apply(ctx, cfg({ enabled: false }));
  svc.patchFile = join(tmpdir(), "lan-peers-nomodel-c.yml");
  await new Promise((r) => setTimeout(r, 60));

  const route = routes.get("/api/lan-peers/settings");
  check("the settings route is still registered", Boolean(route), `routes=${routes.size}`);
  const saved = await (await route.fetch(new Request("http://127.0.0.1:1/api/lan-peers/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: "true", allowSameSubnet: "false", listenPort: "45716", discoveryPort: "45717", displayName: 5 }),
  }))).json();
  check("booleans survive as booleans", svc.cfg.enabled === true && svc.cfg.allowSameSubnet === false, JSON.stringify({ e: svc.cfg.enabled, a: svc.cfg.allowSameSubnet }));
  check("numbers survive as numbers", svc.cfg.listenPort === 45716 && svc.cfg.discoveryPort === 45717, JSON.stringify({ l: svc.cfg.listenPort, d: svc.cfg.discoveryPort }));
  check("text is coerced, not dropped", svc.cfg.displayName === "5", JSON.stringify(svc.cfg.displayName));
  check("save reports success", saved.ok === true, JSON.stringify(saved).slice(0, 120));
  await svc.stop();
}

// ── the browser half still authenticates ────────────────────────────────
{
  const client = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  check("settings fetches send credentials", client.includes('credentials: "same-origin"'), "omit would 401 on /api");
}

await rm(HOME, { recursive: true, force: true });
console.log(fails === 0 ? "\nNO-MODEL PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
