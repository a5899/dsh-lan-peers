/**
 * Conversation, transcript and viewer tests.
 *
 * Runs two live services on loopback and drives the whole path a user sees:
 * chat -> transcript on both sides -> persisted file -> viewer page + viewer API.
 * The mobile checks assert the parts of the HTML that keep the page usable on a
 * phone (viewport, safe-area, touch target size, single column, no fixed width).
 */
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = await mkdtemp(join(tmpdir(), "lan-peers-chat-"));
process.env.DSH_HOME = ROOT;
await mkdir(join(ROOT, "plugins", "dsh-lan-peers"), { recursive: true });

const mod = await import("../lib/index.js");
const { LanPeersService } = mod;
const { VIEWER_HTML } = await import("../lib/viewer.js");

let fails = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label} ${extra}`); }
};

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect: (fn) => (typeof fn === "function" ? fn() : undefined),
};
const cfg = (over) => ({
  enabled: true, displayName: "", listenPort: 0, discoveryPort: 46110,
  multicastGroup: "239.255.77.61", passphrase: "", allowSameSubnet: true,
  manualPeers: "", askTimeoutMs: 5000, maxMessageChars: 8000, ...over,
});

const a = new LanPeersService(ctx, cfg({ displayName: "甲方", identitySuffix: "aaa" }));
const b = new LanPeersService(ctx, cfg({ displayName: "乙方", identitySuffix: "bbb" }));
await a.start();
await b.start();

const wire = (from, to) => {
  from.rememberPeer({ id: to.identity.id, name: to.displayName(), host: "h", httpPort: to.httpPort, address: "127.0.0.1" });
  from.noteSource(to.identity.id, "127.0.0.1");
};
wire(a, b);
wire(b, a);

// ── conversation round trip ─────────────────────────────────────────────
const convId = `conv-${b.identity.id.slice(0, 8)}`;
const peerB = () => {
  const p = a.listPeers().find((x) => x.id === b.identity.id);
  if (!p) throw new Error("peer B not registered in A: " + JSON.stringify(a.listPeers()));
  return p;
};
const first = await a.ask(peerB(), "你好，我是甲方", { conversation: convId });
check("ask returns an answer and the conversation id", first.ok === true && first.conversation === convId, JSON.stringify(first).slice(0, 160));

// ── transcript on both sides ────────────────────────────────────────────
await a.ensureTranscript();
await b.ensureTranscript();

const aMsgs = a.messagesOf(convId);
const bMsgs = b.messagesOf(convId);
check("the sender recorded its question", aMsgs.some((m) => m.direction === "out" && m.kind === "ask" && m.text.includes("甲方")), JSON.stringify(aMsgs.map((m) => m.kind)));
check("the sender recorded the answer", aMsgs.some((m) => m.direction === "in" && m.kind === "answer"), JSON.stringify(aMsgs.map((m) => m.kind)));
check("the receiver recorded the incoming question", bMsgs.some((m) => m.direction === "in" && m.kind === "ask"), JSON.stringify(bMsgs.map((m) => m.kind)));
check("the receiver recorded its own answer", bMsgs.some((m) => m.direction === "out" && m.kind === "answer"), JSON.stringify(bMsgs.map((m) => m.kind)));
check("both sides share the conversation id", bMsgs.every((m) => m.conversation === convId), JSON.stringify(bMsgs.map((m) => m.conversation)));

// ── multi-turn keeps one thread ─────────────────────────────────────────
await a.ask(peerB(), "第二句", { conversation: convId });
await a.ensureTranscript();
const turns = a.messagesOf(convId);
check("a second turn appends to the same conversation", turns.filter((m) => m.kind === "ask").length === 2, `${turns.length} messages`);
check("conversation list shows one thread", a.listConversations().filter((c) => c.id === convId).length === 1, JSON.stringify(a.listConversations().map((c) => c.id)));

// ── tell is transcribed too ─────────────────────────────────────────────
await a.tell(peerB(), "顺带一条通知", { conversation: convId });
await a.ensureTranscript();
await b.ensureTranscript();
check("tell appears in the sender transcript", a.messagesOf(convId).some((m) => m.kind === "tell"), JSON.stringify(a.messagesOf(convId).map((m) => m.kind)));
check("tell appears in the receiver transcript", b.messagesOf(convId).some((m) => m.kind === "tell" && m.direction === "in"), JSON.stringify(b.messagesOf(convId).map((m) => m.kind)));

// ── persistence ─────────────────────────────────────────────────────────
const file = join(ROOT, "plugins", "dsh-lan-peers", "transcript.jsonl");
const raw = await readFile(file, "utf8");
const lines = raw.trim().split("\n");
check("transcript is written to disk", lines.length >= 6, `${lines.length} lines`);
check("every persisted line is valid JSON", lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));

// A fresh service on the same home must see the history.
const reloaded = new LanPeersService({ ...ctx }, cfg({ displayName: "reloaded", identitySuffix: "aaa" }));
await reloaded.ensureTranscript();
check("history survives a restart", reloaded.messagesOf(convId).length > 0, `${reloaded.messagesOf(convId).length} messages`);
check("conversations are rebuilt on load", reloaded.listConversations().some((c) => c.id === convId), JSON.stringify(reloaded.listConversations().map((c) => c.id)));

// A torn last line must not lose the rest.
await writeFile(file, raw + '{"id":"broken"', "utf8");
const tolerant = new LanPeersService({ ...ctx }, cfg({ displayName: "tolerant", identitySuffix: "aaa" }));
await tolerant.ensureTranscript();
check("a torn trailing line is skipped, earlier ones survive", tolerant.messagesOf(convId).length > 0, `${tolerant.messagesOf(convId).length}`);

// ── viewer page ─────────────────────────────────────────────────────────
check("viewer is served as HTML", VIEWER_HTML.startsWith("<!doctype html>"), VIEWER_HTML.slice(0, 30));
check("viewer declares a mobile viewport", VIEWER_HTML.includes('name="viewport"') && VIEWER_HTML.includes("width=device-width"), "missing viewport");
check("viewer respects the notch/safe area", VIEWER_HTML.includes("env(safe-area-inset"), "no safe-area padding");
check("viewer targets 44px touch controls", VIEWER_HTML.includes("min-height:44px"), "touch target too small");
check("viewer follows light/dark mode", VIEWER_HTML.includes("prefers-color-scheme"), "no colour scheme");
check("viewer wraps long text instead of scrolling sideways", VIEWER_HTML.includes("overflow-wrap:anywhere") || VIEWER_HTML.includes("word-break"), "long text may overflow");
check("viewer has no fixed wide layout", !/width:\s*(9\d0|1[0-9]00)px/.test(VIEWER_HTML), "a fixed width breaks small screens");
check("viewer uses the mobile-first single column", !VIEWER_HTML.includes("grid-template-columns") || VIEWER_HTML.includes("@media (min-width"), "multi-column without a breakpoint");
check("viewer never inlines a host address", !/http:\/\/\d+\.\d+\.\d+\.\d+/.test(VIEWER_HTML), "hard-coded host");

// ── viewer API over HTTP ────────────────────────────────────────────────
const base = `http://127.0.0.1:${a.httpPort}`;
const page = await fetch(`${base}/`);
const pageText = await page.text();
check("the peer port serves the viewer at /", page.status === 200 && pageText.includes("DSH 对话记录"), `status=${page.status}`);

