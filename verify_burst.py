"""Check one recorded burst session against the gateway transcript and write its edit timings.

    python3 burst/verify_burst.py <capture.json> <raw.webm> <edit.json> <history.json>

Fails unless the badge read from the screen equals the mean and p90 recomputed from every model call in the session
(Cerebras time_info as stored by the official patch) and the five on-screen links are in the final answer.
"""
import json
import math
import re
import subprocess
import sys
from pathlib import Path
from statistics import mean

HERE = Path(__file__).resolve().parent
capture_path, raw, edit_path, history_path = map(Path, sys.argv[1:5])
capture = json.loads(capture_path.read_text())
history = json.loads(subprocess.check_output([
    str(HERE / "burst-openclaw"), "gateway", "call", "chat.history", "--json",
    "--params", json.dumps({"sessionKey": capture["sessionKey"], "limit": 400}),
], text=True, stderr=subprocess.DEVNULL))
assistant = [m for m in history["messages"] if m.get("role") == "assistant"]
calls = [
    {"tokens": g["outputTokens"], "ms": g["completionMs"], "rate": g["outputTokens"] * 1000 / g["completionMs"], "stop": m.get("stopReason")}
    for m in assistant if (g := m.get("serverGeneration"))
]
rates = [c["rate"] for c in calls]
burst = [c for c in calls if c["tokens"] <= 2 and c["stop"] == "length"]
shop = [c for c in calls if c not in burst]
answer = next(
    part["text"] for m in reversed(assistant) for part in m["content"]
    if part.get("type") == "text" and all(link in part["text"] for link in capture["links"])
)
assert history["sessionKey"] == capture["sessionKey"]
assert capture["trusted"] and len(set(capture["links"])) == 5
assert re.search(r"(?m)^\s*5\. ", answer)
assert len(burst) == capture["turns"], (len(burst), capture["turns"])
assert len(shop) == 2, [c["stop"] for c in shop]
official_mean = math.floor(mean(rates) + 0.5)
official_p90 = math.floor(sorted(rates)[math.ceil(len(rates) * 0.9) - 1] + 0.5)
expected = f"{official_mean:,} tok/s mean · {official_p90:,} p90 (server)"
assert capture["score"] == expected, (capture["score"], expected)
length = float(subprocess.check_output([
    "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(raw),
], text=True).strip())
zero = capture["stoppedAt"] - 1000 * length
timing = {
    "start_offset_ms": max(0, capture["ready"] - zero - 350),
    "status_offset_ms": capture["statusStart"] - zero,
    "armed_offset_ms": capture["armedAt"] - zero,
    "enter_offset_ms": capture["enter"] - zero,
    "complete_offset_ms": capture["finish"] - zero,
    "length_ms": length * 1000,
    "elapsed_ms": capture["finish"] - capture["enter"],
    "mean_tps": official_mean,
    "p90_tps": official_p90,
    "model_calls": len(calls),
    "burst_calls": len(burst),
    "burst_rates": [round(c["rate"]) for c in burst],
    "shopping_rates": [round(c["rate"]) for c in shop],
    "shopping_tokens": [c["tokens"] for c in shop],
}
assert 0 <= timing["start_offset_ms"] < timing["status_offset_ms"] < timing["armed_offset_ms"] < timing["enter_offset_ms"] < timing["complete_offset_ms"] < timing["length_ms"]
edit_path.write_text(json.dumps(timing, indent=2) + "\n")
history_path.write_text(json.dumps(history, indent=2) + "\n")
print(f"{capture['score']}. {len(burst)} two-token calls + shopping calls at {timing['shopping_rates']} tok/s.")
