/**
 * Ask this machine's model to answer a message from a peer.
 *
 * The plugin does not own a model loop; DSH exposes one as the `llm` service.
 * `ctx.llm.stream({ provider, model, messages })` yields chunks and finishes
 * with a `finish` chunk carrying the stop reason. This module wraps that in a
 * single "generate one reply" call with a hard timeout, so a slow or missing
 * model degrades to the deterministic answer instead of hanging the peer.
 */

/** Providers that speak a real API and can answer a prompt. */
const MODEL_READY = new Set(["dedicated", "openai-completions", "anthropic-messages"]);

/**
 * Pick a reachable model route from the llm service catalog.
 *
 * `llm.listModels()` returns `{ provider, models: [{ id }] }` per adapter. The
 * host's own default route is preferred when the caller supplies one; otherwise
 * the first adapter with a usable API and at least one model wins.
 */
export function pickModel(llm, preferred = {}) {
  let catalog;
  try {
    catalog = typeof llm?.listModels === "function" ? llm.listModels() : undefined;
  } catch {
    return undefined;
  }
  if (!Array.isArray(catalog) || catalog.length === 0) return undefined;

  const usable = catalog.filter((entry) => {
    const models = Array.isArray(entry?.models) ? entry.models : [];
    if (models.length === 0) return false;
    const api = entry.api ?? entry.adapter?.api;
    // An entry without an api is treated as usable: the adapter validates anyway.
    return api === undefined || MODEL_READY.has(api);
  });
  if (usable.length === 0) return undefined;

  if (preferred.provider) {
    const hit = usable.find((entry) => entry.provider === preferred.provider);
    if (hit) {
      const model = preferred.model
        ? (hit.models.find((m) => m.id === preferred.model) ?? hit.models[0])
        : hit.models[0];
      return { provider: hit.provider, model: model.id, name: model.name ?? model.id };
    }
  }
  const first = usable[0];
  return { provider: first.provider, model: first.models[0].id, name: first.models[0].name ?? first.models[0].id };
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
 * Never throws: the caller falls back to a deterministic answer.
 */
export async function generateReply({ llm, route, system, conversation, message, timeoutMs = 45_000, maxChars = 8000 }) {
  if (!llm || typeof llm.stream !== "function") return { ok: false, reason: "no-llm" };
  if (!route) return { ok: false, reason: "no-model" };

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  for (const turn of conversation) {
    // Only user/assistant turns from the transcript; tool turns are irrelevant.
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
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      signal: controller.signal,
      maxTokens: 1024,
    });
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

  try {
    // Race the stream against the deadline: an adapter is expected to honour
    // `signal`, but the peer is waiting, so the timeout must hold even when it
    // does not.
    const outcome = await Promise.race([
      consume(),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs + 20).unref?.()),
    ]);
    return outcome;
  } catch (error) {
    return {
      ok: false,
      reason: timedOut ? "timeout" : "model-error",
      message: String(error?.message ?? error).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}
