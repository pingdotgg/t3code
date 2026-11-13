import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeWithUnsentCheckout } from "./restoreMissingWorktree.ts";
import { makeUnsentCheckouts } from "./unsentCheckout.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

it.layer(Layer.provideMerge(WorkspacePaths.layer, NodeServices.layer))(
  "withUnsentCheckout",
  (it) => {
    it.effect.each([{ recorded: true }, { recorded: false }])(
      "a draft reading a checkout storage cleanup removed (recorded: $recorded)",
      ({ recorded }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
          const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-unsent-checkout-" });
          const worktreesDir = path.join(baseDir, "worktrees");
          const worktreePath = path.join(worktreesDir, "project", "feature");
          yield* fs.makeDirectory(path.dirname(worktreePath), { recursive: true });
          const unsentCheckouts = yield* makeUnsentCheckouts;
          const recordPath = path.join(
            path.dirname(worktreePath),
            ".feature.t3-pull-request-checkout",
          );
          if (recorded) {
            yield* unsentCheckouts.record(worktreePath, {
              projectRoot: baseDir,
              branch: "feature",
            });
            yield* fs.utimes(recordPath, 1, 1);
          }
          const created: Array<{ readonly cwd: string; readonly refName: string }> = [];
          const withUnsentCheckout = yield* makeWithUnsentCheckout.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.mock(ServerConfig.ServerConfig)({
                  worktreesDir,
                } as ServerConfig.ServerConfig["Service"]),
                ServerSettings.layerTest(),
                Layer.mock(ProjectService.ProjectService)({}),
                Layer.mock(GitWorkflowService.GitWorkflowService)({
                  pruneWorktrees: () => Effect.void,
                  listLocalBranchNames: () => Effect.succeed(["feature"]),
                  createWorktree: (input) =>
                    Effect.gen(function* () {
                      created.push({ cwd: input.cwd, refName: input.refName });
                      yield* fs.makeDirectory(input.path!, { recursive: true }).pipe(Effect.orDie);
                      return {} as never;
                    }),
                }),
              ),
            ),
          );
          const read = withUnsentCheckout(
            worktreePath,
            workspacePaths.normalizeWorkspaceRoot(worktreePath),
          );
          if (!recorded) {
            const error = yield* read.pipe(Effect.flip);
            assert.equal(error._tag, "WorkspaceRootNotExistsError");
            assert.deepEqual(created, []);
            return;
          }
          assert.equal(yield* read, worktreePath);
          assert.deepEqual(created, [{ cwd: baseDir, refName: "feature" }]);
          const used = Option.getOrThrow((yield* fs.stat(recordPath)).mtime);
          assert.isAbove(used.getTime(), 1_000);
        }),
    );
  },
);
