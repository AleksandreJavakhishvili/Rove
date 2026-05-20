Rove – Vibe-code from your phone. Your agents, your tailnet.




I built this because existing mobile clients for coding agents route my turns through someone else's server, even with E2E encryption. I wanted the actual property: nothing in between my phone and my laptop.

Rove is two pieces you self-host:

- A small Node bridge that runs alongside your CLI agent on your desktop. It speaks the agent's headless protocol, exposes each session as HTTP+WebSocket on your tailnet, and forwards approval requests through an MCP permission-prompt tool back to your phone. The AgentDriver interface is the extension point — Claude Code is implemented today; Codex / Aider / Gemini drivers are scaffolded.
- An Expo React Native app. Reads history, sends prompts, streams tool calls and diffs as they happen, shows approval prompts as bottom sheets, surfaces sub-agent activity with proper indentation, lets you attach images and files.

The headline feature surprised me: live dev-server preview. Because your phone is on the same tailnet, it can reach anything listening on your laptop, not just the bridge. The bridge runs lsof to enumerate listeners, matches PIDs whose cwd sits inside the session's project, and the mobile app loads them in a WebView one swipe away from the chat. Edit a CSS variable from your phone → watch the page re-theme in real time on the same screen.

Sessions persist as JSONL files in `~/.claude/projects/` (and similar for future agents). Takeover from desktop works (bridge SIGTERMs the existing agent process). Session renaming, file uploads, push notifications when off-screen are all wired.

Tradeoffs:
- Needs Tailscale. That's the whole point — non-negotiable.
- Only Claude Code is end-to-end functional today; the other driver slots exist but are unimplemented.
- iOS needs a one-time `npx expo run:ios` because the WebView is a native module. Android works via EAS preview build.
- Can't start brand-new sessions from the phone yet, only resume / take over. On the roadmap.

MIT, no accounts, no telemetry. Architecture diagram + wire protocol are in docs/. Happy to answer questions or take feedback on what to build next.
