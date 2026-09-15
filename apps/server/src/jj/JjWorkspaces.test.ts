import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import { describeJj, runJj, withJjRepo } from "../vcs/testing/JjTestSupport.ts";
import { makeJjRefs, type JjRefsOps } from "./JjRefs.ts";
import { makeJjRemotes } from "./JjRemotes.ts";
import {
  defaultWorkspacePathForRef,
  isT3WorkspaceName,
  makeJjWorkspaces,
  workspaceNameForRef,
  type JjWorkspaceOps,
} from "./JjWorkspaces.ts";

interface WorkspacesFixture {
  readonly driver: JjVcsDriver.JjVcsDriverShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly ops: JjWorkspaceOps;
  readonly refs: JjRefsOps;
  readonly root: string;
  readonly worktreesDir: string;
}

const withRepo = <A, E>(
  use: (fixture: WorkspacesFixture) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  options?: { readonly withRemote?: boolean },
) =>
  withJjRepo({ prefix: "t3-jj-workspaces-", seed: true, ...options }, (repo) =>
    Effect.gen(function* () {
      const { base, driver, fileSystem, path, process, root } = repo;
      const worktreesDir = path.join(base, "worktrees");
      yield* fileSystem.makeDirectory(worktreesDir, { recursive: true });

      const remotes = makeJjRemotes({ driver, process });
      const refs = yield* makeJjRefs({ driver, process });
      const ops = makeJjWorkspaces({
        driver,
        process,
        fileSystem,
        path,
        worktreesDir,
        bookmarkTo: remotes.bookmarkTo,
      });

      return yield* use({ driver, fileSystem, path, ops, refs, root, worktreesDir });
    }),
  );

describeJj("workspace naming", () => {
  it("keeps bookmarks whose sanitised names collide apart", () => {
    assert.notEqual(workspaceNameForRef("a/b"), workspaceNameForRef("a-b"));
    assert.isTrue(isT3WorkspaceName(workspaceNameForRef("a/b")));
  });

  it("never claims the default workspace", () => {
    assert.isFalse(isT3WorkspaceName("default"));
  });

  it("lays the workspace out under the worktrees directory", () => {
    assert.equal(
      defaultWorkspacePathForRef({
        worktreesDir: "/state/worktrees",
        mainWorkspaceRoot: "/code/project",
        refName: "feat/x",
      }),
      "/state/worktrees/project/feat-x",
    );
  });
});

