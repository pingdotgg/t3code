import { assert, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { resolveUsageWorkspaceCwds } from "./usageWorkspaceCwds.ts";

class ProjectionUnavailable extends Data.TaggedError("ProjectionUnavailable") {}

it.effect("falls back to the server cwd when workspace projections fail", () =>
  Effect.gen(function* () {
    const workspaceCwds = yield* resolveUsageWorkspaceCwds(
      "/server-cwd",
      Effect.fail(new ProjectionUnavailable()),
    );

    assert.deepEqual(workspaceCwds, ["/server-cwd"]);
  }),
);

it.effect("collects distinct project and worktree cwd values", () =>
  Effect.gen(function* () {
    const workspaceCwds = yield* resolveUsageWorkspaceCwds(
      "/server-cwd",
      Effect.succeed([
        {
          projects: [{ workspaceRoot: "/project-a" }, { workspaceRoot: "/server-cwd" }],
          threads: [{ worktreePath: "/worktree-a" }, { worktreePath: null }],
        },
        {
          projects: [{ workspaceRoot: "/project-a" }],
          threads: [{ worktreePath: "/worktree-a" }],
        },
      ]),
    );

    assert.deepEqual(workspaceCwds, ["/server-cwd", "/project-a", "/worktree-a"]);
  }),
);
