import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import { VcsProcessOutputLimitError, VcsProcessTimeoutError } from "@t3tools/contracts";
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
import { makeJjRemotes } from "./JjRemotes.ts";
import { makeJjStatus, refNameFromSegment, type JjStatusOps } from "./JjStatus.ts";
import { workspaceNameForRef } from "./JjWorkspaces.ts";

/** Counts both jj snapshots and colocated Git diff work on the polling path. */
const countingDriverLayer = (counter: {
  count: number;
  gitCommands: string[][];
  jjCommands?: string[][];
}) =>
  JjVcsDriver.layer.pipe(
    Layer.provideMerge(
      Layer.effect(
        VcsProcess.VcsProcess,
        Effect.map(VcsProcess.make, (real) => ({
          run: (input: VcsProcess.VcsProcessInput) => {
            if (input.command === "jj") {
              counter.count += 1;
              counter.jjCommands?.push([...input.args]);
            }
            if (input.command === "git") {
              counter.gitCommands.push([...input.args]);
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
  it.effect("surfaces snapshot failures rather than reporting a clean repository", () =>
    withRepo({}, ({ root, status, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* status.localStatus({ cwd: root });
        yield* fileSystem.writeFileString(
          path.join(root, ".jj", "repo", "config.toml"),
          "[broken\n",
        );
        const error = yield* status.localStatus({ cwd: root }).pipe(Effect.flip);
        assert.equal(error._tag, "GitCommandError");
      }),
    ),
  );


  it.effect("returns orphan-history status without optional branch totals", () =>
    withRepo({}, ({ root, status, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["new", "root()"]);
        yield* fileSystem.writeFileString(path.join(root, "orphan.txt"), "orphan\n");
        const local = yield* status.localStatus({ cwd: root });
        assert.isNull(local.refName);
        assert.isUndefined(local.branchChanges);
        assert.isTrue(local.hasWorkingTreeChanges);
      }),
    ),
  );

  it.effect("selects the managed thread bookmark and never falls back to main", () =>
    withJjRepo({ prefix: "t3-jj-status-managed-", seed: true }, (repo) =>
      Effect.gen(function* () {
        const status = yield* makeStatus(repo.driver, repo.process);
        const child = repo.path.join(repo.base, "child");
        yield* runJj(repo.root, ["bookmark", "create", "t3code/thread", "-r", "main"]);
        yield* runJj(repo.root, [
          "workspace",
          "add",
          "--colocate",
          "--name",
          workspaceNameForRef("t3code/thread"),
          "-r",
          "t3code/thread",
          child,
        ]);
        assert.equal((yield* status.localStatus({ cwd: child })).refName, "t3code/thread");
        const sibling = repo.path.join(repo.base, "sibling");
        yield* runJj(repo.root, ["bookmark", "create", "aaa-child", "-r", "main"]);
        yield* runJj(repo.root, [
          "workspace",
          "add",
          "--colocate",
          "--name",
          workspaceNameForRef("aaa-child"),
          "-r",
          "aaa-child",
          sibling,
        ]);
        assert.equal((yield* status.localStatus({ cwd: repo.root })).refName, "main");
        assert.equal((yield* status.localStatus({ cwd: sibling })).refName, "aaa-child");
        yield* runJj(child, ["bookmark", "delete", "t3code/thread"]);
        assert.isNull((yield* status.localStatus({ cwd: child })).refName);
      }),
    ),
  );
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
        assert.deepStrictEqual(local.branchChanges, {
          baseRef: null,
          insertions: 2,
          deletions: 0,
        });
      }),
    ),
  );

  it.effect("keeps committed branch totals separate from a clean working copy", () =>
    withRepo({ withRemote: true }, ({ fileSystem, path, root, status }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "agent.txt"), "agent\n");
        yield* runJj(root, ["commit", "-m", "agent work"]);
        yield* runJj(root, ["bookmark", "set", "main", "-r", "@-"]);

        const local = yield* status.localStatus({ cwd: root });

        assert.equal(local.hasWorkingTreeChanges, false);
        assert.deepStrictEqual(local.workingTree, { files: [], insertions: 0, deletions: 0 });
        assert.deepStrictEqual(local.branchChanges, {
          baseRef: "origin/main",
          insertions: 1,
          deletions: 0,
        });
      }),
    ),
  );

  it.effect("counts work without an ancestor bookmark when a default bookmark exists", () =>
    withRepo({}, ({ fileSystem, path, root, status }) =>
      Effect.gen(function* () {
        const seed = (yield* runJj(root, [
          "log",
          "-r",
          "main",
          "--no-graph",
          "-T",
          "commit_id",
        ])).trim();
        yield* fileSystem.writeFileString(path.join(root, "main-only.txt"), "main\n");
        yield* runJj(root, ["commit", "-m", "advance default"]);
        yield* runJj(root, ["bookmark", "set", "main", "-r", "@-"]);
        yield* runJj(root, ["new", seed]);
        yield* fileSystem.writeFileString(path.join(root, "detached.txt"), "detached\n");
        yield* runJj(root, ["commit", "-m", "unbookmarked work"]);

        const local = yield* status.localStatus({ cwd: root });

        assert.equal(local.refName, null);
        assert.equal(local.hasWorkingTreeChanges, false);
        assert.deepStrictEqual(local.branchChanges, {
          baseRef: "main",
          insertions: 1,
          deletions: 0,
        });
      }),
    ),
  );

  it.effect(
    "includes committed and dirty changes against the remote default for an unpushed bookmark",
    () =>
      withRepo({ withRemote: true }, ({ fileSystem, path, root, status }) =>
        Effect.gen(function* () {
          yield* fileSystem.writeFileString(path.join(root, "agent.txt"), "committed\n");
          yield* runJj(root, ["commit", "-m", "agent work"]);
          yield* runJj(root, ["bookmark", "create", "feat/unpushed", "-r", "@-"]);
          yield* fileSystem.writeFileString(path.join(root, "agent.txt"), "committed\ndirty\n");

          const local = yield* status.localStatus({ cwd: root });

          assert.equal(local.refName, "feat/unpushed");
          assert.equal(local.hasWorkingTreeChanges, true);
          assert.deepStrictEqual(local.workingTree, {
            files: [{ path: "agent.txt", insertions: 1, deletions: 0 }],
            insertions: 1,
            deletions: 0,
          });
          assert.deepStrictEqual(local.branchChanges, {
            baseRef: "origin/main",
            insertions: 2,
            deletions: 0,
          });
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
        assert.deepStrictEqual(local.branchChanges, {
          baseRef: "main",
          insertions: 1,
          deletions: 0,
        });
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

  it.effect("reads totals with one numstat and no patch or second snapshot", () => {
    const jjCalls = { count: 0, gitCommands: [] as string[][] };
    return Effect.gen(function* () {
      const { root } = yield* seedJjRepo({
        prefix: "t3-jj-status-warm-",
        seed: true,
      });
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(`${root}/agent.txt`, "agent\n");

      const driver = yield* JjVcsDriver.JjVcsDriver;
      const process = yield* VcsProcess.VcsProcess;
      const status = yield* makeStatus(driver, process);

      yield* status.localStatus({ cwd: root });
      const warmStart = jjCalls.count;
      const gitStart = jjCalls.gitCommands.length;
      yield* status.localStatus({ cwd: root });

      assert.equal(jjCalls.count - warmStart, 5);
      const commands = jjCalls.gitCommands.slice(gitStart);
      yield* Effect.logInfo("JjStatus local subprocess counts", {
        cold: { jj: warmStart, git: gitStart },
        warm: { jj: jjCalls.count - warmStart, git: commands.length },
      });
      assert.equal(commands.length, 2);
      assert.deepStrictEqual(commands[0]!.slice(-3), [
        "config",
        "--get-regexp",
        "^branch\\.main\\.(t3-merge-base-ref|gh-merge-base)$",
      ]);
      assert.include(commands[1]!, "--numstat");
      assert.notInclude(commands[1]!, "--patch");
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
  it.effect(
    "does not count an inherited conflicted merge or its empty working-copy child as ahead",
    () =>
      withJjRepo({ prefix: "t3-jj-status-conflicted-merge-", withRemote: true }, (repo) =>
        Effect.gen(function* () {
          for (const side of ["left", "right"]) {
            yield* runJj(repo.root, ["new", 'bookmarks(exact:"main")']);
            yield* repo.fileSystem.writeFileString(
              repo.path.join(repo.root, "seed.txt"),
              `${side}\n`,
            );
            yield* runJj(repo.root, ["commit", "-m", `${side} edits seed`]);
            yield* runJj(repo.root, ["bookmark", "create", side, "-r", "@-"]);
          }
          yield* runJj(repo.root, ["new", "left", "right"]);
          yield* runJj(repo.root, ["describe", "-m", "inherit both conflicting parents"]);
          assert.equal(
            (yield* runJj(repo.root, ["log", "-r", "@", "--no-graph", "-T", "empty"])).trim(),
            "true",
          );
          const status = yield* makeStatus(repo.driver, repo.process);
          const atMerge = yield* status.remoteStatus({ cwd: repo.root }, { refreshUpstream: true });
          assert.equal(atMerge?.aheadCount, 2);
          assert.equal(atMerge?.behindCount, 0);
          yield* runJj(repo.root, ["new"]);
          yield* runJj(repo.root, ["bookmark", "set", "main", "-r", "@-"]);
          const withEmptyChild = yield* status.remoteStatus(
            { cwd: repo.root },
            { refreshUpstream: true },
          );
          assert.equal(withEmptyChild?.aheadCount, 2);
          assert.equal(withEmptyChild?.behindCount, 0);
        }),
      ),
  );

  for (const remoteMerge of [false, true]) {
    for (const dirtyMerge of [false, true]) {
      it.effect(
        `counts ${dirtyMerge ? "resolved" : "clean"} merge history as ${
          remoteMerge ? "behind" : "ahead"
        } without counting empty merge or working-copy commits`,
        () =>
          withJjRepo({ prefix: "t3-jj-status-merge-", withRemote: true }, (repo) =>
            Effect.gen(function* () {
              const cwd = remoteMerge ? repo.path.join(repo.base, "peer") : repo.root;
              if (remoteMerge) {
                yield* repo.fileSystem.makeDirectory(cwd, { recursive: true });
                yield* runJj(cwd, ["git", "clone", "--colocate", repo.remotePath, cwd]);
              }
              for (const side of ["left", "right"]) {
                yield* runJj(cwd, ["new", 'bookmarks(exact:"main")']);
                yield* repo.fileSystem.writeFileString(repo.path.join(cwd, `${side}.txt`), side);
                yield* runJj(cwd, ["commit", "-m", `${side} work`]);
                yield* runJj(cwd, ["bookmark", "create", side, "-r", "@-"]);
              }
              yield* runJj(cwd, ["new", "left", "right"]);
              if (dirtyMerge) {
                yield* repo.fileSystem.writeFileString(
                  repo.path.join(cwd, "resolution.txt"),
                  "resolved\n",
                );
              }
              yield* runJj(cwd, ["describe", "-m", "merge both sides"]);
              const status = yield* makeStatus(repo.driver, repo.process);
              const count = dirtyMerge ? 3 : 2;
              if (!remoteMerge) {
                const atMerge = yield* status.remoteStatus(
                  { cwd: repo.root },
                  { refreshUpstream: true },
                );
                assert.equal(atMerge?.aheadCount, count);
                assert.equal(atMerge?.behindCount, 0);
              }
              yield* runJj(cwd, ["new"]);
              yield* runJj(cwd, ["bookmark", "set", "main", "-r", "@-"]);
              if (remoteMerge) {
                yield* runJj(cwd, ["git", "push", "--bookmark", "main", "--remote", "origin"]);
              }
              const refreshed = yield* status.remoteStatus(
                { cwd: repo.root },
                { refreshUpstream: true },
              );
              assert.equal(refreshed?.aheadCount, remoteMerge ? 0 : count);
              assert.equal(refreshed?.behindCount, remoteMerge ? count : 0);
              assert.equal((yield* status.localStatus({ cwd: repo.root })).refName, "main");
            }),
          ),
      );
    }
  }

  it.effect("returns null for an unsupported non-colocated repository, even on refresh", () =>
    withRepo({ colocated: false }, ({ root, status }) =>
      Effect.gen(function* () {
        assert.isNull(yield* status.remoteStatus({ cwd: root }));
        assert.isNull(yield* status.remoteStatus({ cwd: root }, { refreshUpstream: true }));
      }),
    ),
  );

  for (const managed of [false, true]) {
    it.effect(
      managed
        ? "preserves a managed thread bookmark after remote advancement and can still pull and push"
        : "reports behind after a peer push without moving main and can still pull",
      () =>
        withJjRepo({ prefix: "t3-jj-status-peer-", withRemote: true }, (repo) =>
          Effect.gen(function* () {
            const name = managed ? "t3code/thread" : "main";
            const cwd = managed ? repo.path.join(repo.base, "thread") : repo.root;
            if (managed) {
              yield* runJj(repo.root, ["bookmark", "create", name, "-r", "main"]);
              yield* runJj(repo.root, ["git", "push", "--bookmark", name, "--remote", "origin"]);
              yield* runJj(repo.root, [
                "workspace",
                "add",
                "--colocate",
                "--name",
                workspaceNameForRef(name),
                "-r",
                name,
                cwd,
              ]);
            }
            const status = yield* makeStatus(repo.driver, repo.process);
            const remotes = makeJjRemotes({ driver: repo.driver, process: repo.process });
            const mainBefore = (yield* repo.driver.changeAt(repo.root, "main"))?.commitId;
            const localBefore = (yield* repo.driver.changeAt(cwd, `bookmarks(exact:"${name}")`))
              ?.commitId;
            const workingCopyBefore = (yield* repo.driver.changeAt(cwd, "@"))?.commitId;
            const bookmarksBefore = yield* repo.driver.listBookmarks(cwd);
            const trackingBefore = (yield* runGit(cwd, [
              "rev-parse",
              `refs/remotes/origin/${name}`,
            ])).trim();
            const initial = yield* status.remoteStatus({ cwd });
            assert.equal(initial?.behindCount, 0);
            assert.equal(initial?.hasUpstream, true);

            const peer = repo.path.join(repo.base, "peer");
            yield* repo.fileSystem.makeDirectory(peer, { recursive: true });
            yield* runJj(peer, ["git", "clone", "--colocate", repo.remotePath, peer]);
            if (managed) {
              yield* runJj(peer, ["bookmark", "track", `${name}@origin`]);
            }
            yield* runJj(peer, ["new", `remote_bookmarks(exact:"${name}", exact:"origin")`]);
            yield* repo.fileSystem.writeFileString(repo.path.join(peer, "peer.txt"), "peer\n");
            yield* runJj(peer, ["commit", "-m", "peer advances remote"]);
            yield* runJj(peer, ["bookmark", "set", name, "-r", "@-"]);
            yield* runJj(peer, ["git", "push", "--bookmark", name, "--remote", "origin"]);
            const peerHead = (yield* repo.driver.changeAt(peer, `bookmarks(exact:"${name}")`))
              ?.commitId;

            const refreshed = yield* status.remoteStatus({ cwd }, { refreshUpstream: true });
            assert.equal(
              (yield* runGit(cwd, ["rev-parse", `refs/remotes/origin/${name}`])).trim(),
              trackingBefore,
            );
            assert.equal(refreshed?.hasUpstream, true);
            assert.equal(refreshed?.aheadCount, 0);
            assert.equal(refreshed?.behindCount, 1);
            const local = yield* status.localStatus({ cwd });
            assert.equal(local.refName, name);
            assert.equal(local.isDefaultRef, !managed);
            assert.equal((yield* repo.driver.changeAt(repo.root, "main"))?.commitId, mainBefore);
            assert.equal(
              (yield* repo.driver.changeAt(cwd, `bookmarks(exact:"${name}")`))?.commitId,
              localBefore,
            );
            assert.equal((yield* repo.driver.changeAt(cwd, "@"))?.commitId, workingCopyBefore);
            assert.deepStrictEqual(yield* repo.driver.listBookmarks(cwd), bookmarksBefore);
            assert.equal(
              (yield* runGit(cwd, ["rev-parse", `refs/t3/remotes/origin/${name}`])).trim(),
              peerHead,
            );

            const pulled = yield* remotes.pullCurrentBranch(cwd);
            assert.equal(pulled.status, "pulled");
            assert.equal(pulled.refName, name);
            assert.isTrue(yield* repo.fileSystem.exists(repo.path.join(cwd, "peer.txt")));
            const afterPull = yield* status.remoteStatus({ cwd });
            assert.equal(afterPull?.aheadCount, 0);
            assert.equal(afterPull?.behindCount, 0);
            if (managed) {
              yield* repo.fileSystem.writeFileString(repo.path.join(cwd, "thread.txt"), "thread\n");
              yield* runJj(cwd, ["commit", "-m", "thread work after refresh"]);
              const ahead = yield* status.remoteStatus({ cwd });
              assert.equal(ahead?.aheadCount, 1);
              const pushed = yield* remotes.pushBookmark({
                cwd,
                name,
                remoteName: "origin",
                operation: "test",
              });
              assert.equal(pushed.status, "pushed");
              const afterPush = yield* status.remoteStatus({ cwd });
              assert.equal(afterPush?.aheadCount, 0);
              assert.equal(afterPush?.behindCount, 0);
              assert.equal((yield* status.localStatus({ cwd })).refName, name);
              assert.equal(
                (yield* runGit(repo.remotePath, ["rev-parse", `refs/heads/${name}`])).trim(),
                (yield* repo.driver.changeAt(cwd, "@-"))?.commitId,
              );
              assert.equal((yield* repo.driver.changeAt(repo.root, "main"))?.commitId, mainBefore);
            }
          }),
        ),
    );
  }

  it.effect("measures warm remote polls separately from namespace refresh subprocesses", () => {
    const calls = { count: 0, gitCommands: [] as string[][], jjCommands: [] as string[][] };
    return Effect.gen(function* () {
      const { root } = yield* seedJjRepo({
        prefix: "t3-jj-status-remote-count-",
        withRemote: true,
      });
      const driver = yield* JjVcsDriver.JjVcsDriver;
      const process = yield* VcsProcess.VcsProcess;
      const status = yield* makeStatus(driver, process);
      yield* status.remoteStatus({ cwd: root });
      const warmStart = { jj: calls.count, git: calls.gitCommands.length };
      yield* status.remoteStatus({ cwd: root });
      const warm = {
        jj: calls.count - warmStart.jj,
        git: calls.gitCommands.length - warmStart.git,
      };
      const refreshStart = { jj: calls.count, git: calls.gitCommands.length };
      yield* status.remoteStatus({ cwd: root }, { refreshUpstream: true });
      const refresh = {
        jj: calls.count - refreshStart.jj,
        git: calls.gitCommands.length - refreshStart.git,
      };
      yield* Effect.logInfo("JjStatus remote subprocess counts", { warm, refresh });
      assert.isAbove(warm.jj, 0);
      assert.isAbove(refresh.git, warm.git);
      assert.equal(calls.gitCommands.filter((args) => args.includes("fetch")).length, 1);
      assert.isFalse(calls.jjCommands.some((args) => args.includes("fetch")));
    }).pipe(Effect.provide(countingDriverLayer(calls)));
  });

  for (const failure of ["timeout", "output-limit", "overflow"] as const) {
    it.effect(`preserves behind counts when the private query hits ${failure}`, () =>
      withJjRepo({ prefix: "t3-jj-count-fallback-", withRemote: true }, (repo) =>
        Effect.gen(function* () {
          yield* runJj(repo.root, ["new", "main"]);
          yield* repo.fileSystem.writeFileString(repo.path.join(repo.root, "ahead.txt"), "ahead\n");
          yield* runJj(repo.root, ["commit", "-m", "ahead"]);
          const remote = (yield* repo.driver.changeAt(repo.root, "@-"))!.commitId;
          yield* runGit(repo.root, ["update-ref", "refs/t3/remotes/origin/main", remote]);
          let attempted = false;
          const status = yield* makeStatus(repo.driver, {
            run: (input) => {
              if (input.operation === "JjStatus.countGitChanges") {
                attempted = true;
                if (failure === "overflow") {
                  return Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: "t3-commit\n1 file changed\n".repeat(1000),
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  });
                }
                const context = {
                  operation: input.operation,
                  command: input.command,
                  cwd: input.cwd,
                };
                return Effect.fail(
                  failure === "timeout"
                    ? new VcsProcessTimeoutError({ ...context, timeoutMs: 20_000 })
                    : new VcsProcessOutputLimitError({
                        ...context,
                        stream: "stdout",
                        maxBytes: 1,
                        observedBytes: 2,
                      }),
                );
              }
              return repo.process.run(input);
            },
          });
          const result = yield* status.remoteStatus({ cwd: repo.root });
          assert.equal(result?.aheadCount, 0);
          assert.equal(result?.behindCount, failure === "overflow" ? 1000 : 0);
          assert.isTrue(result?.hasUpstream);
          assert.isTrue(attempted);
        }),
      ),
    );
  }

  for (const imported of [true, false]) {
    it.effect(
      imported
        ? "counts an imported alias against its configured fork head"
        : "does not treat an ordinary configured upstream as an imported alias",
      () =>
        withJjRepo({ prefix: "t3-jj-status-import-", seed: true, withRemote: true }, (repo) =>
          Effect.gen(function* () {
            const alias = "aaa-import";
            const fork = repo.path.join(repo.base, "fork.git");
            const sourceHead = imported ? "main" : "topic";
            const originalMain = yield* repo.driver.changeAt(repo.root, 'bookmarks(exact:"main")');
            yield* runGit(repo.root, ["init", "--bare", fork]);
            yield* runJj(repo.root, ["new", 'bookmarks(exact:"main")']);
            yield* repo.fileSystem.writeFileString(repo.path.join(repo.root, "fork.txt"), "fork\n");
            yield* runJj(repo.root, ["commit", "-m", "fork head"]);
            yield* runJj(repo.root, ["bookmark", "create", alias, "-r", "@-"]);
            yield* runGit(repo.root, ["push", fork, `refs/heads/${alias}:refs/heads/topic`]);
            yield* runGit(repo.root, ["push", fork, `refs/heads/${alias}:refs/heads/main`]);
            yield* runJj(repo.root, ["git", "remote", "add", "contributor", fork]);
            yield* runGit(repo.root, ["config", `branch.${alias}.remote`, "contributor"]);
            yield* runGit(repo.root, [
              "config",
              `branch.${alias}.merge`,
              `refs/heads/${sourceHead}`,
            ]);
            yield* runJj(repo.root, ["config", "set", "--repo", "git.auto-local-bookmark", "true"]);
            yield* runJj(repo.root, [
              "config",
              "set",
              "--repo",
              "remotes.contributor.auto-track-bookmarks",
              "*",
            ]);
            if (imported) {
              yield* runGit(repo.root, [
                "config",
                `branch.${alias}.t3code-imported-pr-head`,
                "true",
              ]);
            }
            const fetchArgs: string[][] = [];
            const status = yield* makeStatus(repo.driver, {
              run: (input) => {
                if (input.args.includes("fetch")) {
                  fetchArgs.push([input.command, ...input.args.slice(input.args.indexOf("fetch"))]);
                }
                return repo.process.run(input);
              },
            });
            const beforeRefresh = yield* status.remoteStatus({ cwd: repo.root });
            assert.equal(beforeRefresh?.hasUpstream, false);
            assert.equal(beforeRefresh?.aheadCount, 1);
            const remote = yield* status.remoteStatus(
              { cwd: repo.root },
              { refreshUpstream: true },
            );
            assert.equal(remote?.hasUpstream, imported);
            assert.equal(remote?.aheadCount, imported ? 0 : 1);
            assert.equal(remote?.behindCount, 0);
            assert.equal(remote?.aheadOfDefaultCount, 1);
            const remoteName = imported ? "contributor" : "origin";
            assert.deepStrictEqual(fetchArgs, [
              [
                "git",
                "fetch",
                "--no-tags",
                "--no-write-fetch-head",
                "--prune",
                "--refmap=",
                remoteName,
                `+refs/heads/*:refs/t3/remotes/${remoteName}/*`,
              ],
            ]);
            assert.equal(
              (yield* repo.driver.changeAt(repo.root, 'bookmarks(exact:"main")'))?.commitId,
              originalMain?.commitId,
            );
            const bookmarks = yield* repo.driver.listBookmarks(repo.root);
            assert.isFalse(bookmarks.some((bookmark) => bookmark.remote === "contributor"));
            if (imported) {
              assert.equal(
                (yield* runGit(repo.root, [
                  "rev-parse",
                  "refs/t3/remotes/contributor/main",
                ])).trim(),
                (yield* repo.driver.changeAt(repo.root, `bookmarks(exact:"${alias}")`))?.commitId,
              );
            }
          }),
        ),
    );
  }

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
