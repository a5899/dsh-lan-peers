/** Verify the live config path end to end, outside the DSH host. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

// js-yaml lives in the profile's node_modules, not in this package.
const home = process.env.DSH_HOME || join(homedir(), ".dsh");
const profile = process.env.DSH_PROFILE || "desktop";
const profileDir = join(home, "profiles", profile);
let yaml;
try {
  yaml = createRequire(join(profileDir, "package.json"))("js-yaml");
} catch (error) {
  console.log("SKIP: js-yaml is only present in a DSH profile:", error.message);
  process.exitCode = 0;
  process.exit?.();
}

const cfgPath = join(profileDir, "cordis.patch.yml");
const docs = yaml.load(readFileSync(cfgPath, "utf8"));
const entry = docs.find((e) => e && e.id === "lan-peers");
console.log("config from profile:", JSON.stringify(entry.config));

process.env.DSH_HOME = "C:\\Users\\a5093\\.dsh";
const mod = await import(new URL("../lib/index.js", import.meta.url).href);

const registered = [];
const ctx = {
  logger: { info() {}, warn: (...a) => console.log("WARN:", ...a), error() {} },
  effect: (fn) => (typeof fn === "function" ? fn() : undefined),
  tools: { register: (t) => registered.push(t) },
  webServer: { register: () => () => {} },
};

const svc = mod.apply(ctx, entry.config);
await new Promise((r) => setTimeout(r, 800));
const s = svc.status();
console.log("started:", s.started, "| discoveryPort:", s.discoveryPort, "| listenPort:", s.listenPort);
console.log("multicastGroup:", s.multicastGroup);
console.log("configProblems:", JSON.stringify(s.configProblems));
console.log("enabled:", s.enabled, "| tools:", registered.map((t) => t.name).join(","));

// Do a real scan to prove the wiring works.
const discover = registered.find((t) => t.name === "lan_peer_discover");
const text = await discover.execute({ windowMs: 1200 });
console.log("discover output:", text.split("\n")[0]);

await svc.stop();

// Ports already held by a running DSH are an expected skip, not a failure.
const busy = !s.started && String(s.startError || "").includes("EADDRINUSE");
if (busy) {
  console.log("SKIP: the plugin ports are already in use (a DSH is running) — that is expected.");
  process.exitCode = 0;
} else {
  process.exitCode = s.started && s.configProblems.length === 0 ? 0 : 1;
}
