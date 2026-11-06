import { MessageId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as GracefulShutdownGate from "./GracefulShutdownGate.ts";

const layer = GracefulShutdownGate.layer;

it.layer(layer)("GracefulShutdownGate", (it) => {
  it.effect("queues new turns while draining, except privileged save-work messages", () =>
    Effect.gen(function* () {
      const gate = yield* GracefulShutdownGate.GracefulShutdownGate;
      const saveMessageId = MessageId.make("message:graceful-shutdown-save:test:thread-1");
      const threadId = ThreadId.make("thread-1");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const providerSessionId = ProviderSessionId.make("session-1");

      assert.isFalse(
        yield* gate.shouldQueueNewTurns({
          threadId,
          providerInstanceId,
          providerSessionIds: [providerSessionId],
        }),
      );

      yield* gate.setState({
        phase: "draining",
        shutdownId: "shutdown-1",
        scope: { type: "environment" },
        reason: "test",
        startedAt: "2026-01-01T00:00:00.000Z",
        deadlineAt: "2026-01-01T00:02:00.000Z",
        saveWorkPrompted: true,
        saveWorkMessageIds: new Set([saveMessageId]),
        saveWorkThreadIds: new Set([threadId]),
      });

      assert.isTrue(
        yield* gate.shouldQueueNewTurns({
          threadId,
          providerInstanceId,
          providerSessionIds: [providerSessionId],
        }),
      );
      assert.isFalse(
        yield* gate.shouldQueueNewTurns({
          threadId,
          providerInstanceId,
          providerSessionIds: [providerSessionId],
          messageId: saveMessageId,
        }),
      );

      yield* gate.setState({
        phase: "draining",
        shutdownId: "shutdown-1",
        scope: { type: "provider", providerInstanceId },
        reason: "test",
        startedAt: "2026-01-01T00:00:00.000Z",
        deadlineAt: "2026-01-01T00:02:00.000Z",
        saveWorkPrompted: false,
        saveWorkMessageIds: new Set(),
        saveWorkThreadIds: new Set(),
      });
      assert.isTrue(
        yield* gate.shouldQueueNewTurns({
          threadId,
          providerInstanceId,
          providerSessionIds: [providerSessionId],
        }),
      );
      assert.isFalse(
        yield* gate.shouldQueueNewTurns({
          threadId,
          providerInstanceId: ProviderInstanceId.make("claude"),
          providerSessionIds: [],
        }),
      );

      yield* gate.clear;
      assert.isFalse(
        yield* gate.shouldQueueNewTurns({
          threadId,
          providerInstanceId,
          providerSessionIds: [providerSessionId],
        }),
      );
    }),
  );

  it.effect("scopes session drains to the named provider session", () =>
    Effect.gen(function* () {
      const gate = yield* GracefulShutdownGate.GracefulShutdownGate;
      const providerSessionId = ProviderSessionId.make("session-target");
      yield* gate.setState({
        phase: "quiesced",
        shutdownId: "shutdown-2",
        scope: { type: "session", providerSessionId },
        reason: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        deadlineAt: "2026-01-01T00:02:00.000Z",
        saveWorkPrompted: false,
        saveWorkMessageIds: new Set(),
        saveWorkThreadIds: new Set(),
      });

      assert.isTrue(
        yield* gate.shouldQueueNewTurns({
          threadId: ThreadId.make("thread-a"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionIds: [providerSessionId],
        }),
      );
      assert.isFalse(
        yield* gate.shouldQueueNewTurns({
          threadId: ThreadId.make("thread-b"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionIds: [ProviderSessionId.make("session-other")],
        }),
      );
    }),
  );

  it.effect("tryBegin admits only one concurrent drain", () =>
    Effect.gen(function* () {
      const gate = yield* GracefulShutdownGate.GracefulShutdownGate;
      yield* gate.clear;
      const first = {
        phase: "draining" as const,
        shutdownId: "shutdown-first",
        scope: { type: "environment" as const },
        reason: "first",
        startedAt: "2026-01-01T00:00:00.000Z",
        deadlineAt: "2026-01-01T00:02:00.000Z",
        saveWorkPrompted: false,
        saveWorkMessageIds: new Set<MessageId>(),
        saveWorkThreadIds: new Set<ThreadId>(),
      };
      const second = {
        ...first,
        shutdownId: "shutdown-second",
        reason: "second",
      };

      assert.isTrue(yield* gate.tryBegin(first));
      assert.isFalse(yield* gate.tryBegin(second));
      assert.strictEqual((yield* gate.getState).shutdownId, "shutdown-first");

      yield* gate.clear;
      assert.isTrue(yield* gate.tryBegin(second));
      assert.strictEqual((yield* gate.getState).shutdownId, "shutdown-second");
    }),
  );
});
