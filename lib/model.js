/**
 * Ask this machine's model to answer a message from a peer.
 *
 * The plugin does not own a model loop; DSH exposes one as the `llm` service:
 *
 *   llm.listProviders()        → [{ id, name, ... }]         one entry per route
 *   llm.listModels(providerId) → [{ id, name, ... }]         that route's models
 *   llm.stream({ provider, model, messages, signal })
 *
 * `listModels` takes a provider ID. Calling it without one throws
 * `NO_ADAPTER: no adapter registered for provider "undefined"` — and that
 * exception escaped the host's request handler and killed the DSH process.
 * A reply generator must never be able to crash the machine it runs on, so
 * every host call below is individually guarded and nothing escapes.
 */

/** Providers that speak a real API and can answer a prompt. */
const MODEL_READY = new Set(["dedicated", "openai-completions", "anthropic-messages"]);

/** Normalise whatever `listProviders()` returned into `{ id, name, api }`. */
function normalizeProviders(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry) continue;
    const id = typeof entry === "string" ? entry : (entry.id ?? entry.provider);
    if (typeof id !== "string" || id === "") continue;
    out.push({
      id,
      name: typeof entry === "object" && typeof entry.name === "string" ? entry.name : id,
      api: typeof entry === "object" && typeof entry.api === "string" ? entry.api : undefined,
    });
  }
  return out;
}

/** Normalise a `listModels()` answer into `[{ id, name }]`. */
function normalizeModels(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry) continue;
    const id = typeof entry === "string" ? entry : (entry.id ?? entry.model);
    if (typeof id !== "string" || id === "") continue;
    out.push({ id, name: typeof entry === "object" && typeof entry.name === "string" ? entry.name : id });
  }
  return out;
}

/**
 * Pick a reachable model route.
 *
 * Never throws: an unusable llm service yields `undefined`, which the caller
 * turns into the deterministic fallback reply.
 */
export function pickModel(llm, preferred = {}) {
  try {
    if (!llm || typeof llm.listProviders !== "function") return undefined;

    let providers;
    try {
      providers = normalizeProviders(llm.listProviders());
    } catch {
      return undefined;
    }
    if (providers.length === 0) return undefined;

    const usable = providers.filter((p) => p.api === undefined || MODEL_READY.has(p.api));
    const ordered = [];
    // The preferred route first, then the rest in host order.
    const wanted = typeof preferred.provider === "string" ? preferred.provider : "";
    if (wanted) {
      const hit = usable.find((p) => p.id === wanted);
      if (hit) ordered.push(hit);
    }
    for (const p of usable) if (!ordered.includes(p)) ordered.push(p);

    for (const provider of ordered) {
      let models;
      try {
        // listModels requires a provider id; asking without one throws.
        models = normalizeModels(typeof llm.listModels === "function" ? llm.listModels(provider.id) : []);
      } catch {
        continue;
      }
      if (models.length === 0) continue;
      const model = preferred.model
        ? (models.find((m) => m.id === preferred.model) ?? models[0])
        : models[0];
      return { provider: provider.id, model: model.id, name: model.name };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Concatenate the text carried by `text`/`delta` chunks. */
export function collectText(chunks, limit = 8000) {
  let out = "";
  for (const chunk of chunks) {
    if (!chunk) continue;
    if (typeof chunk === "string") {
      out += chunk;
      continue;
    }
    if (typeof chunk.text === "string") {
      out += chunk.text;
      continue;
    }
    if (chunk.type === "text" && typeof chunk.delta === "string") {
      out += chunk.delta;
      continue;
    }
    if (chunk.type === "content" && typeof chunk.content?.text === "string") out += chunk.content.text;
  }
  return out.length > limit ? `${out.slice(0, limit)}…` : out;
}

/**
 * Generate one reply for a peer's message.
 *
 * @returns `{ ok: true, text, model }` or `{ ok: false, reason, message }`.
 * Never throws — including synchronously — so the caller can always fall back
 * instead of unwinding into the host's request pipeline.
 */
export async function generateReply({ llm, route, system, conversation, message, timeoutMs = 45_000, maxChars = 8000 }) {
  try {
    if (!llm || typeof llm.stream !== "function") return { ok: false, reason: "no-llm" };
    const routeOk = route
      && typeof route.provider === "string" && route.provider !== ""
      && typeof route.model === "string" && route.model !== "";
    // A half-built route must be rejected here: sending it produces
    // NO_ADAPTER for provider "undefined".
    if (!routeOk) return { ok: false, reason: "no-model", message: "incomplete model route" };

    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    for (const turn of conversation) {
      if (turn.role !== "user" && turn.role !== "assistant") continue;
      messages.push({ role: turn.role, content: String(turn.content).slice(0, 4000) });
    }
    messages.push({ role: "user", content: String(message).slice(0, 4000) });

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const consume = async () => {
      const chunks = [];
      let stream;
      try {
        stream = llm.stream({
          provider: route.provider,
          model: route.model,
          messages,
          signal: controller.signal,
          maxTokens: 1024,
        });
      } catch (error) {
        // A synchronous throw from the adapter (bad route, missing adapter).
        return { ok: false, reason: "model-error", message: String(error?.message ?? error).slice(0, 300) };
      }
      for await (const chunk of stream) {
        chunks.push(chunk);
        if (chunk?.type === "finish") {
          const reason = chunk.reason?.kind;
          if (reason === "error") {
            const failure = chunk.reason.failure;
            return { ok: false, reason: "model-error", message: String(failure?.message ?? failure ?? "model failed") };
          }
          break;
        }
      }
      const text = collectText(chunks, maxChars).trim();
      if (text === "") return { ok: false, reason: "empty-reply" };
      return { ok: true, text, model: `${route.provider}/${route.model}` };
    };

    // Race the stream against the deadline: an adapter is expected to honour
    // `signal`, but the peer is waiting, so the timeout must hold regardless.
    const outcome = await Promise.race([
      consume().catch((error) => ({
        ok: false,
        reason: timedOut ? "timeout" : "model-error",
        message: String(error?.message ?? error).slice(0, 300),
      })),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs + 20).unref?.()),
    ]);
    clearTimeout(timer);
    return outcome;
  } catch (error) {
    return {
      ok: false,
      reason: "model-error",
      message: String(error?.message ?? error).slice(0, 300),
    };
  }
}
