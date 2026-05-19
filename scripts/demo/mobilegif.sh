#!/usr/bin/env bash
# mobilegif.sh — turn an iPhone screen recording into a polished README GIF.
#
# Usage:
#   ./mobilegif.sh <name> [options]
#   ./mobilegif.sh batch                          # process everything in raw/
#   ./mobilegif.sh list                           # show what's in raw/
#
# Conventions:
#   raw/<name>.mov            — source recording (gitignored)
#   <name>.gif                — output (committed)
#
# Options:
#   --src PATH                Override source path (default: raw/<name>.mov)
#   --from SEC                Trim start (e.g. 1.5)
#   --to   SEC                Trim end   (e.g. 11)
#   --width PX                Output width in px (default 540)
#   --fps  N                  Output framerate (default 18 — small + smooth)
#   --speed X                 Playback speed multiplier (1.25 = 25% faster)
#   --rounded                 Round the corners (mobile-screen look)
#   --bg COLOR                Background color when rounding (default #0b0d12)
#
# Examples:
#   ./mobilegif.sh setup --from 1 --to 9 --rounded
#   ./mobilegif.sh chat  --from 0.5 --to 8 --speed 1.15 --rounded
#   ./mobilegif.sh diff  --width 480
#   ./mobilegif.sh batch                          # quick-render everything
#
# Requires: ffmpeg  (brew install ffmpeg)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEMO="$ROOT/scripts/demo"
RAW="$DEMO/raw"
cd "$ROOT"

die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found. Install: $2"; }

# Resolve <name> → source path. Prefer raw/<name>.<ext>, fall back to <name>.<ext>
# (handy if someone drops the file directly into scripts/demo/).
resolve_src() {
  local name="$1"
  for dir in "$RAW" "$DEMO"; do
    for ext in mov MOV mp4 MP4 m4v; do
      if [ -f "$dir/$name.$ext" ]; then echo "$dir/$name.$ext"; return; fi
    done
  done
  return 1
}

# Render a single source to <name>.gif using the supplied params.
render_one() {
  local name="$1" src="$2" from="$3" to="$4" width="$5" fps="$6" speed="$7" rounded="$8" bg="$9"
  local out="$DEMO/$name.gif"
  local palette="$DEMO/.${name}-palette.png"

  # Build the ffmpeg filter chain:
  #   1. fps + lanczos resize  → consistent target dimensions
  #   2. setpts (speed)        → speed up boring stretches
  #   3. corner mask (optional)→ rounded corners over solid bg
  # All in one chain so we only re-encode once per pass.
  local chain="fps=$fps,scale=$width:-2:flags=lanczos,setpts=PTS/$speed"

  if [ "$rounded" = "1" ]; then
    # 36px radius works at 540px wide (≈ iPhone screen rounding ratio). Scale
    # proportionally for other widths so it stays visually consistent.
    local r=$(( width * 36 / 540 ))
    # Composite the scaled video over a solid bg of the same size, then mask
    # the corners off using ffmpeg's geq-based alpha channel.
    chain="$chain,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(abs(X-W/2)+abs(Y-H/2)+0,W/2+H/2),0,if(lt(hypot(max(0,abs(X-W/2)-W/2+$r),max(0,abs(Y-H/2)-H/2+$r)),$r),255,0))'"
    # Flatten onto solid bg so the GIF (no alpha) shows our color, not white.
    chain="color=c=$bg:s=${width}x9999[bg];[0:v]$chain[fg];[bg][fg]scale2ref=w=iw:h=ih[bg2][fg2];[bg2][fg2]overlay=shortest=1"
  fi

  # Optional trim — uses input-side -ss/-to so the timestamps refer to the
  # original recording, not the resampled output (much more intuitive).
  # Built as a space-separated string (not an array) to play nice with
  # `set -u` empty-expansion rules.
  local trim=""
  [ -n "$from" ] && trim="$trim -ss $from"
  [ -n "$to" ]   && trim="$trim -to $to"

  info "render $name  src=${src##*/}  ${from:+from=$from }${to:+to=$to }w=${width} fps=${fps} speed=${speed}${rounded:+ rounded}"

  # Two-pass palette-optimized GIF — keeps gradients banding-free and file
  # size in the low hundreds of KB.
  if [ "$rounded" = "1" ]; then
    # shellcheck disable=SC2086
    ffmpeg -y $trim -i "$src" -filter_complex "$chain,palettegen=stats_mode=diff" -frames:v 1 "$palette" >/dev/null 2>&1
    # shellcheck disable=SC2086
    ffmpeg -y $trim -i "$src" -i "$palette" \
      -filter_complex "$chain[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
      "$out" >/dev/null 2>&1
  else
    # shellcheck disable=SC2086
    ffmpeg -y $trim -i "$src" -vf "$chain,palettegen=stats_mode=diff" "$palette" >/dev/null 2>&1
    # shellcheck disable=SC2086
    ffmpeg -y $trim -i "$src" -i "$palette" \
      -lavfi "$chain[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
      "$out" >/dev/null 2>&1
  fi
  rm -f "$palette"

  local kb=$(du -k "$out" | awk '{print $1}')
  ok "wrote $out (${kb} KB)"
}

