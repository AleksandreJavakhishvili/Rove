# `web/` — landing + GitHub Pages build

This directory owns the rove web product. Two things live here:

- **`landing/`** — hand-written HTML/CSS landing page served at the root of the GitHub Pages site. No bundler, no framework, ~5 KB.
- **`dist/`** — build output uploaded to GitHub Pages by `.github/workflows/deploy-web.yml`. Not checked in.

The actual web app — i.e., the React Native Web build of the mobile app — comes from `../mobile/`. The build script in `package.json` invokes `expo export` against `../mobile`, writes its output under `dist/app/`, then drops the landing files at `dist/` so the layout becomes:

```
dist/
  index.html          ← landing
  wordmark.svg
  og-card.png
  app/
    index.html        ← Expo Router entry
    404.html          ← SPA fallback (a copy of index.html)
    favicon.ico
    settings.html
    sessions/...
    _expo/static/...  ← JS bundle, assets
```

## Build

```sh
# from this directory
pnpm install               # one-time (no real deps, just registers the workspace)
cd ../mobile && pnpm install   # required — Expo's CLI runs from mobile/
cd ../web
pnpm build                 # or: ROVE_WEB_BASE_URL=/<repo>/app/ pnpm build
```

`ROVE_WEB_BASE_URL` controls the absolute prefix Expo bakes into emitted asset URLs. For GitHub Pages at `https://<owner>.github.io/<repo>/`, set it to `/<repo>/app/`. For local serving from the project root, leave it unset and the bundle resolves at `/app/`.

## Preview locally

```sh
pnpm build
npx serve dist -l 4173
# open http://localhost:4173/
```

Click "Launch web app" — the page navigates to `http://localhost:4173/app/`.

## Why not just put this inside `mobile/`?

The landing is plain HTML/CSS with no React Native code. The build output combines two sources — the Expo bundle and the hand-written landing — and belongs to neither of them alone. Giving it its own directory keeps `mobile/` focused on React Native and makes the GitHub Pages story one self-contained concern.
