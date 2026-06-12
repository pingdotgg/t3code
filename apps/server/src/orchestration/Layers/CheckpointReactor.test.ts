// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import {
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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { TurnFileSnapshots } from "../../persistence/Services/TurnFileSnapshots.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { TurnFileSnapshotsLive } from "../../persistence/Layers/TurnFileSnapshots.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  checkpointAttributedRefForThreadTurn,
  checkpointRefForThreadTurn,
  checkpointStartRefForThreadTurn,
} from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { WorkspaceEntriesLive } from "../../workspace/Layers/WorkspaceEntries.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

function emptyWorkingTree() {
  return {
    files: [],
    insertions: 0,
    deletions: 0,
    staged: { files: [], insertions: 0, deletions: 0 },
    unstaged: { files: [], insertions: 0, deletions: 0 },
  };
}

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
) {
  const now = "2026-01-01T00:00:00.000Z";
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn(
    (_input: { readonly threadId: ThreadId; readonly numTurns: number }) => Effect.void,
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
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
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
    refreshUsage: () => Effect.succeed({ accountRateLimits: [] }),
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
  let runtime: { readonly dispose: () => Promise<void> } | null = null;
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
    readonly gitStatusRefreshCalls?: Array<string>;
  }) {
    const cwd = createGitRepository();
    tempDirs.push(cwd);
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? ProviderDriverKind.make("codex"),
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolverLive),
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
            refName: "main",
            hasWorkingTreeChanges: false,
            workingTree: emptyWorkingTree(),
          }),
        ),
      refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
      streamStatus: () => Stream.empty,
    });

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(vcsStatusBroadcasterLayer),
      Layer.provideMerge(CheckpointStoreLive.pipe(Layer.provide(VcsDriverRegistry.layer))),
      Layer.provideMerge(
        WorkspaceEntriesLive.pipe(
          Layer.provide(WorkspacePathsLive),
          Layer.provideMerge(VcsDriverRegistry.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePathsLive),
      Layer.provideMerge(TurnFileSnapshotsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    const testRuntime = ManagedRuntime.make(layer);
    runtime = testRuntime;
    const engine = await testRuntime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await testRuntime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await testRuntime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await testRuntime.runPromise(Effect.service(CheckpointStore));
    const turnFileSnapshots = await testRuntime.runPromise(Effect.service(TurnFileSnapshots));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    const createdAt = "2026-01-01T00:00:00.000Z";
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
      await testRuntime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
      await testRuntime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
      await testRuntime.runPromise(
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
      cwd,
      drain,
      checkpointStore,
      turnFileSnapshots,
      runEffect: <A, E>(effect: Effect.Effect<A, E, never>) => testRuntime.runPromise(effect),
    };
  }

  type Harness = Awaited<ReturnType<typeof createHarness>>;

  async function setThreadSession(
    harness: Harness,
    input: {
      readonly commandId: string;
      readonly status: "ready" | "running" | "stopped";
      readonly activeTurnId: TurnId | null;
      readonly createdAt?: string;
    },
  ) {
    const threadId = ThreadId.make("thread-1");
    const createdAt = input.createdAt ?? "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(input.commandId),
        threadId,
        session: {
          threadId,
          status: input.status,
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: input.activeTurnId,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
  }

  async function dispatchTurnDiffComplete(
    harness: Harness,
    input: {
      readonly commandId: string;
      readonly turnId: TurnId;
      readonly status: "ready" | "missing";
      readonly checkpointTurnCount: number;
      readonly files?: ReadonlyArray<string>;
      readonly attribution?: "edit-snapshots" | "touched-paths" | "unattributed";
      readonly completedAt?: string;
      readonly createdAt?: string;
    },
  ) {
    const threadId = ThreadId.make("thread-1");
    const createdAt = input.createdAt ?? "2026-01-01T00:00:01.000Z";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make(input.commandId),
        threadId,
        turnId: input.turnId,
        completedAt: input.completedAt ?? createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, input.checkpointTurnCount),
        status: input.status,
        files: (input.files ?? []).map((filePath) => ({
          path: filePath,
          kind: "modified",
          additions: 1,
          deletions: 0,
        })),
        attribution: input.attribution ?? "unattributed",
        checkpointTurnCount: input.checkpointTurnCount,
        createdAt,
      }),
    );
  }

  async function upsertCurrentFileSnapshot(
    harness: Harness,
    input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly path: string;
      readonly updatedAt: string;
    },
  ) {
    const blobSha = await harness.runEffect(
      harness.checkpointStore.hashFileBlob({
        cwd: harness.cwd,
        path: input.path,
      }),
    );
    if (!blobSha) {
      throw new Error(`Expected blob for ${input.path}`);
    }
    await harness.runEffect(
      harness.turnFileSnapshots.upsertSnapshot({
        threadId: input.threadId,
        turnId: input.turnId,
        path: input.path,
        blobSha,
        deleted: false,
        updatedAt: input.updatedAt,
      }),
    );
  }

  it("captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

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

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
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
      gitRefExists(harness.cwd, checkpointStartRefForThreadTurn(ThreadId.make("thread-1"), 1)),
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

  it("defers mid-turn placeholder capture and finalizes the complete edit-snapshot diff on completion", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-mid-capture-freeze");

    await setThreadSession(harness, {
      commandId: "cmd-session-set-mid-capture-running",
      status: "running",
      activeTurnId: turnId,
    });
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-mid-capture-freeze"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointStartRefForThreadTurn(threadId, 1));

    fs.writeFileSync(path.join(harness.cwd, "file-a.txt"), "a1\n", "utf8");
    await upsertCurrentFileSnapshot(harness, {
      threadId,
      turnId,
      path: "file-a.txt",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    await dispatchTurnDiffComplete(harness, {
      commandId: "cmd-placeholder-mid-capture-freeze",
      turnId,
      status: "missing",
      checkpointTurnCount: 1,
      completedAt: "2026-01-01T00:00:01.000Z",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.drain();

    const placeholderThread = await waitForThread(harness.readModel, (thread) =>
      thread.checkpoints.some((checkpoint) => checkpoint.turnId === turnId),
    );
    const placeholderCheckpoint = placeholderThread.checkpoints.find(
      (checkpoint) => checkpoint.turnId === turnId,
    );
    expect(placeholderCheckpoint?.status).toBe("missing");
    expect(placeholderCheckpoint?.files).toEqual([]);
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(false);
    await expect(
      harness.runEffect(harness.turnFileSnapshots.getByTurn({ threadId, turnId })),
    ).resolves.toHaveLength(1);

    fs.writeFileSync(path.join(harness.cwd, "file-b.txt"), "b1\n", "utf8");
    await upsertCurrentFileSnapshot(harness, {
      threadId,
      turnId,
      path: "file-b.txt",
      updatedAt: "2026-01-01T00:00:02.000Z",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-mid-capture-freeze"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:03.000Z",
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    const finalThread = await waitForThread(harness.readModel, (thread) =>
      thread.checkpoints.some(
        (checkpoint) =>
          checkpoint.turnId === turnId &&
          checkpoint.status === "ready" &&
          checkpoint.files.length === 2,
      ),
    );
    const finalCheckpoint = finalThread.checkpoints.find(
      (checkpoint) => checkpoint.turnId === turnId,
    );
    expect(finalCheckpoint?.checkpointTurnCount).toBe(1);
    expect(finalCheckpoint?.attribution).toBe("edit-snapshots");
    expect(finalCheckpoint?.files.map((file) => file.path).toSorted()).toEqual([
      "file-a.txt",
      "file-b.txt",
    ]);
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(true);
  });

  it("re-captures and supersedes a premature ready checkpoint when the turn completes", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-recapture-ready");

    await setThreadSession(harness, {
      commandId: "cmd-session-set-recapture-running",
      status: "running",
      activeTurnId: turnId,
    });
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-recapture-ready"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointStartRefForThreadTurn(threadId, 1));

    fs.writeFileSync(path.join(harness.cwd, "file-a.txt"), "a1\n", "utf8");
    await harness.runEffect(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
      }),
    );
    await dispatchTurnDiffComplete(harness, {
      commandId: "cmd-premature-ready-recapture",
      turnId,
      status: "ready",
      checkpointTurnCount: 1,
      files: ["file-a.txt"],
      attribution: "edit-snapshots",
      completedAt: "2026-01-01T00:00:01.000Z",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await waitForThread(harness.readModel, (thread) =>
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.files.length === 1,
      ),
    );

    await upsertCurrentFileSnapshot(harness, {
      threadId,
      turnId,
      path: "file-a.txt",
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    fs.writeFileSync(path.join(harness.cwd, "file-b.txt"), "b1\n", "utf8");
    await upsertCurrentFileSnapshot(harness, {
      threadId,
      turnId,
      path: "file-b.txt",
      updatedAt: "2026-01-01T00:00:03.000Z",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-recapture-ready"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:04.000Z",
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    const finalThread = await waitForThread(harness.readModel, (thread) =>
      thread.checkpoints.some(
        (checkpoint) =>
          checkpoint.turnId === turnId &&
          checkpoint.status === "ready" &&
          checkpoint.files.length === 2,
      ),
    );
    const finalCheckpoint = finalThread.checkpoints.find(
      (checkpoint) => checkpoint.turnId === turnId,
    );
    expect(finalThread.checkpoints).toHaveLength(1);
    expect(finalCheckpoint?.checkpointTurnCount).toBe(1);
    expect(finalCheckpoint?.files.map((file) => file.path).toSorted()).toEqual([
      "file-a.txt",
      "file-b.txt",
    ]);
    expect(
      gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 1), "file-b.txt"),
    ).toBe("b1\n");
  });

  it("finalizes a lingering placeholder when the session settles ready", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-session-ready-finalize");

    await setThreadSession(harness, {
      commandId: "cmd-session-set-ready-finalize-running",
      status: "running",
      activeTurnId: turnId,
    });
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-session-ready-finalize"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointStartRefForThreadTurn(threadId, 1));

    fs.writeFileSync(path.join(harness.cwd, "settled-ready.txt"), "ready\n", "utf8");
    await upsertCurrentFileSnapshot(harness, {
      threadId,
      turnId,
      path: "settled-ready.txt",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    await dispatchTurnDiffComplete(harness, {
      commandId: "cmd-placeholder-session-ready-finalize",
      turnId,
      status: "missing",
      checkpointTurnCount: 1,
      completedAt: "2026-01-01T00:00:01.000Z",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.drain();

    await setThreadSession(harness, {
      commandId: "cmd-session-set-ready-finalize-settled",
      status: "ready",
      activeTurnId: null,
      createdAt: "2026-01-01T00:00:02.000Z",
    });

    const finalThread = await waitForThread(harness.readModel, (thread) =>
      thread.checkpoints.some(
        (checkpoint) =>
          checkpoint.turnId === turnId &&
          checkpoint.status === "ready" &&
          checkpoint.files.length === 1,
      ),
    );
    const checkpoint = finalThread.checkpoints.find((entry) => entry.turnId === turnId);
    expect(checkpoint?.files.map((file) => file.path)).toEqual(["settled-ready.txt"]);
    expect(checkpoint?.attribution).toBe("edit-snapshots");
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(true);
  });

  it("finalizes a lingering placeholder when the session settles stopped", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-session-stopped-finalize");

    await setThreadSession(harness, {
      commandId: "cmd-session-set-stopped-finalize-running",
      status: "running",
      activeTurnId: turnId,
    });
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-session-stopped-finalize"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointStartRefForThreadTurn(threadId, 1));

    fs.writeFileSync(path.join(harness.cwd, "settled-stopped.txt"), "stopped\n", "utf8");
    await upsertCurrentFileSnapshot(harness, {
      threadId,
      turnId,
      path: "settled-stopped.txt",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    await dispatchTurnDiffComplete(harness, {
      commandId: "cmd-placeholder-session-stopped-finalize",
      turnId,
      status: "missing",
      checkpointTurnCount: 1,
      completedAt: "2026-01-01T00:00:01.000Z",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.drain();

    await setThreadSession(harness, {
      commandId: "cmd-session-set-stopped-finalize-settled",
      status: "stopped",
      activeTurnId: null,
      createdAt: "2026-01-01T00:00:02.000Z",
    });

    const finalThread = await waitForThread(harness.readModel, (thread) =>
      thread.checkpoints.some(
        (checkpoint) =>
          checkpoint.turnId === turnId &&
          checkpoint.status === "ready" &&
          checkpoint.files.length === 1,
      ),
    );
    const checkpoint = finalThread.checkpoints.find((entry) => entry.turnId === turnId);
    expect(checkpoint?.files.map((file) => file.path)).toEqual(["settled-stopped.txt"]);
    expect(checkpoint?.attribution).toBe("edit-snapshots");
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(true);
  });

  it("does not finalize a lingering placeholder while the session is still running", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-session-running-no-finalize");

    await setThreadSession(harness, {
      commandId: "cmd-session-set-running-no-finalize",
      status: "running",
      activeTurnId: turnId,
    });
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-session-running-no-finalize"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointStartRefForThreadTurn(threadId, 1));

    fs.writeFileSync(path.join(harness.cwd, "still-running.txt"), "running\n", "utf8");
    await upsertCurrentFileSnapshot(harness, {
      threadId,
      turnId,
      path: "still-running.txt",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    await dispatchTurnDiffComplete(harness, {
      commandId: "cmd-placeholder-session-running-no-finalize",
      turnId,
      status: "missing",
      checkpointTurnCount: 1,
      completedAt: "2026-01-01T00:00:01.000Z",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.drain();

    await setThreadSession(harness, {
      commandId: "cmd-session-set-running-no-finalize-again",
      status: "running",
      activeTurnId: turnId,
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    const checkpoint = thread?.checkpoints.find((entry) => entry.turnId === turnId);
    expect(checkpoint?.status).toBe("missing");
    expect(checkpoint?.files).toEqual([]);
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(false);
  });

  it("overwrites the turn-start ref on repeated start signals without replacing turn-0", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-overwrite-start");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-overwrite-start"),
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
      eventId: EventId.make("evt-turn-started-overwrite-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointStartRefForThreadTurn(threadId, 1));

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "later baseline\n", "utf8");
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-overwrite-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId,
      turnId,
    });
    await harness.drain();

    expect(
      gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 0), "README.md"),
    ).toBe("v1\n");
    expect(
      gitShowFileAtRef(harness.cwd, checkpointStartRefForThreadTurn(threadId, 1), "README.md"),
    ).toBe("later baseline\n");
  });

  it("uses edit-time blobs so same-file workspace overlap does not enter the turn diff", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-same-file");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-same-file"),
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
      eventId: EventId.make("evt-turn-started-same-file"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointStartRefForThreadTurn(threadId, 1));

    fs.writeFileSync(path.join(harness.cwd, "shared.txt"), "version-A\n", "utf8");
    const blobSha = await harness.runEffect(
      harness.checkpointStore.hashFileBlob({
        cwd: harness.cwd,
        path: "shared.txt",
      }),
    );
    expect(blobSha).toMatch(/^[0-9a-f]{40}$/);
    await harness.runEffect(
      harness.turnFileSnapshots.upsertSnapshot({
        threadId,
        turnId,
        path: "shared.txt",
        blobSha: blobSha ?? null,
        deleted: false,
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    fs.writeFileSync(path.join(harness.cwd, "shared.txt"), "version-B\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-same-file"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    const events = await waitForEvent(
      harness.engine,
      (event) => event.type === "thread.turn-diff-completed",
    );
    const completedEvent = events.find((event) => event.type === "thread.turn-diff-completed");
    const completedPayload = (
      completedEvent as
        | {
            readonly payload?: {
              readonly attribution?: string;
              readonly files?: ReadonlyArray<{ readonly path: string }>;
            };
          }
        | undefined
    )?.payload;
    expect(completedPayload?.attribution).toBe("edit-snapshots");
    expect(completedPayload?.files?.map((file) => file.path)).toEqual(["shared.txt"]);

    const startRef = checkpointStartRefForThreadTurn(threadId, 1);
    const attributedRef = checkpointAttributedRefForThreadTurn(threadId, 1);
    const fullTurnRef = checkpointRefForThreadTurn(threadId, 1);
    await waitForGitRefExists(harness.cwd, attributedRef);

    expect(gitShowFileAtRef(harness.cwd, attributedRef, "shared.txt")).toBe("version-A\n");
    expect(gitShowFileAtRef(harness.cwd, fullTurnRef, "shared.txt")).toBe("version-B\n");

    const attributedDiff = runGit(harness.cwd, ["diff", startRef, attributedRef]);
    expect(attributedDiff).toContain("+version-A");
    expect(attributedDiff).not.toContain("version-B");
  });

  it("uses touched-path attribution for path-only rows", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-path-only");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-path-only"),
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
      eventId: EventId.make("evt-turn-started-path-only"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointStartRefForThreadTurn(threadId, 1));

    fs.writeFileSync(path.join(harness.cwd, "a.txt"), "a2\n", "utf8");
    fs.writeFileSync(path.join(harness.cwd, "b.txt"), "b2\n", "utf8");
    await harness.runEffect(
      harness.turnFileSnapshots.upsertSnapshot({
        threadId,
        turnId,
        path: "a.txt",
        blobSha: null,
        deleted: false,
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-path-only"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    const events = await waitForEvent(
      harness.engine,
      (event) => event.type === "thread.turn-diff-completed",
    );
    const completedEvent = events.find((event) => event.type === "thread.turn-diff-completed");
    const completedPayload = (
      completedEvent as
        | {
            readonly payload?: {
              readonly attribution?: string;
              readonly files?: ReadonlyArray<{ readonly path: string }>;
            };
          }
        | undefined
    )?.payload;
    expect(completedPayload?.attribution).toBe("touched-paths");
    expect(completedPayload?.files?.map((file) => file.path)).toEqual(["a.txt"]);
    expect(gitRefExists(harness.cwd, checkpointAttributedRefForThreadTurn(threadId, 1))).toBe(
      false,
    );
  });

  it("records deleted edit-snapshot rows as deletions in the attributed diff", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-delete");

    fs.writeFileSync(path.join(harness.cwd, "delete-me.txt"), "delete me\n", "utf8");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-delete"),
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
      eventId: EventId.make("evt-turn-started-delete"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointStartRefForThreadTurn(threadId, 1));

    fs.rmSync(path.join(harness.cwd, "delete-me.txt"));
    await harness.runEffect(
      harness.turnFileSnapshots.upsertSnapshot({
        threadId,
        turnId,
        path: "delete-me.txt",
        blobSha: null,
        deleted: true,
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-delete"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    const events = await waitForEvent(
      harness.engine,
      (event) => event.type === "thread.turn-diff-completed",
    );
    const completedEvent = events.find((event) => event.type === "thread.turn-diff-completed");
    const completedPayload = (
      completedEvent as
        | {
            readonly payload?: {
              readonly attribution?: string;
              readonly files?: ReadonlyArray<{ readonly path: string }>;
            };
          }
        | undefined
    )?.payload;
    expect(completedPayload?.attribution).toBe("edit-snapshots");
    expect(completedPayload?.files?.map((file) => file.path)).toEqual(["delete-me.txt"]);

    const attributedDiff = runGit(harness.cwd, [
      "diff",
      checkpointStartRefForThreadTurn(threadId, 1),
      checkpointAttributedRefForThreadTurn(threadId, 1),
    ]);
    expect(attributedDiff).toContain("diff --git a/delete-me.txt b/delete-me.txt");
    expect(attributedDiff).toContain("deleted file mode");
  });

  it("degrades over the touched-path cap to unattributed full-tree diffs", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-over-cap");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-over-cap"),
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
      eventId: EventId.make("evt-turn-started-over-cap"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointStartRefForThreadTurn(threadId, 1));

    fs.writeFileSync(path.join(harness.cwd, "scoped.txt"), "scoped\n", "utf8");
    fs.writeFileSync(path.join(harness.cwd, "unscoped.txt"), "unscoped\n", "utf8");
    for (let index = 0; index <= 500; index += 1) {
      await harness.runEffect(
        harness.turnFileSnapshots.upsertSnapshot({
          threadId,
          turnId,
          path: `src/touched-${String(index).padStart(3, "0")}.ts`,
          blobSha: null,
          deleted: false,
          updatedAt: "2026-01-01T00:00:01.000Z",
        }),
      );
    }

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-over-cap"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    const events = await waitForEvent(
      harness.engine,
      (event) => event.type === "thread.turn-diff-completed",
    );
    const completedEvent = events.find((event) => event.type === "thread.turn-diff-completed");
    const completedPayload = (
      completedEvent as
        | {
            readonly payload?: {
              readonly attribution?: string;
              readonly files?: ReadonlyArray<{ readonly path: string }>;
            };
          }
        | undefined
    )?.payload;
    const completedPaths = completedPayload?.files?.map((file) => file.path) ?? [];
    expect(completedPayload?.attribution).toBe("unattributed");
    expect(completedPaths).toEqual(expect.arrayContaining(["scoped.txt", "unscoped.txt"]));
  });

  it("excludes workspace changes made between a thread's turns via the next turn-start baseline", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const firstTurnId = asTurnId("turn-baseline-1");
    const secondTurnId = asTurnId("turn-baseline-2");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-baseline-between-turns"),
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
      eventId: EventId.make("evt-turn-started-baseline-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: firstTurnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointStartRefForThreadTurn(threadId, 1));
    fs.writeFileSync(path.join(harness.cwd, "a.txt"), "a1\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-baseline-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId,
      turnId: firstTurnId,
      payload: { state: "completed" },
    });
    await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.turn-diff-completed" &&
        (event as { readonly payload?: { readonly turnId?: TurnId } }).payload?.turnId ===
          firstTurnId,
    );

    fs.writeFileSync(path.join(harness.cwd, "b.txt"), "between-turns\n", "utf8");
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-baseline-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId,
      turnId: secondTurnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointStartRefForThreadTurn(threadId, 2));
    fs.writeFileSync(path.join(harness.cwd, "a.txt"), "a2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-baseline-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:03.000Z",
      threadId,
      turnId: secondTurnId,
      payload: { state: "completed" },
    });

    const events = await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.turn-diff-completed" &&
        (event as { readonly payload?: { readonly turnId?: TurnId } }).payload?.turnId ===
          secondTurnId,
    );
    const completedEvent = events.find(
      (event) =>
        event.type === "thread.turn-diff-completed" &&
        (event as { readonly payload?: { readonly turnId?: TurnId } }).payload?.turnId ===
          secondTurnId,
    );
    const completedPayload = (
      completedEvent as
        | {
            readonly payload?: {
              readonly attribution?: string;
              readonly files?: ReadonlyArray<{ readonly path: string }>;
            };
          }
        | undefined
    )?.payload;
    expect(completedPayload?.attribution).toBe("unattributed");
    expect(completedPayload?.files?.map((file) => file.path)).toEqual(["a.txt"]);
    expect(
      gitShowFileAtRef(harness.cwd, checkpointStartRefForThreadTurn(threadId, 2), "b.txt"),
    ).toBe("between-turns\n");
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

  it("ignores auxiliary thread turn completion while primary turn is active", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

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

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");

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

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
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

  it("falls back to the previous full checkpoint when turn-start was missed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-missed-start");

    await harness.runEffect(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 0),
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missed-start"),
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

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "missed start\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missed-start"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    const events = await waitForEvent(
      harness.engine,
      (event) => event.type === "thread.turn-diff-completed",
    );
    const completedEvent = events.find((event) => event.type === "thread.turn-diff-completed");
    const completedPayload = (
      completedEvent as
        | {
            readonly payload?: {
              readonly attribution?: string;
              readonly files?: ReadonlyArray<{ readonly path: string }>;
            };
          }
        | undefined
    )?.payload;
    expect(gitRefExists(harness.cwd, checkpointStartRefForThreadTurn(threadId, 1))).toBe(false);
    expect(completedPayload?.attribution).toBe("unattributed");
    expect(completedPayload?.files?.map((file) => file.path)).toEqual(["README.md"]);
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

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
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
    const nonRepositorySessionCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "t3-checkpoint-runtime-non-repo-"),
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
    await harness.runEffect(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointStartRefForThreadTurn(ThreadId.make("thread-1"), 2),
      }),
    );
    await harness.runEffect(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointAttributedRefForThreadTurn(ThreadId.make("thread-1"), 2),
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
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
    ).toBe(false);
    expect(
      gitRefExists(harness.cwd, checkpointStartRefForThreadTurn(ThreadId.make("thread-1"), 2)),
    ).toBe(false);
    expect(
      gitRefExists(harness.cwd, checkpointAttributedRefForThreadTurn(ThreadId.make("thread-1"), 2)),
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
