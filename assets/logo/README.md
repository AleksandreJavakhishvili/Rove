# Logo assets

Three SVGs:

- **`mark.svg`** — the icon alone, `currentColor` so it inherits the host's text color. Drop into a `<img>` or inline in markdown for headers.
- **`wordmark.svg`** — icon + "rove" wordmark, single line. Used at the top of the root `README.md`.
- **`icon-app.svg`** — square solid-color app icon (`#0a7ea4` brand teal + white arc). Source for generating the iOS / Android app icons in the `mobile/` package.

## Visual concept

Two nodes connected by a light arc. The arc evokes the trajectory of an idea passing between your phone (one node) and your desktop agent (the other node), roving apart but tethered. The shape works at any size from 16px favicon to 1024px app icon.

## Generating raster sizes from `icon-app.svg`

If you have ImageMagick or rsvg-convert installed:

```bash
# iOS app icon (1024×1024 base; Expo auto-generates the other sizes from this)
rsvg-convert -w 1024 -h 1024 icon-app.svg -o ../../mobile/assets/images/icon.png

# Android adaptive icon foreground (use a transparent background SVG)
# (you'll want to commission a designer for the adaptive foreground/background pair eventually)
```

## Replacing later

These are intentionally minimal placeholders. When you want a real identity, commission a designer — keep the two-nodes-+-arc as the core visual idea unless you've got a better one. Designers tend to overload identity work; keep this one minimal.
