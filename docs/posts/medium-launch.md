# Vibe coding from your phone — without anyone else's servers

*Building Rove: a fully self-hosted mobile client for Claude Code over your own Tailscale*

<!--
  First image = Medium's social card thumbnail (Twitter / LinkedIn / Slack
  embeds use it). 1200×630 landscape composite — headline left, phone right.
  Re-render via `scripts/demo/social-card/render.sh`.
-->

![Rove — your coding agent, in your pocket. Drive Claude Code from your phone over Tailscale.](https://raw.githubusercontent.com/AleksandreJavakhishvili/Rove/main/assets/social/og-card.png)

![Rove demo — type a prompt on your phone, watch the dev server reload live in the same screen](https://raw.githubusercontent.com/AleksandreJavakhishvili/Rove/main/scripts/demo/preview.gif)

I built **Rove** because every existing mobile client for Claude Code routes through someone else's server. Even with end-to-end encryption, the relay still exists — your laptop sends bytes to their cloud, their cloud relays to your phone. If their company disappears or their pricing changes, your "mobile Claude Code" stops working.

Rove doesn't have that layer. Your phone talks directly to a tiny Node daemon on your laptop, over your own Tailscale. Nothing in the middle.

## What it is

Two pieces:

1. **A bridge** — small Node.js daemon on your laptop. Lists your Claude Code sessions, spawns `claude -p --resume <id>` per turn, streams events over WebSocket.
2. **A mobile app** — Expo / React Native. Reads history, sends prompts, watches tool calls execute, approves operations, views diffs.

They talk peer-to-peer over Tailscale. If I disappear tomorrow, your install keeps working — there's no service to shut down.

```
┌────────────────┐                          ┌────────────────────────────────┐
│ Phone (Expo)   │  Tailscale (HTTPS/WSS)   │ Your desktop                   │
│  chat + diff   ├─────────────────────────►│  bridge (Hono + WebSocket)     │
│  approvals     │                          │  spawns claude -p per turn     │
│  live preview  │                          │  ~/.claude/projects/.../*.jsonl│
└────────────────┘                          └────────────────────────────────┘
```

## The headline feature: live preview

That's what the GIF at the top is showing. Because your phone is on the tailnet too, it can reach *anything* on your laptop — not just the bridge. Every listening port. Your Vite dev server. Your local API. Your Storybook.

Swipe left in the chat, and the bridge runs `lsof` to enumerate listening TCP ports, cross-references each PID's working directory, and keeps the ones whose cwd is inside the session's project. Vite at `:5173` in this repo? Match. Random server in `/tmp`? Not a match.

The matches show up as chips in a picker. Tap one, and the WebView loads `http://<your-tailnet-hostname>:<port>` directly. As Claude refactors a component, the page reflows on your phone in real time — exactly the moment captured at the top of this post, where one `--accent` CSS variable change re-themes the entire page. Hot module reloading works. Local APIs respond.

You can rename detected servers ("Landing", "Storefront API"); labels persist per session. If a server is bound to `127.0.0.1` only — which Vite frustratingly defaults to — the WebView shows a framework-specific hint to rebind, not a broken page.

This took about a day to build, and it's the feature I'm most surprised by. The architecture made it almost free: the bridge doesn't have to proxy, just tell the phone where to look.

## Live-streaming desktop sessions

A second feature fell out naturally: tailing the JSONL when the desktop owns a session.

You start `claude` in your laptop terminal before lunch and leave. From your phone in the cafe, you want to see how it's going. Rove watches the session's JSONL with `fs.watch`, streams new entries as they're appended, and stops the watcher when you leave the chat. One file handle per open chat, zero background work otherwise.

You can take over with one tap — the bridge SIGTERMs the desktop `claude` and you're driving from your phone.

## Tradeoffs

- **Needs Tailscale.** Already on it? Zero added complexity. Not on it? Learning curve. The point of the project is to not put anything in the middle, so this is non-negotiable.
- **Claude Code only, today.** Codex / Aider / Gemini drivers are scaffolded; nobody's implemented them yet.
- **iOS needs a one-time native dev build** (WebView is a native module). `npx expo run:ios` once, then hot reload normally.
- **Can't start *new* sessions from the phone yet** — resume, view, take over, stream all work. New sessions still need a desktop `claude`. On the roadmap.

Built end-to-end in pair-programming with Claude Code itself. SDD docs in the repo show the design process if you're curious.

## Try it

```bash
git clone https://github.com/AleksandreJavakhishvili/Rove
cd Rove/bridge && pnpm install && pnpm start
```

![Bridge startup — pnpm start prints a QR with the connection URL and token](https://raw.githubusercontent.com/AleksandreJavakhishvili/Rove/main/scripts/demo/bridge.gif)

Then the mobile app:

```bash
cd ../mobile && pnpm install && npx expo run:ios
```

Scan the QR. Done.

Free, MIT, no accounts, no telemetry, no signup. Issues page is the place if you build something or break something.

Repo: **[github.com/AleksandreJavakhishvili/Rove](https://github.com/AleksandreJavakhishvili/Rove)**
