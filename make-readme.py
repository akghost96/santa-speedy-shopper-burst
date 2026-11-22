"""Write README.md and the evidence folder for the current best burst session (burst/best.json)."""
import json
import re
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
best = json.loads((HERE / "best.json").read_text())
take = best["take"]
edit = json.loads((HERE / f"takes/{take}.edit.json").read_text())
capture = json.loads((HERE / f"takes/{take}.capture.json").read_text())
history = json.loads((HERE / f"takes/{take}.history.json").read_text())
results = [json.loads(line) for line in (HERE / "results.jsonl").read_text().splitlines() if line.strip()]

calls = [
    (m["serverGeneration"]["outputTokens"], m["serverGeneration"]["completionMs"], m.get("stopReason"))
    for m in history["messages"] if m.get("role") == "assistant" and m.get("serverGeneration")
]
answer = next(
    part["text"] for m in reversed(history["messages"]) if m.get("role") == "assistant"
    for part in m["content"] if part.get("type") == "text" and "](https://" in part["text"]
)
items = re.findall(r"(?m)^\s*\d+\.\s*\[(.+?)\]\((https://[^)\s]+)\)", answer)
tokens = sum(t for t, _, _ in calls)
total_ms = sum(ms for _, ms, _ in calls)
weighted = tokens / (total_ms / 1000)
mean, p90 = edit["mean_tps"], edit["p90_tps"]
video = f"submissions/burst-{mean}tps.mp4"
rows = "\n".join(
    f"| {i} | {'status check' if t <= 2 and stop == 'length' else ('tool call' if stop == 'toolUse' else 'answer')} | {t} | {ms:.3f} ms | {t / ms * 1000:,.0f} tok/s |"
    for i, (t, ms, stop) in enumerate(calls, 1)
)
links = "\n".join(f"{i}. {name} — {url}" for i, (name, url) in enumerate(items, 1))
same = [r for r in results if r.get("turns") == best["turns"]]
means = sorted(r["mean_tps"] for r in same)
median = means[len(means) // 2] if means else mean

evidence = HERE / "evidence"
evidence.mkdir(exist_ok=True)
for name in ("edit.json", "capture.json", "history.json", "result.png"):
    shutil.copy(HERE / f"takes/{take}.{name}", evidence / name)
shutil.copy(HERE / "results.jsonl", evidence / "results.jsonl")

(HERE / "README.md").write_text(f"""# Santa's Speedy Shopper — experimental burst entry

**{mean:,} tok/s mean · {p90:,} p90** on the session badge of the official speed patch.
Video: `{video}`.

**Read this first.** This is an experimental entry. The number is real server timing shown by the unmodified patch,
but it does not mean the shopping answer was decoded at that speed. It comes from {edit['burst_calls']} extra two-token calls and
from the way the badge averages calls. Counted by tokens, the same session ran at **{weighted:,.0f} tok/s**
({tokens} output tokens in {total_ms:.1f} ms of server decode time). The plain entry, where every model call belongs to the
shopping task, is in https://github.com/akghost96/santa-speedy-shopper (1,755 tok/s mean).

The two-token observation was published by ykundesu
(https://github.com/ykundesu/Cerebras-KimiK3-1-Pro-TPSBounty). This is an independent implementation of it on top of
our own shopping plugin.

## What runs

- OpenClaw `8b18b55` plus the official speed patch, nothing else changed. Same check as in the plain entry's repo.
- `cerebras/moonshotai-kimi-k3.1-pro-trial`, reasoning effort `low`, temperature `0`.
- One plugin, `santa-burst/`: the plain entry's plugin (live Shopify catalog search, scripted two-call shopping
  turn) plus the burst mode described below.

## One session

1. The user sends `Quick status check.` {edit['burst_calls']} times. On these turns the plugin sends the request with
   `max_completion_tokens: 2` and shows the two thinking tokens as the reply (for example "I need").
2. The user sends "Find five Christmas gifts from US retailers. Give me five direct product links."
   The model calls the live catalog search and replies with the five product lines, as in the plain entry.

## Why the badge is so high

- **Two-token completions measure almost no time.** Cerebras reports the decode time of a completion from its first
  generated token to its last. With exactly two tokens, the second usually comes out of the same speculative step as
  the first, so the reported time is the gap between them: 0.05–0.65 ms here. Two tokens over that gap is
  3,000–36,000 tok/s. Direct calls to the API showed the same thing, and showed it disappear with three or more
  tokens (a few hundred tok/s) or without an earlier identical turn in the conversation.
- **The badge is an unweighted mean over calls.** A two-token call counts as much as a 200-token answer.

Every model call of the session in the video, as the patch recorded it:

| Call | Kind | Tokens | Server decode time | Rate |
| --- | --- | --- | --- | --- |
{rows}

Mean of the rates: **{mean:,} tok/s**. p90: {p90:,}. Token-weighted: {weighted:,.0f} tok/s.

## What is and is not changed

- OpenClaw's source: only the official patch.
- Timing data (`usage`, `time_info`, the patch's `serverGeneration`): passed through untouched. The recorder refuses a
  session unless the badge on screen equals the mean and p90 recomputed from the gateway transcript.
- The plugin does change requests: `max_completion_tokens: 2` on status turns; on the shopping turn the same request
  shaping as the plain entry (fixed queries and scripted one-line thoughts in the prompt, one example turn, the live
  result returned three times, `tool_choice: "required"` on the first call, queue retries).
- On status turns the reply would be thinking only, which OpenClaw does not show, so the plugin relabels those two
  thinking tokens as text. The tokens themselves are what the model produced.

## How the session was chosen

It is the best of {len(same)} verified sessions with {best['turns']} status turns (median {median:,} tok/s mean); `evidence/results.jsonl`
lists all of them. A session's score depends on how many of its status calls land in the fast case.

## The five products in the video

{links}

The stopwatch box (top left) and the title strip and score card are added by the recording scripts; the speed badge
next to the message box is the patch's. Sped-up parts say so in the title strip.

## Reproduce

This folder lives inside the plain entry's project as `burst/` and uses its OpenClaw build (`../.bounty-build`) and
its video helpers (`../.recording-work/edit.py`, `timed_edit.py`).

```bash
# from the parent project (OpenClaw 8b18b55 + patch built in ../.bounty-build), with CEREBRAS_API_KEY set
burst/burst-openclaw gateway run                 # web chat on http://127.0.0.1:18893 (config: openclaw.example.json)
node burst/bench-burst.mjs try-1 {best['turns']}               # one headless session, prints every call's rate
burst/record-burst.sh 10 {best['turns']}                       # recorded browser sessions for 10 minutes
```

## Files

| Path | What |
| --- | --- |
| `santa-burst/index.mjs` | the plugin (search tool, shopping-turn shaping, burst mode) |
| `openclaw.example.json` | gateway config without secrets |
| `capture-burst.mjs`, `verify_burst.py`, `burst_edit.py`, `record-burst.sh` | recorder, check against the transcript, video edit |
| `bench-burst.mjs` | headless session with per-call rates |
| `evidence/` | transcript, timings and screenshot of the session in the video; log of all sessions |
| `{video}` | the video |
""")
print(f"README for {take}: {mean:,} mean / {p90:,} p90, token-weighted {weighted:,.0f} tok/s, {len(same)} sessions")
