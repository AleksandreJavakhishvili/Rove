# Rove Secrets — High-Level Architecture

Related: [frd.md](./frd.md), [plan.md](./plan.md)

## Scope

v1 = **`set_secret`**, a write-through path. No persistent vault. The destination file (`.env`) is the only at-rest copy. The **read / use** problem (preventing read-back, or using a secret without exposing it) is **out of scope** — an agent-runtime concern, not Rove's. See [frd.md](./frd.md) "Out of scope: the read / use problem."

## Design principles

1. **The value never enters the SDK message stream.** The Claude Code SDK — not the bridge — writes the JSONL. The `set_secret` tool *input* carries only a name + path; the *result* is value-hidden; the value arrives on a side channel the SDK never sees and is consumed directly by the bridge writer.
2. **The bridge is a write-through conduit, not a store.** It holds the value only transiently in memory to perform the file write, then drops it. No keychain, no DB.
3. **Reuse the broker pattern.** The request→sheet→response round-trip is the exact shape used by `screenshotBroker` / `handoffBroker`; secrets get a sibling.

## Topology

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Bridge (Node)                                                             │
│                                                                           │
│  Agent turn (Claude Code SDK)                                             │
│    └─ tool call: mcp__rove__set_secret { name, reason, path }             │
│         │                                                                 │
│         ▼                                                                 │
│   secretBroker.request(requestId, name, reason, path)                     │
│         │  emits secret_request ──► send() ──► client                     │
│         ▲                                                                 │
│         │ secret_provide { requestId, value, path } ◄── WS (side channel) │
│         ▼                                                                 │
│   write-through:                                                          │
│     • validate path is inside session cwd (no traversal)                  │
│     • upsert NAME=value into <path>  (default .env)                       │
│     • ensure <path> is gitignored                                         │
│     • drop the value from memory                                          │
│         │                                                                 │
│         ▼                                                                 │
│   tool result to SDK: "ok: wrote OPENAI_API_KEY to .env (value hidden)"   │
└───────────────────────────────────────────────────────────────────────────┘
                              │  HTTPS/WSS over Tailscale (bearer / TS identity)
                              ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Client (mobile RN / web)                                                  │
│                                                                           │
│  on secret_request → mount <SecretSheet> (masked input, NOT the composer, │
│      shows name + reason + editable resolved path)                        │
│      user pastes → secret_provide { requestId, value, path }   (or deny)  │
└───────────────────────────────────────────────────────────────────────────┘
```

## Components

### Bridge

#### `bridge/src/secretBroker.ts` (new) — request round-trip
- Mirrors `screenshotBroker.ts` / `handoffBroker.ts`: `request({ sessionId, name, reason, path }): Promise<SecretOutcome>` allocates a single-use `requestId`, arms a timeout (reuse the broker timeout constant), returns a promise.
- A dispatch callback (registered in the per-session WS attach handler in `server.ts`) emits the `secret_request` frame to the attached client.
- `resolveProvide(requestId, value, path)` / `resolveDeny(requestId)` route the client reply back to the awaiting promise; idempotent (second reply is a benign no-op).
- The broker hands the value to the writer and resolves with a **value-free** outcome (`{ ok, where, gitignored }` | `{ denied }` | `{ timeout }` | `{ error }`).

#### `bridge/src/secretWriter.ts` (new) — write-through + safety
- `writeDotenv(cwd, path, name, value): { where, gitignored }`:
  - resolve `path` against `cwd`; reject if it escapes `cwd` (path safety, FR-5).
  - upsert `NAME=value` (preserve other lines; correct dotenv quoting/escaping); create file if absent.
  - ensure the file is gitignored (append to `.gitignore` if not); report whether it added it.
  - never retains the value; takes it as an argument and returns only metadata.

#### `bridge/src/agents/claudeCodeSdk.ts` — the MCP tool
- Add `set_secret` to the `tools` array in the `rove` MCP server (alongside `take_screenshot` / `prepare_preview`, ~line 898). Handler `handleSetSecret()` follows the existing gate→broker→structured-result pattern (cf. `handleTakeScreenshot`); result content is value-hidden text only.
- **Registration must be always-on.** Today the `rove` server registers only when visual feedback is enabled (~line 842). Split that so `set_secret` is always present while screenshot/preview stay feature-gated. (Plan P2.)
- No `options.env` changes in v1 (env-var injection is deferred).

### Client (mobile RN + web share the codebase)

#### `mobile/components/secrets/SecretSheet.tsx` (new)
- A bottom sheet, sibling to `ApprovalSheet`, mounted on a `secret_request` frame.
- Masked `TextInput` (`secureTextEntry`, `autoCorrect={false}`, `autoComplete="off"`, no draft persistence), the requested `name`, the `reason`, the **editable resolved path**, and Provide / Deny.
- On Provide → transport sends `secret_provide { requestId, value, path }`; on Deny → `secret_deny`. The input is cleared on unmount; never written to any store or chat draft.

#### `mobile/lib/secrets.ts` (new) — transport glue
- Subscribes to `secret_request`; exposes `provide(requestId, value, path)` / `deny(requestId)`. Holds no values.

#### Transport types
- Extend the `ClientToServer` / `ServerToClient` unions (`bridge/src/types.ts`, mirrored in the mobile transport types) with the FR-2 frames.

## Key flows

### Agent-initiated set (the only v1 flow)
```
SDK: tool call mcp__rove__set_secret { name:"OPENAI_API_KEY", reason:"run tests", path:".env" }
Bridge: handleSetSecret → secretBroker.request(R1, …)
        emits secret_request{ requestId:R1, name, reason, path:".env" } → send() → client
