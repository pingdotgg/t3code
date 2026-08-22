import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import { GitCommandError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProjectScaffoldService from "./ProjectScaffoldService.ts";

const RealGitLayer = ProjectScaffoldService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-scaffold-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return yield* driver.execute({
      operation: "ProjectScaffoldService.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

it.effect("scaffolds a committed repo on main with README and favicon", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* ProjectScaffoldService.ProjectScaffoldService;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-scaffold-" });
      const destination = path.join(tempDir, "cool-idea");

      const result = yield* service.scaffold({ name: "Cool Idea", destinationPath: destination });
      assert.equal(result.cwd, destination);

      const readme = yield* fileSystem.readFileString(path.join(destination, "README.md"));
      assert.equal(readme, "# Cool Idea\n\nInitialized with T3 Code.\n");
      const favicon = yield* fileSystem.readFileString(path.join(destination, "favicon.svg"));
      assert.include(favicon, "<svg");

      // The initial commit is the point of the scaffold: worktree creation
      // fails on an unborn HEAD, so HEAD must resolve and the tree be clean.
      const branch = yield* runGit(destination, ["symbolic-ref", "--short", "HEAD"]);
      assert.equal(branch.stdout.trim(), "main");
      yield* runGit(destination, ["rev-parse", "--verify", "HEAD"]);
      const status = yield* runGit(destination, ["status", "--porcelain"]);
      assert.equal(status.stdout.trim(), "");
    }),
  ).pipe(Effect.provide(RealGitLayer)),
);

it.effect("refuses an existing destination folder", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* ProjectScaffoldService.ProjectScaffoldService;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-scaffold-" });
      const destination = path.join(tempDir, "taken");
      yield* fileSystem.makeDirectory(destination);

      const error = yield* Effect.flip(
        service.scaffold({ name: "Taken", destinationPath: destination }),
      );
      assert.include(error.detail, "already exists");
    }),
  ).pipe(Effect.provide(RealGitLayer)),
);

it.effect("removes the created folder when a git step fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-scaffold-" });
      const destination = path.join(tempDir, "doomed");

      const failingGitLayer = ProjectScaffoldService.layer.pipe(
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            execute: (input) =>
              input.args.includes("commit")
                ? Effect.fail(
                    new GitCommandError({
                      operation: input.operation,
                      command: "git",
                      cwd: input.cwd,
                      detail: "boom",
                    }),
                  )
                : Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: "",
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  }),
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );

      const error = yield* Effect.gen(function* () {
        const service = yield* ProjectScaffoldService.ProjectScaffoldService;
        return yield* Effect.flip(
          service.scaffold({ name: "Doomed", destinationPath: destination }),
        );
      }).pipe(Effect.provide(failingGitLayer));

      assert.isNotNull(error);
      assert.isFalse(yield* fileSystem.exists(destination));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
