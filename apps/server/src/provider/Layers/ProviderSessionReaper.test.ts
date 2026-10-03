import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationCommand,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderRuntimeLiveness } from "../Services/ProviderRuntimeLiveness.ts";
import { ProviderRuntimeLivenessLive } from "./ProviderRuntimeLiveness.ts";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderSessionReaperLive } from "./ProviderSessionReaper.ts";

const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };

  return poll();
}

const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

function makeReadModel(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly activities?: ReadonlyArray<{
      readonly id: EventId;
      readonly tone: "info";
      readonly kind: string;
      readonly summary: string;
      readonly payload: unknown;
      readonly turnId: TurnId | null;
      readonly createdAt: string;
    }>;
    readonly messages?: ReadonlyArray<{
      readonly id: MessageId;
      readonly role: "assistant";
      readonly text: string;
      readonly turnId: TurnId;
      readonly streaming: boolean;
      readonly createdAt: string;
      readonly updatedAt: string;
    }>;
    readonly session: {
      readonly threadId: ThreadId;
      readonly status: "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
      readonly providerName: "codex" | "claudeAgent";
      readonly runtimeMode: "approval-required" | "full-access" | "auto-accept-edits";
      readonly activeTurnId: TurnId | null;
      readonly lastError: string | null;
      readonly updatedAt: string;
    } | null;
  }>,
) {
  const now = new Date().toISOString();
  const projectId = ProjectId.make("project-provider-session-reaper");

  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        title: "Provider Reaper Project",
        workspaceRoot: "/tmp/provider-reaper-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: threads.map((thread) => ({
      id: thread.id,
      projectId,
      title: `Thread ${thread.id}`,
      modelSelection: defaultModelSelection,
      interactionMode: "default" as const,
      runtimeMode: "full-access" as const,
      pendingRuntimeMode: null,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [...(thread.messages ?? [])],
      session: thread.session,
      activities: [...(thread.activities ?? [])],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    })),
  };
}

