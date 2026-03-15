# Spec 1:1 Cutover Plan

Goal: Align the orchestration model to `SPEC.md` 1:1 and remove legacy persistence/application cruft.

Execution mode for this plan:

- Hard cutover only. Existing DB and migration history are disposable.
- Intermediate steps are allowed to break runtime, tests, typecheck, and lint.
- We optimize for small, reviewable work units, not continuous app operability.
- Only the final gate requires everything to run cleanly.

## 1. Freeze SPEC contract as source of truth

Work units:

- Create `.plans/spec-contract-matrix.md` with one row per requirement in `SPEC.md` sections `7.1`-`7.4`.
- Add exact SQL-level requirements per row: table, column, type, nullability, PK/unique, index, and invariants.
- Add app-level requirements per row: writer path, reader path, and owning module.
- Mark each row with status labels: `required`, `implemented`, `to-replace`, `delete`.
- Identify any ambiguous spec lines and record a concrete interpretation in the matrix.

Deliverables:

- Complete matrix file with no unclassified rows.
- Single source checklist used by all later steps.

Breakage allowed:

- No code changes required yet.

Exit criteria:

- Every requirement in `7.1`-`7.4` has exactly one matrix row.

## 2. Hard cutover migrations (replace current migration set)

Work units:

- Delete the current legacy migration files and rewrite migration loader ordering.
- Create `001_orchestration_events.ts` with full envelope columns and required event indexes.
- Create `002_orchestration_command_receipts.ts` with PK + lookup indexes.
- Create `003_checkpoint_diff_blobs.ts` with uniqueness on `(thread_id, from_turn_count, to_turn_count)`.
- Create `004_provider_session_runtime.ts` with PK and runtime lookup indexes.
- Create `005_projections.ts` with all projection tables:
  - `projection_projects`
  - `projection_threads`
  - `projection_thread_messages`
  - `projection_thread_activities`
  - `projection_thread_sessions`
  - `projection_thread_turns`
  - `projection_checkpoints`
  - `projection_pending_approvals`
  - `projection_state`
- Add all required indexes/constraints in `005_projections.ts`.
- Ensure old tables (`projects`, `provider_checkpoints`, `provider_sessions`) are not recreated.

Deliverables:

- New 5-file migration chain.
- Updated migration loader references only new migrations.

Breakage allowed:

- Repositories/services can be temporarily broken due to removed old tables.

Exit criteria:

- Fresh DB initializes with only canonical tables plus migration bookkeeping.

## 3. Align persistence row/request schemas to DB 1:1

Work units:

- Define row schemas for each canonical table (contracts or persistence layer module).
- Define request schemas for every insert/update/query operation touching canonical tables.
- Remove or deprecate row/request schemas tied to deleted legacy tables.
- Normalize enum and null semantics to match contracts exactly.
- Ensure SQL aliases map 1:1 to schema field names (no implicit shape transforms).

Deliverables:

- Canonical row/request schemas committed.
- Zero references to legacy row schemas in active code paths.

Breakage allowed:

- Runtime can still fail while query layers are being rewired.

Exit criteria:

- Every canonical table used in code has a typed row schema and typed request schema.

## 4. Rewrite event store for full persisted envelope

Work units:

- Refactor append path to write full envelope fields:
  - `event_id`, `aggregate_kind`, `stream_id`, `stream_version`, `event_type`, `occurred_at`, `command_id`, `causation_event_id`, `correlation_id`, `actor_kind`, `payload_json`, `metadata_json`
- Implement stream version assignment/checking per aggregate stream.
- Refactor read/replay path to decode payload and metadata from JSON and return `OrchestrationEvent` consistently.
- Remove assumptions from old minimal schema (`aggregate_id`, missing metadata/actor).
- Add explicit SQL ordering guarantees for replay (`ORDER BY sequence ASC`).

Deliverables:

- Event store append/replay fully aligned with canonical envelope.

Breakage allowed:

- Command dispatch flow can be partially broken until receipts/projectors are updated.

Exit criteria:

- Event store no longer depends on legacy event table shape.

## 5. Add command receipt idempotency

Work units:

