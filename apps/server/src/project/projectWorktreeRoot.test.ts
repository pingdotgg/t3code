// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import type { OrchestrationProject } from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeProjectWorktreeRootResolver } from "./projectWorktreeRoot.ts";

const WORKSPACE_ROOT = "/tmp/project-worktree-root";

const makeProject = (worktreeRoot: string | null): OrchestrationProject => ({
  id: ProjectId.make("project-worktree-root"),
  title: "Project",
  workspaceRoot: WORKSPACE_ROOT,
  repositoryIdentity: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  worktreeRoot,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  deletedAt: null,
});

const resolveOn = (
  pathLayer: Layer.Layer<Path.Path>,
  getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"],
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const resolve = makeProjectWorktreeRootResolver({
      projectionSnapshotQuery: {
        getActiveProjectByWorkspaceRoot,
      } as ProjectionSnapshotQueryShape,
      path,
    });
    return yield* resolve(WORKSPACE_ROOT);
  }).pipe(Effect.provide(pathLayer));

const resolveWith = (
  getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"],
) => resolveOn(NodeServices.layer, getActiveProjectByWorkspaceRoot);

describe("resolveProjectWorktreeRoot", () => {
  it.effect("returns undefined when the project sets no override", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveWith(() => Effect.succeed(Option.some(makeProject(null))));
      assert.strictEqual(resolved, undefined);
    }),
  );

  it.effect("returns undefined when no project owns the workspace root", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveWith(() => Effect.succeed(Option.none()));
      assert.strictEqual(resolved, undefined);
    }),
  );

  it.effect("expands a leading ~ so the path never depends on the server cwd", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveWith(() =>
        Effect.succeed(Option.some(makeProject("~/code/myrepo.worktrees"))),
      );
      assert.strictEqual(resolved, `${NodeOS.homedir()}/code/myrepo.worktrees`);
    }),
  );

  it.effect("falls back to the default location for a root this platform cannot resolve", () =>
    Effect.gen(function* () {
      // A Windows root reaching a POSIX server: resolving it would silently put
      // worktrees under the server's cwd, so the default location wins.
      const resolved = yield* resolveOn(NodePath.layerPosix, () =>
        Effect.succeed(Option.some(makeProject("C:\\worktrees"))),
      );
      assert.strictEqual(resolved, undefined);
    }),
  );

  it.effect("keeps a Windows root on a Windows server", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveOn(NodePath.layerWin32, () =>
        Effect.succeed(Option.some(makeProject("C:\\worktrees"))),
      );
      assert.strictEqual(resolved, "C:\\worktrees");
    }),
  );

  it.effect("falls back to the default location when the projection read fails", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveWith(() =>
        Effect.fail(
          new PersistenceSqlError({
            operation: "test.getActiveProjectByWorkspaceRoot",
            detail: "projection unavailable",
          }),
        ),
      );
      assert.strictEqual(resolved, undefined);
    }),
  );
});
