# Rove Secrets — Plan

Related: [frd.md](./frd.md), [hla.md](./hla.md)

Scope: v1 is **`set_secret`** (write-through). No vault. The **read / use** problem (read-back prevention; using a secret without exposing it) is **out of scope** — an agent-runtime concern, not Rove's (see [frd.md](./frd.md)). v1 ships the provision path; the runtime governs use.

Phasing: P0 fixes the wire contract. P1 builds the bridge write-through (broker + writer + side channel) — testable headless. P2 adds the `set_secret` MCP tool (the agent entry point). P3 is the client secure sheet — first end-to-end, user-visible win. **P0–P3 are the whole feature.** There is no read-back phase — that's out of scope (agent-runtime).

DoD convention: a phase is done only when its objective DoD is demonstrably met (test or scripted smoke), not merely when boxes are checked.

---

## Implementation status (2026-06-07)

Bridge P0–P2 and mobile P3 are **implemented and typechecking** (`bridge: pnpm typecheck`, `mobile: tsc --noEmit` both clean). Writer and broker have runtime tests that pass (`pnpm exec tsx src/secretWriter.test.ts`, `src/secretBroker.test.ts`), including the **value-free outcome** assertion. Remaining: live end-to-end smoke that needs a running bridge + `claude` session and an Expo device build (the FRD JSONL-grep gate and the on-device sheet smokes) — marked `[ ]` below.

## Phase 0 — Wire contract + types

DoD: the new frame types compile in `bridge/src/types.ts` and the mobile transport types; a `secret_provide` from a test client is accepted and routed by the bridge and never becomes a `user_message`.

- [x] `ServerToClient` (`bridge/src/types.ts`): `{ type: 'secret_request', requestId, name, reason, path }`
- [x] `ClientToServer`: `{ type: 'secret_provide', requestId, value, path }`, `{ type: 'secret_deny', requestId }` (dropped the unused `reason` — it collided with the shared `ScreenshotErrorReason` field)
- [x] Shared types: `SecretOutcome` (value-free: `ok` | `denied` | `timeout` | `no_client` | `cancelled` | `error`) in `secretBroker.ts`
- [x] Mirror the types in the mobile transport layer (`mobile/lib/types.ts`)
- [x] Document the frames in `docs/WIRE_PROTOCOL.md`
- [x] `server.ts` `onMessage` routes `secret_*` inbound (provide → writer via broker, deny → broker); the value never becomes a `user_message`

## Phase 1 — Bridge write-through (broker + writer + side channel)

DoD: a scripted WS client `secret_provide` causes the bridge to write `NAME=value` into the destination, ensure gitignore, and resolve a value-free outcome — with the value asserted absent from the SDK stream and dropped from memory after the write. Path-escape and write-failure cases return `error:` and write nothing. All via unit/integration tests; no UI.

### Writer — `bridge/src/secretWriter.ts` (new)
- [x] `writeDotenvSecret(cwd, path, name, value): { where, gitignored, addedGitignore }` — resolve path against cwd; **reject traversal / absolute escape** (FR-5)
- [x] Upsert `NAME=value` preserving other lines; create file/dirs if absent; dotenv quoting (bare for simple values, double-quoted + escaped otherwise)
- [x] Gitignore safety (FR-6): ensure destination ignored; append to `.gitignore` if not; report `addedGitignore`
- [x] Never retains the value (argument in, metadata out)
- [x] Unit tests (`secretWriter.test.ts`): fresh create; upsert + preserve siblings + no-dup; traversal/absolute/invalid-name rejected; quoting; subdir; gitignore-once — all pass

### Broker — `bridge/src/secretBroker.ts` (new)
- [x] Mirror `screenshotBroker.ts`: `requestSecret()`, `provideSecret(id, value, path?)`, `denySecret(id)`, `cancelSecretsForSession()`, timeout, single-use `requestId`, dispatch registry
- [x] On provide → `writeDotenvSecret` → resolve value-free outcome; deny/timeout/cancel/error resolve accordingly; never rejects
- [x] Idempotent: late/duplicate provide/deny is a silent no-op

### Wiring — `server.ts`
- [x] Register the secret dispatcher in the per-session WS attach; emit `secret_request` via `send()`; tear down + `cancelSecretsForSession` on disconnect
- [x] `onMessage`: route `secret_provide` / `secret_deny` → broker
- [x] Integration test (`secretBroker.test.ts`): provide → file written + gitignored + **outcome carries no value** (asserted) — passes

