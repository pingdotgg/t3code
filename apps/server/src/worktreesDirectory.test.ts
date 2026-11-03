import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TaskFolders from "./workspace/TaskFolders.ts";
import { makeIsManagedWorktreePath } from "./worktreesDirectory.ts";

it.effect("accepts recorded task folder rows below a managed folder, and nothing else", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const store = yield* TaskFolders.TaskFolderStore;
    const isManaged = yield* makeIsManagedWorktreePath;
    const root = `${config.worktreesDir}/web/task`;
    assert.isTrue(yield* isManaged(root));
    assert.isFalse(yield* isManaged(`${root}/web`));

    yield* store.upsert({
      root,
      projectId: ProjectId.make("project:managed"),
      homeWorktreePath: `${root}/web`,
      repositories: [
        {
          kind: "home",
          name: "web",
          originalPath: "/code/web",
          worktreePath: `${root}/web`,
          relativePath: "",
          baseRef: "main",
          branch: "task",
        },
      ],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    assert.isTrue(yield* isManaged(`${root}/web`));
    assert.isFalse(yield* isManaged(`${root}/other`));
  }).pipe(
    Effect.provide(
      TaskFolders.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(ServerSettings.layerTest()),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
