# ADR 0001: Provider Runtime Lifecycle Ownership

## Status
Accepted

## Context
Provider runtime streams can include auxiliary work (for example collab/child-agent turns) under the same provider session as a user-visible primary turn.

The previous orchestration ingestion and checkpoint flows keyed lifecycle updates by `providerSessionId` alone. This allowed auxiliary `turn.completed` events to:

- mark thread sessions as `ready` before the primary turn completed
- clear `activeTurnId` for a still-running primary turn
- emit checkpoint turn-diff summaries for auxiliary turns in the main thread timeline

## Decision
Define and enforce a lifecycle ownership invariant:

- Only events in the primary thread/turn lane may mutate thread session lifecycle state (`status`, `activeTurnId`, `providerThreadId`) and checkpoint turn completion.
- Auxiliary events may still append messages and activities.

Current enforcement is implemented with scope guards:

- Runtime ingestion only applies lifecycle transitions when the event targets the active primary scope (provider thread and active turn checks).
- Checkpoint capture ignores `turn.completed` events from non-primary provider thread scope, and ignores non-active turn completions while a primary turn is active.

## Consequences

### Positive
- Prevents premature loss of "working" state from auxiliary turn completion.
- Prevents auxiliary changed-files/checkpoint cards from appearing as if they were primary turn completion.
- Keeps useful auxiliary activity/message visibility.

### Negative
- Runtime events that omit thread/turn identifiers are treated conservatively in lifecycle transitions.
- Full explicit lane modeling is still desirable in contracts for long-term clarity.

## Follow-up
1. Add explicit runtime lane metadata (`primary` vs `auxiliary`) to canonical provider runtime events.
2. Persist orchestration-to-provider turn binding (`TurnId` <-> `ProviderTurnId`) for stronger reconciliation and replay safety.
3. Promote lifecycle ownership checks from heuristic guards to schema-level invariants once lane metadata is available.
