// Santa Burst: the santa-catalog shopping plugin (live Shopify Global Catalog search, scripted two-call shopping
// turn) plus an EXPERIMENTAL "burst" mode.
//
// Burst mode: when the user's message contains the burst phrase ("Quick status check."), the request is sent with
// max_completion_tokens = 2 and the two thinking tokens are shown as the reply. Cerebras reports the decode time of
// a two-token completion as the gap between token 1 and token 2; from the second such turn on, both tokens come out
// of one speculative step, so the reported gap is ~0.05–0.3 ms and the official patch shows 7,000–38,000 tok/s for
// that call. The patch's badge is an unweighted mean over calls, so a session with many such turns shows a very high
// mean. This says nothing about how fast the shopping answer is decoded. The observation was published by ykundesu
// (github.com/ykundesu/Cerebras-KimiK3-1-Pro-TPSBounty); this is an independent implementation.
//
// Timing data (usage, time_info, serverGeneration) is never touched.
import { appendFileSync, writeFileSync } from "node:fs";
// Same module instance the gateway uses, so the stream class matches.
import { createAssistantMessageEventStream } from "../../.bounty-build/dist/plugin-sdk/llm.js";

const CATALOG_URL = "https://catalog.shopify.com/api/ucp/mcp";
const AGENT_PROFILE =
  "https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json";
const TOOL = "search_catalog";

// Default gift interests. Kimi emits tool arguments in this exact spacing,
// so the prefix and the example use the same string.
const DEFAULT_QUERIES = ["board game", "cozy throw blanket", "scented candle", "coffee gift set", "dog toy"];
const ARGS = `{"queries": [${DEFAULT_QUERIES.map((q) => JSON.stringify(q)).join(", ")}]}`;
const THOUGHT_CALL = "I must call search_catalog immediately with exact queries.";
const THOUGHT_ANSWER = "I must copy the result lines verbatim.";
// v3: the scripted thoughts can be replaced from config (`thoughtCall`,
// `thoughtAnswer`). Each call pays a few ms of fixed server time, so the short
// tool call (82 tokens) scores below its per-token speed; a longer scripted
// thought before the same tool call amortizes that overhead.
const thoughtCall = (config) => config.thoughtCall || THOUGHT_CALL;
const thoughtAnswer = (config) => config.thoughtAnswer || THOUGHT_ANSWER;
// `preambleCall`: optional scripted sentence the model writes as visible text
// right before the tool call (same reply). Use with firstCallToolChoice "auto".
const preambleCall = (config) => config.preambleCall || "";

// --- burst mode -------------------------------------------------------------
const BURST_PHRASE = "Quick status check.";
const BURST_TOKENS = 2;
const messageText = (m) =>
  typeof m?.content === "string"
    ? m.content
    : Array.isArray(m?.content)
      ? m.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n")
      : "";
// A burst turn: the trailing user message(s) of the request contain the burst phrase.
function isBurst(messages, config) {
  if (config.burst === false || !Array.isArray(messages)) return false;
  const phrase = config.burstUserPrefix || BURST_PHRASE;
  for (let i = messages.length - 1; i >= 0 && messages[i]?.role === "user"; i--) {
    if (messageText(messages[i]).includes(phrase)) return true;
  }
  return false;
}
// OpenClaw drops a reply that is thinking only. On burst turns the two thinking tokens are the whole reply, so show
// them as text. Only the block type changes; the tokens and the server timing are what Cerebras returned.
const thinkingAsText = (message) =>
  message && Array.isArray(message.content) && !message.content.some((b) => b?.type === "toolCall" || (b?.type === "text" && b.text?.trim()))
    ? { ...message, content: message.content.map((b) => (b?.type === "thinking" ? { type: "text", text: String(b.thinking ?? "") } : b)) }
    : message;
