import { EventId, ProviderSessionId, ProviderThreadId, ProviderTurnId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterShape,
} from "../Services/ClaudeCodeAdapter.ts";
import { makeClaudeCodeAdapterLive } from "./ClaudeCodeAdapter.ts";

const asSessionId = (value: string): ProviderSessionId => ProviderSessionId.makeUnsafe(value);
const asTurnId = (value: string): ProviderTurnId => ProviderTurnId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);

describe("ClaudeCodeAdapterLive", () => {
  const layer = makeClaudeCodeAdapterLive();

  it.effect("returns validation error for non-claudeCode provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeCodeAdapter;
      const result = yield* adapter.startSession({ provider: "codex" }).pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.equal(result.failure._tag, "ProviderAdapterValidationError");
      if (result.failure._tag !== "ProviderAdapterValidationError") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "claudeCode",
          operation: "startSession",
          issue: "Expected provider 'claudeCode' but received 'codex'.",
        }),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("returns typed process error when runtime is not configured", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeCodeAdapter;
      const result = yield* adapter.startSession({ provider: "claudeCode" }).pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.equal(result.failure._tag, "ProviderAdapterProcessError");
      if (result.failure._tag !== "ProviderAdapterProcessError") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterProcessError({
          provider: "claudeCode",
          sessionId: "pending",
          detail: "Claude Code runtime is not configured.",
        }),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("returns typed request errors for turn operations when runtime is not configured", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeCodeAdapter;
      const result = yield* adapter
        .sendTurn({
          sessionId: asSessionId("claude-sess-1"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.equal(result.failure._tag, "ProviderAdapterRequestError");
      if (result.failure._tag !== "ProviderAdapterRequestError") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterRequestError({
          provider: "claudeCode",
          method: "turn/start",
          detail: "Claude Code runtime is not configured. (session claude-sess-1)",
        }),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("emits no runtime events by default", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeCodeAdapter;
      const firstEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(firstEvent._tag, "None");
    }).pipe(Effect.provide(layer)),
  );
});

describe("ClaudeCodeAdapter mocked layer", () => {
  it.effect("supports replacing the adapter layer directly in tests", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeCodeAdapter;
      const started = yield* adapter.startSession({ provider: "claudeCode" });
      assert.equal(started.sessionId, "mock-sess-1");
      const event = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(event._tag, "Some");
    }).pipe(
      Effect.provide(
        Layer.succeed(ClaudeCodeAdapter, {
          provider: "claudeCode",
          startSession: () =>
            Effect.succeed({
              sessionId: asSessionId("mock-sess-1"),
              provider: "claudeCode",
              status: "ready",
              threadId: ProviderThreadId.makeUnsafe("mock-thread-1"),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }),
          sendTurn: () =>
            Effect.succeed({
              threadId: ProviderThreadId.makeUnsafe("mock-thread-1"),
              turnId: asTurnId("mock-turn-1"),
            }),
          interruptTurn: () => Effect.void,
          readThread: () =>
            Effect.succeed({
              threadId: ProviderThreadId.makeUnsafe("mock-thread-1"),
              turns: [],
            }),
          rollbackThread: () =>
            Effect.succeed({
              threadId: ProviderThreadId.makeUnsafe("mock-thread-1"),
              turns: [],
            }),
          respondToRequest: () => Effect.void,
          stopSession: () => Effect.void,
          listSessions: () => Effect.succeed([]),
          hasSession: () => Effect.succeed(false),
          stopAll: () => Effect.void,
          streamEvents: Stream.make({
            type: "turn.completed",
            eventId: asEventId("evt-mock-1"),
            provider: "claudeCode",
            sessionId: asSessionId("mock-sess-1"),
            createdAt: new Date().toISOString(),
            threadId: ProviderThreadId.makeUnsafe("mock-thread-1"),
            turnId: asTurnId("mock-turn-1"),
            status: "completed",
          }),
        } satisfies ClaudeCodeAdapterShape),
      ),
    ),
  );
});
