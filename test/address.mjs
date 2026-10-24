/**
 * A peer learned from an inbound request must be dialable.
 *
 * Before this fix an inbound ask/tell recorded the peer with `httpPort: null`,
 * so the next `tell` to that same peer failed with "no-address" even though it
 * had just spoken to us. The port is now learned from the sender's identity
 * payload, and an existing row is upgraded rather than left portless.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), "lan-peers-addr-"));
const mod = await import("../lib/index.js");
const { LanPeersService } = mod;

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label} ${extra}`); }
};

const ctx = { logger: { info() {}, warn() {}, error() {} }, effect: (f) => (typeof f === "function" ? f() : undefined) };
const cfg = (over) => ({
  enabled: true, displayName: "", listenPort: 0, discoveryPort: 46190,
  multicastGroup: "239.255.77.75", passphrase: "", allowSameSubnet: true,
  manualPeers: "", askTimeoutMs: 3000, maxMessageChars: 8000, ...over,
});

const a = new LanPeersService(ctx, cfg({ displayName: "甲方", identitySuffix: "aaa" }));
const b = new LanPeersService(ctx, cfg({ displayName: "乙方", identitySuffix: "bbb" }));
a.patchFile = join(tmpdir(), "lan-peers-addr-a.yml");
b.patchFile = join(tmpdir(), "lan-peers-addr-b.yml");
await a.start();
await b.start();

// ── what the sender advertises ──────────────────────────────────────────
const identity = b.identityPayload();
check("the identity payload carries the port", identity.port === b.httpPort, JSON.stringify(identity));
check("the identity payload carries the address", typeof identity.ip === "string" && identity.ip !== "", JSON.stringify(identity));

// ── a: learn the peer from an inbound request, never having seen it ─────
a.peers.clear();
a.noteSource(b.identity.id, "127.0.0.1");
// B tells A; A has never discovered B before.
const told = await b.tell({ id: a.identity.id, name: a.displayName(), address: "127.0.0.1", httpPort: a.httpPort }, "hi");
check("B can tell A before any discovery", told.ok === true, JSON.stringify(told));

const learned = a.peers.get(b.identity.id);
check("A recorded the peer it was told by", Boolean(learned), JSON.stringify([...a.peers.keys()]));
check(
  "the learned peer has a dialable port",
  Number(learned?.httpPort) > 0,
  JSON.stringify({ httpPort: learned?.httpPort, address: learned?.address }),
);
check(
  "and a dialable address",
  typeof learned?.address === "string" && learned.address !== "",
  JSON.stringify(learned?.address),
);

// ── the point of the fix: a reply back must be addressable ─────────────
const replied = await a.tell({ id: b.identity.id, name: b.displayName(), address: learned.address, httpPort: learned.httpPort }, "reply");
check("A can reply to the peer that just spoke to it", replied.ok === true, JSON.stringify(replied));

// ── an existing portless row gets upgraded ─────────────────────────────
a.peers.clear();
a.rememberPeer({ id: b.identity.id, name: "stale", address: "127.0.0.1", httpPort: null });
await b.tell({ id: a.identity.id, name: a.displayName(), address: "127.0.0.1", httpPort: a.httpPort }, "again");
const upgraded = a.peers.get(b.identity.id);
check("a portless row is upgraded by inbound traffic", Number(upgraded?.httpPort) > 0, JSON.stringify({ p: upgraded?.httpPort }));

await a.stop();
await b.stop();
await rm(process.env.DSH_HOME, { recursive: true, force: true });
console.log(fails === 0 ? "\nADDRESS PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
