import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type OrchestrationSessionStatus,
  ProjectId,
  type ServerProvider,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type TurnId,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { QueuedFollowUpReactor } from "../Services/QueuedFollowUpReactor.ts";
import { QueuedFollowUpReactorLive } from "./QueuedFollowUpReactor.ts";

const NOW_ISO = "2026-03-28T12:00:00.000Z";

function makeReadModel(input?: {
  sessionStatus?: OrchestrationSessionStatus | null;
  lastSendError?: string | null;
  queuedPrompts?: ReadonlyArray<string>;
  queuedAttachments?: ReadonlyArray<
    OrchestrationReadModel["threads"][number]["queuedFollowUps"][number]["attachments"]
  >;
  queuedTerminalContexts?: ReadonlyArray<
    OrchestrationReadModel["threads"][number]["queuedFollowUps"][number]["terminalContexts"]
  >;
  queuedModelSelections?: ReadonlyArray<
    OrchestrationReadModel["threads"][number]["queuedFollowUps"][number]["modelSelection"]
  >;
  queuedRuntimeModes?: ReadonlyArray<
    OrchestrationReadModel["threads"][number]["queuedFollowUps"][number]["runtimeMode"]
  >;
  queuedInteractionModes?: ReadonlyArray<
    OrchestrationReadModel["threads"][number]["queuedFollowUps"][number]["interactionMode"]
  >;
  latestTurnState?: OrchestrationReadModel["threads"][number]["latestTurn"];
  activities?: ReadonlyArray<OrchestrationThreadActivity>;
  threadRuntimeMode?: OrchestrationReadModel["threads"][number]["runtimeMode"];
  threadInteractionMode?: OrchestrationReadModel["threads"][number]["interactionMode"];
}): OrchestrationReadModel {
  const queuedPrompts = input?.queuedPrompts ?? ["send this next"];
  return {
    snapshotSequence: 1,
    updatedAt: NOW_ISO,
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        interactionMode: input?.threadInteractionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: input?.threadRuntimeMode ?? DEFAULT_RUNTIME_MODE,
        branch: null,
        worktreePath: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        queuedFollowUps: queuedPrompts.map((prompt, index) => ({
          id: `follow-up-${index + 1}`,
          createdAt: NOW_ISO,
          prompt,
          attachments: input?.queuedAttachments?.[index] ?? [],
          terminalContexts: input?.queuedTerminalContexts?.[index] ?? [],
          modelSelection: input?.queuedModelSelections?.[index] ?? {
            provider: "codex",
            model: "gpt-5.3-codex",
          },
          runtimeMode: input?.queuedRuntimeModes?.[index] ?? DEFAULT_RUNTIME_MODE,
          interactionMode:
            input?.queuedInteractionModes?.[index] ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          lastSendError: input?.lastSendError ?? null,
        })),
        proposedPlans: [],
        activities: [...(input?.activities ?? [])],
        checkpoints: [],
        latestTurn: input?.latestTurnState ?? null,
        session:
          input?.sessionStatus === null
            ? null
            : {
                threadId: ThreadId.makeUnsafe("thread-1"),
                status: input?.sessionStatus ?? "ready",
                providerName: "codex",
                runtimeMode: input?.threadRuntimeMode ?? DEFAULT_RUNTIME_MODE,
                activeTurnId: null,
                lastError: null,
                updatedAt: NOW_ISO,
              },
      },
    ],
  };
}

const DEFAULT_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    authStatus: "authenticated",
    checkedAt: NOW_ISO,
    models: [
      {
        slug: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
  {
    provider: "claudeAgent",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    authStatus: "authenticated",
    checkedAt: NOW_ISO,
    models: [
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "ultrathink", label: "Ultrathink" },
            { value: "high", label: "High" },
          ],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: ["ultrathink"],
        },
      },
    ],
  },
];

function provideQueuedFollowUpReactorTestServices(
  engine: OrchestrationEngineShape,
  providers: ReadonlyArray<ServerProvider> = DEFAULT_PROVIDERS,
) {
  return QueuedFollowUpReactorLive.pipe(
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(
      Layer.succeed(ProviderRegistry, {
        getProviders: Effect.succeed(providers),
        refresh: () => Effect.succeed(providers),
        streamChanges: Stream.empty,
      }),
    ),
  );
}

