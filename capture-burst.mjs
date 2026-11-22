// Record one burst session in the gateway's web chat: N "Quick status check." turns (each capped at 2 output tokens by
// the plugin), then the shopping prompt. Saves the browser recording and a JSON with the on-screen session badge,
// the five links and the timings. Nothing in the page is changed except the overlay box (top left).
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.dirname(here);
const { chromium } = await import(path.join(project, ".bounty-build/node_modules/playwright/index.mjs"));
const port = process.env.BURST_PORT ?? "18893";
const launcher = path.join(here, "burst-openclaw");
const sessionKey = process.env.BURST_KEY;
const turns = Number(process.env.BURST_TURNS ?? 12);
const limit = Number(process.env.BURST_LIMIT ?? 240000);
const rawPath = process.env.BURST_RAW;
const jsonPath = process.env.BURST_JSON;
const pngPath = process.env.BURST_PNG;
if (!sessionKey || !rawPath || !jsonPath || !pngPath) throw new Error("BURST_KEY, BURST_RAW, BURST_JSON and BURST_PNG are required");
process.env.OPENCLAW_STATE_DIR = path.join(project, ".burst-state");
process.env.OPENCLAW_CONFIG_PATH = path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json");
const { n: issueHandoff } = await import(path.join(project, ".bounty-build/dist/control-ui-handoff-BEDtjids.mjs"));
const origin = `http://127.0.0.1:${port}`;
const { browserUrl } = await issueHandoff({ httpUrl: `${origin}/chat?session=${encodeURIComponent(sessionKey)}`, wsUrl: `ws://127.0.0.1:${port}` });

const STATUS = "Quick status check.";
const PROMPT = "Find five Christmas gifts from US retailers. Give me five direct product links.";
const call = (method, params) =>
  JSON.parse(execFileSync(launcher, ["gateway", "call", method, "--json", "--params", JSON.stringify(params)], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }));
