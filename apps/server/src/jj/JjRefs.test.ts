import { assert, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import { describeJj, runGit, runJj, withJjRepo } from "../vcs/testing/JjTestSupport.ts";
import { makeJjRefs, type JjRefsOps } from "./JjRefs.ts";
import { makeJjRemotes } from "./JjRemotes.ts";
import { makeJjWorkspaces, workspaceNameForRef, type JjWorkspaceOps } from "./JjWorkspaces.ts";

interface RefsFixture {
  readonly driver: JjVcsDriver.JjVcsDriverShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly refs: JjRefsOps;
  readonly workspaces: JjWorkspaceOps;
  readonly root: string;
}

const withRepo = <A, E>(
  input: { readonly withRemote?: boolean },
  use: (fixture: RefsFixture) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  withJjRepo({ prefix: "t3-jj-refs-", seed: true, ...input }, (repo) =>
    Effect.gen(function* () {
      const { base, driver, fileSystem, path, process, root } = repo;
      const remotes = makeJjRemotes({ driver, process });
      const refs = yield* makeJjRefs({ driver, process });
      const workspaces = makeJjWorkspaces({
        driver,
        process,
        fileSystem,
        path,
        worktreesDir: path.join(base, "worktrees"),
        bookmarkTo: remotes.bookmarkTo,
      });

      return yield* use({ driver, fileSystem, path, refs, workspaces, root });
    }),
  );

describeJj("JjRefs.hasRefNamed", () => {
  it.effect("invalidates once after each bookmark mutation", () =>
    withJjRepo({ prefix: "t3-jj-invalidate-once-", seed: true }, (repo) =>
      Effect.gen(function* () {
        let invalidations = 0;
        const refs = yield* makeJjRefs({
          driver: {
            ...repo.driver,
            invalidateRepoCaches: (cwd) =>
              Effect.sync(() => {
                invalidations += 1;
              }).pipe(Effect.andThen(repo.driver.invalidateRepoCaches(cwd))),
          },
          process: repo.process,
        });
        yield* refs.createRef({ cwd: repo.root, refName: "topic" });
        assert.equal(invalidations, 1);
        yield* refs.switchRef({ cwd: repo.root, refName: "main" });
        assert.equal(invalidations, 2);
        yield* refs.renameBranch({ cwd: repo.root, oldBranch: "topic", newBranch: "renamed" });
        assert.equal(invalidations, 3);
        yield* refs.deleteLocalBranch({ cwd: repo.root, refName: "renamed" });
        assert.equal(invalidations, 4);
      }),
    ),
  );
  it.effect("matches exact local and remote names without evaluating revisions", () =>
    withRepo({ withRemote: true }, ({ refs, root }) =>
      Effect.gen(function* () {
        assert.isTrue(yield* refs.hasRefNamed({ cwd: root, refName: "main" }));
        assert.isTrue(yield* refs.hasRefNamed({ cwd: root, refName: "origin/main" }));
        assert.isFalse(yield* refs.hasRefNamed({ cwd: root, refName: "mai" }));
        assert.isFalse(yield* refs.hasRefNamed({ cwd: root, refName: "main~1" }));
        assert.isFalse(yield* refs.hasRefNamed({ cwd: root, refName: "all()" }));
        assert.isFalse(yield* refs.hasRefNamed({ cwd: root, refName: "*" }));
      }),
    ),
  );
});

describeJj("JjRefs.resolveRefName", () => {
  it.effect("normalizes exact local and remote refs to host bookmark names", () =>
    withRepo({ withRemote: true }, ({ refs, root }) =>
      Effect.gen(function* () {
        assert.equal(yield* refs.resolveRefName(root, "main"), "main");
        assert.equal(yield* refs.resolveRefName(root, "origin/main"), "main");
        assert.equal(yield* refs.resolveRefName(root, "refs/heads/main"), "main");
        assert.equal(yield* refs.resolveRefName(root, "refs/remotes/origin/main"), "main");
        assert.isNull(yield* refs.resolveRefName(root, "main~1"));
        assert.isNull(yield* refs.resolveRefName(root, "all()"));
        assert.isNull(yield* refs.resolveRefName(root, "refs/heads/missing"));
        assert.isNull(yield* refs.resolveRefName(root, "refs/tags/main"));
      }),
    ),
  );
});

describeJj("JjRefs.listRefs", () => {
  it.effect("reports physical workspace roots, not subdirectories or the main workspace", () =>
    withJjRepo({ prefix: "t3-jj-refs-roots-", seed: true }, (repo) =>
      Effect.gen(function* () {
        const refs = yield* makeJjRefs({ driver: repo.driver, process: repo.process });
        const child = repo.path.join(repo.base, "child");
        yield* runJj(repo.root, ["workspace", "add", "--name", "child", child]);
        const nested = repo.path.join(child, "nested");
        yield* repo.fileSystem.makeDirectory(nested);

        assert.isTrue((yield* refs.listRefs({ cwd: repo.root })).isAtRepositoryRoot);
        assert.isTrue((yield* refs.listRefs({ cwd: child })).isAtRepositoryRoot);
        assert.isFalse((yield* refs.listRefs({ cwd: nested })).isAtRepositoryRoot);
      }),
    ),
  );

  it.effect.skipIf(!symlinksSupported)("recognizes symlink aliases of the workspace root", () =>
    withJjRepo({ prefix: "t3-jj-refs-alias-", seed: true }, (repo) =>
      Effect.gen(function* () {
        const refs = yield* makeJjRefs({ driver: repo.driver, process: repo.process });
        const alias = repo.path.join(repo.base, "alias");
        yield* repo.fileSystem.symlink(repo.root, alias);
        assert.isTrue((yield* refs.listRefs({ cwd: alias })).isAtRepositoryRoot);
      }),
    ),
  );

  it.effect("omits root metadata when the physical cwd cannot be resolved", () =>
    withJjRepo({ prefix: "t3-jj-refs-root-error-", seed: true }, (repo) =>
      Effect.gen(function* () {
        const refs = yield* makeJjRefs({ driver: repo.driver, process: repo.process }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...repo.fileSystem,
            realPath: () => repo.fileSystem.realPath(repo.path.join(repo.base, "missing")),
          }),
        );
        const listed = yield* refs.listRefs({ cwd: repo.root });
        assert.isTrue(listed.isRepo);
        assert.isFalse(Object.hasOwn(listed, "isAtRepositoryRoot"));
      }),
    ),
  );

  it.effect("observes external workspace add and remove without waiting for cache expiry", () =>
    withJjRepo({ prefix: "t3-jj-refs-operations-", seed: true }, (repo) =>
      Effect.gen(function* () {
        const refs = yield* makeJjRefs({ driver: repo.driver, process: repo.process });
        yield* runJj(repo.root, ["bookmark", "create", "feature", "-r", "main"]);
        yield* refs.listRefs({ cwd: repo.root });
        const child = repo.path.join(repo.base, "child");
        const name = workspaceNameForRef("feature");
        yield* runJj(repo.root, [
          "workspace",
          "add",
          "--colocate",
          "--name",
          name,
          "-r",
          "feature",
          child,
        ]);
        assert.equal(
          (yield* refs.listRefs({ cwd: repo.root })).refs.find((ref) => ref.name === "feature")
            ?.worktreePath,
          child,
        );
        yield* runJj(repo.root, ["workspace", "remove", name]);
        assert.isNull(
          (yield* refs.listRefs({ cwd: repo.root })).refs.find((ref) => ref.name === "feature")
            ?.worktreePath,
        );
      }),
    ),
  );

  it.effect("observes T3 workspace create and remove immediately", () =>
    withRepo({}, ({ refs, root, workspaces }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["bookmark", "create", "feature", "-r", "main"]);
        yield* refs.listRefs({ cwd: root });
        const created = yield* workspaces.createWorktree({
          cwd: root,
          refName: "feature",
          path: null,
        });
        assert.equal(
          (yield* refs.listRefs({ cwd: root })).refs.find((ref) => ref.name === "feature")
            ?.worktreePath,
          created.worktree.path,
        );
        yield* workspaces.removeWorktree({ cwd: root, path: created.worktree.path });
        assert.isNull(
          (yield* refs.listRefs({ cwd: root })).refs.find((ref) => ref.name === "feature")
            ?.worktreePath,
        );
      }),
    ),
  );

  it.effect("surfaces segment failures instead of presenting cached refs as valid", () =>
    withRepo({}, ({ refs, root, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* refs.listRefs({ cwd: root });
        yield* fileSystem.writeFileString(
          path.join(root, ".jj", "repo", "config.toml"),
          "[broken\n",
        );
        const error = yield* refs.listRefs({ cwd: root }).pipe(Effect.flip);
        assert.equal(error._tag, "GitCommandError");
      }),
    ),
  );

  it.effect("drops the colocated pseudo-remote and names remote rows like Git does", () =>
    withRepo({ withRemote: true }, ({ refs, root }) =>
      Effect.gen(function* () {
        const listed = yield* refs.listRefs({
          cwd: root,
          refresh: true,
          includeMatchingRemoteRefs: true,
        });

        assert.isFalse(listed.refs.some((ref) => ref.name.startsWith("git/")));
        const remoteRow = listed.refs.find((ref) => ref.isRemote === true);
        assert.equal(remoteRow?.name, "origin/main");
        assert.equal(remoteRow?.remoteName, "origin");
      }),
    ),
  );

  it.effect("reports the segment bookmark as current and the trunk bookmark as default", () =>
    withRepo({ withRemote: true }, ({ refs, root }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["new", 'bookmarks(exact:"main")']);
        const listed = yield* refs.listRefs({ cwd: root, refresh: true });
        const main = listed.refs.find((ref) => ref.name === "main");

        assert.equal(main?.current, true);
        assert.equal(main?.isDefault, true);
      }),
    ),
  );

  it.effect("resolves a bookmark's workspace and never reports the main workspace root", () =>
    withRepo({}, ({ refs, root, workspaces }) =>
      Effect.gen(function* () {
        const created = yield* workspaces.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/threaded",
          path: null,
        });
        const listed = yield* refs.listRefs({ cwd: root, refresh: true });

        assert.equal(
          listed.refs.find((ref) => ref.name === "feat/threaded")?.worktreePath,
          created.worktree.path,
        );
        assert.equal(listed.refs.find((ref) => ref.name === "main")?.worktreePath, null);
      }),
    ),
  );

  it.effect("filters, orders and pages the way the Git implementation does", () =>
    withRepo({}, ({ refs, root }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["bookmark", "create", "feat/alpha", "-r", "@-"]);
        yield* runJj(root, ["bookmark", "create", "feat/beta", "-r", "@-"]);

        const filtered = yield* refs.listRefs({ cwd: root, query: "FEAT/", refresh: true });
        assert.deepStrictEqual(filtered.refs.map((ref) => ref.name).toSorted(), [
          "feat/alpha",
          "feat/beta",
        ]);

        const firstPage = yield* refs.listRefs({ cwd: root, limit: 1, refKind: "local" });
        assert.equal(firstPage.refs.length, 1);
        assert.equal(firstPage.totalCount, 3);
        assert.equal(firstPage.nextCursor, 1);
      }),
    ),
  );
});

