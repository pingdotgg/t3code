# Repeated Steering And Reliable Stop

Running conversations allow users to send any number of steering prompts and stop the active agent at any time, including after one or more steers.

Expected behavior:

- A steering send remains locally busy only until the server projects that exact user-message id. Unrelated projected user messages must not acknowledge the dispatch, and steering the existing running turn must not wait for a new turn or session transition before re-enabling the composer.
- Root interruption commands retain the projected active turn id in orchestration events, but the provider command reactor intentionally lets the root Codex adapter resolve the authoritative active provider turn. Subagent interruption continues to target the selected child turn explicitly and must not fall back to a root turn.
- Codex root interruption reads the live provider thread with `includeTurns: true`, selects the most recently started `inProgress` turn, and bounds that lookup with a timeout. When either candidate lacks `startedAt`, provider response order is authoritative and the later entry wins. A failed lookup is logged and may fall back to the cached session turn; a successful lookup with no active turn returns without reviving a stale cached id.

Primary files:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.logic.ts`
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`

Regression coverage lives in `apps/web/src/components/ChatView.logic.test.ts` and `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts`. Keep coverage for consecutive in-turn steers, exact-message acknowledgement, timestamp-based live-turn selection, lookup timeout/failure fallback, and successful empty reads that suppress stale interrupts.

## Development Ports

- Web: `5738`
- Server/WebSocket: `13778`
