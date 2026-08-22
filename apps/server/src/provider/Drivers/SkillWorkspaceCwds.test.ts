import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveSkillWorkspaceCwds } from "./SkillWorkspaceCwds.ts";

const testLayer = Layer.mergeAll(
  ServerConfig.layerTest("/tmp/server-cwd", { prefix: "t3-skill-cwds-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  Layer.succeed(ProjectionSnapshotQuery, {
    getActiveWorkspaceCwds: () =>
      Effect.succeed(["/tmp/project-a", "/tmp/project-b", "/tmp/project-a-worktree"]),
    getShellSnapshot: () =>
      Effect.die("full shell should not be loaded when the lightweight query is available"),
  } as never),
  NodeServices.layer,
);

it.layer(testLayer)("resolveSkillWorkspaceCwds", (it) => {
  it.effect("includes server cwd, project roots, and worktrees", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const cwds = yield* resolveSkillWorkspaceCwds;
      const resolved = new Set(cwds.map((entry) => path.resolve(entry)));
      assert.ok(resolved.has(path.resolve("/tmp/server-cwd")));
      assert.ok(resolved.has(path.resolve("/tmp/project-a")));
      assert.ok(resolved.has(path.resolve("/tmp/project-b")));
      assert.ok(resolved.has(path.resolve("/tmp/project-a-worktree")));
    }),
  );
});