describe("QueuedFollowUpReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<QueuedFollowUpReactor, never> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("dispatches the queued head and removes it when the thread is sendable", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () => Effect.succeed(makeReadModel()),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
    };

    runtime = ManagedRuntime.make(provideQueuedFollowUpReactorTestServices(engine));

    const reactor = await runtime.runPromise(Effect.service(QueuedFollowUpReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await runtime.runPromise(reactor.drain);

    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.turn.start",
      "thread.queued-follow-up.remove",
    ]);
    const turnStart = dispatched[0];
    expect(turnStart?.type).toBe("thread.turn.start");
    if (turnStart?.type !== "thread.turn.start") {
      throw new Error("Expected first command to be thread.turn.start");
    }
    expect(turnStart.message.text).toBe("send this next");

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("injects queued terminal contexts into the dispatched prompt", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () =>
        Effect.succeed(
          makeReadModel({
            queuedPrompts: ["Investigate this"],
            queuedTerminalContexts: [
              [
                {
                  id: "ctx-1",
                  threadId: ThreadId.makeUnsafe("thread-1"),
                  createdAt: NOW_ISO,
                  terminalId: "default",
                  terminalLabel: "Terminal 1",
                  lineStart: 3,
                  lineEnd: 6,
                  text: "\n\nalpha\nbeta",
                },
              ],
            ],
          }),
        ),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
    };

    runtime = ManagedRuntime.make(provideQueuedFollowUpReactorTestServices(engine));

    const reactor = await runtime.runPromise(Effect.service(QueuedFollowUpReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await runtime.runPromise(reactor.drain);

    const turnStart = dispatched[0];
    expect(turnStart?.type).toBe("thread.turn.start");
    if (turnStart?.type !== "thread.turn.start") {
      throw new Error("Expected first command to be thread.turn.start");
    }
    expect(turnStart.message.text).toContain("Investigate this");
    expect(turnStart.message.text).toContain("<terminal_context>");
    expect(turnStart.message.text).toContain("- Terminal 1 lines 3-6:");
    expect(turnStart.message.text).toContain("5 | alpha");
    expect(turnStart.message.text).toContain("6 | beta");

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("uses the image-only fallback prompt for queued image-only sends", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () =>
        Effect.succeed(
          makeReadModel({
            queuedPrompts: [""],
            queuedAttachments: [
              [
                {
                  type: "image",
                  id: "thread-1-att-1",
                  name: "queued.png",
                  mimeType: "image/png",
                  sizeBytes: 128,
                },
              ],
            ],
          }),
        ),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
    };

    runtime = ManagedRuntime.make(provideQueuedFollowUpReactorTestServices(engine));

    const reactor = await runtime.runPromise(Effect.service(QueuedFollowUpReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await runtime.runPromise(reactor.drain);

    const turnStart = dispatched[0];
    expect(turnStart?.type).toBe("thread.turn.start");
    if (turnStart?.type !== "thread.turn.start") {
      throw new Error("Expected first command to be thread.turn.start");
    }
    expect(turnStart.message.text).toBe(
      "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]",
    );

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("records a send failure and keeps the queued item when dispatch fails", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () => Effect.succeed(makeReadModel()),
      readEvents: () => Stream.empty,
      dispatch: (command) => {
        dispatched.push(command);
        if (command.type === "thread.turn.start") {
          return Effect.fail({ _tag: "InvalidCommand" } as never);
        }
        return Effect.succeed({ sequence: dispatched.length });
      },
      streamDomainEvents: Stream.empty,
    };

    runtime = ManagedRuntime.make(provideQueuedFollowUpReactorTestServices(engine));

    const reactor = await runtime.runPromise(Effect.service(QueuedFollowUpReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await runtime.runPromise(reactor.drain);

    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.turn.start",
      "thread.queued-follow-up.send-failed",
    ]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("does not dispatch while the thread session is still running", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () => Effect.succeed(makeReadModel({ sessionStatus: "running" })),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
    };

    runtime = ManagedRuntime.make(provideQueuedFollowUpReactorTestServices(engine));

    const reactor = await runtime.runPromise(Effect.service(QueuedFollowUpReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await runtime.runPromise(reactor.drain);

    expect(dispatched).toEqual([]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("does not dispatch while a pending approval is open", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () =>
        Effect.succeed(
          makeReadModel({
            activities: [
              {
                id: EventId.makeUnsafe("activity-approval-open"),
                kind: "approval.requested",
                tone: "info",
                summary: "Approval required",
                turnId: null,
                createdAt: NOW_ISO,
                payload: {
                  requestId: "approval-request-1",
                  requestKind: "command",
                },
              },
            ],
          }),
        ),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
    };

    runtime = ManagedRuntime.make(provideQueuedFollowUpReactorTestServices(engine));

    const reactor = await runtime.runPromise(Effect.service(QueuedFollowUpReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await runtime.runPromise(reactor.drain);

    expect(dispatched).toEqual([]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("does not dispatch while a pending user-input request is open", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () =>
        Effect.succeed(
          makeReadModel({
            activities: [
              {
                id: EventId.makeUnsafe("activity-user-input-open"),
                kind: "user-input.requested",
                tone: "info",
                summary: "Need more input",
                turnId: null,
                createdAt: NOW_ISO,
                payload: {
                  requestId: "user-input-request-1",
                  questions: [
                    {
                      id: "question-1",
                      header: "Pick one",
                      question: "Which option?",
                      options: [
                        {
                          label: "A",
                          description: "Option A",
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          }),
        ),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
    };

    runtime = ManagedRuntime.make(provideQueuedFollowUpReactorTestServices(engine));

    const reactor = await runtime.runPromise(Effect.service(QueuedFollowUpReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await runtime.runPromise(reactor.drain);

    expect(dispatched).toEqual([]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("does not dispatch the rest of the queue before the previous queued send settles", async () => {
    const dispatched: OrchestrationCommand[] = [];
    let readModel = makeReadModel({
      queuedPrompts: ["first", "second", "third"],
    });
    const threadEvent = {
      eventId: EventId.makeUnsafe("evt-queued-follow-up-reactor"),
      sequence: 1,
      type: "thread.queued-follow-up-enqueued",
      aggregateKind: "thread",
      aggregateId: ThreadId.makeUnsafe("thread-1"),
      occurredAt: NOW_ISO,
      commandId: CommandId.makeUnsafe("cmd-queued-follow-up-reactor"),
      causationEventId: null,
      correlationId: "corr-queued-follow-up-reactor",
      payload: {
        createdAt: NOW_ISO,
        threadId: ThreadId.makeUnsafe("thread-1"),
        followUp: readModel.threads[0]!.queuedFollowUps[0]!,
      },
      metadata: {},
    } as unknown as OrchestrationEvent;
    const engine: OrchestrationEngineShape = {
      getReadModel: () => Effect.succeed(readModel),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          if (command.type === "thread.queued-follow-up.remove") {
            const nextQueuedFollowUps = readModel.threads[0]!.queuedFollowUps.filter(
              (followUp) => followUp.id !== command.followUpId,
            );
            readModel = {
              ...readModel,
              threads: [
                {
                  ...readModel.threads[0]!,
                  queuedFollowUps: nextQueuedFollowUps,
                },
              ],
            };
          }
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.fromIterable([threadEvent, threadEvent]),
    };

    runtime = ManagedRuntime.make(provideQueuedFollowUpReactorTestServices(engine));

    const reactor = await runtime.runPromise(Effect.service(QueuedFollowUpReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await runtime.runPromise(reactor.drain);

    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.turn.start",
      "thread.queued-follow-up.remove",
    ]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("blocks redispatch when both queue cleanup and send-failed persistence fail", async () => {
    const dispatched: OrchestrationCommand[] = [];
    let readModel = makeReadModel({
      queuedPrompts: ["first"],
      latestTurnState: {
        turnId: "latest-turn-1" as TurnId,
        state: "completed",
        requestedAt: "2026-03-28T12:00:01.000Z",
        startedAt: "2026-03-28T12:00:01.100Z",
        completedAt: "2026-03-28T12:00:02.000Z",
        assistantMessageId: null,
      },
    });
    const threadEvent = {
      eventId: EventId.makeUnsafe("evt-queued-follow-up-reactor-double-failure"),
      sequence: 1,
      type: "thread.queued-follow-up-enqueued",
      aggregateKind: "thread",
      aggregateId: ThreadId.makeUnsafe("thread-1"),
      occurredAt: NOW_ISO,
      commandId: CommandId.makeUnsafe("cmd-queued-follow-up-reactor-double-failure"),
      causationEventId: null,
      correlationId: "corr-queued-follow-up-reactor-double-failure",
      payload: {
        createdAt: NOW_ISO,
        threadId: ThreadId.makeUnsafe("thread-1"),
        followUp: readModel.threads[0]!.queuedFollowUps[0]!,
      },
      metadata: {},
    } as unknown as OrchestrationEvent;
    const engine: OrchestrationEngineShape = {
      getReadModel: () => Effect.succeed(readModel),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          if (command.type === "thread.turn.start") {
            readModel = {
              ...readModel,
              threads: [
                {
                  ...readModel.threads[0]!,
                  latestTurn: {
                    turnId: "latest-turn-2" as TurnId,
                    state: "completed",
                    requestedAt: "2026-03-28T12:00:03.000Z",
                    startedAt: "2026-03-28T12:00:03.100Z",
                    completedAt: "2026-03-28T12:00:04.000Z",
                    assistantMessageId: null,
                  },
                },
              ],
            };
            return { sequence: dispatched.length };
          }
          if (
            command.type === "thread.queued-follow-up.remove" ||
            command.type === "thread.queued-follow-up.send-failed"
          ) {
            throw new Error(`${command.type} failed`);
          }
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.fromIterable([threadEvent, threadEvent]),
    };

    runtime = ManagedRuntime.make(provideQueuedFollowUpReactorTestServices(engine));

    const reactor = await runtime.runPromise(Effect.service(QueuedFollowUpReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await runtime.runPromise(reactor.drain);

    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.turn.start",
      "thread.queued-follow-up.remove",
      "thread.queued-follow-up.send-failed",
    ]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("sets queued runtime and interaction modes before auto-dispatching the queued head", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () =>
        Effect.succeed(
          makeReadModel({
            queuedPrompts: ["mode-sensitive follow-up"],
            queuedRuntimeModes: ["approval-required"],
            queuedInteractionModes: ["plan"],
            threadRuntimeMode: "full-access",
            threadInteractionMode: "default",
          }),
        ),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
    };

    runtime = ManagedRuntime.make(provideQueuedFollowUpReactorTestServices(engine));

    const reactor = await runtime.runPromise(Effect.service(QueuedFollowUpReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await runtime.runPromise(reactor.drain);

    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.runtime-mode.set",
      "thread.interaction-mode.set",
      "thread.turn.start",
      "thread.queued-follow-up.remove",
    ]);

    const turnStart = dispatched[2];
    expect(turnStart?.type).toBe("thread.turn.start");
    if (turnStart?.type !== "thread.turn.start") {
      throw new Error("Expected third command to be thread.turn.start");
    }
    expect(turnStart.runtimeMode).toBe("approval-required");
    expect(turnStart.interactionMode).toBe("plan");

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("applies prompt-injected effort formatting during queued auto-dispatch", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () =>
        Effect.succeed(
          makeReadModel({
            queuedPrompts: ["Investigate this carefully"],
            queuedModelSelections: [
              {
                provider: "claudeAgent",
                model: "claude-sonnet-4-6",
                options: { effort: "ultrathink" },
              },
            ],
          }),
        ),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
    };

    runtime = ManagedRuntime.make(provideQueuedFollowUpReactorTestServices(engine));

    const reactor = await runtime.runPromise(Effect.service(QueuedFollowUpReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await runtime.runPromise(reactor.drain);

    const turnStart = dispatched.find((command) => command.type === "thread.turn.start");
    expect(turnStart?.type).toBe("thread.turn.start");
    if (turnStart?.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(turnStart.message.text).toBe("Ultrathink:\nInvestigate this carefully");

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
