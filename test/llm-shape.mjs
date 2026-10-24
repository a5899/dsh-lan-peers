/**
 * Probe the real llm service shape by booting the plugin with a fake llm that
 * mirrors DSH's contract, then confirm pickModel asks correctly.
 */
const { pickModel, generateReply } = await import("../lib/model.js");

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label} ${extra}`); }
};

// The hostile shape that crashed DSH: listModels() called with no argument
// throws NO_ADAPTER, exactly like the real service.
function strictLlm({ providers, modelsByProvider, api }) {
  const asked = [];
  return {
    asked,
    listProviders() {
      return providers.map((p) => ({ id: p, name: p, api }));
    },
    listModels(provider) {
      asked.push(provider);
      if (provider === undefined || provider === null || provider === "") {
        const error = new Error('no adapter registered for provider "undefined"');
        error.code = "NO_ADAPTER";
        throw error;
      }
      return (modelsByProvider[provider] ?? []).map((id) => ({ id, name: id }));
    },
    stream() {
      return (async function* () {
        yield { type: "text", delta: "ok" };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };
}

// 1. The original crash: a call without a provider must never escape.
{
  const llm = strictLlm({ providers: ["deepseek-account"], modelsByProvider: { "deepseek-account": ["deepseek-flash"] } });
  let threw = false;
  let route;
  try {
    route = pickModel(llm);
  } catch (error) {
    threw = true;
    console.log("  threw:", error.message);
  }
  check("pickModel never throws when the adapter rejects a bad call", !threw);
  check("pickModel finds the route", route?.provider === "deepseek-account" && route.model === "deepseek-flash", JSON.stringify(route));
  check("listModels is always called WITH a provider", llm.asked.every((p) => typeof p === "string" && p !== ""), JSON.stringify(llm.asked));
}

// 2. A provider whose models cannot be listed is skipped, not fatal.
{
  const llm = {
    listProviders: () => [{ id: "broken", name: "broken" }, { id: "good", name: "good" }],
    listModels(provider) {
      if (provider === "broken") throw new Error("boom");
      return [{ id: "m1", name: "m1" }];
    },
    stream: () => (async function* () { yield { type: "finish", reason: { kind: "stop" } }; })(),
  };
  check("a throwing provider is skipped", pickModel(llm)?.provider === "good", JSON.stringify(pickModel(llm)));
}

// 3. No providers at all.
{
  check("no providers yields no route", pickModel({ listProviders: () => [], listModels: () => [] }) === undefined);
  check("a null llm yields no route", pickModel(null) === undefined);
  check("an llm without listProviders yields no route", pickModel({}) === undefined);
}

// 4. generateReply refuses an incomplete route before touching the adapter.
for (const [label, route] of [
  ["a missing route", undefined],
  ["a route without provider", { model: "m" }],
  ["a route without model", { provider: "p" }],
  ["an empty provider", { provider: "", model: "m" }],
]) {
  const llm = { stream() { throw new Error("must not be called"); } };
  const result = await generateReply({ llm, route, system: "s", conversation: [], message: "q" });
  check(`${label} is rejected without calling the adapter`, result.ok === false && result.reason === "no-model", JSON.stringify(result));
}

// 5. A synchronous throw from stream() is contained.
{
  const llm = { stream() { throw new Error('no adapter registered for provider "x"'); } };
  const result = await generateReply({ llm, route: { provider: "x", model: "m" }, system: "s", conversation: [], message: "q" });
  check("a synchronous adapter throw is contained", result.ok === false && result.reason === "model-error", JSON.stringify(result));
}

// 6. STRING PROVIDERS instead of objects (a different host shape).
{
  const llm = {
    listProviders: () => ["alpha"],
    listModels: (p) => (p === "alpha" ? ["a1"] : []),
    stream: () => (async function* () { yield { type: "finish", reason: { kind: "stop" } }; })(),
  };
  check("plain-string providers are accepted", pickModel(llm)?.provider === "alpha" && pickModel(llm).model === "a1", JSON.stringify(pickModel(llm)));
}

// 7. listProviders itself throws (service half-initialised).
{
  let threw = false;
  let route;
  try {
    route = pickModel({ listProviders() { throw new Error("service not ready"); } });
  } catch { threw = true; }
  check("a throwing listProviders is contained", !threw && route === undefined, String(route));
}

// 8. hostile without listProviders -> treated as unusable, no call at all.
{
  let called = false;
  const route = pickModel({ listModels() { called = true; return [{ id: "m" }]; } });
  check("an llm without listProviders never calls listModels", route === undefined && called === false);
}

console.log(fails === 0 ? "\nLLM SHAPE PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