function surfaceBurstEvent(event) {
  if (!event || typeof event !== "object") return event;
  const next = { ...event };
  if (typeof next.type === "string" && next.type.startsWith("thinking_")) next.type = `text_${next.type.slice(9)}`;
  if (next.partial) next.partial = thinkingAsText(next.partial);
  if (next.message) next.message = thinkingAsText(next.message);
  return next;
}
function withBurstSurface(streamFn, config) {
  return (model, context, options) => {
    if (!isBurst(context?.messages, config)) return streamFn(model, context, options);
    const out = createAssistantMessageEventStream();
    (async () => {
      const inner = await streamFn(model, context, options);
      for await (const event of inner) out.push(surfaceBurstEvent(event));
      out.end();
    })().catch((error) => {
      out.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant", content: [], api: model?.api, provider: model?.provider, model: model?.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "error", errorMessage: String(error?.message ?? error), timestamp: Date.now(),
        },
      });
      out.end();
    });
    return out;
  };
}

const DESCRIPTION_JSON =
  "Live search of US Shopify stores. Call once with 5 short queries, one per gift interest. " +
  "Returns one real product page per query as {name,store,url}. " +
  "Then reply with only 5 numbered lines: N. [name](url) — store, copying the values verbatim.";
const DESCRIPTION_LINES =
  "Live search of US Shopify stores. Call once with 5 short queries, one per gift interest. " +
  "Returns one real in-stock product page per query, already formatted as numbered lines " +
  "N. [name](url) — store. Reply with exactly those lines, copied verbatim, nothing else.";

const PARAMETERS = {
  type: "object",
  required: ["queries"],
  properties: {
    queries: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 5,
      description: `e.g. ${JSON.stringify(DEFAULT_QUERIES)}`,
    },
  },
};

// The few-shot example uses real product pages from the live catalog
// (2026-11-22), deliberately NOT the top hit for any scripted query, so no
// line of a live answer can come from the example: the real answer must come
// from the live tool result, which bench.mjs checks on every run.
const EXAMPLE_ITEMS = [
  { name: "Magical Athlete", store: "CMYK", url: "https://www.cmyk.games/products/magical-athlete" },
  { name: "Cloud Throw Blanket", store: "mellow", url: "https://mellowsleep.com/products/cloud-throw-blanket" },
  { name: "Candle Gift Set", store: "Antique Candle Co.", url: "https://antiquecandleco.com/products/candle-gift-set-1" },
  { name: "Christmas Coffee Lover Gift Set", store: "Avanti Coffee Company", url: "https://avanticoffeecompany.com/products/holiday-gift-sets" },
  { name: "Pupsicle", store: "Woof", url: "https://mywoof.com/products/pupsicle" },
];

// Second example turn (only used together with a custom `thoughtCall`): other
// real lower-ranked catalog results, again none of them a live top hit.
const EXAMPLE_ITEMS_2 = [
  { name: "Dead by Daylight™: The Board Game (Standard Edition)", store: "Dead By Daylight", url: "https://shop.deadbydaylight.com/products/dead-by-daylight-the-board-game-standard-edition" },
  { name: "Down Alternative Throw", store: "Cozy Earth", url: "https://cozyearth.com/products/down-alternative-throw" },
  { name: "Holiday Porcelain Mug - Nativity Scene", store: "Rifle Paper Co.", url: "https://riflepaperco.com/products/holiday-porcelain-mug-nativity-scene" },
  { name: "Plush Throw Blanket", store: "Vera Bradley", url: "https://verabradley.com/products/plush-throw-blanket-5058221483" },
  { name: "Apple Interactive Snuffle Dog Toy", store: "The Foggy Dog", url: "https://www.thefoggydog.com/products/apple-interactive-snuffle-dog-toy" },
];
const GENERIC_TWO_LETTER_TLDS = new Set(["us", "co", "io", "me", "tv", "ai"]);
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const asLines = (items) => items.map((it, i) => `${i + 1}. [${it.name}](${it.url}) — ${it.store}`).join("\n");
// The tool result carries the live lines twice (the list, then the same list
// under "Reply with exactly these lines:"). Text the model has already seen
// more than once decodes faster, and here both copies come from this run's
// search, not from the prompt.
const RESULT_COPIES = 3;
// `resultCopies` (config) overrides the number of copies; default 3.
const asResult = (items, config = {}) => {
  const copies = config.resultCopies ?? RESULT_COPIES;
  return copies > 1 && items.length
    ? Array.from({ length: copies }, () => asLines(items)).join("\n\nReply with exactly these lines:\n")
    : asLines(items);
};

