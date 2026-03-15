# SPEC Contract Matrix (Sections 7.1-7.4)

Status legend:

- `required`: requirement acknowledged, no current implementation claim yet.
- `implemented`: requirement currently satisfied in code + schema.
- `to-replace`: partial/misaligned implementation exists and must be replaced.
- `delete`: current path actively conflicts with SPEC and should be removed.

## 7.1 Write-Side Persisted Tables

### W1

- Spec ref: `7.1.1 orchestration_events`
- Requirement: append-only event store with canonical envelope columns.
- SQL contract:
  - `sequence INTEGER PRIMARY KEY` (global monotonic)
  - `event_id TEXT UNIQUE NOT NULL`
  - `aggregate_kind TEXT NOT NULL CHECK IN ('project','thread')`
  - `stream_id TEXT NOT NULL`
  - `stream_version INTEGER NOT NULL`
  - `event_type TEXT NOT NULL`
  - `occurred_at TEXT NOT NULL`
  - `command_id TEXT NULL`
  - `causation_event_id TEXT NULL`
  - `correlation_id TEXT NULL`
  - `actor_kind TEXT NOT NULL CHECK IN ('client','server','provider')`
  - `payload_json TEXT NOT NULL`
  - `metadata_json TEXT NOT NULL`
- Current writer path: `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`
- Current reader path: `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`
- Owner module: `apps/server/src/persistence` (event store + migrations)
- Status: `to-replace`
- Notes: current migration/table lacks `stream_id`, `stream_version`, `causation_event_id`, `correlation_id`, `actor_kind`, `metadata_json`.

### W2

- Spec ref: `7.1.2 orchestration_command_receipts`
- Requirement: command idempotency + ack replay receipts table.
- SQL contract:
  - `command_id TEXT PRIMARY KEY`
  - `aggregate_kind TEXT NOT NULL CHECK IN ('project','thread')`
  - `aggregate_id TEXT NOT NULL`
  - `accepted_at TEXT NOT NULL`
  - `result_sequence INTEGER NOT NULL`
  - `status TEXT NOT NULL CHECK IN ('accepted','rejected')`
  - `error TEXT NULL`
- Current writer path: none
- Current reader path: none
- Owner module: `apps/server/src/orchestration` dispatch boundary + `apps/server/src/persistence`
- Status: `to-replace`
- Notes: missing table and missing idempotency flow.

### W3

- Spec ref: `7.1.3 checkpoint_diff_blobs`
- Requirement: store large plaintext diffs separate from checkpoint summaries.
- SQL contract:
  - `thread_id TEXT NOT NULL`
  - `from_turn_count INTEGER NOT NULL`
  - `to_turn_count INTEGER NOT NULL`
  - `diff TEXT NOT NULL`
  - `created_at TEXT NOT NULL`
  - `UNIQUE(thread_id, from_turn_count, to_turn_count)`
- Current writer path: none
- Current reader path: none
- Owner module: `apps/server/src/persistence` + turn diff query service
- Status: `to-replace`
- Notes: no canonical diff blob table yet.

### W4

- Spec ref: `7.1.4 provider_session_runtime`
- Requirement: server-internal provider runtime/resume state.
- SQL contract:
  - `provider_session_id TEXT PRIMARY KEY`
  - `thread_id TEXT NOT NULL`
  - `provider_name TEXT NOT NULL`
  - `adapter_key TEXT NOT NULL`
  - `provider_thread_id TEXT NULL`
  - `status TEXT NOT NULL CHECK IN ('starting','running','stopped','error')`
  - `last_seen_at TEXT NOT NULL`
  - `resume_cursor_json TEXT NULL`
  - `runtime_payload_json TEXT NULL`
- Current writer path: legacy provider session persistence (`apps/server/src/persistence/Layers/ProviderSessions.ts`)
- Current reader path: legacy provider session persistence (`apps/server/src/persistence/Layers/ProviderSessions.ts`)
- Owner module: provider runtime manager + persistence runtime repository
- Status: `to-replace`
- Notes: existing `provider_sessions` schema is incompatible and too small.

## 7.2 Canonical Persisted Event Schema

### E1

- Spec ref: `7.2 OrchestrationPersistedEventSchema`
- Requirement: full typed persisted event envelope in shared contracts.
- SQL contract: envelope fields in W1 must map 1:1 to contracts schema.
- Current writer path: contracts defined in `packages/contracts/src/orchestration.ts`
- Current reader path: used by persistence decode boundaries (partial)
- Owner module: `packages/contracts`
- Status: `implemented`
- Notes: contract schema exists; DB + store mapping still incomplete.

