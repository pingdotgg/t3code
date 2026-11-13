import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import {
  layerTaskFoldersWithGit,
  taskFoldersTestProjectId as projectId,
  type TaskFoldersTestState,
} from "../workspace/TaskFolders.testkit.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const threadId = ThreadId.make("thread:task-folder-rewind");
const providerThreadId = ProviderThreadId.make("provider-thread:task-folder-rewind");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "test" };
const branch = "feature/rewind";

interface Options {
  /** The project folder is a repository, so the task folder checks it out; otherwise it is linked. */
  readonly projectIsRepository: boolean;
  /** The worktrees directory is reached through a symlink. */
  readonly symlinkedWorktrees?: boolean;
}

/** What the test supplies before the layer is built; the last commit's events land in `committed`. */
interface State extends TaskFoldersTestState {
  readonly committed: Array<OrchestrationV2DomainEvent>;
}

const layerFor = (state: State, options: Options) => {
  const layerNode = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
  const layerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const base = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rewind-worktrees-" }),
      );
      const real = path.join(base, "real");
      yield* fileSystem.makeDirectory(real);
      if (options.symlinkedWorktrees !== true) return { ...config, worktreesDir: real };
      yield* fileSystem.symlink(real, path.join(base, "linked"));
      return { ...config, worktreesDir: path.join(base, "linked") };
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-rewind-" })),
    Layer.provide(layerNode),
  );
  const layerGit = GitVcsDriver.layer.pipe(
    Layer.provideMerge(layerConfig),
    Layer.provideMerge(layerNode),
  );
  const layerTaskFolders = layerTaskFoldersWithGit(state).pipe(Layer.provide(layerGit));
  const layerProjections = ProjectionStore.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  const layerProjects = Layer.mock(ProjectStore.ProjectStoreV2)({});
  const layerCheckpointStore = CheckpointStore.layer.pipe(
    Layer.provide(
      VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer.pipe(Layer.provide(layerNode)))),
    ),
    Layer.provide(layerNode),
  );
  const layerCheckpoints = CheckpointService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        layerNode,
        layerCheckpointStore,
        WorkspaceFolders.layer.pipe(
          Layer.provide(Layer.mergeAll(layerProjects, layerTaskFolders, layerNode)),
        ),
      ),
    ),
  );
  const { committed } = state;
  const layerEventSink = Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const record = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
        Effect.forEach(events, (event) => store.apply(event), { discard: true }).pipe(
          Effect.andThen(Effect.sync(() => committed.splice(0, committed.length, ...events))),
          Effect.orDie,
        );
      type Written = { readonly events: ReadonlyArray<OrchestrationV2DomainEvent> };
      return {
        commitCommand: (input: Written) =>
          record(input.events).pipe(Effect.as({ committed: true })),
        write: (input: Written) => record(input.events).pipe(Effect.as([])),
      } as never;
    }),
  ).pipe(Layer.provide(layerProjections));
  const layerWorkflow = Layer.unwrap(
    Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      return Layer.mock(GitWorkflow.GitWorkflowService)({
        createWorktree: git.createWorktree,
        pruneWorktrees: git.pruneWorktrees,
      });
    }),
  ).pipe(Layer.provide(layerGit));
  return Layer.mergeAll(
    layerGit,
    layerTaskFolders,
    layerProjections,
    layerCheckpoints,
    IdAllocator.layer,
    CheckpointCaptureService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(layerCheckpoints, layerEventSink, IdAllocator.layer, layerProjections),
      ),
    ),
    CheckpointRollbackService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerCheckpoints,
          layerEventSink,
          layerWorkflow,
          IdAllocator.layer,
          layerProjections,
          layerProjects,
          layerTaskFolders,
          layerConfig,
          layerNode,
          ServerSettings.layerTest(),
          ThreadCommandExecutor.layer,
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            open: () =>
              Effect.succeed({
                rollbackThread: (input: { readonly providerThread: unknown }) =>
                  Effect.succeed({ providerThread: input.providerThread }),
              } as never),
          }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
        ),
      ),
    ),
  );
};

