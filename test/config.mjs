/**
 * Config-contract regression test.
 *
 * The plugin once declared its schema fields `.volatile()`, and the DSH host
 * then handed `apply()` an opaque `{}` for every field. `Number({})` is NaN and
 * `String({})` is "[object Object]", so the plugin started on a garbage port
 * with a "[object Object]" multicast group and every request failed. This test
 * pins the contract: usable values pass through, unusable ones are reported and
 * replaced by defaults — never silently coerced.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = await mkdtemp(join(tmpdir(), "lan-peers-config-"));
process.env.DSH_HOME = HOME;

const mod = await import("../lib/index.js");
const { coerceConfig } = await import("../lib/index.js").catch(() => ({ coerceConfig: null }));

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label} ${extra}`); }
};

const mkCtx = (warnings = []) => ({
  logger: { info() {}, warn: (...a) => warnings.push(a.join(" ")), error() {} },
  effect: (fn) => (typeof fn === "function" ? fn() : undefined),
  tools: { register() {} },
  // Services arrive through inject; this ctx offers none, which is fine for
  // config tests but does produce one "routes were NOT registered" notice.
  inject() {
    return () => {};
  },
});

const GOOD = {
  enabled: false,
  displayName: "",
  listenPort: 45715,
  discoveryPort: 45714,
  multicastGroup: "239.255.77.77",
  passphrase: "",
  allowSameSubnet: true,
  manualPeers: "",
  askTimeoutMs: 120000,
  maxMessageChars: 8000,
};

// ── the well-formed case ────────────────────────────────────────────────
{
  const warnings = [];
  const svc = mod.apply(mkCtx(warnings), GOOD);
  await new Promise((r) => setTimeout(r, 80));
  check("well-formed config produces no problems", (svc.configProblems || []).length === 0, JSON.stringify(svc.configProblems));
  check("no config warning for a clean config", !warnings.some((w) => w.includes("unusable field")), warnings.join(" | "));
  check("ports survive verbatim", svc.cfg.discoveryPort === 45714 && svc.cfg.listenPort === 45715, JSON.stringify({ d: svc.cfg.discoveryPort, l: svc.cfg.listenPort }));
  check("multicast group survives as a string", svc.cfg.multicastGroup === "239.255.77.77", String(svc.cfg.multicastGroup));
  await svc.stop();
}

// ── the shape that actually broke: an opaque reference object per field ──
{
  const warnings = [];
  const opaque = {};
  for (const key of Object.keys(GOOD)) opaque[key] = {};
  const svc = mod.apply(mkCtx(warnings), opaque);
  await new Promise((r) => setTimeout(r, 80));

  check("opaque fields are reported", (svc.configProblems || []).length > 0, JSON.stringify(svc.configProblems));
  check("a warning names the unusable fields", warnings.some((w) => w.includes("unusable field")), warnings.join(" | "));
  check(
    "ports fall back to real numbers, never NaN",
    Number.isFinite(svc.cfg.discoveryPort) && Number.isFinite(svc.cfg.listenPort) &&
      svc.cfg.discoveryPort === 45714 && svc.cfg.listenPort === 45715,
    JSON.stringify({ d: svc.cfg.discoveryPort, l: svc.cfg.listenPort }),
  );
  check(
    "multicast group is never '[object Object]'",
    svc.cfg.multicastGroup !== "[object Object]" && svc.cfg.multicastGroup === "239.255.77.77",
    String(svc.cfg.multicastGroup),
  );
  check(
    "an object never counts as `enabled: true`",
    svc.cfg.enabled === false,
    String(svc.cfg.enabled),
  );
  check("start stays off for an opaque config", svc.started === false, String(svc.started));
  check("status exposes the problems", Array.isArray(svc.status().configProblems) && svc.status().configProblems.length > 0);
  await svc.stop();
}

// ── individual bad values ───────────────────────────────────────────────
{
  const cases = [
    ["listenPort as a string", { ...GOOD, listenPort: "45715" }, "listenPort"],
    ["discoveryPort out of range", { ...GOOD, discoveryPort: 70000 }, "discoveryPort"],
    ["discoveryPort as NaN", { ...GOOD, discoveryPort: Number.NaN }, "discoveryPort"],
    ["askTimeoutMs negative", { ...GOOD, askTimeoutMs: -1 }, "askTimeoutMs"],
    ["multicastGroup as a number", { ...GOOD, multicastGroup: 1234 }, "multicastGroup"],
    ["passphrase as an object", { ...GOOD, passphrase: { secret: "x" } }, "passphrase"],
    ["enabled as a string", { ...GOOD, enabled: "yes" }, "enabled"],
  ];
  for (const [label, config, field] of cases) {
    const warnings = [];
    const svc = mod.apply(mkCtx(warnings), config);
    await new Promise((r) => setTimeout(r, 40));
    const problems = svc.configProblems || [];
    check(`${label} is reported as a problem`, problems.some((p) => p.startsWith(field + ":")), JSON.stringify(problems));
    check(`${label} leaves a usable ${field}`, (
      field === "multicastGroup" ? typeof svc.cfg[field] === "string" && svc.cfg[field] !== "[object Object]"
        : field === "passphrase" ? typeof svc.cfg[field] === "string"
          : field === "enabled" ? typeof svc.cfg[field] === "boolean"
            : Number.isFinite(svc.cfg[field]) && svc.cfg[field] > 0
    ), String(svc.cfg[field]));
    await svc.stop();
  }
}

// ── the schema must not opt back into volatile ──────────────────────────
{
  const src = (await import("node:fs")).readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  const schemaBlock = src.slice(src.indexOf("export const Config"), src.indexOf("/** The subset of config"));
  check("schema no longer uses .volatile()", !schemaBlock.includes(".volatile()"), "a volatile field arrives as an opaque reference");
}

await rm(HOME, { recursive: true, force: true });
console.log(fails === 0 ? "\nCONFIG PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
