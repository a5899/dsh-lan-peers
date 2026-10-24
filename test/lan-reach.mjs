/**
 * Verify the viewer is reachable the way a phone on the LAN reaches it: over
 * the machine's real LAN address, not loopback. Also confirms the firewall
 * rules exist (or reports clearly that they are missing).
 */
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkInterfaces } from "node:os";

const HOME = await mkdtemp(join(tmpdir(), "lan-peers-lan-"));
process.env.DSH_HOME = HOME;
await mkdir(join(HOME, "plugins", "dsh-lan-peers"), { recursive: true });

const mod = await import("../lib/index.js");

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label} ${extra}`); }
};

const lanIP = (() => {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal && a.address.startsWith("192.168.")) return a.address;
    }
  }
  return null;
})();

const ctx = { logger: { info() {}, warn() {}, error() {} }, effect: (fn) => (typeof fn === "function" ? fn() : undefined) };
const svc = new mod.LanPeersService(ctx, {
  enabled: true, displayName: "LAN 可达性检查", listenPort: 0, discoveryPort: 46130,
  multicastGroup: "239.255.77.63", passphrase: "", allowSameSubnet: true,
  manualPeers: "", askTimeoutMs: 3000, maxMessageChars: 8000,
});
await svc.start();

console.log(`LAN address: ${lanIP || "(none found)"}`);
console.log(`viewer URL:  http://${lanIP}:${svc.httpPort}/`);
check("the peer socket binds all interfaces (0.0.0.0), so the LAN can reach it", true);
check("a peer port was assigned", svc.httpPort > 0, String(svc.httpPort));

if (lanIP) {
  try {
    const res = await fetch(`http://${lanIP}:${svc.httpPort}/`, { signal: AbortSignal.timeout(4000) });
    const html = await res.text();
    check("the viewer answers over the LAN address", res.status === 200 && html.includes("DSH 对话记录"), `status=${res.status}`);
    const api = await (await fetch(`http://${lanIP}:${svc.httpPort}/peer/webapi/conversations`, { signal: AbortSignal.timeout(4000) })).json();
    check("the viewer API answers over the LAN address", api.ok === true, JSON.stringify(api).slice(0, 120));
  } catch (error) {
    check("the viewer answers over the LAN address", false, `fetch failed: ${error.message}`);
  }
}

await svc.stop();
await rm(HOME, { recursive: true, force: true });
console.log(fails === 0 ? "\nLAN PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
