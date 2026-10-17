import { assert, it } from "@effect/vitest";
import { CheckpointRef, VcsError } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
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

const ContractLayer = Layer.effect(VcsDriver.VcsDriver, JjVcsDriver.JjVcsDriver).pipe(
  Layer.provide(JjVcsDriver.layer),
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
  it.effect("keeps repository configuration inside the disposable test config", () =>
    withRepo(({ root, path }) =>
      Effect.gen(function* () {
        const configPath = (yield* runJj(root, ["config", "path", "--repo"])).trim();
        const testConfig = process.env.JJ_CONFIG ?? "";
        assert.notStrictEqual(testConfig, "");
        assert.isTrue(configPath.startsWith(`${path.dirname(testConfig)}${path.sep}`));
      }),
    ),
  );

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
  it.effect(
    "rereads secondary repository pointers and colocation without explicit invalidation",
    () =>
      withRepo(({ driver, fileSystem, path, base, root }) =>
        Effect.gen(function* () {
          const secondary = path.join(base, "secondary");
          const other = path.join(base, "other");
          yield* fileSystem.makeDirectory(path.join(secondary, ".jj"), { recursive: true });
          yield* fileSystem.makeDirectory(other);
          yield* createJjRepo(other);
          const pointer = path.join(secondary, ".jj", "repo");
          yield* fileSystem.writeFileString(pointer, path.join(root, ".jj", "repo"));
          assert.equal((yield* driver.repoPaths(secondary)).mainWorkspaceRoot, root);

          yield* fileSystem.writeFileString(pointer, path.join(other, ".jj", "repo"));
          assert.equal((yield* driver.repoPaths(secondary)).mainWorkspaceRoot, other);
          yield* fileSystem.rename(path.join(other, ".git"), path.join(base, "old-git"));
          assert.equal((yield* driver.repoPaths(secondary)).gitDir, null);
        }),
      ),
  );

  it.effect("does not reuse metadata after replacing a repository at the same root", () =>
    withRepo(({ driver, fileSystem, path, base, root }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["git", "remote", "add", "before", "https://example.com/before.git"]);
        assert.deepEqual(yield* driver.listRemoteNames(root), ["before"]);
        assert.equal(yield* driver.resolveDefaultBookmark(root), null);

        yield* fileSystem.rename(path.join(root, ".jj"), path.join(base, "old-jj"));
        yield* fileSystem.rename(path.join(root, ".git"), path.join(base, "old-git"));
        yield* createJjRepo(root);
        yield* runJj(root, ["git", "remote", "add", "after", "https://example.com/after.git"]);
        yield* fileSystem.writeFileString(path.join(root, "a.txt"), "a\n");
        yield* runJj(root, ["commit", "-m", "replacement"]);
        yield* runJj(root, ["bookmark", "create", "main", "-r", "@-"]);

        assert.deepEqual(yield* driver.listRemoteNames(root), ["after"]);
        assert.equal(yield* driver.resolveDefaultBookmark(root), "main");
      }),
    ),
  );

  it.effect("refreshes remote metadata when external configuration changes", () =>
    withRepo(({ driver, root }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["git", "remote", "add", "origin", "https://example.com/repo.git"]);
        assert.deepEqual(yield* driver.listRemoteNames(root), ["origin"]);
        yield* runJj(root, ["git", "remote", "rename", "origin", "upstream"]);
        assert.deepEqual(yield* driver.listRemoteNames(root), ["upstream"]);
        assert.equal(yield* driver.resolvePrimaryRemoteName(root), "upstream");
      }),
    ),
  );
});

describeJj("JjVcsDriver primary remotes", () => {
  for (const names of [["upstream"], ["backup", "upstream"], ["backup", "origin"]]) {
    it.effect(`agrees on the primary remote for ${names.join(", ")}`, () =>
      withRepo(({ driver, root }) =>
        Effect.gen(function* () {
          for (const name of names) {
            yield* runJj(root, ["git", "remote", "add", name, `https://example.com/${name}.git`]);
          }
          const result = yield* driver.listRemotes(root);
          const primary = yield* driver.resolvePrimaryRemoteName(root);
          assert.deepEqual(
            result.remotes.filter((remote) => remote.isPrimary).map((remote) => remote.name),
            [primary],
          );
          assert.equal(primary, names.includes("origin") ? "origin" : result.remotes[0]?.name);
        }),
      ),
    );
  }
});