describeJj("JjWorkspaces.createWorktree", () => {
  it.effect("mints the bookmark and lands under the worktrees directory", () =>
    withRepo(({ ops, root, worktreesDir }) =>
      Effect.gen(function* () {
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/one",
          path: null,
        });

        assert.equal(created.worktree.refName, "feat/one");
        assert.isTrue(created.worktree.path.startsWith(worktreesDir));
        const bookmarks = yield* runJj(root, ["bookmark", "list"]);
        assert.include(bookmarks, "feat/one");
      }),
    ),
  );

  it.effect("is idempotent for the same bookmark", () =>
    withRepo(({ ops, root }) =>
      Effect.gen(function* () {
        const first = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/two",
          path: null,
        });
        const second = yield* ops.createWorktree({ cwd: root, refName: "feat/two", path: null });

        assert.equal(second.worktree.path, first.worktree.path);
      }),
    ),
  );

  it.effect("gives two colliding bookmark names two workspaces", () =>
    withRepo(({ ops, root }) =>
      Effect.gen(function* () {
        const slashed = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "a/b",
          path: null,
        });
        const dashed = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "a-b",
          path: null,
        });

        assert.notEqual(slashed.worktree.path, dashed.worktree.path);
      }),
    ),
  );

  it.effect("records the pull-request base in the colocated Git config", () =>
    withRepo(({ ops, root }) =>
      Effect.gen(function* () {
        yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/base",
          baseRefName: "main",
          path: null,
        });

        const gitConfig = yield* FileSystem.FileSystem.pipe(
          Effect.flatMap((fileSystem) => fileSystem.readFileString(`${root}/.git/config`)),
        );
        assert.include(gitConfig, "gh-merge-base");
        assert.include(gitConfig, "feat/base");
      }),
    ),
  );

  it.effect("records the thread bookmark's upstream when the base came from a remote", () =>
    withRepo(
      ({ ops, root }) =>
        Effect.gen(function* () {
          yield* ops.createWorktree({
            cwd: root,
            refName: "origin/main",
            newRefName: "feat/forked",
            baseRefName: "origin/main",
            path: null,
          });

          // Without these the hosting side reads no upstream for the thread's bookmark and never
          // probes owner-qualified pull-request heads, which is how fork PRs go missing.
          const gitConfig = yield* FileSystem.FileSystem.pipe(
            Effect.flatMap((fileSystem) => fileSystem.readFileString(`${root}/.git/config`)),
          );
          assert.include(gitConfig, '[branch "feat/forked"]');
          assert.include(gitConfig, "remote = origin");
          assert.include(gitConfig, "merge = refs/heads/feat/forked");
        }),
      { withRemote: true },
    ),
  );

  it.effect("re-creates a registered workspace whose directory is gone", () =>
    withRepo(({ fileSystem, ops, root }) =>
      Effect.gen(function* () {
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/healed",
          path: null,
        });
        yield* fileSystem.remove(created.worktree.path, { recursive: true });

        const healed = yield* ops.createWorktree({
          cwd: root,
          refName: "feat/healed",
          path: null,
        });

        assert.equal(healed.worktree.path, created.worktree.path);
        assert.isTrue(yield* fileSystem.exists(`${healed.worktree.path}/.jj`));
      }),
    ),
  );

  it.effect("leaves no registered workspace behind when `jj workspace add` fails", () =>
    withRepo(({ driver, fileSystem, ops, root, path }) =>
      Effect.gen(function* () {
        const destination = path.join(root, "..", "blocked");
        // A file where jj wants to create the leaf directory: jj registers the workspace and then
        // fails, which is exactly the half-created state the cleanup exists for.
        yield* fileSystem.writeFileString(destination, "not a directory\n");

        const failure = yield* ops
          .createWorktree({
            cwd: root,
            refName: "main",
            newRefName: "feat/blocked",
            path: destination,
          })
          .pipe(Effect.flip);
        assert.equal(failure._tag, "GitCommandError");

        const workspaces = yield* driver.listWorkspaces(root);
        assert.isUndefined(
          workspaces.find((workspace) => workspace.name === workspaceNameForRef("feat/blocked")),
        );

        yield* fileSystem.remove(destination);
        const retried = yield* ops.createWorktree({
          cwd: root,
          refName: "feat/blocked",
          path: destination,
        });
        assert.equal(retried.worktree.refName, "feat/blocked");
      }),
    ),
  );
});

