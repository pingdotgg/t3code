import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ServerSettingsError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectLock from "./ProjectLock.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import {
  claudeDriver,
  codexDriver,
  codexSession,
  createdAt,
  member,
  moved,
  namedThread,
  needsProject,
  providerThread,
  refusal,
  runCreated,
  threadCreated,
} from "./ThreadMove.testkit.ts";
import { moveReceiptTurnItem } from "./ThreadMoveReceipt.ts";
import * as ThreadMoveService from "./ThreadMoveService.ts";

const codexId = ProviderInstanceId.make("codex");
const SCRATCH_ID = ProjectId.make("scratch");

class Probe extends Context.Service<
  Probe,
  Ref.Ref<(threadId: ThreadId) => Effect.Effect<boolean>>
>()("t3/project/ThreadMoveService.test/Probe") {}

const codexInstance = {
  instanceId: codexId,
  driverKind: codexDriver,
  snapshot: { getSnapshot: Effect.succeed({ version: null }) },
  orchestrationAdapter: { getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2) },
} as unknown as ProviderInstance;

const layerThreads = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const probe = yield* Probe;
    return Layer.mock(ThreadManagementService.ThreadManagementService)({
      getShellSnapshot: (options) => projections.getShellSnapshot(options).pipe(Effect.orDie),
      getThreadRecords: (threadId, fields, filter) =>
        projections.getThreadRecords(threadId, fields, filter).pipe(Effect.orDie),
      threadHasBackgroundWork: (threadId) =>
        Ref.get(probe).pipe(Effect.flatMap((hasWork) => hasWork(threadId))),
    });
  }),
);
const layerFolders = Layer.unwrap(
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scratchRoot = path.join(config.baseDir, "scratch");
    yield* fileSystem.makeDirectory(scratchRoot, { recursive: true });
    return Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: path.join(config.baseDir, "projects"),
      scratchRoot: Effect.succeedSome(scratchRoot),
      ensureScratchProject: projects
        .bootstrap({
          commandId: CommandId.make("scratch:create"),
          projectId: SCRATCH_ID,
          title: "No project",
          workspaceRoot: scratchRoot,
        })
        .pipe(Effect.as({ projectId: SCRATCH_ID }), Effect.orDie),
      folderForThread: ({ threadId }) => {
        const folder = path.join(scratchRoot, `2026-01-01-${threadId.replace(/[^a-z0-9]/gi, "")}`);
        return fileSystem.makeDirectory(folder).pipe(Effect.as(Option.some(folder)), Effect.orDie);
      },
    });
  }),
);
const layerProviders = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
  getInstance: (instanceId) => Effect.succeed(instanceId === codexId ? codexInstance : undefined),
});
const layerTest = Layer.effect(ThreadMoveService.ThreadMoveService, ThreadMoveService.make).pipe(
  Layer.provideMerge(Layer.mergeAll(layerThreads, layerFolders, layerProviders)),
  Layer.provideMerge(Layer.effect(ProjectService.ProjectService, ProjectService.make)),
  Layer.provideMerge(
    Layer.mergeAll(
      LegacyV1ThreadImporter.layer.pipe(
        Layer.provideMerge(EventSink.layer),
        Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
      ),
      EffectOutbox.layer,
      ProjectStore.layer,
      IdAllocator.layer,
      ThreadCommandExecutor.layer,
      ProjectLock.layer,
      Layer.effect(
        Probe,
        Ref.make<(threadId: ThreadId) => Effect.Effect<boolean>>(() => Effect.succeed(false)),
      ),
      Layer.succeed(WorkspacePaths.WorkspacePaths, {
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
        resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
          Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
      }),
    ),
  ),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "thread-move-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const setup = Effect.fn("ThreadMoveServiceTest.setup")(function* (name: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const service = yield* ThreadMoveService.ThreadMoveService;
  const probe = yield* Probe;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: `t3-move-${name}-` }),
  );
  const at = (...segments: ReadonlyArray<string>) => path.join(root, ...segments);
  for (const folder of ["a", "b", "w", "plain"]) yield* fileSystem.makeDirectory(at(folder));
  const project = (id: string, folder: string) =>
    projects.create({
      commandId: CommandId.make(`${name}:project:${id}`),
      projectId: ProjectId.make(`${name}:${id}`),
      title: id,
      workspaceRoot: at(folder),
    });
  const remove = (id: string, projectId: ProjectId, force = false) =>
    projects.delete({ commandId: CommandId.make(`${name}:${id}`), projectId, force });
  const a = yield* project("A", "a");
  const b = yield* project("B", "b");
  const thread = (
    id: string,
    projectId: ProjectId,
    worktreePath: string | null,
    extra?: Omit<Parameters<typeof threadCreated>[0], "threadId" | "projectId" | "worktreePath">,
  ) => {
    const threadId = ThreadId.make(`${name}:${id}`);
    return sink
      .write({ events: [threadCreated({ threadId, projectId, worktreePath, ...extra })] })
      .pipe(Effect.as(threadId));
  };
  const shell = (threadId: ThreadId) =>
    projections.getThreadProjection(threadId).pipe(Effect.map(({ thread }) => thread));
  return { at, a, b, thread, project, remove, shell, service, projects, projections, sink, probe };
});

