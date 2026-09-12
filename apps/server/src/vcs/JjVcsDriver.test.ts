import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";
import {
  createJjRepo,
  describeJj,
  type JjRepoFixture,
  type JjTestCommandError,
  runGit,
  runJj,
  withJjRepo,
} from "./testing/JjTestSupport.ts";

const ContractLayer = JjVcsDriver.vcsLayer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

type JjContractError = JjTestCommandError | PlatformError.PlatformError;

const withRepo = <A, E>(
  use: (fixture: JjRepoFixture) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) => withJjRepo({ prefix: "t3-jj-driver-" }, use);

describeJj("Jujutsu VCS driver contract", () => {
  runVcsDriverContractSuite<never, JjContractError>({
    name: "Jujutsu",
    kind: "jj",
    layer: ContractLayer,
    fixture: {
      createRepo: (cwd) => createJjRepo(cwd),
      writeFile: (cwd, relativePath, contents) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const absolutePath = path.join(cwd, relativePath);
          yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
          yield* fileSystem.writeFileString(absolutePath, contents);
        }),
      ignorePath: (cwd, pattern) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
        }),
    },
  });
});

describeJj("JjVcsDriver detection", () => {
  it.effect(
    "resolves the workspace root from a nested directory without spawning a process",
    () => {
      const calls = { count: 0 };
      const countingProcess = Layer.mock(VcsProcess.VcsProcess)({
        run: () =>
          Effect.sync(() => {
            calls.count += 1;
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const created = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-detect-" });
        const root = yield* fileSystem.realPath(created);
        yield* createJjRepo(root);
        const nested = path.join(root, "src", "deep");
        yield* fileSystem.makeDirectory(nested, { recursive: true });

        const driver = yield* JjVcsDriver.JjVcsDriver;
        const identity = yield* driver.detectRepository(nested);

        assert.equal(identity?.kind, "jj");
        assert.equal(identity?.rootPath, root);
        assert.equal(identity?.metadataPath, path.join(root, ".jj"));
        assert.isTrue(yield* driver.isInsideWorkTree(nested));
        assert.equal(calls.count, 0);
      }).pipe(
        Effect.provide(
          JjVcsDriver.layer.pipe(
            Layer.provide(countingProcess),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
    },
  );

  it.effect("detects a secondary workspace as its own jj root", () =>
    withRepo(({ driver, fileSystem, path, base, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "a.txt"), "a\n");
        yield* runJj(root, ["commit", "-m", "first"]);
        const workspacesDir = path.join(base, "workspaces");
        yield* fileSystem.makeDirectory(workspacesDir, { recursive: true });
        const secondary = path.join(workspacesDir, "thread");
        yield* runJj(root, ["workspace", "add", "--name", "t3-thread", secondary]);

        const identity = yield* driver.detectRepository(secondary);
        assert.equal(identity?.rootPath, yield* fileSystem.realPath(secondary));

        const paths = yield* driver.repoPaths(secondary);
        assert.equal(paths.mainWorkspaceRoot, root);
        assert.equal(paths.isSecondaryWorkspace, true);
      }),
    ),
  );
});

describeJj("JjVcsDriver reads", () => {
  it.effect("keeps the root commit out of a first change's parents", () =>
    withRepo(({ driver, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "a.txt"), "a\n");

        const change = yield* driver.currentChange(root);

        assert.deepStrictEqual(change.parentCommitIds, []);
        assert.equal(change.empty, false);
        assert.deepStrictEqual(
          change.fileStats.map((file) => file.path),
          ["a.txt"],
        );
      }),
    ),
  );

  it.effect("reports the root commit as no change at all", () =>
    withRepo(({ driver, root }) =>
      Effect.gen(function* () {
        assert.equal(yield* driver.changeAt(root, "trunk()"), null);
        assert.equal(yield* driver.changeAt(root, "root()"), null);
      }),
    ),
  );

  it.effect("falls back to a local main bookmark when trunk resolves to nothing", () =>
    withRepo(({ driver, fileSystem, path, root }) =>
      Effect.gen(function* () {
        assert.equal(yield* driver.resolveDefaultBookmark(root), null);

        yield* fileSystem.writeFileString(path.join(root, "a.txt"), "a\n");
        yield* runJj(root, ["commit", "-m", "first"]);
        yield* runJj(root, ["bookmark", "create", "main", "-r", "@-"]);
        yield* driver.invalidateRepoCaches(root);

        assert.equal(yield* driver.resolveDefaultBookmark(root), "main");
      }),
    ),
  );

  it.effect("reads the bookmarked ancestor segment newest first", () =>
    withRepo(({ driver, fileSystem, path, root }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* driver.currentSegment(root), []);

        yield* fileSystem.writeFileString(path.join(root, "a.txt"), "a\n");
        yield* runJj(root, ["commit", "-m", "first"]);
        yield* runJj(root, ["bookmark", "create", "main", "-r", "@-"]);
        yield* fileSystem.writeFileString(path.join(root, "b.txt"), "b\n");

        const segment = yield* driver.currentSegment(root);
        assert.equal(segment.length, 2);
        assert.deepStrictEqual(segment[0]?.localBookmarks, []);
        assert.deepStrictEqual(segment[1]?.localBookmarks, ["main"]);
      }),
    ),
  );

  it.effect("drops the colocated git pseudo-remote from the bookmark list", () =>
    withRepo(({ driver, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "a.txt"), "a\n");
        yield* runJj(root, ["commit", "-m", "first"]);
        yield* runJj(root, ["bookmark", "create", "main", "-r", "@-"]);

        const bookmarks = yield* driver.listBookmarks(root);
        assert.deepStrictEqual(
          bookmarks.map((bookmark) => bookmark.remote),
          [null],
        );
        assert.equal(bookmarks[0]?.name, "main");
        assert.equal(bookmarks[0]?.target?.length, 40);
        assert.isTrue((bookmarks[0]?.targetTimestamp ?? 0) > 0);
      }),
    ),
  );

  it.effect("still decodes bookmarks after a rename leaves a deleted local bookmark", () =>
    withRepo(({ driver, fileSystem, path, base, root }) =>
      Effect.gen(function* () {
        const remote = path.join(base, "origin.git");
        yield* fileSystem.makeDirectory(remote, { recursive: true });
        yield* runGit(remote, ["init", "--bare", "--quiet"]);

        yield* fileSystem.writeFileString(path.join(root, "a.txt"), "a\n");
        yield* runJj(root, ["commit", "-m", "first"]);
        yield* runJj(root, ["bookmark", "create", "main", "-r", "@-"]);
        yield* runJj(root, ["git", "remote", "add", "origin", remote]);
        yield* runJj(root, ["git", "push", "--bookmark=main"]);
        // The rename leaves `main` tracking origin with no local target, and jj's
        // `normal_target` renders an error rather than a value for that row.
        yield* runJj(root, ["bookmark", "rename", "main", "renamed"]);

        const bookmarks = yield* driver.listBookmarks(root);
        assert.deepStrictEqual(
          bookmarks.map((bookmark) => ({ name: bookmark.name, remote: bookmark.remote })),
          [
            { name: "main", remote: "origin" },
            { name: "renamed", remote: null },
          ],
        );
      }),
    ),
  );

  it.effect("parses the remote list", () =>
    withRepo(({ driver, root }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["git", "remote", "add", "origin", "https://example.com/repo.git"]);

        const result = yield* driver.listRemotes(root);
        assert.deepStrictEqual(
          result.remotes.map((remote) => ({
            name: remote.name,
            url: remote.url,
            isPrimary: remote.isPrimary,
          })),
          [{ name: "origin", url: "https://example.com/repo.git", isPrimary: true }],
        );
        assert.equal(yield* driver.resolvePrimaryRemoteName(root), "origin");
      }),
    ),
  );

  it.effect("counts the commits in a revset", () =>
    withRepo(({ driver, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "a.txt"), "a\n");
        yield* runJj(root, ["commit", "-m", "first"]);
        yield* runJj(root, ["commit", "-m", "second"]);

        assert.equal(yield* driver.countRevset(root, "::@ ~ root()"), 3);
        assert.equal(yield* driver.countRevset(root, "no-such-bookmark@nowhere"), 0);
      }),
    ),
  );

  it.effect("lists files relative to the directory that was listed", () =>
    withRepo(({ driver, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(path.join(root, "src"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(root, "root.txt"), "root\n");
        yield* fileSystem.writeFileString(path.join(root, "src", "b.txt"), "b\n");

        const result = yield* driver.listWorkspaceFiles(path.join(root, "src"));

        assert.deepStrictEqual(result.paths, ["b.txt"]);
        assert.equal(result.truncated, false);
      }),
    ),
  );

  it.effect("honours the whole git ignore stack when filtering paths", () =>
    withRepo(({ driver, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, ".gitignore"), "*.log\n");
        yield* fileSystem.makeDirectory(path.join(root, "nested"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(root, "nested", ".gitignore"), "*.tmp\n");
        yield* fileSystem.makeDirectory(path.join(root, ".git", "info"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(root, ".git", "info", "exclude"), "secret*\n");

        const kept = yield* driver.filterIgnoredPaths(root, [
          "keep.ts",
          "debug.log",
          "nested/scratch.tmp",
          "secret.env",
        ]);

        assert.deepStrictEqual(kept, ["keep.ts"]);
      }),
    ),
  );

  it.effect("reports a deleted workspace's root as null, never the server's own directory", () =>
    withRepo(({ driver, fileSystem, path, base, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "a.txt"), "a\n");
        yield* runJj(root, ["commit", "-m", "first"]);
        const workspacesDir = path.join(base, "workspaces");
        yield* fileSystem.makeDirectory(workspacesDir, { recursive: true });
        const secondary = path.join(workspacesDir, "gone");
        yield* runJj(root, ["workspace", "add", "--name", "t3-gone", secondary]);
        yield* fileSystem.remove(secondary, { recursive: true });

        const workspaces = yield* driver.listWorkspaces(root);
        const gone = workspaces.find((workspace) => workspace.name === "t3-gone");

        assert.equal(gone?.root, null);
        assert.isFalse(workspaces.some((workspace) => workspace.root === process.cwd()));
      }),
    ),
  );
});

