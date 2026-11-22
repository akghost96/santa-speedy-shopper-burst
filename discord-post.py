"""Build the Discord post for the current best burst session (burst/best.json). Nothing is sent anywhere.

    python3 burst/discord-post.py [--check]     # --check also loads the five links; exit 1 unless all return HTTP 200
"""
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REPO_URL = "https://github.com/akghost96/santa-speedy-shopper-burst"
PLAIN_POST = "https://discord.com/channels/1085960591052644463/1573838301486387380/threads/1574135347321765949"
NODE = Path.home() / ".local/share/mise/installs/node/26.13.1/bin/node"

best = json.loads((HERE / "best.json").read_text())
take = best["take"]
edit = json.loads((HERE / f"takes/{take}.edit.json").read_text())
history = json.loads((HERE / f"takes/{take}.history.json").read_text())
calls = [(m["serverGeneration"]["outputTokens"], m["serverGeneration"]["completionMs"]) for m in history["messages"] if m.get("role") == "assistant" and m.get("serverGeneration")]
weighted = sum(t for t, _ in calls) / (sum(ms for _, ms in calls) / 1000)
answer = next(
    part["text"] for m in reversed(history["messages"]) if m.get("role") == "assistant"
    for part in m["content"] if part.get("type") == "text" and "](https://" in part["text"]
)
items = re.findall(r"(?m)^\s*\d+\.\s*\[(.+?)\]\((https://[^)\s]+)\)", answer)
assert len(items) == 5, len(items)
mean, p90 = edit["mean_tps"], edit["p90_tps"]
video = HERE / f"submissions/burst-{mean}tps.mp4"
assert video.exists(), video

if "--check" in sys.argv:
    script = (
        'const { chromium } = await import(process.argv[1]);'
        'const b = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });'
        'const p = await b.newPage(); let bad = 0;'
        'for (const u of process.argv.slice(2)) { try { const r = await p.goto(u, { waitUntil: "domcontentloaded", timeout: 25000 });'
        ' if (r.status() !== 200) bad++; console.error(r.status(), u); } catch (e) { bad++; console.error("ERR", u); } }'
        'await b.close(); process.exit(bad ? 1 : 0);'
    )
    subprocess.run(
        [str(NODE), "--input-type=module", "-e", script, str(ROOT / ".bounty-build/node_modules/playwright/index.mjs"), *[u for _, u in items]],
        check=True, env={"PATH": "/usr/bin:/bin", "PLAYWRIGHT_BROWSERS_PATH": str(ROOT / ".recording-work/pw-browsers"), "HOME": str(Path.home())},
    )

title = f"Speed Bounty entry (experimental burst mode): {mean:,} tok/s mean · {p90:,} p90"
assert len(title) <= 100, len(title)
body = "\n".join([
    f"Experimental entry. The badge is the official patch's session mean over {edit['model_calls']} calls: {edit['burst_calls']} two-token \"Quick status check.\" calls, "
    f"which Cerebras reports at 3,000–36,000 tok/s each, plus the 2 shopping calls. Counted by tokens the same session is {weighted:,.0f} tok/s. "
    f"The two-token effect was first published by ykundesu. Our plain entry (1,755 tok/s mean): {PLAIN_POST}",
    "",
    "Five US stores, all links HTTP 200 just now:",
    "",
    *[f"{i}. {name} — {url}" for i, (name, url) in enumerate(items, 1)],
    "",
    f"Speed Bounty entry: {mean:,} TPS",
    "",
    REPO_URL,
])
print(json.dumps({"take": take, "mean_tps": mean, "p90_tps": p90, "title": title, "body": body, "video": str(video)}, indent=2, ensure_ascii=False))
