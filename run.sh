#!/bin/zsh
# Refresh Meta-Nav. launchd fires this on the hour (metanav.plist -> ~/Library/LaunchAgents/local.metanav.plist) and it works
# on weekdays within config.hours; `metanav` (an alias in ~/.zshrc) and the panel's SYNC NOW button fire it on demand, at any hour.

SKILL="${0:A:h}"
NAME="${SKILL:t}"   # the skill is called after its folder: /metanav

# launchd starts with a bare environment; the installer writes the user's PATH here
export PATH="__PATH__"

OUT=$(jq -r '.output_dir // "~/metanav"' "$SKILL/config.json")
OUT="${OUT/#\~/$HOME}"
START=$(jq -r '.hours.start // 9' "$SKILL/config.json")
END=$(jq -r '.hours.end // 18' "$SKILL/config.json")

# `metanav` drops a .manual flag first: a run the user asked for ignores the hours
if [[ -f "$OUT/.manual" ]]; then
  rm -f "$OUT/.manual"
else
  [[ $(date +%u) -le 5 && $(date +%-H) -ge $START && $(date +%-H) -le $END ]] || exit 0
fi

mkdir -p "$OUT/logs" && cd "$OUT" || exit 1

# One run at a time - a slow run shouldn't overlap the next tick. A lock older than
# 20 minutes is left over from a run that died (lid closed, power off): clear it, or
# every later run would skip silently.
[[ -n $(find .running -maxdepth 0 -mmin +20 2>/dev/null) ]] && rmdir .running
mkdir .running 2>/dev/null || exit 0
trap 'rmdir "$OUT/.running"' EXIT

# Show "Syncing…" on the open panel until this run rewrites it
python3 "$SKILL/render.py" --syncing

# The run collects with collect.mjs (a headless Chrome of its own, so no window pops up) and only judges,
# so it needs no browser tools: --strict-mcp-config with no config loads no MCP server.
# "unattended": nobody reads this run while it works, so it must never stop to ask (SKILL.md).
# The model that judges is a setting: config.json "judge_model" (opus; sonnet is faster but follows the rules less reliably).
MODEL=$(jq -r '.judge_model // "sonnet"' "$SKILL/config.json")
claude -p "/$NAME unattended" --model "$MODEL" \
  --strict-mcp-config \
  --permission-mode auto \
  --allowedTools "Skill" "Read" "Write" \
  --output-format json \
  > "logs/$(date +%Y%m%d-%H%M).json" 2>&1

# A run that failed never re-rendered: take the "syncing" flag back off. The panel then
# shows the last good result, marked stale once it's over 90 minutes old.
grep -q '"syncing": true' index.html 2>/dev/null && python3 "$SKILL/render.py" --idle

# The collector's inputs hold private chats and mail. Deleted here, not by the run itself, so it happens
# every time, even after a failed run.
rm -rf "$OUT/.inputs"

find logs -name '*.json' -mtime +7 -delete
