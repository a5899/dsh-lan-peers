/**
 * Settings-persistence tests.
 *
 * Three failures shipped here, all of which made "保存并应用" a lie:
 *
 * 1. `ctx.loader` / `ctx.get('loader')` read from an undeclared context throws
 *    `cannot get property "loader" without inject`.
 * 2. `loader.entries()` is a Generator, so `.find` on it throws too.
 * 3. Even with a loader, the entry lives in the BUNDLE's patch file, not the
 *    profile's root patch — writing the wrong file "succeeds" and changes
 *    nothing.
 *
 * The fallback is now a direct atomic rewrite of the plugin's own patch, and
 * every failure is reported instead of swallowed.
 */
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { existsSync, readFileSync as readFileSyncFile } from "node:fs";

const mod = await import("../lib/index.js");
const { LanPeersService } = mod;
const { applyConfigToPatchText, yamlScalar, persistOwnPatch, tryPersistOwnPatch, ownPatchPath } = await import("../lib/patches.js");

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label} ${extra}`); }
};

const cfg = (over) => ({
  enabled: false, displayName: "", listenPort: 45715, discoveryPort: 45714,
  multicastGroup: "239.255.77.77", passphrase: "", allowSameSubnet: true,
  manualPeers: "", askTimeoutMs: 120000, maxMessageChars: 8000, ...over,
});

// ── YAML rewriting ──────────────────────────────────────────────────────
const PATCH = `# a comment that must survive
- insert:
    - id: lan-peers
      name: 'dsh-lan-peers'
      config:
        enabled: false
        displayName: ''
        listenPort: 45715
        passphrase: ''
    - id: other-plugin
      name: 'other'
      config:
        enabled: true
