/**
 * dsh-lan-peers self-test.
 *
 * Runs the real service with two instances on one machine, on separate ports
 * and a private state dir, and exercises: packet handling, trust gate,
 * ask/tell round trip, passphrase mismatch, and the disabled state.
 *
 *   node test/selftest.mjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// Keep every write out of this package's real cordis.patch.yml.
const __isolatedPatch = (tag) => {
  const { tmpdir: tmp } = process.getBuiltinModule("node:os");
  return tmp() + "/lan-peers-test-" + tag + "-" + process.pid + ".yml";
};



// Isolate the identity/trust files before importing the module.
const HOME = await mkdtemp(join(tmpdir(), "lan-peers-test-"));
process.env.DSH_HOME = HOME;

const mod = await import("../lib/index.js");
const { LanPeersService, parsePeerList, sameSubnet, isPrivateIPv4, localIPv4, MAGIC } = mod;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mkCtx = () => ({
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) {
    return typeof fn === "function" ? fn() : undefined;
  },
});

/** A config object shaped like the plugin applies it. */
function mkConfig(over = {}) {
  return {
    enabled: true,
    displayName: "",
    listenPort: 0,
    discoveryPort: 45999,
    multicastGroup: "239.255.77.99",
    passphrase: "",
    allowSameSubnet: true,
    manualPeers: "",
    askTimeoutMs: 5000,
    maxMessageChars: 8000,
    ...over,
  };
}

