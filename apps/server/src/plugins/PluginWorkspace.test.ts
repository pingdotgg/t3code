import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2AppThread,
  PluginId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { makePluginActivation, makePluginApi } from "./PluginApi.ts";
import * as PluginMcpTools from "./PluginMcpTools.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";
import * as PluginWorkspace from "./PluginWorkspace.ts";

const layerWorkspace = WorkspaceFileSystem.layer.pipe(
  // Only writes ask which workspaces are known.
  Layer.provide(Layer.mock(KnownWorkspaces.KnownWorkspaces)({})),
  Layer.provideMerge(WorkspaceEntries.layer),
  Layer.provideMerge(WorkspacePaths.layer),
);

const layer = PluginWorkspace.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer)),
  Layer.provide(layerWorkspace),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-workspace-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const now = DateTime.makeUnsafe("2026-11-10T12:00:00Z");

const createProject = Effect.fn(function* (projectId: ProjectId, workspaceRoot: string) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const event = {
    sequence: 0,
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: DateTime.formatIso(now),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  } as const;
  yield* projects.apply({
    ...event,
    eventId: EventId.make(`event:${projectId}:created`),
    type: "project.created",
    payload: {
      projectId,
      title: projectId,
      workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      createdAt: DateTime.formatIso(now),
      updatedAt: DateTime.formatIso(now),
    },
  });
  return {
    delete: projects.apply({
      ...event,
      eventId: EventId.make(`event:${projectId}:deleted`),
      type: "project.deleted",
      payload: { projectId, deletedAt: DateTime.formatIso(now) },
    }),
  };
});

const createThread = Effect.fn(function* (
  threadId: ThreadId,
  projectId: ProjectId,
  worktreePath: string | null,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providerInstanceId = ProviderInstanceId.make("replay");
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId,
    title: "Plugin workspace",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "replay" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    branch: null,
    worktreePath,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* projections.apply({
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  });
  return {
    delete: projections.apply({
      id: EventId.make(`event:${threadId}:deleted`),
      type: "thread.deleted",
      threadId,
      occurredAt: now,
      payload: { ...thread, deletedAt: now },
    }),
  };
});

/** A folder of the given files, as `{ relative path: contents }`. */
const makeFolder = Effect.fn(function* (files: Readonly<Record<string, string>>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-workspace-" });
  for (const [relativePath, contents] of Object.entries(files)) {
    yield* fs.makeDirectory(path.dirname(path.join(root, relativePath)), { recursive: true });
    yield* fs.writeFileString(path.join(root, relativePath), contents);
  }
  return root;
});

const sortedPaths = (result: { readonly entries: ReadonlyArray<{ readonly path: string }> }) =>
  result.entries.map((entry) => entry.path).toSorted();