describeJj("JjVcsDriver reads", () => {
  it.effect("ignores user keyword aliases in machine-readable templates", () =>
    withRepo(({ driver, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "a.txt"), "a\n");
        yield* runJj(root, ["commit", "-m", "original"]);
        yield* runJj(root, ["bookmark", "create", "main", "-r", "@-"]);
        yield* fileSystem.writeFileString(
          path.join(root, ".jj", "repo", "config.toml"),
          '[template-aliases]\ncommit_id = "false"\nempty = \'"wrong"\'\n' +
            'description = \'"wrong"\'\nparents = "false"\nlocal_bookmarks = "false"\n' +
            'name = \'"wrong"\'\nroot = \'"wrong"\'\npath = \'"wrong"\'\n',
        );
        assert.isTrue((yield* driver.currentChange(root)).empty);
        assert.equal((yield* driver.changeAt(root, "@-"))?.description, "original\n");
        assert.equal((yield* driver.currentSegment(root))[0]?.empty, true);
        assert.equal((yield* driver.listBookmarks(root))[0]?.name, "main");
        assert.equal((yield* driver.listWorkspaces(root))[0]?.root, root);
        assert.deepEqual((yield* driver.listWorkspaceFiles(root)).paths, ["a.txt"]);
      }),
    ),
  );

  it.effect("names the malformed field without leaking its value", () =>
    withRepo(({ driver, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(
          path.join(root, ".jj", "repo", "config.toml"),
          String.raw`[template-aliases]
"json(value)" = '"\"credential-secret\""'
`,
        );
        const error = yield* driver.currentChange(root).pipe(Effect.flip);
        assert.equal(error._tag, "VcsProcessOutputReadError");
        assert.notInclude(error.message, "credential-secret");
        if (error._tag === "VcsProcessOutputReadError") {
          assert.equal(error.cause instanceof Error && error.cause.message, "Malformed jj output at root.");
          assert.notInclude(String(error.cause), "credential-secret");
        }
      }),
    ),
  );

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

  it.effect("treats missing revisions as absent but preserves malformed revset failures", () =>
    withRepo(({ driver, root }) =>
      Effect.gen(function* () {
        assert.equal(yield* driver.changeAt(root, "main@origin"), null);
        assert.equal(
          yield* driver.changeAt(root, "0123456789abcdef0123456789abcdef01234567"),
          null,
        );
        assert.equal(
          (yield* driver.changeAt(root, "invalid(").pipe(Effect.flip))._tag,
          "VcsProcessExitError",
        );
        assert.equal(
          (yield* driver.changeAt(root, "trnk()").pipe(Effect.flip))._tag,
          "VcsProcessExitError",
        );
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
        assert.equal(
          (yield* driver.countRevset(root, "invalid(").pipe(Effect.flip))._tag,
          "VcsProcessExitError",
        );
        assert.equal(
          (yield* driver.countRevset(root, "trnk()").pipe(Effect.flip))._tag,
          "VcsProcessExitError",
        );
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

  it.effect("uses workspace-root ignore rules from nested directories in every workspace", () =>
    withRepo(({ driver, fileSystem, path, base, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, ".gitignore"), "/nested/ignored.txt\n");
        yield* fileSystem.makeDirectory(path.join(root, "nested"), { recursive: true });
        yield* runJj(root, ["commit", "-m", "ignore rules"]);
        const secondary = path.join(base, "secondary");
        yield* runJj(root, ["workspace", "add", "--no-colocate", "--name", "secondary", secondary]);
        yield* fileSystem.makeDirectory(path.join(secondary, "nested"), { recursive: true });
        for (const workspace of [root, secondary]) {
          assert.deepStrictEqual(
            yield* driver.filterIgnoredPaths(path.join(workspace, "nested"), [
              "ignored.txt",
              "keep.txt",
            ]),
            ["keep.txt"],
          );
        }
      }),
    ),
  );

  it.effect("keeps a deleted workspace listed so it can still be forgotten", () =>
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

        assert.isDefined(gone);
        assert.equal(gone?.root, secondary);
        assert.isFalse(workspaces.some((workspace) => workspace.root === process.cwd()));
      }),
    ),
  );
});