const finals = () => {
  try { return (call("chat.history", { sessionKey, limit: 400 }).messages ?? []).filter((m) => m.role === "assistant" && m.stopReason && m.stopReason !== "toolUse").length; }
  catch { return -1; }
};
const viewport = { width: 1440, height: 810 };
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
const staging = await fs.mkdtemp(path.join(here, "capture-"));
const deadline = Date.now() + limit;
let context, page, result, stoppedAt;
const captureStart = Date.now();
try {
  context = await browser.newContext({ colorScheme: "dark", viewport, recordVideo: { dir: staging, size: viewport } });
  page = await context.newPage();
  await page.goto(browserUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
  const box = page.getByRole("textbox", { name: "Chat composer", exact: true });
  await box.waitFor({ state: "visible", timeout: 20000 });
  const collapse = page.getByRole("button", { name: "Collapse sidebar", exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await box.focus();
  await page.evaluate((turns) => {
    const badge = document.createElement("div");
    badge.setAttribute("aria-hidden", "true");
    badge.style.cssText = "position:fixed;left:25px;top:72px;width:245px;box-sizing:border-box;padding:15px 18px 16px;z-index:99999;pointer-events:none;background:#172121;border:1px solid #445f4e;border-radius:13px;color:#eef3eb;font-family:system-ui,sans-serif;box-shadow:0 7px 20px #0004";
    const key = document.createElement("div"), digits = document.createElement("div"), status = document.createElement("div");
    key.style.cssText = "font-size:16px;font-weight:650;letter-spacing:.02em;color:#c8f884";
    digits.style.cssText = "font-size:38px;font-weight:700;line-height:1.2;letter-spacing:-.04em;font-variant-numeric:tabular-nums;margin:6px 0 5px";
    status.style.cssText = "font-size:14px;color:#bbc8c0";
    key.textContent = "2-token status checks"; digits.textContent = `0 / ${turns}`; status.textContent = "Experimental burst mode";
    badge.append(key, digits, status); document.body.append(badge);
    const now = () => performance.timeOrigin + performance.now();
    const take = (window.__burst = { ready: now(), statusStart: null, armed: false, enter: null, finish: null, links: [], trusted: false, turns });
    take.setCount = (n) => { digits.textContent = `${n} / ${turns}`; };
    take.arm = () => { take.armed = true; take.armedAt = now(); key.textContent = "Enter → 5 product links"; digits.textContent = "0.00 s"; status.textContent = "Shopping turn"; };
    const getLinks = () => [...new Set([...document.querySelectorAll('main ol li a[href^="https://"]')].filter((a) => { const r = a.getBoundingClientRect(); return r.height > 0 && r.bottom > 0 && r.top < innerHeight; }).map((a) => a.href))];
    const update = () => {
      if (take.enter === null || take.finish !== null) return;
      const stamp = now(), links = getLinks();
      if (links.length >= 5) { take.finish = stamp; take.links = links.slice(0, 5); key.textContent = "Timer stopped"; status.textContent = "5 product links visible"; digits.style.color = "#c8f884"; }
      digits.textContent = ((stamp - take.enter) / 1000).toFixed(2) + " s";
    };
    setInterval(update, 55);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      const stamp = performance.timeOrigin + event.timeStamp;
      if (take.statusStart === null) take.statusStart = stamp;
      if (take.armed && take.enter === null) { take.enter = stamp; take.trusted = event.isTrusted; }
    }, true);
  }, turns);
  await page.waitForTimeout(500);

  for (let i = 0; i < turns; i++) {
    const before = finals();
    await box.pressSequentially(STATUS, { delay: 9 });
    await page.keyboard.press("Enter");
    for (;;) {
      if (Date.now() > deadline) throw Object.assign(new Error("status phase timed out"), { soft: true });
      await page.waitForTimeout(250);
      const n = finals();
      if (before >= 0 && n > before) break;
    }
    await page.evaluate((n) => window.__burst.setCount(n), i + 1);
    await page.waitForTimeout(250);
  }
  process.stdout.write(`${turns} status turns done.\n`);
  await page.evaluate(() => window.__burst.arm());
  await page.waitForTimeout(400);
  await box.pressSequentially(PROMPT, { delay: 30 });
  if ((await box.inputValue()) !== PROMPT) throw new Error("Visible prompt did not match");
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");

  const received = await page.waitForFunction(() => {
    const take = window.__burst, main = document.querySelector("main");
    const stats = main.innerText.match(/[0-9,.]+ tok\/s mean · [0-9,.]+ p90 \(server\)/g);
    return take?.finish && stats?.length && !main.innerText.includes("Assistant is working...");
  }, undefined, { polling: 150, timeout: Math.max(1000, deadline - Date.now()) }).catch((error) => { if (error.name !== "TimeoutError") throw error; return null; });
  if (received) {
    const readScore = () => page.evaluate(() => document.querySelector("main").innerText.match(/[0-9,.]+ tok\/s mean · [0-9,.]+ p90 \(server\)/g).at(-1));
    let score = await readScore();
    for (let stableSince = Date.now(), until = Date.now() + 8000; Date.now() < until;) {
      await page.waitForTimeout(250);
      const next = await readScore();
      if (next !== score) { score = next; stableSince = Date.now(); } else if (Date.now() - stableSince >= 3000) break;
    }
    result = await page.evaluate((score) => { const t = window.__burst; return { ready: t.ready, statusStart: t.statusStart, armedAt: t.armedAt, enter: t.enter, finish: t.finish, links: t.links, trusted: t.trusted, turns: t.turns, score }; }, score);
    await page.screenshot({ path: pngPath });
    await page.waitForTimeout(1500);
    stoppedAt = Date.now();
  } else {
    try { call("chat.abort", { sessionKey }); } catch {}
    process.stdout.write("No complete shopping answer in time.\n");
  }
} catch (error) {
  if (!error.soft) throw error;
  try { call("chat.abort", { sessionKey }); } catch {}
  process.stdout.write(`${error.message}\n`);
} finally {
  const recording = page?.video();
  await context?.close();
  if (recording && result) await recording.saveAs(rawPath);
  await browser.close();
  await fs.rm(staging, { recursive: true, force: true });
}
if (!result) process.exitCode = 75;
else {
  if (!result.trusted || result.links.length !== 5) throw new Error("Missing live timing evidence");
  await fs.writeFile(jsonPath, JSON.stringify({ ...result, captureStart, stoppedAt, sessionKey, prompt: PROMPT, statusPhrase: STATUS }, null, 2) + "\n");
  process.stdout.write(`Five links after ${((result.finish - result.enter) / 1000).toFixed(2)} s. ${result.score}.\n`);
}