cmd_render() {
  need ffmpeg "brew install ffmpeg"
  local name="$1"; shift || true
  [ -n "$name" ] || die "missing <name>. Try: $0 setup --from 1 --to 9 --rounded"

  local src="" from="" to="" width=540 fps=18 speed=1.0 rounded=0 bg="#0b0d12"
  while [ $# -gt 0 ]; do
    case "$1" in
      --src)     src="$2"; shift 2 ;;
      --from)    from="$2"; shift 2 ;;
      --to)      to="$2"; shift 2 ;;
      --width)   width="$2"; shift 2 ;;
      --fps)     fps="$2"; shift 2 ;;
      --speed)   speed="$2"; shift 2 ;;
      --rounded) rounded=1; shift ;;
      --bg)      bg="$2"; shift 2 ;;
      *) die "unknown flag: $1" ;;
    esac
  done

  if [ -z "$src" ]; then
    src="$(resolve_src "$name" || true)"
    [ -n "$src" ] || die "no source found for '$name' — expected raw/$name.mov (or .mp4)"
  fi
  [ -f "$src" ] || die "source not found: $src"

  render_one "$name" "$src" "$from" "$to" "$width" "$fps" "$speed" "$rounded" "$bg"
}

cmd_batch() {
  need ffmpeg "brew install ffmpeg"
  [ -d "$RAW" ] || die "no raw/ directory — create $RAW and drop your iPhone recordings there"
  local count=0
  shopt -s nullglob
  for f in "$RAW"/*.mov "$RAW"/*.MOV "$RAW"/*.mp4 "$RAW"/*.MP4 "$RAW"/*.m4v; do
    [ -f "$f" ] || continue
    local name; name="$(basename "$f")"; name="${name%.*}"
    render_one "$name" "$f" "" "" 540 18 1.0 0 "#0b0d12"
    count=$((count + 1))
  done
  shopt -u nullglob
  [ "$count" -gt 0 ] || warn "no recordings found in $RAW"
  ok "batch done ($count file$([ $count -eq 1 ] || echo s))"
}

cmd_list() {
  if [ ! -d "$RAW" ]; then
    warn "no raw/ directory yet — mkdir $RAW and AirDrop your iPhone recordings into it"
    return
  fi
  local found=0
  shopt -s nullglob
  for f in "$RAW"/*.mov "$RAW"/*.MOV "$RAW"/*.mp4 "$RAW"/*.MP4 "$RAW"/*.m4v; do
    [ -f "$f" ] || continue
    local name; name="$(basename "$f")"; name="${name%.*}"
    local dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null | awk '{printf "%.1fs", $1}')
    local kb=$(du -k "$f" | awk '{print $1}')
    local has_gif=" "
    [ -f "$DEMO/$name.gif" ] && has_gif="✓"
    printf "  %s  %-20s  %8s  %6sKB  %s\n" "$has_gif" "$name" "$dur" "$kb" "$f"
    found=1
  done
  shopt -u nullglob
  [ "$found" = 1 ] || warn "no recordings in $RAW yet"
}

case "${1:-}" in
  batch) cmd_batch ;;
  list)  cmd_list ;;
  -h|--help|"")
    sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
    ;;
  *) cmd_render "$@" ;;
esac
