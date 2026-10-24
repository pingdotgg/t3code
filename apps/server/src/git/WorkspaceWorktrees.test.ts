import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceWorktrees from "./WorkspaceWorktrees.ts";

const layerTest = (baseDir: string) =>
  WorkspaceWorktrees.layer.pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(VcsProcess.VcsProcess, (process) =>
    process.run({ operation: "WorkspaceWorktrees.test", command: "git", cwd, args }),
  ).pipe(Effect.map((result) => result.stdout.trim()));

const initRepository = Effect.fn("initRepository")(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(cwd, { recursive: true });
  yield* git(cwd, ["init", "--initial-branch=main"]);
  yield* git(cwd, ["config", "user.email", "test@test.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* fileSystem.writeFileString(`${cwd}/README.md`, "# test\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "initial commit"]);
});

it.effect("creates, renames and removes an isolated run across repositories", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-workspace-worktrees-",
    });
    yield* Effect.gen(function* () {
      const worktrees = yield* WorkspaceWorktrees.WorkspaceWorktrees;
      const workspaceRoot = path.join(baseDir, "project");
      yield* initRepository(path.join(workspaceRoot, "api"));
      yield* initRepository(path.join(workspaceRoot, "web"));
      yield* fileSystem.writeFileString(path.join(workspaceRoot, "README.md"), "shared\n");
      yield* fileSystem.makeDirectory(path.join(workspaceRoot, "shared"));

      const created = yield* worktrees.create({
        workspaceRoot,
        repositories: [
          { relativePath: "api", name: "api" },
          { relativePath: "web", name: "web" },
        ],
        branch: "t3code/abcd1234",
        startFromOrigin: false,
      });

      assert.equal(created.path, path.join(baseDir, "worktrees", "project", "t3code-abcd1234"));
      assert.equal(
        yield* git(path.join(created.path, "api"), ["branch", "--show-current"]),
        "t3code/abcd1234",
      );
      assert.equal(
        yield* fileSystem.readLink(path.join(created.path, "README.md")),
        path.join(workspaceRoot, "README.md"),
      );
      assert.isTrue(yield* worktrees.isContainer(created.path));
      assert.isFalse(yield* worktrees.isContainer(workspaceRoot));

      const renamed = yield* worktrees.renameBranch({
        path: created.path,
        oldBranch: "t3code/abcd1234",
        newBranch: "feature",
      });
      assert.equal(renamed.branch, "feature");
      assert.equal(
        yield* git(path.join(created.path, "web"), ["branch", "--show-current"]),
        "feature",
      );

      // A name taken in a later repository undoes the rename in the earlier ones.
      yield* git(path.join(workspaceRoot, "web"), ["branch", "taken"]);
      const conflict = yield* worktrees
        .renameBranch({
          path: created.path,
          oldBranch: "feature",
          newBranch: "taken",
          exactName: true,
        })
        .pipe(Effect.flip);
      assert.equal(conflict._tag, "GitCommandError");
      assert.equal(
        yield* git(path.join(created.path, "api"), ["branch", "--show-current"]),
        "feature",
      );

      yield* worktrees.remove({ workspaceRoot, path: created.path, force: false });
      assert.isFalse(yield* fileSystem.exists(created.path));
      assert.isTrue(yield* fileSystem.exists(path.join(workspaceRoot, "README.md")));
      assert.isTrue(yield* fileSystem.exists(path.join(workspaceRoot, "shared")));
      assert.notInclude(
        yield* git(path.join(workspaceRoot, "api"), ["worktree", "list"]),
        created.path,
      );
    }).pipe(Effect.provide(layerTest(baseDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("removes nested worktrees after the workspace file is gone", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-workspace-worktrees-",
    });
    yield* Effect.gen(function* () {
      const worktrees = yield* WorkspaceWorktrees.WorkspaceWorktrees;
      const workspaceRoot = path.join(baseDir, "project");
      const workspaceFile = path.join(workspaceRoot, "project.code-workspace");
      yield* initRepository(path.join(workspaceRoot, "packages", "api"));
      yield* fileSystem.writeFileString(
        workspaceFile,
        `{ "folders": [{ "path": "packages/api" }] }`,
      );
      const created = yield* worktrees.create({
        workspaceRoot,
        repositories: [{ relativePath: "packages/api", name: "api" }],
        branch: "nested",
        startFromOrigin: false,
      });
      yield* fileSystem.remove(workspaceFile);

      yield* worktrees.remove({ workspaceRoot, path: created.path, force: false });

      assert.isFalse(yield* fileSystem.exists(created.path));
      assert.notInclude(
        yield* git(path.join(workspaceRoot, "packages", "api"), ["worktree", "list"]),
        created.path,
      );
    }).pipe(Effect.provide(layerTest(baseDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("uses t3-<hash> in every repository when one has a plain t3 branch", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-workspace-worktrees-",
    });
    yield* Effect.gen(function* () {
      const worktrees = yield* WorkspaceWorktrees.WorkspaceWorktrees;
      const workspaceRoot = path.join(baseDir, "project");
      yield* initRepository(path.join(workspaceRoot, "api"));
      yield* initRepository(path.join(workspaceRoot, "web"));
      yield* git(path.join(workspaceRoot, "web"), ["branch", "t3"]);

      const created = yield* worktrees.create({
        workspaceRoot,
        repositories: [
          { relativePath: "api", name: "api" },
          { relativePath: "web", name: "web" },
        ],
        branch: "t3/abcd1234",
        startFromOrigin: false,
      });

      assert.equal(created.branch, "t3-abcd1234");
      assert.equal(created.path, path.join(baseDir, "worktrees", "project", "t3-abcd1234"));
      assert.equal(
        yield* git(path.join(created.path, "api"), ["branch", "--show-current"]),
        "t3-abcd1234",
      );
    }).pipe(Effect.provide(layerTest(baseDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps a container that holds anything besides its worktrees and links", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-workspace-worktrees-",
    });
    yield* Effect.gen(function* () {
      const worktrees = yield* WorkspaceWorktrees.WorkspaceWorktrees;
      const workspaceRoot = path.join(baseDir, "project");
      yield* initRepository(path.join(workspaceRoot, "api"));
      const created = yield* worktrees.create({
        workspaceRoot,
        repositories: [{ relativePath: "api", name: "api" }],
        branch: "keep-notes",
        startFromOrigin: false,
      });
      yield* fileSystem.writeFileString(path.join(created.path, "notes.md"), "mine\n");

      yield* worktrees.remove({ workspaceRoot, path: created.path, force: false });

      assert.isFalse(yield* fileSystem.exists(path.join(created.path, "api")));
      assert.equal(yield* fileSystem.readFileString(path.join(created.path, "notes.md")), "mine\n");
    }).pipe(Effect.provide(layerTest(baseDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("with a workspace file, links files, dot-folders and listed folders only", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-workspace-worktrees-",
    });
    yield* Effect.gen(function* () {
      const worktrees = yield* WorkspaceWorktrees.WorkspaceWorktrees;
      const workspaceRoot = path.join(baseDir, "project");
      yield* initRepository(path.join(workspaceRoot, "api"));
      yield* initRepository(path.join(workspaceRoot, "tools"));
      for (const folder of ["shared", ".vscode", "archive/old-run"]) {
        yield* fileSystem.makeDirectory(path.join(workspaceRoot, folder), { recursive: true });
      }
      yield* fileSystem.writeFileString(path.join(workspaceRoot, "README.md"), "shared\n");
      yield* fileSystem.writeFileString(
        path.join(workspaceRoot, "team.code-workspace"),
        '{ "folders": [{ "path": "api" }, { "path": "shared" }] }',
      );

      const created = yield* worktrees.create({
        workspaceRoot,
        repositories: [{ relativePath: "api", name: "api" }],
        branch: "listed-only",
        startFromOrigin: false,
      });

      assert.deepEqual((yield* fileSystem.readDirectory(created.path)).toSorted(), [
        ".vscode",
        "README.md",
        "api",
        "shared",
        "team.code-workspace",
      ]);
    }).pipe(Effect.provide(layerTest(baseDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
