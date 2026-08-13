import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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
import { Deferred, Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { CheckpointInvariantError } from "../../checkpointing/Errors.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
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
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";

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
) {
  const now = new Date().toISOString();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn(
    (_input: { readonly threadId: ThreadId; readonly numTurns: number }) =>
      failRollback
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
    OrchestrationEngineService | CheckpointReactor | CheckpointStore,
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
    readonly gitStatusRefreshCalls?: Array<string>;
    readonly failCheckpointCapture?: boolean;
    readonly awaitRuntimeEventProcessed?: (eventId: EventId) => Effect.Effect<void>;
  }) {
    const cwd = createGitRepository();
    tempDirs.push(cwd);
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? ProviderDriverKind.make("codex"),
      options?.failProviderRollback ?? false,
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
    const checkpointStoreLayer = options?.failCheckpointCapture
      ? Layer.effect(
          CheckpointStore,
          Effect.gen(function* () {
            const checkpointStore = yield* CheckpointStore;
            return {
              ...checkpointStore,
              captureCheckpoint: () =>
                Effect.fail(
                  new CheckpointInvariantError({
                    operation: "CheckpointStore.captureCheckpoint",
                    detail: "Injected capture failure.",
                  }),
                ),
            };
          }).pipe(Effect.provide(CheckpointStoreLive)),
        )
      : CheckpointStoreLive;

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(
        Layer.succeed(ProviderRuntimeIngestionService, {
          start: () => Effect.void,
          drain: Effect.void,
          awaitTurnCompletionProcessed: options?.awaitRuntimeEventProcessed ?? (() => Effect.void),
        }),
      ),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(gitStatusBroadcasterLayer),
      Layer.provideMerge(checkpointStoreLayer),
      Layer.provideMerge(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
      Layer.provideMerge(WorkspacePathsLive),
      Layer.provideMerge(GitCoreLive),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    const createdAt = new Date().toISOString();
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

    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        }),
      );
    }

    return {
      engine,
      provider,
      checkpointStore,
      cwd,
      drain,
    };
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
    tempDirs.push(nonGitCwd);
    const harness = await createHarness({
      projectWorkspaceRoot: nonGitCwd,
      providerSessionCwd: nonGitCwd,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: nonGitCwd,
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
        kind: "modified",
        additions: 1,
        deletions: 0,
      },
      {
        path: "src/second.ts",
        kind: "modified",
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
            kind: "modified",
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
        kind: "modified",
        additions: 1,
        deletions: 0,
      },
    ]);
    expect(checkpoint?.agentTouchedPaths).toEqual(["apps/web/src/components/Sidebar.tsx"]);
    expect(checkpoint?.turnFiles).toEqual([
      {
        path: "apps/web/src/components/Sidebar.tsx",
        kind: "modified",
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
            kind: "modified",
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
        kind: "modified",
        additions: 1,
        deletions: 0,
      },
      { path: "README.md", kind: "modified", additions: 1, deletions: 1 },
    ]);
    expect(checkpoint?.turnFiles).toEqual([
      {
        path: "apps/web/src/components/Sidebar.tsx",
        kind: "modified",
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

  it("captures turn completion checkpoint from project workspace root when provider session cwd is unavailable", async () => {
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
    await harness.drain();
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
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

  it("restores the guard when a current-checkpoint revert fails to commit", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "staged before revert\n", "utf8");
    runGit(harness.cwd, ["add", "README.md"]);
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "unstaged before revert\n", "utf8");

    const dispatch = harness.engine.dispatch;
    vi.spyOn(harness.engine, "dispatch").mockImplementation((command) =>
      command.type === "thread.revert.complete"
        ? Effect.die(new Error("Injected revert commit failure."))
        : dispatch(command),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-current-checkpoint-revert"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 2,
        createdAt,
      }),
    );

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(runGit(harness.cwd, ["show", ":README.md"])).toBe("staged before revert\n");
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe(
      "unstaged before revert\n",
    );
    expect(
      gitRefExists(harness.cwd, checkpointRevertGuardRefForThread(ThreadId.make("thread-1"))),
    ).toBe(false);
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