const outboxOf = (threadId: ThreadId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{
        readonly effect_type: string;
      }>`SELECT effect_type FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId} ORDER BY effect_id ASC`,
      (rows) => rows.map((row) => row.effect_type),
    ),
  );
const hookLock = <Key>(
  locks: KeyedLock.KeyedLock<Key>,
  before: (key: Key) => Effect.Effect<unknown, Error>,
): KeyedLock.KeyedLock<Key> => ({
  ...locks,
  withLock: (key, effect) => Effect.andThen(Effect.orDie(before(key)), locks.withLock(key, effect)),
});
const hookedService = Effect.fn("ThreadMoveServiceTest.hookedService")(function* (
  before: (key: ProjectId) => Effect.Effect<unknown, Error>,
) {
  const locks = yield* ProjectLock.ProjectLock;
  return yield* ThreadMoveService.make.pipe(
    Effect.provideService(ProjectLock.ProjectLock, hookLock(locks, before)),
  );
});

it.layer(layerTest)("ThreadMoveService", (it) => {
  it.effect("a refused move or a failed environment read commits nothing", () =>
    Effect.gen(function* () {
      const { at, a, thread, shell, service, probe } = yield* setup("refused");
      const threadId = yield* thread("t", a.id, null);
      yield* Ref.set(probe, (candidate) => Effect.succeed(candidate === threadId));
      const result = yield* service.move({ threadId, destination: at("b") });
      expect(result).toMatchObject(member(threadId, "background work"));
      assert.equal((yield* shell(threadId)).projectId, a.id);
      assert.deepEqual(yield* outboxOf(threadId), []);
      yield* Ref.set(probe, () => Effect.succeed(false));

      // The decision reads the settings once itself; the environment resolver's read comes second.
      const settings = yield* ServerSettings.ServerSettingsService;
      let reads = 0;
      const unresolved = yield* ThreadMoveService.make.pipe(
        Effect.provideService(ServerSettings.ServerSettingsService, {
          ...settings,
          getSettings: Effect.suspend(() =>
            ++reads === 2
              ? new ServerSettingsError({
                  settingsPath: at("settings.json"),
                  operation: "read-file",
                })
              : settings.getSettings,
          ),
        }),
      );
      const failure = yield* unresolved.move({ threadId, destination: at("b") }).pipe(Effect.flip);
      assert.equal(failure.message, "Could not resolve the provider's environment.");
      assert.equal((yield* shell(threadId)).projectId, a.id);
      assert.deepEqual(yield* outboxOf(threadId), []);
    }),
  );

  it.effect("only the call that carries every flag changes state", () =>
    Effect.gen(function* () {
      const { at, a, thread, shell, service, projects, projections, sink } = yield* setup("flags");
      const threadId = yield* thread("t", a.id, at("w"), { branch: "feature" });
      const runId = RunId.make("flags:run");
      const earlier = moveReceiptTurnItem({
        id: TurnItemId.make("flags:earlier"),
        threadId,
        ordinal: 1,
        movedAt: createdAt,
        previousFolder: at("w"),
        message: "earlier",
      });
      yield* sink.write({
        events: [
          runCreated({ id: runId, threadId, ordinal: 1, providerInstanceId: codexId }),
          {
            id: EventId.make("flags:earlier"),
            type: "turn-item.updated" as const,
            threadId,
            occurredAt: createdAt,
            payload: { ...earlier, runId },
          },
        ],
      });
      const sideId = yield* thread("side", a.id, at("w"), { parent: threadId, kind: "side" });
      const forkId = yield* thread("fork", a.id, at("w"), { parent: threadId, kind: "fork" });
      const added = () =>
        Effect.map(projects.getByWorkspaceRoot(at("plain")), Option.getOrUndefined);
      const move = (flags?: { addProject?: boolean; confirm?: boolean }) =>
        service.move({ threadId, destination: at("plain"), ...flags });

      expect(yield* move()).toMatchObject(needsProject(at("plain")));
      assert.isUndefined(yield* added());

      expect(yield* move({ addProject: true })).toMatchObject({
        _tag: "confirm",
        from: at("w"),
        to: at("plain"),
        wayBack: "add-project",
        staysOnDisk: expect.stringContaining("stays on disk"),
        otherThreads: [namedThread(forkId)],
      });
      assert.isUndefined(yield* added());
      assert.equal((yield* shell(threadId)).projectId, a.id);

      expect(yield* move({ addProject: true, confirm: true })).toMatchObject(
        moved(at("plain"), [threadId, sideId]),
      );
      const project = yield* added();
      assert.equal(project?.title, "plain");
      for (const id of [threadId, sideId]) {
        expect(yield* shell(id)).toMatchObject({
          projectId: project?.id,
          worktreePath: null,
          branch: null,
        });
      }
      assert.equal((yield* shell(forkId)).projectId, a.id);
      const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"]);
      const receipt = turnItems.find((item) => item.id !== earlier.id);
      // A reload reads this order: the receipt comes after the run's item.
      const reloaded = yield* projections.getThreadProjection(threadId);
      assert.deepEqual(
        reloaded.visibleTurnItems.map((row) => row.item.id),
        [earlier.id, receipt?.id],
      );
      const message = receipt?.type === "system_notice" ? receipt.message : "";
      assert.equal(receipt?.type === "system_notice" ? receipt.previousFolder : null, at("w"));
      assert.include(message, `The next turn runs in \`${at("plain")}\`.`);
      assert.include(message, `"${forkId}"`);
      assert.deepEqual(yield* outboxOf(threadId), ["scheduled-tasks.move"]);
    }),
  );

  type Recheck = Effect.Success<ReturnType<typeof setup>> & {
    readonly key: ProjectId;
    readonly threadId: ThreadId;
  };
  type Hook = (scenario: Recheck) => Effect.Effect<unknown, Error>;
  it.effect.each<readonly [string, Hook, (threadId: ThreadId) => object]>([
    [
      "the re-check refuses a member",
      ({ probe }) => Ref.set(probe, () => Effect.succeed(true)),
      (threadId) =>
        member(
          threadId,
          `This thread still has background work running. The project "plain" was added and stays.`,
        ),
    ],
    [
      "the thread enters a worktree meanwhile",
      ({ sink, threadId, a, at }) =>
        sink.write({
          events: [
            {
              ...threadCreated({ threadId, projectId: a.id, worktreePath: at("w") }),
              id: EventId.make("recheck:enters-worktree"),
              type: "thread.metadata-updated" as const,
            },
          ],
        }),
      () => refusal(`The thread changed. Try again. The project "plain" was added and stays.`),
    ],
    [
      "a subagent child is created during the probes",
      ({ probe, thread, threadId, a }) =>
        Ref.set(probe, () =>
          Ref.set(probe, () => Effect.succeed(false)).pipe(
            Effect.andThen(thread("sub", a.id, null, { parent: threadId, kind: "subagent" })),
            Effect.orDie,
            Effect.as(false),
          ),
        ),
      () =>
        refusal(
          `The thread or its destination changed. Try again. The project "plain" was added and stays.`,
        ),
    ],
    [
      "the added project is deleted before the lock",
      ({ remove, key }) => remove(`del:${key}`, key, true),
      () => refusal(`The destination project no longer exists. The project "plain" was added.`),
    ],
  ])("keeps and names the project it added when %s", ([name, hook, expected]) =>
    Effect.gen(function* () {
      const scenario = yield* setup(name.replace(/\W+/g, "-"));
      const { at, a, shell, projects, probe } = scenario;
      const threadId = yield* scenario.thread("t", a.id, null);
      const service = yield* hookedService((key) => hook({ ...scenario, key, threadId }));
      const result = yield* service.move({ threadId, destination: at("plain"), addProject: true });
      const added = Option.getOrThrow(
        yield* projects.getByWorkspaceRoot(at("plain"), { includeDeleted: true }),
      );
      expect(result).toMatchObject({
        ...expected(threadId),
        projects: [{ projectId: added.id, title: "plain" }],
      });
      assert.equal((yield* shell(threadId)).projectId, a.id);
      yield* Ref.set(probe, () => Effect.succeed(false));
    }),
  );

  it.effect("a move waiting on a deletion is refused; a forced deletion takes a moved thread", () =>
    Effect.gen(function* () {
      const { at, a, b, thread, project, remove, shell, projects, projections } =
        yield* setup("deletion");
      const threadId = yield* thread("t", a.id, null);
      const deleteReadThreads = yield* Deferred.make<void>();
      const releaseDelete = yield* Deferred.make<void>();
      const gatedProjects = yield* ProjectService.make.pipe(
        Effect.provideService(ProjectionStore.ProjectionStoreV2, {
          ...projections,
          getShellSnapshot: (options) =>
            options?.projectId === b.id
              ? projections.getShellSnapshot(options).pipe(
                  Effect.tap(() => Deferred.succeed(deleteReadThreads, undefined)),
                  Effect.tap(() => Deferred.await(releaseDelete)),
                )
              : projections.getShellSnapshot(options),
        }),
      );
      const deletion = yield* gatedProjects
        .delete({ commandId: CommandId.make("deletion:delete-b"), projectId: b.id, force: true })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(deleteReadThreads);
      const moveAtLock = yield* Deferred.make<void>();
      const service = yield* hookedService(() => Deferred.succeed(moveAtLock, undefined));
      const releaser = yield* Deferred.await(moveAtLock).pipe(
        Effect.andThen(Deferred.succeed(releaseDelete, undefined)),
        Effect.forkChild({ startImmediately: true }),
      );
      const moving = yield* service
        .move({ threadId, destination: at("b") })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.join(releaser);
      yield* Fiber.join(deletion);
      assert.deepEqual(yield* Fiber.join(moving), {
        _tag: "refused",
        reason: "The destination project no longer exists.",
      });
      assert.equal((yield* shell(threadId)).projectId, a.id);
      assert.isTrue(Option.isNone(yield* projects.getById(b.id)));

      const c = yield* project("C", "plain");
      assert.equal((yield* service.move({ threadId, destination: at("plain") }))._tag, "moved");
      assert.equal((yield* Effect.flip(remove("delete-c", c.id)))._tag, "ProjectNotEmptyError");
      yield* remove("force-c", c.id, true);
      assert.isNotNull((yield* shell(threadId)).deletedAt);
    }),
  );

  it.effect("deletion holds the project lock from its thread read through its commit", () =>
    Effect.gen(function* () {
      const { b, thread } = yield* setup("lock");
      const projectLocks = yield* ProjectLock.ProjectLock;
      const deletionAtLock = yield* Deferred.make<void>();
      const projects = yield* ProjectService.make.pipe(
        Effect.provideService(
          ProjectLock.ProjectLock,
          hookLock(projectLocks, () => Deferred.succeed(deletionAtLock, undefined)),
        ),
      );
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* projectLocks
        .withLock(
          b.id,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(held);
      const deletion = yield* projects
        .delete({ commandId: CommandId.make("lock:delete-b"), projectId: b.id })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(deletionAtLock);
      yield* thread("late", b.id, null);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      assert.equal((yield* Fiber.join(deletion).pipe(Effect.flip))._tag, "ProjectNotEmptyError");
      assert.isTrue(Option.isSome(yield* projects.getById(b.id)));
    }),
  );

  it.effect("/no claims one folder and removes it only while empty when the commit fails", () =>
    Effect.gen(function* () {
      const { a, thread, shell, service, sink } = yield* setup("scratch");
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const scratchRoot = Option.getOrThrow(yield* managedFolders.scratchRoot);
      const claimedFor = (id: string) =>
        fileSystem
          .readDirectory(scratchRoot)
          .pipe(Effect.map((entries) => entries.filter((entry) => entry.includes(id))));
      const threadId = yield* thread("t", a.id, null);

      const result = yield* service.move({ threadId, destination: null });
      const { projectId, worktreePath } = yield* shell(threadId);
      expect(result).toMatchObject(moved(worktreePath ?? "", [threadId]));
      assert.equal(projectId, SCRATCH_ID);
      assert.equal(path.dirname(worktreePath ?? ""), scratchRoot);
      assert.lengthOf(yield* claimedFor("t"), 1);
      assert.equal((yield* service.move({ threadId, destination: null }))._tag, "refused");

      const failingSink = (fill: string | null) =>
        EventSink.EventSinkV2.of({
          ...sink,
          commitCommand: ({ commandId, events }) => {
            const moved = events.find((event) => event.type === "thread.metadata-updated");
            const folder =
              moved?.type === "thread.metadata-updated" ? moved.payload.worktreePath : null;
            const error = new EventSink.EventSinkWriteError({
              commandId,
              eventCount: events.length,
              cause: new Error("Injected commit failure"),
            });
            const fillFolder =
              folder === null || fill === null
                ? Effect.void
                : Effect.orDie(fileSystem.writeFileString(path.join(folder, fill), "keep"));
            return Effect.andThen(fillFolder, error);
          },
        });
      for (const [id, fill] of [
        ["empty", null],
        ["full", "notes.md"],
      ] as const) {
        const memberId = yield* thread(id, a.id, null);
        const failing = yield* ThreadMoveService.make.pipe(
          Effect.provideService(EventSink.EventSinkV2, failingSink(fill)),
        );
        const failure = yield* Effect.flip(failing.move({ threadId: memberId, destination: null }));
        assert.equal(failure.message, "Could not commit the move.");
        assert.equal((yield* shell(memberId)).projectId, a.id);
        const kept = yield* claimedFor(id);
        assert.lengthOf(kept, fill === null ? 0 : 1);
        if (fill !== null) {
          assert.isTrue(yield* fileSystem.exists(path.join(scratchRoot, kept[0]!, fill)));
        }
      }
    }),
  );

  it.effect("takes the project lock, then each member's lock from the parent down", () =>
    Effect.gen(function* () {
      const { at, a, b, thread, shell } = yield* setup("order");
      const threadLocks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const projectLocks = yield* ProjectLock.ProjectLock;
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (key: string) => Ref.update(order, (keys) => [...keys, key]);
      const threadId = yield* thread("t", a.id, null);
      const sideId = yield* thread("side", a.id, null, { parent: threadId, kind: "side" });
      const subId = yield* thread("sub", a.id, null, { parent: sideId, kind: "subagent" });
      const forkId = yield* thread("fork", a.id, null, { parent: threadId, kind: "fork" });
      const lateSide = thread("late", a.id, null, { parent: threadId, kind: "side" });
      const lateId = ThreadId.make("order:late");
      const service = yield* ThreadMoveService.make.pipe(
        Effect.provideService(
          ThreadCommandExecutor.ThreadCommandExecutor,
          hookLock(threadLocks, record),
        ),
        Effect.provideService(
          ProjectLock.ProjectLock,
          hookLock(projectLocks, (key) => record(`project:${key}`).pipe(Effect.andThen(lateSide))),
        ),
      );

      const result = yield* service.move({ threadId, destination: at("b") });

      assert.equal(result._tag, "moved");
      assert.deepEqual(yield* Ref.get(order), [`project:${b.id}`, threadId, lateId, sideId, subId]);
      for (const id of [threadId, sideId, subId, lateId]) {
        assert.equal((yield* shell(id)).projectId, b.id);
      }
      assert.equal((yield* shell(forkId)).projectId, a.id);
    }),
  );

  it.effect("queues each member's task move behind that member's detach", () =>
    Effect.gen(function* () {
      const { at, a, b, thread, service, sink } = yield* setup("queue");
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = yield* thread("t", a.id, null);
      const sideId = yield* thread("side", a.id, null, { parent: threadId, kind: "side" });
      yield* sink.write({
        events: [
          {
            id: EventId.make("queue:attached"),
            type: "provider-session.attached",
            threadId: sideId,
            driver: codexDriver,
            providerInstanceId: codexId,
            occurredAt: createdAt,
            payload: codexSession({ id: "queue:session", status: "ready", cwd: at("a") }),
          },
        ],
      });
      const taskMove = (id: ThreadId) => ({
        type: "scheduled-tasks.move" as const,
        threadIds: [id],
        projectId: b.id,
      });

      yield* (yield* SqlClient.SqlClient)`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'`;
      assert.equal((yield* service.move({ threadId, destination: at("b") }))._tag, "moved");
      const claim = outbox.claimNext({ workerId: "queue" }).pipe(Effect.map(Option.getOrUndefined));
      const detach = yield* claim;
      expect([detach?.threadId, detach?.request.type]).toEqual([sideId, "provider-session.detach"]);
      assert.deepEqual((yield* claim)?.request, taskMove(threadId));
      assert.isUndefined(yield* claim);
      yield* outbox.succeed({ effectId: detach!.id, workerId: "queue" });
      assert.deepEqual((yield* claim)?.request, taskMove(sideId));
    }),
  );

  it.effect("relocates each Claude row from where its session is stored, one move at a time", () =>
    Effect.gen(function* () {
      const { at, a, b, thread, shell, service, sink } = yield* setup("storage");
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* thread("t", a.id, null);
      const providerInstanceId = ProviderInstanceId.make("claudeAgent");
      const base = { threadId, providerInstanceId, occurredAt: createdAt };
      const providerThreadId = (name: string) => ProviderThreadId.make(`storage:${name}`);
      const row = (name: string, nativeId: string, nativeStorageFolder?: string) => ({
        ...base,
        id: EventId.make(`storage:row:${name}:${nativeStorageFolder ?? "unknown"}`),
        type: "provider-thread.updated" as const,
        driver: claudeDriver,
        payload: providerThread({
          id: `storage:${name}`,
          threadId,
          providerInstanceId,
          nativeId,
          nativeStorageFolder,
        }),
      });
      const run = (ordinal: number, name: string, cwd?: string) =>
        runCreated({
          id: RunId.make(`storage:run:${ordinal}`),
          threadId,
          ordinal,
          providerInstanceId,
          providerThreadId: providerThreadId(name),
          cwd,
        });
      const attempt = (ordinal: number, name: string, nativeThreadId?: string) => ({
        ...base,
        id: EventId.make(`storage:attempt:${ordinal}`),
        type: "run-attempt.created" as const,
        payload: {
          id: RunAttemptId.make(`storage:attempt:${ordinal}`),
          ...(nativeThreadId === undefined ? {} : { nativeThreadId }),
          runId: RunId.make(`storage:run:${ordinal}`),
          attemptOrdinal: 1,
          rootNodeId: NodeId.make(`storage:node:${ordinal}`),
          providerInstanceId,
          providerThreadId: providerThreadId(name),
          providerTurnId: null,
          reason: "initial" as const,
          status: "completed" as const,
          startedAt: createdAt,
          completedAt: createdAt,
        },
      });
      // "resumed" holds a session first run on another row; "legacy" predates run.cwd.
      yield* sink.write({
        events: [
          row("resumed", "session-resumed"),
          row("legacy", "session-legacy"),
          run(1, "old-instance", "/old/storage"),
          attempt(1, "old-instance", "session-resumed"),
          run(2, "legacy"),
          attempt(2, "legacy"),
          {
            ...base,
            id: EventId.make("storage:scope"),
            type: "checkpoint-scope.created",
            payload: {
              id: CheckpointScopeId.make("storage:scope"),
              threadId,
              runId: RunId.make("storage:run:2"),
              nodeId: NodeId.make("storage:node:2"),
              parentScopeId: null,
              providerThreadId: providerThreadId("legacy"),
              kind: "root_run",
              ordinalWithinParent: 0,
              advancesAppRunCount: true,
              cwd: "/legacy/storage",
              createdAt,
            },
          },
        ],
      });
      const pendingRelocations = sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}
            AND status = 'pending' AND effect_type = 'provider-session.relocate-storage'
          ORDER BY effect_id ASC
        `.pipe(
        Effect.map((rows) => rows.map(({ payload_json }) => JSON.parse(payload_json))),
        Effect.map((all) => all.map((r) => [r.providerThreadId, r.oldFolder, r.newFolder])),
      );

      assert.equal((yield* service.move({ threadId, destination: at("b") }))._tag, "moved");
      assert.deepEqual(yield* pendingRelocations, [
        ["storage:legacy", "/legacy/storage", at("b")],
        ["storage:resumed", "/old/storage", at("b")],
      ]);

      assert.deepEqual(yield* service.move({ threadId, destination: at("a") }), {
        _tag: "refused",
        reason: "The last move is still relocating a Claude session. Try again in a moment.",
      });
      assert.equal((yield* shell(threadId)).projectId, b.id);
      assert.lengthOf(yield* pendingRelocations, 2);

      // What the relocation handler leaves behind when it succeeds.
      yield* sink.write({
        events: [
          row("resumed", "session-resumed", at("b")),
          row("legacy", "session-legacy", at("b")),
        ],
      });
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded' WHERE thread_id = ${threadId}`;
      assert.equal((yield* service.move({ threadId, destination: at("a") }))._tag, "moved");
      assert.deepEqual(yield* pendingRelocations, [
        ["storage:legacy", at("b"), at("a")],
        ["storage:resumed", at("b"), at("a")],
      ]);
    }),
  );
});
