import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
  QueuedTurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  PubSub,
  Scope,
  Stream,
} from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { CheckpointInvariantError } from "../../checkpointing/Errors.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  checkpointBaselineRefForThreadTurn,
  checkpointRefForThreadTurn,
  checkpointRevertGuardRefForThread,
} from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { WorkspaceEntriesLive } from "../../workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceEntries } from "../../workspace/Services/WorkspaceEntries.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";
import { CheckoutCoordinator } from "../../git/CheckoutCoordinator.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { ReviewSnapshotVerifier } from "../Services/ReviewSnapshotVerifier.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { WorkspaceOwnershipRepository } from "../../persistence/Services/WorkspaceOwnership.ts";
import { WorkspaceOwnershipRepositoryLive } from "../../persistence/Layers/WorkspaceOwnership.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = ProviderDriverKind.make("codex"),
  failRollback = false,
  defectRollback = false,
) {
  const now = new Date().toISOString();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  let runtimeSubscriptions = 0;
  const rollbackConversation = vi.fn(
    (_input: { readonly threadId: ThreadId; readonly numTurns: number }) =>
      defectRollback
        ? Effect.die(new Error("Injected rollback defect."))
        : failRollback
          ? Effect.fail(
              new ProviderAdapterRequestError({
                provider: String(providerName),
                method: "rollbackConversation",
                detail: "Injected rollback failure.",
              }),
            )
          : Effect.void,
  );

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () =>
    hasSession
      ? Effect.succeed([
          {
            provider: providerName,
            status: "ready",
            runtimeMode: "full-access",
            threadId: ThreadId.make("thread-1"),
            cwd: sessionCwd,
            createdAt: now,
            updatedAt: now,
          },
        ] satisfies ReadonlyArray<ProviderSession>)
      : Effect.succeed([] as ReadonlyArray<ProviderSession>);
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    forkSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions,
    prewarmSession: () => Effect.void,
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(providerName),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(providerName),
          continuationKey: `${providerName}:instance:${instanceId}`,
        },
      }),
    rollbackConversation,
    get streamEvents() {
      runtimeSubscriptions++;
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    rollbackConversation,
    emit,
    runtimeSubscriptions: () => runtimeSubscriptions,
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: OrchestrationThread) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<OrchestrationThread> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for orchestration event.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

