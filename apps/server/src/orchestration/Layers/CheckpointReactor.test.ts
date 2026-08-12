// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  type OrchestrationReadModel,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
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
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { makeKeyedWorkspaceBoundary, PreTurnCheckpointLive } from "./PreTurnCheckpoint.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { PreTurnCheckpoint } from "../Services/PreTurnCheckpoint.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";

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
  rollbackConversationFails = false,
) {
  const now = "2026-01-01T00:00:00.000Z";
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn(
    (_input: { readonly threadId: ThreadId; readonly numTurns: number }) =>
      rollbackConversationFails
        ? Effect.die(new Error("Injected provider rollback failure"))
        : Effect.void,
  );
  const stopSession = vi.fn(() => Effect.void);

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
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession,
    listSessions,
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
      return Stream.fromPubSub(runtimeEventPubSub);
    },
    subscribeEvents: PubSub.subscribe(runtimeEventPubSub).pipe(Effect.map(Stream.fromSubscription)),
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    rollbackConversation,
    stopSession,
    emit,
  };
}

async function waitForThread(
  readModel: () => Promise<OrchestrationReadModel>,
  predicate: (thread: OrchestrationReadModel["threads"][number]) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<OrchestrationReadModel["threads"][number]> => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for orchestration event.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v1\n", "utf8");
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
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | CheckpointReactor
    | PreTurnCheckpoint
    | CheckpointStore.CheckpointStore
    | ProjectionSnapshotQuery,
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
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly threadBranch?: string | null;
    readonly secondThreadSharingWorktree?: boolean;
    readonly localStatusRefName?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderDriverKind;
    readonly rollbackConversationFails?: boolean;
    readonly startReactor?: boolean;
    readonly gitStatusRefreshCalls?: Array<string>;
    readonly beforeRestoreCheckpoint?: (
      input: CheckpointStore.RestoreCheckpointInput,
    ) => Effect.Effect<void>;
  }) {
    const cwd = createGitRepository();
    tempDirs.push(cwd);
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? ProviderDriverKind.make("codex"),
      options?.rollbackConversationFails ?? false,
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-checkpoint-reactor-test-",
    });
    const vcsStatusBroadcasterLayer = Layer.succeed(VcsStatusBroadcaster, {
      getStatus: () => Effect.die("getStatus should not be called in this test"),
      refreshLocalStatus: (cwd: string) =>
        Effect.sync(() => {
          options?.gitStatusRefreshCalls?.push(cwd);
        }).pipe(
          Effect.as({
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: true,
            refName:
              options?.localStatusRefName !== undefined ? options.localStatusRefName : "main",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
        ),
      refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
      streamStatus: () => Stream.empty,
    });

    const checkpointStoreBaseLayer = CheckpointStore.layer.pipe(
      Layer.provide(VcsDriverRegistry.layer),
    );
    const beforeRestoreCheckpoint = options?.beforeRestoreCheckpoint;
    const checkpointStoreLayer = beforeRestoreCheckpoint
      ? Layer.effect(
          CheckpointStore.CheckpointStore,
          Effect.gen(function* () {
            const store = yield* CheckpointStore.CheckpointStore;
            return CheckpointStore.CheckpointStore.of({
              ...store,
              restoreCheckpoint: (input) =>
                beforeRestoreCheckpoint(input).pipe(Effect.andThen(store.restoreCheckpoint(input))),
            });
          }),
        ).pipe(Layer.provide(checkpointStoreBaseLayer))
      : checkpointStoreBaseLayer;

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(PreTurnCheckpointLive),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(vcsStatusBroadcasterLayer),
      Layer.provideMerge(checkpointStoreLayer),
      Layer.provideMerge(
        WorkspaceEntries.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provideMerge(VcsDriverRegistry.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
    const preTurnCheckpoint = await runtime.runPromise(Effect.service(PreTurnCheckpoint));
    const checkpointStore = await runtime.runPromise(
      Effect.service(CheckpointStore.CheckpointStore),
    );
    scope = await Effect.runPromise(Scope.make("sequential"));
    let reactorStarted = false;
    const startReactor = async () => {
      if (reactorStarted) {
        return;
      }
      reactorStarted = true;
      await Effect.runPromise(reactor.start().pipe(Scope.provide(scope!)));
    };
    if (options?.startReactor !== false) {
      await startReactor();
    }
    const drain = () => Effect.runPromise(reactor.drain);

    const createdAt = "2026-01-01T00:00:00.000Z";
    const threadWorktreePath =
      options?.threadWorktreePath === undefined ? cwd : options.threadWorktreePath;
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine
        .dispatch({
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
          branch: options?.threadBranch ?? null,
          worktreePath: threadWorktreePath,
          createdAt,
        })
        .pipe(
          options?.secondThreadSharingWorktree
            ? Effect.andThen(
                engine.dispatch({
                  type: "thread.create",
                  commandId: CommandId.make("cmd-thread-create-2"),
                  threadId: ThreadId.make("thread-2"),
                  projectId: asProjectId("project-1"),
                  title: "Thread 2",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "gpt-5-codex",
                  },
                  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                  runtimeMode: "approval-required",
                  branch: null,
                  worktreePath: threadWorktreePath,
                  createdAt,
                }),
              )
            : Effect.asVoid,
        ),
    );

    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        }),
      );
      NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        }),
      );
      NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        }),
      );
    }

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      provider,
      reactor,
      preTurnCheckpoint,
      checkpointStore,
      cwd,
      startReactor,
      drain,
    };
  }

  it("captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await runtime!.runPromise(
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

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-1"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-1" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(true);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
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

  it("finalizes a targeted aborted turn once across direct and subscribed paths", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-aborted-1");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await runtime!.runPromise(
      harness.preTurnCheckpoint.ensure({ threadId, createdAt }).pipe(
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-running-aborted-turn"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "opencode",
              runtimeMode: "approval-required",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        ),
      ),
    );
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");

    const abortedEvent = {
      type: "turn.aborted" as const,
      eventId: EventId.make("evt-turn-aborted-1"),
      provider: ProviderDriverKind.make("opencode"),
      threadId,
      turnId,
      createdAt,
      payload: { reason: "Interrupted by user." },
    };
    await runtime!.runPromise(harness.reactor.finalizeTurnCompletion(abortedEvent));
    harness.provider.emit(abortedEvent);
    await harness.drain();

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.checkpoints.some((checkpoint) => checkpoint.turnId === turnId),
    );
    expect(thread.session).toMatchObject({ status: "running", activeTurnId: turnId });
    expect(thread.checkpoints).toContainEqual(
      expect.objectContaining({
        turnId,
        checkpointTurnCount: 1,
        status: "ready",
      }),
    );
    expect(thread.checkpoints.filter((checkpoint) => checkpoint.turnId === turnId)).toHaveLength(1);
    expect(
      thread.activities.filter(
        (activity) => activity.kind === "checkpoint.captured" && activity.turnId === turnId,
      ),
    ).toHaveLength(1);
    expect(
      gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 1), "README.md"),
    ).toBe("v2\n");
  });

  it("keeps a live diff as a placeholder until terminal capture includes later writes", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-with-live-diff");
    const createdAt = "2026-01-01T00:00:00.000Z";
    const checkpointRef = checkpointRefForThreadTurn(threadId, 1);

    await runtime!.runPromise(
      harness.preTurnCheckpoint.ensure({ threadId, createdAt }).pipe(
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-running-live-diff"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        ),
      ),
    );
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-live-diff-placeholder"),
        threadId,
        turnId,
        completedAt: createdAt,
        checkpointRef,
        status: "missing",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await harness.drain();

    expect(gitRefExists(harness.cwd, checkpointRef)).toBe(false);
    const midTurn = await harness.readModel();
    const midTurnThread = midTurn.threads.find((thread) => thread.id === threadId);
    expect(midTurnThread?.checkpoints).toContainEqual(
      expect.objectContaining({ turnId, checkpointTurnCount: 1, status: "missing" }),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v3\n", "utf8");
    await runtime!.runPromise(
      harness.reactor.finalizeTurnCompletion({
        type: "turn.completed",
        eventId: EventId.make("evt-terminal-after-live-diff"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId,
        createdAt,
        payload: { state: "completed" },
      }),
    );

    expect(gitShowFileAtRef(harness.cwd, checkpointRef, "README.md")).toBe("v3\n");
    const terminal = await harness.readModel();
    const terminalThread = terminal.threads.find((thread) => thread.id === threadId);
    expect(terminalThread?.checkpoints).toContainEqual(
      expect.objectContaining({ turnId, checkpointTurnCount: 1, status: "ready" }),
    );
    expect(
      terminalThread?.checkpoints.filter((checkpoint) => checkpoint.turnId === turnId),
    ).toHaveLength(1);
  });

  it("captures a pre-turn baseline once across concurrent and repeated ensures", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0);
    const input = {
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    await runtime!.runPromise(
      Effect.all(
        [harness.preTurnCheckpoint.ensure(input), harness.preTurnCheckpoint.ensure(input)],
        { concurrency: "unbounded" },
      ),
    );
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    await runtime!.runPromise(harness.preTurnCheckpoint.ensure(input));

    expect(gitShowFileAtRef(harness.cwd, checkpointRef, "README.md")).toBe("v1\n");
  });

  it("serializes completion and next-turn filesystem boundaries across Windows path casing", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });

    await runtime!.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const completionEntered = yield* Deferred.make<void>();
          const releaseCompletion = yield* Deferred.make<void>();
          const order = yield* Ref.make<ReadonlyArray<string>>([]);
          const completion = yield* harness.preTurnCheckpoint
            .withWorkspaceBoundary(
              "C:\\Repo\\Workspace",
              Ref.update(order, (entries) => [...entries, "completion-entered"]).pipe(
                Effect.andThen(Deferred.succeed(completionEntered, undefined)),
                Effect.andThen(Deferred.await(releaseCompletion)),
                Effect.andThen(Ref.update(order, (entries) => [...entries, "completion-finished"])),
              ),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(completionEntered);

          const nextTurn = yield* harness.preTurnCheckpoint
            .withWorkspaceBoundary(
              "c:/repo/workspace/",
              Ref.update(order, (entries) => [...entries, "next-turn-entered"]),
            )
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;

          expect(nextTurn.pollUnsafe()).toBeUndefined();
          expect(yield* Ref.get(order)).toEqual(["completion-entered"]);

          yield* Deferred.succeed(releaseCompletion, undefined);
          yield* Fiber.join(completion);
          yield* Fiber.join(nextTurn);
          expect(yield* Ref.get(order)).toEqual([
            "completion-entered",
            "completion-finished",
            "next-turn-entered",
          ]);
        }),
      ),
    );
  });

  it("allows unrelated workspace boundaries to progress concurrently", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });

    await runtime!.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstEntered = yield* Deferred.make<void>();
          const releaseFirst = yield* Deferred.make<void>();
          const order = yield* Ref.make<ReadonlyArray<string>>([]);
          const first = yield* harness.preTurnCheckpoint
            .withWorkspaceBoundary(
              "C:\\Repo\\Workspace-A",
              Ref.update(order, (entries) => [...entries, "first-entered"]).pipe(
                Effect.andThen(Deferred.succeed(firstEntered, undefined)),
                Effect.andThen(Deferred.await(releaseFirst)),
              ),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(firstEntered);

          const second = yield* harness.preTurnCheckpoint
            .withWorkspaceBoundary(
              "C:\\Repo\\Workspace-B",
              Ref.update(order, (entries) => [...entries, "second-entered"]),
            )
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;

          expect(yield* Ref.get(order)).toEqual(["first-entered", "second-entered"]);
          yield* Deferred.succeed(releaseFirst, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
        }),
      ),
    );
  });

  it("evicts idle workspace boundary locks", async () => {
    await createHarness({ seedFilesystemCheckpoints: false });
    const boundaries = await runtime!.runPromise(makeKeyedWorkspaceBoundary);

    await runtime!.runPromise(
      Effect.forEach(
        Array.from({ length: 100 }, (_, index) => `C:\\Repo\\Workspace-${index}`),
        (cwd) => boundaries.withBoundary(cwd, Effect.void),
        { concurrency: "unbounded", discard: true },
      ),
    );

    expect(await runtime!.runPromise(boundaries.activeKeyCount)).toBe(0);
  });

  it("preserves an existing pre-turn checkpoint ref", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0);
    runGit(harness.cwd, ["update-ref", checkpointRef, "HEAD"]);
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");

    await runtime!.runPromise(
      harness.preTurnCheckpoint.ensure({
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(gitShowFileAtRef(harness.cwd, checkpointRef, "README.md")).toBe("v1\n");
  });

  it("adopts an orphan completion ref before the next turn can overwrite it", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const firstTurnId = asTurnId("turn-orphaned-checkpoint");
    const secondTurnId = asTurnId("turn-after-orphaned-checkpoint");
    const createdAt = "2026-01-01T00:00:00.000Z";
    const firstCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const secondCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

    await runtime!.runPromise(
      harness.preTurnCheckpoint.ensure({ threadId, createdAt }).pipe(
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-running-before-orphan-capture"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: firstTurnId,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        ),
      ),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    // Simulate process exit after the git ref is captured but before
    // thread.turn.diff.complete is persisted.
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: firstCheckpointRef,
      }),
    );

    await runtime!.runPromise(harness.preTurnCheckpoint.ensure({ threadId, createdAt }));
    const adopted = await harness.readModel();
    const adoptedThread = adopted.threads.find((thread) => thread.id === threadId);
    expect(adoptedThread?.checkpoints).toContainEqual(
      expect.objectContaining({
        turnId: firstTurnId,
        checkpointTurnCount: 1,
        checkpointRef: firstCheckpointRef,
        status: "ready",
      }),
    );

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-running-after-orphan-adoption"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: secondTurnId,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v3\n", "utf8");
    await runtime!.runPromise(
      harness.reactor.finalizeTurnCompletion({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-after-orphan-adoption"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId: secondTurnId,
        createdAt,
        payload: { state: "completed" },
      }),
    );

    expect(gitShowFileAtRef(harness.cwd, firstCheckpointRef, "README.md")).toBe("v2\n");
    expect(gitShowFileAtRef(harness.cwd, secondCheckpointRef, "README.md")).toBe("v3\n");
    const completed = await harness.readModel();
    const completedThread = completed.threads.find((thread) => thread.id === threadId);
    expect(
      completedThread?.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount),
    ).toEqual([1, 2]);
  });

  it("adopts a materialized ref for an existing missing placeholder after a capture crash", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-placeholder-capture-crash");
    const createdAt = "2026-01-01T00:00:00.000Z";
    const checkpointRef = checkpointRefForThreadTurn(threadId, 1);

    await runtime!.runPromise(
      harness.preTurnCheckpoint.ensure({ threadId, createdAt }).pipe(
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-running-placeholder-capture-crash"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        ),
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.make("cmd-placeholder-before-capture-crash"),
            threadId,
            turnId,
            completedAt: createdAt,
            checkpointRef: CheckpointRef.make("provider-diff:placeholder-capture-crash"),
            status: "missing",
            files: [],
            checkpointTurnCount: 1,
            createdAt,
          }),
        ),
      ),
    );
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    // Simulate exit after terminal capture wrote the canonical ref but before
    // thread.turn.diff.complete replaced the already-projected placeholder.
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({ cwd: harness.cwd, checkpointRef }),
    );

    await runtime!.runPromise(harness.preTurnCheckpoint.ensure({ threadId, createdAt }));

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    expect(thread?.checkpoints).toContainEqual(
      expect.objectContaining({
        turnId,
        checkpointTurnCount: 1,
        checkpointRef,
        status: "ready",
      }),
    );
    expect(thread?.checkpoints.filter((checkpoint) => checkpoint.turnId === turnId)).toHaveLength(
      1,
    );
    expect(gitShowFileAtRef(harness.cwd, checkpointRef, "README.md")).toBe("v2\n");
  });

  it("uses a new orphan-adoption receipt after revert reuses a checkpoint count", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const firstTurnId = asTurnId("turn-orphan-before-revert");
    const secondTurnId = asTurnId("turn-orphan-after-revert");
    const createdAt = "2026-01-01T00:00:00.000Z";
    const checkpointRef = checkpointRefForThreadTurn(threadId, 1);

    await runtime!.runPromise(
      harness.preTurnCheckpoint.ensure({ threadId, createdAt }).pipe(
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-first-orphan-before-revert"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: firstTurnId,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        ),
      ),
    );
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({ cwd: harness.cwd, checkpointRef }).pipe(
        Effect.andThen(harness.preTurnCheckpoint.ensure({ threadId, createdAt })),
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.revert.complete",
            commandId: CommandId.make("cmd-revert-between-orphan-adoptions"),
            threadId,
            turnCount: 0,
            createdAt,
          }),
        ),
        Effect.andThen(
          harness.checkpointStore.deleteCheckpointRefs({
            cwd: harness.cwd,
            checkpointRefs: [checkpointRef],
          }),
        ),
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-second-orphan-after-revert"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: secondTurnId,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        ),
      ),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v3\n", "utf8");
    await runtime!.runPromise(
      harness.checkpointStore
        .captureCheckpoint({ cwd: harness.cwd, checkpointRef })
        .pipe(Effect.andThen(harness.preTurnCheckpoint.ensure({ threadId, createdAt }))),
    );

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    expect(thread?.checkpoints).toContainEqual(
      expect.objectContaining({
        turnId: secondTurnId,
        checkpointTurnCount: 1,
        checkpointRef,
      }),
    );
    const events = await runtime!.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const adoptionCommandIds = events
      .filter(
        (event) =>
          event.type === "thread.turn-diff-completed" &&
          event.commandId?.startsWith("checkpoint:orphan-adopt:") === true,
      )
      .map((event) => event.commandId);
    expect(adoptionCommandIds).toEqual([
      CommandId.make(`checkpoint:orphan-adopt:${threadId}:${firstTurnId}:1`),
      CommandId.make(`checkpoint:orphan-adopt:${threadId}:${secondTurnId}:1`),
    ]);
  });

  it("skips the pre-turn checkpoint prerequisite for a non-Git workspace", async () => {
    const nonRepositoryCwd = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-pre-turn-checkpoint-non-repo-"),
    );
    tempDirs.push(nonRepositoryCwd);
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      projectWorkspaceRoot: nonRepositoryCwd,
      threadWorktreePath: null,
    });

    await runtime!.runPromise(
      harness.preTurnCheckpoint.ensure({
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(NodeFS.existsSync(NodePath.join(nonRepositoryCwd, ".git"))).toBe(false);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(false);
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
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-refresh-local-status"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(gitStatusRefreshCalls).toEqual([harness.cwd]);
  });

  it("adopts a drifted checkout as the thread branch on a dedicated worktree", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/renamed-by-agent",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift"),
      payload: { state: "completed" },
    });

    await harness.drain();
    await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.meta-updated" &&
        (event as unknown as { payload: { branch?: string } }).payload.branch ===
          "t3code/renamed-by-agent",
    );

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("t3code/renamed-by-agent");
  });

  it("does not adopt a drifted checkout when the worktree is shared by another thread", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/renamed-by-agent",
      secondThreadSharingWorktree: true,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift-shared"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift-shared"),
      payload: { state: "completed" },
    });

    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("t3code/original-branch");
  });

  it("does not adopt a temporary placeholder checkout as the thread branch", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/0a1b2c3d",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift-temp"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift-temp"),
      payload: { state: "completed" },
    });

    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("t3code/original-branch");
  });

  it("ignores auxiliary thread turn completion while primary turn is active", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await runtime!.runPromise(
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

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.checkpoints).toHaveLength(0);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
  });

  it("captures pre-turn and completion checkpoints for claude runtime events", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: ProviderDriverKind.make("claudeAgent"),
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

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
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-claude-1" && entry.checkpoints.length === 1,
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
  });

  it("appends capture failure activity when turn diff summary cannot be derived", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

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

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-baseline"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(true);
  });

  it("captures pre-turn baseline from project workspace root when thread worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-for-baseline"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-user-1"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("captures turn completion checkpoint from project workspace root when provider session cwd is unavailable", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

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

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-provider-cwd"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("ignores non-v2 checkpoint.captured runtime events", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

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

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-3"),
      turnCount: 3,
      status: "completed",
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
      false,
    );
  });

  it("continues processing runtime events after a single checkpoint runtime failure", async () => {
    const nonRepositorySessionCwd = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-runtime-non-repo-"),
    );
    tempDirs.push(nonRepositorySessionCwd);

    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerSessionCwd: nonRepositorySessionCwd,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

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

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-runtime-failure"),
      payload: { state: "completed" },
    });

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-after-runtime-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-after-runtime-failure"),
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(true);
  });

  it("executes provider revert and emits thread.reverted for checkpoint revert requests", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

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
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.checkpoints.length === 1,
    );

    expect(thread.latestTurn?.turnId).toBe("turn-1");
    expect(thread.checkpoints).toHaveLength(1);
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
    expect(
      NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe("v2\n");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
    ).toBe(false);
  });

  it("recovers an unfinished revert without repeating an outcome-unknown provider rollback", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";
    const requestCommandId = CommandId.make("cmd-revert-crashed-after-provider-rollback");

    await runtime!.runPromise(
      Effect.forEach(
        [1, 2],
        (turnCount) =>
          harness.engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.make(`cmd-revert-crash-diff-${turnCount}`),
            threadId,
            turnId: asTurnId(`turn-${turnCount}`),
            completedAt: createdAt,
            checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
            status: "ready",
            files: [],
            checkpointTurnCount: turnCount,
            createdAt,
          }),
        { concurrency: 1 },
      ).pipe(
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.checkpoint.revert",
            commandId: requestCommandId,
            threadId,
            turnCount: 1,
            createdAt,
          }),
        ),
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(
              `checkpoint:revert-provider-rollback-started:${requestCommandId}`,
            ),
            threadId,
            activity: {
              id: EventId.make(`checkpoint:revert-provider-rollback-started:${requestCommandId}`),
              tone: "info",
              kind: "checkpoint.revert.provider-rollback.started",
              summary: "Synchronizing provider conversation",
              payload: { turnCount: 1, rolledBackTurns: 1 },
              turnId: null,
              createdAt,
            },
            createdAt,
          }),
        ),
        Effect.andThen(
          harness.checkpointStore.restoreCheckpoint({
            cwd: harness.cwd,
            checkpointRef: checkpointRefForThreadTurn(threadId, 1),
            fallbackToHead: false,
          }),
        ),
        Effect.andThen(
          harness.provider.rollbackConversation({
            threadId,
            numTurns: 1,
          }),
        ),
      ),
    );
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);

    await harness.startReactor();
    await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.reverted" &&
        "commandId" in event &&
        event.commandId === `checkpoint:revert-complete:${requestCommandId}`,
    );
    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.activities.some(
          (activity) => activity.kind === "checkpoint.revert.provider-rollback.unknown",
        ),
    );

    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.stopSession).toHaveBeenCalledTimes(1);
    expect(thread.latestTurn?.turnId).toBe("turn-1");
    expect(thread.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1]);
    expect(thread.session?.status).toBe("stopped");
    expect(thread.session?.lastError).toContain("outcome is unknown after restart");
    expect(
      NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe("v2\n");
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(false);
  });

  it("projects a restored checkpoint even when provider rollback fails", async () => {
    const harness = await createHarness({ rollbackConversationFails: true });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await runtime!.runPromise(
      harness.engine
        .dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-before-failed-provider-rollback"),
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
        })
        .pipe(
          Effect.andThen(
            Effect.forEach(
              [1, 2],
              (turnCount) =>
                harness.engine.dispatch({
                  type: "thread.turn.diff.complete",
                  commandId: CommandId.make(`cmd-failed-provider-rollback-diff-${turnCount}`),
                  threadId,
                  turnId: asTurnId(`turn-${turnCount}`),
                  completedAt: createdAt,
                  checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
                  status: "ready",
                  files: [],
                  checkpointTurnCount: turnCount,
                  createdAt,
                }),
              { concurrency: 1 },
            ),
          ),
          Effect.andThen(
            harness.engine.dispatch({
              type: "thread.checkpoint.revert",
              commandId: CommandId.make("cmd-revert-with-failed-provider-rollback"),
              threadId,
              turnCount: 1,
              createdAt,
            }),
          ),
        ),
    );
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.activities.some(
          (activity) => activity.kind === "checkpoint.revert.provider-rollback.failed",
        ),
    );
    expect(thread.latestTurn?.turnId).toBe("turn-1");
    expect(thread.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1]);
    expect(thread.session?.status).toBe("stopped");
    expect(thread.session?.lastError).toContain("provider conversation rollback failed");
    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      false,
    );
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.stopSession).toHaveBeenCalledTimes(1);
    expect(
      NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe("v2\n");
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(false);
  });

  it("holds the workspace boundary until checkpoint revert finishes", async () => {
    const restoreEntered = Effect.runSync(Deferred.make<void>());
    const releaseRestore = Effect.runSync(Deferred.make<void>());
    const harness = await createHarness({
      beforeRestoreCheckpoint: () =>
        Deferred.succeed(restoreEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRestore)),
        ),
    });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await runtime!.runPromise(
      Effect.forEach(
        [1, 2],
        (turnCount) =>
          harness.engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.make(`cmd-boundary-revert-diff-${turnCount}`),
            threadId,
            turnId: asTurnId(`turn-${turnCount}`),
            completedAt: createdAt,
            checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
            status: "ready",
            files: [],
            checkpointTurnCount: turnCount,
            createdAt,
          }),
        { concurrency: 1 },
      ).pipe(
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.checkpoint.revert",
            commandId: CommandId.make("cmd-boundary-revert-request"),
            threadId,
            turnCount: 1,
            createdAt,
          }),
        ),
      ),
    );

    await runtime!.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Deferred.await(restoreEntered);
          const nextTurn = yield* harness.preTurnCheckpoint
            .ensure({ threadId, createdAt })
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;

          expect(nextTurn.pollUnsafe()).toBeUndefined();
          expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");

          yield* Deferred.succeed(releaseRestore, undefined);
          yield* Fiber.join(nextTurn);
        }),
      ),
    );
    await harness.drain();

    expect(
      NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe("v2\n");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
    ).toBe(false);
  });

  it("executes provider revert and emits thread.reverted for claude sessions", async () => {
    const harness = await createHarness({ providerName: ProviderDriverKind.make("claudeAgent") });
    const createdAt = "2026-01-01T00:00:00.000Z";

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
    const createdAt = "2026-01-01T00:00:00.000Z";

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
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-no-session"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });
});
