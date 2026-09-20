import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import { describeJj, runJj, withJjRepo } from "../vcs/testing/JjTestSupport.ts";
import { makeJjRemotes, type JjRemoteOps } from "./JjRemotes.ts";

interface RemotesFixture {
  readonly driver: JjVcsDriver.JjVcsDriverShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly remotes: JjRemoteOps;
  readonly root: string;
  /** A second checkout of the same remote, for moving it behind the first one's back. */
  readonly peer: string;
}

const withRemote = <A, E>(
  use: (fixture: RemotesFixture) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  withJjRepo({ prefix: "t3-jj-remotes-", withRemote: true }, (repo) =>
    Effect.gen(function* () {
      const { base, driver, fileSystem, path, process, remotePath, root } = repo;
      const peer = path.join(base, "peer");
      yield* fileSystem.makeDirectory(peer, { recursive: true });
      yield* runJj(peer, ["git", "clone", "--colocate", remotePath, peer]);

      const remotes = makeJjRemotes({ driver, process });

      return yield* use({ driver, fileSystem, path, remotes, root, peer });
    }),
  );

describeJj("JjRemotes.bookmarkTo", () => {
  it.effect("moves forward, no-ops when already there, and refuses a sideways move", () =>
    withRemote(({ driver, fileSystem, path, remotes, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "one.txt"), "one\n");
        yield* runJj(root, ["commit", "-m", "one"]);

        yield* remotes.bookmarkTo({
          cwd: root,
          name: "main",
          revset: "@-",
          operation: "test",
        });
        const moved = yield* driver.changeAt(root, 'bookmarks(exact:"main")');
        const parent = yield* driver.changeAt(root, "@-");
        assert.equal(moved?.commitId, parent?.commitId);

        // Idempotent: a re-run of the same move changes nothing and does not fail.
        yield* remotes.bookmarkTo({
          cwd: root,
          name: "main",
          revset: "@-",
          operation: "test",
        });

        // A sibling is not an ancestor, so the guard refuses instead of letting jj refuse rawly.
        yield* runJj(root, ["new", 'bookmarks(exact:"main")-', "-m", "sibling"]);
        const failure = yield* remotes
          .bookmarkTo({ cwd: root, name: "main", revset: "@", operation: "test" })
          .pipe(Effect.flip);
        assert.include(failure.detail, "not an ancestor of this one");
      }),
    ),
  );
});

describeJj("JjRemotes.pushBookmark", () => {
  it.effect("pushes, then reports the second push as up to date", () =>
    withRemote(({ fileSystem, path, remotes, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "one.txt"), "one\n");
        yield* runJj(root, ["commit", "-m", "one"]);

        const first = yield* remotes.pushBookmark({
          cwd: root,
          name: "main",
          remoteName: "origin",
          operation: "test",
        });
        assert.equal(first.status, "pushed");

        const second = yield* remotes.pushBookmark({
          cwd: root,
          name: "main",
          remoteName: "origin",
          operation: "test",
        });
        assert.equal(second.status, "skipped_up_to_date");
      }),
    ),
  );

  it.effect("refuses a bookmark that points at the working copy", () =>
    withRemote(({ fileSystem, path, remotes, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "editing.txt"), "editing\n");
        yield* runJj(root, ["bookmark", "create", "feat/editing", "-r", "@"]);

        const failure = yield* remotes
          .pushBookmark({
            cwd: root,
            name: "feat/editing",
            remoteName: "origin",
            operation: "test",
          })
          .pipe(Effect.flip);

        assert.include(failure.detail, "points at your working copy");
      }),
    ),
  );

  it.effect("asks for a description instead of publishing an undescribed change", () =>
    withRemote(({ fileSystem, path, remotes, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "one.txt"), "one\n");
        yield* runJj(root, ["new"]);
        yield* runJj(root, ["bookmark", "create", "feat/undescribed", "-r", "@-"]);

        const failure = yield* remotes
          .pushBookmark({
            cwd: root,
            name: "feat/undescribed",
            remoteName: "origin",
            operation: "test",
          })
          .pipe(Effect.flip);

        assert.include(failure.detail, "Describe this change before pushing.");
      }),
    ),
  );
});

describeJj("JjRemotes.pullCurrentBranch", () => {
  it.effect("reports an up-to-date bookmark without touching the working copy", () =>
    withRemote(({ remotes, root }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["new", 'bookmarks(exact:"main")']);
        const pulled = yield* remotes.pullCurrentBranch(root);

        assert.equal(pulled.status, "skipped_up_to_date");
        assert.equal(pulled.refName, "main");
      }),
    ),
  );

  it.effect("fast-forwards onto the remote bookmark", () =>
    withRemote(({ driver, fileSystem, path, peer, remotes, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(peer, "peer.txt"), "peer\n");
        yield* runJj(peer, ["commit", "-m", "peer work"]);
        yield* runJj(peer, ["bookmark", "set", "main", "-r", "@-"]);
        yield* runJj(peer, ["git", "push", "--bookmark", "main", "--remote", "origin"]);

        yield* runJj(root, ["new", 'bookmarks(exact:"main")']);
        const pulled = yield* remotes.pullCurrentBranch(root);

        assert.equal(pulled.status, "pulled");
        assert.equal(pulled.upstreamRef, "origin/main");
        assert.isTrue(yield* fileSystem.exists(path.join(root, "peer.txt")));
        const parent = yield* driver.changeAt(root, "@-");
        assert.include(parent?.localBookmarks ?? [], "main");
      }),
    ),
  );

  it.effect("names the rebase instead of pulling over local work", () =>
    withRemote(({ fileSystem, path, peer, remotes, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(peer, "peer.txt"), "peer\n");
        yield* runJj(peer, ["commit", "-m", "peer work"]);
        yield* runJj(peer, ["bookmark", "set", "main", "-r", "@-"]);
        yield* runJj(peer, ["git", "push", "--bookmark", "main", "--remote", "origin"]);

        yield* runJj(root, ["new", 'bookmarks(exact:"main")']);
        yield* fileSystem.writeFileString(path.join(root, "local.txt"), "local\n");
        yield* runJj(root, ["commit", "-m", "local work"]);
        yield* runJj(root, ["bookmark", "set", "main", "-r", "@-"]);

        const failure = yield* remotes.pullCurrentBranch(root).pipe(Effect.flip);

        assert.include(failure.detail, "has local changes");
        assert.include(failure.detail, "Rebase onto origin/main");
      }),
    ),
  );
});
