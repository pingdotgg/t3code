import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { PluginId } from "@t3tools/contracts/plugin";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  AgentsThreadOwnershipError,
  AgentsTurnAwaitTimeoutError,
  makeAgentsCapability,
} from "./AgentsCapability.ts";

const pluginId = PluginId.make("agent-plugin");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};
const createdAt = "2026-01-01T00:00:00.000Z";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-plugin-agents-test-",
});
const orchestrationLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
  ProjectionTurnRepositoryLive,
  ProjectionThreadMessageRepositoryLive,
).pipe(
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(serverConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);
const agentsIt = it.layer(orchestrationLayer);

function makeProviderRegistry() {
  const available = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "not-required" },
    checkedAt: createdAt,
    models: [{ slug: "gpt-5-codex", name: "GPT-5 Codex", isCustom: false }],
    slashCommands: [],
    skills: [],
  } as const;
  const unavailable = {
    instanceId: ProviderInstanceId.make("missing"),
    driver: "missing",
    displayName: "Missing",
    enabled: true,
    installed: false,
    version: null,
    status: "disabled",
    auth: { status: "not-required" },
    checkedAt: createdAt,
    availability: "unavailable",
    models: [],
    slashCommands: [],
    skills: [],
  } as const;
  return {
    listInstances: Effect.succeed([
      {
        snapshot: {
          getSnapshot: Effect.succeed(available),
          refresh: Effect.succeed(available),
          streamChanges: Stream.empty,
          maintenanceCapabilities: {} as any,
        },
      },
    ] as any),
    listUnavailable: Effect.succeed([unavailable] as any),
    getInstance: () => Effect.sync(() => undefined),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.die("not used"),
  } satisfies ProviderInstanceRegistry["Service"];
}

const makeCapability = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const turns = yield* ProjectionTurnRepository;
  const messages = yield* ProjectionThreadMessageRepository;
  const agents = makeAgentsCapability({
    pluginId,
    engine,
    snapshots,
    turns,
    messages,
    providerInstances: makeProviderRegistry(),
  });
  return { agents, engine, snapshots, turns, messages };
});

