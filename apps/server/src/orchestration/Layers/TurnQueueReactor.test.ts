import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@forma/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { TurnQueueReactorLive } from "./TurnQueueReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { TurnQueueReactor } from "../Services/TurnQueueReactor.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const ACTIVE_TURN_ID = TurnId.make("turn-active");
const NOW = "2026-03-02T00:00:00.000Z";

async function waitFor<T>(predicate: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<T> => {
    const result = await predicate();
    if (result !== null) {
      return result;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };

  return poll();
}

describe("TurnQueueReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | TurnQueueReactor,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  let commandCounter = 0;

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

  const nextCommandId = (tag: string) => CommandId.make(`${tag}-${++commandCounter}`);

  async function createHarness(options?: { autoStart?: boolean }) {
    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "forma-turn-queue-reactor-test-",
    });
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    const layer = TurnQueueReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(TurnQueueReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));

    if (options?.autoStart !== false) {
      await runtime.runPromise(reactor.start().pipe(Scope.provide(scope)));
    }

    const dispatchBaseEntities = async () => {
      await runtime!.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: nextCommandId("project-create"),
          projectId: PROJECT_ID,
          title: "Project",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt: NOW,
        }),
      );

      await runtime!.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: nextCommandId("thread-create"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
        }),
      );
    };

    const setSession = async (
      session: {
        readonly threadId: ThreadId;
        readonly status:
          | "running"
          | "starting"
          | "ready"
          | "error"
          | "interrupted"
          | "idle"
          | "stopped";
        readonly providerName: "codex";
        readonly runtimeMode: "approval-required" | "full-access";
        readonly activeTurnId: TurnId | null;
        readonly lastError: string | null;
        readonly updatedAt: string;
      } | null,
    ) => {
      const nextSession =
        session ??
        ({
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        } as const);
      await runtime!.runPromise(
        engine.dispatch({
          type: "thread.session.set",
          commandId: nextCommandId("thread-session-set"),
          threadId: THREAD_ID,
          session: nextSession,
          createdAt: NOW,
        }),
      );
    };

    const enqueueTurn = async (messageId: string, text = `queued:${messageId}`) => {
      await runtime!.runPromise(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: nextCommandId("thread-turn-start"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make(messageId),
            role: "user",
            text,
            attachments: [],
          },
          interactionMode: "plan",
          runtimeMode: "approval-required",
          createdAt: NOW,
        }),
      );
    };

    const settleTurn = async (outcome: "completed" | "interrupted" | "error") => {
      await runtime!.runPromise(
        engine.dispatch({
          type: "thread.turn.settle",
          commandId: nextCommandId("thread-turn-settle"),
          threadId: THREAD_ID,
          turnId: ACTIVE_TURN_ID,
          outcome,
          settledAt: NOW,
          createdAt: NOW,
        }),
      );
    };

    const appendActivity = async (kind: string) => {
      await runtime!.runPromise(
        engine.dispatch({
          type: "thread.activity.append",
          commandId: nextCommandId("thread-activity-append"),
          threadId: THREAD_ID,
          activity: {
            id: EventId.make(`activity-${commandCounter}`),
            tone: "error",
            kind,
            summary: kind,
            payload: {},
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        }),
      );
    };

    const removeQueuedTurn = async (messageId: string) => {
      await runtime!.runPromise(
        engine.dispatch({
          type: "thread.turn.queue.remove",
          commandId: nextCommandId("thread-turn-queue-remove"),
          threadId: THREAD_ID,
          messageId: MessageId.make(messageId),
        }),
      );
    };

    const readThread = async () => {
      const readModel = await runtime!.runPromise(engine.getReadModel());
      return readModel.threads.find((thread) => thread.id === THREAD_ID) ?? null;
    };

    const readEvents = async () =>
      runtime!.runPromise(
        Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
      );

    return {
      engine,
      reactor,
      dispatchBaseEntities,
      setSession,
      enqueueTurn,
      settleTurn,
      appendActivity,
      removeQueuedTurn,
      readThread,
      readEvents,
      startReactor: () => runtime!.runPromise(reactor.start().pipe(Scope.provide(scope!))),
      drain: () => runtime!.runPromise(reactor.drain),
    };
  }

  it("reconciles queued threads on startup and promotes the head when idle", async () => {
    const forma = await createHarness({ autoStart: false });
    await forma.dispatchBaseEntities();
    await forma.setSession({
      threadId: THREAD_ID,
      status: "running",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: ACTIVE_TURN_ID,
      lastError: null,
      updatedAt: NOW,
    });
    await forma.enqueueTurn("queued-startup");
    await forma.setSession(null);

    await forma.startReactor();

    await waitFor(async () => {
      const events = await forma.readEvents();
      return (
        events.find(
          (event) =>
            event.type === "thread.turn-start-requested" &&
            event.payload.messageId === MessageId.make("queued-startup"),
        ) ?? null
      );
    });

    const thread = await forma.readThread();
    expect(thread?.turnQueue.items).toEqual([]);
    expect(thread?.turnQueue.status).toBe("idle");
  });

  it("promotes the next queued turn only after thread.turn-settled", async () => {
    const forma = await createHarness();
    await forma.dispatchBaseEntities();
    await forma.setSession({
      threadId: THREAD_ID,
      status: "running",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: ACTIVE_TURN_ID,
      lastError: null,
      updatedAt: NOW,
    });
    await forma.enqueueTurn("queued-after-settle");
    await forma.drain();
    await forma.setSession(null);
    await forma.drain();

    const beforeSettleEvents = await forma.readEvents();
    expect(
      beforeSettleEvents.some(
        (event) =>
          event.type === "thread.turn-start-requested" &&
          event.payload.messageId === MessageId.make("queued-after-settle"),
      ),
    ).toBe(false);

    await forma.settleTurn("completed");

    await waitFor(async () => {
      const events = await forma.readEvents();
      return (
        events.find(
          (event) =>
            event.type === "thread.turn-start-requested" &&
            event.payload.messageId === MessageId.make("queued-after-settle"),
        ) ?? null
      );
    });
  });

  it("pauses queued turns after interrupted settlement", async () => {
    const forma = await createHarness();
    await forma.dispatchBaseEntities();
    await forma.setSession({
      threadId: THREAD_ID,
      status: "running",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: ACTIVE_TURN_ID,
      lastError: null,
      updatedAt: NOW,
    });
    await forma.enqueueTurn("queued-interrupted");
    await forma.setSession(null);
    await forma.settleTurn("interrupted");

    const thread = await waitFor(async () => {
      const current = await forma.readThread();
      return current?.turnQueue.status === "paused" ? current : null;
    });

    expect(thread.turnQueue.pauseReason).toBe("interrupted");
    expect(thread.turnQueue.items.map((item) => item.messageId)).toEqual([
      MessageId.make("queued-interrupted"),
    ]);
  });

  it("pauses queued turns when provider turn start fails", async () => {
    const forma = await createHarness();
    await forma.dispatchBaseEntities();
    await forma.setSession({
      threadId: THREAD_ID,
      status: "running",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: ACTIVE_TURN_ID,
      lastError: null,
      updatedAt: NOW,
    });
    await forma.enqueueTurn("queued-provider-failure");
    await forma.setSession(null);
    await forma.appendActivity("provider.turn.start.failed");

    const thread = await waitFor(async () => {
      const current = await forma.readThread();
      return current?.turnQueue.status === "paused" ? current : null;
    });

    expect(thread.turnQueue.pauseReason).toBe("error");
    expect(thread.turnQueue.items.map((item) => item.messageId)).toEqual([
      MessageId.make("queued-provider-failure"),
    ]);
  });

  it("promotes the new head when the previous head is removed while idle", async () => {
    const forma = await createHarness();
    await forma.dispatchBaseEntities();
    await forma.setSession({
      threadId: THREAD_ID,
      status: "running",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: ACTIVE_TURN_ID,
      lastError: null,
      updatedAt: NOW,
    });
    await forma.enqueueTurn("queued-head");
    await forma.enqueueTurn("queued-next");
    await forma.setSession(null);
    await forma.removeQueuedTurn("queued-head");

    await waitFor(async () => {
      const events = await forma.readEvents();
      return (
        events.find(
          (event) =>
            event.type === "thread.turn-start-requested" &&
            event.payload.messageId === MessageId.make("queued-next"),
        ) ?? null
      );
    });

    const thread = await forma.readThread();
    expect(thread?.turnQueue.items).toEqual([]);
    expect(thread?.turnQueue.status).toBe("idle");
  });
});
