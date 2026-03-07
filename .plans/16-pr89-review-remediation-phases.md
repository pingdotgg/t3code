# PR #89 Review Remediation Plan (Phased)

## How To Use These Files

- Working checklist with updateable status per item (single source of truth): `.plans/16c-pr89-remediation-checklist.md`
- This file (`16-pr89-review-remediation-phases.md`): phase strategy and grouping.

## Scope

- Source: GitHub review comments on PR #89 (`Add server-side orchestration engine with event sourcing`).
- Triage baseline used here:
  - Total threads: 185
  - Outdated: 94 (excluded)
  - Active unresolved: 85
  - Invalid/false-positive: 3 (excluded)
  - Duplicate reposts: collapsed
  - Unique actionable findings after filtering: 58
  - Post-rewrite validity audit: 5 additional stale items marked invalid, leaving 53 actionable (`34 valid` + `19 partially-valid`)

## Phase 0: Canonical Triage Lock

- Create a single tracking checklist for the 53 currently actionable findings.
- Map every duplicate thread to its canonical item.
- Mark invalid/false-positive items with explicit rationale.

Exit criteria:
- Every open thread is mapped to one canonical fix item or marked invalid.

## Phase 1: Runtime Survival and Critical Event Wiring

Related bug groups solved together:
- Worker loop/fiber fatal error handling in orchestration reactors.
- WebSocket message error boundaries and unhandled rejection guards.
- Close invalid `providers.event` review findings as documented architecture mismatch (no code change expected).

Primary files:
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/server/src/orchestration/Layers/CheckpointReactor.ts`
- `apps/server/src/wsServer.ts`

Exit criteria:
- A single event-processing failure cannot permanently stop ingestion/reactor loops.
- WS message handling cannot produce unhandled promise rejections.
- Invalid provider-event-channel review findings are closed with architecture rationale.

## Phase 2: State Consistency and Ordering

Related bug groups solved together:
- Fire-and-forget revert completion causing consistency windows.
- Non-atomic append/projection paths and retry behavior.
- Race-sensitive thread/event association issues.

Primary files:
- `apps/server/src/orchestration/Layers/CheckpointReactor.ts`
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`

Exit criteria:
- Revert flow is deterministically reflected in read model updates.
- Append/project failure mode is explicit and safe under retry.
- No cross-thread misassociation under concurrent runtime events.

## Phase 3: Checkpointing Correctness Bundle

Related bug groups solved together:
- Checkpoint input normalization consistency.
- Snapshot/projector coverage mismatches.
- Checkpoint ref/workspace CWD utility duplication.
- Checkpoint diff/error handling behavior gaps.

Primary files:
- `apps/server/src/checkpointing/Layers/CheckpointStore.ts`
- `apps/server/src/checkpointing/Layers/CheckpointDiffQuery.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `apps/server/src/orchestration/Layers/CheckpointReactor.ts`
- `apps/server/src/wsServer.ts`

Exit criteria:
- Checkpoint capture/restore/revert paths use one normalization policy.
- Required projectors are actually represented in snapshot reads.
- Shared checkpoint/ref/CWD helpers are centralized.

## Phase 4: Memory and Lifecycle Hygiene

Related bug groups solved together:
- Unbounded in-memory dedup sets/maps.
- Missing cleanup/lifecycle protections in long-lived effects/resources.

Primary files:
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/server/src/config.ts`

Exit criteria:
- Long-running server memory does not grow unbounded from dedup bookkeeping.
- Resource cleanup paths are registered for interruption/shutdown.

## Phase 5: Transport, Parsing, and Platform Edge Cases

Related bug groups solved together:
- UTF-8 chunk boundary decode correctness.
- Markdown/file-link parsing edge cases.
- Shell/OS-specific PATH parsing behavior.
- Git rename parsing and small keybinding edge cases.

Primary files:
- `apps/server/src/wsServer.ts`
- `apps/server/src/git/Layers/CodexTextGeneration.ts`
- `apps/web/src/markdown-links.ts`
- `apps/server/src/os-jank.ts`
- `apps/server/src/git/Layers/GitCore.ts`
- `apps/server/src/keybindings.ts`

Exit criteria:
- Edge-case parsers are robust across valid but non-trivial inputs.
- Platform-dependent command behavior has safe fallbacks.

## Phase 6: Build and Maintainability Cleanup

Related bug groups solved together:
- Build script/runtime assumption cleanup.
- Redundant error-union declarations and utility/type duplication.
- Non-functional cleanup comments/docs markers.

Primary files:
- `apps/server/package.json`
- `apps/server/src/checkpointing/Errors.ts`
- Shared utility locations introduced during earlier phases
- `AGENTS.md` (if cleanup is still pending)

Exit criteria:
- Build path is explicit and environment-safe.
- Redundant types/utilities are removed in favor of single sources of truth.

## Phase 7: Verification and Closeout

- Add backend tests for all behavioral fixes (integration-focused; external services may be layered/mocked, core business logic not mocked out).
- Run lint and backend tests for all touched packages.
- Resolve threads with fix references per canonical checklist item.

Exit criteria:
- Lint passes.
- Backend tests pass.
- All actionable review threads are resolved or explicitly justified.
