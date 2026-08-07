import {
  ProviderDriverKind,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { make, type SentryAgentTurnSpan } from "./SentryAgentMonitoring.ts";

const provider = ProviderDriverKind.make("codex");
const threadId = ThreadId.make("thread-1");
const turnId = TurnId.make("turn-1");
const startedAt = "2026-01-01T00:00:00.000Z";
const completedAt = "2026-01-01T00:00:02.500Z";

const usage: ThreadTokenUsageSnapshot = {
  usedTokens: 999,
  lastUsedTokens: 135,
  inputTokens: 800,
  cachedInputTokens: 300,
  outputTokens: 199,
  reasoningOutputTokens: 70,
  lastInputTokens: 100,
  lastCachedInputTokens: 40,
  lastOutputTokens: 35,
  lastReasoningOutputTokens: 12,
  toolUses: 1,
  durationMs: 2_500,
};

const makeHarness = (enabled: Ref.Ref<boolean>) =>
  Effect.gen(function* () {
    const spans = yield* Ref.make<ReadonlyArray<SentryAgentTurnSpan>>([]);
    const monitoring = yield* make({
      isExportEnabled: Ref.get(enabled),
      exportSpan: (span) => Ref.update(spans, (current) => [...current, span]),
    });
    return { monitoring, spans };
  });

describe("SentryAgentMonitoring", () => {
  it.effect("does not export while disabled", () =>
    Effect.gen(function* () {
      const enabled = yield* Ref.make(false);
      const { monitoring, spans } = yield* makeHarness(enabled);

      yield* monitoring.record({
        type: "turn.completed",
        provider,
        threadId,
        turnId,
        createdAt: completedAt,
        state: "completed",
        model: "gpt-5.6",
      });

      assert.deepEqual(yield* Ref.get(spans), []);
    }),
  );

  it.effect("maps model, tokens, tools, duration, cost, and completion state", () =>
    Effect.gen(function* () {
      const enabled = yield* Ref.make(true);
      const { monitoring, spans } = yield* makeHarness(enabled);

      yield* monitoring.record({
        type: "turn.started",
        provider,
        threadId,
        turnId,
        createdAt: startedAt,
        model: "gpt-5.6",
      });
      yield* monitoring.record({ type: "turn.usage", threadId, turnId, usage });
      yield* monitoring.record({
        type: "turn.tool-used",
        threadId,
        turnId,
        toolUseId: "tool-1",
      });
      yield* monitoring.record({
        type: "turn.tool-used",
        threadId,
        turnId,
        toolUseId: "tool-2",
      });
      yield* monitoring.record({
        type: "turn.completed",
        provider,
        threadId,
        turnId,
        createdAt: completedAt,
        state: "completed",
        totalCostUsd: 0.0125,
      });

      const exported = yield* Ref.get(spans);
      assert.lengthOf(exported, 1);
      assert.deepInclude(exported[0]?.attributes, {
        "gen_ai.provider.name": "codex",
        "gen_ai.request.model": "gpt-5.6",
        "gen_ai.response.model": "gpt-5.6",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 35,
        "gen_ai.usage.total_tokens": 135,
        "gen_ai.usage.cache_read.input_tokens": 40,
        "gen_ai.usage.reasoning.output_tokens": 12,
        "gen_ai.cost.total_tokens": 0.0125,
        "t3.agent.tool_use.count": 2,
        "t3.agent.turn.duration_ms": 2_500,
        "t3.agent.turn.completion_state": "completed",
      });
      assert.isFalse(exported[0]?.failed);
    }),
  );

  it.effect("maps normalized runtime errors without exporting the provider message", () =>
    Effect.gen(function* () {
      const enabled = yield* Ref.make(true);
      const { monitoring, spans } = yield* makeHarness(enabled);

      yield* monitoring.record({
        type: "turn.started",
        provider,
        threadId,
        turnId,
        createdAt: startedAt,
        model: "gpt-5.6",
      });
      yield* monitoring.record({
        type: "turn.error",
        provider,
        threadId,
        turnId,
        createdAt: completedAt,
        errorClass: "permission_error",
      });

      const [exported] = yield* Ref.get(spans);
      assert.isTrue(exported?.failed);
      assert.equal(exported?.attributes["error.type"], "permission_error");
      assert.notProperty(exported?.attributes ?? {}, "error.message");
      assert.deepEqual(
        Object.keys(exported?.attributes ?? {}).filter((key) => key === "error.type"),
        ["error.type"],
      );
    }),
  );

  it.effect("stops future exports as soon as the setting is disabled", () =>
    Effect.gen(function* () {
      const enabled = yield* Ref.make(true);
      const { monitoring, spans } = yield* makeHarness(enabled);

      yield* monitoring.record({
        type: "turn.completed",
        provider,
        threadId,
        turnId,
        createdAt: completedAt,
        state: "completed",
      });
      yield* Ref.set(enabled, false);
      yield* monitoring.record({
        type: "turn.completed",
        provider,
        threadId,
        turnId: TurnId.make("turn-2"),
        createdAt: completedAt,
        state: "failed",
      });

      assert.lengthOf(yield* Ref.get(spans), 1);
    }),
  );
});
