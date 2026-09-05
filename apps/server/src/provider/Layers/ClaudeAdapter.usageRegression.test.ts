import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Options as ClaudeQueryOptions,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSettings, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { makeClaudeAdapter } from "./ClaudeAdapter.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const THREAD_ID = ThreadId.make("thread-claude-usage-regression");

class ClaudeUsageRegressionAdapter extends Context.Service<
  ClaudeUsageRegressionAdapter,
  ClaudeAdapterShape
>()("t3/provider/Layers/ClaudeAdapter.usageRegression.test/ClaudeUsageRegressionAdapter") {}

class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<(value: IteratorResult<SDKMessage>) => void> = [];
  private done = false;

  emit(message: SDKMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  finish(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  readonly setModel = async (_model?: string): Promise<void> => {};
  readonly setPermissionMode = async (_mode: string): Promise<void> => {};
  readonly setMaxThinkingTokens = async (_tokens: number | null): Promise<void> => {};
  readonly close = (): void => this.finish();

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) {
          return Promise.resolve({ done: false, value });
        }
        if (this.done) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Builds the minimal live adapter layer needed to drive SDK messages through completeTurn. */
function makeHarness() {
  const query = new FakeClaudeQuery();
  let createInput:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }
    | undefined;

  const layer = Layer.effect(
    ClaudeUsageRegressionAdapter,
    Effect.gen(function* () {
      return yield* makeClaudeAdapter(decodeClaudeSettings({}), {
        createQuery: (input) => {
          createInput = input;
          return query;
        },
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-usage-regression", "/tmp")),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );

  return { layer, query, getCreateInput: () => createInput };
}

/** Returns a deterministic Random service so runtime event ids are stable in the test harness. */
function makeDeterministicRandomService(seed = 0x1234_5678): {
  nextIntUnsafe: () => number;
  nextDoubleUnsafe: () => number;
} {
  let state = seed >>> 0;
  const nextIntUnsafe = (): number => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state;
  };
  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
}

describe("ClaudeAdapter cumulative usage regression", () => {
  it.effect("preserves parent message_delta context over cumulative result usage (#8594)", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeUsageRegressionAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      // This is the parent-session path from the issue: message_delta carries
      // the per-request active context. It deliberately does not use
      // task_progress, which is the separate subagent-meter bug (#4650).
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-8594",
        uuid: "message-delta-8594",
        parent_tool_use_id: null,
        event: {
          type: "message_delta",
          delta: {
            stop_reason: null,
            stop_sequence: null,
          },
          usage: {
            input_tokens: 100000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 12994,
            output_tokens: 0,
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-8594",
        usage: {
          input_tokens: 100000,
          cache_creation_input_tokens: 50000,
          cache_read_input_tokens: 2034473,
          output_tokens: 18487,
          total_tokens: 2202960,
          iterations: [],
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 1000000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const finalUsage = events.findLast((event) => event.type === "thread.token-usage.updated");
      assert.equal(finalUsage?.type, "thread.token-usage.updated");
      if (finalUsage?.type === "thread.token-usage.updated") {
        assert.deepEqual(finalUsage.payload.usage, {
          usedTokens: 112994,
          lastUsedTokens: 112994,
          totalProcessedTokens: 2202960,
          inputTokens: 112994,
          maxTokens: 1000000,
        });
      }

      // Keep the prompt reference live so this harness matches the real SDK
      // setup shape and catches accidental query construction regressions.
      assert.isDefined(harness.getCreateInput());
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses the current result when a later turn has no message_delta", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeUsageRegressionAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const firstTurnEvents = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "first", attachments: [] });
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-stale-usage",
        uuid: "message-delta-first-turn",
        parent_tool_use_id: null,
        event: {
          type: "message_delta",
          delta: { stop_reason: null, stop_sequence: null },
          usage: {
            input_tokens: 100000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 12994,
            output_tokens: 0,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        duration_api_ms: 90,
        num_turns: 1,
        result: "first done",
        stop_reason: "end_turn",
        session_id: "sdk-session-stale-usage",
        usage: {
          input_tokens: 100000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 12994,
          output_tokens: 0,
          total_tokens: 112994,
          iterations: [],
        },
        modelUsage: {
          "claude-opus-4-6": { contextWindow: 1000000, maxOutputTokens: 64000 },
        },
      } as unknown as SDKMessage);
      yield* Fiber.join(firstTurnEvents);

      const secondTurnEvents = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "second", attachments: [] });
      // No message_delta or assistant snapshot is emitted for this turn. The
      // result is therefore the only current-turn active-usage reading and
      // must beat the session-wide lastKnownTokenUsage from the prior turn.
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        duration_api_ms: 90,
        num_turns: 1,
        result: "second done",
        stop_reason: "end_turn",
        session_id: "sdk-session-stale-usage",
        usage: {
          input_tokens: 200000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 10000,
          output_tokens: 5000,
          total_tokens: 215000,
          iterations: [],
        },
        modelUsage: {
          "claude-opus-4-6": { contextWindow: 1000000, maxOutputTokens: 64000 },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const events = Array.from(yield* Fiber.join(secondTurnEvents));
      const finalUsage = events.findLast((event) => event.type === "thread.token-usage.updated");
      assert.equal(finalUsage?.type, "thread.token-usage.updated");
      if (finalUsage?.type === "thread.token-usage.updated") {
        assert.equal(finalUsage.payload.usage.usedTokens, 215000);
        assert.equal(finalUsage.payload.usage.inputTokens, 210000);
        assert.equal(finalUsage.payload.usage.outputTokens, 5000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
