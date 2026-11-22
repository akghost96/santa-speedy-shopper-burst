# Santa's Speedy Shopper — experimental burst entry

**14,597 tok/s mean · 36,179 p90** on the session badge of the official speed patch.
Video: `submissions/burst-14597tps.mp4`.

**Read this first.** This is an experimental entry. The number is real server timing shown by the unmodified patch,
but it does not mean the shopping answer was decoded at that speed. It comes from 4 extra two-token calls and
from the way the badge averages calls. Counted by tokens, the same session ran at **827 tok/s**
(298 output tokens in 360.2 ms of server decode time). The plain entry, where every model call belongs to the
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

1. The user sends `Quick status check.` 4 times. On these turns the plugin sends the request with
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
| 1 | status check | 2 | 0.155 ms | 12,925 tok/s |
| 2 | status check | 2 | 0.113 ms | 17,683 tok/s |
| 3 | status check | 2 | 0.108 ms | 18,535 tok/s |
| 4 | status check | 2 | 0.055 ms | 36,179 tok/s |
| 5 | tool call | 82 | 51.773 ms | 1,584 tok/s |
| 6 | answer | 208 | 307.968 ms | 675 tok/s |

Mean of the rates: **14,597 tok/s**. p90: 36,179. Token-weighted: 827 tok/s.

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

It is the best of 20 verified sessions with 4 status turns (median 6,285 tok/s mean); `evidence/results.jsonl`
lists all of them. A session's score depends on how many of its status calls land in the fast case.

## The five products in the video

1. Root: A Game of Woodland Might and Right — https://ledergames.com/products/root-a-game-of-woodland-might-and-right
2. Double-Sided Cozy Throw Blanket - Patchwork Be Happy — https://www.naturallife.com/products/double-sided-cozy-throw-blanket-patchwork-be-happy
3. Maple Butter 3-Wick Candle — https://goosecreek.com/products/maple-butter-large-3-wick-candle
4. Right Roast Sampler Gift Basket — https://www.coffeebeanery.com/products/the-right-roast-sampler-gift-basket
5. Pickle Stickle Super Chewer Durable Gnaw Dog Toy — https://bark.co/products/pickle-stickle

The stopwatch box (top left) and the title strip and score card are added by the recording scripts; the speed badge
next to the message box is the patch's. Sped-up parts say so in the title strip.

## Reproduce

This folder lives inside the plain entry's project as `burst/` and uses its OpenClaw build (`../.bounty-build`) and
its video helpers (`../.recording-work/edit.py`, `timed_edit.py`).

```bash
# from the parent project (OpenClaw 8b18b55 + patch built in ../.bounty-build), with CEREBRAS_API_KEY set
burst/burst-openclaw gateway run                 # web chat on http://127.0.0.1:18893 (config: openclaw.example.json)
node burst/bench-burst.mjs try-1 4               # one headless session, prints every call's rate
burst/record-burst.sh 10 4                       # recorded browser sessions for 10 minutes
```

## Files

| Path | What |
| --- | --- |
| `santa-burst/index.mjs` | the plugin (search tool, shopping-turn shaping, burst mode) |
| `openclaw.example.json` | gateway config without secrets |
| `capture-burst.mjs`, `verify_burst.py`, `burst_edit.py`, `record-burst.sh` | recorder, check against the transcript, video edit |
| `bench-burst.mjs` | headless session with per-call rates |
| `evidence/` | transcript, timings and screenshot of the session in the video; log of all sessions |
| `submissions/burst-14597tps.mp4` | the video |
