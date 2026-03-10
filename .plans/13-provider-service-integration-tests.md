# ProviderService Integration Test Plan

Goal:

- Validate end-to-end `ProviderService` behavior with real layers:
  - `ProviderServiceLive`
  - `CheckpointServiceLive`
  - `CheckpointStoreLive`
  - `CheckpointRepositoryLive` (sqlite in-memory)
  - `ProviderSessionDirectoryLive`
- Only fake the adapter event source (deterministic Codex-like stream).
- Avoid mocking checkpointing/persistence orchestration logic.

## Test Harness

Build a deterministic `TestProviderAdapterLive` in `apps/server/src/provider/Layers/TestProviderAdapter.integration.ts`:

- Service contract: `ProviderAdapterShape<ProviderAdapterError>`.
- Internal state:
  - session registry (session + cwd + threadId)
  - thread snapshot store (`threadId`, `turns`)
  - event subscribers
- Behavior:
  - `startSession`: creates session with threadId.
  - `sendTurn`: appends a deterministic turn snapshot and emits ordered events:
    - `turn/started`
    - `item/started` / `item/completed` (tool + approval variants depending on scenario)
    - `item/agentMessage/delta` chunks
    - `turn/completed`
  - optional "mutator" callback per turn to change workspace files before completion.
  - `readThread`, `rollbackThread`, `stopSession`, `stopAll`.

Use real git-backed temporary workspaces in integration tests:

- initialize repo with baseline commit
- run provider turn in workspace
- assert checkpoint diffs against real git refs

## Core Integration Specs

1. `startSession` initializes checkpoint root exactly once

- Arrange:
  - start provider session in git repo.
- Assert:
  - `provider_checkpoints` contains root row (turn 0).
  - checkpoint ref exists in git.
  - second `startSession` for new session creates a new independent root.

2. Turn without filesystem change

- Arrange:
  - emit normal turn events, no file mutation.
- Assert:
  - provider subscribers receive:
    - `turn/started`
    - `turn/completed`
    - synthetic `checkpoint/captured`
  - `listCheckpoints` returns root + turn 1.
  - `getCheckpointDiff(0 -> 1)` returns empty/no-op diff.

3. Turn with filesystem change

- Arrange:
  - mutate `README.md` during turn.
- Assert:
  - `listCheckpoints` returns root + turn 1.
  - `getCheckpointDiff(0 -> 1)` contains file path and hunk.
  - persisted checkpoint metadata includes non-empty `checkpointRef`.

4. Multi-turn sequencing and checkpoint monotonicity

- Arrange:
  - turn 1: no file change
  - turn 2: file change
  - turn 3: file change
- Assert:
  - turn counts are monotonic and contiguous in DB (0,1,2,3).
  - latest checkpoint is marked current.
  - diffs for adjacent turns map to expected filesystem deltas.

5. Revert to checkpoint

- Arrange:
  - execute 3 turns with at least one file-changing turn.
  - call `revertToCheckpoint(turnCount=1)`.
- Assert:
  - workspace content matches turn 1 state.
  - adapter `rollbackThread` called with `numTurns=2`.
  - DB rows for turns >1 are removed.
  - later refs are deleted from git.

6. Capture failure surface

- Arrange:
  - adapter emits `turn/completed`, but file mutation leaves invalid repo state or store capture fails.
- Assert:
  - `ProviderService` emits `checkpoint/captureError`.
  - no partial metadata/ref divergence is left behind.

## WebSocket Coverage (Thin Integration)

Add one ws server integration spec:

- Subscribe to `providers.event`.
- Run a deterministic provider turn through ws methods.
- Assert push stream includes:
  - `turn/started`, tool events, `turn/completed`, `checkpoint/captured`.
- Assert orchestration projection still updates assistant message and turn diff summary.

## Proposed PR Split

PR A:

- Test adapter harness + shared integration fixtures (repo setup, runtime/layer setup).

PR B:

- Core ProviderService integration specs (cases 1-4).

PR C:

- Revert + failure-path specs (cases 5-6) + ws thin integration spec.
