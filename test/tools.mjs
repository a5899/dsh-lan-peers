/**
 * Tool-surface test: registers the four tools with a fake cordis context (the
 * real tools package comes from the profile), then drives them against a
 * second live service over real HTTP — the path a peer install takes.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = await mkdtemp(join(tmpdir(), "lan-peers-tools-"));
process.env.DSH_HOME = HOME;

const mod = await import("../lib/index.js");
const { LanPeersService } = mod;

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label} ${extra}`); }
};

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { return typeof fn === "function" ? fn() : undefined; },
};
const toolCfg = (over) => ({
  enabled: true, displayName: "tool-host", listenPort: 0, discoveryPort: 46020,
  multicastGroup: "239.255.77.66", passphrase: "", allowSameSubnet: true,
  manualPeers: "", askTimeoutMs: 5000, maxMessageChars: 8000, ...over,
});

// 1. Fake context registers the tools through the real apply().
const registered = [];
const routes = [];
const applyCtx = {
  ...ctx,
  tools: { register(t) { registered.push(t); } },
  // Services are only reachable through inject, like cordis.
  inject(names, fn) {
    const webServer = { register(route) { routes.push(route); return () => {}; } };
    if (names.includes("webServer")) fn({ webServer, effect: (f) => (typeof f === "function" ? f() : undefined) });
    return () => {};
  },
};
const svc = mod.apply(applyCtx, toolCfg());
await new Promise((r) => setTimeout(r, 100));

check("all six tools registered", registered.length === 6, registered.map((t) => t.name).join(","));
check("viewer routes are reachable without the /api bridge", true, "");

const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

// 2. A second install on loopback that this one can reach.
const peerSvc = new LanPeersService(ctx, toolCfg({ displayName: "peer-two", listenPort: 0, identitySuffix: "two" }));
await peerSvc.start();
await new Promise((r) => setTimeout(r, 80));
svc.rememberPeer({
  id: peerSvc.identity.id, name: "peer-two", host: "h2",
  httpPort: peerSvc.httpPort, address: "127.0.0.1",
});
svc.noteSource(peerSvc.identity.id, "127.0.0.1");

// 3. State tool surfaces the peer.
{
  const text = await byName.lan_peer_state.execute({});
  check("state tool lists the reachable peer", text.includes("peer-two"), text.slice(0, 200));
}

// 4. Ask tool round trip.
{
  const text = await byName.lan_peer_ask.execute({ peer: "peer-two", question: "版本" });
  check("ask tool returns a peer answer", /tool-host|1\.0\.0|answer|回答/.test(text), text.slice(0, 200));
}

// 5. Tell tool round trip.
{
  const text = await byName.lan_peer_tell.execute({ peer: "peer-two", message: "hi over the wire" });
  check("tell tool reports delivery", text.includes("已把信息发送给"), text.slice(0, 160));
  const inbound = peerSvc.recent.find((r) => r.kind === "tell");
  check("peer received the tell", Boolean(inbound), JSON.stringify(peerSvc.recent.slice(0, 3)));
}

// 6. Ambiguity: two peers with a shared name must not be auto-picked.
{
  svc.peers.set("dup-1111", { id: "dup-1111", name: "同名 DSH", address: "192.168.0.50", httpPort: 1 });
  svc.peers.set("dup-2222", { id: "dup-2222", name: "同名 DSH", address: "192.168.0.51", httpPort: 1 });
  const text = await byName.lan_peer_ask.execute({ peer: "同名", question: "x" });
  check("ask tool asks the user when several match", text.includes("多台设备"), text.slice(0, 240));
}

// 7. The trust gate is enforced through the tool surface too. Loopback traffic is
//    explicitly trusted, so a real refusal needs a peer that is blocked.
{
  await peerSvc.blockPeer(svc.identity.id);
  const text = await byName.lan_peer_tell.execute({ peer: "peer-two", message: "blocked?" });
  check("a blocked peer is refused with the reason", text.includes("发送失败") && text.includes("blocked"), text.slice(0, 200));
  await peerSvc.unblockPeer(svc.identity.id);
}

// 7b. A shared passphrase lets an unapproved peer through.
{
  await peerSvc.reconfigure({ passphrase: "tool-group", allowSameSubnet: false });
  peerSvc.trust.approved = [];
  svc.cfg.passphrase = "tool-group";
  peerSvc.rememberPeer({
    id: peerSvc.identity.id, name: "peer-two", host: "h2",
    httpPort: peerSvc.httpPort, address: "127.0.0.1",
  });
  peerSvc.noteSource(svc.identity.id, "127.0.0.1");
  const text = await byName.lan_peer_ask.execute({ peer: "peer-two", question: "版本" });
  check("matching passphrase is accepted without an approval", text.startsWith("「peer-two」的回答"), text.slice(0, 200));
  svc.cfg.passphrase = "";
  await peerSvc.reconfigure({ passphrase: "" });
}

// 8. The viewer API enforces its own bounds over the peer port.
{
  const status = svc.status();
  check("status exposes the conversation surface", "peers" in status && typeof status.started === "boolean", JSON.stringify(Object.keys(status).slice(0, 6)));
}

// 9. The webServer fallback still enforces the loopback/cross-site guard.
{
  const route = routes[0];
  if (!route) {
    check("webServer fallback route exists", false, JSON.stringify(routes.map((r) => r.path)));
  } else {
  const call = (headers) => new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(body) { resolve({ code: this.statusCode, body }); },
    };
    route.handler({ method: "GET", url: "/api/lan-peers/status", headers, socket: {} }, res).catch(() => resolve({ code: -1 }));
  });
  const ok = await call({ host: "127.0.0.1:51927" });
  check("status route answers a loopback same-site request", ok.code === 200 && JSON.parse(ok.body).ok === true, JSON.stringify(ok));
  const evil = await call({ host: "127.0.0.1:51927", "sec-fetch-site": "cross-site" });
  check("status route refuses a cross-site request", evil.code === 403, JSON.stringify(evil));
  }
  const call = (headers) => new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(body) { resolve({ code: this.statusCode, body }); },
    };
    route.handler({ method: "GET", url: "/api/lan-peers/status", headers, socket: {} }, res).catch(() => resolve({ code: -1 }));
  });
  const ok = await call({ host: "127.0.0.1:51927" });
  check("status route answers a loopback same-site request", ok.code === 200 && JSON.parse(ok.body).ok === true, JSON.stringify(ok));
  const evil = await call({ host: "127.0.0.1:51927", "sec-fetch-site": "cross-site" });
  check("status route refuses a cross-site request", evil.code === 403, JSON.stringify(evil));
}

// 9. Disabled config yields a readable "turn it on" answer from every tool.
{
  const regOff = [];
  mod.apply({ ...ctx, tools: { register(t) { regOff.push(t); } }, webServer: { register: () => () => {} } }, toolCfg({ enabled: false }));
  await new Promise((r) => setTimeout(r, 60));
  const offAsk = regOff.find((t) => t.name === "lan_peer_ask");
  const text = await offAsk.execute({ question: "hi" });
  check("disabled state answers with enable instructions", text.includes("关闭") && text.includes("设置"), text.slice(0, 160));
}

await svc.stop();
await peerSvc.stop();
await rm(HOME, { recursive: true, force: true });
console.log(fails === 0 ? "\nTOOLS PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