describeJj("JjWorkspaces.removeWorktree", () => {
  it.effect("refuses a path that is not a registered workspace and leaves it on disk", () =>
    withRepo(({ fileSystem, ops, path, root }) =>
      Effect.gen(function* () {
        const stranger = path.join(root, "..", "not-a-workspace");
        yield* fileSystem.makeDirectory(stranger, { recursive: true });
        yield* fileSystem.writeFileString(path.join(stranger, "keep.txt"), "keep\n");

        const failure = yield* ops
          .removeWorktree({ cwd: root, path: stranger, force: true })
          .pipe(Effect.flip);

        assert.include(failure.detail, "No Jujutsu workspace is registered at");
        assert.isTrue(yield* fileSystem.exists(path.join(stranger, "keep.txt")));
      }),
    ),
  );

  it.effect("refuses the main workspace and leaves the project untouched", () =>
    withRepo(({ fileSystem, ops, root }) =>
      Effect.gen(function* () {
        const failure = yield* ops
          .removeWorktree({ cwd: root, path: root, force: true })
          .pipe(Effect.flip);

        assert.include(failure.detail, "is the main Jujutsu workspace and cannot be removed");
        assert.isTrue(yield* fileSystem.exists(`${root}/.jj`));
        assert.isTrue(yield* fileSystem.exists(`${root}/.git`));
      }),
    ),
  );

  it.effect("refuses work the agent wrote with no jj command since", () =>
    withRepo(({ fileSystem, ops, path, root }) =>
      Effect.gen(function* () {
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/dirty",
          path: null,
        });
        const agentFile = path.join(created.worktree.path, "agent.txt");
        yield* fileSystem.writeFileString(agentFile, "unsnapshotted\n");

        const failure = yield* ops
          .removeWorktree({ cwd: root, path: created.worktree.path })
          .pipe(Effect.flip);

        assert.include(failure.detail, "uncommitted or unbookmarked changes");
        assert.isTrue(yield* fileSystem.exists(agentFile));
      }),
    ),
  );

  it.effect("refuses after the agent committed, and force keeps that work on the bookmark", () =>
    withRepo(({ fileSystem, ops, refs, root }) =>
      Effect.gen(function* () {
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/committed",
          path: null,
        });
        yield* fileSystem.writeFileString(`${created.worktree.path}/agent.txt`, "work\n");
        yield* runJj(created.worktree.path, ["commit", "-m", "agent work"]);

        const failure = yield* ops
          .removeWorktree({ cwd: root, path: created.worktree.path })
          .pipe(Effect.flip);
        assert.include(failure.detail, "uncommitted or unbookmarked changes");

        yield* ops.removeWorktree({ cwd: root, path: created.worktree.path, force: true });

        assert.isFalse(yield* fileSystem.exists(created.worktree.path));
        const listed = yield* refs.listRefs({ cwd: root, refresh: true });
        const bookmark = listed.refs.find((ref) => ref.name === "feat/committed");
        assert.isDefined(bookmark);
        const described = yield* runJj(root, [
          "log",
          "-r",
          'bookmarks(exact:"feat/committed")',
          "--no-graph",
          "-T",
          "description",
        ]);
        assert.include(described, "agent work");
      }),
    ),
  );

  it.effect("forgets and deletes a clean workspace with force", () =>
    withRepo(({ driver, fileSystem, ops, root }) =>
      Effect.gen(function* () {
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/clean",
          path: null,
        });

        yield* ops.removeWorktree({ cwd: root, path: created.worktree.path, force: true });

        assert.isFalse(yield* fileSystem.exists(created.worktree.path));
        const workspaces = yield* driver.listWorkspaces(root);
        assert.isUndefined(
          workspaces.find((workspace) => workspace.name === workspaceNameForRef("feat/clean")),
        );
      }),
    ),
  );
});

describeJj("JjWorkspaces.pruneWorktrees", () => {
  it.effect("reclaims a T3 workspace whose directory is gone and keeps the user's own", () =>
    withRepo(({ driver, fileSystem, ops, path, root }) =>
      Effect.gen(function* () {
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/pruned",
          path: null,
        });
        const userWorkspace = path.join(root, "..", "mine");
        yield* runJj(root, ["workspace", "add", "--name", "mine", userWorkspace]);

        yield* fileSystem.remove(created.worktree.path, { recursive: true });
        yield* fileSystem.remove(userWorkspace, { recursive: true });

        yield* ops.pruneWorktrees({ cwd: root });

        const workspaces = yield* driver.listWorkspaces(root);
        assert.isUndefined(
          workspaces.find((workspace) => workspace.name === workspaceNameForRef("feat/pruned")),
        );
        assert.isDefined(workspaces.find((workspace) => workspace.name === "mine"));
      }),
    ),
  );
});
