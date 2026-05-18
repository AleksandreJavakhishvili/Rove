#!/usr/bin/env bash
# Regenerates all raster icon PNGs from the SVG sources in assets/logo/.
# Requires librsvg: brew install librsvg

set -euo pipefail
cd "$(dirname "$0")/.."

SRC=assets/logo
DST=mobile/assets/images

if ! command -v rsvg-convert >/dev/null; then
  echo "error: rsvg-convert not found" >&2
  echo "install with: brew install librsvg" >&2
  exit 1
fi

mkdir -p "$DST"

# iOS app icon — square 1024 PNG, no transparency; iOS rounds it.
rsvg-convert -w 1024 -h 1024 "$SRC/icon-app.svg" -o "$DST/icon.png"

# Splash logo — same as app icon for now.
rsvg-convert -w 1024 -h 1024 "$SRC/icon-app.svg" -o "$DST/splash-icon.png"

# Android adaptive icon — three separate layers.
rsvg-convert -w 1024 -h 1024 "$SRC/icon-foreground.svg" -o "$DST/android-icon-foreground.png"
rsvg-convert -w 1024 -h 1024 "$SRC/icon-background.svg" -o "$DST/android-icon-background.png"
rsvg-convert -w 1024 -h 1024 "$SRC/icon-mono.svg"      -o "$DST/android-icon-monochrome.png"

# Web favicon.
rsvg-convert -w 192 -h 192 "$SRC/icon-app.svg" -o "$DST/favicon.png"

echo "Regenerated:"
ls -lh "$DST"/icon.png "$DST"/splash-icon.png "$DST"/android-icon-*.png "$DST"/favicon.png | awk '{print "  "$9" ("$5")"}'
