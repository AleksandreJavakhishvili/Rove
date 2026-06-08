# Rove Secrets — FRD

## Problem

Agents routinely need a credential to make progress — an `OPENAI_API_KEY` for a script, a `STRIPE_SECRET_KEY` for a test, a database URL to run migrations. Today the only way for a user to hand that credential over is to **paste it into the chat**, which is the worst place for it:

1. It is written verbatim into the session transcript on disk (`~/.claude/projects/<slug>/<id>.jsonl`) by the Claude Code SDK, in plaintext, forever.
2. It enters the model's context window — the agent "reads" it and can echo it, log it, or commit it.
3. It re-renders on every history replay, on every device that opens the session, and in any screenshot of the chat.

We want a user to **paste a key into a secure surface in Rove once, and have the bridge write it into place (e.g. `.env`)** — without the value ever passing through the chat, the model's context, or the session transcript.

## v1 scope (this document)

v1 is a single capability: **`set_secret`** — an agent-requested, write-through path that lands a pasted credential into a file the agent names, without the model ever receiving the value.

- The agent asks for a named secret and a destination path.
- Rove shows a secure paste sheet (not the chat).
- The bridge writes `NAME=value` into the path and ensures it is gitignored.
- The agent gets back only a value-hidden confirmation.

**Out of scope (see below):** the "read / use" problem — preventing a secret in `.env` from being read back, or letting the agent use a secret without seeing it. That is an agent-runtime concern, not Rove's. v1 is the *provision* path only: no persistent vault, no keychain, no pre-load Settings screen, no env-var injection.

## What v1 guarantees (and what it does not yet)

Precise, because it's the whole point.