const createProject = (engine: OrchestrationEngineService["Service"], id = "project-agents") =>
  engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-${id}-create`),
    projectId: ProjectId.make(id),
    title: "Project",
    workspaceRoot: `/tmp/${id}`,
    defaultModelSelection: modelSelection,
    createdAt,
  });

const dispatchThreadCreate = (
  engine: OrchestrationEngineService["Service"],
  input: {
    readonly threadId: ThreadId;
    readonly owner?: "user" | `plugin:${string}`;
    readonly projectId?: ProjectId;
    readonly commandId?: string;
  },
) =>
  engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(input.commandId ?? `cmd-${input.threadId}-create`),
    threadId: input.threadId,
    projectId: input.projectId ?? ProjectId.make("project-agents"),
    title: "Thread",
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    modelSelection,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: null,
    createdAt,
  });

const dispatchAssistantCompletion = (
  engine: OrchestrationEngineService["Service"],
  input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly messageId: MessageId;
    readonly text: string;
  },
) =>
  Effect.gen(function* () {
    yield* engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: CommandId.make(`cmd-${input.messageId}-delta`),
      threadId: input.threadId,
      messageId: input.messageId,
      turnId: input.turnId,
      delta: input.text,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: CommandId.make(`cmd-${input.messageId}-complete`),
      threadId: input.threadId,
      messageId: input.messageId,
      turnId: input.turnId,
      createdAt,
    });
  });

agentsIt("AgentsCapability", (it) => {
  it.effect("createThread dispatches through orchestration and stamps plugin ownership", () =>
    Effect.gen(function* () {
      const { agents, engine, snapshots } = yield* makeCapability;
      yield* createProject(engine);

      const { threadId } = yield* agents.createThread({
        projectId: ProjectId.make("project-agents"),
        title: "Owned",
        modelSelection,
      });

      const owner = yield* snapshots.getThreadOwnerById(threadId);
      expect(Option.getOrUndefined(owner)).toBe("plugin:agent-plugin");
    }),
  );

  it.effect(
    "rejects startTurn, respond, interrupt, stop, delete, observe, and await for non-owned threads",
    () =>
      Effect.gen(function* () {
        const { agents, engine } = yield* makeCapability;
        const userThreadId = ThreadId.make("thread-user-owned");
        const otherThreadId = ThreadId.make("thread-other-plugin");
        yield* createProject(engine);
        yield* dispatchThreadCreate(engine, { threadId: userThreadId, owner: "user" });
        yield* dispatchThreadCreate(engine, {
          threadId: otherThreadId,
          owner: "plugin:other-plugin",
          commandId: "cmd-other-plugin-thread",
        });

        const checks = [
          agents.startTurn({ threadId: userThreadId, text: "hello" }),
          agents.respondToApproval({
            threadId: userThreadId,
            requestId: "request-1" as any,
            decision: "accept",
          }),
          agents.respondToUserInput({
            threadId: userThreadId,
            requestId: "request-1" as any,
            answers: {},
          }),
          agents.interruptTurn({ threadId: userThreadId }),
          agents.stopSession({ threadId: userThreadId }),
          agents.deleteThread({ threadId: userThreadId }),
          agents.observeThread(userThreadId).pipe(Stream.runCollect),
          agents.awaitTurn({
            threadId: otherThreadId,
            turnId: TurnId.make("turn-other"),
            timeout: "10 millis",
          }),
        ];

        for (const check of checks) {
          const exit = yield* Effect.exit(check);
          expect(exit._tag).toBe("Failure");
          if (exit._tag === "Failure") {
            expect(String(exit.cause)).toContain(AgentsThreadOwnershipError.name);
          }
        }
      }),
  );

  it.effect("startTurn injects ownership into bootstrap thread creation", () =>
    Effect.gen(function* () {
      const { agents, engine, snapshots } = yield* makeCapability;
      yield* createProject(engine);
      const threadId = ThreadId.make("thread-bootstrap-owned");

      yield* agents.startTurn({
        threadId,
        text: "hello",
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project-agents"),
            title: "Bootstrap",
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
          },
        },
      });

      const owner = yield* snapshots.getThreadOwnerById(threadId);
      expect(Option.getOrUndefined(owner)).toBe("plugin:agent-plugin");
    }),
  );

  it.effect("startTurn forwards caller-supplied ids and generates defaults when omitted", () =>
    Effect.gen(function* () {
      const dispatched: OrchestrationCommand[] = [];
      const agents = makeAgentsCapability({
        pluginId,
        engine: {
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
          streamDomainEvents: Stream.empty,
        },
        snapshots: {
          getThreadOwnerById: () => Effect.succeed(Option.some("plugin:agent-plugin" as any)),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
        } as any,
        turns: {} as any,
        messages: {} as any,
        providerInstances: makeProviderRegistry(),
      });
      const threadId = ThreadId.make("thread-caller-ids");
      const callerMessageId = MessageId.make("message-caller");
      const callerCommandId = CommandId.make("cmd-caller-turn-start");

      const callerResult = yield* agents.startTurn({
        threadId,
        text: "caller ids",
        messageId: callerMessageId,
        commandId: callerCommandId,
      });
      const generatedResult = yield* agents.startTurn({
        threadId,
        text: "generated ids",
      });

      const turnStarts = dispatched.filter((command) => command.type === "thread.turn.start");
      expect(callerResult.messageId).toBe(callerMessageId);
      expect(turnStarts[0]?.type).toBe("thread.turn.start");
      if (turnStarts[0]?.type === "thread.turn.start") {
        expect(turnStarts[0].commandId).toBe(callerCommandId);
        expect(turnStarts[0].message.messageId).toBe(callerMessageId);
      }
      expect(generatedResult.messageId).not.toBe(callerMessageId);
      expect(String(generatedResult.messageId)).toMatch(/^plugin-message:/);
      expect(turnStarts[1]?.type).toBe("thread.turn.start");
      if (turnStarts[1]?.type === "thread.turn.start") {
        expect(String(turnStarts[1].commandId)).toMatch(/^plugin:turn-start:/);
        expect(turnStarts[1].message.messageId).toBe(generatedResult.messageId);
      }
    }),
  );

  it.effect("startTurn re-dispatch with the same caller commandId is receipt-deduplicated", () =>
    Effect.gen(function* () {
      const { agents, engine, messages, turns } = yield* makeCapability;
      yield* createProject(engine);
      const { threadId } = yield* agents.createThread({
        projectId: ProjectId.make("project-agents"),
        title: "Dedup",
        modelSelection,
      });
      const messageId = MessageId.make("message-dedup");
      const commandId = CommandId.make("cmd-dedup-turn-start");

      yield* agents.startTurn({ threadId, text: "first", messageId, commandId });
      yield* agents.startTurn({ threadId, text: "second", messageId, commandId });

      const projectedMessages = yield* messages.listByThreadId({ threadId });
      expect(projectedMessages.filter((message) => message.messageId === messageId)).toHaveLength(
        1,
      );
      const projectedTurns = yield* turns.listByThreadId({ threadId });
      expect(projectedTurns.filter((turn) => turn.pendingMessageId === messageId)).toHaveLength(1);
    }),
  );

  it.effect("observeThread emits the owned snapshot followed by thread-detail events", () =>
    Effect.gen(function* () {
      const { agents, engine } = yield* makeCapability;
      yield* createProject(engine);
      const { threadId } = yield* agents.createThread({
        projectId: ProjectId.make("project-agents"),
        title: "Observed",
        modelSelection,
      });

      const collected = yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* agents
            .observeThread(threadId)
            .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
          yield* Effect.yieldNow;
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("cmd-plugin-observe-activity"),
            threadId,
            activity: {
              id: "event-plugin-observe-activity" as any,
              tone: "info",
              kind: "note",
              summary: "Observed",
              payload: {},
              turnId: null,
              createdAt,
            },
            createdAt,
          });
          return yield* Fiber.join(fiber);
        }),
      );

      expect(collected[0]?.kind).toBe("snapshot");
      expect(collected[1]?.kind).toBe("event");
      expect(collected[1]?.kind === "event" ? collected[1].event.type : null).toBe(
        "thread.activity-appended",
      );
    }),
  );

  it.effect(
    "awaitTurn returns already-terminal and streamed terminal turns with assistant text",
    () =>
      Effect.gen(function* () {
        const { agents, engine } = yield* makeCapability;
        yield* createProject(engine);
        const { threadId } = yield* agents.createThread({
          projectId: ProjectId.make("project-agents"),
          title: "Awaited",
          modelSelection,
        });
        const fastTurnId = TurnId.make("turn-fast");
        yield* dispatchAssistantCompletion(engine, {
          threadId,
          turnId: fastTurnId,
          messageId: MessageId.make("message-fast"),
          text: "already done",
        });

        const fastResult = yield* agents.awaitTurn({
          threadId,
          turnId: fastTurnId,
          timeout: "1 second",
        });
        expect(fastResult).toEqual({
          state: "completed",
          assistantText: "already done",
        });

        const streamedTurnId = TurnId.make("turn-streamed");
        const streamedResult = yield* Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* agents
              .awaitTurn({ threadId, turnId: streamedTurnId, timeout: "1 second" })
              .pipe(Effect.forkScoped);
            yield* Effect.yieldNow;
            yield* dispatchAssistantCompletion(engine, {
              threadId,
              turnId: streamedTurnId,
              messageId: MessageId.make("message-streamed"),
              text: "stream completed",
            });
            return yield* Fiber.join(fiber);
          }),
        );
        expect(streamedResult).toEqual({
          state: "completed",
          assistantText: "stream completed",
        });
      }),
  );

  it.effect("awaitTurn times out without interrupting the turn", () =>
    Effect.gen(function* () {
      const { agents, engine } = yield* makeCapability;
      yield* createProject(engine);
      const { threadId } = yield* agents.createThread({
        projectId: ProjectId.make("project-agents"),
        title: "Timeout",
        modelSelection,
      });

      const timeoutFiber = yield* agents
        .awaitTurn({
          threadId,
          turnId: TurnId.make("turn-never"),
          timeout: "1 millis",
        })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 millis");

      const error = yield* Fiber.join(timeoutFiber);
      expect(error).toBeInstanceOf(AgentsTurnAwaitTimeoutError);
    }),
  );

  it.effect("respond, interrupt, stop, and delete dispatch owned thread commands", () =>
    Effect.gen(function* () {
      const dispatched: OrchestrationCommand[] = [];
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const agents = makeAgentsCapability({
        pluginId,
        engine: {
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
          streamDomainEvents: Stream.fromQueue(events),
        },
        snapshots: {
          getThreadOwnerById: () => Effect.succeed(Option.some("plugin:agent-plugin" as any)),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
        } as any,
        turns: {} as any,
        messages: {} as any,
        providerInstances: makeProviderRegistry(),
      });
      const threadId = ThreadId.make("thread-owned");

      yield* Effect.all([
        agents.respondToApproval({ threadId, requestId: "approval-1" as any, decision: "accept" }),
        agents.respondToUserInput({ threadId, requestId: "input-1" as any, answers: { ok: true } }),
        agents.interruptTurn({ threadId }),
        agents.stopSession({ threadId }),
        agents.deleteThread({ threadId }),
      ]);

      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.approval.respond",
        "thread.user-input.respond",
        "thread.turn.interrupt",
        "thread.session.stop",
        "thread.delete",
      ]);
    }),
  );

  it.effect("listInstances reads available and unavailable registry entries", () =>
    Effect.gen(function* () {
      const agents = makeAgentsCapability({
        pluginId,
        engine: {
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 1 }),
          streamDomainEvents: Stream.empty,
        },
        snapshots: {} as any,
        turns: {} as any,
        messages: {} as any,
        providerInstances: makeProviderRegistry(),
      });

      const instances = yield* agents.listInstances();
      expect(instances.available[0]?.instanceId).toBe("codex");
      expect(instances.unavailable[0]?.instanceId).toBe("missing");
    }),
  );
});
