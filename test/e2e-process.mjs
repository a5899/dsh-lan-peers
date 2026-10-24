/**
 * Cross-process proof: starts a *separate* Node process running the installed
 * plugin as a peer, then asks and tells it from this process through the
 * plugin's real service and tools, exactly as the live agent would.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NODE = process.execPath;
const PLUGIN_DIR = "C:\\Users\\a5093\\.dsh\\profiles\\desktop\\node_modules\\dsh-lan-peers";
const HOME = await mkdtemp(join(tmpdir(), "lan-peers-e2e-"));
const AWAIT_MS = 25_000;

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label} ${extra}`); }
};

// --- start the remote peer as its own process ---------------------------
const peerScript = `
import { createServer } from "node:http";
const mod = await import(${JSON.stringify(`file:///${PLUGIN_DIR.replace(/\\/g, "/")}/lib/index.js`)});
process.env.DSH_HOME = ${JSON.stringify(HOME)};

const registered = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect: (fn) => (typeof fn === "function" ? fn() : undefined),
  tools: { register: (t) => registered.push(t) },
  webServer: { register: () => () => {} },
};
const svc = mod.apply(ctx, {
  // keep every write inside the temp home
  enabled: true, displayName: "REMOTE-PEER", listenPort: 0, discoveryPort: 46030,
  multicastGroup: "239.255.77.60", passphrase: "e2e-secret", allowSameSubnet: true,
  manualPeers: "", askTimeoutMs: 8000, maxMessageChars: 8000,
});
svc.patchFile = process.env.DSH_HOME + "/never-written.yml";
await new Promise((r) => setTimeout(r, 300));
process.stdout.write("PEER_READY " + svc.httpPort + " " + svc.identity.id + "\\n");
// Stay alive until the parent closes stdin.
process.stdin.resume();
process.stdin.on("end", async () => { await svc.stop(); process.exit(0); });
`;
const peer = spawn(NODE, ["--input-type=module", "-e", peerScript], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, DSH_HOME: HOME },
});

let peerPort = 0;
let peerId = "";
const peerErr = [];
peer.stderr.on("data", (d) => peerErr.push(String(d)));
const ready = new Promise((resolve) => {
  let buffer = "";
  peer.stdout.on("data", (d) => {
    buffer += String(d);
    const m = /PEER_READY (\d+) (\S+)/.exec(buffer);
    if (m) { peerPort = Number(m[1]); peerId = m[2]; resolve(true); }
  });
  setTimeout(() => resolve(false), AWAIT_MS);
});

console.log("cross-process e2e");
const up = await ready;
check("remote peer process started and bound a port", up && peerPort > 0, `port=${peerPort} err=${peerErr.join("").slice(0, 200)}`);

if (up) {
  // --- this side: the installed plugin, same config family --------------
  process.env.DSH_HOME = join(HOME, "local");
  const mod = await import(`file:///${PLUGIN_DIR.replace(/\\/g, "/")}/lib/index.js`);
  const registered = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (fn) => (typeof fn === "function" ? fn() : undefined),
    tools: { register: (t) => registered.push(t) },
    webServer: { register: () => () => {} },
  };
  // Start disabled: the tool must refuse to act.
  const local = mod.apply(ctx, {
    enabled: false, displayName: "LOCAL-ASKER", listenPort: 0, discoveryPort: 46031,
    multicastGroup: "239.255.77.60", passphrase: "e2e-secret", allowSameSubnet: true,
    manualPeers: "", askTimeoutMs: 8000, maxMessageChars: 8000,
  });
  local.patchFile = join(HOME, "local-never-written.yml");
  await new Promise((r) => setTimeout(r, 120));
  const askTool = registered.find((t) => t.name === "lan_peer_ask");
  const tellTool = registered.find((t) => t.name === "lan_peer_tell");

  const refuse = await askTool.execute({ question: "hi" });
  check("disabled install refuses to contact anyone", refuse.includes("关闭"), refuse.slice(0, 80));

  // Enable it, pointed at the remote peer.
  await local.reconfigure({ enabled: true, passphrase: "e2e-secret", manualPeers: `127.0.0.1:${peerPort}` });
  await new Promise((r) => setTimeout(r, 150));
  local.noteSource(peerId, "127.0.0.1");
  local.rememberPeer({ id: peerId, name: "REMOTE-PEER", host: "remote", httpPort: peerPort, address: "127.0.0.1" });

  const state = await registered.find((t) => t.name === "lan_peer_state").execute({});
  check("state shows the remote process as a peer", state.includes("REMOTE-PEER"), state.slice(0, 200));

  const answer = await askTool.execute({ peer: "REMOTE-PEER", question: "版本" });
  // Assert the success shape specifically: the failure path also mentions the
  // peer name, so a loose regex would pass on a refusal (caught in review).
  check(
    "ask reaches the other PROCESS and returns its answer",
    answer.startsWith("「REMOTE-PEER」的回答") && !answer.includes("失败"),
    answer.slice(0, 220),
  );

  const told = await tellTool.execute({ peer: "REMOTE-PEER", message: "hello from the e2e test" });
  check("tell reaches the other PROCESS", told.includes("已把信息发送给") && !told.includes("失败"), told.slice(0, 160));

  // Wrong passphrase must fail closed: the remote refuses with a mismatch.
  await local.reconfigure({ passphrase: "wrong-secret" });
  const bad = await askTool.execute({ peer: "REMOTE-PEER", question: "版本" });
  check("wrong passphrase is refused end to end", bad.includes("passphrase-mismatch"), bad.slice(0, 160));

  // A shared passphrase authorizes the peer without any manual approval.
  await local.reconfigure({ passphrase: "e2e-secret" });
  const withoutApproval = await askTool.execute({ peer: "REMOTE-PEER", question: "你是谁" });
  check("shared passphrase authorizes without an approval", withoutApproval.startsWith("「REMOTE-PEER」的回答"), withoutApproval.slice(0, 200));

  await local.stop();
}

peer.stdin.end();
await new Promise((r) => setTimeout(r, 400));
try { peer.kill(); } catch { /* already gone */ }
await rm(HOME, { recursive: true, force: true });
console.log(fails === 0 ? "\nE2E PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