/**
 * A worktree thread of a project tracking the `api` and `web` repositories, on real Git. `api`
 * sits inside the project folder and `web` beside it.
 */
const taskFolderThread = Effect.fn(function* (state: State, options: Options) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const taskFolders = yield* TaskFolders.TaskFolders;
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  const capture = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
  const rollbacks = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const { committed } = state;
  const now = yield* DateTime.now;
  const tmp = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rewind-" }),
  );
  const run = (cwd: string, ...args: ReadonlyArray<string>) =>
    git.execute({ operation: "rewind-test", cwd, args }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.orDie,
    );
  const write = (file: string, contents: string) =>
    fileSystem
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(file, contents)), Effect.orDie);
  const read = (file: string) =>
    fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => null));
  const repository = Effect.fnUntraced(function* (folder: string) {
    yield* write(path.join(folder, "README.md"), "start\n");
    yield* run(folder, "init", "-b", "main");
    yield* run(folder, "config", "user.email", "rewind@example.test");
    yield* run(folder, "config", "user.name", "Rewind");
    yield* run(folder, "add", ".");
    yield* run(folder, "commit", "-m", "initial");
  });
  const shop = path.join(tmp, "shop");
  yield* write(path.join(shop, "AGENTS.md"), "rules\n");
  if (options.projectIsRepository) yield* repository(shop);
  yield* repository(path.join(shop, "api"));
  yield* repository(path.join(tmp, "web"));
  state.workspaceRoot = shop;
  state.trackedFolders = [
    { path: path.join(shop, "api"), name: "api" },
    { path: path.join(tmp, "web"), name: "web" },
  ];
  const plan = yield* taskFolders.plan({ projectId });
  const { taskFolder } = yield* taskFolders.create({
    plan: plan!,
    branch,
    projectStart: { refName: "main", baseRefName: "main" },
    startFromOrigin: false,
  });
  const worktreePath = taskFolder.projectPath;
  const folders = {
    shop: worktreePath,
    api: path.join(worktreePath, "api"),
    web: path.join(taskFolder.root, "web"),
  };

  const rootScope = yield* checkpoints.prepareRootRunScope({
    threadId,
    runId: RunId.make("run:rewind:1"),
    rootNodeId: NodeId.make("node:rewind:1"),
    providerThreadId,
    cwd: worktreePath,
    createdAt: now,
  });
  let sequence = 0;
  type EventInput<Event = OrchestrationV2DomainEvent> = Event extends OrchestrationV2DomainEvent
    ? Omit<Event, "id" | "occurredAt" | "threadId">
    : never;
  const apply = (event: EventInput) =>
    store
      .apply({
        ...event,
        id: EventId.make(`event:rewind:${sequence++}`),
        threadId,
        occurredAt: now,
      } as OrchestrationV2DomainEvent)
      .pipe(Effect.orDie);
  yield* apply({
    type: "thread.created",
    payload: {
      id: threadId,
      createdBy: "user",
      creationSource: "web",
      projectId,
      title: "Rewind",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch,
      worktreePath,
      activeProviderThreadId: providerThreadId,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* apply({
    type: "provider-thread.updated",
    payload: {
      id: providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId: ProviderSessionId.make("provider-session:rewind"),
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* apply({ type: "checkpoint-scope.created", payload: rootScope });

  /** One turn: baseline, the turn's edits, then the capture. Returns the files each folder recorded. */
  const turn = Effect.fnUntraced(function* (ordinal: number, edits: Effect.Effect<void>) {
    const key = String(ordinal);
    const runId = RunId.make(`run:rewind:${key}`);
    const nodeId = NodeId.make(`node:rewind:${key}`);
    const attemptId = RunAttemptId.make(`attempt:rewind:${key}`);
    const turnId = ProviderTurnId.make(`turn:rewind:${key}`);
    yield* apply({
      type: "run.created",
      payload: {
        id: runId,
        threadId,
        ordinal,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message:rewind:${key}`),
        rootNodeId: nodeId,
        activeAttemptId: attemptId,
        status: "waiting",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    yield* apply({
      type: "node.updated",
      payload: {
        id: nodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "root_turn",
        status: "waiting",
        countsForRun: true,
        providerThreadId,
        providerTurnId: turnId,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: rootScope.id,
        startedAt: now,
        completedAt: null,
      },
    });
    yield* apply({
      type: "run-attempt.created",
      runId,
      payload: {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId: turnId,
        reason: "initial",
        status: "completed",
        startedAt: now,
        completedAt: now,
      },
    });
    yield* apply({
      type: "provider-turn.updated",
      payload: {
        id: turnId,
        providerThreadId,
        nodeId,
        runAttemptId: attemptId,
        nativeTurnRef: { driver, nativeId: `native-turn:${key}`, strength: "strong" },
        ordinal,
        status: "completed",
        startedAt: now,
        completedAt: now,
      },
    });
    yield* checkpoints
      .captureBaseline({
        scope: rootScope,
        ordinalWithinScope: ordinal - 1,
        thread: { projectId, worktreePath },
      })
      .pipe(Effect.orDie);
    yield* edits;
    yield* capture.execute({ threadId, runId, scopeId: rootScope.id }).pipe(Effect.orDie);
    const scopes = yield* recordedScopes;
    return Object.fromEntries(
      committed.flatMap((event) =>
        event.type === "checkpoint.captured" && event.payload.runId !== null
          ? [
              [
                scopes.get(event.payload.scopeId) ?? "shop",
                event.payload.files.map((file) => file.path),
              ],
            ]
          : [],
      ),
    );
  });
  const records = store
    .getThreadRecords(threadId, ["runs", "checkpoints", "checkpointScopes"])
    .pipe(Effect.orDie);
  const recordedScopes = records.pipe(
    Effect.map(
      ({ checkpointScopes }) =>
        new Map(
          checkpointScopes.flatMap((scope) =>
            scope.label === undefined ? [] : [[scope.id, scope.label] as const],
          ),
        ),
    ),
  );
  /** Rewinds to the end of run `ordinal`, restoring files. */
  const rewind = Effect.fnUntraced(function* (ordinal: number) {
    const checkpointId = yield* ids.allocate
      .checkpoint({ checkpointScopeId: rootScope.id, name: String(ordinal) })
      .pipe(Effect.orDie);
    yield* rollbacks.execute({ threadId, providerThreadId, checkpointId, scopeId: rootScope.id });
  });
  /** Run statuses by ordinal, and each folder's checkpoint statuses by ordinal. */
  const recorded = Effect.gen(function* () {
    const { runs, checkpoints: all } = yield* records;
    const scopes = yield* recordedScopes;
    const statuses: Record<string, Record<number, string>> = {};
    for (const checkpoint of all) {
      (statuses[scopes.get(checkpoint.scopeId) ?? "shop"] ??= {})[checkpoint.ordinalWithinScope] =
        checkpoint.status;
    }
    return {
      runs: runs.toSorted((left, right) => left.ordinal - right.ordinal).map((run) => run.status),
      checkpoints: statuses,
    };
  });
  return {
    path,
    fileSystem,
    run,
    write,
    read,
    folders,
    taskFolder,
    turn,
    rewind,
    recorded,
    records,
    apply,
  };
});

const withThread = <A, E>(
  options: Options,
  test: (
    thread: Effect.Success<ReturnType<typeof taskFolderThread>>,
  ) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerFor>>>,
) => {
  const state: State = { workspaceRoot: "/unset", trackedFolders: [], thread: null, committed: [] };
  return taskFolderThread(state, options).pipe(
    Effect.flatMap(test),
    Effect.provide(layerFor(state, options)),
    Effect.scoped,
  );
};

it.live.each([{ symlinkedWorktrees: false }, { symlinkedWorktrees: true }])(
  "rewinds the project folder and every repository a discarded turn changed, symlinked worktrees directory=$symlinkedWorktrees",
  ({ symlinkedWorktrees }) =>
    withThread({ projectIsRepository: true, symlinkedWorktrees }, (thread) =>
      Effect.gen(function* () {
        const { path, folders, write, read } = thread;
        const file = (folder: keyof typeof folders, name = "a.txt") =>
          path.join(folders[folder], name);
        yield* thread.turn(
          1,
          Effect.all([write(file("shop"), "1"), write(file("api"), "1"), write(file("web"), "1")]),
        );
        yield* thread.turn(2, Effect.all([write(file("shop"), "2"), write(file("api"), "2")]));
        yield* thread.turn(
          3,
          Effect.all([
            write(file("shop", "new.txt"), "3"),
            write(file("api", "new.txt"), "3"),
            write(file("web"), "3"),
          ]),
        );

        yield* thread.rewind(1);

        assert.deepEqual(
          yield* Effect.all([
            read(file("shop")),
            read(file("shop", "new.txt")),
            read(file("api")),
            read(file("api", "new.txt")),
            read(file("web")),
          ]),
          ["1", null, "1", null, "1"],
        );
        // The project folder's restore left the worktree inside it checked out.
        assert.equal(yield* thread.run(folders.api, "rev-parse", "--abbrev-ref", "HEAD"), branch);
        const recorded = yield* thread.recorded;
        assert.deepEqual(recorded.runs, ["completed", "rolled_back", "rolled_back"]);
        assert.deepEqual(recorded.checkpoints, {
          shop: { 0: "ready", 1: "ready", 2: "stale", 3: "stale" },
          api: { 0: "ready", 1: "ready", 2: "stale", 3: "stale" },
          web: { 0: "ready", 1: "ready", 2: "stale", 3: "stale" },
        });

        // The next turn starts from what the rewind restored, in every folder.
        assert.deepEqual(yield* thread.turn(4, write(file("api"), "again")), {
          shop: [],
          api: ["a.txt"],
        });
      }),
    ),
);

it.live("rewinds a linked project folder's repositories to how each was before the turn", () =>
  withThread({ projectIsRepository: false }, (thread) =>
    Effect.gen(function* () {
      const { path, folders, write, read } = thread;
      yield* thread.turn(1, write(path.join(folders.api, "a.txt"), "1"));
      yield* thread.turn(2, write(path.join(folders.api, "a.txt"), "2"));
      // The first turn to change web: it has no checkpoint at the turn the rewind goes back to.
      yield* thread.turn(3, write(path.join(folders.web, "a.txt"), "3"));
      assert.deepEqual((yield* thread.recorded).checkpoints, {
        shop: { 0: "missing", 1: "missing", 2: "missing", 3: "missing" },
        api: { 0: "ready", 1: "ready", 2: "ready" },
        web: { 2: "ready", 3: "ready" },
      });

      yield* thread.rewind(1);

      assert.deepEqual(
        yield* Effect.all([
          read(path.join(folders.api, "a.txt")),
          read(path.join(folders.web, "a.txt")),
          read(path.join(folders.web, "README.md")),
          read(path.join(folders.shop, "AGENTS.md")),
        ]),
        ["1", null, "start\n", "rules\n"],
      );
      assert.deepEqual((yield* thread.recorded).runs, ["completed", "rolled_back", "rolled_back"]);
      // A turn that changes only web lists web's file alone, against what the rewind left.
      assert.deepEqual(yield* thread.turn(4, write(path.join(folders.web, "b.txt"), "again")), {
        shop: [],
        web: ["b.txt"],
      });
    }),
  ),
);

it.live("refuses to restore files when a linked project folder has no repository to restore", () =>
  withThread({ projectIsRepository: false }, (thread) =>
    Effect.gen(function* () {
      yield* thread.turn(1, Effect.void);
      yield* thread.turn(2, Effect.void);

      const refused = yield* thread.rewind(1).pipe(Effect.flip);

      assert.equal(refused.reason, "rollback-target-invalid");
      assert.deepEqual((yield* thread.recorded).runs, ["completed", "completed"]);
    }),
  ),
);

it.live("refuses a project folder whose own snapshot is missing, before any folder changes", () =>
  withThread({ projectIsRepository: true }, (thread) =>
    Effect.gen(function* () {
      const { path, folders, write, read } = thread;
      yield* thread.turn(1, write(path.join(folders.api, "a.txt"), "1"));
      yield* thread.turn(2, write(path.join(folders.api, "a.txt"), "2"));
      const target = (yield* thread.records).checkpoints.find(
        (checkpoint) => checkpoint.appRunOrdinal === 1,
      )!;
      const untouched = Effect.gen(function* () {
        assert.equal(yield* read(path.join(folders.api, "a.txt")), "2");
        assert.deepEqual((yield* thread.recorded).runs, ["completed", "completed"]);
      });

      // Recorded as present, but the snapshot itself is gone.
      yield* thread.run(folders.shop, "update-ref", "-d", target.ref);
      assert.equal((yield* thread.rewind(1).pipe(Effect.flip)).reason, "unexpected-failure");
      yield* untouched;

      yield* thread.apply({
        type: "checkpoint.captured",
        nodeId: target.nodeId,
        payload: { ...target, status: "missing" },
      });
      assert.equal((yield* thread.rewind(1).pipe(Effect.flip)).reason, "rollback-target-invalid");
      yield* untouched;
    }),
  ),
);

it.live("puts restored folders back when a later folder's restore fails", () =>
  withThread({ projectIsRepository: true }, (thread) =>
    Effect.gen(function* () {
      const { path, folders, write, read, taskFolder } = thread;
      const edit = (contents: string) =>
        Effect.all([
          write(path.join(folders.shop, "a.txt"), contents),
          write(path.join(folders.api, "a.txt"), contents),
          write(path.join(folders.web, "a.txt"), contents),
        ]);
      yield* thread.turn(1, edit("1"));
      yield* thread.turn(2, edit("2"));
      // Repositories restore in the order the task folder lists them: the last one's fails.
      const last = taskFolder.repositories.at(-1)!.worktreePath;
      const lock = path.resolve(
        last,
        yield* thread.run(last, "rev-parse", "--git-path", "index.lock"),
      );
      yield* write(lock, "");

      const failed = yield* thread.rewind(1).pipe(Effect.flip);

      assert.equal(failed.reason, "unexpected-failure");
      assert.deepEqual(
        yield* Effect.all([
          read(path.join(folders.shop, "a.txt")),
          read(path.join(folders.api, "a.txt")),
          read(path.join(folders.web, "a.txt")),
        ]),
        ["2", "2", "2"],
      );
      const recorded = yield* thread.recorded;
      assert.deepEqual(recorded.runs, ["completed", "completed"]);
      assert.deepEqual(recorded.checkpoints.api, { 0: "ready", 1: "ready", 2: "ready" });
    }),
  ),
);

it.live.each([{ projectIsRepository: true }, { projectIsRepository: false }])(
  "restores a task folder storage cleanup removed before rewinding it, project is a repository=$projectIsRepository",
  (options) =>
    withThread(options, (thread) =>
      Effect.gen(function* () {
        const { path, folders, write, read, taskFolder, fileSystem } = thread;
        const taskFolders = yield* TaskFolders.TaskFolders;
        const edit = (contents: string) =>
          Effect.all([
            write(path.join(folders.api, "a.txt"), contents),
            write(path.join(folders.web, "a.txt"), contents),
          ]);
        yield* thread.turn(1, edit("1"));
        yield* thread.turn(2, edit("2"));
        const removal = yield* taskFolders.remove({
          root: taskFolder.root,
          force: true,
          forget: false,
        });
        assert.deepEqual(removal.kept, []);
        assert.isFalse(yield* fileSystem.exists(taskFolder.root));

        yield* thread.rewind(1);

        assert.deepEqual(
          yield* Effect.all([
            read(path.join(folders.shop, "AGENTS.md")),
            read(path.join(folders.api, "a.txt")),
            read(path.join(folders.web, "a.txt")),
          ]),
          ["rules\n", "1", "1"],
        );
        assert.equal(yield* thread.run(folders.web, "rev-parse", "--abbrev-ref", "HEAD"), branch);
      }),
    ),
);