### E2

- Spec ref: `7.2 Rules/payload discriminated by eventType`
- Requirement: `payload` validation keyed by `eventType`.
- SQL contract: `event_type` drives payload decode schema; invalid combinations rejected.
- Current writer path: `packages/contracts/src/orchestration.ts`
- Current reader path: `apps/server/src/persistence/Layers/OrchestrationEventStore.ts` decode path
- Owner module: contracts + event store
- Status: `to-replace`
- Notes: decode is present but DB does not persist full envelope columns.

### E3

- Spec ref: `7.2 Rules/provider ids scope`
- Requirement: provider ids live in metadata/provider payload, not as thread identity replacement.
- SQL contract: provider fields persisted inside `metadata_json`; `stream_id` remains project/thread id.
- Current writer path: `apps/server/src/orchestration/decider.ts` (metadata mostly empty)
- Current reader path: projector/event consumers
- Owner module: decider + provider ingestion + event store
- Status: `to-replace`
- Notes: metadata plumbing is incomplete in persistence path.

### E4

- Spec ref: `7.2 Rules/streamVersion concurrency guard`
- Requirement: stream version monotonic per aggregate stream; enforced on write.
- SQL contract: `stream_version INTEGER NOT NULL` + uniqueness/invariant enforcement per stream.
- Current writer path: none
- Current reader path: none
- Owner module: event store append logic + DB constraints
- Status: `to-replace`
- Notes: no stream version assignment/checking today.

## 7.3 Required Projected Tables (Read Models)

### P1

- Spec ref: `7.3.1 projection_projects`
- Requirement: persisted project projection table.
- SQL contract:
  - `project_id TEXT PRIMARY KEY`
  - `title TEXT NOT NULL`
  - `workspace_root TEXT NOT NULL`
  - `default_model TEXT NULL`
  - `created_at TEXT NOT NULL`
  - `updated_at TEXT NOT NULL`
  - `deleted_at TEXT NULL`
- Current writer path: none (in-memory projector only)
- Current reader path: none (snapshot not DB-projected)
- Owner module: projector pipeline + snapshot query
- Status: `to-replace`
- Notes: legacy `projects` table is separate concept and should be removed from orchestration model.

### P2

- Spec ref: `7.3.2 projection_threads`
- Requirement: persisted thread projection table.
- SQL contract:
  - `thread_id TEXT PRIMARY KEY`
  - `project_id TEXT NOT NULL`
  - `title TEXT NOT NULL`
  - `model TEXT NOT NULL`
  - `branch TEXT NULL`
  - `worktree_path TEXT NULL`
  - `latest_turn_id TEXT NULL`
  - `created_at TEXT NOT NULL`
  - `updated_at TEXT NOT NULL`
  - `deleted_at TEXT NULL`
- Current writer path: none (in-memory projector only)
- Current reader path: none (snapshot not DB-projected)
- Owner module: projector pipeline + snapshot query
- Status: `to-replace`
- Notes: missing table and projector writes.

### P3

- Spec ref: `7.3.3 projection_thread_messages`
- Requirement: persisted thread message projection table.
- SQL contract:
  - `message_id TEXT PRIMARY KEY`
  - `thread_id TEXT NOT NULL`
  - `turn_id TEXT NULL`
  - `role TEXT NOT NULL CHECK IN ('user','assistant','system')`
  - `text TEXT NOT NULL`
  - `is_streaming INTEGER/BOOLEAN NOT NULL`
  - `created_at TEXT NOT NULL`
  - `updated_at TEXT NOT NULL`
- Current writer path: none (in-memory projector only)
- Current reader path: none (snapshot not DB-projected)
- Owner module: projector pipeline + snapshot query
- Status: `to-replace`
- Notes: missing table and message projection writes.

### P4

- Spec ref: `7.3.4 projection_thread_activities`
- Requirement: persisted thread activity projection table.
- SQL contract:
  - `activity_id TEXT PRIMARY KEY`
  - `thread_id TEXT NOT NULL`
  - `turn_id TEXT NULL`
  - `tone TEXT NOT NULL CHECK IN ('info','tool','approval','error')`
  - `kind TEXT NOT NULL`
  - `summary TEXT NOT NULL`
  - `payload_json TEXT NOT NULL`
  - `created_at TEXT NOT NULL`
- Current writer path: none (in-memory projector only)
- Current reader path: none (snapshot not DB-projected)
- Owner module: projector pipeline + snapshot query
- Status: `to-replace`
- Notes: no canonical activity projection persistence.

