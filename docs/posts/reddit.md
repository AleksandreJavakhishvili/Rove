# Reddit launch posts

Brief, on-point, no fluff. Each subreddit gets its own framing — same product,
different hook for different crowds.

Recommended order: **r/selfhosted** → **r/LocalLLaMA** (+1 day) → **r/ClaudeAI**
(+2 days). 24h gap minimum to avoid cross-posting penalties.

---

## r/selfhosted

**Title**
```
Rove – drive your CLI coding agents from your phone over Tailscale (no relay, no cloud)
```

**Body**
```
Your phone, your laptop, your tailnet. Nothing in between.

Tiny Node bridge runs next to `claude` on your desktop. Expo app on your phone talks to it peer-to-peer over your tailnet. No relay server, no accounts, no telemetry.

Bonus that surprised me: swipe left in the chat → live WebView of the dev server your agent is editing. Edit a CSS variable from your phone → watch the page re-theme on the same screen.

Stack: Node 22 + Hono, Expo / React Native, optional Let's Encrypt via `tailscale cert` for real HTTPS. ~3 MB bridge, no DB, no daemon.

MIT. https://github.com/AleksandreJavakhishvili/Rove
```

---

## r/LocalLLaMA

**Title**
```
Self-hosted mobile UI for CLI coding agents — Claude Code today, agent-agnostic by design
```

**Body**
```
Tiny Node bridge on your laptop + Expo app on your phone, peer-to-peer over Tailscale. Reads the agent's session JSONLs, spawns it in headless mode per turn, streams normalized events to the phone.

Today: Claude Code only.

By design: AgentDriver interface in `bridge/src/agents/types.ts` is the extension point. ~200 lines of TS per driver for Codex / Aider / Gemini / anything that speaks a stream-json-ish protocol — list sessions, spawn, translate events.

Mobile gets: chat, inline diffs, tool cards, approval sheets, sub-agent indentation, file/image attach, live dev-server preview one swipe away from the chat.

https://github.com/AleksandreJavakhishvili/Rove — feedback / driver PRs welcome.
```

---

## r/ClaudeAI

**Title**
```
Vibe-code from your phone. Your Claude. Your tailnet. No relay.
```

**Body**
```
Built a fully self-hosted mobile client for Claude Code.

Bridge on your laptop + app on your phone, peer-to-peer over your own Tailscale. Your turns never leave your devices.

What you get from your phone:
- Chat with streaming text, tool cards, inline diffs
- Approval sheets for risky tools (Bash, Write, MCP)
- Sub-agent activity nested under its parent Task
- File + image attach (Claude reads images natively)
- Live WebView of your dev server, one swipe away
- Resume sessions started on your desktop, take ownership from the phone

MIT. No accounts, no telemetry, no third party in the path.

https://github.com/AleksandreJavakhishvili/Rove
```

---

## Tailscale community Slack (#community-showcase)

```
Built a mobile dev tool that uses Tailscale as the entire network — Rove, a self-hosted mobile client for CLI coding agents (Claude Code today). Bridge on your laptop + Expo app on your phone, peer-to-peer over tailnet, no relay.

Tailscale-specific bits that made it nice to build:
• `tailscale status --json` for auto-detecting the device's tailnet identity at startup — no config
• `tailscale cert` for free Let's Encrypt on the `.ts.net` hostname so iOS gets real HTTPS without ATS hacks
• MagicDNS hostname embedded in a QR — phone scans once, connected

Repo: https://github.com/AleksandreJavakhishvili/Rove
```

---

## Etiquette (applies to all)

- **First 3 hours decide the thread.** Be in the comments, reply to every top-level question.
- **No vote rings.** Reddit detects coordinated upvoting; r/selfhosted mods are vigilant. One organic upvote > ten asked-for ones.
- **If asked "why not <competitor>?"**: "It's more polished and ships in app stores. rove is for the case where you specifically don't want any relay in the path, even an encrypted one. Both can exist."
- **Flair correctly** on r/ClaudeAI (look for "Project Showcase" or similar) and r/selfhosted (usually "Self-Promotion" or "Releases").
- **Don't repost on the same day** if removed. Message the mod once asking what to fix, then wait.