describe("ProviderSessionReaper", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    ProviderSessionReaper | ProviderSessionRuntimeRepository,
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

  async function createHarness(input: {
    readonly readModel: ReturnType<typeof makeReadModel>;
    readonly stopSessionImplementation?: (input: {
      readonly threadId: ThreadId;
    }) => ReturnType<ProviderServiceShape["stopSession"]>;
    readonly activeSessions?: ReadonlyArray<ProviderSession>;
    readonly listSessionsImplementation?: ProviderServiceShape["listSessions"];
    readonly sweepIntervalMs?: number;
    readonly settledTurnGraceMs?: number;
    /** Provider runtime events replayed into the liveness ledger before the reaper starts. */
    readonly observedRuntimeEvents?: ReadonlyArray<ProviderRuntimeEvent>;
    /** Overrides the projection the reaper's pre-dispatch re-read observes. */
    readonly readModelAfterSweep?: ReturnType<typeof makeReadModel>;
  }) {
    const stoppedThreadIds = new Set<ThreadId>();
    const dispatchedCommands: OrchestrationCommand[] = [];
    let readModelCalls = 0;
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(
      (request) =>
        (input.stopSessionImplementation
          ? input.stopSessionImplementation(request)
          : Effect.sync(() => {
              stoppedThreadIds.add(request.threadId);
            })) as ReturnType<ProviderServiceShape["stopSession"]>,
    );

    let listSessionsCalls = 0;
    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      forkSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      steerTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      sessionCommand: () => unsupported(),
      stopSession,
      listSessions: () =>
        Effect.sync(() => {
          listSessionsCalls += 1;
          return input.listSessionsImplementation?.() ?? Effect.succeed(input.activeSessions ?? []);
        }).pipe(Effect.flatten),
      prewarmSession: () => Effect.void,
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      getInstanceInfo: (instanceId) => {
        const driverKind = ProviderDriverKind.make(String(instanceId));
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey: `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      streamEvents: Stream.empty,
    };

    const orchestrationEngine: OrchestrationEngineShape = {
      // Each sweep reads the projection twice: once for its snapshot and once more
      // immediately before reaping. Startup also reads it once to reconcile
      // orphaned background agents, so from call 3 onward the odd calls are the
      // pre-reap re-reads. Tests that need the re-read to disagree with the
      // snapshot therefore see `readModel` on even calls and
      // `readModelAfterSweep` on odd calls from 3 onward.
      getReadModel: () => {
        if (input.readModelAfterSweep === undefined) return Effect.succeed(input.readModel);
        readModelCalls += 1;
        const isPreReapReread = readModelCalls >= 3 && readModelCalls % 2 === 1;
        return Effect.succeed(isPreReapReread ? input.readModelAfterSweep : input.readModel);
      },
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatchedCommands.push(command);
          return { sequence: dispatchedCommands.length };
        }),
      withWorktreeLock: (effect) => effect,
      streamDomainEvents: Stream.empty,
      // Unused by these tests; Effect.never satisfies the scoped subscription type.
      acquireDomainEventSubscription: Effect.never,
    };

    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(runtimeRepositoryLayer),
    );
    const providerRuntimeLivenessLayer = Layer.effect(
      ProviderRuntimeLiveness,
      Effect.gen(function* () {
        const liveness = yield* ProviderRuntimeLiveness;
        for (const event of input.observedRuntimeEvents ?? []) {
          yield* liveness.record(event);
        }
        return liveness;
      }),
    ).pipe(Layer.provide(ProviderRuntimeLivenessLive));
    const layer = makeProviderSessionReaperLive({
      inactivityThresholdMs: 1_000,
      sweepIntervalMs: input.sweepIntervalMs ?? 60_000,
      ...(input.settledTurnGraceMs === undefined
        ? {}
        : { settledTurnGraceMs: input.settledTurnGraceMs }),
    }).pipe(
      Layer.provideMerge(providerSessionDirectoryLayer),
      Layer.provideMerge(runtimeRepositoryLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
      Layer.provideMerge(providerRuntimeLivenessLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    return {
      stopSession,
      stoppedThreadIds,
      dispatchedCommands,
      /** Sweeps observed: the reaper calls `listSessions` once per sweep. */
      sweeps: () => listSessionsCalls,
    };
  }

  /** Persists the provider runtime binding the reaper sweeps over. */
  async function persistRuntimeBinding(threadId: ThreadId, lastSeenAt: string, cursor: string) {
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));
    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt,
        resumeCursor: { opaque: cursor },
        runtimePayload: null,
      }),
    );
  }

  function settledTurnEvent(threadId: ThreadId, turnId: TurnId): ProviderRuntimeEvent {
    return {
      eventId: EventId.make(`evt-settled-${threadId}`),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId,
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      turnId,
      payload: { state: "completed" },
    } satisfies ProviderRuntimeEvent;
  }

  it("reaps stale persisted sessions without active turns", async () => {
    const threadId = ThreadId.make("thread-reaper-stale");
    const now = new Date().toISOString();
    const staleSessionSeenAt = new Date(Date.now() - 2_000).toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: staleSessionSeenAt,
        resumeCursor: {
          opaque: "resume-stale",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 1);

    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({ threadId });
    expect(harness.stoppedThreadIds.has(threadId)).toBe(true);
  });

  it("stops orphaned background agents left by a previous server process", async () => {
    const threadId = ThreadId.make("thread-reaper-orphaned-background-agent");
    const turnId = TurnId.make("turn-reaper-orphaned-background-agent");
    const startedAt = "2026-07-17T18:21:14.630Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          activities: [
            {
              id: EventId.make("activity-background-agent-started"),
              tone: "info",
              kind: "task.started",
              summary: "Background agent started",
              payload: {
                taskId: "snapshot-500-fix",
                taskType: "background-agent",
                name: "snapshot-500-fix",
              },
              turnId,
              createdAt: startedAt,
            },
          ],
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: startedAt,
          },
        },
      ]),
    });

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make());
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() =>
      harness.dispatchedCommands.some((command) => command.type === "thread.activity.append"),
    );
    const command = harness.dispatchedCommands.find(
      (candidate) => candidate.type === "thread.activity.append",
    );
    expect(command).toMatchObject({
      type: "thread.activity.append",
      threadId,
      activity: {
        kind: "task.completed",
        payload: {
          taskId: "snapshot-500-fix",
          status: "stopped",
        },
        turnId,
      },
    });
  });

  it("reconciles startup active turns without reporting a provider failure", async () => {
    const threadId = ThreadId.make("thread-reaper-active-turn");
    const turnId = TurnId.make("turn-reaper-active");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-active-turn",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.dispatchedCommands).toHaveLength(1);
    expect(harness.dispatchedCommands[0]).toMatchObject({
      type: "thread.session.set",
      threadId,
      session: {
        status: "interrupted",
        activeTurnId: null,
        lastError: null,
      },
    });
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("waits for a valid provider session snapshot before completing startup reconciliation", async () => {
    let listSessionsCalls = 0;
    let releaseSnapshot!: (sessions: ReadonlyArray<ProviderSession>) => void;
    const availableSnapshot = new Promise<ReadonlyArray<ProviderSession>>((resolve) => {
      releaseSnapshot = resolve;
    });
    await createHarness({
      readModel: makeReadModel([]),
      listSessionsImplementation: () => {
        listSessionsCalls += 1;
        return listSessionsCalls === 1
          ? Effect.die(new Error("simulated unavailable session snapshot"))
          : Effect.promise(() => availableSnapshot);
      },
    });

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    let reconciled = false;
    const reconciliation = runtime!.runPromise(reaper.reconcileStartup).then(() => {
      reconciled = true;
    });

    await waitFor(() => listSessionsCalls === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reconciled).toBe(false);

    releaseSnapshot([]);
    await reconciliation;
    expect(reconciled).toBe(true);
  });

  it("clears the legacy restart error from already interrupted sessions", async () => {
    const threadId = ThreadId.make("thread-reaper-legacy-restart-error");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "interrupted",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "Provider session is no longer active.",
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-legacy-restart-error",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await waitFor(() => harness.dispatchedCommands.length === 1);

    expect(harness.dispatchedCommands[0]).toMatchObject({
      type: "thread.session.set",
      threadId,
      session: {
        status: "interrupted",
        activeTurnId: null,
        lastError: null,
      },
    });
  });

  it("preserves genuine provider failure errors during startup repair", async () => {
    const threadId = ThreadId.make("thread-reaper-genuine-provider-failure");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "interrupted",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "Provider session was lost unexpectedly.",
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-genuine-provider-failure",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.dispatchedCommands).toHaveLength(0);
  });

  it("finalizes persisted streaming assistant messages when startup interrupts their turn", async () => {
    const threadId = ThreadId.make("thread-reaper-streaming-message");
    const turnId = TurnId.make("turn-reaper-streaming-message");
    const messageId = MessageId.make("message-reaper-streaming");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          messages: [
            {
              id: messageId,
              role: "assistant",
              text: "Partial response",
              turnId,
              streaming: true,
              createdAt: now,
              updatedAt: now,
            },
          ],
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-streaming-message",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await waitFor(() => harness.dispatchedCommands.length === 2);

    expect(harness.dispatchedCommands).toMatchObject([
      {
        type: "thread.message.assistant.complete",
        threadId,
        messageId,
        turnId,
      },
      {
        type: "thread.session.set",
        threadId,
        session: {
          status: "interrupted",
          activeTurnId: null,
          lastError: null,
        },
      },
    ]);
  });

  it("reports a provider failure when a live server later loses an active turn", async () => {
    const threadId = ThreadId.make("thread-reaper-live-session-loss");
    const turnId = TurnId.make("turn-reaper-live-session-loss");
    const now = new Date().toISOString();
    const activeSession: ProviderSession = {
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      status: "running",
      runtimeMode: "full-access",
      threadId,
      activeTurnId: turnId,
      createdAt: now,
      updatedAt: now,
    };
    let listSessionsCallCount = 0;
    const harness = await createHarness({
      sweepIntervalMs: 100,
      listSessionsImplementation: () =>
        Effect.succeed(listSessionsCallCount++ === 0 ? [activeSession] : []),
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-live-session-loss",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await waitFor(() => harness.dispatchedCommands.length === 1);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = null;

    expect(harness.dispatchedCommands[0]).toMatchObject({
      type: "thread.session.set",
      session: {
        lastError: "Provider session was lost unexpectedly.",
      },
    });
  });

  // Regression: a healthy turn that finished seconds ago was interrupted with
  // "Provider session was lost unexpectedly." because the adapter had already
  // flipped its in-memory session to idle while the durable projection still
  // named the turn active. The provider's terminal event was merely queued.
  it("holds a stale active turn the provider already reported as settled", async () => {
    const threadId = ThreadId.make("thread-reaper-settled-turn");
    const turnId = TurnId.make("turn-reaper-settled-turn");
    const now = new Date().toISOString();
    const harness = await createHarness({
      sweepIntervalMs: 100,
      settledTurnGraceMs: 0,
      // The provider is idle, so the bare mismatch check would reap.
      activeSessions: [],
      observedRuntimeEvents: [settledTurnEvent(threadId, turnId)],
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    await persistRuntimeBinding(threadId, now, "resume-settled-turn");

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await waitFor(() => harness.sweeps() >= 3);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = null;

    expect(harness.dispatchedCommands).toEqual([]);
  });

  it("holds a stale active turn while the provider is still reporting events", async () => {
    const threadId = ThreadId.make("thread-reaper-provider-active");
    const turnId = TurnId.make("turn-reaper-provider-active");
    const now = new Date().toISOString();
    const harness = await createHarness({
      sweepIntervalMs: 100,
      // Long enough that a just-recorded event is still inside the grace.
      settledTurnGraceMs: 60_000,
      activeSessions: [],
      observedRuntimeEvents: [
        {
          eventId: EventId.make("evt-reaper-provider-active"),
          provider: ProviderDriverKind.make("claudeAgent"),
          threadId,
          createdAt: now,
          type: "item.updated",
          turnId,
          payload: { itemType: "command_execution" },
        } satisfies ProviderRuntimeEvent,
      ],
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    await persistRuntimeBinding(threadId, now, "resume-provider-active");

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await waitFor(() => harness.sweeps() >= 3);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = null;

    expect(harness.dispatchedCommands).toEqual([]);
  });

  it("holds a stale active turn whose projection advanced during the sweep", async () => {
    const threadId = ThreadId.make("thread-reaper-projection-advanced");
    const turnId = TurnId.make("turn-reaper-projection-advanced");
    const now = new Date().toISOString();
    const session = (activeTurnId: TurnId) => ({
      threadId,
      status: "running" as const,
      providerName: "claudeAgent" as const,
      runtimeMode: "full-access" as const,
      activeTurnId,
      lastError: null,
      updatedAt: now,
    });
    const harness = await createHarness({
      sweepIntervalMs: 100,
      settledTurnGraceMs: 0,
      activeSessions: [],
      // The projection caught up between the sweep's snapshot and the pre-dispatch
      // re-read: the turn finished and a different one is now active.
      readModel: makeReadModel([{ id: threadId, session: session(turnId) }]),
      readModelAfterSweep: makeReadModel([
        { id: threadId, session: session(TurnId.make("turn-reaper-next")) },
      ]),
      observedRuntimeEvents: [],
    });
    await persistRuntimeBinding(threadId, now, "resume-projection-advanced");

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await waitFor(() => harness.sweeps() >= 3);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = null;

    expect(harness.dispatchedCommands).toEqual([]);
  });

  it("clears stale active turns when the persisted runtime binding is already stopped", async () => {
    const threadId = ThreadId.make("thread-reaper-stopped-active-turn");
    const turnId = TurnId.make("turn-reaper-stopped-active");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-stopped-active-turn",
        },
        runtimePayload: {
          activeTurnId: null,
          lastRuntimeEvent: "provider.stopAll",
        },
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.dispatchedCommands).toHaveLength(1);
    expect(harness.dispatchedCommands[0]).toMatchObject({
      type: "thread.session.set",
      threadId,
      session: {
        status: "interrupted",
        activeTurnId: null,
        lastError: null,
      },
    });
  });

  it("clears stale active turns even within the inactivity threshold", async () => {
    const threadId = ThreadId.make("thread-reaper-fresh-active-turn");
    const turnId = TurnId.make("turn-reaper-fresh-active");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-fresh-active-turn",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.dispatchedCommands).toHaveLength(1);
    expect(harness.dispatchedCommands[0]).toMatchObject({
      type: "thread.session.set",
      threadId,
      session: {
        status: "interrupted",
        activeTurnId: null,
      },
    });
  });

  it("keeps active turns when a provider session still owns them", async () => {
    const threadId = ThreadId.make("thread-reaper-live-active-turn");
    const turnId = TurnId.make("turn-reaper-live-active");
    const now = new Date().toISOString();
    const harness = await createHarness({
      activeSessions: [
        {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          status: "running",
          runtimeMode: "full-access",
          threadId,
          activeTurnId: turnId,
          createdAt: now,
          updatedAt: now,
        },
      ],
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-live-active-turn",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.dispatchedCommands).toHaveLength(0);
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("keeps active turns when a provider session reports the same turn id with a stale ready status", async () => {
    const threadId = ThreadId.make("thread-reaper-ready-active-turn");
    const turnId = TurnId.make("turn-reaper-ready-active");
    const now = new Date().toISOString();
    const harness = await createHarness({
      activeSessions: [
        {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          status: "ready",
          runtimeMode: "full-access",
          threadId,
          activeTurnId: turnId,
          createdAt: now,
          updatedAt: now,
        },
      ],
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-ready-active-turn",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.dispatchedCommands).toHaveLength(0);
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("does not keep active turns alive from a running provider session without a matching turn id", async () => {
    const threadId = ThreadId.make("thread-reaper-running-missing-turn");
    const turnId = TurnId.make("turn-reaper-running-missing-turn");
    const now = new Date().toISOString();
    const harness = await createHarness({
      activeSessions: [
        {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          status: "running",
          runtimeMode: "full-access",
          threadId,
          createdAt: now,
          updatedAt: now,
        },
      ],
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-running-missing-turn",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.dispatchedCommands).toHaveLength(1);
    expect(harness.dispatchedCommands[0]).toMatchObject({
      type: "thread.session.set",
      threadId,
      session: {
        status: "interrupted",
        activeTurnId: null,
      },
    });
  });

  it("keeps startup recovery pending when live session listing initially fails", async () => {
    const threadId = ThreadId.make("thread-reaper-list-failure-active-turn");
    const turnId = TurnId.make("turn-reaper-list-failure-active");
    const now = new Date().toISOString();
    let listSessionsCallCount = 0;
    const harness = await createHarness({
      sweepIntervalMs: 100,
      listSessionsImplementation: () =>
        listSessionsCallCount++ === 0
          ? Effect.die(new Error("simulated list failure"))
          : Effect.succeed([]),
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-list-failure-active-turn",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.dispatchedCommands).toHaveLength(0);
    await waitFor(() => harness.dispatchedCommands.length === 1);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = null;
    expect(harness.dispatchedCommands[0]).toMatchObject({
      type: "thread.session.set",
      session: {
        status: "interrupted",
        activeTurnId: null,
        lastError: null,
      },
    });
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("does not reap sessions that are still within the inactivity threshold", async () => {
    const threadId = ThreadId.make("thread-reaper-fresh");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-fresh",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("skips persisted sessions that are already marked stopped", async () => {
    const threadId = ThreadId.make("thread-reaper-stopped");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stopped",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("continues reaping other sessions when one stop attempt fails", async () => {
    const failedThreadId = ThreadId.make("thread-reaper-stop-failure");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-success");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: failedThreadId,
          session: {
            threadId: failedThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      stopSessionImplementation: (request) =>
        request.threadId === failedThreadId
          ? Effect.fail(
              new ProviderValidationError({
                operation: "ProviderSessionReaper.test",
                issue: "simulated stop failure",
              }),
            )
          : Effect.void,
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId: failedThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-failure",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-success",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      failedThreadId,
      reapedThreadId,
    ]);
  });

  it("continues reaping other sessions when one stop attempt defects", async () => {
    const defectThreadId = ThreadId.make("thread-reaper-stop-defect");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-after-defect");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: defectThreadId,
          session: {
            threadId: defectThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      stopSessionImplementation: (request) =>
        request.threadId === defectThreadId
          ? Effect.die(new Error("simulated stop defect"))
          : Effect.void,
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId: defectThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-defect",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-after-defect",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      defectThreadId,
      reapedThreadId,
    ]);
  });
});
