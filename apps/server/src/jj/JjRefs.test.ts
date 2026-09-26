import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import { describeJj, runJj, withJjRepo } from "../vcs/testing/JjTestSupport.ts";
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

describeJj("JjRefs.listRefs", () => {
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
