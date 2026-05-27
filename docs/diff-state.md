# Diff State

T3 Code's diff panel is backed by the **Diff State Module**. The module is a typed seam between durable checkpoint storage and the UI.

## Inputs

- **Authoritative checkpoint diffs** come from `CheckpointReactor` and checkpoint refs.
- **Speculative provider diffs** come from provider `turn.diff.updated` events. These are useful for fast file summaries, but they are not treated as captured checkpoint data.
- **Git status updates** come from the existing git status subscription and cause active diff-state queries to refresh.

## State model

`DiffState` is a discriminated union:

- `ready` — the requested checkpoint-backed diff is available.
- `stale` — the UI is showing the last loaded snapshot while the latest checkpoint state is unavailable.
- `loading` — a diff request is in flight.
- `unavailable` — checkpoint metadata or refs are not available yet.
- `error` — an unexpected diff failure occurred.

`DiffSnapshot` contains the raw patch for the current renderer plus typed metadata and typed file summaries. This keeps current rendering behavior stable while letting future slices move to per-file rendering and deltas.

## Speculative vs authoritative summaries

Provider runtime diff summaries use checkpoint status `speculative`. They may be updated multiple times during a turn and are replaced by real checkpoint captures when available.

Captured checkpoint summaries use status `ready`, `missing`, or `error`. Speculative updates must not overwrite authoritative summaries.

## File safety

Server diff state classifies each file as:

- `normal`
- `large`
- `unrenderable`

The UI collapses large files by default and shows placeholders for unrenderable files. Binary files, oversized diffs, long lines, excessive deletion hunks, and hidden bidi characters are detected server-side.

## Current limitation

Per-file deltas are currently exposed as typed module behavior, but live push delivery is not yet wired. Until the push path exists, the UI refreshes diff state by invalidating active queries when Git status changes.