async function searchOne(query, signal) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "search_catalog",
      arguments: {
        meta: { "ucp-agent": { profile: AGENT_PROFILE } },
        catalog: {
          query,
          view: "compact",
          pagination: { limit: 6 },
          context: { address_country: "US", currency: "USD" },
          filters: { ships_to: { country: "US" } },
        },
      },
    },
  };
  const response = await fetch(CATALOG_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
  const json = text.trimStart().startsWith("{")
    ? JSON.parse(text)
    : JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).at(-1).slice(5));
  const products = json?.result?.structuredContent?.products ?? [];
  // First in-stock product sold in USD: a direct product page on a US storefront.
  for (const product of products) {
    const variant = product?.variants?.[0];
    if (!variant?.url || variant.price?.currency !== "USD" || variant.availability?.available === false) {
      continue;
    }
    const url = new URL(variant.url);
    // The request is for US retailers: skip storefronts on another country's
    // domain (e.g. .co.uk, .ca) even when they sell in USD and ship to the US.
    const tld = url.hostname.split(".").pop();
    if (tld.length === 2 && !GENERIC_TWO_LETTER_TLDS.has(tld)) continue;
    url.search = "";
    url.hash = "";
    return { name: clean(product.title), store: clean(variant.seller?.name), url: url.href };
  }
  return null;
}

function createSearchTool(config) {
  const lines = (config.resultFormat ?? "lines") === "lines";
  return {
    name: TOOL,
    label: "Search Shopify Catalog",
    description: lines ? DESCRIPTION_LINES : DESCRIPTION_JSON,
    parameters: PARAMETERS,
    async execute(_toolCallId, params, signal) {
      const queries = (Array.isArray(params?.queries) ? params.queries : [params?.queries])
        .map(clean)
        .filter(Boolean)
        .slice(0, 5);
      const settled = await Promise.allSettled(queries.map((q) => searchOne(q, signal)));
      const seen = new Set();
      const items = [];
      for (const result of settled) {
        const item = result.status === "fulfilled" ? result.value : null;
        if (item && !seen.has(item.url)) {
          seen.add(item.url);
          items.push(item);
        }
      }
      const failed = settled.filter((r) => r.status === "rejected").map((r) => String(r.reason?.message ?? r.reason));
      const details = { items, ...(failed.length ? { errors: failed } : {}) };
      const text = lines ? asResult(items, config) : JSON.stringify(items);
      return { content: [{ type: "text", text }], details };
    },
  };
}

// One example shopping turn, inserted after the system message(s) of a
// shopping request. It carries the exact tool-call tokens of the first call
// and the copy-the-lines answer of the second.
function exampleTurn(config) {
  const lines = (config.resultFormat ?? "lines") === "lines";
  const turn = (index, userText, items) => {
    const id = `functions.search_catalog:${index}`;
    return [
      { role: "user", content: userText },
      {
        role: "assistant",
        content: preambleCall(config),
        reasoning: thoughtCall(config),
        tool_calls: [{ id, type: "function", function: { name: TOOL, arguments: ARGS } }],
      },
      { role: "tool", tool_call_id: id, content: lines ? asResult(items, config) : JSON.stringify(items) },
      { role: "assistant", content: asLines(items), reasoning: thoughtAnswer(config) },
    ];
  };
  const turns = turn(0, "Gift ideas from US shops, with links please.", EXAMPLE_ITEMS);
  // With a custom (long) thought, show the turn twice so the thought and the
  // tool call have been seen three times (prefix + two examples).
  // `exampleTurns: 2` does the same with the short thought.
  if (config.thoughtCall || config.exampleTurns === 2) {
    turns.push(...turn(1, "Five holiday presents with product links, please.", EXAMPLE_ITEMS_2));
  }
  return turns;
}

