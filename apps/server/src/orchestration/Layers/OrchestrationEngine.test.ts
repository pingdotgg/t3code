import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  ProviderInstanceId,
  QueuedTurnId,
} from "@t3tools/contracts";
import { Deferred, Effect, Layer, ManagedRuntime, Metric, Option, Queue, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";
import { CheckoutCoordinator } from "../../git/CheckoutCoordinator.ts";
import { threadHasInFlightTurn } from "../commandInvariants.ts";

import { PersistenceSqlError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorktreeCleanupJobRepository } from "../../persistence/Services/WorktreeCleanupJobs.ts";
import { WorkspaceOwnershipRepository } from "../../persistence/Services/WorkspaceOwnership.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { canonicalizeWorktreePath } from "../../git/worktreePaths.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

async function createOrchestrationSystem(
  beforeProject: (event: OrchestrationEvent) => Effect.Effect<void> = () => Effect.void,
  dbPath?: string,
) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-engine-test-",
  });
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(
      Layer.effect(
        OrchestrationProjectionPipeline,
        Effect.gen(function* () {
          const real = yield* OrchestrationProjectionPipeline;
          return {
            ...real,
            projectEvent: (event: OrchestrationEvent) =>
              beforeProject(event).pipe(Effect.andThen(real.projectEvent(event))),
          };
        }),
      ).pipe(Layer.provide(OrchestrationProjectionPipelineLive)),
    ),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(dbPath ? makeSqlitePersistenceLive(dbPath) : SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const testWorkspaceRoot = await mkdtemp(join(tmpdir(), "t3-orchestration-workspaces-"));
  const workspaceForThread = (threadId: string) => join(testWorkspaceRoot, threadId);
  const ownedThreadIds = new Set<string>();
  const testEngine = {
    ...engine,
    dispatch: (command: Parameters<typeof engine.dispatch>[0]) => {
      if (command.type === "thread.create") {
        ownedThreadIds.add(String(command.threadId));
      }
      if (command.type === "thread.create" && command.worktreePath == null) {
        const worktreePath = workspaceForThread(String(command.threadId));
        return Effect.promise(() => mkdir(worktreePath, { recursive: true })).pipe(
          Effect.andThen(
            engine.dispatch({
              ...command,
              worktreePath,
            }),
          ),
        );
      }
      if (
        command.type === "thread.turn.start" &&
        command.bootstrap?.createThread !== undefined &&
        command.bootstrap.createThread.worktreePath == null
      ) {
        ownedThreadIds.add(String(command.threadId));
        const worktreePath = workspaceForThread(String(command.threadId));
        return Effect.promise(() => mkdir(worktreePath, { recursive: true })).pipe(
          Effect.andThen(
            engine.dispatch({
              ...command,
              bootstrap: {
                ...command.bootstrap,
                createThread: {
                  ...command.bootstrap.createThread,
                  worktreePath,
                },
              },
            }),
          ),
        );
      }
      return engine.dispatch(command);
    },
  } satisfies typeof engine;
  const snapshots = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const coordinator = await runtime.runPromise(Effect.service(CheckoutCoordinator));
  const workspaceOwnership = await runtime.runPromise(Effect.service(WorkspaceOwnershipRepository));
  const worktreeCleanupJobs = await runtime.runPromise(
    Effect.service(WorktreeCleanupJobRepository),
  );
  return {
    engine: testEngine,
    snapshots,
    coordinator,
    workspaceOwnership,
    worktreeCleanupJobs,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: async () => {
      if (dbPath === undefined) {
        for (const threadId of ownedThreadIds) {
          const ownerships = await runtime.runPromise(
            workspaceOwnership.getByThreadId(ThreadId.make(threadId)),
          );
          for (const ownership of ownerships) {
            await runtime.runPromise(
              workspaceOwnership.release(ThreadId.make(threadId), ownership.canonicalPath),
            );
          }
        }
      }
      await runtime.dispose();
      await rm(testWorkspaceRoot, { recursive: true, force: true });
    },
  };
}

function now() {
  return new Date().toISOString();
}

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