Client: mounts SecretSheet (masked). User can edit path. Pastes key, taps Provide.
Client: secret_provide{ requestId:R1, value:"sk-…", path:".env" }   ← side channel, NOT a user_message
Bridge: secretBroker.resolveProvide(R1, "sk-…", ".env")
        secretWriter.writeDotenv(cwd, ".env", "OPENAI_API_KEY", "sk-…")
          → validate inside cwd → upsert line → ensure .gitignore → drop value
        broker resolves { ok, where:".env", gitignored:true }
SDK: tool result = "ok: wrote OPENAI_API_KEY to .env (value hidden; .gitignore updated)"
        → SDK persists THIS text to JSONL (safe: value-hidden)
```

### Deny
```
Client: secret_deny{ requestId:R1 }
Bridge: broker resolves { denied }
SDK: tool result = "denied: user declined to provide OPENAI_API_KEY"  (non-fatal; agent adapts)
```

## Tech stack

- **In-process MCP tool** via the SDK's `createSdkMcpServer` / `tool()` — same mechanism as `take_screenshot`. No external MCP process.
- **Broker pattern** — promise + timeout + WS dispatcher, copied from `screenshotBroker.ts`.
- **No keychain, no DB, no new heavy deps.** The destination file is the store.
- **No change to transport/auth.** New frames ride the existing per-session WebSocket; Tailscale-identity / bearer auth unchanged.

## Cross-cutting concerns

### Where the value is allowed to exist (v1)
| Location | Plaintext value present? |
|---|---|
| Chat composer / `user_message` / JSONL transcript | **No** — never (at provision) |
| Model context window | **No** — only name + value-hidden confirmation (at provision) |
| Bridge process memory | Transiently, during the write; then dropped |
| Rove persistent store (keychain/DB) | **No** — none exists in v1 |
| Destination file (`.env`) | Yes (by design — that's "in place"), gitignored |
| Outbound WS frame / client / screenshot | **No** at provision. Read-back is out of scope (agent-runtime). |

### Persistence safety (the central v1 invariant)
The SDK writes the JSONL from its message stream. The value never enters that stream: the `set_secret` *input* is a name + path, its *result* is value-hidden, and the value arrives on `secret_provide`, which `server.ts` consumes straight into the writer and never forwards to the SDK. The transcript is therefore value-free **as a result of provisioning**.

### The read-back gap (out of scope — agent-runtime concern)
This invariant covers provisioning, not later reads. If the agent runs `cat .env`, the value re-enters a `tool_result` → the model and the JSONL. **Rove does not try to close this.** Whether the agent may read a secret, or use one without seeing it, belongs to the agent runtime, not the transport/client layer — Rove can't enforce it and shouldn't own it. No redaction net is wired, by decision. See [frd.md](./frd.md) "Out of scope: the read / use problem." Stated explicitly so it reads as a drawn boundary, not a silent omission.

### Path safety
Destination resolved against session cwd; reject `..` traversal and absolute escapes; the sheet shows the resolved path so the user can catch/correct it before pasting.

### Auth, idempotency
- New frames use the existing bearer/Tailscale-identity auth. No new credential type.
- `requestId` is a server-minted single-use id (as with permissions/handoffs); a duplicate `secret_provide` is a no-op.

### Failure paths
| Failure | Behavior |
|---|---|
| User denies | Non-fatal `denied:` result; agent adapts |
| Request times out (no client / no response) | `timeout:` result; agent can retry or proceed |
| Path escapes cwd | `error: path outside project`; nothing written |
| File write fails (perms) | `error:` with reason; nothing written |
| Two clients attached, both reply | First wins; second is benign no-op |

### Observability
- Bridge logs lifecycle **without values**: `[secret] request R1 name=OPENAI_API_KEY path=.env`, `[secret] wrote .env (gitignore: added)`, `[secret] R1 outcome=provided|denied|timeout|error`.

## Open questions

1. **Default path.** `.env` in session cwd is the default; confirm we don't want a per-project configurable default.
2. **Quoting edge cases** in dotenv upsert (values with newlines, `=`, quotes) — settle the escaping rules in the writer (P1).
