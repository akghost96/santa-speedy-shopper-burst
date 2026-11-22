#!/usr/bin/env bash
# Record burst sessions against the burst gateway (port 18893) until a deadline; keep the best verified one.
#   burst/record-burst.sh <minutes> [status-turns=12] [limit_ms=300000]
# Every session: N "Quick status check." turns, then the shopping prompt. Verified against the transcript; the best
# is rendered to burst/submissions/burst-<mean>tps.mp4. Results: burst/results.jsonl.
set -u
here="$(dirname "$(realpath "$0")")"; project="$(dirname "$here")"
node="${OPENCLAW_BOUNTY_NODE:-$HOME/.local/share/mise/installs/node/26.13.1/bin/node}"
minutes="${1:-30}"; turns="${2:-12}"; limit="${3:-300000}"
deadline=$(( $(date +%s) + minutes * 60 ))
best_file="$here/best.json"
mkdir -p "$here/takes" "$here/raw" "$here/submissions"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$project/.recording-work/pw-browsers}"
i=0
while [ "$(date +%s)" -lt "$deadline" ] && [ ! -e "$here/.stop" ]; do
  i=$((i + 1)); id="b$(date +%s)t$i"
  export BURST_KEY="agent:main:burst-take-$id" BURST_TURNS="$turns" BURST_LIMIT="$limit" \
    BURST_RAW="$here/raw/$id.webm" BURST_JSON="$here/takes/$id.capture.json" BURST_PNG="$here/takes/$id.result.png"
  "$here/burst-openclaw" gateway call sessions.create --json --params "{\"key\":\"$BURST_KEY\"}" >/dev/null 2>&1 || { echo "$id: sessions.create failed"; sleep 3; continue; }
  if ! timeout $(( limit / 1000 + 90 )) "$node" "$here/capture-burst.mjs" >"$here/takes/$id.capture.log" 2>&1; then
    echo "$id: no complete session ($(tail -1 "$here/takes/$id.capture.log" | cut -c1-80))"; sleep 2; continue
  fi
  if ! python3 "$here/verify_burst.py" "$BURST_JSON" "$BURST_RAW" "$here/takes/$id.edit.json" "$here/takes/$id.history.json" >"$here/takes/$id.verify.log" 2>&1; then
    echo "$id: verification failed ($(tail -1 "$here/takes/$id.verify.log" | cut -c1-120))"; rm -f "$BURST_RAW"; continue
  fi
  read -r mean p90 < <(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["mean_tps"], d["p90_tps"])' "$here/takes/$id.edit.json")
  printf '{"id": "%s", "mean_tps": %s, "p90_tps": %s, "turns": %s, "at": "%s"}\n' "$id" "$mean" "$p90" "$turns" "$(date +%H:%M:%S)" >> "$here/results.jsonl"
  echo "$id: verified $mean mean / $p90 p90 ($turns status turns)"
  best=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["mean_tps"])' "$best_file" 2>/dev/null || echo 0)
  if [ "$mean" -gt "$best" ]; then
    if (flock 9; python3 "$here/burst_edit.py" "$BURST_RAW" "$here/takes/$id.edit.json" "$here/submissions/burst-${mean}tps.mp4") 9>"$project/.recording-work/.render.lock" >"$here/takes/$id.render.log" 2>&1; then
      printf '{"mean_tps": %s, "p90_tps": %s, "take": "%s", "turns": %s, "file": "submissions/burst-%stps.mp4"}\n' "$mean" "$p90" "$id" "$turns" "$mean" > "$best_file"
      echo "$id: NEW BURST VIDEO ($mean mean / $p90 p90) -> burst/submissions/burst-${mean}tps.mp4"
    else
      echo "$id: render failed (see takes/$id.render.log)"
    fi
  else
    rm -f "$BURST_RAW" "$BURST_PNG"
  fi
done
echo "finished: best $(cat "$best_file" 2>/dev/null)"
