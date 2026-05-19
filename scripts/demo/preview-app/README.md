# Preview demo app

A small Vite + React landing page used as the recording target for Rove's
**live preview** pane. The whole app is designed for visible, one-line
changes: edit a CSS variable or a string, watch Vite HMR push it through to
the WebView in the Rove app.

## Run it

```bash
cd scripts/demo/preview-app
pnpm install
pnpm dev
```

This binds to `0.0.0.0:5173` (Vite's `--host`) so Rove's preview-port scanner
on the bridge can see it. Confirm with `curl http://localhost:5173` — you
should get HTML.

## Wire it to a Rove session

1. With this app running, open `claude` (or `pnpm start` the bridge first)
   in this directory: `cd scripts/demo/preview-app && claude`.
2. Send any first message so the session JSONL is created in
   `~/.claude/projects/...`.
3. In the Rove mobile app, you'll see the new session. Open it.
4. **Swipe left** on the chat → preview pane appears with Helix loaded.

The bridge auto-labels Vite, so it shows up as "Vite · 5173" in the picker.

## What to edit for the demo

Each of these is a high-signal single-line change. Use one per recording
take to keep `preview.gif` short:

| Prompt to your phone                                          | What changes visibly                          |
| ------------------------------------------------------------- | --------------------------------------------- |
| "change the headline to 'Hello from my phone'"                | The big H1 text                               |
| "make the accent color green (#14d3a3)"                       | Buttons, badge, gradient on `em`              |
| "rename the brand to Atlas"                                   | Top-left wordmark                             |
| "swap the primary button label to 'Start free trial'"         | Hero CTA                                      |
| "add a fourth feature card titled 'Open source'"              | Grid grows                                    |
| "switch to a pink → orange gradient on the headline"          | `.headline em` background gradient            |

For the very first recording, "make the accent color green" is the most
dramatic — it touches the badge, the primary button, the headline gradient,
*and* the card hover state all from one `--accent` CSS variable. Great
"watch a single line of code reshape the whole page" moment.

## Recording the GIF

After running the prompt and seeing the change land in the WebView,
stop the recording and follow [`../RECORDING.md`](../RECORDING.md):

```bash
# AirDrop the .mov to scripts/demo/raw/preview.mov, then:
./scripts/demo/mobilegif.sh preview --from 0.5 --to 10 --rounded
```

## Not part of the published package

This directory is intentionally outside the bridge/mobile workspaces. It
exists only as a recording target. Feel free to delete it if you want to
prune the repo — nothing in `bridge/` or `mobile/` imports from here.
