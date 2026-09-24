# Repeated Steering And Reliable Stop

Running conversations allow users to send any number of steering prompts and stop the active agent at any time, including after one or more steers.

Expected behavior:

- An active-thread send allocates its user-message id before entering local dispatch, and the dispatch API requires that exact id. For steering the current running turn, the server projection carrying that id is authoritative acknowledgement even when the frozen dispatch snapshot has stale or absent session status. A later message from another client does not invalidate it, and an unrelated projected user message cannot acknowledge it. Sends that advance a turn retain the turn/session transition fallback, while the connecting phase ignores those transitions unless the exact message has already projected. Multi-model fanout and implementing a plan in a separate new thread use a distinct busy-state variant that preserves worktree preparation and submission intent. This state is cleared explicitly rather than by source-thread projections or turn/session transitions.
- Root interruption commands retain the projected active turn id in orchestration events, but the provider command reactor intentionally lets the root Codex adapter resolve the authoritative active provider turn. Subagent interruption continues to target the selected child turn explicitly and must not fall back to a root turn.
- Codex root interruption first performs upstream's bounded, best-effort interruption of every live child provider turn. It then reads the root thread's history mode: legacy threads use `thread/read` with `includeTurns: true`; paginated threads use `thread/turns/list` in ascending provider order. One two-second deadline covers the history-mode read and all pages. Selection uses the most recently started `inProgress` turn. When either candidate lacks `startedAt`, provider response order is authoritative and the later entry wins. A failed lookup, including an unexpected defect, is logged and may fall back to the session turn read after that lookup finishes; a successful lookup with no active turn returns without reviving a stale cached id.

Conflict guidance:

- `apps/web/src/components/ChatView.localDispatch.ts` owns the branch's dispatch snapshot, exact-message acknowledgement, and React state hook. Keep message dispatch and new-thread busy state as distinct variants. Preserve upstream's `submissionIntent`, reconnect guard, worktree-preparation state, latest-user-message timing, and turn/session fallback around the exact-id correlation. The hook's `allocateMessageDispatch` allocates the expected `MessageId`, begins dispatch, and returns that id to the caller. Multi-model fanout and the separate plan-implementation flow use `beginNewThreadBusyState`. Fanout passes `preparingWorktree: true` and the resolved submission intent, then explicitly resets the state when its background requests own their threads or dispatch fails. Allocate a source-thread message id only on the non-fanout path; each fanout target allocates its own id.
- Do not restore upstream's inline dispatch hook or latest-user-message heuristic in `apps/web/src/components/ChatView.logic.ts` or `apps/web/src/components/ChatView.tsx`. In `ChatView.tsx`, keep the draft-hero dock transition and early in-flight guard, call `allocateMessageDispatch` for each active-thread send, pass the resolved submission intent from the composer send, and send the returned id to the server. The separate context-window compaction callback also uses that allocator while preserving the composer's draft and attachments. Plan follow-up remains foreground by default.
- `apps/web/src/components/ChatView.localDispatch.test.ts` covers the message/new-thread state variants, fanout preparation and background-intent preservation, and immunity to source-thread acknowledgement. `apps/web/src/components/ChatView.logic.test.ts` imports the dispatch helpers from `ChatView.localDispatch.ts` and covers exact projection, reconnect, fallback, and consecutive-steer behavior.
- Keep active-turn selection, ordering, the overall lookup deadline, and fallback in `apps/server/src/provider/Layers/CodexInterruptResolution.ts`, covered by its colocated test. Inject the `readCodexThreadWithTurns` effect from `apps/server/src/provider/Layers/CodexSessionRuntime.ts`: it shares upstream's legacy/paginated reader with conversation history but preserves provider status and timestamps until each caller projects them. Keep history normalization after this shared read; normalized history lacks the metadata needed for interruption. Preserve page decoding and cursor-cycle rejection, and apply the interrupt timeout to the complete read rather than each page. The runtime must retain bounded live-child interruption before root resolution; `apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts` covers that fan-out.
- Upstream owns the platform-specific mock launchers and temporary-directory setup in `apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts`. Preserve its Windows `.cmd` and Unix `.sh` launchers for the shared `.mjs` peer and its platform-native temporary working directory so stop and child-fan-out regression coverage remains cross-platform.

Primary files:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.localDispatch.ts`
- `apps/server/src/provider/Layers/CodexInterruptResolution.ts`
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`

Regression coverage lives in `apps/web/src/components/ChatView.localDispatch.test.ts`, `apps/web/src/components/ChatView.logic.test.ts`, `apps/server/src/provider/Layers/CodexInterruptResolution.test.ts`, and `apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts`. Keep coverage for consecutive in-turn steers, exact-message acknowledgement, reconnect and turn/session fallback behavior, background-intent preservation, live-root-turn selection across legacy reads and paginated boundaries, one deadline across metadata and all pages, malformed-page/cursor-cycle/failure/defect fallback, successful empty reads that suppress stale root interrupts, and bounded interruption of live child turns before the root.

Use `hasServerAcknowledgedLocalDispatch` from `apps/web/src/components/ChatView.localDispatch.ts` for client dispatch correlation. Defer an explicit server receipt keyed by message id unless projected ids stop being authoritative.

## Development Ports

- Web: `5738`
- Server/WebSocket: `13778`