describeJj("JjRefs.createRef", () => {
  it.effect("creates and renames punctuation-bearing bookmark names literally", () =>
    withRepo({}, ({ refs, root }) =>
      Effect.gen(function* () {
        yield* refs.createRef({ cwd: root, refName: "fix(ui)" });
        const renamed = yield* refs.renameBranch({
          cwd: root,
          oldBranch: "fix(ui)",
          newBranch: "fix(ui)+",
          exactName: true,
        });
        assert.equal(renamed.branch, "fix(ui)+");
        assert.include(yield* refs.listLocalBranchNames(root), "fix(ui)+");
      }),
    ),
  );

  it.effect("bookmarks `@` when it holds the work", () =>
    withRepo({}, ({ driver, fileSystem, path, refs, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "editing.txt"), "editing\n");

        yield* refs.createRef({ cwd: root, refName: "feat/editing" });

        const change = yield* driver.currentChange(root);
        assert.include(change.localBookmarks, "feat/editing");
      }),
    ),
  );

  it.effect("bookmarks `@-` when `@` is empty, so the agent's commits are captured", () =>
    withRepo({}, ({ driver, fileSystem, path, refs, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "agent.txt"), "agent\n");
        yield* runJj(root, ["commit", "-m", "agent work"]);

        yield* refs.createRef({ cwd: root, refName: "feat/captured" });

        const change = yield* driver.currentChange(root);
        assert.deepStrictEqual([...change.localBookmarks], []);
        const parent = yield* driver.changeAt(root, "@-");
        assert.include(parent?.localBookmarks ?? [], "feat/captured");
      }),
    ),
  );

  it.effect("bookmarks `@` in a repository with no commits", () =>
    withJjRepo({ prefix: "t3-jj-refs-empty-" }, ({ driver, process, root }) =>
      Effect.gen(function* () {
        const refs = yield* makeJjRefs({ driver, process });

        yield* refs.createRef({ cwd: root, refName: "main" });

        const change = yield* driver.currentChange(root);
        assert.include(change.localBookmarks, "main");
      }),
    ),
  );
});