async function waitForGitFileAtRef(
  cwd: string,
  ref: string,
  filePath: string,
  contents: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    try {
      if (gitShowFileAtRef(cwd, ref, filePath) === contents) {
        return;
      }
    } catch {
      // The ref may not exist until the reactor has captured the baseline.
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for '${filePath}' at '${ref}'.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | CheckpointReactor
    | CheckpointStore
    | CheckoutCoordinator
    | ProviderRuntimeIngestionService
    | WorkspaceOwnershipRepository,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderDriverKind;
    readonly failProviderRollback?: boolean;
    readonly defectProviderRollback?: boolean;
    readonly gitStatusRefreshCalls?: Array<string>;
    readonly failCheckpointCapture?: boolean;
    readonly beforeCheckpointCapture?: (ref: CheckpointRef) => Effect.Effect<void>;
    readonly failDiffWithGenerationMismatch?: boolean;
    readonly failWorkspaceInvalidate?: boolean;
    readonly failRevertGuardRestore?: boolean;
    readonly awaitRuntimeEventProcessed?: (eventId: EventId) => Effect.Effect<void>;
    readonly useRuntimeIngestion?: boolean;
    readonly deferCheckpointStart?: boolean;
  }) {
    const projectRoot = createGitRepository();
    const cwd = path.join(path.dirname(projectRoot), `.t3-test-thread-${randomUUID()}`);
    runGit(projectRoot, ["worktree", "add", "-b", `test/${randomUUID()}`, cwd, "HEAD"]);
    tempDirs.push(cwd, projectRoot);
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? ProviderDriverKind.make("codex"),
      options?.failProviderRollback ?? false,
      options?.defectProviderRollback ?? false,
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
    );

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-checkpoint-reactor-test-",
    });
    const gitStatusBroadcasterLayer = Layer.succeed(GitStatusBroadcaster, {
      getStatus: () => Effect.die("getStatus should not be called in this test"),
      refreshLocalStatus: (cwd: string) =>
        Effect.sync(() => {
          options?.gitStatusRefreshCalls?.push(cwd);
        }).pipe(
          Effect.as({
            isRepo: true,
            hasOriginRemote: false,
            isDefaultBranch: true,
            branch: "main",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
        ),
      refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
      streamStatus: () => Stream.empty,
    });
    const checkpointStoreLayer =
      options?.failCheckpointCapture ||
      options?.beforeCheckpointCapture ||
      options?.failDiffWithGenerationMismatch ||
      options?.failRevertGuardRestore
        ? Layer.effect(
            CheckpointStore,
            Effect.gen(function* () {
              const checkpointStore = yield* CheckpointStore;
              return {
                ...checkpointStore,
                captureCheckpoint: (
                  input: Parameters<typeof checkpointStore.captureCheckpoint>[0],
                ) =>
                  (options.beforeCheckpointCapture?.(input.checkpointRef) ?? Effect.void).pipe(
                    Effect.andThen(
                      options.failCheckpointCapture
                        ? Effect.fail(
                            new CheckpointInvariantError({
                              operation: "CheckpointStore.captureCheckpoint",
                              detail: "Injected capture failure.",
                            }),
                          )
                        : checkpointStore.captureCheckpoint(input),
                    ),
                  ),
                diffCheckpointFiles: (
                  input: Parameters<typeof checkpointStore.diffCheckpointFiles>[0],
                ) =>
                  options?.failDiffWithGenerationMismatch
                    ? Effect.fail(
                        new CheckpointInvariantError({
                          operation: "CheckpointStore.diffCheckpoints",
                          detail: "The from checkpoint does not belong to workspace generation 1.",
                        }),
                      )
                    : checkpointStore.diffCheckpointFiles(input),
                restoreCheckpoint: (
                  input: Parameters<typeof checkpointStore.restoreCheckpoint>[0],
                ) =>
                  options?.failRevertGuardRestore &&
                  input.checkpointRef ===
                    checkpointRevertGuardRefForThread(ThreadId.make("thread-1"))
                    ? Effect.fail(
                        new CheckpointInvariantError({
                          operation: "CheckpointStore.restoreCheckpoint",
                          detail: "Injected guard restore failure.",
                        }),
                      )
                    : checkpointStore.restoreCheckpoint(input),
              };
            }).pipe(Effect.provide(CheckpointStoreLive)),
          )
        : CheckpointStoreLive;

    const ingestionLayer = options?.useRuntimeIngestion
      ? Layer.effect(
          ProviderRuntimeIngestionService,
          Effect.gen(function* () {
            const real = yield* ProviderRuntimeIngestionService;
            return {
              ...real,
              awaitTurnCompletionProcessed: (eventId: EventId) =>
                (options.awaitRuntimeEventProcessed?.(eventId) ?? Effect.void).pipe(
                  Effect.andThen(real.awaitTurnCompletionProcessed(eventId)),
                ),
            };
          }),
        ).pipe(
          Layer.provide(ProviderRuntimeIngestionLive),
          Layer.provideMerge(orchestrationLayer),
          Layer.provide(SqlitePersistenceMemory),
          Layer.provide(ServerSettingsService.layerTest()),
          Layer.provide(
            Layer.succeed(ReviewSnapshotVerifier, {
              currentSnapshot: (input) => Effect.succeed(input.snapshot),
            }),
          ),
        )
      : Layer.succeed(ProviderRuntimeIngestionService, {
          start: (enqueueCheckpointEvent) =>
            Effect.forkScoped(
              Stream.runForEach(provider.service.streamEvents, enqueueCheckpointEvent),
            ).pipe(Effect.asVoid),
          drain: Effect.void,
          awaitTurnCompletionProcessed: options?.awaitRuntimeEventProcessed ?? (() => Effect.void),
        });
    const workspaceEntriesLayer = options?.failWorkspaceInvalidate
      ? Layer.effect(
          WorkspaceEntries,
          Effect.gen(function* () {
            const workspaceEntries = yield* WorkspaceEntries;
            return {
              ...workspaceEntries,
              invalidate: () => Effect.die(new Error("Injected workspace invalidate failure.")),
            };
          }),
        ).pipe(Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))))
      : WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive));
    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(ingestionLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(gitStatusBroadcasterLayer),
      Layer.provideMerge(checkpointStoreLayer),
      Layer.provideMerge(workspaceEntriesLayer),
      Layer.provideMerge(WorkspacePathsLive),
      Layer.provideMerge(GitCoreLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(
        WorkspaceOwnershipRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
      ),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    const workspaceOwnership = await runtime.runPromise(
      Effect.service(WorkspaceOwnershipRepository),
    );
    const coordinator = await runtime.runPromise(Effect.service(CheckoutCoordinator));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(
      ingestion.start(reactor.enqueueRuntimeEvent).pipe(Scope.provide(scope)),
    );
    if (!options?.deferCheckpointStart) {
      await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    }
    const drain = () => Effect.runPromise(reactor.drain);

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? projectRoot,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
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
        worktreePath: options?.threadWorktreePath ?? cwd,
        createdAt,
      }),
    );
    const threadBinding = (await Effect.runPromise(engine.getReadModel())).threads.find(
      (thread) => thread.id === ThreadId.make("thread-1"),
    )?.workspaceBinding;
    const checkpointStoreForHarness = {
      ...checkpointStore,
      captureCheckpoint: (input: Parameters<typeof checkpointStore.captureCheckpoint>[0]) =>
        checkpointStore.captureCheckpoint({
          ...input,
          ...(input.workspaceBinding === undefined && threadBinding !== undefined
            ? { workspaceBinding: threadBinding }
            : {}),
        }),
      checkpointRefMatchesWorkspace: (
        input: Parameters<typeof checkpointStore.checkpointRefMatchesWorkspace>[0],
      ) =>
        checkpointStore.checkpointRefMatchesWorkspace({
          ...input,
          ...(input.workspaceBinding === undefined && threadBinding !== undefined
            ? { workspaceBinding: threadBinding }
            : {}),
        }),
      restoreCheckpoint: (input: Parameters<typeof checkpointStore.restoreCheckpoint>[0]) =>
        checkpointStore.restoreCheckpoint({
          ...input,
          ...(input.workspaceBinding === undefined && threadBinding !== undefined
            ? { workspaceBinding: threadBinding }
            : {}),
        }),
    };

    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStoreForHarness.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStoreForHarness.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStoreForHarness.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        }),
      );
    }

    return {
      engine,
      provider,
      checkpointStore: checkpointStoreForHarness,
      workspaceOwnership,
      coordinator,
      ingestion,
      reactor,
      cwd,
      drain,
    };
  }

  for (const failCheckpointCapture of [false, true]) {
    it(`hands off completion before checkpoint subscriptions start, capture ${failCheckpointCapture ? "failure" : "success"}`, async () => {
      const captureEntered = Effect.runSync(Deferred.make<void>());
      const releaseCapture = Effect.runSync(Deferred.make<void>());
      let captureCount = 0;
      const harness = await createHarness({
        seedFilesystemCheckpoints: false,
        useRuntimeIngestion: true,
        deferCheckpointStart: true,
        failCheckpointCapture,
        beforeCheckpointCapture: (ref) =>
          ref === checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)
            ? Effect.sync(() => {
                captureCount++;
              }).pipe(
                Effect.andThen(Deferred.succeed(captureEntered, undefined)),
                Effect.andThen(Deferred.await(releaseCapture)),
              )
            : Effect.void,
      });
      const threadId = ThreadId.make("thread-1");
      const turnId = asTurnId("turn-startup-gap");
      const createdAt = new Date().toISOString();
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("start-startup-gap"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
        payload: {},
      });
      await Effect.runPromise(harness.ingestion.drain);
      await harness.drain();
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("completion-startup-gap"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
        payload: { state: "completed" },
      });
      try {
        await Effect.runPromise(harness.ingestion.drain);
        await Effect.runPromise(Deferred.await(captureEntered));
        expect(await Effect.runPromise(harness.coordinator.isFinalizing(harness.cwd))).toBe(true);
        expect(
          (await Effect.runPromise(harness.engine.getReadModel())).threads[0]?.session
            ?.activeTurnId,
        ).toBeNull();
        await Effect.runPromise(harness.reactor.start().pipe(Scope.provide(scope!)));
        expect(harness.provider.runtimeSubscriptions()).toBe(1);
        await Effect.runPromise(Deferred.succeed(releaseCapture, undefined));
        await harness.drain();
        expect(captureCount).toBe(1);
        expect(await Effect.runPromise(harness.coordinator.isFinalizing(harness.cwd))).toBe(false);
        const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
        expect(thread?.checkpoints.find((entry) => entry.turnId === turnId)?.status).toBe(
          failCheckpointCapture ? "error" : "ready",
        );
      } finally {
        await Effect.runPromise(Deferred.succeed(releaseCapture, undefined));
      }
    });
  }

  for (const cancelAt of ["receipt", "capture"] as const) {
    it(`releases active and queued completion exclusions when cancelled during ${cancelAt}`, async () => {
      const awaitingReceipt = Effect.runSync(Deferred.make<void>());
      const harness = await createHarness({
        seedFilesystemCheckpoints: false,
        useRuntimeIngestion: true,
        awaitRuntimeEventProcessed: () =>
          cancelAt === "receipt"
            ? Deferred.succeed(awaitingReceipt, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        beforeCheckpointCapture: (ref) =>
          cancelAt === "capture" && ref === checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)
            ? Deferred.succeed(awaitingReceipt, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });
      const createdAt = new Date().toISOString();
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("start-cancel"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-cancel"),
        payload: {},
      });
      await Effect.runPromise(harness.ingestion.drain);
      await harness.drain();
      for (const id of ["completion-cancel-active", "completion-cancel-queued"]) {
        harness.provider.emit({
          type: "turn.completed",
          eventId: EventId.make(id),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-cancel"),
          payload: { state: "completed" },
        });
        await Effect.runPromise(harness.ingestion.drain);
      }
      await Effect.runPromise(Deferred.await(awaitingReceipt));
      expect(await Effect.runPromise(harness.coordinator.isFinalizing(harness.cwd))).toBe(true);
      await runtime!.dispose();
      runtime = null;
      expect(await Effect.runPromise(harness.coordinator.isFinalizing(harness.cwd))).toBe(false);
      const lateEventId = EventId.make("completion-after-shutdown");
      await Effect.runPromise(harness.coordinator.beginFinalization(lateEventId, harness.cwd));
      await Effect.runPromise(
        harness.reactor.enqueueRuntimeEvent({
          type: "turn.completed",
          eventId: lateEventId,
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-cancel"),
          payload: { state: "completed" },
        }),
      );
      expect(await Effect.runPromise(harness.coordinator.isFinalizing(harness.cwd))).toBe(false);
    });
  }

  for (const failCheckpointCapture of [false, true]) {
    it(`waits for ingestion without holding checkout and releases finalization after capture ${failCheckpointCapture ? "failure" : "success"}`, async () => {
      const awaitingReceipt = Effect.runSync(Deferred.make<void>());
      const receipt = Effect.runSync(Deferred.make<void>());
      const manualEntered = Effect.runSync(Deferred.make<void>());
      const releaseManual = Effect.runSync(Deferred.make<void>());
      const admissionAttempted = Effect.runSync(Deferred.make<void>());
      const captureEntered = Effect.runSync(Deferred.make<void>());
      const releaseCapture = Effect.runSync(Deferred.make<void>());
      let manual: Promise<unknown> | undefined;
      let admission: Promise<unknown> | undefined;
      const harness = await createHarness({
        seedFilesystemCheckpoints: false,
        failCheckpointCapture,
        useRuntimeIngestion: true,
        beforeCheckpointCapture: (ref) =>
          ref === checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)
            ? Deferred.succeed(captureEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCapture)),
              )
            : Effect.void,
        awaitRuntimeEventProcessed: () =>
          Deferred.succeed(awaitingReceipt, undefined).pipe(
            Effect.andThen(Deferred.await(receipt)),
          ),
      });
      const threadId = ThreadId.make("thread-1");
      const turnId = asTurnId("turn-coordination");
      const eventId = EventId.make("completion-coordination");
      const createdAt = new Date().toISOString();
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("start-coordination"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
        payload: {},
      });
      await Effect.runPromise(harness.ingestion.drain);
      await harness.drain();
      harness.provider.emit({
        type: "turn.completed",
        eventId,
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
        payload: { state: "completed" },
      });
      try {
        await Effect.runPromise(Deferred.await(awaitingReceipt));
        await Effect.runPromise(harness.ingestion.drain);
        expect(await Effect.runPromise(harness.coordinator.isFinalizing(harness.cwd))).toBe(true);
        expect(
          (await Effect.runPromise(harness.engine.getReadModel())).threads[0]?.session
            ?.activeTurnId,
        ).toBeNull();
        expect(
          Option.isSome(
            await Effect.runPromise(harness.coordinator.tryWithCheckout(harness.cwd, Effect.void)),
          ),
        ).toBe(true);
        manual = Effect.runPromise(
          harness.coordinator.withCheckout(
            harness.cwd,
            Deferred.succeed(manualEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseManual)),
            ),
          ),
        );
        await Effect.runPromise(Deferred.await(manualEntered));
        const withCheckout = harness.coordinator.withCheckout;
        const reservation = vi
          .spyOn(harness.coordinator, "withCheckout")
          .mockImplementation((cwd, effect) =>
            Deferred.succeed(admissionAttempted, undefined).pipe(
              Effect.andThen(withCheckout(cwd, effect)),
            ),
          );
        // The command worker waits for checkout while checkpoints wait for ingestion, not vice versa.
        admission = Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("admission-during-receipt"),
            threadId,
            message: {
              messageId: MessageId.make("admission-during-receipt"),
              role: "user",
              text: "next turn",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          }),
        );
        await Effect.runPromise(Deferred.await(admissionAttempted));
        await Effect.runPromise(Deferred.succeed(releaseManual, undefined));
        await manual;
        await admission;
        reservation.mockRestore();
        expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(false);
        await Effect.runPromise(Deferred.succeed(receipt, undefined));
        await Effect.runPromise(Deferred.await(captureEntered));
        expect(await Effect.runPromise(harness.coordinator.isFinalizing(harness.cwd))).toBe(true);
        await Effect.runPromise(Deferred.succeed(releaseCapture, undefined));
        await harness.drain();
        expect(await Effect.runPromise(harness.coordinator.isFinalizing(harness.cwd))).toBe(false);
        const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
        expect(thread?.checkpoints.find((entry) => entry.turnId === turnId)?.status).toBe(
          failCheckpointCapture ? "error" : "ready",
        );
        expect(
          Option.isSome(
            await Effect.runPromise(harness.coordinator.tryWithCheckout(harness.cwd, Effect.void)),
          ),
        ).toBe(true);
      } finally {
        await Effect.runPromise(Deferred.succeed(releaseManual, undefined));
        await Effect.runPromise(Deferred.succeed(receipt, undefined));
        await Effect.runPromise(Deferred.succeed(releaseCapture, undefined));
        await Promise.allSettled([manual, admission]);
        vi.restoreAllMocks();
      }
    });
  }

  it("captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-1"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointBaselineRefForThreadTurn(ThreadId.make("thread-1"), 1),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-1"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.latestTurn?.turnId === "turn-1" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointBaselineRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointBaselineRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v1\n");
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("keeps completed checkpoints immutable and excludes dirty pre-turn changes", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const firstTurnId = asTurnId("turn-immutable-1");
    const secondTurnId = asTurnId("turn-immutable-2");
    const createdAt = new Date().toISOString();

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-immutable-1-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: firstTurnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointBaselineRefForThreadTurn(threadId, 1));
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "first turn\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-immutable-1-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: firstTurnId,
      payload: { state: "completed" },
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1));
    const firstCheckpointOid = runGit(harness.cwd, [
      "rev-parse",
      checkpointRefForThreadTurn(threadId, 1),
    ]).trim();

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "external dirty change\n", "utf8");
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-immutable-2-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: secondTurnId,
    });
    await waitForGitFileAtRef(
      harness.cwd,
      checkpointBaselineRefForThreadTurn(threadId, 2),
      "README.md",
      "external dirty change\n",
    );

    expect(runGit(harness.cwd, ["rev-parse", checkpointRefForThreadTurn(threadId, 1)]).trim()).toBe(
      firstCheckpointOid,
    );
    expect(
      gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 1), "README.md"),
    ).toBe("first turn\n");

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "second turn\n", "utf8");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-turn-immutable-2-file"),
        threadId,
        activity: {
          id: EventId.make("evt-turn-immutable-2-file"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Edited README",
          payload: {
            itemType: "file_change",
            data: { kind: "edit", path: "README.md" },
          },
          turnId: secondTurnId,
          createdAt,
        },
        createdAt,
      }),
    );
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-immutable-2-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: secondTurnId,
      payload: { state: "completed" },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some((checkpoint) => checkpoint.turnId === secondTurnId),
    );
    expect(
      thread.checkpoints.find((checkpoint) => checkpoint.turnId === secondTurnId)?.turnFiles,
    ).toEqual([{ path: "README.md", kind: "modified", additions: 1, deletions: 1 }]);
  });

  it("settles turn completion when checkpoints are unavailable outside a git repository", async () => {
    const nonGitCwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-non-git-workspace-"));
    const nonGitThreadCwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-non-git-thread-"));
    tempDirs.push(nonGitCwd);
    tempDirs.push(nonGitThreadCwd);
    const harness = await createHarness({
      projectWorkspaceRoot: nonGitCwd,
      providerSessionCwd: nonGitThreadCwd,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: nonGitThreadCwd,
    });
    const createdAt = new Date().toISOString();
    const turnId = asTurnId("turn-without-checkpoint");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-without-checkpoint"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-without-checkpoint"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: ThreadId.make("thread-1"),
      turnId,
      payload: { state: "completed" },
    });

    const events = await waitForEvent(
      harness.engine,
      (event) => event.type === "thread.turn-diff-completed",
      1_000,
    );
    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.latestTurn?.turnId === turnId &&
        entry.latestTurn.state === "interrupted" &&
        entry.latestTurn.completedAt === createdAt,
      1_000,
    );
    const turnDiffEvent = events.find(
      (event): event is Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }> =>
        event.type === "thread.turn-diff-completed",
    );

    expect(turnDiffEvent?.payload.status).toBe("missing");
    expect(thread.checkpoints.find((checkpoint) => checkpoint.turnId === turnId)?.status).toBe(
      "missing",
    );
  });

  it("settles turn completion when capturing a checkpoint fails", async () => {
    const harness = await createHarness({
      failCheckpointCapture: true,
      seedFilesystemCheckpoints: false,
    });
    const createdAt = new Date().toISOString();
    const turnId = asTurnId("turn-with-failed-checkpoint");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-failed-checkpoint"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-with-failed-checkpoint"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: ThreadId.make("thread-1"),
      turnId,
      payload: { state: "completed" },
    });

    const events = await waitForEvent(
      harness.engine,
      (event) => event.type === "thread.turn-diff-completed",
      1_000,
    );
    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.latestTurn?.turnId === turnId &&
        entry.latestTurn.state === "error" &&
        entry.latestTurn.completedAt === createdAt &&
        entry.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
      1_000,
    );
    const turnDiffEvent = events.find(
      (event): event is Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }> =>
        event.type === "thread.turn-diff-completed",
    );

    expect(turnDiffEvent?.payload.status).toBe("error");
    expect(thread.checkpoints.find((checkpoint) => checkpoint.turnId === turnId)?.status).toBe(
      "error",
    );
  });

  it("waits for runtime ingestion before deriving turn-scoped files", async () => {
    const ingestionStarted = Effect.runSync(Deferred.make<void>());
    const ingestionCompleted = Effect.runSync(Deferred.make<void>());
    const completionEventId = EventId.make("evt-turn-completed-backlog");
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      awaitRuntimeEventProcessed: (eventId) =>
        eventId !== completionEventId
          ? Effect.void
          : Deferred.succeed(ingestionStarted, undefined).pipe(
              Effect.andThen(Deferred.await(ingestionCompleted)),
            ),
    });
    const createdAt = new Date().toISOString();
    const turnId = asTurnId("turn-backlog");

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-backlog"),
      provider: ProviderDriverKind.make("copilot"),
      createdAt,
      threadId: ThreadId.make("thread-1"),
      turnId,
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointBaselineRefForThreadTurn(ThreadId.make("thread-1"), 1),
    );

    fs.mkdirSync(path.join(harness.cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(harness.cwd, "src/first.ts"), "export const first = true;\n");
    fs.writeFileSync(path.join(harness.cwd, "src/second.ts"), "export const second = true;\n");
    harness.provider.emit({
      type: "turn.completed",
      eventId: completionEventId,
      provider: ProviderDriverKind.make("copilot"),
      createdAt,
      threadId: ThreadId.make("thread-1"),
      turnId,
      payload: { state: "completed" },
    });

    await Effect.runPromise(Deferred.await(ingestionStarted));
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(false);

    for (const [index, filePath] of ["src/first.ts", "src/second.ts"].entries()) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`cmd-file-activity-${index}`),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make(`evt-file-activity-${index}`),
            tone: "tool",
            kind: "tool.completed",
            summary: "Edited files",
            payload: {
              itemType: "file_change",
              data: {
                rawInput: `*** Begin Patch\n*** Add File: ${filePath}\n+content\n*** End Patch\n`,
              },
            },
            turnId,
            createdAt,
          },
          createdAt,
        }),
      );
    }

    await Effect.runPromise(Deferred.succeed(ingestionCompleted, undefined));
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
    );
    const thread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some((checkpoint) => checkpoint.turnId === turnId),
    );
    expect(
      thread.checkpoints.find((checkpoint) => checkpoint.turnId === turnId)?.turnFiles,
    ).toEqual([
      {
        path: "src/first.ts",
        kind: "added",
        additions: 1,
        deletions: 0,
      },
      {
        path: "src/second.ts",
        kind: "added",
        additions: 1,
        deletions: 0,
      },
    ]);
  });

  it("promotes provider turn diff paths into the real checkpoint turn file list", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();
    const turnId = asTurnId("turn-sidebar");
    const sidebarPath = path.join(harness.cwd, "apps/web/src/components/Sidebar.tsx");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-provider-diff-paths"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-provider-diff-paths"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: ThreadId.make("thread-1"),
      turnId,
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointBaselineRefForThreadTurn(ThreadId.make("thread-1"), 1),
    );

    fs.mkdirSync(path.dirname(sidebarPath), { recursive: true });
    fs.writeFileSync(sidebarPath, "export function Sidebar() {}\n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-provider-diff-placeholder"),
        threadId: ThreadId.make("thread-1"),
        turnId,
        completedAt: createdAt,
        checkpointRef: CheckpointRef.make("provider-diff:evt-sidebar"),
        status: "missing",
        files: [],
        agentTouchedPaths: ["apps/web/src/components/Sidebar.tsx"],
        turnFiles: [
          {
            path: "apps/web/src/components/Sidebar.tsx",
            kind: "added",
            additions: 1,
            deletions: 0,
          },
        ],
        assistantMessageId: MessageId.make("assistant:item-sidebar"),
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.latestTurn?.turnId === "turn-sidebar" &&
        entry.checkpoints.some(
          (checkpoint) => checkpoint.checkpointTurnCount === 1 && checkpoint.status === "ready",
        ),
    );
    const checkpoint = thread.checkpoints.find((entry) => entry.turnId === turnId);

    expect(checkpoint?.files).toEqual([
      {
        path: "apps/web/src/components/Sidebar.tsx",
        kind: "added",
        additions: 1,
        deletions: 0,
      },
    ]);
    expect(checkpoint?.agentTouchedPaths).toEqual(["apps/web/src/components/Sidebar.tsx"]);
    expect(checkpoint?.turnFiles).toEqual([
      {
        path: "apps/web/src/components/Sidebar.tsx",
        kind: "added",
        additions: 1,
        deletions: 0,
      },
    ]);
  });

  it("stores snapshot files from baseline while keeping turn files scoped to the current turn", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-sidebar");
    const readmePath = path.join(harness.cwd, "README.md");
    const sidebarPath = path.join(harness.cwd, "apps/web/src/components/Sidebar.tsx");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-cumulative-snapshot"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-readme"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: asTurnId("turn-readme"),
    });
    await waitForGitRefExists(harness.cwd, checkpointBaselineRefForThreadTurn(threadId, 1));

    fs.writeFileSync(readmePath, "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-readme"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: asTurnId("turn-readme"),
      payload: { state: "completed" },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint) => checkpoint.checkpointTurnCount === 1 && checkpoint.status === "ready",
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-provider-diff-placeholder-cumulative"),
        threadId,
        turnId,
        completedAt: createdAt,
        checkpointRef: CheckpointRef.make("provider-diff:evt-sidebar-cumulative"),
        status: "missing",
        files: [],
        agentTouchedPaths: ["apps/web/src/components/Sidebar.tsx"],
        turnFiles: [
          {
            path: "apps/web/src/components/Sidebar.tsx",
            kind: "added",
            additions: 1,
            deletions: 0,
          },
        ],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    fs.mkdirSync(path.dirname(sidebarPath), { recursive: true });
    fs.writeFileSync(sidebarPath, "export function Sidebar() {}\n", "utf8");

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-cumulative-snapshot"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.latestTurn?.turnId === "turn-sidebar" &&
        entry.checkpoints.some(
          (checkpoint) => checkpoint.checkpointTurnCount === 2 && checkpoint.status === "ready",
        ),
    );
    const checkpoint = thread.checkpoints.find((entry) => entry.turnId === turnId);

    expect(
      checkpoint?.files.toSorted((left, right) => left.path.localeCompare(right.path)),
    ).toEqual([
      {
        path: "apps/web/src/components/Sidebar.tsx",
        kind: "added",
        additions: 1,
        deletions: 0,
      },
      { path: "README.md", kind: "modified", additions: 1, deletions: 1 },
    ]);
    expect(checkpoint?.turnFiles).toEqual([
      {
        path: "apps/web/src/components/Sidebar.tsx",
        kind: "added",
        additions: 1,
        deletions: 0,
      },
    ]);
  });

  it("refreshes local git status state on turn completion using the session cwd", async () => {
    const gitStatusRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      gitStatusRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-refresh-local-status"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-refresh-local-status"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(gitStatusRefreshCalls).toEqual([harness.cwd]);
  });

  it("ignores auxiliary thread turn completion while primary turn is active", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-primary-running"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-main"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointBaselineRefForThreadTurn(ThreadId.make("thread-1"), 1),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.checkpoints).toHaveLength(0);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
  });

  it("captures pre-turn and completion checkpoints for claude runtime events", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: ProviderDriverKind.make("claudeAgent"),
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointBaselineRefForThreadTurn(ThreadId.make("thread-1"), 1),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.latestTurn?.turnId === "turn-claude-1" && entry.checkpoints.length === 1,
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
  });

  it("appends capture failure activity when turn diff summary cannot be derived", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-baseline-diff"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-baseline"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-baseline"),
      payload: { state: "completed" },
    });

    const events = await waitForEvent(
      harness.engine,
      (event) => event.type === "thread.turn-diff-completed",
    );
    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(true);
    // When there is no assistant message in the completing turn, the reactor
    // must omit assistantMessageId (decoded as null) instead of synthesizing
    // a fake `assistant:<turnId>` id or borrowing one from another turn.
    const turnDiffEvent = events.find(
      (event): event is Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }> =>
        event.type === "thread.turn-diff-completed",
    );
    expect(turnDiffEvent?.payload.assistantMessageId).toBeNull();
    expect(thread.checkpoints[0]?.assistantMessageId).toBeNull();
  });

  it("does not append capture failure activity when diff spans a workspace generation change", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      failDiffWithGenerationMismatch: true,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-generation-mismatch"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-generation-mismatch"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(harness.engine, (entry) => entry.checkpoints.length === 1);

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(thread.checkpoints[0]?.files).toEqual([]);
    expect(thread.checkpoints[0]?.turnFiles).toEqual([]);
    expect(
      thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(false);
  });

  it("captures fallback pre-turn baseline from project workspace root when worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-for-fallback-baseline"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-fallback-baseline"),
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointBaselineRefForThreadTurn(ThreadId.make("thread-1"), 1),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointBaselineRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("preserves the pre-send baseline when turn.started arrives after provider edits", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const baselineRef = checkpointBaselineRefForThreadTurn(threadId, 1);

    await Effect.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: baselineRef,
      }),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "provider edit\n", "utf8");
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-after-provider-edit"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: new Date().toISOString(),
      threadId,
      turnId: asTurnId("turn-after-provider-edit"),
    });
    await harness.drain();

    expect(gitShowFileAtRef(harness.cwd, baselineRef, "README.md")).toBe("v1\n");
  });

  it("re-baselines a shared checkpoint ref after workspace handoff", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const baselineRef = checkpointBaselineRefForThreadTurn(threadId, 1);
    const handoffCwd = `${harness.cwd}-handoff`;
    tempDirs.push(handoffCwd);

    await Effect.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: baselineRef,
      }),
    );

    runGit(harness.cwd, ["worktree", "add", "-b", "handoff", handoffCwd, "HEAD"]);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.workspace.handoff",
        commandId: CommandId.make("cmd-workspace-handoff"),
        threadId,
        branch: "handoff",
        worktreePath: handoffCwd,
        markerMessageId: MessageId.make("message-handoff-marker"),
        continuation: {
          id: QueuedTurnId.make("queued-turn-handoff"),
          threadId,
          message: {
            messageId: MessageId.make("message-handoff"),
            role: "user",
            text: "continue after handoff",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          failedAt: null,
          failureMessage: null,
        },
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-after-handoff"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: new Date().toISOString(),
      threadId,
      turnId: asTurnId("turn-after-handoff"),
    });

    await waitForGitFileAtRef(handoffCwd, baselineRef, "README.md", "v1\n");
  });

  it("does not capture a checkpoint from the project root when provider session cwd is unavailable", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-provider-cwd"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-missing-cwd"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-provider-cwd"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(false);
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
  });

  it("ignores non-v2 checkpoint.captured runtime events", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-checkpoint-captured"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "checkpoint.captured",
      eventId: EventId.make("evt-checkpoint-captured-3"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-3"),
      turnCount: 3,
      status: "completed",
    });

    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
      false,
    );
  });

  it("continues processing runtime events after a single checkpoint runtime failure", async () => {
    const nonRepositorySessionCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "t3-checkpoint-runtime-non-repo-"),
    );
    tempDirs.push(nonRepositorySessionCwd);

    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerSessionCwd: nonRepositorySessionCwd,
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-non-repo-runtime"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-runtime-capture-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-runtime-failure"),
      payload: { state: "completed" },
    });

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-after-runtime-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-after-runtime-failure"),
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointBaselineRefForThreadTurn(ThreadId.make("thread-1"), 1),
    );
    expect(
      gitRefExists(harness.cwd, checkpointBaselineRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
  });

  it("executes provider revert and emits thread.reverted for checkpoint revert requests", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    const dispatch = harness.engine.dispatch;
    let revertCommitAttempts = 0;
    vi.spyOn(harness.engine, "dispatch").mockImplementation((command) => {
      if (command.type === "thread.revert.complete") {
        revertCommitAttempts += 1;
        if (revertCommitAttempts === 1) {
          return Effect.fail(
            new PersistenceSqlError({
              operation: "thread.revert.complete",
              detail: "Injected transient revert commit failure.",
            }),
          );
        }
      }
      return dispatch(command);
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        agentTouchedPaths: [],
        turnFiles: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        agentTouchedPaths: [],
        turnFiles: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(harness.engine, (entry) => entry.checkpoints.length === 1);

    expect(thread.latestTurn?.turnId).toBe("turn-1");
    expect(thread.checkpoints).toHaveLength(1);
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
    expect(revertCommitAttempts).toBe(2);
    await harness.drain();
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
    ).toBe(false);
  });

  it("keeps a committed revert successful when workspace invalidation fails", async () => {
    const harness = await createHarness({ failWorkspaceInvalidate: true });
    const createdAt = new Date().toISOString();

    for (const turnCount of [1, 2]) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`cmd-invalidate-revert-diff-${turnCount}`),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId(`turn-invalidate-revert-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), turnCount),
          status: "ready",
          files: [],
          agentTouchedPaths: [],
          turnFiles: [],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-invalidate-revert"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) => entry.checkpoints.length === 1);
    await harness.drain();

    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      false,
    );
    expect(
      gitRefExists(harness.cwd, checkpointRevertGuardRefForThread(ThreadId.make("thread-1"))),
    ).toBe(false);
  });

  it("restores the original workspace when provider rollback fails", async () => {
    const harness = await createHarness({ failProviderRollback: true });
    const createdAt = new Date().toISOString();

    for (const turnCount of [1, 2]) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`cmd-failed-revert-diff-${turnCount}`),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId(`turn-failed-revert-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), turnCount),
          status: "ready",
          files: [],
          agentTouchedPaths: [],
          turnFiles: [],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "uncommitted before revert\n", "utf8");
    runGit(harness.cwd, ["add", "README.md"]);
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "unstaged before revert\n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-failed-revert"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    expect(runGit(harness.cwd, ["show", ":README.md"])).toBe("uncommitted before revert\n");
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe(
      "unstaged before revert\n",
    );
    expect(thread.checkpoints).toHaveLength(2);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
    ).toBe(true);
  });

  it("restores the original workspace and deletes the guard after a rollback defect", async () => {
    const harness = await createHarness({ defectProviderRollback: true });
    const createdAt = new Date().toISOString();

    for (const turnCount of [1, 2]) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`cmd-defect-revert-diff-${turnCount}`),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId(`turn-defect-revert-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), turnCount),
          status: "ready",
          files: [],
          agentTouchedPaths: [],
          turnFiles: [],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "uncommitted before defect\n", "utf8");
    runGit(harness.cwd, ["add", "README.md"]);
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "unstaged before defect\n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-defect-revert"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );
    await harness.drain();

    expect(runGit(harness.cwd, ["show", ":README.md"])).toBe("uncommitted before defect\n");
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe(
      "unstaged before defect\n",
    );
    expect(
      gitRefExists(harness.cwd, checkpointRevertGuardRefForThread(ThreadId.make("thread-1"))),
    ).toBe(false);
  });

  it("records the original rollback error when guard restoration also fails", async () => {
    const harness = await createHarness({
      failProviderRollback: true,
      failRevertGuardRestore: true,
    });
    const createdAt = new Date().toISOString();

    for (const turnCount of [1, 2]) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`cmd-original-error-diff-${turnCount}`),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId(`turn-original-error-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), turnCount),
          status: "ready",
          files: [],
          agentTouchedPaths: [],
          turnFiles: [],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-original-error-revert"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    const failure = thread.activities.findLast(
      (activity) => activity.kind === "checkpoint.revert.failed",
    );

    expect(failure?.payload).toMatchObject({
      detail: expect.stringContaining("Injected rollback failure."),
    });
  });

  it("refuses to restore a checkpoint when ownership changes mid-revert", async () => {
    const guardRef = String(checkpointRevertGuardRefForThread(ThreadId.make("thread-1")));
    let harnessRef: Awaited<ReturnType<typeof createHarness>> | undefined;
    const harness = await createHarness({
      beforeCheckpointCapture: (ref) => {
        const harnessValue = harnessRef;
        if (harnessValue === undefined || String(ref) !== guardRef) {
          return Effect.void;
        }
        return Effect.gen(function* () {
          // Simulate a concurrent handoff releasing and reassigning the
          // checkout after the pre-guard ownership check passed. The restore
          // must observe the reassignment and refuse to mutate the new
          // owner's tree.
          yield* harnessValue.workspaceOwnership.release(ThreadId.make("thread-1"));
          const readModel = yield* harnessValue.engine.getReadModel();
          const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
          const worktreePath = thread?.workspaceBinding?.worktreePath ?? thread?.worktreePath;
          if (worktreePath === undefined || worktreePath === null) {
            return yield* Effect.die(new Error("test thread has no worktree path"));
          }
          yield* harnessValue.workspaceOwnership.claim({
            threadId: ThreadId.make("thread-2"),
            worktreePath,
            branch: null,
            commandId: CommandId.make("cmd-mid-revert-handoff"),
            now: new Date().toISOString(),
          });
        }).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) => Effect.die(cause)),
        );
      },
    });
    harnessRef = harness;
    const createdAt = new Date().toISOString();

    for (const turnCount of [1, 2]) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`cmd-mid-revert-diff-${turnCount}`),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId(`turn-mid-revert-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), turnCount),
          status: "ready",
          files: [],
          agentTouchedPaths: [],
          turnFiles: [],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "uncommitted before revert\n", "utf8");
    runGit(harness.cwd, ["add", "README.md"]);
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "unstaged before revert\n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-mid-revert"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    await harness.drain();
    expect(runGit(harness.cwd, ["show", ":README.md"])).toBe("uncommitted before revert\n");
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe(
      "unstaged before revert\n",
    );
    expect(thread.checkpoints).toHaveLength(2);
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    const newOwnerships = await Effect.runPromise(
      harness.workspaceOwnership.getByThreadId(ThreadId.make("thread-2")),
    );
    expect(newOwnerships.length).toBe(1);
  });

  it("executes provider revert and emits thread.reverted for claude sessions", async () => {
    const harness = await createHarness({ providerName: ProviderDriverKind.make("claudeAgent") });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        agentTouchedPaths: [],
        turnFiles: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        agentTouchedPaths: [],
        turnFiles: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request-claude"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
  });

  it("processes consecutive revert requests with deterministic rollback sequencing", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-inline-revert"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        agentTouchedPaths: [],
        turnFiles: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        agentTouchedPaths: [],
        turnFiles: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-1"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-0"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 0,
        createdAt,
      }),
    );

    await harness.drain();

    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(2);
    expect(harness.provider.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
    expect(harness.provider.rollbackConversation.mock.calls[1]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
  });

  it("appends an error activity when revert is requested without an active session", async () => {
    const harness = await createHarness({ hasSession: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-no-session"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });
});
