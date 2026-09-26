import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import { VcsProcessOutputLimitError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-worktree-driver-test-",
});
const serverConfigLiveLayer = serverConfigLayer.pipe(Layer.provide(NodeServices.layer));
const testLayer = GitVcsDriver.layer.pipe(
  Layer.provide(serverConfigLiveLayer),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("lists registered Git workspaces including the primary checkout", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const repositoryRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-git-worktree-repo-" });
    const worktreePath = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-git-worktree-root-" }),
      "feature",
    );

    const run = (args: ReadonlyArray<string>) =>
      driver.execute({
        operation: "GitVcsDriverWorktreeTest.git",
        cwd: repositoryRoot,
        args,
      });

    yield* run(["init", "-b", "main"]);
    yield* run(["config", "user.email", "test@example.com"]);
    yield* run(["config", "user.name", "T3 Test"]);
    yield* fs.writeFileString(path.join(repositoryRoot, "README.md"), "hello\n");
    yield* run(["add", "README.md"]);
    yield* run(["commit", "-m", "initial"]);
    yield* driver.createWorktree({
      cwd: repositoryRoot,
      refName: "main",
      newRefName: "feature/worktree",
      path: worktreePath,
    });

    const workspaces = yield* driver.listWorkspaces(repositoryRoot);
    assert.deepInclude(workspaces, {
      path: repositoryRoot,
      refName: "main",
      prunable: false,
    });
    assert.deepInclude(workspaces, {
      path: worktreePath,
      refName: "feature/worktree",
      prunable: false,
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects truncated worktree listings instead of parsing partial records", () =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const error = yield* driver.listWorkspaces("/repo").pipe(Effect.flip);

    assert.instanceOf(error, VcsProcessOutputLimitError);
    assert.equal(error.operation, "GitVcsDriver.listWorkspaces");
    assert.equal(error.command, "git");
    assert.equal(error.cwd, "/repo");
    assert.equal(error.stream, "stdout");
    assert.equal(error.maxBytes, 16 * 1024 * 1024);
    assert.equal(
      error.observedBytes,
      "worktree /repo\0HEAD deadbeef\0branch refs/heads/main\0\0worktree /partial".length,
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: () =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: "worktree /repo\0HEAD deadbeef\0branch refs/heads/main\0\0worktree /partial",
              stderr: "",
              stdoutTruncated: true,
              stderrTruncated: false,
            }),
        }),
      ),
    ),
  ),
);
