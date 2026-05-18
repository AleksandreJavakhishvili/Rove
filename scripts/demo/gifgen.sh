#!/usr/bin/env bash
# gifgen.sh — produce the README demo assets for Rove.
#
# Subcommands:
#   bridge    Record the bridge startup terminal → bridge.gif      (needs: vhs)
#   phone     Convert a manually-recorded iPhone .mov/.mp4 → phone.gif (needs: ffmpeg)
#   combine   Stitch bridge.gif + phone.gif side-by-side → demo.gif    (needs: ffmpeg)
#   all       bridge → phone → combine
#
# Inputs you provide manually:
#   scripts/demo/phone.mov   — iOS screen recording of: QR scan → chat opens →
#                              type "fix the bug in src/foo.ts" → diff appears.
#                              Trim to 8–12s before running `phone`.
#
# Why two halves?
#   The bridge half can be scripted (vhs). The phone half can't (no headless
#   simulator path that's worth the bother). Record once on your iPhone, then
#   this script handles the rest.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEMO="$ROOT/scripts/demo"
cd "$ROOT"

# ---------- helpers -----------------------------------------------------------

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found. Install: $2"
}

# ---------- bridge ------------------------------------------------------------

cmd_bridge() {
  need vhs "brew install vhs"
  info "Recording bridge.tape (this runs the real bridge for ~16s)…"
  vhs "$DEMO/bridge.tape"
  ok "wrote $DEMO/bridge.gif"
}

# ---------- phone -------------------------------------------------------------

cmd_phone() {
  need ffmpeg "brew install ffmpeg"
  local src
  for ext in mov mp4 MOV MP4; do
    if [ -f "$DEMO/phone.$ext" ]; then src="$DEMO/phone.$ext"; break; fi
  done
  [ -n "${src:-}" ] || die "no phone.mov / phone.mp4 in $DEMO — record one on your iPhone first."
  info "Converting $src → phone.gif (palette-optimized)…"

  # Two-pass: build an optimal 256-color palette from the video, then map.
  # Result: smaller file, no banding on the gradient backgrounds.
  local palette="$DEMO/.phone-palette.png"
  ffmpeg -y -i "$src" -vf "fps=18,scale=540:-1:flags=lanczos,palettegen=stats_mode=diff" "$palette" >/dev/null 2>&1
  ffmpeg -y -i "$src" -i "$palette" \
    -lavfi "fps=18,scale=540:-1:flags=lanczos[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    "$DEMO/phone.gif" >/dev/null 2>&1
  rm -f "$palette"
  ok "wrote $DEMO/phone.gif"
}

# ---------- combine -----------------------------------------------------------

cmd_combine() {
  need ffmpeg "brew install ffmpeg"
  [ -f "$DEMO/bridge.gif" ] || die "missing $DEMO/bridge.gif — run \`$0 bridge\` first."
  [ -f "$DEMO/phone.gif" ]  || die "missing $DEMO/phone.gif — run \`$0 phone\` first."

  info "Stacking bridge + phone side-by-side → demo.gif…"

  # Normalize heights so hstack lines up cleanly. Bridge is wider, phone is
  # taller — scale both to the same height, pad the bridge to that height with
  # the dark Catppuccin background to avoid letterboxing artifacts.
  local palette="$DEMO/.demo-palette.png"
  local filter='[0:v]scale=-1:720[b];[1:v]scale=-1:720[p];[b][p]hstack=inputs=2[out]'

  ffmpeg -y -i "$DEMO/bridge.gif" -i "$DEMO/phone.gif" \
    -filter_complex "${filter},[out]palettegen=stats_mode=diff" \
    "$palette" >/dev/null 2>&1

  ffmpeg -y -i "$DEMO/bridge.gif" -i "$DEMO/phone.gif" -i "$palette" \
    -filter_complex "${filter};[out][2:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    "$DEMO/demo.gif" >/dev/null 2>&1
  rm -f "$palette"
  ok "wrote $DEMO/demo.gif — drop this at the top of README.md"
}

# ---------- entrypoint --------------------------------------------------------

case "${1:-}" in
  bridge)  cmd_bridge ;;
  phone)   cmd_phone ;;
  combine) cmd_combine ;;
  all)     cmd_bridge && cmd_phone && cmd_combine ;;
  ""|-h|--help)
    sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
    ;;
  *) die "unknown subcommand: $1 (try: bridge | phone | combine | all)" ;;
esac
