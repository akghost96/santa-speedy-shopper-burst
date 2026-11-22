"""Render the video of one burst session (60 s at most): the status-check phase sped up, the shopping turn, a score card.

    python3 burst/burst_edit.py <raw.webm> <edit.json> <out.mp4>

Uses the drawing and ffmpeg helpers of ../.recording-work/edit.py. The playback speed of every sped-up part is shown
in the title strip.
"""
import json
import math
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / ".recording-work"))
from edit import ACCENT, ENCODE, MUTED, OPENING, ROOT, WORK, footage, join, still, text, video  # noqa: E402
from timed_edit import duration  # noqa: E402

raw, edit_json, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2]), Path(sys.argv[3]).resolve()
run = json.loads(edit_json.read_text())
length = duration(raw)
lead = run["start_offset_ms"] / 1000
armed = run["armed_offset_ms"] / 1000
CARD = 5.0
BUDGET = 59.0


def sped(name, start, end, speed):
    target = WORK / f"{name}-source.mp4"
    video(["-i", str(raw), "-vf", f"fps=30,trim=start={start}:end={end},setpts=(PTS-STARTPTS)/{speed},fps=30", *ENCODE, str(target)])
    return target


shop_len = length - armed
shop_speed = max(1, math.ceil(shop_len / 34))
status_len = armed - lead
status_speed = max(1, math.ceil(status_len / (BUDGET - CARD - shop_len / shop_speed)))


def scoreboard(draw):
    text(draw, (84, 116), "Experimental burst entry", 34, bold=True)
    text(draw, (80, 205), f"{run['mean_tps']:,}", 170, ACCENT, True)
    text(draw, (90, 405), "mean tokens/sec  (session badge of the official patch)", 36, bold=True)
    text(draw, (90, 470), f"{run['p90_tps']:,} p90  ·  {run['model_calls']} model calls", 30, MUTED)
    text(draw, (90, 545), f"{run['burst_calls']} status calls of 2 output tokens each, plus 2 shopping calls", 30, bold=True)
    shop = " and ".join(f"{rate:,}" for rate in run["shopping_rates"])
    text(draw, (90, 600), f"The two shopping calls alone ran at {shop} tok/s.", 30, MUTED)
    text(draw, (90, 682), f"Enter to five product links   {run['elapsed_ms'] / 1000:.2f} s", 30, bold=True)


parts = []
status_src = sped("burst-status", lead, armed, status_speed) if status_speed > 1 else raw
parts.append(footage(
    "burst-status", status_src, 0 if status_speed > 1 else lead, duration(status_src) if status_speed > 1 else status_len,
    f"Status checks · {status_speed}× playback" if status_speed > 1 else "Status checks", "2 output tokens per call", OPENING,
))
shop_src = sped("burst-shop", armed, length, shop_speed) if shop_speed > 1 else raw
parts.append(footage(
    "burst-shop", shop_src, 0 if shop_speed > 1 else armed, duration(shop_src) if shop_speed > 1 else shop_len,
    f"Shopping turn · {shop_speed}× playback" if shop_speed > 1 else "Santa’s Speedy Shopper", "Kimi K3.1 Pro on Cerebras", OPENING,
))
parts.append(still("burst-score", CARD, scoreboard))
join("santa-burst-render", parts)
out.parent.mkdir(parents=True, exist_ok=True)
shutil.move(str(ROOT / "santa-burst-render.mp4"), str(out))
total = duration(out)
assert total <= 60.0, total
print(f"{out.name}: {total:.1f} s (status ×{status_speed}, shopping ×{shop_speed})")
