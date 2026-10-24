/**
 * Model-generated reply tests.
 *
 * The behavioural change: an inbound question can now be answered by this
 * machine's model instead of the fixed host-facts reply. The properties that
 * matter are all failure-shaped, because a peer is waiting on the other end:
 *
 *   - with the switch off, the model is NEVER called (no surprise token spend);
 *   - with it on, the reply comes from the model;
 *   - any model failure still produces a reply (the deterministic fallback),
 *     so a slow/missing model cannot break the conversation;
 *   - the model is never handed anything but the conversation + a guard prompt.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = await mkdtemp(join(tmpdir(), "lan-peers-model-"));
process.env.DSH_HOME = HOME;

const mod = await import("../lib/index.js");
const { LanPeersService } = mod;
const { pickModel, collectText, generateReply } = await import("../lib/model.js");

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label} ${extra}`); }
};

// ── a fake llm service with the real stream shape ───────────────────────
function makeLlm({ reply = "模型生成的回答", failWith = null, slowMs = 0, providers } = {}) {
  const calls = [];
  // Mirrors the REAL contract: listProviders() lists routes, listModels(id)
  // takes one and throws NO_ADAPTER without it — the shape that crashed DSH.
  const routes = providers ?? [{ id: "deepseek-account", api: "dedicated", models: ["deepseek-flash"] }];
  const service = {
    listProviders() {
      return routes.map((r) => ({ id: r.id, name: r.name ?? r.id, api: r.api }));
    },
    listModels(provider) {
      if (provider === undefined || provider === null || provider === "") {
        const error = new Error('no adapter registered for provider "undefined"');
        error.code = "NO_ADAPTER";
        throw error;
      }
      const hit = routes.find((r) => r.id === provider);
      return (hit?.models ?? []).map((id) => ({ id, name: id }));
    },
    stream(options) {
      calls.push(options);
      return (async function* () {
        if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
        if (failWith === "throw") throw new Error("provider exploded");
        if (failWith === "error-chunk") {
          yield { type: "finish", reason: { kind: "error", failure: { message: "rate limited" } } };
          return;
        }
        yield { type: "text", delta: reply.slice(0, 3) };
        yield { type: "text", delta: reply.slice(3) };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };
  return { service, calls };
}

const cfg = (over) => ({
  enabled: true, displayName: "本机", listenPort: 0, discoveryPort: 46150,
  multicastGroup: "239.255.77.72", passphrase: "", allowSameSubnet: true,
  manualPeers: "", askTimeoutMs: 5000, maxMessageChars: 8000, ...over,
});

// ── pure helpers ────────────────────────────────────────────────────────
{
  const { service } = makeLlm();
  const route = pickModel(service);
  check("picks a usable model route", route?.provider === "deepseek-account" && route.model === "deepseek-flash", JSON.stringify(route));
  check("no providers yields no route", pickModel({ listProviders: () => [], listModels: () => [] }) === undefined);
  check("a provider with no models is rejected", pickModel({ listProviders: () => [{ id: "x", api: "dedicated" }], listModels: () => [] }) === undefined);
  check("text chunks concatenate", collectText([{ type: "text", delta: "a" }, { type: "text", delta: "b" }]) === "ab");
  check("plain-string chunks are accepted", collectText(["a", "b"]) === "ab");
}

// ── switch off: the model must not be called ────────────────────────────
{
  const { service, calls } = makeLlm();
  const svc = new LanPeersService({ logger: { info() {}, warn() {}, error() {} }, effect: (f) => (typeof f === "function" ? f() : undefined) }, cfg({ modelReplies: false }));
  svc.llm = service;
  svc.patchFile = join(tmpdir(), "lan-peers-model-a.yml");
  const answer = await svc.answerFor("版本", "conv-x", { id: "peer", name: "对方" });
  check("with modelReplies off the model is never called", calls.length === 0, `${calls.length} calls`);
  check("the deterministic answer is still returned", typeof answer.text === "string" && answer.from !== "model", JSON.stringify(answer));
  await svc.stop();
}

// ── switch on: the model answers ────────────────────────────────────────
{
  const { service } = makeLlm({ reply: "手机端当前电量 80%，状态正常。" });
  const svc = new LanPeersService({ logger: { info() {}, warn() {}, error() {} }, effect: (f) => (typeof f === "function" ? f() : undefined) }, cfg({ modelReplies: true }));
  svc.llm = service;
  svc.patchFile = join(tmpdir(), "lan-peers-model-b.yml");
  await svc.ensureTranscript();
  const conversation = "conv-model-1";
  await svc.recordMessage({ direction: "in", kind: "ask", peer: { id: "p", name: "对方" }, text: "你那边怎么样？", conversation });
  const answer = await svc.answerFor("你那边怎么样？", conversation, { id: "p", name: "对方" });
  check("the answer comes from the model", answer.from === "model", JSON.stringify(answer));
  check("the answer text is the model's", answer.text.includes("80%"), answer.text);
  check("the route is reported", typeof answer.model === "string" && answer.model.includes("deepseek-flash"), answer.model);
  check("model reply accounting is updated", svc.modelStats.replies === 1, JSON.stringify(svc.modelStats));
  await svc.stop();
}

// ── the prompt carries context and a guard ──────────────────────────────
{
  const { service, calls } = makeLlm();
  const svc = new LanPeersService({ logger: { info() {}, warn() {}, error() {} }, effect: (f) => (typeof f === "function" ? f() : undefined) }, cfg({ modelReplies: true }));
  svc.llm = service;
  svc.patchFile = join(tmpdir(), "lan-peers-model-c.yml");
  await svc.ensureTranscript();
  const conversation = "conv-model-2";
  await svc.recordMessage({ direction: "out", kind: "answer", peer: { id: "p", name: "对方" }, text: "早先的回答", conversation });
  await svc.recordMessage({ direction: "in", kind: "ask", peer: { id: "p", name: "对方" }, text: "第二个问题", conversation });
  await svc.answerFor("第二个问题", conversation, { id: "p", name: "对方" });

  const sent = calls.at(-1);
  check("the model receives a system prompt", sent.messages[0]?.role === "system", JSON.stringify(sent.messages[0]));
  check("the system prompt forbids leaking local data", /不要透露|绝不/.test(sent.messages[0].content), sent.messages[0].content.slice(0, 120));
  const roles = sent.messages.map((m) => m.role);
  check("the conversation is replayed as turns", roles.filter((r) => r === "assistant").length >= 1, JSON.stringify(roles));
  check("the current question is the last user turn", sent.messages.at(-1).role === "user" && sent.messages.at(-1).content === "第二个问题", JSON.stringify(sent.messages.at(-1)));
  check("the question is not duplicated in history", sent.messages.filter((m) => m.content === "第二个问题").length === 1, JSON.stringify(roles));
  await svc.stop();
}

// ── every failure degrades to a reply, never an error ───────────────────
for (const [label, llmOpts, expectReason] of [
  ["a throwing provider", { failWith: "throw" }, "model-error"],
  ["an error finish chunk", { failWith: "error-chunk" }, "model-error"],
  ["an empty reply", { reply: "" }, "empty-reply"],
]) {
  const { service } = makeLlm(llmOpts);
  const svc = new LanPeersService({ logger: { info() {}, warn() {}, error() {} }, effect: (f) => (typeof f === "function" ? f() : undefined) }, cfg({ modelReplies: true }));
  svc.llm = service;
  svc.patchFile = join(tmpdir(), "lan-peers-model-d.yml");
  const answer = await svc.answerFor("版本", "conv-f", { id: "p", name: "对方" });
  check(`${label} still yields an answer`, typeof answer.text === "string" && answer.text.length > 0, JSON.stringify(answer));
  check(`${label} reports the reason`, answer.modelError === expectReason, `${answer.modelError} vs ${expectReason}`);
  check(`${label} is counted as a failure`, svc.modelStats.failures === 1, JSON.stringify(svc.modelStats));
  await svc.stop();
}

// ── no usable model at all ──────────────────────────────────────────────
{
  const svc = new LanPeersService({ logger: { info() {}, warn() {}, error() {} }, effect: (f) => (typeof f === "function" ? f() : undefined) }, cfg({ modelReplies: true }));
  svc.llm = undefined;
  svc.patchFile = join(tmpdir(), "lan-peers-model-e.yml");
  const answer = await svc.answerFor("版本", "conv-g", { id: "p", name: "对方" });
  check("a missing llm service degrades instead of throwing", typeof answer.text === "string" && answer.modelError === "no-llm", JSON.stringify(answer));
  await svc.stop();
}

// ── a timeout must not hang the peer ────────────────────────────────────
{
  const { service } = makeLlm({ slowMs: 300, reply: "too late" });
  const result = await generateReply({
    llm: service,
    route: { provider: "deepseek-account", model: "deepseek-flash" },
    system: "s",
    conversation: [],
    message: "q",
    timeoutMs: 100,
  });
  check("a slow model times out instead of hanging", result.ok === false && result.reason === "timeout", JSON.stringify(result));
}

// ── end to end over the wire ────────────────────────────────────────────
{
  const { service } = makeLlm({ reply: "这是模型通过内网给出的回答。" });
  const ctx = { logger: { info() {}, warn() {}, error() {} }, effect: (f) => (typeof f === "function" ? f() : undefined) };
  const a = new LanPeersService(ctx, cfg({ displayName: "甲方", modelReplies: true, identitySuffix: "aaa" }));
  const b = new LanPeersService(ctx, cfg({ displayName: "乙方", modelReplies: true, identitySuffix: "bbb" }));
  a.patchFile = join(tmpdir(), "lan-peers-model-f.yml");
  b.patchFile = join(tmpdir(), "lan-peers-model-g.yml");
  b.llm = service;
  await a.start();
  await b.start();
  a.rememberPeer({ id: b.identity.id, name: b.displayName(), host: "h", httpPort: b.httpPort, address: "127.0.0.1" });
  a.noteSource(b.identity.id, "127.0.0.1");
  b.rememberPeer({ id: a.identity.id, name: a.displayName(), host: "h", httpPort: a.httpPort, address: "127.0.0.1" });
  b.noteSource(a.identity.id, "127.0.0.1");

  const peerB = a.listPeers().find((p) => p.id === b.identity.id);
  const result = await a.ask(peerB, "请用模型回答一句", { conversation: "conv-wire" });
  check("the peer's model answer arrives over HTTP", result.ok && result.answer?.from === "model", JSON.stringify(result).slice(0, 200));
  check("the answer text is the model's", result.answer?.text?.includes("模型通过内网"), JSON.stringify(result.answer));
  await b.ensureTranscript();
  check("the receiver transcribed what its model said", b.messagesOf("conv-wire").some((m) => m.kind === "answer" && m.text.includes("模型通过内网")), JSON.stringify(b.messagesOf("conv-wire").map((m) => m.kind)));
  await a.stop();
  await b.stop();
}

await rm(HOME, { recursive: true, force: true });
console.log(fails === 0 ? "\nMODEL PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