describe("OrchestrationEngine", () => {
  it("does not claim the project checkout for workspace-less metadata updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3-meta-workspace-"));
    const system = await createOrchestrationSystem();
    const projectId = ProjectId.make("meta-workspace-project");
    const threadId = ThreadId.make("meta-workspace-thread");
    const at = now();

    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("meta-workspace-project-create"),
          projectId,
          title: "Metadata workspace",
          workspaceRoot: directory,
          createdAt: at,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("meta-workspace-thread-create"),
          threadId,
          projectId,
          title: "Metadata workspace",
          modelSelection: { instanceId: ProviderInstanceId.make("copilot"), model: "test-model" },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: at,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("meta-workspace-clear"),
          threadId,
          title: "Cleared workspace",
          worktreePath: null,
          workspaceBinding: null,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("meta-workspace-title"),
          threadId,
          title: "Title only",
        }),
      );

      const thread = (await system.run(system.engine.getReadModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(thread?.title).toBe("Title only");
      expect(thread?.worktreePath).toBeNull();
      expect(thread?.workspaceBinding).toBeUndefined();
      expect(
        (await system.run(system.workspaceOwnership.getByThreadId(threadId))).some(
          (ownership) => ownership.canonicalPath === directory,
        ),
      ).toBe(false);
    } finally {
      await system.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("atomically records child updates, recovers paused batches, and never recreates dismissed reports", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3-nudging-restart-"));
    const dbPath = join(directory, "state.sqlite");
    let rejectQueue = false;
    let system = await createOrchestrationSystem(
      (event) =>
        event.type === "thread.queued-turn-created" && rejectQueue
          ? Effect.die("injected queue projection failure")
          : Effect.void,
      dbPath,
    );
    const projectId = ProjectId.make("nudging-project");
    const parentId = ThreadId.make("nudging-parent");
    const childId = ThreadId.make("nudging-child");
    const at = now();
    const report = {
      type: "thread.child.report" as const,
      commandId: CommandId.make("report-original"),
      threadId: childId,
      reportId: "decision-1",
      assignmentId: MessageId.make("assignment"),
      kind: "decision-needed" as const,
      summary: "Choose the migration approach.",
      decision: { question: "Which migration approach?", options: ["Expand", "Replace"] },
      canContinue: false,
      originTurnId: TurnId.make("turn-child"),
      createdAt: at,
    };
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("nudging-project"),
          projectId,
          title: "Nudging",
          workspaceRoot: directory,
          createdAt: at,
        }),
      );
      for (const id of [parentId, childId]) {
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create-${id}`),
            threadId: id,
            projectId,
            title: id,
            modelSelection: { instanceId: ProviderInstanceId.make("copilot"), model: "test-model" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: at,
            ...(id === childId
              ? {
                  parentThreadId: parentId,
                  delegation: {
                    assignmentId: MessageId.make("assignment"),
                    followUp: "automatic" as const,
                    completedAt: null,
                  },
                }
              : {}),
          }),
        );
      }
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("bind-child-turn"),
          threadId: childId,
          session: {
            threadId: childId,
            status: "running",
            providerName: "copilot",
            providerInstanceId: ProviderInstanceId.make("copilot"),
            runtimeMode: "approval-required",
            activeTurnId: TurnId.make("turn-child"),
            lastError: null,
            updatedAt: at,
          },
          createdAt: at,
        }),
      );
      rejectQueue = true;
      await expect(system.run(system.engine.dispatch(report))).rejects.toThrow();
      let state = await system.run(system.engine.getReadModel());
      expect(state.threads.find((entry) => entry.id === parentId)?.activities).toEqual([]);
      expect(state.threads.find((entry) => entry.id === parentId)?.queuedTurns).toEqual([]);
      rejectQueue = false;
      await system.run(
        system.engine.dispatch({ ...report, commandId: CommandId.make("report-retry") }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("wait-parent"),
          threadId: parentId,
          childWait: {
            mode: "all",
            assignments: [{ childThreadId: childId, assignmentId: MessageId.make("assignment") }],
          },
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make("stop-parent"),
          threadId: parentId,
          createdAt: at,
        }),
      );
      await system.dispose();
      system = await createOrchestrationSystem(undefined, dbPath);
      state = await system.run(system.engine.getReadModel());
      const parent = state.threads.find((entry) => entry.id === parentId)!;
      expect(parent.nudging?.paused).toBe(true);
      expect(parent.nudging?.wait?.mode).toBe("all");
      expect(
        state.threads.find((entry) => entry.id === childId)?.nudging?.delegation?.decision?.decision
          ?.question,
      ).toBe("Which migration approach?");
      expect(parent.queuedTurns).toHaveLength(1);
      expect(
        (await system.run(system.snapshots.getShellSnapshot())).threads.find(
          (entry) => entry.id === parentId,
        )?.hasPendingQueuedTurn,
      ).toBe(false);
      expect(
        state.threads.find((entry) => entry.id === childId)?.nudging?.delegation?.assignmentId,
      ).toBe("assignment");
      await system.run(
        system.engine.dispatch({ ...report, commandId: CommandId.make("report-after-restart") }),
      );
      expect(
        (await system.run(system.engine.getReadModel())).threads.find(
          (entry) => entry.id === parentId,
        )?.queuedTurns,
      ).toEqual(parent.queuedTurns);
      await system.run(
        system.engine.dispatch({
          type: "thread.queued-turn.delete",
          commandId: CommandId.make("dismiss"),
          threadId: parentId,
          queuedTurnId: parent.queuedTurns![0]!.id,
          deletedAt: at,
        }),
      );
      await system.run(
        system.engine.dispatch({ ...report, commandId: CommandId.make("report-after-dismiss") }),
      );
      const persisted = await system.run(system.snapshots.getSnapshot());
      expect(persisted.threads.find((entry) => entry.id === parentId)?.queuedTurns).toEqual([]);
      expect(
        persisted.threads
          .find((entry) => entry.id === parentId)
          ?.activities.filter((activity) => activity.kind === "child.lifecycle.reported"),
      ).toHaveLength(1);
      await system.run(
        system.engine.dispatch({
          ...report,
          reportId: "decision-2",
          supersedesReportId: `report:${childId}:assignment:decision-1`,
          commandId: CommandId.make("second-report"),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("resume-parent"),
          threadId: parentId,
          childFollowUpPaused: false,
        }),
      );
      const queued = (await system.run(system.engine.getReadModel())).threads.find(
        (entry) => entry.id === parentId,
      )!.queuedTurns![0]!;
      await system.run(
        system.engine.dispatch({
          type: "thread.queued-turn.dispatch",
          commandId: CommandId.make("dispatch-nudge"),
          threadId: parentId,
          queuedTurnId: queued.id,
          dispatchedAt: now(),
        }),
      );
      await system.dispose();
      system = await createOrchestrationSystem(undefined, dbPath);
      const recovered = (await system.run(system.engine.getReadModel())).threads.find(
        (entry) => entry.id === parentId,
      )!;
      expect(recovered.queuedTurns).toEqual([]);
      expect(
        recovered.messages.filter((message) => message.origin?.kind === "child-nudge"),
      ).toHaveLength(1);
    } finally {
      await system.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts stale conditional metadata as a durable no-op through real dispatch", async () => {
    const projected: OrchestrationEvent[] = [];
    const system = await createOrchestrationSystem((event) =>
      Effect.sync(() => {
        projected.push(event);
      }),
    );
    const projectId = ProjectId.make("conditional-project");
    const threadId = ThreadId.make("conditional-thread");
    const createdAt = now();
    try {
      await mkdir("/tmp/conditional-metadata", { recursive: true });
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("conditional-project"),
          projectId,
          title: "Conditional metadata",
          workspaceRoot: "/tmp/conditional-project-root",
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("conditional-thread"),
          threadId,
          projectId,
          title: "Conditional metadata",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: "feature",
          worktreePath: "/tmp/conditional-metadata",
          createdAt,
        }),
      );
      const before = await system.run(system.engine.getReadModel());
      const pullRequest = {
        number: 42,
        title: "Recovered",
        url: "https://github.com/acme/app/pull/42",
        baseBranch: "main",
        headBranch: "feature",
        state: "open" as const,
      };
      const command = {
        type: "thread.meta.update" as const,
        commandId: CommandId.make("stale-conditional"),
        threadId,
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
        pullRequest,
      };
      const eventCount = projected.length;
      const result = await system.run(system.engine.dispatch(command));
      expect(result.sequence).toBe(before.snapshotSequence);
      expect(await system.run(system.engine.getReadModel())).toEqual(before);
      expect(projected).toHaveLength(eventCount);

      // A retry whose precondition now matches must still replay the receipt.
      expect(
        await system.run(
          system.engine.dispatch({
            ...command,
            expectedUpdatedAt: before.threads[0]!.updatedAt,
          }),
        ),
      ).toEqual(result);
      expect(projected).toHaveLength(eventCount);
      expect(await system.run(system.engine.getReadModel())).toEqual(before);

      await system.run(
        system.engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("move-project-checkout"),
          projectId,
          workspaceRoot: "/tmp/moved-checkout",
        }),
      );
      const afterMove = await system.run(system.engine.getReadModel());
      expect(afterMove.threads[0]?.updatedAt).toBe(before.threads[0]?.updatedAt);
      const staleWorkspaceCommand = {
        ...command,
        commandId: CommandId.make("stale-workspace"),
        expectedUpdatedAt: before.threads[0]!.updatedAt,
        expectedWorkspaceCwd: "/tmp/moved-checkout",
      };
      const staleWorkspaceResult = await system.run(system.engine.dispatch(staleWorkspaceCommand));
      expect(staleWorkspaceResult.sequence).toBe(afterMove.snapshotSequence);
      expect(await system.run(system.engine.getReadModel())).toEqual(afterMove);
      expect(projected).toHaveLength(eventCount + 1);
      expect(
        await system.run(
          system.engine.dispatch({
            ...staleWorkspaceCommand,
            expectedWorkspaceCwd: "/tmp/conditional-metadata",
          }),
        ),
      ).toEqual(staleWorkspaceResult);
      expect(await system.run(system.engine.getReadModel())).toEqual(afterMove);

      await system.run(
        system.engine.dispatch({
          ...command,
          commandId: CommandId.make("fresh-conditional"),
          expectedUpdatedAt: before.threads[0]!.updatedAt,
        }),
      );
      expect((await system.run(system.engine.getReadModel())).threads[0]?.pullRequest).toEqual(
        pullRequest,
      );
      expect(projected).toHaveLength(eventCount + 2);

      await system.run(
        system.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("clear-child-wait"),
          threadId,
          childWait: null,
        }),
      );
      const clearedWait = await system.run(system.engine.getReadModel());
      const pruneCommand = {
        type: "thread.child.wait.prune" as const,
        commandId: CommandId.make("prune-cleared-child-wait"),
        threadId,
        assignments: [
          {
            childThreadId: ThreadId.make("missing-child"),
            assignmentId: MessageId.make("missing-assignment"),
          },
        ],
      };
      const pruned = await system.run(system.engine.dispatch(pruneCommand));
      expect(pruned.sequence).toBe(clearedWait.snapshotSequence);
      expect(await system.run(system.engine.getReadModel())).toEqual(clearedWait);
      expect(await system.run(system.engine.dispatch(pruneCommand))).toEqual(pruned);
    } finally {
      await system.dispose();
    }
  });

  for (const queued of [false, true]) {
    for (const first of ["manual", "admission"] as const) {
      it(`serializes ${queued ? "queued" : "direct"} admission through pending commit when ${first} acquires first`, async () => {
        const projecting = Effect.runSync(Deferred.make<void>());
        const releaseProjection = Effect.runSync(Deferred.make<void>());
        const manualEntered = Effect.runSync(Deferred.make<void>());
        const releaseManual = Effect.runSync(Deferred.make<void>());
        const admissionAttempted = Effect.runSync(Deferred.make<void>());
        const commandId = CommandId.make("coordinated-admission");
        const system = await createOrchestrationSystem((event) =>
          event.commandId === commandId && event.type === "thread.turn-start-requested"
            ? Deferred.succeed(projecting, undefined).pipe(
                Effect.andThen(Deferred.await(releaseProjection)),
              )
            : Effect.void,
        );
        const cwd = "/tmp/coordinated-admission-worktree";
        const threadId = ThreadId.make("coordinated-thread");
        const projectId = ProjectId.make("coordinated-project");
        const createdAt = now();
        const queuedTurnId = QueuedTurnId.make("coordinated-queue");
        const message = {
          messageId: MessageId.make("coordinated-message"),
          role: "user" as const,
          text: "hello",
          attachments: [],
        };
        let admission: Promise<unknown> | undefined;
        let manual: Promise<unknown> | undefined;
        try {
          await system.run(
            system.engine.dispatch({
              type: "project.create",
              commandId: CommandId.make("coordinated-project"),
              projectId,
              title: "Coordination",
              workspaceRoot: "/tmp/coordinated-admission-project",
              defaultModelSelection: null,
              createdAt,
            }),
          );
          await system.run(
            system.engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make("coordinated-thread"),
              threadId,
              projectId,
              title: "Coordination",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5-codex",
              },
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "approval-required",
              branch: null,
              worktreePath: cwd,
              createdAt,
            }),
          );
          if (queued) {
            await system.run(
              system.engine.dispatch({
                type: "thread.queued-turn.create",
                commandId: CommandId.make("coordinated-enqueue"),
                threadId,
                queuedTurnId,
                message,
                runtimeMode: "approval-required",
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                createdAt,
              }),
            );
          }
          const dispatch = () =>
            system.run(
              system.engine.dispatch(
                queued
                  ? {
                      type: "thread.queued-turn.dispatch",
                      commandId,
                      threadId,
                      queuedTurnId,
                      dispatchedAt: createdAt,
                    }
                  : {
                      type: "thread.turn.start",
                      commandId,
                      threadId,
                      message,
                      runtimeMode: "approval-required",
                      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                      createdAt,
                    },
              ),
            );
          if (first === "manual") {
            manual = system.run(
              system.coordinator.withCheckout(
                cwd,
                Deferred.succeed(manualEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseManual)),
                ),
              ),
            );
            await system.run(Deferred.await(manualEntered));
            const withCheckout = system.coordinator.withCheckout;
            vi.spyOn(system.coordinator, "withCheckout").mockImplementation((path, effect) =>
              Deferred.succeed(admissionAttempted, undefined).pipe(
                Effect.andThen(withCheckout(path, effect)),
              ),
            );
            admission = dispatch();
            await system.run(Deferred.await(admissionAttempted));
            expect(await system.run(Deferred.isDone(projecting))).toBe(false);
            expect(
              (await system.run(system.engine.getReadModel())).threads[0]?.latestTurn,
            ).toBeNull();
            await system.run(Deferred.succeed(releaseManual, undefined));
            await manual;
          } else {
            admission = dispatch();
          }
          await system.run(Deferred.await(projecting));
          expect(
            Option.isNone(await system.run(system.coordinator.tryWithCheckout(cwd, Effect.void))),
          ).toBe(true);
          expect(
            (await system.run(system.engine.getReadModel())).threads[0]?.latestTurn,
          ).toBeNull();
          await system.run(Deferred.succeed(releaseProjection, undefined));
          await admission;
          const observed = await system.run(
            system.coordinator.withCheckout(cwd, system.engine.getReadModel()),
          );
          expect(observed.threads[0]).toBeDefined();
          expect(observed.threads.some(threadHasInFlightTurn)).toBe(true);
          expect(
            observed.threads[0]?.messages.some((entry) => entry.id === message.messageId),
          ).toBe(true);
          if (queued) expect(observed.threads[0]?.queuedTurns).toEqual([]);
        } finally {
          await system.run(Deferred.succeed(releaseManual, undefined));
          await system.run(Deferred.succeed(releaseProjection, undefined));
          await Promise.allSettled([admission, manual]);
          vi.restoreAllMocks();
          await system.dispose();
        }
      });
    }
  }

  it("deduplicates semantic child lifecycle notifications transactionally", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("project-lifecycle-dedup");
    const parentThreadId = ThreadId.make("parent-lifecycle-dedup");
    const childThreadId = ThreadId.make("child-lifecycle-dedup");
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };

    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-lifecycle-dedup"),
          projectId,
          title: "Lifecycle dedup",
          workspaceRoot: "/tmp/project-lifecycle-dedup",
          defaultModelSelection: null,
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-parent-lifecycle-dedup"),
          threadId: parentThreadId,
          projectId,
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-child-lifecycle-dedup"),
          threadId: childThreadId,
          projectId,
          parentThreadId,
          title: "Child",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );

      for (const suffix of ["first", "retry"] as const) {
        await system.run(
          system.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`cmd-approval-${suffix}`),
            threadId: childThreadId,
            activity: {
              id: EventId.make(`activity-approval-${suffix}`),
              tone: "approval",
              kind: "approval.requested",
              summary: "Approval required",
              payload: { requestId: "approval-42" },
              turnId: TurnId.make("turn-approval"),
              createdAt: now(),
            },
            createdAt: now(),
          }),
        );
      }

      const events = await system.run(
        Stream.runCollect(system.engine.readEvents(0)).pipe(
          Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
        ),
      );
      expect(
        events.filter(
          (event) =>
            event.type === "thread.child-lifecycle-notified" &&
            event.payload.lifecycle === "approval-required",
        ),
      ).toHaveLength(1);
      expect(events.filter((event) => event.type === "thread.activity-appended")).toHaveLength(2);
    } finally {
      await system.dispose();
    }
  });

  it("does not block assigning a worktree for an unreserved cleanup intent", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const projectId = asProjectId("project-pending-worktree");
    const deletedThreadId = ThreadId.make("deleted-thread-pending-worktree");
    const threadId = ThreadId.make("thread-pending-worktree");
    const worktreePath = "/tmp/pending-worktree";

    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-pending-worktree"),
          projectId,
          title: "Pending Worktree",
          workspaceRoot: "/tmp/project-pending-worktree",
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-deleted-thread-pending-worktree"),
          threadId: deletedThreadId,
          projectId,
          title: "Deleted Pending Worktree",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: "feature/deleted-pending-worktree",
          worktreePath: "/tmp/pending-parent/../pending-worktree",
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("cmd-delete-pending-worktree"),
          threadId: deletedThreadId,
          cleanupWorktree: true,
        }),
      );
      const deletedOwnership = await system.run(
        system.workspaceOwnership.getByThreadId(deletedThreadId),
      );
      for (const ownership of deletedOwnership) {
        await system.run(
          system.workspaceOwnership.release(deletedThreadId, ownership.canonicalPath),
        );
      }

      const retryableCommand = {
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-pending-worktree"),
        threadId,
        projectId,
        title: "Pending Worktree",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: "feature/pending-worktree",
        worktreePath,
        createdAt,
      } as const;

      await expect(system.run(system.engine.dispatch(retryableCommand))).resolves.toEqual({
        sequence: 4,
      });
    } finally {
      await system.dispose();
    }
  });

  it("blocks unarchive while cleanup holds the removal reservation", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const projectId = asProjectId("project-reserved-unarchive");
    const threadId = ThreadId.make("thread-reserved-unarchive");
    const worktreePath = "/tmp/reserved-unarchive";

    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-reserved-unarchive"),
          projectId,
          title: "Reserved unarchive",
          workspaceRoot: "/tmp/project-reserved-unarchive",
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-reserved-unarchive"),
          threadId,
          projectId,
          title: "Reserved unarchive",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: "feature/reserved-unarchive",
          worktreePath,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-archive-reserved-unarchive"),
          threadId,
        }),
      );

      await system.run(
        system.worktreeCleanupJobs.enqueue({
          threadId,
          cwd: "/tmp/project-reserved-unarchive",
          worktreePath,
          canonicalWorktreePath: worktreePath,
          requestedAt: createdAt,
          source: "archive",
          allowTerminalReset: false,
        }),
      );
      const reservation = await system.run(
        system.worktreeCleanupJobs.tryReserveForRemoval({
          threadId,
          canonicalWorktreePath: worktreePath,
          reservedAt: createdAt,
        }),
      );
      expect(Option.isSome(reservation)).toBe(true);
      expect(
        (await system.run(system.worktreeCleanupJobs.getByThreadId(threadId))).pipe(
          Option.getOrThrow,
        ).status,
      ).toBe("removing");
      expect(await system.run(system.worktreeCleanupJobs.hasReservationByPath(worktreePath))).toBe(
        true,
      );

      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make("cmd-unarchive-reserved-unarchive"),
            threadId,
          }),
        ),
      ).rejects.toThrow("cleanup");
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-resume-reserved-unarchive"),
            threadId,
            message: {
              messageId: MessageId.make("message-resume-reserved-unarchive"),
              role: "user",
              text: "resume",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          }),
        ),
      ).rejects.toThrow("cleanup");
      expect(
        (await system.run(system.worktreeCleanupJobs.getByThreadId(threadId))).pipe(
          Option.getOrThrow,
        ).status,
      ).toBe("removing");
    } finally {
      await system.dispose();
    }
  });

  it("bootstraps the in-memory read model from persisted projections", async () => {
    const bootstrapStarted = Effect.runSync(Deferred.make<void>());
    const releaseBootstrap = Effect.runSync(Deferred.make<void>());
    const failOnHistoricalReplayStore: OrchestrationEventStoreShape = {
      append: () =>
        Effect.fail(
          new PersistenceSqlError({
            operation: "test.append",
            detail: "append should not be called during bootstrap",
          }),
        ),
      readFromSequence: () => Stream.empty,
      readAll: () =>
        Stream.fail(
          new PersistenceSqlError({
            operation: "test.readAll",
            detail: "historical replay should not be used during bootstrap",
          }),
        ),
    };

    const projectionSnapshot = {
      snapshotSequence: 7,
      updatedAt: "2026-03-03T00:00:04.000Z",
      projects: [
        {
          id: asProjectId("project-bootstrap"),
          title: "Bootstrap Project",
          workspaceRoot: "/tmp/project-bootstrap",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [],
          createdAt: "2026-03-03T00:00:00.000Z",
          updatedAt: "2026-03-03T00:00:01.000Z",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: ThreadId.make("thread-bootstrap"),
          projectId: asProjectId("project-bootstrap"),
          title: "Bootstrap Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access" as const,
          pendingRuntimeMode: null,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-03-03T00:00:02.000Z",
          updatedAt: "2026-03-03T00:00:03.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      ],
    };

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(
        Layer.succeed(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.succeed(projectionSnapshot),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getActiveChatArchiveEntries: () => Effect.succeed([]),
          getSnapshotSequence: () => Effect.succeed(projectionSnapshot.snapshotSequence),
          getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadShellProjectContextById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
          listThreadProjectIds: () => Effect.die("unused"),
          getThreadActivitiesPage: () => Effect.die("unused"),
          readThread: () => Effect.die("unused"),
        }),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationProjectionPipeline, {
          bootstrap: Deferred.succeed(bootstrapStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseBootstrap)),
          ),
          projectEvent: () => Effect.succeed({ reconcile: Effect.void }),
        } satisfies OrchestrationProjectionPipelineShape),
      ),
      Layer.provide(Layer.succeed(OrchestrationEventStore, failOnHistoricalReplayStore)),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );

    const runtime = ManagedRuntime.make(layer);

    const enginePromise = runtime.runPromise(Effect.service(OrchestrationEngineService));
    await Effect.runPromise(Deferred.await(bootstrapStarted));
    const acquisitionResult = await Promise.race([
      enginePromise.then(() => "acquired" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);
    await Effect.runPromise(Deferred.succeed(releaseBootstrap, undefined));

    expect(acquisitionResult).toBe("acquired");

    const engine = await enginePromise;
    const readModel = await runtime.runPromise(engine.getReadModel());

    expect(readModel.snapshotSequence).toBe(7);
    expect(readModel.projects).toHaveLength(1);
    expect(readModel.projects[0]?.title).toBe("Bootstrap Project");
    expect(readModel.threads).toHaveLength(1);
    expect(readModel.threads[0]?.title).toBe("Bootstrap Thread");

    await runtime.dispose();
  });

  it("fails dispatches when projection bootstrap fails", async () => {
    const bootstrapError = new PersistenceSqlError({
      operation: "test.bootstrap",
      detail: "bootstrap failed",
    });
    const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-orchestration-bootstrap-failure-test-",
    });
    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(
          Layer.succeed(OrchestrationProjectionPipeline, {
            bootstrap: Effect.fail(bootstrapError),
            projectEvent: () => Effect.succeed({ reconcile: Effect.void }),
          } satisfies OrchestrationProjectionPipelineShape),
        ),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolverLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(serverConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));

    await expect(
      runtime.runPromise(
        engine
          .dispatch({
            type: "project.create",
            commandId: CommandId.make("cmd-project-bootstrap-failure"),
            projectId: asProjectId("project-bootstrap-failure"),
            title: "Bootstrap Failure",
            workspaceRoot: "/tmp/project-bootstrap-failure",
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            createdAt: now(),
          })
          .pipe(Effect.timeout("1 second")),
      ),
    ).rejects.toThrow("bootstrap failed");

    await runtime.dispose();
  });

  it("returns deterministic read models for repeated reads", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-1-create"),
        projectId: asProjectId("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-1-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("msg-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const readModelA = await system.run(engine.getReadModel());
    const readModelB = await system.run(engine.getReadModel());
    expect(readModelB).toEqual(readModelA);
    await system.dispose();
  });

  it("archives and unarchives threads through orchestration commands", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-archive-create"),
        projectId: asProjectId("project-archive"),
        title: "Project Archive",
        workspaceRoot: "/tmp/project-archive",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-archive-create"),
        threadId: ThreadId.make("thread-archive"),
        projectId: asProjectId("project-archive"),
        title: "Archive me",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-thread-archive-running-session"),
        threadId: ThreadId.make("thread-archive"),
        session: {
          threadId: ThreadId.make("thread-archive"),
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: asTurnId("turn-stale-running"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-thread-archive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.run(engine.getReadModel())).threads.find(
        (thread) => thread.id === "thread-archive",
      )?.archivedAt,
    ).not.toBeNull();

    await system.run(
      engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("cmd-thread-unarchive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.run(engine.getReadModel())).threads.find(
        (thread) => thread.id === "thread-archive",
      )?.archivedAt,
    ).toBeNull();
    expect(
      (await system.run(engine.getReadModel())).threads.find(
        (thread) => thread.id === "thread-archive",
      )?.session?.activeTurnId,
    ).toBeNull();

    await system.run(
      engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("cmd-thread-unarchive-already-active"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.run(engine.getReadModel())).threads.find(
        (thread) => thread.id === "thread-archive",
      )?.archivedAt,
    ).toBeNull();

    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-thread-start-after-unarchive"),
        threadId: ThreadId.make("thread-archive"),
        message: {
          messageId: asMessageId("msg-start-after-unarchive"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt,
      }),
    );

    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-replay-create"),
        projectId: asProjectId("project-replay"),
        title: "Replay Project",
        workspaceRoot: "/tmp/project-replay",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-replay-create"),
        threadId: ThreadId.make("thread-replay"),
        projectId: asProjectId("project-replay"),
        title: "replay",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-thread-replay-delete"),
        threadId: ThreadId.make("thread-replay"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.deleted",
    ]);
    await system.dispose();
  });

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-stream-create"),
        projectId: asProjectId("project-stream"),
        title: "Stream Project",
        workspaceRoot: "/tmp/project-stream",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const eventTypes: string[] = [];
    await system.run(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        );
        yield* Effect.sleep("10 millis");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-stream-thread-create"),
          threadId: ThreadId.make("thread-stream"),
          projectId: asProjectId("project-stream"),
          title: "domain-stream",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-stream-thread-update"),
          threadId: ThreadId.make("thread-stream"),
          title: "domain-stream-updated",
        });
        eventTypes.push((yield* Queue.take(eventQueue)).type);
        eventTypes.push((yield* Queue.take(eventQueue)).type);
      }).pipe(Effect.scoped),
    );

    expect(eventTypes).toEqual(["thread.created", "thread.meta-updated"]);
    await system.dispose();
  });

  it("records command ack duration using the first committed event type", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-ack-create"),
        projectId: asProjectId("project-ack"),
        title: "Ack Project",
        workspaceRoot: "/tmp/project-ack",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-ack-create"),
        threadId: ThreadId.make("thread-ack"),
        projectId: asProjectId("project-ack"),
        title: "Ack Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_command_ack_duration", {
        commandType: "thread.create",
        aggregateKind: "thread",
        ackEventType: "thread.created",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("records failed command dispatches as metric failures", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-missing-project"),
          threadId: ThreadId.make("thread-missing-project"),
          projectId: asProjectId("project-missing"),
          title: "Missing Project Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("does not exist");

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_commands_total", {
        commandType: "thread.create",
        aggregateKind: "thread",
        outcome: "failure",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("stores completed checkpoint summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-turn-diff-create"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn Diff Project",
        workspaceRoot: "/tmp/project-turn-diff",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-turn-diff-create"),
        threadId: ThreadId.make("thread-turn-diff"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn diff thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-turn-diff-complete"),
        threadId: ThreadId.make("thread-turn-diff"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        agentTouchedPaths: [],
        turnFiles: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = (await system.run(engine.getReadModel())).threads.find(
      (entry) => entry.id === "thread-turn-diff",
    );
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        agentTouchedPaths: [],
        turnFiles: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ]);
    await system.dispose();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.make("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-orchestration-engine-test-",
    });

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolverLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();
    const flakyWorkspace = `/tmp/t3-orchestration-flaky-${process.pid}`;
    await mkdir(flakyWorkspace, { recursive: true });

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-flaky-create"),
        projectId: asProjectId("project-flaky"),
        title: "Flaky Project",
        workspaceRoot: "/tmp/project-flaky",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-flaky-1"),
          threadId: ThreadId.make("thread-flaky-fail"),
          projectId: asProjectId("project-flaky"),
          title: "flaky-fail",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: flakyWorkspace,
          createdAt,
        }),
      ),
    ).rejects.toThrow("append failed");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-flaky-2"),
        threadId: ThreadId.make("thread-flaky-ok"),
        projectId: asProjectId("project-flaky"),
        title: "flaky-ok",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: `${flakyWorkspace}-ok`,
        createdAt,
      }),
    );

    expect(result.sequence).toBe(2);
    expect((await runtime.runPromise(engine.getReadModel())).snapshotSequence).toBe(2);
    await runtime.dispose();
  });

  it("rolls back all events for a multi-event command when projection fails mid-dispatch", async () => {
    let shouldFailRequestedProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) => {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.make("cmd-turn-start-atomic") &&
          event.type === "thread.turn-start-requested"
        ) {
          shouldFailRequestedProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.succeed({ reconcile: Effect.void });
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolverLive),
        Layer.provide(SqlitePersistenceMemory),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-atomic-create"),
        projectId: asProjectId("project-atomic"),
        title: "Atomic Project",
        workspaceRoot: "/tmp/project-atomic",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-atomic-create"),
        threadId: ThreadId.make("thread-atomic"),
        projectId: asProjectId("project-atomic"),
        title: "atomic",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: "/tmp/t3-orchestration-atomic-thread",
        createdAt,
      }),
    );

    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("cmd-turn-start-atomic"),
      threadId: ThreadId.make("thread-atomic"),
      message: {
        messageId: asMessageId("msg-atomic-1"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };

    await expect(runtime.runPromise(engine.dispatch(turnStartCommand))).rejects.toThrow(
      "projection failed",
    );

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);
    expect((await runtime.runPromise(engine.getReadModel())).snapshotSequence).toBe(2);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(4);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(
      eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
    ).toHaveLength(2);

    await runtime.dispose();
  });

  it("runs projection reconciliation after the command receipt commits", async () => {
    let observedCommittedReceipt = false;
    const projectionPipelineLayer = Layer.effect(
      OrchestrationProjectionPipeline,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          bootstrap: Effect.void,
          projectEvent: (event) =>
            Effect.succeed({
              reconcile: sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count
                FROM orchestration_command_receipts
                WHERE command_id = ${event.commandId}
                  AND status = 'accepted'
              `.pipe(
                Effect.map((rows) => {
                  observedCommittedReceipt = rows[0]?.count === 1;
                }),
                Effect.mapError(toPersistenceSqlError("test.postCommitReconciliation")),
              ),
            }),
        } satisfies OrchestrationProjectionPipelineShape;
      }),
    );
    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(projectionPipelineLayer),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolverLive),
        Layer.provide(SqlitePersistenceMemory),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-post-commit-reconciliation"),
        projectId: asProjectId("project-post-commit-reconciliation"),
        title: "Post-commit reconciliation",
        workspaceRoot: "/tmp/project-post-commit-reconciliation",
        defaultModelSelection: null,
        createdAt: now(),
      }),
    );

    expect(observedCommittedReceipt).toBe(true);
    await runtime.dispose();
  });

  it("reconciles in-memory state when append persists but projection fails", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.make("cmd-thread-meta-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.succeed({ reconcile: Effect.void });
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolverLive),
        Layer.provide(SqlitePersistenceMemory),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-sync-create"),
        projectId: asProjectId("project-sync"),
        title: "Sync Project",
        workspaceRoot: "/tmp/project-sync",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-sync-create"),
        threadId: ThreadId.make("thread-sync"),
        projectId: asProjectId("project-sync"),
        title: "sync-before",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: "/tmp/t3-orchestration-sync-thread",
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-thread-meta-sync-fail"),
          threadId: ThreadId.make("thread-sync"),
          title: "sync-after-failed-projection",
        }),
      ),
    ).rejects.toThrow("projection failed");

    const readModelAfterFailure = await runtime.runPromise(engine.getReadModel());
    const updatedThread = readModelAfterFailure.threads.find(
      (thread) => thread.id === "thread-sync",
    );
    expect(readModelAfterFailure.snapshotSequence).toBe(3);
    expect(updatedThread?.title).toBe("sync-after-failed-projection");

    await runtime.dispose();
  });

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-invariant-missing-thread"),
          threadId: ThreadId.make("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-duplicate-1"),
        threadId: ThreadId.make("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-duplicate-2"),
          threadId: ThreadId.make("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });
  it("honors explicit current-checkout threads without allocating a worktree, and isolates legacy root bindings", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const initRepository = async (prefix: string): Promise<string> => {
      const directory = await mkdtemp(join(tmpdir(), prefix));
      execFileSync("git", ["init"], { cwd: directory });
      execFileSync("git", ["config", "user.email", "t3-test@example.com"], {
        cwd: directory,
      });
      execFileSync("git", ["config", "user.name", "t3-test"], { cwd: directory });
      execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: directory });
      return directory;
    };
    const explicitRepositoryDir = await initRepository("t3-explicit-checkout-");
    // A separate repository so the legacy thread never contends with the
    // explicit thread for ownership of the same checkout.
    const legacyRepositoryDir = await initRepository("t3-legacy-checkout-");
    const canonicalExplicitDir = await canonicalizeWorktreePath(explicitRepositoryDir);
    const canonicalLegacyDir = await canonicalizeWorktreePath(legacyRepositoryDir);
    const isolatedParentFor = (canonicalDir: string): string =>
      join(
        dirname(canonicalDir),
        ".t3-thread-workspaces",
        createHash("sha256").update(canonicalDir).digest("hex").slice(0, 16),
      );
    const explicitIsolatedParentDir = isolatedParentFor(canonicalExplicitDir);
    const legacyIsolatedParentDir = isolatedParentFor(canonicalLegacyDir);
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };

    const createProject = (projectId: ProjectId, workspaceRoot: string, commandId: string) =>
      system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(commandId),
          projectId,
          title: projectId,
          workspaceRoot,
          createdAt: now(),
        }),
      );
    const createCheckoutThread = (
      threadId: ThreadId,
      projectId: ProjectId,
      commandId: string,
      workspaceRoot: string,
    ) =>
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(commandId),
          threadId,
          projectId,
          title: threadId,
          modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: workspaceRoot,
          createdAt: now(),
        }),
      );
    const startTurn = (threadId: ThreadId, commandId: string, messageId: string) =>
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId,
          message: {
            messageId: asMessageId(messageId),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      );

    try {
      const explicitProjectId = ProjectId.make("explicit-checkout-project");
      await createProject(
        explicitProjectId,
        explicitRepositoryDir,
        "explicit-checkout-project-create",
      );

      const explicitThreadId = ThreadId.make("explicit-checkout-thread");
      await createCheckoutThread(
        explicitThreadId,
        explicitProjectId,
        "explicit-checkout-thread-create",
        explicitRepositoryDir,
      );

      let readModel = await system.run(engine.getReadModel());
      const created = readModel.threads.find((entry) => entry.id === explicitThreadId);
      expect(created?.worktreePath).toBe(canonicalExplicitDir);
      expect(created?.workspaceBinding?.workspaceScope).toBe("project-checkout");

      await startTurn(explicitThreadId, "explicit-checkout-turn", "explicit-checkout-msg");
      readModel = await system.run(engine.getReadModel());
      const afterTurn = readModel.threads.find((entry) => entry.id === explicitThreadId);
      expect(afterTurn?.worktreePath).toBe(canonicalExplicitDir);
      expect(afterTurn?.workspaceBinding?.workspaceScope).toBe("project-checkout");
      expect(existsSync(explicitIsolatedParentDir)).toBe(false);

      const legacyProjectId = ProjectId.make("legacy-checkout-project");
      await createProject(legacyProjectId, legacyRepositoryDir, "legacy-checkout-project-create");
      const legacyThreadId = ThreadId.make("legacy-checkout-thread");
      await createCheckoutThread(
        legacyThreadId,
        legacyProjectId,
        "legacy-checkout-thread-create",
        legacyRepositoryDir,
      );
      // Simulate a legacy root binding: same persisted checkout path, but no
      // recorded current-checkout scope.
      await system.run(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("legacy-checkout-clear-binding"),
          threadId: legacyThreadId,
          workspaceBinding: null,
        }),
      );

      await startTurn(legacyThreadId, "legacy-checkout-turn", "legacy-checkout-msg");
      readModel = await system.run(engine.getReadModel());
      const isolated = readModel.threads.find((entry) => entry.id === legacyThreadId);
      expect(isolated?.worktreePath).not.toBe(canonicalLegacyDir);
      expect(isolated?.worktreePath?.startsWith(`${legacyIsolatedParentDir}${sep}`)).toBe(true);
      expect(isolated?.branch?.startsWith("t3/thread/")).toBe(true);
      expect(isolated?.workspaceBinding?.workspaceScope).toBeUndefined();
    } finally {
      await system.dispose();
      await rm(explicitIsolatedParentDir, { recursive: true, force: true });
      await rm(legacyIsolatedParentDir, { recursive: true, force: true });
      await rm(explicitRepositoryDir, { recursive: true, force: true });
      await rm(legacyRepositoryDir, { recursive: true, force: true });
    }
  });
});