it.layer(layer, { excludeTestServices: true })("PluginWorkspace", (it) => {
  it.effect("reads the thread's worktree, or its project's folder when it has none", () =>
    Effect.gen(function* () {
      const workspace = yield* PluginWorkspace.PluginWorkspace;
      const projectRoot = yield* makeFolder({
        "notes.txt": "from the project",
        "src/a.ts": "export {};",
        "~/home.txt": "a folder named ~",
      });
      const worktree = yield* makeFolder({ "notes.txt": "from the worktree" });
      const projectId = ProjectId.make("project:plugin-workspace-read");
      yield* createProject(projectId, projectRoot);
      const inProject = ThreadId.make("thread:plugin-workspace-project");
      const inWorktree = ThreadId.make("thread:plugin-workspace-worktree");
      yield* createThread(inProject, projectId, null);
      yield* createThread(inWorktree, projectId, worktree);

      const read = (threadId: ThreadId, relativePath: string) =>
        workspace.readFile({ threadId, relativePath }).pipe(Effect.map(({ contents }) => contents));
      assert.strictEqual(yield* read(inProject, "notes.txt"), "from the project");
      assert.strictEqual(yield* read(inWorktree, "notes.txt"), "from the worktree");
      assert.strictEqual(yield* read(inProject, "./src/../~/home.txt"), "a folder named ~");

      assert.deepStrictEqual(sortedPaths(yield* workspace.listEntries({ threadId: inProject })), [
        "notes.txt",
        "src",
        "~",
      ]);
      assert.deepStrictEqual(
        sortedPaths(yield* workspace.listEntries({ threadId: inProject, directoryPath: "src" })),
        ["src/a.ts"],
      );
      assert.deepStrictEqual(sortedPaths(yield* workspace.listEntries({ threadId: inWorktree })), [
        "notes.txt",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a missing or deleted thread or project, though the worktree remains", () =>
    Effect.gen(function* () {
      const workspace = yield* PluginWorkspace.PluginWorkspace;
      const root = yield* makeFolder({ "notes.txt": "still here" });
      const deletedProjectId = ProjectId.make("project:plugin-workspace-deleted");
      const deletedProject = yield* createProject(deletedProjectId, root);
      yield* deletedProject.delete;
      const liveProjectId = ProjectId.make("project:plugin-workspace-live");
      yield* createProject(liveProjectId, root);

      const deletedThread = ThreadId.make("thread:plugin-workspace-deleted");
      yield* Effect.flatMap(createThread(deletedThread, liveProjectId, root), (t) => t.delete);
      const ofDeletedProject = ThreadId.make("thread:plugin-workspace-of-deleted");
      yield* createThread(ofDeletedProject, deletedProjectId, root);
      const ofMissingProject = ThreadId.make("thread:plugin-workspace-of-missing");
      yield* createThread(ofMissingProject, ProjectId.make("project:never-created"), root);

      const failures = yield* Effect.forEach(
        [ThreadId.make("thread:never-created"), deletedThread, ofDeletedProject, ofMissingProject],
        (threadId) =>
          Effect.all([
            workspace.readFile({ threadId, relativePath: "notes.txt" }).pipe(Effect.flip),
            workspace.listEntries({ threadId }).pipe(Effect.flip),
          ]).pipe(Effect.map((errors) => errors.map((error) => error._tag))),
      );
      assert.deepStrictEqual(failures, [
        ["PluginWorkspaceThreadNotFoundError", "PluginWorkspaceThreadNotFoundError"],
        ["PluginWorkspaceThreadNotFoundError", "PluginWorkspaceThreadNotFoundError"],
        ["PluginWorkspaceProjectNotFoundError", "PluginWorkspaceProjectNotFoundError"],
        ["PluginWorkspaceProjectNotFoundError", "PluginWorkspaceProjectNotFoundError"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "keeps reads and listings inside the folder, through .., absolute paths and symlinks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* PluginWorkspace.PluginWorkspace;
        const outside = yield* makeFolder({ "secret.txt": "outside" });
        const root = yield* makeFolder({ "inside.txt": "inside" });
        yield* fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
        yield* fs.symlink(outside, path.join(root, "linked-folder"));
        const projectId = ProjectId.make("project:plugin-workspace-escape");
        yield* createProject(projectId, root);
        const threadId = ThreadId.make("thread:plugin-workspace-escape");
        yield* createThread(threadId, projectId, null);

        const readFailures = yield* Effect.forEach(
          [
            path.join(outside, "secret.txt"),
            "../secret.txt",
            `../${path.basename(outside)}/secret.txt`,
            "link.txt",
            "linked-folder/secret.txt",
          ],
          (relativePath) =>
            workspace.readFile({ threadId, relativePath }).pipe(
              Effect.flip,
              Effect.map((error) => error._tag),
            ),
        );
        assert.deepStrictEqual(readFailures, [
          "WorkspacePathOutsideRootError",
          "WorkspacePathOutsideRootError",
          "WorkspacePathOutsideRootError",
          "WorkspaceFilePathEscapeError",
          "WorkspaceFilePathEscapeError",
        ]);

        const listFailures = yield* Effect.forEach(
          [outside, "..", "linked-folder"],
          (directoryPath) =>
            workspace.listEntries({ threadId, directoryPath }).pipe(
              Effect.flip,
              Effect.map((error) => error._tag),
            ),
        );
        assert.deepStrictEqual(listFailures, [
          "WorkspaceEntriesReadDirectoryError",
          "WorkspaceEntriesReadDirectoryError",
          "WorkspaceEntriesReadDirectoryError",
        ]);
        // Links that leave the folder are left out of its listing.
        assert.deepStrictEqual(sortedPaths(yield* workspace.listEntries({ threadId })), [
          "inside.txt",
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("serves a plugin plain promises, refusing input that isn't a thread and path", () =>
    Effect.gen(function* () {
      const root = yield* makeFolder({ "notes.txt": "for the plugin" });
      const projectId = ProjectId.make("project:plugin-workspace-facade");
      yield* createProject(projectId, root);
      const threadId = ThreadId.make("thread:plugin-workspace-facade");
      yield* createThread(threadId, projectId, null);
      const services = yield* Effect.all({
        settings: PluginSettingsStore.PluginSettingsStore,
        storage: PluginStorage.PluginStorage,
        mcpTools: PluginMcpTools.PluginMcpTools,
        workspace: PluginWorkspace.PluginWorkspace,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(PluginSettingsStore.PluginSettingsStore)({}),
            Layer.mock(PluginStorage.PluginStorage)({}),
            Layer.mock(PluginMcpTools.PluginMcpTools)({ isOffered: () => false }),
          ),
        ),
      );
      const api = makePluginApi({
        id: PluginId.make("workspace-reader"),
        rootDir: root,
        settingsSchema: undefined,
        activation: makePluginActivation(),
        context: yield* Effect.context<never>(),
        services,
      });
      const settle = <A>(promise: Promise<A>) =>
        Effect.promise(() =>
          promise.then(
            (value) => ({ value }),
            (error: Error & { readonly code?: string }) => ({
              rejected: error.code ?? error.name,
            }),
          ),
        );

      assert.strictEqual(api.version, 2);
      assert.deepStrictEqual(
        yield* settle(api.workspace.readFile({ threadId, relativePath: "notes.txt" })),
        {
          value: {
            relativePath: "notes.txt",
            contents: "for the plugin",
            byteLength: 14,
            truncated: false,
          },
        },
      );
      assert.deepStrictEqual(yield* settle(api.workspace.listEntries({ threadId })), {
        value: { entries: [{ path: "notes.txt", kind: "file" }] },
      });
      // Plugins are untyped JavaScript.
      const untyped = api.workspace as unknown as Record<
        "readFile" | "listEntries",
        (input: unknown) => Promise<unknown>
      >;
      for (const input of [
        { relativePath: "notes.txt" },
        { threadId, relativePath: "" },
        { threadId, relativePath: 1 },
        null,
      ]) {
        assert.deepStrictEqual(yield* settle(untyped.readFile(input)), { rejected: "TypeError" });
      }
      assert.deepStrictEqual(yield* settle(untyped.listEntries({ threadId, directoryPath: 3 })), {
        rejected: "TypeError",
      });
      assert.deepStrictEqual(
        yield* settle(
          api.workspace.readFile({ threadId: "thread:missing", relativePath: "notes.txt" }),
        ),
        { rejected: "PluginWorkspaceThreadNotFoundError" },
      );
    }).pipe(Effect.scoped),
  );
});