- Introduce persistence access layer for `orchestration_command_receipts`.
- In command dispatch flow, check existing receipt by `commandId` before append.
- On first execution, persist accepted receipt with `resultSequence`.
- On domain rejection, persist rejected receipt with error payload.
- On duplicate command, return prior result from receipt without re-appending event.
- Ensure receipt write and event append ordering is deterministic.

Deliverables:

- Dispatch path with idempotency behavior wired through receipts.

Breakage allowed:

- Snapshot/read model may still be inconsistent until projectors are fully wired.

Exit criteria:

- Duplicate command IDs no longer create duplicate events.

## 6. Build DB-backed projection pipeline

Work units:

- Create projector runner that consumes events and applies table-specific projections.
- Implement projector handlers for each projection table.
- For each handler, update target row(s) and `projection_state.last_applied_sequence` in the same transaction.
- Define projector names used in `projection_state` and make them stable constants.
- Add replay bootstrap from event store to bring projections up to latest sequence on startup.
- Add safe resume logic from projector `last_applied_sequence`.

Deliverables:

- Persistent projector pipeline writing all `projection_*` tables.

Breakage allowed:

- Web/API layer may still read old in-memory model until step 7.

Exit criteria:

- Events drive projection rows in DB; projection state advances transactionally.

## 7. Move RPC reads to projections and diff blobs

Work units:

- Implement snapshot query service reading only projection tables.
- Build thread hydration from projection rows: messages, activities, checkpoints, session.
- Compute `snapshotSequence` as the minimum required projector sequence from `projection_state`.
- Implement `getTurnDiff` query backed by `checkpoint_diff_blobs` only.
- Remove or bypass in-memory snapshot construction for RPC responses.
- Validate replay handoff contract: snapshot sequence -> replay from `fromSequenceExclusive`.

Deliverables:

- `orchestration.getSnapshot` and `orchestration.getTurnDiff` served from DB projections/blob store.

Breakage allowed:

- Provider runtime persistence may still be partially legacy until step 8.

Exit criteria:

- No orchestration read RPC depends on legacy tables or in-memory-only state.

## 8. Migrate provider runtime persistence to canonical table

Work units:

- Create repository/service for `provider_session_runtime`.
- Update adapter/session manager to persist runtime/resume cursor in new table.
- Ensure domain-visible session state still flows through orchestration events to `projection_thread_sessions`.
- Remove writes to legacy provider session tables.
- Verify restart/resume path reads runtime state from canonical table only.

Deliverables:

- Provider runtime state entirely backed by `provider_session_runtime`.

Breakage allowed:

- Some legacy interfaces may still exist but should be disconnected.

Exit criteria:

- Runtime restore no longer reads/writes legacy provider session persistence.

## 9. Remove old cruft aggressively

Work units:

- Delete legacy repositories/services that map to removed tables.
- Remove dead migration imports and obsolete persistence service interfaces.
- Remove compatibility code paths that translate legacy row shapes.
- Remove unused contracts/types linked to deprecated persistence model.
- Update internal docs/comments to reference canonical projection/event model only.

Deliverables:

- Legacy persistence and translation layers removed from active codebase.

Breakage allowed:

- Temporary compile failures acceptable while deletion/refactor is in progress.

Exit criteria:

- No production code path references deleted legacy tables/services.

## 10. Final verification gate (first point where green is required)

Work units:

- Add migration tests that assert canonical tables, columns, constraints, and indexes.
- Add event store tests for envelope persistence, metadata, actor kind, and replay.
- Add receipt idempotency tests for accept/reject/duplicate paths.
- Add projector tests for transactional row updates + `projection_state` updates.
- Add snapshot tests verifying projection-sourced output and `snapshotSequence` semantics.
- Add turn diff tests verifying `checkpoint_diff_blobs` source of truth.
- Add provider runtime tests for persist + restart + resume behavior.
- Run project lint/typecheck/tests and fix failures.

Deliverables:

- Green checks with canonical schema + persistence model in place.

Breakage allowed:

- None at end of step.

Exit criteria:

- SPEC `7.1`-`7.4` requirements satisfied and validated by tests.