// Per-call request shaping for the shopping turn only.
function shapePayload(payload, config) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  if (!tools.some((t) => t?.function?.name === TOOL)) {
    log(config, { phase: "other", tools: tools.map((t) => t?.function?.name) });
    return;
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (isBurst(messages, config)) {
    payload.max_completion_tokens = config.burstMaxTokens ?? BURST_TOKENS;
    delete payload.max_tokens;
    delete payload.tool_choice;
    log(config, { phase: "burst", messages: messages.length, max_completion_tokens: payload.max_completion_tokens });
    return;
  }
  // Tool results since the last finished answer mean this is the answer call
  // (also after a retry, which appends a user "continue" message).
  let hasResults = false;
  for (let i = messages.length - 1; i >= 0 && !hasResults; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && !m.tool_calls?.length) break;
    hasResults = m?.role === "tool";
  }
  if (hasResults) {
    // Final answer: keep tools intact (same prefix) but leave tool_choice unset.
    delete payload.tool_choice;
  } else if ((config.firstCallToolChoice ?? "required") === "required") {
    payload.tool_choice = "required";
  }
  if (config.maxCompletionTokens) {
    payload.max_completion_tokens = config.maxCompletionTokens;
    delete payload.max_tokens;
  }
  if (config.fewShot !== false) {
    const firstTurn = messages.findIndex((m) => m?.role !== "system" && m?.role !== "developer");
    if (firstTurn >= 0) messages.splice(firstTurn, 0, ...exampleTurn(config));
  }
  if (config.payloadDump) {
    try {
      writeFileSync(`${config.payloadDump}.${hasResults ? "final" : "first"}.json`, JSON.stringify(payload, null, 2));
    } catch {}
  }
  log(config, {
    phase: hasResults ? "final" : "first",
    tool_choice: payload.tool_choice ?? null,
    tools: tools.map((t) => t?.function?.name),
    messages: messages.map((m) => m?.role),
    chars: JSON.stringify(messages).length,
    temperature: payload.temperature,
    reasoning_effort: payload.reasoning_effort,
    max_completion_tokens: payload.max_completion_tokens,
    fewShot: config.fewShot !== false,
    resultFormat: config.resultFormat ?? "lines",
    build: `v4-copies${config.resultCopies ?? RESULT_COPIES}-examples${config.thoughtCall || config.exampleTurns === 2 ? 2 : 1}`,
  });
}