**v1 guarantees, at the moment of provision:**
- The value is never typed into the chat composer, never becomes a `user_message`, and is therefore never written to the session JSONL as a result of providing it.
- The value never enters the model's context. The `set_secret` tool's *inputs* are only `{ name, path, reason }`; the *value* arrives out-of-band and the tool *result* is value-hidden.
- The value is never persisted by Rove anywhere except the destination file the user/agent chose (which is the file they'd have created by hand anyway, now auto-gitignored).

**v1 does NOT prevent the agent from reading the secret back.** Once the key is in `.env`, an agent that runs `cat .env` surfaces the value in a tool result, which then lands in the model's context and the JSONL. **Closing that is not Rove's job** (see "Out of scope: the read / use problem"). Whether an agent on this machine may read a secret, or use one without seeing it, is an agent-runtime concern — the transport/client layer can neither enforce it nor own it.

So the honest v1 property is: *"providing a key no longer puts it in the transcript or the model's context."* What the agent then does with a secret that legitimately lives on the machine is the runtime's responsibility.

## Goals (v1)

1. **Paste-in-place, not paste-in-chat.** A user hands a credential to a session through a secure input surface that is visibly distinct from the chat composer, and the bridge writes it where the agent said it's needed (default: a `.env` in the project).
2. **The agent asks the right way.** When an agent needs a credential, it calls `set_secret` — it never instructs the user to "paste your key here" in chat.
3. **The agent never holds the plaintext at provision.** The agent receives only a value-hidden confirmation and references the secret by file/name thereafter.
4. **Safe by default on disk.** The destination is validated and auto-gitignored; the bridge never writes a secret into a tracked file.

## Non-goals (v1)

- **Persistent secret store / keychain vault.** The destination file is the only at-rest copy. No Rove-owned secret database.
- **Pre-loading secrets** from a Settings screen before the agent asks.
- **Env-var-only injection** (no file). v1 writes a file; reading env from a file is the app's job.
- **Cross-machine sync, rotation, expiry, audit log.**
- **The read-back guarantee** — deferred for design (see below), not a v1 promise.

## Personas

- **Solo developer (primary).** Drives Claude Code from their phone on their tailnet. Trusts the agent enough to run it, but does not want keys sitting in a transcript that syncs, gets screenshotted, or gets shared in a bug report.
- **Pairing/shared user.** Runs a bridge a teammate also connects to (`ALLOWED_USERS`); wants a teammate to provide a key for a session without it becoming visible in the shared transcript.

## User stories

### US-1: Agent asks for a key, user pastes it once
> As a user, when the agent needs `OPENAI_API_KEY` to run my script, I want it to ask me through a secure prompt I can paste into — not tell me to type my key into the chat.

Acceptance:
- The agent calls `set_secret` with the name, a human-readable reason, and a destination path.
- Rove surfaces a **secure sheet** with a masked input, the requested name, the reason, and the **resolved destination path (editable)**. It is visually and behaviorally distinct from the chat composer.
- On Provide, the value travels on a side channel (never a chat message); the bridge writes the destination file; the agent continues.
- The agent's tool result is value-hidden, e.g. `ok: wrote OPENAI_API_KEY to .env (value hidden)`.
- The chat transcript and the JSONL contain **no occurrence** of the value as a result of this flow — verified by grepping the session file.

### US-2: The key is put in the right place automatically
> As a user, after I provide the key, I want it already in `.env` so the agent's next command just works.

Acceptance:
- The bridge writes/updates the named key in the destination (default `.env` in the session cwd), creating the file if needed and preserving other lines.
- If the destination is not gitignored, the bridge adds it to `.gitignore` and reports that it did.
- The agent runs a command that consumes the file and it succeeds — without the value being returned to the model.

### US-3: I can correct where it lands
> As a user, when the agent proposes writing to `./.env` but my key belongs in `./backend/.env`, I want to fix the path before I paste.

Acceptance:
- The secure sheet shows the resolved destination and lets the user edit it before providing.
- The bridge confines the write to the session cwd (no traversal, no absolute escapes); an out-of-bounds path is rejected with a clear reason.

### US-4: Deny / cancel
> As a user, when the agent asks for a key I don't want to give, I want to decline without derailing the session.

Acceptance:
- The secure sheet has a Deny/Cancel action.
- Denying resolves the agent's request with a non-fatal result (`denied: user declined to provide OPENAI_API_KEY`) so the agent can adapt rather than crash.

## Functional requirements (v1)

### FR-1: Secure entry surface (not the chat)
The client provides a dedicated **secret entry sheet** with a masked input, impossible to mistake for and not routed through the chat composer. Values entered here are never placed in a `user_message`, never stored in a chat draft, never logged.

### FR-2: Side-channel transport
Secret values travel on dedicated WebSocket frames distinct from chat/tool/permission streams:
- Server→Client: `secret_request { requestId, name, reason, path }`
- Client→Server: `secret_provide { requestId, value, path }` and `secret_deny { requestId, reason? }`

The `value` field exists **only** on the inbound `secret_provide` frame and is consumed by the writer — never re-emitted outbound. (`path` echoes back on provide so a user edit in the sheet is authoritative.)

### FR-3: `set_secret` tool
A Rove MCP tool surfaced to the model as `mcp__rove__set_secret`:
- Inputs: `name` (e.g. `OPENAI_API_KEY`), `reason` (human-readable), `path?` (default `.env`, relative to session cwd).
- Behavior: opens the secure sheet via a broker round-trip; blocks until the user provides or denies (or a timeout fires).
- Result to the model: value-hidden text only — `ok: <where>`, `denied: <reason>`, `timeout`, or `error: <reason>`. Never contains the value, and never asks the model to supply the value.

### FR-4: Write-through materialization
On provide, the bridge writes the secret itself (the agent is not involved):
- Upsert `NAME=value` into the destination file (default `.env` in session cwd), creating it if absent, preserving other lines, with correct dotenv quoting/escaping.
- The value lives only in that file. Rove keeps no persistent copy.

### FR-5: Path safety
The destination is resolved against the session cwd and **confined to it** — no `..` traversal, no absolute paths outside cwd. An unsafe path is rejected with a clear `error:` result and nothing is written.

### FR-6: Gitignore safety
For any write, if the destination is not already ignored by git, the bridge appends it to `.gitignore` and surfaces `(gitignore: added)`. The bridge never writes a secret into a tracked file without this protection.

### FR-7: Non-fatal deny + timeout
A denied or timed-out request resolves the tool with a non-error, actionable result so the turn continues. The request expires after a bounded window consistent with the existing permission/handoff brokers.

## Out of scope: the read / use problem (belongs to the agent runtime, not Rove)

Rove's job is **provisioning** — getting a secret from the human to the machine securely. What an agent on that machine may do with a secret afterward is the **agent runtime's** concern, not the transport/client layer's. Rove neither can enforce it (the agent always has built-in Bash/Read and can `cat` any file) nor should own it (every client driving an agent would otherwise reinvent the same sandbox). We name the two pieces only to draw the boundary clearly:

- **Read-back** — stopping `cat .env` / `printenv` from surfacing a secret the app legitimately needs on disk. Not Rove's to solve. We considered an outbound-redaction net at the bridge's `send()` choke point and rejected it as the wrong layer: a band-aid over the runtime, best-effort, and trivially evaded by an obfuscating agent.
- **Use-without-expose** — letting the agent run a query/test that needs a secret without seeing the value (the "nerfed tool": run a command with the secret injected, return only results). Genuinely valuable, but it's an **agent-runtime / platform** capability — an execution model, not just a tool, and not Rove-specific. It belongs to the runtime (or its own project), not to Rove's secrets scope.

Net: **v1 provisions; the runtime governs use.** If the runtime later exposes a use-without-expose primitive, Rove's `set_secret` composes with it unchanged.

## Out of scope

- **The read / use problem** — read-back prevention and use-without-expose. Agent-runtime concern, not Rove (see the section above). This includes the egress-proxy tier, capability tools like `run_with_secret`, and inline `${secret:NAME}` substitution — all part of the runtime's "use" model, not Rove's "provision" model.
- **Persistent vault / keychain**, **pre-load Settings screen**, **env-var injection**, **cross-project reuse without re-pasting** — add later, as a layer on top of `set_secret`, only if a real need appears.
- **Cross-machine sync, rotation, expiry, audit log, versioning.**

## Success metrics (v1)

- **Provision doesn't leak.** A test that provides a key through `set_secret` and then greps the session JSONL finds no occurrence of the value *attributable to the provision flow*. Hard gate.
- **It lands correctly.** The destination file contains the key, is gitignored, and an agent command that consumes it succeeds — with no value returned to the model.
- **No "where did my key go" confusion.** No reports of a provided key failing to reach the destination or of the path being written somewhere surprising.
- (Read-back is explicitly out of scope — an agent-runtime concern, not a Rove metric.)
