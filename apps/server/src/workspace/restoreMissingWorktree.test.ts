import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, TerminalCwdNotFoundError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeRetryAfterRestoringWorktree } from "./restoreMissingWorktree.ts";

const harness = (worktreePath: string | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const created: Array<string | undefined> = [];
    const retry = yield* makeRetryAfterRestoringWorktree(() =>
      Effect.succeed({
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        worktreePath,
        branch: "feature",
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              worktreesDirectory: "",
              previousWorktreesDirectories: [],
            } as never),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeed(Option.some({ workspaceRoot: "/repo" } as never)),
          }),
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            pruneWorktrees: () => Effect.void,
            createWorktree: (input) =>
              Effect.sync(() => created.push(input.path ?? undefined)).pipe(
                Effect.andThen(fs.makeDirectory(input.path ?? "", { recursive: true })),
                Effect.as({} as never),
                Effect.orDie,
              ),
          }),
        ),
      ),
    );
    return { retry, created };
  });

const launchIn = (cwd: string) =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    fs.exists(cwd).pipe(
      Effect.orDie,
      Effect.flatMap((exists) =>
        exists ? Effect.succeed("opened") : Effect.fail(new TerminalCwdNotFoundError({ cwd })),
      ),
    ),
  );

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-restore-worktree-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("makeRetryAfterRestoringWorktree", (it) => {
  it.effect("recreates a cleaned-up worktree and retries the launch", () =>
    Effect.gen(function* () {
      const { worktreesDir } = yield* ServerConfig.ServerConfig;
      const worktreePath = (yield* Path.Path).join(worktreesDir, "project", "feature");
      const { retry, created } = yield* harness(worktreePath);

      assert.equal(yield* retry("thread-1", launchIn(worktreePath)), "opened");
      assert.deepEqual(created, [worktreePath]);
    }),
  );

  it.effect("reports the missing cwd when the thread has no worktree", () =>
    Effect.gen(function* () {
      const { worktreesDir } = yield* ServerConfig.ServerConfig;
      const cwd = (yield* Path.Path).join(worktreesDir, "project", "gone");
      const { retry, created } = yield* harness(null);

      const error = yield* retry("thread-1", launchIn(cwd)).pipe(Effect.flip);

      assert.deepEqual(error, new TerminalCwdNotFoundError({ cwd }));
      assert.deepEqual(created, []);
    }),
  );
});
