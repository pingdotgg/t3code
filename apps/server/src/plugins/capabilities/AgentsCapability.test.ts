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
  AgentsBootstrapUnsupportedError,
  AgentsInvalidTimeoutError,
  AgentsThreadNotFoundError,
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

  it.effect(
    "two overlapping startTurns with the same commandId on an absent thread create it once and both succeed",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const realSnapshots = yield* ProjectionSnapshotQuery;
        const turns = yield* ProjectionTurnRepository;
        const messages = yield* ProjectionThreadMessageRepository;
        yield* createProject(engine);

        const threadId = ThreadId.make("thread-bootstrap-race");
        const commandId = CommandId.make("cmd-bootstrap-race-turn-start");

        // Both concurrent calls read ownership BEFORE either bootstrap create
        // commits, so both take the create-thread branch. Pinning the mock to
        // "absent" holds that race window open deterministically, so the
        // colliding second create is exercised on every run rather than only
        // under an unlucky interleaving. Dispatch itself hits the real engine.
        const agents = makeAgentsCapability({
          pluginId,
          engine,
          snapshots: {
            getThreadOwnerById: () => Effect.succeed(Option.none()),
            getThreadDetailById: () => Effect.succeed(Option.none()),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          } as any,
          turns,
          messages,
          providerInstances: makeProviderRegistry(),
        });

        const bootstrap = {
          createThread: {
            projectId: ProjectId.make("project-agents"),
            title: "Raced",
            modelSelection,
            runtimeMode: "approval-required" as const,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
          },
        };

        // With a per-call RANDOM bootstrap create commandId the losing create
        // hits requireThreadAbsent (the thread now exists) and the second
        // startTurn fails — violating the commandId idempotency contract. A
        // deterministic bootstrap commandId dedups the create instead.
        const [first, second] = yield* Effect.all(
          [
            agents.startTurn({ threadId, text: "first", commandId, bootstrap }),
            agents.startTurn({ threadId, text: "second", commandId, bootstrap }),
          ],
          { concurrency: 2 },
        );

        expect(second.turnId).toBe(first.turnId);
        expect(second.messageId).toBe(first.messageId);

        // The thread was created exactly once and is plugin-owned (verified via
        // the REAL projection, not the pinned mock).
        const owner = yield* realSnapshots.getThreadOwnerById(threadId);
        expect(Option.getOrUndefined(owner)).toBe("plugin:agent-plugin");

        // Exactly one turn.start persisted — the shared caller commandId deduped it.
        const projectedTurns = yield* turns.listByThreadId({ threadId });
        expect(projectedTurns).toHaveLength(1);
      }),
  );

  it.effect(
    "startTurn derives stable turnId/messageId from a repeated commandId and random ids without one",
    () =>
      Effect.gen(function* () {
        const dispatched: OrchestrationCommand[] = [];
        const turnAliases = new Map<
          string,
          { readonly threadId: ThreadId; readonly messageId: MessageId; readonly terminal: boolean }
        >();
        const agents = makeAgentsCapability(
          {
            pluginId,
            engine: {
              readEvents: () => Stream.empty,
              dispatch: (command: OrchestrationCommand) =>
                Effect.sync(() => {
                  dispatched.push(command);
                  return { sequence: dispatched.length };
                }),
              streamDomainEvents: Stream.empty,
            } as unknown as OrchestrationEngineService["Service"],
            snapshots: {
              getThreadOwnerById: () => Effect.succeed(Option.some("plugin:agent-plugin" as any)),
              getThreadDetailById: () => Effect.succeed(Option.none()),
              getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            } as any,
            turns: {} as any,
            messages: {} as any,
            providerInstances: makeProviderRegistry(),
          },
          turnAliases,
        );
        const threadId = ThreadId.make("thread-idempotent-ids");
        const commandId = CommandId.make("cmd-idempotent-turn-start");

        // Same commandId, NO messageId: both turnId and messageId must be derived
        // deterministically from the commandId, so a retry (which the engine
        // receipt-dedups back to the first turn) returns the SAME identifiers the
        // first dispatch persisted instead of a fresh, never-persisted pair.
        const first = yield* agents.startTurn({ threadId, text: "first", commandId });
        const second = yield* agents.startTurn({ threadId, text: "second", commandId });
        expect(second.turnId).toBe(first.turnId);
        expect(second.messageId).toBe(first.messageId);

        // The alias registered under that stable turnId points at the same
        // messageId the turn.start actually dispatched, so a later readTerminalTurn
        // correlates (turnId -> alias.messageId -> pendingMessageId) rather than
        // dangling.
        expect(turnAliases.get(String(first.turnId))?.messageId).toBe(first.messageId);
        const firstTurnStart = dispatched.find((command) => command.type === "thread.turn.start");
        expect(
          firstTurnStart?.type === "thread.turn.start" ? firstTurnStart.message.messageId : null,
        ).toBe(first.messageId);

        // No commandId: ids are freshly minted, so two calls differ.
        const withoutA = yield* agents.startTurn({ threadId, text: "a" });
        const withoutB = yield* agents.startTurn({ threadId, text: "b" });
        expect(withoutB.turnId).not.toBe(withoutA.turnId);
        expect(withoutB.messageId).not.toBe(withoutA.messageId);
      }),
  );

  it.effect(
    "a retried startTurn keeps one persisted turn whose pendingMessageId matches the returned ids",
    () =>
      Effect.gen(function* () {
        const { agents, engine, turns } = yield* makeCapability;
        yield* createProject(engine);
        const { threadId } = yield* agents.createThread({
          projectId: ProjectId.make("project-agents"),
          title: "Idempotent",
          modelSelection,
        });
        const commandId = CommandId.make("cmd-idempotent-await-turn-start");

        // Retry with the same caller commandId and no messageId: stable ids across
        // the receipt-deduped retry.
        const first = yield* agents.startTurn({ threadId, text: "first", commandId });
        const second = yield* agents.startTurn({ threadId, text: "second", commandId });
        expect(second.turnId).toBe(first.turnId);
        expect(second.messageId).toBe(first.messageId);

        // The engine deduped the retry, so exactly one turn is persisted, and its
        // pendingMessageId equals the returned (derived) messageId. That equality
        // is precisely what readTerminalTurn correlates on (turnId -> alias
        // messageId -> pendingMessageId), so the retry's alias resolves rather than
        // dangling. With random ids the retry would have returned a fresh messageId
        // absent from this row, leaving awaitTurn to time out.
        const persisted = (yield* turns.listByThreadId({ threadId })).filter(
          (row) => row.pendingMessageId === first.messageId,
        );
        expect(persisted).toHaveLength(1);
      }),
  );

  it.effect("observeThread emits the owned snapshot followed by newer thread-detail events", () =>
    Effect.gen(function* () {
      const { agents, engine } = yield* makeCapability;
      yield* createProject(engine);
      const { threadId } = yield* agents.createThread({
        projectId: ProjectId.make("project-agents"),
        title: "Observed",
        modelSelection,
      });

      const [snapshotItem, eventItem] = yield* Effect.scoped(
        Effect.gen(function* () {
          const items = yield* Queue.unbounded<any>();
          yield* agents.observeThread(threadId).pipe(
            Stream.runForEach((item) => Queue.offer(items, item)),
            Effect.forkScoped,
          );
          // The snapshot is emitted first. observeThread subscribes to the live
          // stream BEFORE reading the snapshot, so an activity dispatched only
          // AFTER we have received the snapshot is guaranteed to be strictly
          // newer than snapshotSequence and delivered (not filtered as a
          // snapshot-duplicate).
          const snapshot = yield* Queue.take(items);
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
          const event = yield* Queue.take(items);
          return [snapshot, event] as const;
        }),
      );

      expect(snapshotItem?.kind).toBe("snapshot");
      expect(eventItem?.kind).toBe("event");
      expect(eventItem?.kind === "event" ? eventItem.event.type : null).toBe(
        "thread.activity-appended",
      );
    }),
  );

  it.effect("observeThread does not re-emit events already contained in the snapshot", () =>
    Effect.gen(function* () {
      const { agents, engine } = yield* makeCapability;
      yield* createProject(engine);
      const { threadId } = yield* agents.createThread({
        projectId: ProjectId.make("project-agents"),
        title: "Observed",
        modelSelection,
      });
      // Append an activity and let it project BEFORE observing, so the snapshot
      // already contains it. It must NOT be re-emitted as a live event.
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-plugin-observe-preexisting"),
        threadId,
        activity: {
          id: "event-plugin-observe-preexisting" as any,
          tone: "info",
          kind: "note",
          summary: "Already in snapshot",
          payload: {},
          turnId: null,
          createdAt,
        },
        createdAt,
      });

      const [first, second] = yield* Effect.scoped(
        Effect.gen(function* () {
          const items = yield* Queue.unbounded<any>();
          yield* agents.observeThread(threadId).pipe(
            Stream.runForEach((item) => Queue.offer(items, item)),
            Effect.forkScoped,
          );
          const snapshot = yield* Queue.take(items);
          // Dispatch a strictly-newer activity; the observed live element must be
          // this one, proving the pre-existing (snapshot) activity was deduped.
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("cmd-plugin-observe-newer"),
            threadId,
            activity: {
              id: "event-plugin-observe-newer" as any,
              tone: "info",
              kind: "note",
              summary: "Newer",
              payload: {},
              turnId: null,
              createdAt,
            },
            createdAt,
          });
          const live = yield* Queue.take(items);
          return [snapshot, live] as const;
        }),
      );

      expect(first?.kind).toBe("snapshot");
      // The only live event delivered is the newer one; the pre-existing
      // activity (sequence <= snapshotSequence) was filtered out as a duplicate.
      expect(second?.kind).toBe("event");
      const liveActivityId =
        second?.kind === "event" && second.event.type === "thread.activity-appended"
          ? second.event.payload.activity.id
          : null;
      expect(liveActivityId).toBe("event-plugin-observe-newer");
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

  it.effect(
    "guarded methods fail not-found for a missing thread and ownership for another plugin's thread",
    () =>
      Effect.gen(function* () {
        const { agents, engine } = yield* makeCapability;
        yield* createProject(engine);
        const otherThreadId = ThreadId.make("thread-owned-by-other");
        yield* dispatchThreadCreate(engine, {
          threadId: otherThreadId,
          owner: "plugin:other-plugin",
          commandId: "cmd-m4-other-thread",
        });

        // A thread that does not exist fails not-found, NOT ownership: the
        // not-found branch in the guard must be reachable.
        const missingExit = yield* Effect.exit(
          agents.observeThread(ThreadId.make("thread-m4-missing")).pipe(Stream.runCollect),
        );
        expect(missingExit._tag).toBe("Failure");
        if (missingExit._tag === "Failure") {
          expect(String(missingExit.cause)).toContain(AgentsThreadNotFoundError.name);
          expect(String(missingExit.cause)).not.toContain(AgentsThreadOwnershipError.name);
        }

        // A thread owned by a different plugin still fails ownership (guard intact).
        const ownedExit = yield* Effect.exit(
          agents.awaitTurn({
            threadId: otherThreadId,
            turnId: TurnId.make("turn-m4"),
            timeout: "10 millis",
          }),
        );
        expect(ownedExit._tag).toBe("Failure");
        if (ownedExit._tag === "Failure") {
          expect(String(ownedExit.cause)).toContain(AgentsThreadOwnershipError.name);
        }
      }),
  );

  it.effect("startTurn rejects the inert prepareWorktree/runSetupScript bootstrap prep", () =>
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
          // Thread does not exist yet — the path that used to forward prep.
          getThreadOwnerById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
        } as any,
        turns: {} as any,
        messages: {} as any,
        providerInstances: makeProviderRegistry(),
      });
      const threadId = ThreadId.make("thread-bootstrap-prep");

      // The engine command plane ignores prepareWorktree/runSetupScript (only
      // ws.ts honors them), so forwarding them would be a silent no-op. The
      // capability now fails typed BEFORE dispatching anything — including the
      // thread.create it would otherwise emit for a new thread.
      const exit = yield* Effect.exit(
        agents.startTurn({
          threadId,
          text: "bootstrap prep",
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
            prepareWorktree: { projectCwd: "/tmp/project-agents", baseBranch: "main" },
            runSetupScript: true,
          },
        }),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain(AgentsBootstrapUnsupportedError.name);
      }
      // Nothing was dispatched — the rejection precedes the thread.create.
      expect(dispatched).toHaveLength(0);
    }),
  );

  it.effect("startTurn still accepts a bootstrap that only creates the thread", () =>
    Effect.gen(function* () {
      const { agents, engine, snapshots } = yield* makeCapability;
      yield* createProject(engine);
      const threadId = ThreadId.make("thread-bootstrap-create-only");

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

  it.effect("startTurn deletes the pending alias when a start on an existing thread fails", () =>
    Effect.gen(function* () {
      const turnAliases = new Map<
        string,
        { readonly threadId: ThreadId; readonly messageId: MessageId; readonly terminal: boolean }
      >();
      const agents = makeAgentsCapability(
        {
          pluginId,
          engine: {
            readEvents: () => Stream.empty,
            dispatch: (command: OrchestrationCommand) =>
              command.type === "thread.turn.start"
                ? Effect.fail({ _tag: "SimulatedDispatchFailure" as const })
                : Effect.succeed({ sequence: 1 }),
            streamDomainEvents: Stream.empty,
          } as unknown as OrchestrationEngineService["Service"],
          snapshots: {
            // Existing, owned thread -> createdThread is false; a failed turn
            // start must still remove the alias set before dispatch.
            getThreadOwnerById: () => Effect.succeed(Option.some("plugin:agent-plugin" as any)),
            getThreadDetailById: () => Effect.succeed(Option.none()),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          } as any,
          turns: {} as any,
          messages: {} as any,
          providerInstances: makeProviderRegistry(),
        },
        turnAliases,
      );
      const threadId = ThreadId.make("thread-existing-owned");

      const exit = yield* Effect.exit(agents.startTurn({ threadId, text: "will fail" }));
      expect(exit._tag).toBe("Failure");
      // A failed start on an existing thread must not leak its pending alias;
      // repeated failed starts would otherwise grow this map for the plugin
      // process lifetime.
      expect(turnAliases.size).toBe(0);
    }),
  );

  it.effect("startTurn evicts the oldest alias when turnAliases reaches its cap", () =>
    Effect.gen(function* () {
      const turnAliases = new Map<
        string,
        { readonly threadId: ThreadId; readonly messageId: MessageId; readonly terminal: boolean }
      >();
      const agents = makeAgentsCapability(
        {
          pluginId,
          engine: {
            readEvents: () => Stream.empty,
            // Every start succeeds, so the alias is kept (not rolled back), and
            // three un-awaited turns accumulate against the cap of 2.
            dispatch: () => Effect.succeed({ sequence: 1 }),
            streamDomainEvents: Stream.empty,
          } as unknown as OrchestrationEngineService["Service"],
          snapshots: {
            // Existing, owned thread -> startTurn dispatches turn.start directly.
            getThreadOwnerById: () => Effect.succeed(Option.some("plugin:agent-plugin" as any)),
            getThreadDetailById: () => Effect.succeed(Option.none()),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          } as any,
          turns: {} as any,
          messages: {} as any,
          providerInstances: makeProviderRegistry(),
        },
        turnAliases,
        2,
      );
      const threadId = ThreadId.make("thread-cap");

      // Three un-awaited starts; none is pruned by a terminal read, so the FIFO
      // cap is what bounds the map.
      const first = yield* agents.startTurn({ threadId, text: "one" });
      const second = yield* agents.startTurn({ threadId, text: "two" });
      const third = yield* agents.startTurn({ threadId, text: "three" });

      // The map is bounded at the cap; the oldest alias was evicted and the two
      // most-recent turns are retained.
      expect(turnAliases.size).toBeLessThanOrEqual(2);
      expect(turnAliases.has(String(first.turnId))).toBe(false);
      expect(turnAliases.has(String(second.turnId))).toBe(true);
      expect(turnAliases.has(String(third.turnId))).toBe(true);
    }),
  );

  it.effect("the cap evicts an already-terminal alias before a still-pending one", () =>
    Effect.gen(function* () {
      const turnAliases = new Map<
        string,
        { readonly threadId: ThreadId; readonly messageId: MessageId; readonly terminal: boolean }
      >();
      const threadId = ThreadId.make("thread-cap-terminal");
      // getByTurnId resolves terminal ONLY for turnIds we mark below; every
      // start otherwise leaves its alias pending.
      const terminalTurnIds = new Set<string>();
      const agents = makeAgentsCapability(
        {
          pluginId,
          engine: {
            readEvents: () => Stream.empty,
            dispatch: () => Effect.succeed({ sequence: 1 }),
            streamDomainEvents: Stream.empty,
          } as unknown as OrchestrationEngineService["Service"],
          snapshots: {
            getThreadOwnerById: () => Effect.succeed(Option.some("plugin:agent-plugin" as any)),
            getThreadDetailById: () => Effect.succeed(Option.none()),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          } as any,
          turns: {
            getByTurnId: ({ turnId }: { readonly turnId: TurnId }) =>
              Effect.succeed(
                terminalTurnIds.has(String(turnId))
                  ? Option.some({
                      threadId,
                      turnId,
                      pendingMessageId: null,
                      state: "completed",
                      assistantMessageId: null,
                    } as any)
                  : Option.none(),
              ),
            listByThreadId: () => Effect.succeed([]),
          } as any,
          messages: {
            getByMessageId: () => Effect.succeed(Option.none()),
          } as any,
          providerInstances: makeProviderRegistry(),
        },
        turnAliases,
        2,
      );

      // A is pending and recorded FIRST (oldest). B is recorded second and then
      // awaited to completion, which marks B's alias terminal.
      const a = yield* agents.startTurn({ threadId, text: "pending-A" });
      const b = yield* agents.startTurn({ threadId, text: "will-complete-B" });
      terminalTurnIds.add(String(b.turnId));
      yield* agents.awaitTurn({ threadId, turnId: b.turnId, timeout: "1 second" });
      expect(turnAliases.get(String(b.turnId))?.terminal).toBe(true);

      // C hits the cap. Eviction must reclaim the TERMINAL entry (B), never the
      // still-pending A, even though A is older by insertion order.
      const c = yield* agents.startTurn({ threadId, text: "pending-C" });
      expect(turnAliases.size).toBeLessThanOrEqual(2);
      expect(turnAliases.has(String(a.turnId))).toBe(true);
      expect(turnAliases.has(String(b.turnId))).toBe(false);
      expect(turnAliases.has(String(c.turnId))).toBe(true);
    }),
  );

  it.effect("a second awaitTurn on a completed turn resolves instead of timing out", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-reawait");
      const turnAliases = new Map<
        string,
        { readonly threadId: ThreadId; readonly messageId: MessageId; readonly terminal: boolean }
      >();
      // Synthetic plugin turnId never matches getByTurnId directly (the engine
      // assigns its own turnId), so correlation is ONLY via the alias's
      // messageId -> the projected row's pendingMessageId. `pendingMessageId`
      // is wired to the alias the startTurn below records.
      let pendingMessageId: string | null = null;
      const agents = makeAgentsCapability(
        {
          pluginId,
          engine: {
            readEvents: () => Stream.empty,
            dispatch: () => Effect.succeed({ sequence: 1 }),
            streamDomainEvents: Stream.empty,
          } as unknown as OrchestrationEngineService["Service"],
          snapshots: {
            getThreadOwnerById: () => Effect.succeed(Option.some("plugin:agent-plugin" as any)),
            getThreadDetailById: () => Effect.succeed(Option.none()),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          } as any,
          turns: {
            getByTurnId: () => Effect.succeed(Option.none()),
            listByThreadId: () =>
              Effect.succeed(
                pendingMessageId === null
                  ? []
                  : [
                      {
                        threadId,
                        turnId: TurnId.make("engine-assigned-turn"),
                        pendingMessageId,
                        state: "completed",
                        assistantMessageId: null,
                      } as any,
                    ],
              ),
          } as any,
          messages: {
            getByMessageId: () => Effect.succeed(Option.none()),
          } as any,
          providerInstances: makeProviderRegistry(),
        },
        turnAliases,
      );

      const started = yield* agents.startTurn({ threadId, text: "await twice" });
      pendingMessageId = String(started.messageId);

      const first = yield* agents.awaitTurn({
        threadId,
        turnId: started.turnId,
        timeout: "1 second",
      });
      expect(first).toEqual({ state: "completed", assistantText: null });

      // The prune-on-terminal-read bug deleted the alias here, so this second
      // await found nothing on every path and polled to a timeout. Keeping the
      // alias (marked terminal) lets the re-await resolve immediately.
      const second = yield* agents.awaitTurn({
        threadId,
        turnId: started.turnId,
        timeout: "1 second",
      });
      expect(second).toEqual({ state: "completed", assistantText: null });
      expect(turnAliases.get(String(started.turnId))?.terminal).toBe(true);
    }),
  );

  it.effect("awaitTurn fails typed on a malformed timeout instead of defecting", () =>
    Effect.gen(function* () {
      const agents = makeAgentsCapability({
        pluginId,
        engine: {
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 1 }),
          streamDomainEvents: Stream.empty,
        } as unknown as OrchestrationEngineService["Service"],
        snapshots: {
          getThreadOwnerById: () => Effect.succeed(Option.some("plugin:agent-plugin" as any)),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
        } as any,
        turns: {
          getByTurnId: () => Effect.succeed(Option.none()),
          listByThreadId: () => Effect.succeed([]),
        } as any,
        messages: {} as any,
        providerInstances: makeProviderRegistry(),
      });

      const exit = yield* Effect.exit(
        agents.awaitTurn({
          threadId: ThreadId.make("thread-bad-timeout"),
          turnId: TurnId.make("turn-bad-timeout"),
          timeout: "soon",
        }),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        // A typed failure, NOT a defect (Duration.fromInputUnsafe would throw).
        expect(String(exit.cause)).toContain(AgentsInvalidTimeoutError.name);
        expect(String(exit.cause)).not.toContain("Die");
      }
    }),
  );

  it.effect("listPendingRequests drops requests that already have a resolution activity", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-pending-requests");
      const activities = [
        {
          id: "act-1",
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval requested",
          payload: { requestId: "req-resolved" },
          turnId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "act-2",
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: { requestId: "req-resolved", decision: "accept" },
          turnId: null,
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "act-3",
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: { requestId: "req-open" },
          turnId: null,
          createdAt: "2026-01-01T00:00:02.000Z",
        },
        {
          id: "act-4",
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: { requestId: "req-stale" },
          turnId: null,
          createdAt: "2026-01-01T00:00:03.000Z",
        },
        {
          id: "act-5",
          tone: "error",
          kind: "provider.user-input.respond.failed",
          summary: "User input respond failed",
          payload: { requestId: "req-stale", detail: "Unknown pending user-input request" },
          turnId: null,
          createdAt: "2026-01-01T00:00:04.000Z",
        },
      ];
      const agents = makeAgentsCapability({
        pluginId,
        engine: {
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 1 }),
          streamDomainEvents: Stream.empty,
        } as unknown as OrchestrationEngineService["Service"],
        snapshots: {
          getThreadOwnerById: () => Effect.succeed(Option.some("plugin:agent-plugin" as any)),
          getThreadDetailById: () => Effect.succeed(Option.some({ activities } as any)),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
        } as any,
        turns: {} as any,
        messages: {} as any,
        providerInstances: makeProviderRegistry(),
      });

      const pending = yield* agents.listPendingRequests(threadId);
      // Only the still-open request survives: the resolved approval and the
      // stale-failed user-input request are both filtered out.
      expect(pending.map((request) => request.requestId)).toEqual(["req-open"]);
    }),
  );

  it.effect(
    "startTurn retry with the same commandId but no messageId reuses the first call's messageId",
    () =>
      Effect.gen(function* () {
        const dispatched: OrchestrationCommand[] = [];
        const turnAliases = new Map<
          string,
          { readonly threadId: ThreadId; readonly messageId: MessageId; readonly terminal: boolean }
        >();
        const agents = makeAgentsCapability(
          {
            pluginId,
            engine: {
              readEvents: () => Stream.empty,
              dispatch: (command: OrchestrationCommand) =>
                Effect.sync(() => {
                  dispatched.push(command);
                  return { sequence: dispatched.length };
                }),
              streamDomainEvents: Stream.empty,
            } as unknown as OrchestrationEngineService["Service"],
            snapshots: {
              getThreadOwnerById: () => Effect.succeed(Option.some("plugin:agent-plugin" as any)),
              getThreadDetailById: () => Effect.succeed(Option.none()),
              getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            } as any,
            turns: {} as any,
            messages: {} as any,
            providerInstances: makeProviderRegistry(),
          },
          turnAliases,
        );
        const threadId = ThreadId.make("thread-retry-explicit-message");
        const commandId = CommandId.make("cmd-retry-explicit-turn-start");
        const explicitMessageId = MessageId.make("message-retry-explicit");

        // First call establishes the alias with the EXPLICIT messageId M1 — the id
        // the engine persists as pendingMessageId for the (derived) turnId.
        const first = yield* agents.startTurn({
          threadId,
          text: "first",
          messageId: explicitMessageId,
          commandId,
        });
        expect(first.messageId).toBe(explicitMessageId);

        // Retry: SAME commandId, NO messageId. The engine receipt-dedups this back
        // to the first turn (pendingMessageId still M1). A retry that derived
        // messageId=hash(commandId) here would overwrite the alias with an id the
        // engine never persisted, so awaitTurn(turnId) would correlate on the wrong
        // messageId and time out. The fix reuses the first call's messageId.
        const second = yield* agents.startTurn({ threadId, text: "second", commandId });
        expect(second.turnId).toBe(first.turnId);
        expect(second.messageId).toBe(explicitMessageId);
        // The alias for that turnId still maps to M1, so readTerminalTurn/awaitTurn
        // correlates (turnId -> alias.messageId -> pendingMessageId).
        expect(turnAliases.get(String(second.turnId))?.messageId).toBe(explicitMessageId);
      }),
  );

  it.effect("awaitTerminalTurn resolves via the re-poll when no waking event is delivered", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-poll-fallback");
      const turnId = TurnId.make("turn-poll-fallback");
      // The turn becomes terminal AFTER awaitTurn has subscribed and parked, and
      // NO domain event is emitted to wake the deferred (streamDomainEvents is
      // empty). Only the bounded re-poll can make progress; the OLD event-only
      // path would hang until the outer timeout.
      let terminal = false;
      const terminalRow = {
        threadId,
        turnId,
        pendingMessageId: null,
        state: "completed",
        assistantMessageId: null,
      } as any;
      const agents = makeAgentsCapability({
        pluginId,
        engine: {
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 1 }),
          streamDomainEvents: Stream.empty,
        } as unknown as OrchestrationEngineService["Service"],
        snapshots: {
          getThreadOwnerById: () => Effect.succeed(Option.some("plugin:agent-plugin" as any)),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
        } as any,
        turns: {
          getByTurnId: () =>
            Effect.sync(() => (terminal ? Option.some(terminalRow) : Option.none())),
          listByThreadId: () => Effect.succeed([]),
        } as any,
        messages: {
          getByMessageId: () => Effect.succeed(Option.none()),
        } as any,
        providerInstances: makeProviderRegistry(),
      });

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* agents
            .awaitTurn({ threadId, turnId, timeout: 60_000 })
            .pipe(Effect.forkScoped);
          // Let the fiber subscribe and park on the race; its first poll read sees
          // no terminal row.
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          terminal = true;
          // Advance past the poll interval. The deferred never fires (empty
          // stream), so resolution can only come from the re-poll re-reading the
          // projection.
          yield* TestClock.adjust("300 millis");
          return yield* Fiber.join(fiber);
        }),
      );

      expect(result).toEqual({ state: "completed", assistantText: null });
    }),
  );
});
