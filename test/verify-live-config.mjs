/** Verify the live config path end to end, outside the DSH host. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// js-yaml lives in the profile's node_modules, not in this package.
const requireFromProfile = createRequire("C:\\Users\\a5093\\.dsh\\profiles\\desktop\\package.json");
const yaml = requireFromProfile("js-yaml");

const cfgPath = "C:\\Users\\a5093\\.dsh\\profiles\\desktop\\cordis.patch.yml";
const docs = yaml.load(readFileSync(cfgPath, "utf8"));
const entry = docs.find((e) => e && e.id === "lan-peers");
console.log("config from profile:", JSON.stringify(entry.config));

process.env.DSH_HOME = "C:\\Users\\a5093\\.dsh";
const mod = await import(
  requireFromProfile("node:url").pathToFileURL(
    "C:\\Users\\a5093\\.dsh\\profiles\\desktop\\node_modules\\dsh-lan-peers\\lib\\index.js",
  ).href
);

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
process.exitCode = s.started && s.configProblems.length === 0 ? 0 : 1;