const convList = await (await fetch(`${base}/peer/webapi/conversations`)).json();
check("the viewer API lists conversations", convList.ok === true && convList.conversations.some((c) => c.id === convId), JSON.stringify(convList).slice(0, 160));

const msgs = await (await fetch(`${base}/peer/webapi/messages?conversation=${encodeURIComponent(convId)}`)).json();
check("the viewer API returns messages", msgs.ok === true && msgs.messages.length > 0, JSON.stringify(msgs).slice(0, 160));
check("messages carry direction and text", msgs.messages.every((m) => "direction" in m && "text" in m), JSON.stringify(msgs.messages[0]));

const missing = await fetch(`${base}/peer/webapi/messages`);
check("messages without a conversation is a 400", missing.status === 400, `status=${missing.status}`);

const bogus = await fetch(`${base}/peer/webapi/nope`);
check("unknown viewer paths 404 with JSON", bogus.status === 404, `status=${bogus.status}`);

// Sending from the viewer goes through the same ask path.
const sent = await (await fetch(`${base}/peer/webapi/send`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ peer: "乙方", message: "从网页发的", conversation: convId }),
})).json();
check("viewer send delivers to the peer", sent.ok === true, JSON.stringify(sent).slice(0, 160));
await a.ensureTranscript();
check("viewer send is transcribed", a.messagesOf(convId).some((m) => m.text.includes("从网页发的")), "missing");

await a.stop();
await b.stop();
await rm(ROOT, { recursive: true, force: true });
console.log(fails === 0 ? "\nCHAT PASS" : `\n${fails} FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