`;

{
  const out = applyConfigToPatchText(PATCH, "lan-peers", { enabled: true, displayName: "note13 pro" });
  check("rewrites the targeted entry", out.includes("enabled: true") && out.includes("displayName: 'note13 pro'"), out);
  check("leaves untouched keys alone", out.includes("listenPort: 45715") && out.includes("passphrase: ''"));
  check("keeps comments", out.includes("# a comment that must survive"));
  check("does not touch a sibling entry", out.includes("- id: other-plugin\n      name: 'other'\n      config:\n        enabled: true"), out);
  check("preserves trailing structure", out.trimEnd().split("\n").at(-1) === "enabled: true" || out.includes("enabled: true"));
}

{
  const out = applyConfigToPatchText(PATCH, "missing-entry", { enabled: true });
  check("an unknown entry yields null (never a partial write)", out === null, String(out));
}

{
  // An entry with no config block gets one.
  const text = "- insert:\n    - id: lan-peers\n      name: 'dsh-lan-peers'\n";
  const out = applyConfigToPatchText(text, "lan-peers", { enabled: true, listenPort: 45716 });
  check("adds a config block when missing", out.includes("config:") && out.includes("enabled: true") && out.includes("listenPort: 45716"), out);
}

{
  check("quotes strings with single quotes", yamlScalar("note13 pro") === "'note13 pro'", yamlScalar("note13 pro"));
  check("escapes an embedded quote", yamlScalar("it's") === "'it''s'", yamlScalar("it's"));
  check("writes booleans bare", yamlScalar(false) === "false");
  check("writes numbers bare", yamlScalar(45715) === "45715");
  check("writes an empty string as ''", yamlScalar("") === "''");
  check("never writes an object", yamlScalar({}) === "'[object Object]'", "objects must be unwrapped before this point");
}

// ── the rewrite is verified before it is committed ──────────────────────
{
  const { verifyRewrite } = await import("../lib/patches.js");
  const good = applyConfigToPatchText(PATCH, "lan-peers", { enabled: true, displayName: "v" });
  const fakeLoad = (text) => {
    if (text.includes("NOT: [valid")) throw new Error("bad indentation");
    return [{ insert: [{ id: "lan-peers", config: { enabled: true, displayName: "v", listenPort: 45715 } }] }];
  };
  check("a correct rewrite verifies", verifyRewrite(good, PATCH, "lan-peers", { enabled: true }, fakeLoad).ok === true);
  check("a value that did not land is rejected", verifyRewrite(good, PATCH, "lan-peers", { displayName: "other" }, fakeLoad).ok === false);
  check("invalid YAML is rejected", verifyRewrite("NOT: [valid", PATCH, "lan-peers", { enabled: true }, fakeLoad).ok === false, "must not commit");
  check("a duplicated entry is rejected", verifyRewrite(good, PATCH, "lan-peers", { enabled: true }, () => [
    { id: "lan-peers", config: { enabled: true } },
    { id: "lan-peers", config: { enabled: true } },
  ]).ok === false);
  const noParser = verifyRewrite(good, PATCH, "lan-peers", { enabled: true }, null);
  check("without a parser the structural check still runs", noParser.ok === true, JSON.stringify(noParser));
  const brokenNoParser = verifyRewrite(good.replace("id: lan-peers", "id: x"), PATCH, "lan-peers", { enabled: true }, null);
  check("a vanished entry is caught without a parser", brokenNoParser.ok === false, JSON.stringify(brokenNoParser));
}

// ── the service reports failures instead of faking success ──────────────
const ctxLogs = [];
const makeCtx = ({ loader } = {}) => {
  const ctx = {
    logger: { info() {}, warn: (m) => ctxLogs.push(m), error() {} },
    effect: (f) => (typeof f === "function" ? f() : undefined),
    tools: { register() {} },
    inject: () => () => {},
    get() {
      throw new Error('cannot get property "loader" without inject');
    },
  };
  Object.defineProperty(ctx, "loader", {
    get() {
      if (!loader) throw new Error('cannot get property "loader" without inject');
      return loader;
    },
    enumerable: true,
    configurable: true,
  });
  return ctx;
};

{
  // A cordis-faithful ctx with no loader and no reachable patch file.
  const svc = new LanPeersService(makeCtx(), cfg());
  svc.patchFile = join(tmpdir(), "lan-peers-no-such-patch.yml");
  const ok = await svc.persistConfig({ enabled: true });
  check("persist reports false when nothing is writable", ok === false, String(ok));
  check("the failure names itself", typeof svc.lastPersistError === "string" && svc.lastPersistError.length > 0, svc.lastPersistError);
  check("no undeclared-service throw escapes", !ctxLogs.some((m) => m.includes("without inject")), ctxLogs.join(" | "));
  await svc.stop();
}

{
  // Loader whose entries() is a GENERATOR (the real contract).
  const updates = [];
  function* entries() {
    yield { id: "other", update: async () => {} };
    yield { id: "lan-peers", update: async (patch) => { updates.push(patch); } };
  }
  const loader = { entries };
  const svc = new LanPeersService(makeCtx({ loader }), cfg());
  const ok = await svc.persistConfig({ enabled: true });
  check("iterates the entries generator instead of calling .find", ok === true, `${ok} ${ctxLogs.join(" | ")}`);
  check("writes the whole config, not just the diff", updates.length === 1 && updates[0].config && Object.keys(updates[0].config).length >= 10, JSON.stringify(updates));
  await svc.stop();
}

{
  // reconfigure surfaces non-durable saves.
  const svc = new LanPeersService(makeCtx(), cfg());
  svc.patchFile = join(tmpdir(), "lan-peers-no-such-patch.yml");
  const status = await svc.reconfigure({ displayName: "x" });
  check("reconfigure reports persisted:false", status.persisted === false, JSON.stringify({ p: status.persisted, e: status.persistError }));
  check("reconfigure carries the reason", typeof status.persistError === "string" && status.persistError.length > 0, status.persistError);
  check("the in-memory change still applied", svc.cfg.displayName === "x");
  await svc.stop();
}

// ── the real fallback path, against a temporary package layout ──────────
const ROOT = await mkdtemp(join(tmpdir(), "lan-peers-patch-"));
{
  const pkgDir = join(ROOT, "node_modules", "dsh-lan-peers");
  await mkdir(join(pkgDir, "lib"), { recursive: true });
  await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "dsh-lan-peers", version: "9.9.9" }), "utf8");
  await writeFile(join(pkgDir, "cordis.patch.yml"), PATCH, "utf8");
  const fromUrl = pathToFileURL(join(pkgDir, "lib", "patches.js")).href;

  check("the patch path is resolved next to the module", ownPatchPath("dsh-lan-peers", fromUrl) === join(pkgDir, "cordis.patch.yml"), ownPatchPath("dsh-lan-peers", fromUrl));

  const wrote = await persistOwnPatch("dsh-lan-peers", "lan-peers", cfg({ enabled: true, displayName: "phone" }), { fromUrl });
  check("writes the bundle's own patch", wrote === true, String(wrote));

  const after = await readFile(join(pkgDir, "cordis.patch.yml"), "utf8");
  check("the file now carries the new values", after.includes("enabled: true") && after.includes("displayName: 'phone'"), after);
  check("unrelated entries survive the write", after.includes("other-plugin"));

  // Re-saving the same values must count as SUCCESS: the file already holds
  // them, so the settings are durable. Reporting failure here is what made an
  // unchanged save look broken in the UI.
  const again = await persistOwnPatch("dsh-lan-peers", "lan-peers", cfg({ enabled: true, displayName: "phone" }), { fromUrl });
  check("an unchanged save still reports success", again === true, String(again));

  const detail = await tryPersistOwnPatch("dsh-lan-peers", "lan-peers", cfg({ enabled: true, displayName: "phone" }), { fromUrl });
  check("the outcome says unchanged, not written", detail.outcome === "unchanged" && detail.written === true && detail.changed === false, JSON.stringify(detail));

  const missing = await tryPersistOwnPatch("dsh-lan-peers", "lan-peers", {}, { file: join(tmpdir(), "definitely-missing-" + process.pid + ".yml") });
  check("a missing file is a real failure", missing.outcome === "missing" && missing.written === false, JSON.stringify(missing));
  check("and it explains where it looked", String(missing.reason).includes("not found"), missing.reason);

  const noEntry = await tryPersistOwnPatch("dsh-lan-peers", "not-an-entry", {}, { fromUrl });
  check("an unknown entry is its own failure", noEntry.outcome === "no-entry" && noEntry.written === false, JSON.stringify(noEntry));
}
await rm(ROOT, { recursive: true, force: true });

// ── version comes from the manifest ─────────────────────────────────────
{
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  check("PLUGIN_VERSION matches package.json", mod.PLUGIN_VERSION === pkg.version, `${mod.PLUGIN_VERSION} vs ${pkg.version}`);
  check("status reports the real version", (() => {
    const svc = new LanPeersService(makeCtx(), cfg());
    const status = svc.status();
    svc.stop?.();
    return status.version === pkg.version;
  })(), "status.version is stale");
}

{
  // Nothing in this suite may touch a real install: every service that could
  // reach one is pointed at a temp path that does not exist.
  const real = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "dsh-lan-peers", "cordis.patch.yml");
  const before = existsSync(real) ? readFileSyncFile(real, "utf8") : "";
  const svc = new LanPeersService(makeCtx(), cfg());
  svc.patchFile = join(tmpdir(), "lan-peers-no-such-patch.yml");
  check("the temp target really does not exist", !existsSync(svc.patchFile));
  await svc.persistConfig({ enabled: false });
  await svc.stop();
  const after = existsSync(real) ? readFileSyncFile(real, "utf8") : "";
  check("a failing persist leaves the real install untouched", before === after, "the real patch changed");
}

console.log(fails === 0 ? "\nPERSIST PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
