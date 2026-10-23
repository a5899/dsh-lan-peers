/** Static contract check for the browser half (lib/client.js). */
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const checks = [
  ["ModuleLoader.load wrapper", src.includes("window.__ModuleLoader__.load({")],
  ["module id matches the package", src.includes('id: "dsh-lan-peers"')],
  ["factory takes require", src.includes("factory: (require) =>")],
  ["registers into plugins.item", src.includes('ctx.slots.register(') && src.includes('name: "plugins.item"')],
  ["injects into plugins.item", src.includes('ctx.slots.inject("plugins.item"')],
  ["unique slot id", src.includes('id: "lan-peers"')],
  ["label is a function (official page pattern)", src.includes("label: () => COPY.title")],
  ["talks to the host route prefix", src.includes('API = "/api/lan-peers/"')],
  ["uses react.createElement only (no JSX)", !/<[A-Z][A-Za-z]*\s/.test(src)],
  ["handles failure without throwing", src.includes("catch (error)") && src.includes("console.warn")],
];

let fails = 0;
for (const [label, ok] of checks) {
  if (ok) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label}`); }
}
console.log(fails === 0 ? "\nCLIENT CONTRACT PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