### P5

- Spec ref: `7.3.5 projection_thread_sessions`
- Requirement: persisted thread session projection table.
- SQL contract:
  - `thread_id TEXT PRIMARY KEY`
  - `status TEXT NOT NULL CHECK IN ('idle','starting','running','ready','interrupted','stopped','error')`
  - `provider_name TEXT NULL`
  - `provider_session_id TEXT NULL`
  - `provider_thread_id TEXT NULL`
  - `active_turn_id TEXT NULL`
  - `last_error TEXT NULL`
  - `updated_at TEXT NOT NULL`
- Current writer path: none (in-memory projector only)
- Current reader path: none (snapshot not DB-projected)
- Owner module: projector pipeline + snapshot query
- Status: `to-replace`
- Notes: current provider session table is not this domain projection.

### P6

- Spec ref: `7.3.6 projection_thread_turns`
- Requirement: persisted thread turn projection table.
- SQL contract:
  - `turn_id TEXT PRIMARY KEY`
  - `thread_id TEXT NOT NULL`
  - `turn_count INTEGER NOT NULL`
  - `status TEXT NOT NULL CHECK IN ('running','completed','interrupted','error')`
  - `user_message_id TEXT NULL`
  - `assistant_message_id TEXT NULL`
  - `started_at TEXT NOT NULL`
  - `completed_at TEXT NULL`
- Current writer path: none
- Current reader path: none
- Owner module: projector pipeline + session/turn query helpers
- Status: `to-replace`
- Notes: missing table and projection logic.

### P7

- Spec ref: `7.3.7 projection_checkpoints`
- Requirement: persisted checkpoint summary projection table.
- SQL contract:
  - `thread_id TEXT NOT NULL`
  - `turn_id TEXT NOT NULL`
  - `checkpoint_turn_count INTEGER NOT NULL`
  - `checkpoint_ref TEXT NOT NULL`
  - `status TEXT NOT NULL CHECK IN ('ready','missing','error')`
  - `files_json TEXT NOT NULL`
  - `assistant_message_id TEXT NULL`
  - `completed_at TEXT NOT NULL`
  - `UNIQUE(thread_id, checkpoint_turn_count)`
- Current writer path: legacy `provider_checkpoints` writes in `apps/server/src/persistence/Layers/Checkpoints.ts`
- Current reader path: legacy checkpoint repository
- Owner module: projector pipeline + checkpoint query layer
- Status: `to-replace`
- Notes: current table semantics do not match canonical checkpoint projection schema.

### P8

- Spec ref: `7.3.8 projection_pending_approvals`
- Requirement: persisted pending-approval projection table.
- SQL contract:
  - `request_id TEXT PRIMARY KEY`
  - `thread_id TEXT NOT NULL`
  - `turn_id TEXT NULL`
  - `status TEXT NOT NULL CHECK IN ('pending','resolved')`
  - `decision TEXT NULL CHECK IN ('accept','acceptForSession','decline','cancel')`
  - `created_at TEXT NOT NULL`
  - `resolved_at TEXT NULL`
- Current writer path: none
- Current reader path: none
- Owner module: projector pipeline + approval query layer
- Status: `to-replace`
- Notes: missing table and projection logic.

### P9

- Spec ref: `7.3.9 projection_state`
- Requirement: projector progress tracking table.
- SQL contract:
  - `projector TEXT PRIMARY KEY`
  - `last_applied_sequence INTEGER NOT NULL`
  - `updated_at TEXT NOT NULL`
- Current writer path: none
- Current reader path: none
- Owner module: projector runner/checkpointing
- Status: `to-replace`
- Notes: missing table and projector bookkeeping.

### P10

- Spec ref: `7.3 Projection consistency rules`
- Requirement: projector row updates and `projection_state` update must be atomic per event.
- SQL contract: per-projector transaction boundary covering both projection write and state update.
- Current writer path: none (in-memory projector has no SQL transaction)
- Current reader path: none
- Owner module: projector runner
- Status: `to-replace`
- Notes: requires transactional projection executor.

### P11

- Spec ref: `7.3 Optional debug field`
- Requirement: `lastEventSequence` on projection rows is optional and not required for correctness.
- SQL contract: optional; not required in baseline schema.
- Current writer path: none
- Current reader path: none
- Owner module: projector runner
- Status: `required`
- Notes: interpretation: exclude from first cutover unless debugging requires it.

## 7.4 Snapshot and RPC Requirements

### R1

