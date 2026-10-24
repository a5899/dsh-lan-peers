/**
 * Render the viewer in a real browser at phone widths and screenshot it.
 * Uses the puppeteer bundled with the DSH profile (no install needed).
 */
import { createRequire } from "node:module";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const req = createRequire("C:\\Users\\a5093\\.dsh\\profiles\\desktop\\package.json");

let puppeteer;
try {
  puppeteer = req("puppeteer-core");
} catch (error) {
  console.log("SKIP: puppeteer-core unavailable:", error.message);
  process.exitCode = 0;
  process.exit?.();
}

// Find a Chromium the profile already knows about.
const candidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

const { existsSync } = await import("node:fs");
const exe = candidates.find((p) => existsSync(p));
if (!exe) {
  console.log("SKIP: no Chrome/Edge found");
  process.exitCode = 0;
  process.exit?.();
}

const HOME = await mkdtemp(join(tmpdir(), "lan-peers-shot-"));
process.env.DSH_HOME = HOME;
await mkdir(join(HOME, "plugins", "dsh-lan-peers"), { recursive: true });

const mod = await import("../lib/index.js");
const { LanPeersService } = mod;

const ctx = { logger: { info() {}, warn() {}, error() {} }, effect: (fn) => (typeof fn === "function" ? fn() : undefined) };
const cfg = (over) => ({
  enabled: true, displayName: "", listenPort: 0, discoveryPort: 46120,
  multicastGroup: "239.255.77.62", passphrase: "", allowSameSubnet: true,
  manualPeers: "", askTimeoutMs: 5000, maxMessageChars: 8000, ...over,
});

const a = new LanPeersService(ctx, cfg({ displayName: "笔记本 DSH", identitySuffix: "aaa" }));
const b = new LanPeersService(ctx, cfg({ displayName: "手机 DSH", identitySuffix: "bbb" }));
await a.start();
await b.start();
a.rememberPeer({ id: b.identity.id, name: b.displayName(), host: "h", httpPort: b.httpPort, address: "127.0.0.1" });
a.noteSource(b.identity.id, "127.0.0.1");
b.rememberPeer({ id: a.identity.id, name: a.displayName(), host: "h", httpPort: a.httpPort, address: "127.0.0.1" });
b.noteSource(a.identity.id, "127.0.0.1");

const conv = `conv-${b.identity.id.slice(0, 8)}`;
const peerB = a.listPeers().find((p) => p.id === b.identity.id);
await a.ask(peerB, "手机那边现在状态怎么样？", { conversation: conv });
await a.tell(peerB, "这条是提醒：记得把手机版的注意事项同步过来。", { conversation: conv });
await a.ask(peerB, "收到，那手机版面要注意什么？", { conversation: conv });

const url = `http://127.0.0.1:${a.httpPort}/`;
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const outDir = "C:\\Users\\a5093\\Documents\\deepseek-harness\\default-workspace\\lan-peers\\test\\shots";
await mkdir(outDir, { recursive: true });

const results = [];
for (const [name, width, height, dsf] of [["phone", 390, 844, 3], ["small", 320, 640, 2], ["desktop", 1280, 800, 1]]) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: dsf, isMobile: width < 700, hasTouch: width < 700 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("requestfailed", (r) => errors.push("REQFAIL " + r.url() + " " + (r.failure() && r.failure().errorText)));
  page.on("response", (r) => { if (r.status() >= 400) errors.push("HTTP " + r.status() + " " + r.request().method() + " " + r.url()); });
  await page.goto(url, { waitUntil: "networkidle0", timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".conv").length > 0, { timeout: 10000 }).catch(() => {});

  const metrics = await page.evaluate(() => ({
    convs: document.querySelectorAll(".conv").length,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    overflowing: [...document.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1).length,
    minTouch: Math.min(...[...document.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().height)).filter((h) => h > 0)),
    title: document.title,
  }));
  await page.screenshot({ path: join(outDir, `viewer-list-${name}.png`), fullPage: false });

  // Open the thread and shoot it too.
  await page.evaluate(() => { const c = document.querySelector(".conv"); if (c) c.click(); });
  await page.waitForFunction(() => document.querySelectorAll(".msg").length > 0, { timeout: 8000 }).catch(() => {});
  const thread = await page.evaluate(() => ({
    msgs: document.querySelectorAll(".msg").length,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    overflow: document.querySelectorAll(".msg .text").length
      ? [...document.querySelectorAll(".msg .text")].some((el) => el.scrollWidth > el.clientWidth + 1)
      : false,
  }));
  await page.screenshot({ path: join(outDir, `viewer-thread-${name}.png`), fullPage: false });
  await page.close();

  results.push({ name, width, list: metrics, thread, errors });
  console.log(`${name} (${width}px): convs=${metrics.convs} listScroll=${metrics.scrollW}/${metrics.clientW} overflowEls=${metrics.overflowing} minTouch=${metrics.minTouch}px msgs=${thread.msgs} threadScroll=${thread.scrollW}/${thread.clientW} textOverflow=${thread.overflow} errors=${errors.length}`);
  if (errors.length) console.log("  errors:", errors.slice(0, 3).join(" | "));
}

await browser.close();
await a.stop();
await b.stop();
await rm(HOME, { recursive: true, force: true });

const bad = results.filter((r) => r.errors.length > 0 || r.list.scrollW > r.list.clientW + 1 || r.thread.scrollW > r.thread.scrollW + 1 && false);
console.log(bad.length === 0 ? "\nRENDER OK" : `\n${bad.length} viewport(s) with problems`);
process.exitCode = bad.length === 0 ? 0 : 1;