describeJj("JjRefs.switchRef", () => {
  it.effect("refuses to strand a commit the agent left on no bookmark", () =>
    withRepo({}, ({ fileSystem, path, refs, root }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["new", 'bookmarks(exact:"main")']);
        yield* fileSystem.writeFileString(path.join(root, "agent.txt"), "agent\n");
        yield* runJj(root, ["commit", "-m", "agent work"]);

        const failure = yield* refs.switchRef({ cwd: root, refName: "main" }).pipe(Effect.flip);

        assert.include(failure.detail, "not on a bookmark yet");
        assert.include(failure.detail, "Create a bookmark for it");
      }),
    ),
  );

  it.effect("tracks a remote ref before switching and records the Git upstream", () =>
    withRepo({ withRemote: true }, ({ fileSystem, refs, root }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["bookmark", "create", "feat/remote", "-r", "@-"]);
        yield* runJj(root, ["git", "push", "--bookmark", "feat/remote", "--remote", "origin"]);
        yield* runJj(root, ["bookmark", "forget", "feat/remote"]);
        yield* runJj(root, ["git", "fetch", "--remote", "origin"]);

        const switched = yield* refs.switchRef({ cwd: root, refName: "origin/feat/remote" });

        assert.equal(switched.refName, "feat/remote");
        const gitConfig = yield* fileSystem.readFileString(`${root}/.git/config`);
        assert.include(gitConfig, 'branch "feat/remote"');
        assert.include(gitConfig, "refs/heads/feat/remote");
      }),
    ),
  );
});

