# Repeated Steering And Reliable Stop

Running conversations allow users to send any number of steering prompts and stop the active agent at any time, including after one or more steers.

Expected behavior:

- A steering send remains locally busy only until the server projects that exact user-message id. That acknowledgement is authoritative even when the frozen dispatch snapshot has stale or absent session status, stays valid when another client later projects a newer user message, and cannot be triggered by an unrelated projected user message. Steering the existing running turn must not wait for a new turn or session transition before re-enabling the composer.
- Root interruption commands retain the projected active turn id in orchestration events, but the provider command reactor intentionally lets the root Codex adapter resolve the authoritative active provider turn. Subagent interruption continues to target the selected child turn explicitly and must not fall back to a root turn.
- Codex root interruption reads the live provider thread with `includeTurns: true`, selects the most recently started `inProgress` turn, and bounds that lookup with a timeout. When either candidate lacks `startedAt`, provider response order is authoritative and the later entry wins. A failed lookup is logged and may fall back to the session turn read after that lookup finishes; a successful lookup with no active turn returns without reviving a stale cached id.

Conflict guidance:

- In `apps/web/src/components/ChatView.logic.ts`, `apps/web/src/components/ChatView.logic.test.ts`, and `apps/web/src/components/ChatView.tsx`, preserve exact-id acknowledgement and consecutive-steer coverage. Keep the draft-hero dock transition and early in-flight guard, and call `beginLocalDispatch` only after `newMessageId()` provides the exact expected id.
- Keep live-turn lookup, ordering, timeout, and fallback coverage in `apps/server/src/provider/Layers/CodexInterruptResolution.test.ts`, separate from the runtime model/effort instruction coverage in `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts`. `apps/server/src/provider/Layers/CodexSessionRuntime.ts` must retain both developer-instruction behavior and branch-owned interrupt resolution.

Primary files:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.logic.ts`
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`

Regression coverage lives in `apps/web/src/components/ChatView.logic.test.ts` and `apps/server/src/provider/Layers/CodexInterruptResolution.test.ts`. Keep coverage for consecutive in-turn steers, exact-message acknowledgement, timestamp-based live-turn selection, lookup timeout/failure fallback, and successful empty reads that suppress stale interrupts.

Use the existing `hasServerAcknowledgedLocalDispatch` helper for client dispatch correlation. Defer an explicit server receipt keyed by message id unless projected ids stop being authoritative.

## Development Ports

- Web: `5738`
- Server/WebSocket: `13778`
