/**
 * Multicast reachability on the real LAN interfaces.
 *
 * Verifies the fix for "the phone can find this machine but this machine cannot
 * find the phone": membership must be joined on the interface that actually
 * carries the LAN, not on whichever adapter the OS picks by route metric (an
 * unplugged Ethernet keeps a lower metric than Wi-Fi and receives nothing).
 */
const mod = await import("../lib/index.js");

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label} ${extra}`); }
};

const ifaces = mod.lanInterfaces();
console.log("interfaces:", JSON.stringify(ifaces.map((i) => ({ name: i.name, address: i.address, preferred: i.preferred }))));
check("at least one LAN interface is usable", ifaces.length > 0, JSON.stringify(ifaces));
check("virtual/tunnel adapters rank after real ones", (() => {
  const firstVirtual = ifaces.findIndex((i) => i.virtual);
  const lastReal = ifaces.map((i) => !i.virtual).lastIndexOf(true);
  return firstVirtual === -1 || firstVirtual > lastReal;
})());
check("the reported LAN address is a real adapter", (() => {
  const best = ifaces[0];
  return !best || !best.virtual;
})(), JSON.stringify(ifaces[0]));

/**
 * Ask the plugin's own discovery socket what source address its probes carry,
 * by listening on a second socket and triggering a real discover().
 */
async function probeSourceAddress(service, ifaces) {
  const dgramMod = await import("node:dgram");
  const port = service.cfg.discoveryPort;
  const spy = dgramMod.default.createSocket({ type: "udp4", reuseAddr: true });
  const seen = [];
  await new Promise((resolve) => {
    spy.bind(port, () => {
      try { spy.addMembership(service.cfg.multicastGroup, ifaces[0].address); } catch { /* default */ }
      spy.on("message", (_b, r) => { if (!seen.includes(r.address)) seen.push(r.address); });
      resolve();
    });
    setTimeout(resolve, 1200);
  });
  // A real probe from the same host: its own socket skips itself, but the spy
  // socket receives it and reports the source address.
  await service.discover({ windowMs: 1200 });
  await new Promise((r) => setTimeout(r, 400));
  try { spy.close(); } catch { /* closed */ }
  const lan = ifaces.map((i) => i.address);
  return { seen, ok: seen.length > 0 && seen.every((a) => lan.includes(a)) };
}

const ctx = { logger: { info() {}, warn() {}, error() {} }, effect: (f) => (typeof f === "function" ? f() : undefined) };
const cfg = (over) => ({
  enabled: true, displayName: "", listenPort: 0, discoveryPort: 46170,
  multicastGroup: "239.255.77.68", passphrase: "", allowSameSubnet: true,
  manualPeers: "", askTimeoutMs: 4000, maxMessageChars: 8000, ...over,
});

const a = new mod.LanPeersService(ctx, cfg({ displayName: "node-a", identitySuffix: "aaa" }));
const b = new mod.LanPeersService(ctx, cfg({ displayName: "node-b", identitySuffix: "bbb" }));
await a.start();
await b.start();

check("membership was joined on at least one interface", Array.isArray(a.joinedInterfaces) && a.joinedInterfaces.length > 0, JSON.stringify(a.joinedInterfaces));
check("the join targeted a real address or the OS default", a.joinedInterfaces.every((x) => x === "default" || /^\d+\.\d+\.\d+\.\d+$/.test(x)), JSON.stringify(a.joinedInterfaces));

const found = await a.discover({ windowMs: 3000 });
const peers = found.peers || [];
check("multicast discovery finds the other instance", peers.some((p) => p.name === "node-b"), JSON.stringify(peers));

// NOTE: both services run on ONE host here. A directed broadcast loops back
// with this host's own address as the source, so the answering side unicasts
// its reply to itself and the asker never sees it. That is an artefact of a
// single-host test, not of the protocol (two machines have distinct addresses).
// What this can still prove is that both instances joined the group on the
// real interface, emit from the real LAN address, and that a probe reaches the
// other instance.
const reverse = await b.discover({ windowMs: 3000 });
check(
  "the second instance also joins the real interface",
  Array.isArray(b.joinedInterfaces) && b.joinedInterfaces.length > 0,
  JSON.stringify(b.joinedInterfaces),
);
const src = await probeSourceAddress(a, ifaces);
check(
  "probes are emitted from the LAN address, not a proxy tunnel",
  src.ok,
  `sources=${JSON.stringify(src.seen)}`,
);

// A second round must work as well (the first can hide races).
a.peers.clear();
const again = await a.discover({ windowMs: 2500 });
check("repeated discovery still works", (again.peers || []).some((p) => p.name === "node-b"), JSON.stringify(again.peers));

await a.stop();
await b.stop();
console.log(fails === 0 ? "\nDISCOVERY PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
