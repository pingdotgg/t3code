# PR Event Review Checklist

## P0

- `apps/server/src/provider/Layers/CursorAdapter.ts:1365` validate `input.input` before emitting `turn.started` or mutating `context.turnState`; current order can leave a phantom running turn on invalid input.
- `apps/server/src/provider/Layers/CursorAdapter.ts:783` preserve the original tool-call classification across `tool_call_update`; do not hard-code `itemType: "command_execution"` for every update/completion.
- `apps/server/src/provider/Layers/CodexAdapter.ts:720` correlate `serverRequest/resolved` back to the original request type instead of emitting `requestType: "unknown"`; otherwise approval resolution loses semantic meaning.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:320` add first-class handling for `session.state.changed`; orchestration currently derives session state indirectly and can miss provider-reported waiting/error/stopped transitions.

## P1

- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:320` consume `thread.metadata.updated` and dispatch thread title/metadata updates where applicable.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:320` consume `turn.plan.updated` and project plan state or append a structured thread activity so plan updates are not dropped.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:320` consume `turn.diff.updated` and route it into the existing diff/checkpoint flow if this event is now the provider-side source of truth.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:320` consume `item.updated` for tool lifecycle summaries/progress so mid-tool updates are visible instead of ignored.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:320` consume `runtime.warning` and append non-fatal warning activities; these are currently emitted by providers but disappear downstream.

## P2

- `apps/server/src/provider/Layers/CodexAdapter.ts:904` map `windowsSandbox/setupCompleted` to at least one `session.state.changed` transition plus optional warning detail, as called for by `EVENTS.md`.
- `apps/server/src/provider/Layers/CodexAdapter.ts:468` consider emitting `session.configured` when session startup config is known, not only `session.started` / `session.state.changed`.
- `apps/server/src/provider/Layers/CodexAdapter.ts:652` widen `item.updated` coverage beyond reasoning-summary and terminal-interaction boundaries if Codex methods provide meaningful in-progress item mutations.
- `apps/server/src/provider/Layers/ClaudeCodeAdapter.ts:1222` verify whether Claude `tool_progress` should carry a real human summary instead of synthesizing `task:<id>` into `summary`; keep raw correlation data separately if needed.
- `apps/server/src/provider/Layers/ClaudeCodeAdapter.ts:1062` decide whether any Claude SDK events should map to `user-input.requested` / `user-input.resolved`; if unsupported, document that explicitly in tests or comments.

## P3

- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1` reduce reliance on legacy event shims once all adapters and tests are canonical; they currently hide incomplete V2 migration.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:320` decide whether `auth.status`, `files.persisted`, `tool.summary`, `task.*`, `hook.*`, realtime thread events, and token-usage updates should become activities, session fields, or remain intentionally ignored.
- `apps/server/src/orchestration/projector.ts:360` extend read-model fields only after ingestion semantics are finalized, so projector changes reflect intentional product surface rather than raw event exhaust.

## Tests To Add

- `apps/server/src/provider/Layers/CursorAdapter.test.ts` assert that invalid empty prompt input emits no `turn.started` and leaves session idle.
- `apps/server/src/provider/Layers/CursorAdapter.test.ts` assert that `tool_call` and `tool_call_update` keep the same canonical `itemType`.
- `apps/server/src/provider/Layers/CodexAdapter.test.ts` add a case proving `serverRequest/resolved` preserves the original request type.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` add coverage for `session.state.changed`, `turn.plan.updated`, `turn.diff.updated`, `thread.metadata.updated`, and `runtime.warning`.