- Spec ref: `7.4.1`
- Requirement: `orchestration.getSnapshot` fully served from projection tables and returns `snapshotSequence`.
- SQL contract: snapshot query joins/reads only `projection_*` + `projection_state`.
- Current writer path: in-memory model built in `apps/server/src/orchestration/projector.ts`
- Current reader path: `apps/server/src/orchestration/Layers/OrchestrationEngine.ts#getReadModel`
- Owner module: snapshot query service + ws RPC handler
- Status: `delete`
- Notes: current in-memory read model path must be removed for SPEC compliance.

### R2

- Spec ref: `7.4.2`
- Requirement: snapshot `projects[]` source is `projection_projects`.
- SQL contract: `projects` collection assembled from `projection_projects` rows.
- Current writer path: none
- Current reader path: in-memory thread/project arrays
- Owner module: snapshot query service
- Status: `to-replace`
- Notes: no DB project projection reader exists yet.

### R3

- Spec ref: `7.4.3`
- Requirement: thread snapshot `checkpoints[]` source is `projection_checkpoints` with required fields.
- SQL contract: fields `turnId`, `completedAt`, `status`, `files[]`, `checkpointRef`, optional `assistantMessageId`, `checkpointTurnCount`.
- Current writer path: legacy checkpoint repo data model
- Current reader path: in-memory checkpoints from orchestration events
- Owner module: snapshot query service + checkpoint projector
- Status: `to-replace`
- Notes: canonical projection table and reader not implemented.

### R4

- Spec ref: `7.4.4`
- Requirement: no `listCheckpoints` orchestration RPC; list in snapshot + full diff via `getTurnDiff` from diff blobs.
- SQL contract: `getTurnDiff` reads `checkpoint_diff_blobs` only.
- Current writer path: none for diff blobs
- Current reader path: `orchestration.getTurnDiff` schema exists, data backing incomplete
- Owner module: ws RPC handler + diff query service
- Status: `to-replace`
- Notes: current checkpoint repository is not canonical source.

### R5

- Spec ref: `7.4.5`
- Requirement: client acts on `ThreadId`; server resolves provider session via `projection_thread_sessions`.
- SQL contract: session lookup by `thread_id` from projection table.
- Current writer path: mixed provider/session handling paths
- Current reader path: legacy provider session persistence lookups
- Owner module: provider dispatch/session resolution
- Status: `to-replace`
- Notes: remove provider-session-as-routing-key behavior.

### R6

- Spec ref: `7.4.6`
- Requirement: `snapshotSequence` derived from `projection_state` minimum over dependent projectors.
- SQL contract: `MIN(last_applied_sequence)` across required projector keys.
- Current writer path: none
- Current reader path: currently from in-memory event projection sequence
- Owner module: snapshot query service
- Status: `to-replace`
- Notes: must move from in-memory sequence to DB projection-state semantics.

### R7

- Spec ref: `7.4.7`
- Requirement: snapshot/replay handoff has no gap (`getSnapshot` -> subscribe from snapshot sequence).
- SQL contract: read consistency strategy guaranteeing no missing events between snapshot visibility and replay start.
- Current writer path: event stream via `OrchestrationEventStore.readFromSequence`
- Current reader path: ws replay flow in `apps/server/src/wsServer.ts`
- Owner module: ws RPC + event stream handoff layer
- Status: `to-replace`
- Notes: interpretation requires explicit consistency boundary (transaction, sequence fence, or equivalent).

## Ambiguous/Interpretation Decisions (tracked upfront)

### A1

- Topic: `orchestration_events.stream_id` vs event runtime `aggregateId` naming.
- Decision: persist canonical DB column name `stream_id`; map to runtime `aggregateId` where needed in decider/projector code.

### A2

- Topic: JSON column typing in SQLite for `payload`, `metadata`, projection payload/files, runtime cursor/payload.
- Decision: store as `TEXT` JSON with strict encode/decode schemas at boundaries.

### A3

- Topic: `snapshotSequence` dependency set for min-sequence computation.
- Decision: include all projectors used to construct snapshot payload (`projects`, `threads`, `messages`, `activities`, `sessions`, `turns`, `checkpoints`, `pending_approvals`).

### A4

- Topic: no-gap handoff mechanism in `7.4.7`.
- Decision: implement explicit sequence fence semantics at snapshot time; replay starts from fence `fromSequenceExclusive`.

## Checklist Completeness Statement

- Coverage scope: `SPEC.md` sections `7.1`, `7.2`, `7.3`, `7.4`.
- Requirement rows present: `W1-W4`, `E1-E4`, `P1-P11`, `R1-R7`.
- Unclassified rows: `0`.