## Phase 2 — `set_secret` MCP tool (agent entry point)

DoD: a real agent turn calling `mcp__rove__set_secret` surfaces a `secret_request`; a scripted `secret_provide` writes `.env` and returns a value-hidden result; grepping the session JSONL finds zero occurrences of the value attributable to the flow.

- [x] Split the `rove` MCP server registration in `claudeCodeSdk.ts` so `set_secret` is **always** registered while `take_screenshot` / `prepare_preview` stay gated on visual-feedback (conditional spread in `buildRoveMcpServer`; server now registered unconditionally)
- [x] Add `set_secret` to the tools array, inputs `{ name, reason, path? }` (Zod; `path` default `.env`); auto-allowed (`SET_SECRET_MCP_TOOL_QUALIFIED` in `safeAutoAllow`) so the secure sheet is the only prompt
- [x] `handleSetSecret()` following the `handleTakeScreenshot` gate→broker→structured-result pattern; value-hidden `ok:` / `denied:` / `timeout:` / `no_client:` / `error:` text
- [x] Both visual-feedback states typecheck; the secret tool is present regardless (rove server always registered)
- [ ] Integration (FRD success gate): live agent turn → provide → `.env` written → value-hidden result → **JSONL grep finds no value**. Needs a running bridge + `claude` session; not yet exercised end-to-end.

## Phase 3 — Client secure sheet (mobile + web)

DoD: on a real device/browser, an agent `set_secret` pops the masked sheet; editing the path + pasting + Provide writes the file and continues the turn; the value appears nowhere in the chat or transcript. Deny continues the turn non-fatally.

- [x] Client transport: `secret_request` handled in the chat screen's frame switch; `secret_provide` / `secret_deny` sent via the existing `sendRef`. (Kept inline like the handoff flow rather than a separate `mobile/lib/secrets.ts`; holds no values.)
- [x] `mobile/components/secrets/SecretSheet.tsx`: bottom sheet sibling to `ApprovalSheet`; masked `TextInput` (`secureTextEntry` + reveal toggle, no autocomplete/autocorrect/draft); shows `name` + `reason` + **editable destination path**; Provide / Deny; clears value on unmount
- [x] Mounted from the chat screen on `secret_request` (keyed by `requestId` → fresh, value-free component that unmounts on close)
- [x] Wire transport send for `secret_provide` / `secret_deny`
- [x] Value held only in local component state, never a chat draft/store; cleared on unmount (conditional mount + `useEffect` cleanup)
- [ ] Device smokes (need an Expo build): agent asks → sheet → edit path → paste → Provide → agent proceeds; Deny → `denied:`; path-escape rejected with a clear message

## Out of scope — the read / use problem (not a phase)

There is no phase for this. Preventing read-back, or letting the agent use a secret without seeing it (the "nerfed tool" idea), is an **agent-runtime concern**, not Rove's — Rove can't enforce it and shouldn't own it. We considered a bridge-side redaction net and a `run_with_secret` capability tool and ruled both out: rationale in [frd.md](./frd.md) "Out of scope: the read / use problem." If the runtime later ships a use-without-expose primitive, `set_secret` composes with it unchanged.

## Deferred (post-v1, tracked so they aren't lost)

- [ ] **Persistent vault / keychain**, **pre-load Settings screen**, **env-var injection** — a layer on top of `set_secret`, only if a real need appears.
- [ ] **Cross-machine sync, rotation, expiry, audit log.**

(Read-back prevention, `run_with_secret` / capability tools, and the egress-proxy tier are **out of scope** — agent-runtime, not Rove. See above.)

## Risks to watch

- **Always-on MCP registration.** Decoupling `set_secret` from the visual-feedback gate must not regress the screenshot/preview tools or their cost-when-disabled behavior. Test both states.
- **Dotenv quoting.** A value with `=`, quotes, or whitespace must round-trip; a sloppy upsert can corrupt the file or the value. Pin the rules and test them (P1).
- **Don't overclaim.** The tool result / UI must say the key now lives in `.env` (and can be read like any project file) — not imply Rove prevents the agent from reading it. Read-back is out of Rove's scope (agent-runtime); the copy should reflect that, per the FRD.
- **Path confinement.** The model picks the path; the cwd-confinement check is the only thing between it and writing a secret somewhere surprising. Treat it as security-critical and test traversal/escape cases.