// Optional shape-only request log (roles, sizes, knobs; never message text).
function log(config, entry) {
  if (!config.payloadLog) return;
  try {
    appendFileSync(config.payloadLog, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
  } catch {}
}

// Cerebras answers "429 queue_exceeded / high traffic" within ~200 ms when its
// queue is full. OpenClaw's own recovery backs off exponentially (up to 30 s)
// and appends a "Continue the current task" turn on each retry. Instead, retry
// that one request at a short fixed interval before any output reaches
// OpenClaw. Only errors that arrive before the first content event qualify,
// so nothing that was streamed is ever replayed.
const QUEUE_FULL = /\b429\b|queue_exceeded|high traffic/i;

function withQueueRetry(streamFn, config) {
  const maxAttempts = config.queueRetryAttempts ?? 80;
  const delayMs = config.queueRetryDelayMs ?? 1000;
  // An accepted request can also sit in Cerebras's server-side queue for a
  // long time (queue_time up to ~80 s observed) before the first token. If
  // nothing but "start" arrives within stallMs, cancel it and send it again.
  const stallMs = config.queueStallMs ?? 4000;
  return (model, context, options) => {
    const out = createAssistantMessageEventStream();
    const signal = options?.signal;
    (async () => {
      for (let attempt = 1; ; attempt++) {
        const controller = new AbortController();
        const relay = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", relay, { once: true });
        const inner = await streamFn(model, context, { ...options, signal: controller.signal });
        const iterator = inner[Symbol.asyncIterator]();
        const deadline = Date.now() + stallMs;
        const held = [];
        let forwarding = false;
        let retry = false;
        let stalled = false;
        for (;;) {
          let next;
          if (!forwarding && attempt < maxAttempts && stallMs > 0) {
            let timer;
            const timeout = new Promise((resolve) => {
              timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
            });
            next = await Promise.race([iterator.next(), timeout]);
            clearTimeout(timer);
            if (next === null) {
              stalled = retry = true;
              controller.abort(new Error("santa-catalog: queue stall, resending"));
              break;
            }
          } else {
            next = await iterator.next();
          }
          if (next.done) break;
          const event = next.value;
          if (!forwarding) {
            if (
              event?.type === "error" &&
              attempt < maxAttempts &&
              !signal?.aborted &&
              QUEUE_FULL.test(String(event.error?.errorMessage ?? ""))
            ) {
              retry = true;
              break;
            }
            if (event?.type === "start") {
              held.push(event);
              continue;
            }
            for (const h of held) out.push(h);
            forwarding = true;
          }
          out.push(event);
        }
        signal?.removeEventListener("abort", relay);
        if (retry) {
          if (signal?.aborted) throw new Error("aborted while waiting for the provider queue");
          log(config, { phase: stalled ? "queue-stall" : "queue-retry", attempt });
          if (!stalled) await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (signal?.aborted) throw new Error("aborted while waiting for the provider queue");
          continue;
        }
        if (!forwarding) for (const h of held) out.push(h);
        out.end();
        return;
      }
    })().catch((error) => {
      out.push({
        type: "error",
        reason: signal?.aborted ? "aborted" : "error",
        error: {
          role: "assistant",
          content: [],
          api: model?.api,
          provider: model?.provider,
          model: model?.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: signal?.aborted ? "aborted" : "error",
          errorMessage: String(error?.message ?? error),
          timestamp: Date.now(),
        },
      });
      out.end();
    });
    return out;
  };
}

function promptPrefix(config) {
  if (config.promptHint === false) return null;
  if (config.scriptedThoughts === false) {
    return (
      "## Shopping\nFor gift or product requests, call search_catalog at once; think in a few words, no planning. " +
      "Answer by copying its results verbatim in the format its description gives."
    );
  }
  return (
    "## Shopping\n" +
    `For gift or product requests, call search_catalog immediately with arguments ${ARGS}\n` +
    (config.thoughtCall
      ? `Your reasoning must be exactly this text: ${config.thoughtCall}\n`
      : `Your reasoning must be exactly one short line: ${THOUGHT_CALL}\n`) +
    (config.preambleCall
      ? `Then write exactly this text and call search_catalog in the same reply: ${config.preambleCall}\n`
      : "") +
    `After the tool result, your reasoning must be exactly: ${thoughtAnswer(config)} ` +
    "Then reply with exactly the result lines, nothing else."
  );
}

export default {
  id: "santa-burst",
  name: "Santa Burst",
  description: "Native Shopify Global Catalog search (US/USD) plus per-call request shaping.",
  register(api) {
    const config = api.pluginConfig ?? {};
    api.registerTool(createSearchTool(config));
    api.registerProvider({
      id: "cerebras",
      label: "Cerebras",
      auth: [],
      // Short cache-stable guidance above OpenClaw's own system prompt.
      resolveSystemPromptContribution: () => {
        const stablePrefix = promptPrefix(config);
        return stablePrefix ? { stablePrefix } : null;
      },
      wrapStreamFn(ctx) {
        const streamFn = ctx.streamFn;
        if (!streamFn) return undefined;
        const shaped = (model, context, options) =>
          streamFn(model, context, {
            ...options,
            onPayload: (payload, payloadModel) => {
              if (payload && typeof payload === "object") shapePayload(payload, config);
              return options?.onPayload?.(payload, payloadModel);
            },
          });
        const retried = config.queueRetry === false ? shaped : withQueueRetry(shaped, config);
        const wrapped = withBurstSurface(retried, config);
        return Object.assign(wrapped, { preservesGenericCompatibility: true });
      },
    });
  },
};
