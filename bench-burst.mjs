// Headless burst session through the gateway: N status-check turns, then the shopping prompt, in one session.
// Prints each model call's server rate (Cerebras time_info, as the official patch shows it) and the session mean/p90.
// Usage: node burst/bench-burst.mjs <label> [statusTurns=6]
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, "burst-openclaw");
const [label, turnsArg] = process.argv.slice(2);
if (!label) throw new Error("usage: bench-burst.mjs <label> [statusTurns]");
const turns = Number(turnsArg ?? 6);
const STATUS = process.env.BURST_PHRASE ?? "Quick status check.";
const PROMPT = "Find five Christmas gifts from US retailers. Give me five direct product links.";
const limitMs = Number(process.env.BENCH_LIMIT_MS ?? 180000);
const sessionKey = `agent:main:burst-${label}-${Date.now()}`;
const call = (method, params) =>
  JSON.parse(execFileSync(launcher, ["gateway", "call", method, "--json", "--params", JSON.stringify(params)], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }));
const history = () => { try { return call("chat.history", { sessionKey, limit: 400 }).messages ?? []; } catch { return null; } };
const finals = (messages) => messages.filter((m) => m.role === "assistant" && m.stopReason && m.stopReason !== "toolUse").length;

async function send(message) {
  const before = finals(history() ?? []);
  const t0 = Date.now();
  call("chat.send", { sessionKey, message, idempotencyKey: `burst-${t0}-${Math.random().toString(36).slice(2)}` });
  while (Date.now() - t0 < limitMs) {
    const messages = history();
    if (messages && finals(messages) > before) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 200));
  }
  try { call("chat.abort", { sessionKey }); } catch {}
  throw new Error(`no reply within ${limitMs / 1000}s to: ${message}`);
}

for (let i = 0; i < turns; i++) process.stdout.write(`status ${i + 1}: ${await send(STATUS)} ms\n`);
process.stdout.write(`shopping: ${await send(PROMPT)} ms\n`);
const messages = history();
const calls = messages.filter((m) => m.role === "assistant" && m.serverGeneration).map((m) => ({
  stop: m.stopReason, tokens: m.serverGeneration.outputTokens, ms: m.serverGeneration.completionMs,
  rate: m.serverGeneration.outputTokens / (m.serverGeneration.completionMs / 1000),
  text: (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("").slice(0, 60),
}));
const rates = calls.map((c) => c.rate);
const sorted = [...rates].sort((a, b) => a - b);
const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
const p90 = sorted[Math.max(0, Math.ceil(0.9 * sorted.length) - 1)];
for (const c of calls) console.log(`${c.stop.padEnd(8)} ${String(c.tokens).padStart(4)} tok ${c.ms.toFixed(4).padStart(10)} ms ${String(Math.round(c.rate)).padStart(7)} tok/s  ${JSON.stringify(c.text)}`);
console.log(`calls ${calls.length}  mean ${Math.round(mean).toLocaleString()} tok/s  p90 ${Math.round(p90).toLocaleString()} tok/s`);
mkdirSync(path.join(here, "runs"), { recursive: true });
writeFileSync(path.join(here, "runs", `${label}.json`), JSON.stringify({ sessionKey, calls, mean, p90, messages }, null, 2));
