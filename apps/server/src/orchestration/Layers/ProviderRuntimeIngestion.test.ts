import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const getCheckpointDiff = vi.fn(
    (input: { sessionId: string; fromTurnCount: number; toTurnCount: number }) =>
      Effect.succeed({
        threadId: "thread-1",
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff: "",
      }),
  );

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([]),
    listCheckpoints: () => unsupported(),
    getCheckpointDiff,
    revertToCheckpoint: () => unsupported(),
    stopAll: () => Effect.void,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const emit = (event: ProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event));
  };

  return {
    service,
    emit,
    getCheckpointDiff,
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: {
    session: { status: string; activeTurnId: string | null; lastError: string | null } | null;
    messages: ReadonlyArray<{ id: string; text: string; streaming: boolean }>;
  }) => boolean,
  timeoutMs = 2000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<{
    session: { status: string; activeTurnId: string | null; lastError: string | null } | null;
    messages: ReadonlyArray<{ id: string; text: string; streaming: boolean }>;
  }> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === "thread-1");
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

describe("ProviderRuntimeIngestion", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderRuntimeIngestionService,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  async function createHarness() {
    const provider = createProviderServiceHarness();
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(ingestion.start.pipe(Scope.provide(scope)));
    await Effect.runPromise(Effect.sleep("10 millis"));

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: "cmd-thread-create",
        threadId: "thread-1",
        projectId: "project-1",
        title: "Thread",
        model: "gpt-5-codex",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session",
        commandId: "cmd-session-seed",
        threadId: "thread-1",
        session: {
          sessionId: "sess-1",
          provider: "codex",
          status: "ready",
          threadId: "thread-1",
          activeTurnId: null,
          createdAt,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    return {
      engine,
      emit: provider.emit,
    };
  }

  it("maps turn started/completed events into thread session updates", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: "evt-turn-started",
      provider: "codex",
      sessionId: "sess-1",
      createdAt: now,
      turnId: "turn-1",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: "evt-turn-completed",
      provider: "codex",
      sessionId: "sess-1",
      createdAt: new Date().toISOString(),
      turnId: "turn-1",
      status: "failed",
      errorMessage: "turn failed",
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed",
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.lastError).toBe("turn failed");
  });

  it("maps message delta/completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "message.delta",
      eventId: "evt-message-delta-1",
      provider: "codex",
      sessionId: "sess-1",
      createdAt: now,
      turnId: "turn-2",
      itemId: "item-1",
      delta: "hello",
    });
    harness.emit({
      type: "message.delta",
      eventId: "evt-message-delta-2",
      provider: "codex",
      sessionId: "sess-1",
      createdAt: now,
      turnId: "turn-2",
      itemId: "item-1",
      delta: " world",
    });
    harness.emit({
      type: "message.completed",
      eventId: "evt-message-completed",
      provider: "codex",
      sessionId: "sess-1",
      createdAt: now,
      turnId: "turn-2",
      itemId: "item-1",
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some((message) => message.id === "assistant:item-1" && !message.streaming),
    );
    const message = thread.messages.find((entry) => entry.id === "assistant:item-1");
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("maps runtime.error into errored session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "runtime.error",
      eventId: "evt-runtime-error",
      provider: "codex",
      sessionId: "sess-1",
      createdAt: now,
      turnId: "turn-3",
      message: "runtime exploded",
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-3" &&
        entry.session?.lastError === "runtime exploded",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime exploded");
  });
});
