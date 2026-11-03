import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EventId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as TaskFolders from "./TaskFolders.ts";

const NOW = "2026-10-27T00:00:00.000Z";

const layerTest = KnownWorkspaces.layer.pipe(
  Layer.provide(
    Layer.mock(GitVcsDriver.GitVcsDriver)({ listWorktreePaths: () => Effect.succeed([]) }),
  ),
  Layer.provideMerge(Layer.mergeAll(ProjectStore.layer, TaskFolders.layer)),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-known-workspaces-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layerTest, { excludeTestServices: true })("KnownWorkspaces", (it) => {
  it.effect("accepts paths in tracked folders and task folders, nothing beside them", () =>
    Effect.gen(function* () {
      const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-known-workspaces-" }),
      );
      const at = (...segments: ReadonlyArray<string>) => path.join(base, ...segments);
      for (const folder of ["home", "app/src", "tasks/fix-login/home", "elsewhere"]) {
        yield* fileSystem.makeDirectory(at(folder), { recursive: true });
      }
      const projectId = ProjectId.make("project:known-workspaces");
      yield* (yield* ProjectStore.ProjectStoreV2).apply({
        sequence: 1,
        eventId: EventId.make("event:known-workspaces"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: NOW,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "home",
          workspaceRoot: at("home"),
          defaultModelSelection: null,
          scripts: [],
          trackedFolders: [{ path: at("app"), name: "app" }],
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
      assert.isFalse(yield* knownWorkspaces.contains(at("tasks", "fix-login", "home")));
      yield* (yield* TaskFolders.TaskFolderStore).upsert({
        root: at("tasks", "fix-login"),
        projectId,
        homeWorktreePath: at("tasks", "fix-login", "home"),
        repositories: [],
        createdAt: NOW,
        updatedAt: NOW,
      });

      assert.isTrue(yield* knownWorkspaces.contains(at("home")));
      assert.isTrue(yield* knownWorkspaces.contains(at("app", "src")));
      assert.isTrue(yield* knownWorkspaces.contains(at("tasks", "fix-login", "home")));
      assert.isFalse(yield* knownWorkspaces.contains(at("elsewhere")));
      assert.isFalse(yield* knownWorkspaces.contains(base));
    }),
  );
});
