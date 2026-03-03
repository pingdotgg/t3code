import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import {
  CommandId,
  EventId,
  MessageId,
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
import { ServerConfig } from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asSessionId = (value: string): ProviderSessionId => ProviderSessionId.makeUnsafe(value);
const asProviderThreadId = (value: string): ProviderThreadId => ProviderThreadId.makeUnsafe(value);
const asProviderTurnId = (value: string): ProviderTurnId => ProviderTurnId.makeUnsafe(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);

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
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
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
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
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
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
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

  it("does not clear active turn when session/thread started arrives mid-turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-midturn-lifecycle"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      threadId: asProviderThreadId("provider-thread-1"),
      turnId: asProviderTurnId("turn-midturn-lifecycle"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-midturn-lifecycle",
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-midturn-lifecycle"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      threadId: asProviderThreadId("provider-thread-1"),
    });
    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-midturn-lifecycle"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      threadId: asProviderThreadId("provider-thread-1"),
    });

    await Effect.runPromise(Effect.sleep("40 millis"));
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-midturn-lifecycle");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-midturn-lifecycle"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      threadId: asProviderThreadId("provider-thread-1"),
      turnId: asProviderTurnId("turn-midturn-lifecycle"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores auxiliary turn completions from a different provider thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-primary"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      threadId: asProviderThreadId("provider-thread-1"),
      turnId: asProviderTurnId("turn-primary"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-aux"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      threadId: asProviderThreadId("provider-thread-aux"),
      turnId: asProviderTurnId("turn-aux"),
      status: "completed",
    });

    await Effect.runPromise(Effect.sleep("40 millis"));
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-primary");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-primary"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      threadId: asProviderThreadId("provider-thread-1"),
      turnId: asProviderTurnId("turn-primary"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("accepts claude turn lifecycle when seeded thread id is a synthetic placeholder", async () => {
    const harness = await createHarness();
    const seededAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed-claude-placeholder"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeCode",
          providerSessionId: asSessionId("sess-1"),
          providerThreadId: asProviderThreadId("claude-thread-placeholder"),
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-claude-placeholder"),
      provider: "claudeCode",
      sessionId: asSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      threadId: asProviderThreadId("provider-thread-real"),
      turnId: asProviderTurnId("turn-claude-placeholder"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-claude-placeholder",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-claude-placeholder"),
      provider: "claudeCode",
      sessionId: asSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      threadId: asProviderThreadId("provider-thread-real"),
      turnId: asProviderTurnId("turn-claude-placeholder"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores non-active turn completion when runtime omits thread id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-guarded"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-guarded-main"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-guarded-main",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-other"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      turnId: asProviderTurnId("turn-guarded-other"),
      status: "completed",
    });

    await Effect.runPromise(Effect.sleep("40 millis"));
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-guarded-main");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-main"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      turnId: asProviderTurnId("turn-guarded-main"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("maps canonical content delta/item completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some((message) => message.id === "assistant:item-1" && !message.streaming),
    );
    const message = thread.messages.find((entry) => entry.id === "assistant:item-1");
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("uses assistant item completion detail when no assistant deltas were streamed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-item-completed-no-delta"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-no-delta"),
      itemId: asItemId("item-no-delta"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "assistant-only final text",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some((message) => message.id === "assistant:item-no-delta" && !message.streaming),
    );
    const message = thread.messages.find((entry) => entry.id === "assistant:item-no-delta");
    expect(message?.text).toBe("assistant-only final text");
    expect(message?.streaming).toBe(false);
  });

  it("buffers assistant deltas by default until completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-buffered"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-buffered",
    );

    harness.emit({
      type: "message.delta",
      eventId: asEventId("evt-message-delta-buffered"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      delta: "buffer me",
    });

    await Effect.runPromise(Effect.sleep("30 millis"));
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.messages.some((message) => message.id === "assistant:item-buffered")).toBe(
      false,
    );

    harness.emit({
      type: "message.completed",
      eventId: asEventId("evt-message-completed-buffered"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message) => message.id === "assistant:item-buffered" && !message.streaming,
      ),
    );
    const message = thread.messages.find((entry) => entry.id === "assistant:item-buffered");
    expect(message?.text).toBe("buffer me");
    expect(message?.streaming).toBe(false);
  });

  it("streams assistant deltas when thread.turn.start requests streaming mode", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        createdAt: now,
      }),
    );
    await Effect.runPromise(Effect.sleep("30 millis"));

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-mode"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-streaming-mode"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-mode",
    );

    harness.emit({
      type: "message.delta",
      eventId: asEventId("evt-message-delta-streaming-mode"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      delta: "hello live",
    });

    const liveThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message) =>
          message.id === "assistant:item-streaming-mode" &&
          message.streaming &&
          message.text === "hello live",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (entry) => entry.id === "assistant:item-streaming-mode",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "message.completed",
      eventId: asEventId("evt-message-completed-streaming-mode"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
    });

    const finalThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message) => message.id === "assistant:item-streaming-mode" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (entry) => entry.id === "assistant:item-streaming-mode",
    );
    expect(finalMessage?.text).toBe("hello live");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("spills oversized buffered deltas and still finalizes full assistant text", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const oversizedText = "x".repeat(40_000);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffer-spill"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-buffer-spill"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffer-spill",
    );

    harness.emit({
      type: "message.delta",
      eventId: asEventId("evt-message-delta-buffer-spill"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      delta: oversizedText,
    });
    harness.emit({
      type: "message.completed",
      eventId: asEventId("evt-message-completed-buffer-spill"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message) => message.id === "assistant:item-buffer-spill" && !message.streaming,
      ),
    );
    const message = thread.messages.find((entry) => entry.id === "assistant:item-buffer-spill");
    expect(message?.text.length).toBe(oversizedText.length);
    expect(message?.text).toBe(oversizedText);
    expect(message?.streaming).toBe(false);
  });

  it("does not duplicate assistant completion when message.completed is followed by turn.completed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-for-complete-dedup"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-complete-dedup"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-complete-dedup",
    );

    harness.emit({
      type: "message.delta",
      eventId: asEventId("evt-message-delta-for-complete-dedup"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      delta: "done",
    });
    harness.emit({
      type: "message.completed",
      eventId: asEventId("evt-message-completed-for-complete-dedup"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-for-complete-dedup"),
      provider: "codex",
      sessionId: asSessionId("sess-1"),
      createdAt: now,
      turnId: asProviderTurnId("turn-complete-dedup"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message) => message.id === "assistant:item-complete-dedup" && !message.streaming,
        ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const completionEvents = events.filter((event) => {
      if (event.type !== "thread.message-sent") {
        return false;
      }
      return (
        event.payload.messageId === "assistant:item-complete-dedup" &&
        event.payload.streaming === false
      );
    });
    expect(completionEvents).toHaveLength(1);
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
