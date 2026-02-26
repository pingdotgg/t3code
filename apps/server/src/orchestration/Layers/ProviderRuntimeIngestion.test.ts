import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderItemId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asSessionId = (value: string): ProviderSessionId => ProviderSessionId.makeUnsafe(value);
const asProviderTurnId = (value: string): ProviderTurnId => ProviderTurnId.makeUnsafe(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([]),
    rollbackConversation: () => unsupported(),
    stopAll: () => Effect.void,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const emit = (event: ProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event));
  };

  return {
    service,
    emit,
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: {
    session: { status: string; activeTurnId: string | null; lastError: string | null } | null;
    messages: ReadonlyArray<{ id: string; text: string; streaming: boolean }>;
    activities: ReadonlyArray<{ kind: string }>;
  }) => boolean,
  timeoutMs = 2000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<{
    session: { status: string; activeTurnId: string | null; lastError: string | null } | null;
    messages: ReadonlyArray<{ id: string; text: string; streaming: boolean }>;
    activities: ReadonlyArray<{ kind: string }>;
  }> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
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
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
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
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-provider-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        model: "gpt-5-codex",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          providerSessionId: asSessionId("sess-1"),
          providerThreadId: ProviderThreadId.makeUnsafe("provider-thread-1"),
          activeTurnId: null,
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
      eventId: asEventId("evt-turn-started"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-1"),
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      turnId: asProviderTurnId("turn-1"),
      status: "failed",
      errorMessage: "turn failed",
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("turn failed");
  });

  it("maps message delta/completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "message.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-2"),
      itemId: asItemId("item-1"),
      delta: "hello",
    });
    harness.emit({
      type: "message.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-2"),
      itemId: asItemId("item-1"),
      delta: " world",
    });
    harness.emit({
      type: "message.completed",
      eventId: asEventId("evt-message-completed"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-2"),
      itemId: asItemId("item-1"),
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
      eventId: asEventId("evt-runtime-error"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-3"),
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

  it("maps session/thread lifecycle and tool.started into session/activity projections", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      threadId: ProviderThreadId.makeUnsafe("provider-thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      threadId: ProviderThreadId.makeUnsafe("provider-thread-2"),
    });
    harness.emit({
      type: "tool.started",
      eventId: asEventId("evt-tool-started"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-9"),
      toolKind: "other",
      title: "Read file",
      detail: "/tmp/file.ts",
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.activities.some((activity) => activity.kind === "tool.started"),
    );

    expect(thread.session?.status).toBe("ready");
    expect(thread.activities.some((activity) => activity.kind === "tool.started")).toBe(true);
  });

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "message.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-invalid"),
      itemId: asItemId("item-invalid"),
      delta: undefined,
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      turnId: asProviderTurnId("turn-after-failure"),
      message: "runtime still processed",
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-after-failure" &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });
});
