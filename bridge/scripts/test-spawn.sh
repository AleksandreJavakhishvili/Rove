#!/usr/bin/env bash
# Usage: ./scripts/test-spawn.sh <session-id>
# Looks up the session's cwd from its JSONL, then runs claude headless there
# with the same flags the bridge uses. Pipes a "hi" message and prints output.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <session-id>" >&2
  exit 1
fi

SESSION_ID="$1"

# Find the JSONL anywhere under ~/.claude/projects/
JSONL=$(find "$HOME/.claude/projects" -name "${SESSION_ID}.jsonl" -type f 2>/dev/null | head -1)
if [[ -z "$JSONL" ]]; then
  echo "no JSONL found for session $SESSION_ID" >&2
  exit 2
fi

# Extract cwd from the first line that has one
CWD=$(awk -F'"cwd":"' 'NF>1 {split($2, a, "\""); print a[1]; exit}' "$JSONL")
if [[ -z "$CWD" ]]; then
  echo "no cwd in $JSONL" >&2
  exit 3
fi

echo "session: $SESSION_ID"
echo "jsonl:   $JSONL"
echo "cwd:     $CWD"
echo "---"
echo "running claude headless from $CWD ..."
echo "---"

cd "$CWD"
echo '{"type":"user","message":{"role":"user","content":"reply with the single word: ok"}}' \
  | claude -p \
      --resume "$SESSION_ID" \
      --output-format stream-json \
      --input-format stream-json \
      --verbose \
      --permission-mode default \
      --allowedTools "Read Grep Glob Ls WebSearch"
