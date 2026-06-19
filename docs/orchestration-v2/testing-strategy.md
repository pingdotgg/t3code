# Testing Strategy

V2 should be validated with a small number of high-value integration tests rather than a large suite of unit tests that mock away the behavior being tested.

The goal is not "no test doubles ever." The goal is that test doubles exist only at true process, network, clock, id, and filesystem boundaries. Core orchestration behavior must run for real.

## Testing Principle

The default V2 test shape is:

```text
command dispatch
  -> real Orchestrator
  -> real ProviderAdapter
  -> replayed ProviderRuntime transport
  -> real adapter normalizer
  -> real V2 event store/sink using production persistence semantics
  -> real V2 projection/projector
  -> real Checkpoint policy
  -> assertions
```

The replay framework replaces the external provider process or network stream. It does not replace the adapter, normalizer, command/event infrastructure, projection reducers/projectors, checkpoint policy, or business logic.

Raw provider frames in replay transcripts are realistic transport evidence. In production, equivalent raw frames are diagnostic log data with bounded retention. Integration tests should still use real normalized orchestration persistence/projections so replay input exercises the same adapter and orchestration paths as live provider output.

## Allowed Test Substitutes

Allowed substitutes:

- provider runtime transport, backed by deterministic replay transcripts.
- Effect runtime time, controlled in tests with `TestClock` from `effect/testing`.
- Effect `Random`, provided with a deterministic test implementation for stable UUIDs/numbers.
- temporary filesystem/worktree.
- temporary database or in-memory database with the same repository interfaces.
- fake process supervisor only when it is testing process failure behavior directly.

Not allowed in integration tests:

- mocked orchestrator.
- mocked provider adapter.
- mocked provider event normalizer.
- mocked command/event infrastructure or V2 event sink.
- mocked projection reducer.
- mocked checkpoint service behavior.
- mocked provider capability policy.
- pre-normalized domain events used as the input for adapter tests.
- custom clock/id services that duplicate Effect's `Clock`, `DateTime`, or `Random` services.

Pure reducer tests are still valid, but they should be few and targeted. They should test projection invariants directly, not replace integration coverage.

Production code should read time through Effect runtime APIs, such as `DateTime.now` and `Clock.currentTimeMillis`, not through `Date.now` or ad hoc wrappers. Production code should allocate random values through `effect/Random`, not through direct `crypto.randomUUID`, `Math.random`, or a custom global id generator.

Tests should provide Effect test services:

```ts
import { TestClock } from "effect/testing";
```

The id allocator can still expose domain-specific helpers such as `newRunId` or `newNodeId`, but those helpers should be implemented on top of `Random` so test layers can produce deterministic values without mocking orchestration logic.

## Generic Replay Runtime

Replay must be provider-neutral. Codex NDJSON fixtures are one provider's transcript format, not the framework itself.

```ts
type ProviderReplayTranscript = {
  provider: ProviderKind;
  protocol: string;
  version: string;
  scenario: string;
  entries: ProviderReplayEntry[];
};

type ProviderReplayEntry =
  | {
      type: "expect_outbound";
      label?: string;
      frame: unknown;
    }
  | {
      type: "emit_inbound";
      label?: string;
      frame: unknown;
      afterMs?: number;
    }
  | {
      type: "runtime_exit";
      status: "success" | "error" | "cancelled";
      error?: unknown;
    };
```

The replay runtime owns deterministic transport semantics:

- ordered inbound event emission.
- outbound command assertion.
- pause/resume and timing control.
- runtime exit/error simulation.
- resume cursor/session restoration.
- transcript metadata validation.

The replay runtime must not know what a turn, plan, approval, subagent, or checkpoint means. Provider adapters interpret provider-specific frames.

Recovery tests use replay only at the provider transport boundary. App restart is tested by tearing down and recreating the outermost orchestrator/server layer against durable persistence. Idle cleanup and crash recovery are tested through production lifecycle services such as the session reaper or runtime recovery policy. Tests must not add adapter or orchestrator methods whose only purpose is to restart sessions for assertions.

## Provider Transcript Formats

Each provider can have its own raw frame format inside the generic replay envelope.

Examples:

```text
Codex replay transcript
  -> JSON-RPC app-server requests/responses/notifications
  -> consumed by CodexAdapter

Claude replay transcript
  -> Claude Agent SDK query() outbound options and yielded SDKMessage chunks
  -> consumed by ClaudeAdapter

Cursor replay transcript
  -> Cursor Agent SDK open/send calls and ordered onDelta/run results
  -> consumed by CursorAdapter

OpenCode replay transcript
  -> OpenCode SDK requests/responses plus ordered SSE events
  -> consumed by OpenCodeAdapter

ACP replay transcript
  -> logical JSON-RPC requests/responses/notifications over a strict NDJSON peer
  -> consumed by AcpAdapter and a provider flavor (Grok or ACP Registry)
```