describeJj("JjRefs.renameBranch", () => {
  it.effect("returns unchanged names without trying to rename the bookmark", () =>
    withRepo({}, ({ refs, root }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* refs.renameBranch({ cwd: root, oldBranch: "main", newBranch: "main" }),
          { branch: "main" },
        );
      }),
    ),
  );

  it.effect("moves the remote comparison base and removes the temporary bookmark's config", () =>
    withRepo({ withRemote: true }, ({ refs, root, workspaces }) =>
      Effect.gen(function* () {
        const created = yield* workspaces.createWorktree({
          cwd: root,
          refName: "origin/main",
          newRefName: "t3code/temporary",
          baseRefName: "refs/remotes/origin/main",
          path: null,
        });
        yield* refs.renameBranch({
          cwd: created.worktree.path,
          oldBranch: "t3code/temporary",
          newBranch: "topic",
        });
        for (const [key, value] of [
          ["remote", "origin"],
          ["merge", "refs/heads/topic"],
          ["gh-merge-base", "main"],
          ["t3-merge-base-ref", "refs/remotes/origin/main"],
        ]) {
          assert.equal((yield* runGit(root, ["config", "--get", `branch.topic.${key}`])).trim(), value);
        }
        const config = yield* runGit(root, ["config", "--list"]);
        assert.notInclude(config, "branch.t3code/temporary.");
      }),
    ),
  );

  it.effect("suffixes generated names instead of replacing existing bookmarks", () =>
    withRepo({}, ({ refs, root }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["bookmark", "create", "feat/target", "feat/target-1", "-r", "@-"]);
        const renamed = yield* refs.renameBranch({
          cwd: root,
          oldBranch: "main",
          newBranch: "feat/target",
        });
        assert.equal(renamed.branch, "feat/target-2");
        assert.includeMembers(yield* refs.listLocalBranchNames(root), [
          "feat/target",
          "feat/target-1",
          "feat/target-2",
        ]);
      }),
    ),
  );

  it.effect("rejects collisions when the caller requires an exact name", () =>
    withRepo({}, ({ refs, root }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["bookmark", "create", "feat/target", "-r", "@-"]);
        const failure = yield* refs
          .renameBranch({
            cwd: root,
            oldBranch: "main",
            newBranch: "feat/target",
            exactName: true,
          })
          .pipe(Effect.flip);
        assert.include(failure.detail, "Could not rename bookmark");
        assert.includeMembers(yield* refs.listLocalBranchNames(root), ["main", "feat/target"]);
      }),
    ),
  );

  it.effect("renames the bookmark and the workspace that carries it", () =>
    withRepo({}, ({ driver, refs, root, workspaces }) =>
      Effect.gen(function* () {
        const created = yield* workspaces.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/old",
          path: null,
        });

        const renamed = yield* refs.renameBranch({
          cwd: created.worktree.path,
          oldBranch: "feat/old",
          newBranch: "feat/new",
        });

        assert.equal(renamed.branch, "feat/new");
        assert.include(yield* runJj(root, ["bookmark", "list"]), "feat/new");

        // The bookmark-to-workspace mapping `listRefs` reports is keyed on the new name.
        const workspaceNames = (yield* driver.listWorkspaces(root)).map(
          (workspace) => workspace.name,
        );
        assert.include(workspaceNames, workspaceNameForRef("feat/new"));
        assert.notInclude(workspaceNames, workspaceNameForRef("feat/old"));
      }),
    ),
  );

  it.effect("leaves every workspace alone when the rename runs from the project root", () =>
    withRepo({}, ({ driver, refs, root, workspaces }) =>
      Effect.gen(function* () {
        yield* workspaces.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/elsewhere",
          path: null,
        });

        yield* refs.renameBranch({
          cwd: root,
          oldBranch: "feat/elsewhere",
          newBranch: "feat/renamed",
        });

        // `jj workspace rename` renames whichever workspace `cwd` belongs to, so running it here
        // would rename `default` and leave the thread's own workspace on the stale name.
        const workspaceNames = (yield* driver.listWorkspaces(root)).map(
          (workspace) => workspace.name,
        );
        assert.include(workspaceNames, "default");
        assert.include(workspaceNames, workspaceNameForRef("feat/elsewhere"));
        assert.notInclude(workspaceNames, workspaceNameForRef("feat/renamed"));
      }),
    ),
  );
});