describeJj("JjVcsDriver usability", () => {
  it.effect("supports checkpoints in a colocated repository", () =>
    withRepo(({ driver, root }) =>
      Effect.gen(function* () {
        assert.isTrue(yield* driver.checkpointsUsable(root));
      }),
    ),
  );

  it.effect("refuses a repository that is not colocated, with an actionable reason", () =>
    withJjRepo({ prefix: "t3-jj-external-", colocated: false }, ({ driver, root }) =>
      Effect.gen(function* () {
        assert.equal((yield* driver.repoPaths(root)).gitDir, null);
        assert.isFalse(yield* driver.checkpointsUsable(root));

        const error = yield* driver.currentChange(root).pipe(Effect.flip);
        assert.equal(error._tag, "VcsUnsupportedOperationError");
        assert.include(
          error._tag === "VcsUnsupportedOperationError" ? error.detail : "",
          "colocated Jujutsu repositories",
        );
      }),
    ),
  );
});

describeJj("JjVcsDriver list reads", () => {
  it.effect("propagates a non-zero exit instead of reporting an empty list", () => {
    const failingProcess = Layer.mock(VcsProcess.VcsProcess)({
      run: (input) =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(input.args.includes("--version") ? 0 : 1),
          stdout: input.args.includes("--version") ? "jj 0.42.0\n" : "",
          stderr: input.args.includes("--version")
            ? ""
            : "Error: the operation log is unreadable\n",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const created = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-list-fail-" });
      const root = path.join(yield* fileSystem.realPath(created), "work");
      yield* fileSystem.makeDirectory(root, { recursive: true });
      yield* createJjRepo(root);

      const driver = yield* JjVcsDriver.JjVcsDriver;

      // An empty list here renders an empty branch picker with `isRepo: true`, and tells
      // `removeWorktree` that a healthy workspace is not registered.
      assert.equal(
        (yield* driver.listBookmarks(root).pipe(Effect.flip))._tag,
        "VcsProcessExitError",
      );
      assert.equal(
        (yield* driver.listWorkspaces(root).pipe(Effect.flip))._tag,
        "VcsProcessExitError",
      );
    }).pipe(
      Effect.provide(
        JjVcsDriver.layer.pipe(
          Layer.provide(failingProcess),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });
});