Fixtures should preserve raw provider evidence as closely as possible. Expected V2 events or projections are assertions, not fixture input.

For Claude, the initial replay boundary is the async iterable returned by the Agent SDK `query()`
call. A transcript should include the `query` prompt/options we sent and then replay the raw
`SDKMessage` chunks in provider order. This intentionally tests the V2 adapter against real Claude
SDK output; it does not test the SDK's own subprocess or transport parser.

ACP fixtures run against a child-process replay peer that validates every outbound frame and
serves recorded inbound frames. This replaces only the external ACP driver transport; the shared
runtime, adapter normalization, orchestration, persistence, and projections remain production code.
The generic ACP Registry harness retargets protocol-standard ACP transcripts;
provider-extension transcripts remain scoped to the flavor that owns the extension.

OpenCode fixtures replace the SDK client at its HTTP/SSE boundary. They must preserve races between
request responses and SSE events, because user messages and terminal `session.status` events can
arrive before the corresponding `promptAsync` or `abort` response. Subagent fixtures must retain
both parent and child session ids so root-only terminal behavior remains testable.

Provider transcript recorders live with the server orchestration testkit, not with provider client
packages. Use `bun run record:codex-replay -- --scenario <name>` for Codex app-server transcripts
and `bun run record:claude-replay -- --scenario <name>` for Claude Agent SDK transcripts. Use
`pnpm --filter t3 record:cursor-replay -- --scenario <name>` for Cursor Agent SDK transcripts.

## Contract Test Levels

Recommended levels:

1. Schema tests for V2 contracts.
2. Pure projection tests for hard invariants.
3. Provider adapter replay tests from raw transcript to V2 domain events.
4. Full orchestration integration tests from commands through replay runtime to final projection.

The fourth level is the most important one. It is the test that catches lifecycle mismatches such as child turns closing parent runs or checkpoints being captured too early.

## First Ten Integration Tests

V2 should start with roughly ten strong tests:

1. `simple`: sending one message creates one run, one root node, one provider turn, one assistant response, and one root checkpoint.
2. `multi_turn`: follow-up messages create monotonically ordered app runs on the same app thread.
3. `message_steering`: steering attaches to the active run intent instead of becoming an unrelated run.
4. `turn_interrupt`: interrupt acknowledgement does not complete the run until the provider terminal event arrives.
5. `steering_restart_fallback`: a provider without native steering interrupts the active attempt and creates a replacement attempt under the same run.
6. `subagent`: child provider turns create nested execution nodes and never complete the parent run.
7. `subagent_checkpoint`: child/subagent nodes create nested checkpoint scopes without advancing the app run count.
8. `thread_rollback`: rollback targets checkpoint scopes and reconciles provider rollback snapshots.
9. `approval_request`: provider approval callbacks become durable runtime requests and are resolved through the real adapter path.
10. `provider_switch_return`: switching away from a provider creates a context handoff, and switching back resumes the prior provider thread with a delta handoff.

Additional tests should be added only when they protect a new invariant or reproduce a real failure mode.

## Fixture Rules

- Fixtures are raw provider transcripts, not mocked domain events.
- Fixtures should include enough outbound expectations to prove the app sent the correct provider commands.
- Fixtures should include protocol metadata, provider version, model, cwd policy, and capture timestamp.
- Fixture playback must be deterministic under Effect `TestClock` and deterministic `Random` layers.
- When a provider transcript is generated from a real run, keep the original provider frame ordering.
- Redaction should preserve ids, method names, lifecycle ordering, and correlation structure.
- Fixture transcripts are test input and diagnostic evidence. They do not imply production stores all raw provider frames in SQLite.

## Assertions

Assertions should prefer final projections and durable normalized orchestration events over incidental implementation calls.

Good assertions:

- duplicate command dispatch returns the original receipt sequence without replaying provider transport.
- stored-event sequence monotonicity.
- snapshot sequence plus stream-after-sequence behavior.
- run status and ordinal.
- active/final run attempt.
- execution node parent/child structure.
- provider thread and provider turn correlation.
- checkpoint scope hierarchy.
- pending/resolved runtime requests.
- handoff coverage and strategy.
- replay transcript frame count and normalized event count when relevant.

Weak assertions:

- exact internal function call counts.
- private helper invocation order.
- mocked callback arguments below the adapter/runtime boundary.

## Implementation Order

Testing infrastructure should be built before production rewrites:

1. V2 contract schemas.
2. Effect service definitions.
3. provider runtime transport abstraction.
4. generic replay runtime.
5. Codex, Claude, Cursor, OpenCode, and ACP transcript loaders for app-owned provider replay fixtures.
6. projection reducer tests for core invariants.
7. full command-to-projection integration tests.
8. production layers.

This keeps the architecture executable while it is being built and prevents tests from validating only simplified mocks.
