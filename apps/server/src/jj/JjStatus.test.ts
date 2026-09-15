import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as GitManager from "../git/GitManager.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import {
  describeJj,
  runGit,
  runJj,
  seedJjRepo,
  stubSourceControlProviders,
  withJjRepo,
} from "../vcs/testing/JjTestSupport.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { makeJjStatus, refNameFromSegment, type JjStatusOps } from "./JjStatus.ts";

/** Counts the `jj` spawns the driver itself makes, which is what the status budget is about. */
const countingDriverLayer = (counter: { count: number }) =>
  JjVcsDriver.layer.pipe(
    Layer.provideMerge(
      Layer.effect(
        VcsProcess.VcsProcess,
        Effect.map(VcsProcess.make, (real) => ({
          run: (input: VcsProcess.VcsProcessInput) => {
            if (input.command === "jj") {
              counter.count += 1;
            }
            return real.run(input);
          },
        })),
      ).pipe(Layer.provide(ProcessRunner.layer)),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const stubGitManager = (
  branchPullRequest: GitManager.GitManager["Service"]["branchPullRequest"] = () =>
    Effect.succeed(null),
) =>
  GitManager.GitManager.pipe(
    Effect.provide(Layer.mock(GitManager.GitManager)({ branchPullRequest })),
  );

const makeStatus = (
  driver: JjVcsDriver.JjVcsDriverShape,
  process: VcsProcess.VcsProcess["Service"],
  branchPullRequest?: GitManager.GitManager["Service"]["branchPullRequest"],
) =>
  Effect.gen(function* () {
    return yield* makeJjStatus({
      driver,
      process,
      gitManager: yield* stubGitManager(branchPullRequest),
      sourceControlProviders: yield* stubSourceControlProviders,
    });
  });

interface StatusFixture {
  readonly driver: JjVcsDriver.JjVcsDriverShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly status: JjStatusOps;
  readonly root: string;
  readonly remotePath: string;
}

const withRepo = <A, E>(
  input: {
    readonly withRemote?: boolean;
    readonly colocated?: boolean;
    readonly branchPullRequest?: GitManager.GitManager["Service"]["branchPullRequest"];
  },
  use: (fixture: StatusFixture) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  withJjRepo({ prefix: "t3-jj-status-", seed: true, ...input }, (repo) =>
    Effect.gen(function* () {
      const { driver, fileSystem, path, process, remotePath, root } = repo;
      const status = yield* makeStatus(driver, process, input.branchPullRequest);

      return yield* use({ driver, fileSystem, path, status, root, remotePath });
    }),
  );

describeJj("JjStatus.localStatus", () => {
  it.effect("reports an empty working copy as clean and names the bookmark", () =>
    withRepo({}, ({ root, status }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["new", 'bookmarks(exact:"main")']);
        const local = yield* status.localStatus({ cwd: root });

        assert.deepStrictEqual(local.vcs, { kind: "jj" });
        assert.equal(local.refName, "main");
        assert.equal(local.isDefaultRef, true);
        assert.equal(local.hasWorkingTreeChanges, false);
        assert.equal(local.workingTree.files.length, 0);
      }),
    ),
  );

  it.effect("reports per-file counts for an edited working copy", () =>
    withRepo({}, ({ fileSystem, path, root, status }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["new", 'bookmarks(exact:"main")']);
        yield* fileSystem.writeFileString(path.join(root, "a.txt"), "one\ntwo\n");
        yield* fileSystem.writeFileString(path.join(root, "b.txt"), "three\n");

        const local = yield* status.localStatus({ cwd: root });

        assert.equal(local.hasWorkingTreeChanges, true);
        assert.deepStrictEqual(
          local.workingTree.files.map((file) => file.path),
          ["a.txt", "b.txt"],
        );
        assert.equal(local.workingTree.insertions, 3);
        assert.equal(local.workingTree.deletions, 0);
      }),
    ),
  );

  it.effect("reports changes in a repository that has no bookmarks at all", () =>
    withJjRepo({ prefix: "t3-jj-status-bare-" }, ({ driver, fileSystem, path, process, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "a.txt"), "a\n");
        yield* fileSystem.writeFileString(path.join(root, "b.txt"), "b\n");
        const status = yield* makeStatus(driver, process);

        const local = yield* status.localStatus({ cwd: root });

        assert.equal(local.refName, null);
        assert.equal(local.workingTree.files.length, 2);
        assert.equal(local.hasWorkingTreeChanges, true);
      }),
    ),
  );

  it.effect("reports clean after the agent committed, because `@` is empty again", () =>
    withRepo({}, ({ fileSystem, path, root, status }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["new", 'bookmarks(exact:"main")']);
        yield* fileSystem.writeFileString(path.join(root, "agent.txt"), "agent\n");
        yield* runJj(root, ["commit", "-m", "agent work"]);

        const local = yield* status.localStatus({ cwd: root });

        assert.equal(local.workingTree.files.length, 0);
        assert.equal(local.hasWorkingTreeChanges, false);
      }),
    ),
  );

  it.effect("keeps `refName` stable across repeated polls", () =>
    withRepo({}, ({ root, status }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["new", 'bookmarks(exact:"main")']);
        yield* runJj(root, ["bookmark", "create", "aardvark", "-r", 'bookmarks(exact:"main")']);

        const first = yield* status.localStatus({ cwd: root });
        const second = yield* status.localStatus({ cwd: root });

        assert.equal(first.refName, "aardvark");
        assert.equal(first.refName, second.refName);
      }),
    ),
  );

  it.effect("costs two jj subprocesses once the repository caches are warm", () => {
    const jjCalls = { count: 0 };
    return Effect.gen(function* () {
      const { root } = yield* seedJjRepo({
        prefix: "t3-jj-status-warm-",
        seed: true,
      });

      const driver = yield* JjVcsDriver.JjVcsDriver;
      const process = yield* VcsProcess.VcsProcess;
      const status = yield* makeStatus(driver, process);

      yield* status.localStatus({ cwd: root });
      const warmStart = jjCalls.count;
      yield* status.localStatus({ cwd: root });

      assert.equal(jjCalls.count - warmStart, 2);
    }).pipe(Effect.provide(countingDriverLayer(jjCalls)));
  });

  it.effect("names the reason a non-colocated repository cannot be used, without throwing", () =>
    withRepo({ colocated: false }, ({ root, status }) =>
      Effect.gen(function* () {
        const local = yield* status.localStatus({ cwd: root });

        assert.equal(local.vcs?.kind, "jj");
        assert.include(local.vcs?.unsupportedReason ?? "", "colocated Jujutsu repositories");
        assert.equal(local.refName, null);
        assert.equal(local.hasWorkingTreeChanges, false);
      }),
    ),
  );

  it.effect("survives a Git ref moved backwards behind jj's back", () =>
    withRepo({}, ({ fileSystem, path, root, status }) =>
      Effect.gen(function* () {
        const seedCommit = (yield* runGit(root, ["rev-parse", "HEAD"])).trim();
        yield* runJj(root, ["new", 'bookmarks(exact:"main")']);
        yield* fileSystem.writeFileString(path.join(root, "keep.txt"), "keep\n");
        yield* runJj(root, ["commit", "-m", "work to keep"]);
        yield* runJj(root, ["bookmark", "set", "main", "-r", "@-"]);
        const keptCommit = (yield* runJj(root, [
          "log",
          "-r",
          'bookmarks(exact:"main")',
          "--no-graph",
          "-T",
          "commit_id",
        ])).trim();

        // What an ordinary `git fetch`, `git branch -f` or `gh pr checkout` does to a colocated
        // repository: with jj's default, the next snapshotting command abandons the commit and
        // deletes the file from disk.
        yield* runGit(root, ["update-ref", "refs/heads/main", seedCommit]);

        yield* status.localStatus({ cwd: root });

        assert.isTrue(yield* fileSystem.exists(path.join(root, "keep.txt")));
        const surviving = yield* runJj(root, [
          "log",
          "-r",
          keptCommit,
          "--no-graph",
          "-T",
          "description",
        ]);
        assert.include(surviving, "work to keep");
      }),
    ),
  );
});