describeJj("JjVcsDriver usability", () => {
  it.effect("preserves broken jj config diagnostics instead of claiming it is missing", () =>
    withRepo(({ driver, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(
          path.join(root, ".jj", "repo", "config.toml"),
          "invalid = [\n",
        );
        const error = yield* driver.currentChange(root).pipe(Effect.flip);
        assert.equal(error._tag, "VcsUnsupportedOperationError");
        if (error._tag === "VcsUnsupportedOperationError") {
          assert.include(error.detail, "Config error");
          assert.notInclude(error.detail, "not installed");
        }
      }),
    ),
  );

  it.effect("does not let one repository's broken config poison another repository", () =>
    withRepo(({ driver, fileSystem, path, base, root }) =>
      Effect.gen(function* () {
        const healthy = path.join(base, "healthy");
        yield* fileSystem.makeDirectory(healthy);
        yield* createJjRepo(healthy);
        yield* fileSystem.writeFileString(
          path.join(root, ".jj", "repo", "config.toml"),
          "invalid = [\n",
        );
        yield* driver.currentChange(root).pipe(Effect.flip);
        assert.isTrue((yield* driver.currentChange(healthy)).empty);
      }),
    ),
  );

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
  it.effect("reports malformed output without leaking it or inventing an exit status", () => {
    const secret = "credential-secret";
    const malformedProcess = Layer.mock(VcsProcess.VcsProcess)({
      run: (input) =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(input.args.includes("check-ignore") ? 128 : 0),
          stdout: input.args.includes("--version") ? "jj 0.46.0\n" : secret,
          stderr: input.args.includes("check-ignore") ? secret : "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const created = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-decode-" });
      const root = path.join(yield* fileSystem.realPath(created), "work");
      yield* fileSystem.makeDirectory(root, { recursive: true });
      yield* createJjRepo(root);
      const driver = yield* JjVcsDriver.JjVcsDriver;
      const error = yield* driver.currentChange(root).pipe(Effect.flip);
      assert.equal(error._tag, "VcsProcessOutputReadError");
      assert.notInclude(error.message, secret);
      assert.notInclude(yield* Schema.encodeEffect(Schema.fromJsonString(VcsError))(error), secret);
      assert.isFalse("exitCode" in error);
      const ignoreError = yield* driver.filterIgnoredPaths(root, ["file.txt"]).pipe(Effect.flip);
      assert.equal(ignoreError._tag, "VcsProcessExitError");
      assert.notInclude(
        yield* Schema.encodeEffect(Schema.fromJsonString(VcsError))(ignoreError),
        secret,
      );
    }).pipe(
      Effect.provide(
        JjVcsDriver.layer.pipe(
          Layer.provide(malformedProcess),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });

  it.effect("propagates a non-zero exit instead of reporting an empty list", () => {
    const failingProcess = Layer.mock(VcsProcess.VcsProcess)({
      run: (input) =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(input.args.includes("--version") ? 0 : 1),
          stdout: input.args.includes("--version") ? "jj 0.46.0\n" : "",
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
      assert.equal(
        (yield* driver.currentSegment(root).pipe(Effect.flip))._tag,
        "VcsProcessExitError",
      );
      assert.equal(
        (yield* driver.countRevset(root, "@").pipe(Effect.flip))._tag,
        "VcsProcessExitError",
      );
      assert.equal((yield* driver.listRemotes(root).pipe(Effect.flip))._tag, "VcsProcessExitError");
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

describeJj("JjVcsDriver authored checkpoint paths", () => {
  it.effect("includes paths across committed changes and checkpoint snapshots", () =>
    withJjRepo({ prefix: "t3-jj-authored-", seed: true }, ({ driver, root, fileSystem, path }) =>
      Effect.gen(function* () {
        assert(driver.checkpoints);
        const fromCheckpointRef = CheckpointRef.make("refs/t3/checkpoints/from");
        const toCheckpointRef = CheckpointRef.make("refs/t3/checkpoints/to");
        yield* driver.checkpoints.captureCheckpoint({
          cwd: root,
          checkpointRef: fromCheckpointRef,
        });
        yield* fileSystem.writeFileString(path.join(root, "committed.txt"), "committed\n");
        yield* runJj(root, ["new", "-m", "next change"]);
        yield* fileSystem.writeFileString(path.join(root, "snapshot.txt"), "snapshot\n");
        yield* driver.checkpoints.captureCheckpoint({ cwd: root, checkpointRef: toCheckpointRef });
        const paths = yield* driver.checkpoints.listAuthoredPaths({
          cwd: root,
          fromCheckpointRef,
          toCheckpointRef,
        });
        assert.isNotNull(paths);
        assert.deepEqual(Array.from(paths ?? []).sort(), ["committed.txt", "snapshot.txt"]);
        const filteredDiff = yield* driver.checkpoints.diffCheckpoints({
          cwd: root,
          fromCheckpointRef,
          toCheckpointRef,
          filePaths: ["snapshot.txt"],
          ignoreWhitespace: false,
        });
        assert.include(filteredDiff, "snapshot.txt");
        assert.notInclude(filteredDiff, "committed.txt");
        assert.equal(
          yield* driver.checkpoints.diffCheckpoints({
            cwd: root,
            fromCheckpointRef,
            toCheckpointRef,
            filePaths: [],
            ignoreWhitespace: false,
          }),
          "",
        );
      }),
    ),
  );

  it.effect("falls back to the complete diff when checkpoint parents are unchanged", () =>
    withRepo(({ driver, root }) =>
      Effect.gen(function* () {
        assert(driver.checkpoints);
        const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/same");
        yield* driver.checkpoints.captureCheckpoint({ cwd: root, checkpointRef });
        assert.isNull(
          yield* driver.checkpoints.listAuthoredPaths({
            cwd: root,
            fromCheckpointRef: checkpointRef,
            toCheckpointRef: checkpointRef,
          }),
        );
      }),
    ),
  );
});

describeJj("JjVcsDriver merge checkpoint paths", () => {
  it.effect("keeps the full diff when the starting snapshot has multiple parents", () =>
    withJjRepo(
      { prefix: "t3-jj-merge-authored-", seed: true },
      ({ driver, root, fileSystem, path }) =>
        Effect.gen(function* () {
          assert(driver.checkpoints);
          yield* fileSystem.writeFileString(path.join(root, "left.txt"), "left\n");
          yield* runJj(root, ["bookmark", "create", "left"]);
          yield* runJj(root, ["new", "main"]);
          yield* fileSystem.writeFileString(path.join(root, "right.txt"), "right\n");
          yield* runJj(root, ["new", "left", "@"]);
          const fromCheckpointRef = CheckpointRef.make("refs/t3/checkpoints/merge-from");
          const toCheckpointRef = CheckpointRef.make("refs/t3/checkpoints/merge-to");
          yield* driver.checkpoints.captureCheckpoint({
            cwd: root,
            checkpointRef: fromCheckpointRef,
          });
          yield* runJj(root, ["new"]);
          yield* driver.checkpoints.captureCheckpoint({
            cwd: root,
            checkpointRef: toCheckpointRef,
          });
          assert.isNull(
            yield* driver.checkpoints.listAuthoredPaths({
              cwd: root,
              fromCheckpointRef,
              toCheckpointRef,
            }),
          );
        }),
    ),
  );
});
