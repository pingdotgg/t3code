import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  findVcsMarkerRoot,
  mainWorkspaceRootFromRepoPointer,
  resolveJjRepoPaths,
} from "./JjRepo.ts";
import { createJjRepo, describeJj, runJj } from "./testing/JjTestSupport.ts";

const withTempDir = <A, E>(
  use: (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly root: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const created = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-repo-" });
    const root = yield* fileSystem.realPath(created);
    return yield* use({ fileSystem, path, root });
  }).pipe(Effect.provide(NodeServices.layer));

/** The on-disk shape of a colocated main workspace: a `.jj` directory beside a `.git` directory. */
const makeColocatedRoot = (fileSystem: FileSystem.FileSystem, path: Path.Path, root: string) =>
  Effect.gen(function* () {
    yield* fileSystem.makeDirectory(path.join(root, ".jj", "repo"), { recursive: true });
    yield* fileSystem.makeDirectory(path.join(root, ".git"), { recursive: true });
  });

describe("findVcsMarkerRoot", () => {
  it.effect("resolves a subdirectory of a colocated workspace to its root", () =>
    withTempDir(({ fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* makeColocatedRoot(fileSystem, path, root);
        const nested = path.join(root, "src", "deep");
        yield* fileSystem.makeDirectory(nested, { recursive: true });

        assert.deepStrictEqual(yield* findVcsMarkerRoot(fileSystem, path, nested), {
          root,
          marker: "jj",
        });
      }),
    ),
  );

  it.effect("gives a nested git worktree to git, not to the jj workspace above it", () =>
    withTempDir(({ fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* makeColocatedRoot(fileSystem, path, root);
        const worktree = path.join(root, "worktrees", "thread");
        yield* fileSystem.makeDirectory(worktree, { recursive: true });
        // `git worktree add` writes `.git` as a file holding a gitdir pointer.
        yield* fileSystem.writeFileString(
          path.join(worktree, ".git"),
          `gitdir: ${path.join(root, ".git", "worktrees", "thread")}\n`,
        );

        assert.deepStrictEqual(yield* findVcsMarkerRoot(fileSystem, path, worktree), {
          root: worktree,
          marker: "git",
        });
      }),
    ),
  );

  it.effect("gives a nested plain git repository to git", () =>
    withTempDir(({ fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* makeColocatedRoot(fileSystem, path, root);
        const nestedRepo = path.join(root, "vendor", "lib");
        yield* fileSystem.makeDirectory(path.join(nestedRepo, ".git"), { recursive: true });

        assert.deepStrictEqual(yield* findVcsMarkerRoot(fileSystem, path, nestedRepo), {
          root: nestedRepo,
          marker: "git",
        });
      }),
    ),
  );

  it.effect("returns null for a path that no longer exists instead of walking up", () =>
    withTempDir(({ fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* makeColocatedRoot(fileSystem, path, root);
        const missing = path.join(root, "worktrees", "deleted-thread");

        assert.equal(yield* findVcsMarkerRoot(fileSystem, path, missing), null);
      }),
    ),
  );

  it.effect("returns null when no marker exists above the path", () =>
    withTempDir(({ fileSystem, path, root }) =>
      Effect.gen(function* () {
        const plain = path.join(root, "plain");
        yield* fileSystem.makeDirectory(plain, { recursive: true });

        assert.equal(yield* findVcsMarkerRoot(fileSystem, path, plain), null);
      }),
    ),
  );

  it.effect("normalises the root through symlinks", () =>
    withTempDir(({ fileSystem, path, root }) =>
      Effect.gen(function* () {
        const real = path.join(root, "real");
        yield* fileSystem.makeDirectory(path.join(real, ".jj", "repo"), { recursive: true });
        const link = path.join(root, "link");
        yield* fileSystem.symlink(real, link);

        assert.deepStrictEqual(yield* findVcsMarkerRoot(fileSystem, path, link), {
          root: real,
          marker: "jj",
        });
      }),
    ),
  );
});

describe("mainWorkspaceRootFromRepoPointer", () => {
  it("resolves a relative pointer against the workspace's own .jj directory", () => {
    assert.equal(
      mainWorkspaceRootFromRepoPointer("/lab/ws/thread", "../../../work/.jj/repo\n"),
      "/lab/work",
    );
  });

  it("resolves an absolute pointer", () => {
    assert.equal(
      mainWorkspaceRootFromRepoPointer("/lab/ws/thread", "/lab/work/.jj/repo"),
      "/lab/work",
    );
  });
});

describe("resolveJjRepoPaths", () => {
  it.effect("reports a colocated main workspace", () =>
    withTempDir(({ fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* makeColocatedRoot(fileSystem, path, root);

        assert.deepStrictEqual(yield* resolveJjRepoPaths(fileSystem, path, root), {
          workspaceRoot: root,
          mainWorkspaceRoot: root,
          gitDir: path.join(root, ".git"),
          isSecondaryWorkspace: false,
        });
      }),
    ),
  );

  it.effect("reports no git directory for a non-colocated repository", () =>
    withTempDir(({ fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(path.join(root, ".jj", "repo"), { recursive: true });

        const paths = yield* resolveJjRepoPaths(fileSystem, path, root);
        assert.equal(paths.gitDir, null);
        assert.equal(paths.isSecondaryWorkspace, false);
      }),
    ),
  );

  it.effect("follows a secondary workspace's relative repo pointer to the main workspace", () =>
    withTempDir(({ fileSystem, path, root }) =>
      Effect.gen(function* () {
        const main = path.join(root, "work");
        yield* makeColocatedRoot(fileSystem, path, main);
        const secondary = path.join(root, "ws", "thread");
        yield* fileSystem.makeDirectory(path.join(secondary, ".jj"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(secondary, ".jj", "repo"),
          "../../../work/.jj/repo",
        );

        assert.deepStrictEqual(yield* resolveJjRepoPaths(fileSystem, path, secondary), {
          workspaceRoot: secondary,
          mainWorkspaceRoot: main,
          gitDir: path.join(main, ".git"),
          isSecondaryWorkspace: true,
        });
      }),
    ),
  );
});

describeJj("JjRepo against a real repository", () => {
  it.effect("resolves the colocated git store from a workspace jj created", () =>
    withTempDir(({ fileSystem, path, root }) =>
      Effect.gen(function* () {
        const main = path.join(root, "work");
        yield* fileSystem.makeDirectory(main, { recursive: true });
        yield* createJjRepo(main);
        yield* fileSystem.writeFileString(path.join(main, "a.txt"), "a\n");
        yield* runJj(main, ["commit", "-m", "first"]);
        const secondary = path.join(root, "ws", "thread");
        yield* fileSystem.makeDirectory(path.dirname(secondary), { recursive: true });
        yield* runJj(main, ["workspace", "add", "--name", "t3-thread", secondary]);

        const marker = yield* findVcsMarkerRoot(fileSystem, path, secondary);
        assert.equal(marker?.marker, "jj");

        const paths = yield* resolveJjRepoPaths(fileSystem, path, secondary);
        assert.equal(paths.mainWorkspaceRoot, main);
        assert.equal(paths.gitDir, path.join(main, ".git"));
        assert.equal(paths.isSecondaryWorkspace, true);
      }),
    ),
  );
});