describeJj("JjStatus.remoteStatus", () => {
  it.effect("counts the agent's own commits as ahead, not behind", () =>
    withRepo({ withRemote: true }, ({ fileSystem, path, root, status }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["new", 'bookmarks(exact:"main")']);
        yield* fileSystem.writeFileString(path.join(root, "one.txt"), "one\n");
        yield* runJj(root, ["commit", "-m", "one"]);
        yield* fileSystem.writeFileString(path.join(root, "two.txt"), "two\n");
        yield* runJj(root, ["commit", "-m", "two"]);

        const remote = yield* status.remoteStatus({ cwd: root });

        assert.equal(remote?.aheadCount, 2);
        assert.equal(remote?.behindCount, 0);
        assert.equal(remote?.aheadOfDefaultCount, 2);
      }),
    ),
  );

  it.effect("does not let an empty working copy inflate the ahead count", () =>
    withRepo({ withRemote: true }, ({ root, status }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["new", 'bookmarks(exact:"main")']);

        const remote = yield* status.remoteStatus({ cwd: root });

        assert.equal(remote?.aheadCount, 0);
        assert.equal(remote?.hasUpstream, true);
      }),
    ),
  );

  it.effect("reports a never-pushed bookmark's commits instead of zeroing Push", () =>
    withRepo({ withRemote: true }, ({ fileSystem, path, root, status }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["new", 'bookmarks(exact:"main")']);
        yield* fileSystem.writeFileString(path.join(root, "one.txt"), "one\n");
        yield* runJj(root, ["commit", "-m", "one"]);
        yield* fileSystem.writeFileString(path.join(root, "two.txt"), "two\n");
        yield* runJj(root, ["commit", "-m", "two"]);
        yield* runJj(root, ["bookmark", "create", "feat/unpushed", "-r", "@-"]);

        const remote = yield* status.remoteStatus({ cwd: root });

        assert.equal(remote?.hasUpstream, false);
        assert.equal(remote?.aheadCount, 2);
        assert.equal(remote?.behindCount, 0);
      }),
    ),
  );

  it.effect("carries the pull request the colocated Git store knows about", () =>
    withRepo(
      {
        withRemote: true,
        branchPullRequest: () =>
          Effect.succeed({
            number: 7,
            title: "Add the thing",
            url: "https://example.com/pull/7",
            baseRef: "main",
            headRef: "main",
            state: "open" as const,
            repositoryKey: null,
            updatedAt: null,
          }),
      },
      ({ root, status }) =>
        Effect.gen(function* () {
          yield* runJj(root, ["new", 'bookmarks(exact:"main")']);

          const remote = yield* status.remoteStatus({ cwd: root });

          // The whole mapping, so the omit-when-undefined fields stay pinned.
          assert.deepStrictEqual(remote?.pr, {
            number: 7,
            title: "Add the thing",
            url: "https://example.com/pull/7",
            baseRef: "main",
            headRef: "main",
            state: "open",
            updatedAt: null,
          });
        }),
    ),
  );
});

describeJj("refNameFromSegment", () => {
  it("takes the lexicographically first name of the last bookmarked row", () => {
    assert.equal(
      refNameFromSegment([
        { commitId: "a", empty: true, localBookmarks: [] },
        { commitId: "b", empty: false, localBookmarks: ["zeta", "alpha"] },
      ]),
      "alpha",
    );
  });

  it("is null when nothing in the segment carries a bookmark", () => {
    assert.equal(refNameFromSegment([{ commitId: "a", empty: true, localBookmarks: [] }]), null);
  });
});
