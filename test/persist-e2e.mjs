/**
 * End-to-end persistence against a realistic profile layout.
 *
 * Builds a throwaway `<profile>/node_modules/<name>/` tree, applies the plugin to
 * a cordis-faithful context whose loader is unreachable (the real situation),
 * saves settings through the HTTP route, and then re-reads the patch the way a
 * restart would — proving the value survives rather than merely living in RAM.
 */
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = await mkdtemp(join(tmpdir(), "lan-peers-e2e-persist-"));
process.env.DSH_HOME = join(ROOT, "home");

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label} ${extra}`); }
};

const PKG = "dsh-lan-peers";
const pkgDir = join(ROOT, "profile", "node_modules", PKG);
await mkdir(join(pkgDir, "lib"), { recursive: true });
await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: PKG, version: "1.1.2" }), "utf8");

const PATCH = `# dsh-lan-peers bundle layer.
- insert:
    - id: lan-peers
      name: 'dsh-lan-peers'
      config:
        enabled: false
        displayName: ''
        listenPort: 45715
        discoveryPort: 45714
        multicastGroup: 239.255.77.77
        passphrase: ''
        allowSameSubnet: true
        manualPeers: ''
        askTimeoutMs: 120000
        maxMessageChars: 8000
`;
await writeFile(join(pkgDir, "cordis.patch.yml"), PATCH, "utf8");

const mod = await import("../lib/index.js");
const { persistOwnPatch } = await import("../lib/patches.js");
const patchesUrl = pathToFileURL(join(pkgDir, "lib", "patches.js")).href;

const cfg = {
  enabled: false, displayName: "", listenPort: 45715, discoveryPort: 46140,
  multicastGroup: "239.255.77.64", passphrase: "", allowSameSubnet: true,
  manualPeers: "", askTimeoutMs: 5000, maxMessageChars: 8000,
};

// A ctx that denies `loader` and `connection` reads, like the real host does
// for dependencies the plugin did not declare.
const routes = new Map();
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect: (f) => (typeof f === "function" ? f() : undefined),
  tools: { register() {} },
  inject: () => () => {},
  get(name) {
    throw new Error(`cannot get property "${name}" without inject`);
  },
};
Object.defineProperty(ctx, "loader", {
  get() { throw new Error('cannot get property "loader" without inject'); },
  enumerable: true,
  configurable: true,
});
Object.defineProperty(ctx, "connection", {
  get() {
    return {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    };
  },
  enumerable: true,
  configurable: true,
});

const svc = mod.apply(ctx, cfg);
// Point the service at the throwaway patch, exactly where a real install has it.
svc.patchFile = join(pkgDir, "cordis.patch.yml");
await new Promise((r) => setTimeout(r, 120));

check("routes were registered", routes.size === 8, `routes=${routes.size}`);

const route = routes.get("/api/lan-peers/settings");
const call = (payload) => route.fetch(new Request("http://127.0.0.1:1/api/lan-peers/settings", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
})).then((r) => r.json());

// ── save a value ────────────────────────────────────────────────────────
const saved = await call({ ...cfg, enabled: true, displayName: "note13 pro" });
check("POST settings succeeds", saved.ok === true, JSON.stringify(saved).slice(0, 160));
check("the response reports the save as durable", saved.status?.persisted === true, JSON.stringify(saved.status?.persisted));

const afterSave = await readFile(join(pkgDir, "cordis.patch.yml"), "utf8");
check("the patch file carries the new display name", afterSave.includes("displayName: 'note13 pro'"), afterSave);
check("the patch file carries the new enabled flag", /enabled: true/.test(afterSave), afterSave);
check("untouched fields keep their values", afterSave.includes("listenPort: 45715") && afterSave.includes("askTimeoutMs: 5000"), afterSave);
check("comments survive the write", afterSave.startsWith("# dsh-lan-peers bundle layer."));

// ── what a restart reads ────────────────────────────────────────────────
const restarted = (() => {
  // Minimal parse of the entry's config block, the way a human would read it.
  const lines = afterSave.split("\n");
  const start = lines.findIndex((l) => /id: lan-peers/.test(l));
  const configStart = lines.findIndex((l, i) => i > start && /config:/.test(l));
  const out = {};
  for (let i = configStart + 1; i < lines.length; i += 1) {
    const m = /^\s+([A-Za-z]+):\s*(.*)$/.exec(lines[i]);
    if (!m) break;
    let v = m[2].trim();
    if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    if (v === "true") v = true;
    else if (v === "false") v = false;
    else if (/^\d+$/.test(v)) v = Number(v);
    out[m[1]] = v;
  }
  return out;
})();
check("a restart would read back displayName", restarted.displayName === "note13 pro", JSON.stringify(restarted));
check("a restart would read back enabled", restarted.enabled === true, JSON.stringify(restarted));
check("a restart would read back the ports", restarted.listenPort === 45715 && restarted.discoveryPort === 46140, JSON.stringify(restarted));

// ── an unwritable target must be reported, not hidden ───────────────────
svc.patchFile = join(ROOT, "no-such-dir", "nope.yml");
const broken = await call({ ...cfg, displayName: "lost" });
check("an unwritable target still answers ok", broken.ok === true, JSON.stringify(broken).slice(0, 120));
check("but reports persisted:false", broken.status?.persisted === false, JSON.stringify(broken.status?.persisted));
check("and explains why", typeof broken.status?.persistError === "string" && broken.status.persistError.length > 0, broken.status?.persistError);

await svc.stop();
await rm(ROOT, { recursive: true, force: true });
console.log(fails === 0 ? "\nE2E PERSIST PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