async function newService(config) {
  const service = new LanPeersService(mkCtx(), config);
  service.patchFile = __isolatedPatch("selftest");
  await service.start();
  return service;
}

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error?.message || error}`);
  }
}

console.log("dsh-lan-peers selftest");
console.log(`state dir: ${HOME}`);

// 鈹€鈹€ pure helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
await check("parsePeerList accepts bare host:port and full URLs", () => {
  assert.deepEqual(parsePeerList("192.168.0.42:45715, http://10.0.0.5:45716, bad;"), [
    "http://192.168.0.42:45715",
    "http://10.0.0.5:45716",
  ]);
});

await check("sameSubnet keeps 192.168.0.x together and rejects 192.168.1.x", () => {
  assert.equal(sameSubnet("192.168.0.39", "192.168.0.42"), true);
  assert.equal(sameSubnet("192.168.0.39", "192.168.1.42"), false);
  assert.equal(sameSubnet("10.1.2.3", "10.9.9.9"), true);
});

await check("isPrivateIPv4 rejects public addresses", () => {
  assert.equal(isPrivateIPv4("8.8.8.8"), false);
  assert.equal(isPrivateIPv4("192.168.1.10"), true);
});

// 鈹€鈹€ two real services 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const a = await newService(mkConfig({ displayName: "node-a", listenPort: 0, identitySuffix: "aaa" }));
const b = await newService(mkConfig({ displayName: "node-b", listenPort: 0, identitySuffix: "bbb" }));

await check("both services bound an inbound TCP port", () => {
  assert.ok(a.httpPort > 0, "a.httpPort");
  assert.ok(b.httpPort > 0, "b.httpPort");
  assert.notEqual(a.httpPort, b.httpPort);
});

await check("identities are distinct and stable", () => {
  assert.ok(a.identity.id && b.identity.id);
  assert.notEqual(a.identity.id, b.identity.id);
});

// Register B into A's peer table the way a real discovery reply would.
const loopback = "127.0.0.1";
b.rememberPeer({
  id: b.identity.id,
  name: b.displayName(),
  host: "host-b",
  httpPort: b.httpPort,
  address: loopback,
  version: "1.0.0",
});
a.rememberPeer({
  id: b.identity.id,
  name: b.displayName(),
  host: "host-b",
  httpPort: b.httpPort,
  address: loopback,
  version: "1.0.0",
});

await check("ask round trip returns a factual answer", async () => {
  const peer = a.listPeers().find((p) => p.id === b.identity.id);
  assert.ok(peer, "peer registered");
  assert.equal(peer.trusted, true, "same-subnet trust without a passphrase");
  const result = await a.ask(peer, "版本");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.answer.text, /DSH|1\.0\.0/);
});

await check("ask names the answering install", async () => {
  const peer = a.listPeers().find((p) => p.id === b.identity.id);
  const result = await a.ask(peer, "你是谁");
  assert.equal(result.ok, true);
  assert.match(result.answer.text, /node-b/);
});

await check("tell round trip succeeds", async () => {
  const peer = a.listPeers().find((p) => p.id === b.identity.id);
  const result = await a.tell(peer, "hello from test");
  assert.equal(result.ok, true, JSON.stringify(result));
});

await check("inbound traffic is journaled on both sides", () => {
  assert.ok(b.recent.some((r) => r.direction === "in" && r.kind === "ask"));
  assert.ok(b.recent.some((r) => r.direction === "in" && r.kind === "tell"));
  assert.ok(a.recent.some((r) => r.direction === "out" && r.kind === "tell"));
});

await check("blocking a peer refuses it", async () => {
  await b.blockPeer(a.identity.id);
  const peer = a.listPeers().find((p) => p.id === b.identity.id);
  const result = await a.tell(peer, "should be refused");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "blocked");
  await b.unblockPeer(a.identity.id);
});

await check("trust gate: same-subnet rules without touching the wire", () => {
  b.cfg.passphrase = "";
  b.trust.approved = [];
  b.cfg.allowSameSubnet = true;
  assert.equal(b.isTrusted("unknown", "127.0.0.1", false), true, "loopback is trusted");
  assert.equal(b.isTrusted("unknown", "10.9.9.9", false), false, "foreign subnet is not");
  assert.equal(b.isTrusted("unknown", null, false), false, "no source is not trusted");
  b.cfg.allowSameSubnet = false;
  assert.equal(b.isTrusted("unknown", "127.0.0.1", false), false, "the switch turns loopback off too");
  b.cfg.allowSameSubnet = true;
  assert.equal(b.isTrusted("unknown", "10.9.9.9", true), true, "a matching passphrase wins on any address");
});

await check("approved peers are trusted regardless of subnet", async () => {
  await b.trustPeer("approved-id-1234", "selftest");
  assert.equal(b.isTrusted("approved-id-1234", "10.9.9.9", false), true);
  await b.untrustPeer("approved-id-1234");
  assert.equal(b.isTrusted("approved-id-1234", "10.9.9.9", false), false);
});

await check("a blocked peer stays refused even with a matching passphrase", () => {
  b.trust.blocked.push("blocked-id-9999");
  assert.equal(b.isTrusted("blocked-id-9999", "127.0.0.1", true), false);
  b.trust.blocked = b.trust.blocked.filter((x) => x !== "blocked-id-9999");
});

await check("a matching passphrase authorizes peers on its own", async () => {
  // Fresh approval-less remote with a passphrase both sides share.
  await b.reconfigure({ passphrase: "shared-group-secret", allowSameSubnet: false });
  b.trust.approved = [];
  await a.reconfigure({ passphrase: "shared-group-secret" });
  b.rememberPeer({
    id: b.identity.id, name: b.displayName(), host: "host-b",
    httpPort: b.httpPort, address: loopback,
  });
  const peer = a.listPeers().find((p) => p.id === b.identity.id);
  const result = await a.ask(peer, "版本");
  assert.equal(result.ok, true, JSON.stringify(result));
  const refused = await a.tell(peer, "wrong group");
  assert.equal(refused.ok, true, JSON.stringify(refused));
  // A different passphrase must not be authorized by anything else.
  await a.reconfigure({ passphrase: "different-secret" });
  const mismatch = await a.tell(peer, "should fail");
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "passphrase-mismatch");
  await a.reconfigure({ passphrase: "" });
  await b.reconfigure({ passphrase: "" });
});

await check("passphrase mismatch hides and refuses the peer", async () => {
  await b.reconfigure({ passphrase: "secret-one" });
  const peer = a.listPeers().find((p) => p.id === b.identity.id);
  // Rebuild the peer entry with B's real port after rebind.
  b.rememberPeer({
    id: b.identity.id, name: b.displayName(), host: "host-b",
    httpPort: b.httpPort, address: loopback,
  });
  a.rememberPeer({
    id: b.identity.id, name: b.displayName(), host: "host-b",
    httpPort: b.httpPort, address: loopback,
  });
  const refreshed = a.listPeers().find((p) => p.id === b.identity.id);
  const result = await a.ask(refreshed, "鐗堟湰");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "passphrase-mismatch");
  assert.equal(a.verifyPassphrase(b.passphraseHash()).ok, false);
  await a.reconfigure({ passphrase: "secret-one" });
  const ok = await a.ask(refreshed, "鐗堟湰");
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

await check("disabled config binds nothing and refuses work", async () => {
  const c = new LanPeersService(mkCtx(), mkConfig({ enabled: false }));
  const started = await c.start();
  assert.equal(started.started, false);
  assert.equal(c.httpPort, undefined);
  const d = await c.discover();
  assert.equal(d.ok, false);
  assert.equal(d.reason, "disabled");
});

await check("resolvePeer reports ambiguity instead of guessing", () => {
  const fake = new LanPeersService(mkCtx(), mkConfig());
  fake.identity = { id: "idfake0001" };
  fake.peers.set("aaa1111", { id: "aaa1111", name: "瀹㈠巺 DSH", address: "192.168.0.10", httpPort: 45715 });
  fake.peers.set("bbb2222", { id: "bbb2222", name: "涔︽埧 DSH", address: "192.168.0.11", httpPort: 45715 });
  const ambiguous = fake.resolvePeer("DSH");
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, "ambiguous");
  assert.equal(ambiguous.peers.length, 2);
  const exact = fake.resolvePeer("瀹㈠巺 DSH");
  assert.equal(exact.ok, true);
  const single = fake.resolvePeer("");
  assert.equal(single.ok, false);
  assert.equal(single.reason, "ambiguous");
});

await check("resolvePeer auto-selects when exactly one peer exists", () => {
  const fake = new LanPeersService(mkCtx(), mkConfig());
  fake.identity = { id: "idfake0002" };
  fake.peers.set("ccc3333", { id: "ccc3333", name: "only", address: "192.168.0.12", httpPort: 45715 });
  const one = fake.resolvePeer("");
  assert.equal(one.ok, true);
  assert.equal(one.peer.id, "ccc3333");
});

await check("reconfigure to disabled stops the sockets", async () => {
  await a.reconfigure({ enabled: false });
  assert.equal(a.started, false);
  assert.equal(a.sock, null);
  await b.reconfigure({ enabled: false });
  assert.equal(b.started, false);
});

await a.stop();
await b.stop();
await rm(HOME, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;

