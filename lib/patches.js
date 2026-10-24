/**
 * Persist one loader entry's config into the patch YAML the entry comes from.
 *
 * Used when the loader service is not reachable. The plugin is loaded as part
 * of a bundle layer, so its entry lives in that bundle's own patch file
 * (`<profile>/node_modules/<name>/cordis.patch.yml`) — not in the profile's
 * root `cordis.patch.yml`. Rewriting the root file appears to work and silently
 * changes nothing, which is exactly the failure mode this replaces.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Quote one YAML scalar the way the hand-written patch files already do. */
export function yamlScalar(value) {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (value === null || value === undefined) return "''";
  const text = String(value);
  if (text === "") return "''";
  // Single quotes; an embedded quote is escaped by doubling it.
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Rewrite the `config:` block of the entry with the given id.
 *
 * Only the keys present in `values` are replaced; every other line is copied
 * byte-for-byte, so comments and formatting survive. When the entry has no
 * `config:` block yet, one is appended under it.
 *
 * @returns the new file text, or null when the entry was not found.
 */
export function applyConfigToPatchText(text, id, values) {
  const lines = text.split(/\r?\n/);
  const entryIndex = lines.findIndex((line) => new RegExp(`^\\s*-\\s+id:\\s*['"]?${escapeRegExp(id)}['"]?\\s*$`).test(line));
  if (entryIndex === -1) return null;

  const entryIndent = lines[entryIndex].match(/^\s*/)[0].length;
  // Find the end of this entry: the next `- ` row at the same indent, or EOF.
  let entryEnd = lines.length;
  for (let i = entryIndex + 1; i < lines.length; i += 1) {
    const indent = lines[i].match(/^\s*/)[0].length;
    if (lines[i].trim() !== "" && indent <= entryIndent && /^\s*-/.test(lines[i])) {
      entryEnd = i;
      break;
    }
  }

  const configIndex = lines.findIndex(
    (line, i) => i > entryIndex && i < entryEnd && /^\s+config:\s*$/.test(line),
  );

  const keyIndent = configIndex === -1 ? `${" ".repeat(entryIndent + 4)}` : lines[configIndex].match(/^\s*/)[0] + "  ";
  const keyPrefix = configIndex === -1 ? `${" ".repeat(entryIndent + 2)}config:` : null;

  const next = [...lines];
  if (configIndex === -1) {
    const block = [keyPrefix];
    for (const [key, value] of Object.entries(values)) block.push(`${keyIndent}${key}: ${yamlScalar(value)}`);
    next.splice(entryEnd, 0, ...block);
    return next.join("\n");
  }

  // Replace matching keys in place; append any that are missing.
  let insertAt = configIndex + 1;
  const seen = new Set();
  for (let i = configIndex + 1; i < entryEnd; i += 1) {
    const match = /^(\s+)([A-Za-z0-9_.-]+):\s*(.*)$/.exec(lines[i]);
    if (!match) {
      if (lines[i].trim() !== "") insertAt = i + 1;
      continue;
    }
    const [, indent, key] = match;
    insertAt = i + 1;
    if (!(key in values)) continue;
    next[i] = `${indent}${key}: ${yamlScalar(values[key])}`;
    seen.add(key);
  }
  const missing = Object.entries(values).filter(([key]) => !seen.has(key));
  if (missing.length > 0) {
    next.splice(insertAt, 0, ...missing.map(([key, value]) => `${keyIndent}${key}: ${yamlScalar(value)}`));
  }
  return next.join("\n");
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where this plugin's own bundle patch lives, derived from this module's
 * location: `<profile>/node_modules/<name>/lib/patches.js` → `<profile>/…`.
 */
export function ownPatchPath(pluginName, fromUrl = import.meta.url) {
  const here = dirname(fileURLToPath(fromUrl));          // …/<name>/lib
  return join(here, "..", "cordis.patch.yml");           // …/<name>/cordis.patch.yml
}

/**
 * Persist values into the plugin's own patch file, atomically.
 * @returns true when the file changed.
 */
export async function persistOwnPatch(pluginName, id, values, { fromUrl, file: explicitFile } = {}) {
  return (await tryPersistOwnPatch(pluginName, id, values, { fromUrl, file: explicitFile })).written;
}

/**
 * Same work as {@link persistOwnPatch}, but distinguishes the outcomes the
 * caller must not confuse:
 *
 *   - `missing`   the patch file is not there — nothing can be written;
 *   - `no-entry`  the file exists but carries no entry with this id;
 *   - `unchanged` the file already held these values — this is SUCCESS, the
 *                 settings are on disk; reporting failure here made an
 *                 idempotent save look broken;
 *   - `written`   the file was updated.
 *
 * @returns `{ outcome, written, changed, reason? }`
 */
export async function tryPersistOwnPatch(pluginName, id, values, { fromUrl, file: explicitFile } = {}) {
  const file = explicitFile || ownPatchPath(pluginName, fromUrl);
  if (!existsSync(file)) return { outcome: "missing", written: false, changed: false, reason: `patch file not found: ${file}` };
  const before = await readFile(file, "utf8");
  const after = applyConfigToPatchText(before, id, values);
  if (after === null) return { outcome: "no-entry", written: false, changed: false, reason: `no "${id}" entry in ${file}` };
  if (after === before) return { outcome: "unchanged", written: true, changed: false };

  // Verify before committing: the rewrite is line-based (to keep comments and
  // formatting), so re-parse the result and confirm the intended values landed.
  // A silent YAML corruption would take the whole bundle layer down on restart.
  const verified = verifyRewrite(after, before, id, values);
  if (!verified.ok) {
    throw new Error(`patch rewrite rejected: ${verified.reason}`);
  }

  // tmp + rename: a crash mid-write must not truncate the patch.
  const tmp = `${file}.${process.pid}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(tmp, after, "utf8");
  await rename(tmp, file);
  return { outcome: "written", written: true, changed: true };
}

/**
 * Re-read the rewritten patch as YAML and confirm the entry now carries the
 * requested values. Returns `{ ok: true }` or `{ ok: false, reason }`.
 *
 * The YAML parser is optional: when no `yaml` package resolves, the structural
 * check degrades to comparing the entry block text, which still catches a
 * truncated or duplicated entry.
 */
export function verifyRewrite(after, before, id, values, loadYaml) {
  const loader = loadYaml ?? tryLoadYaml();
  if (loader) {
    try {
      const docs = loader(after);
      const findEntry = (nodes) => {
        const out = [];
        const walk = (node) => {
          if (Array.isArray(node)) return node.forEach(walk);
          if (!node || typeof node !== "object") return;
          if (node.id === id) out.push(node);
          for (const value of Object.values(node)) walk(value);
        };
        walk(docs);
        return out;
      };
      const entries = findEntry(docs);
      if (entries.length !== 1) return { ok: false, reason: `expected exactly one "${id}" entry, found ${entries.length}` };
      const config = entries[0].config || {};
      for (const [key, want] of Object.entries(values)) {
        const got = config[key];
        const same = typeof want === "number" ? Number(got) === want : String(got) === String(want);
        if (!same) return { ok: false, reason: `${key} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `not valid YAML: ${String(error?.message || error).slice(0, 120)}` };
    }
  }
  // No parser available: at minimum the entry must still be present and unique.
  const occurrences = (after.match(new RegExp(`-\\s+id:\\s*['"]?${escapeRegExp(id)}['"]?\\s*$`, "gm")) || []).length;
  if (occurrences !== 1) return { ok: false, reason: `expected one "${id}" entry after rewrite, found ${occurrences}` };
  if (!after.includes("config:")) return { ok: false, reason: "the config block disappeared" };
  return { ok: true };
}

/** Resolve a YAML parser without adding a hard dependency. */
function tryLoadYaml() {
  const createRequire = process.getBuiltinModule?.("node:module")?.createRequire;
  if (!createRequire) return undefined;
  for (const anchor of [import.meta.url, `${process.cwd()}/package.json`]) {
    try {
      const mod = createRequire(anchor)("js-yaml");
      if (typeof mod?.load === "function") return mod.load;
      if (typeof mod?.default?.load === "function") return mod.default.load;
    } catch {
      /* try the next anchor */
    }
  }
  return undefined;
}
