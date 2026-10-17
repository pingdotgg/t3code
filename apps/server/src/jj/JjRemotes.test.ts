import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import { VcsProcessSpawnError } from "@t3tools/contracts";

import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import { describeJj, runGit, runJj, withJjRepo } from "../vcs/testing/JjTestSupport.ts";
import { makeJjRemotes, type JjRemoteOps } from "./JjRemotes.ts";
import { workspaceNameForRef } from "./JjWorkspaces.ts";

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

it.effect("resolves launch bases from tracked bookmarks, explicit remotes and origin fallback", () =>
  Effect.gen(function* () {
    const bookmark = (name: string, remote: string | null, tracked = false) => ({
      name,
      remote,
      tracked,
      target: "old",
      synced: true,
      conflict: false,
      targetTimestamp: 0,
    });
    const remotes = makeJjRemotes({
      driver: {
        listRemoteNames: () => Effect.succeed(["origin", "upstream", "upstream/team"]),
        listBookmarks: () => Effect.succeed([
          bookmark("main", null),
          bookmark("main", "upstream", true),
          bookmark("origin/shadow", null),
          bookmark("untracked", "upstream"),
        ]),
      } as unknown as JjVcsDriver.JjVcsDriverShape,
      process: {} as VcsProcess.VcsProcess["Service"],
    });
    for (const [refName, expected] of [
      ["main", { remoteName: "upstream", branchName: "main" }],
      ["upstream/team/topic/x", { remoteName: "upstream/team", branchName: "topic/x" }],
      ["origin/shadow", { remoteName: "origin", branchName: "origin/shadow" }],
      ["untracked", { remoteName: "origin", branchName: "untracked" }],
    ] as const) {
      assert.deepEqual(
        yield* remotes.resolveWorktreeBaseRemote({ cwd: "/workspace", refName }),
        expected,
      );
    }
    const noOrigin = makeJjRemotes({
      driver: {
        listRemoteNames: () => Effect.succeed(["upstream"]),
        listBookmarks: () => Effect.succeed([]),
      } as unknown as JjVcsDriver.JjVcsDriverShape,
      process: {} as VcsProcess.VcsProcess["Service"],
    });
    assert.isNull(yield* noOrigin.resolveWorktreeBaseRemote({ cwd: "/workspace", refName: "main" }));
  }),
);

for (const advertisedExit of [0, 2, 128]) {
  it.effect(`fetches a launch base with remote probe exit ${advertisedExit}`, () =>
    Effect.gen(function* () {
      const calls: VcsProcess.VcsProcessInput[] = [];
      const changeAt = vi.fn((..._args: [string, string]) =>
        Effect.succeed({ commitId: "fresh-commit" }),
      );
      const invalidate = vi.fn(() => Effect.void);
      const remotes = makeJjRemotes({
        driver: {
          listRemoteNames: () => Effect.succeed(["origin"]),
          listBookmarks: () => Effect.succeed([]),
          ensureUsable: () => Effect.succeed({ gitDir: "/main/.git", mainWorkspaceRoot: "/main" }),
          invalidateRepoCaches: invalidate,
          changeAt,
        } as unknown as JjVcsDriver.JjVcsDriverShape,
        process: {
          run: (input) => {
            calls.push(input);
            return Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(
                input.args.includes("ls-remote") ? advertisedExit : 0,
              ),
              stdout: "",
              stderr: advertisedExit === 128 ? "remote unavailable" : "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          },
        },
      });
      const fetch = remotes.fetchWorktreeBaseCommit({ cwd: "/secondary", refName: "topic/ui(x)" });
      if (advertisedExit === 128) {
        assert.include((yield* fetch.pipe(Effect.flip)).detail, "remote unavailable");
      } else {
        assert.deepEqual(yield* fetch, advertisedExit === 2 ? null : {
          commitSha: "fresh-commit",
          remoteRefName: "origin/topic/ui(x)",
        });
      }
      assert.equal(calls[0]?.cwd, "/main");
      assert.deepEqual(calls[0]!.args.slice(0, 2), ["--git-dir", "/main/.git"]);
      assert.deepEqual(calls[0]?.env, {
        GCM_INTERACTIVE: "never",
        GIT_ASKPASS: "",
        GIT_TERMINAL_PROMPT: "0",
        SSH_ASKPASS: "",
        SSH_ASKPASS_REQUIRE: "never",
      });
      if (advertisedExit === 0) {
        const jjFetch = calls.find((call) => call.command === "jj");
        assert.equal(jjFetch?.cwd, "/secondary");
        assert.deepEqual(jjFetch?.args.slice(-6), [
          "git", "fetch", "--remote", 'exact:"origin"', "--branch", 'exact:"topic/ui(x)"',
        ]);
        assert.deepEqual(changeAt.mock.calls[0], ["/secondary", '"topic/ui(x)"@"origin"']);
        assert.equal(invalidate.mock.calls.length, 1);
      } else {
        assert.equal(calls.length, 1);
        assert.equal(changeAt.mock.calls.length, 0);
      }
    }),
  );
}

describeJj("JjRemotes launch remote probe", () => {
  it.effect("disables interactive credentials in the actual Git remote process", () =>
    withJjRepo({ prefix: "t3-jj-probe-env-", withRemote: true }, (repo) =>
      Effect.gen(function* () {
        const uploadPack = repo.path.join(repo.base, "upload-pack");
        yield* repo.fileSystem.writeFileString(
          uploadPack,
          [
            "#!/bin/sh",
            'printf "%s\\n" "$GCM_INTERACTIVE" "$GIT_ASKPASS" "$GIT_TERMINAL_PROMPT" "$SSH_ASKPASS" "$SSH_ASKPASS_REQUIRE" > "$0.env"',
            'exec git-upload-pack "$@"',
            "",
          ].join("\n"),
        );
        yield* repo.fileSystem.chmod(uploadPack, 0o755);
        yield* runGit(repo.root, ["config", "remote.origin.uploadpack", JSON.stringify(uploadPack)]);

        const result = yield* makeJjRemotes(repo).fetchWorktreeBaseCommit({
          cwd: repo.root,
          refName: "missing-remote-branch",
        });
        assert.isNull(result);
        assert.equal(
          yield* repo.fileSystem.readFileString(`${uploadPack}.env`),
          "never\n\n0\n\nnever\n",
        );
      }),
    ),
  );
});

describeJj("JjRemotes.publishRepository remote allocation", () => {
  it.effect("explains a failed first push after retaining the newly allocated remote", () =>
    withJjRepo({ prefix: "t3-jj-publish-rejected-", seed: true }, (repo) =>
      Effect.gen(function* () {
        const remote = repo.path.join(repo.base, "rejected.git");
        yield* runGit(repo.root, ["init", "--bare", remote]);
        yield* runGit(repo.root, ["--git-dir", remote, "config", "core.hooksPath", "hooks"]);
        const hook = repo.path.join(remote, "hooks", "pre-receive");
        yield* repo.fileSystem.writeFileString(hook, "#!/bin/sh\nexit 1\n");
        yield* repo.fileSystem.chmod(hook, 0o755);
        const result = yield* makeJjRemotes(repo)
          .publishRepository({
            cwd: repo.root,
            remoteName: "origin",
            remoteUrl: remote,
            pushFailureDetail: (_cause, remoteName) =>
              `Created team/new and added it as remote "${remoteName}", but the push failed. Fix the problem, then push again.`,
          })
          .pipe(Effect.flip);
        assert.equal(
          result.detail,
          'Created team/new and added it as remote "origin", but the push failed. Fix the problem, then push again.',
        );
        assert.deepStrictEqual(yield* repo.driver.listRemoteNames(repo.root), ["origin"]);
      }),
    ),
  );

  it.effect("preserves the actionable undescribed-change refusal when publishing", () =>
    withJjRepo({ prefix: "t3-jj-publish-undescribed-" }, (repo) =>
      Effect.gen(function* () {
        const remote = repo.path.join(repo.base, "new.git");
        yield* runGit(repo.root, ["init", "--bare", remote]);
        yield* repo.fileSystem.writeFileString(repo.path.join(repo.root, "work.txt"), "work\n");
        yield* runJj(repo.root, ["new"]);
        const failure = yield* makeJjRemotes(repo)
          .publishRepository({
            cwd: repo.root,
            remoteName: "origin",
            remoteUrl: remote,
            pushFailureDetail: () => "Generic hosting guidance",
          })
          .pipe(Effect.flip);
        assert.include(failure.detail, "Describe this change before pushing");
        assert.notInclude(failure.detail, "Generic hosting guidance");
      }),
    ),
  );

  it.effect("reuses an existing remote with an equivalent URL", () =>
    withJjRepo({ prefix: "t3-jj-publish-reuse-" }, ({ driver, process, root }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["git", "remote", "add", "shared", "git@github.com:team/shared.git"]);
        const result = yield* makeJjRemotes({ driver, process }).publishRepository({
          cwd: root,
          remoteName: "origin",
          remoteUrl: "https://github.com/team/shared.git",
        });
        assert.equal(result.remoteName, "shared");
        assert.equal(result.status, "remote_added");
        assert.deepStrictEqual(yield* driver.listRemoteNames(root), ["shared"]);
      }),
    ),
  );

  it.effect("sanitizes names and suffixes collisions without overwriting remotes", () => {
    const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    return withJjRepo(
      {
        prefix: "t3-jj-publish-collision-",
        env,
      },
      ({ driver, process, root }) =>
        Effect.gen(function* () {
          const upstreamUrl = "https://github.com/team/upstream.git";
          const otherUrl = "https://github.com/team/other.git";
          const targetUrl = "https://github.com/team/new.git";
          yield* runJj(root, ["git", "remote", "add", "my-origin", upstreamUrl], { env });
          yield* runJj(root, ["git", "remote", "add", "my-origin-1", otherUrl], { env });
          const result = yield* makeJjRemotes({ driver, process }).publishRepository({
            cwd: root,
            remoteName: " my origin! ",
            remoteUrl: targetUrl,
          });
          assert.equal(result.remoteName, "my-origin-2");
          const listed = yield* driver.listRemotes(root);
          assert.deepStrictEqual(
            listed.remotes.map(({ name, url }) => ({ name, url })),
            [
              { name: "my-origin", url: upstreamUrl },
              { name: "my-origin-1", url: otherUrl },
              { name: "my-origin-2", url: targetUrl },
            ],
          );
        }),
    );
  });

  for (const name of ["aaa-thread", "zzz-thread"]) {
    it.effect(`publishes ${name} only from its managed workspace and refuses its deletion`, () =>
      withJjRepo({ prefix: "t3-jj-publish-managed-", withRemote: true }, (repo) =>
        Effect.gen(function* () {
          const child = repo.path.join(repo.base, "child");
          yield* runJj(repo.root, ["bookmark", "create", name, "-r", "main"]);
          yield* runJj(repo.root, [
            "workspace",
            "add",
            "--colocate",
            "--name",
            workspaceNameForRef(name),
            "-r",
            name,
            child,
          ]);
          const remotes = makeJjRemotes({ driver: repo.driver, process: repo.process });
          const published = yield* remotes.publishRepository({
            cwd: child,
            remoteName: "origin",
            remoteUrl: repo.remotePath,
          });
          assert.equal(published.refName, name);
          assert.equal(published.status, "pushed");
          const remoteBookmark = (yield* repo.driver.listBookmarks(child)).find(
            (bookmark) => bookmark.name === name && bookmark.remote === "origin",
          );
          assert.equal(
            remoteBookmark?.target,
            (yield* repo.driver.changeAt(child, "@-"))?.commitId,
          );

          const parentPublished = yield* remotes.publishRepository({
            cwd: repo.root,
            remoteName: "origin",
            remoteUrl: repo.remotePath,
          });
          assert.equal(parentPublished.refName, "main");

          const mainBefore = (yield* repo.driver.changeAt(repo.root, "main"))?.commitId;
          yield* repo.fileSystem.writeFileString(repo.path.join(child, "child.txt"), "child\n");
          yield* runJj(child, ["commit", "-m", "Child work"]);
          yield* runJj(child, ["bookmark", "delete", name]);
          const failure = yield* remotes
            .publishRepository({
              cwd: child,
              remoteName: "origin",
              remoteUrl: repo.remotePath,
            })
            .pipe(Effect.flip);
          assert.include(failure.detail, "workspace bookmark");
          assert.equal((yield* repo.driver.changeAt(repo.root, "main"))?.commitId, mainBefore);
          assert.equal(
            (yield* runGit(repo.remotePath, ["rev-parse", "refs/heads/main"])).trim(),
            mainBefore,
          );
        }),
      ),
    );
  }
});

describeJj("JjRemotes.resolveRemoteTrackingCommit", () => {
  it.effect("retains process failures instead of reporting a missing remote branch", () =>
    withJjRepo({ prefix: "t3-jj-tracking-failure-" }, ({ driver, process, root }) =>
      Effect.gen(function* () {
        const cause = new VcsProcessSpawnError({
          operation: "test",
          command: "jj",
          cwd: root,
          cause: new Error("jj is unavailable"),
        });
        const remotes = makeJjRemotes({
          driver: { ...driver, changeAt: () => Effect.fail(cause) },
          process,
        });
        const failure = yield* remotes
          .resolveRemoteTrackingCommit({
            cwd: root,
            refName: "main",
            fallbackRemoteName: "origin",
          })
          .pipe(Effect.flip);
        assert.equal(failure.detail, "Could not resolve the remote bookmark.");
        assert.strictEqual(failure.cause, cause);
      }),
    ),
  );

  it.effect("resolves remote bookmark names containing revset punctuation literally", () =>
    withRemote(({ driver, remotes, root }) =>
      Effect.gen(function* () {
        yield* remotes.bookmarkTo({
          cwd: root,
          name: "fix(ui)",
          revset: "@-",
          operation: "test",
        });
        yield* remotes.pushBookmark({
          cwd: root,
          name: "fix(ui)",
          remoteName: "origin",
          operation: "test",
        });
        yield* remotes.fetchRemote({ cwd: root, remoteName: "origin", refName: "fix(ui)" });
        const expected = yield* driver.changeAt(root, "@-");
        const resolved = yield* remotes.resolveRemoteTrackingCommit({
          cwd: root,
          refName: "origin/fix(ui)",
          fallbackRemoteName: "origin",
        });
        assert.equal(resolved.commitSha, expected?.commitId);
      }),
    ),
  );
});

describeJj("JjRemotes metadata invalidation", () => {
  it.effect(
    "invalidates after bookmark creation, movement and fetch, but not no-ops or failures",
    () =>
      withJjRepo({ prefix: "t3-jj-remote-cache-", withRemote: true }, (repo) =>
        Effect.gen(function* () {
          const invalidate = vi.fn(repo.driver.invalidateRepoCaches);
          const remotes = makeJjRemotes({
            driver: { ...repo.driver, invalidateRepoCaches: invalidate },
            process: repo.process,
          });
          const input = { cwd: repo.root, name: "cache-test", revset: "@-", operation: "test" };
          yield* remotes.bookmarkTo(input);
          assert.equal(invalidate.mock.calls.length, 1);
          yield* remotes.bookmarkTo(input);
          assert.equal(invalidate.mock.calls.length, 1);

          yield* repo.fileSystem.writeFileString(repo.path.join(repo.root, "next.txt"), "next\n");
          yield* runJj(repo.root, ["commit", "-m", "next"]);
          yield* remotes.bookmarkTo(input);
          assert.equal(invalidate.mock.calls.length, 2);

          yield* remotes.fetchRemote({ cwd: repo.root, remoteName: "origin" });
          assert.equal(invalidate.mock.calls.length, 3);
          yield* remotes.fetchRemote({ cwd: repo.root, remoteName: "missing" }).pipe(Effect.flip);
          assert.equal(invalidate.mock.calls.length, 3);
        }),
      ),
  );
});

describeJj("JjRemotes private remote freshness", () => {
  it.effect("clears captured refs only for the successfully fetched remote", () =>
    withJjRepo({ prefix: "t3-jj-fetch-private-", withRemote: true }, (repo) =>
      Effect.gen(function* () {
        const oid = (yield* runGit(repo.root, ["rev-parse", "refs/heads/main"])).trim();
        const refs = [
          "refs/t3/remotes/origin/main",
          "refs/t3/remotes/origin/other",
          "refs/t3/remotes/untouched/main",
          "refs/t3/remotes/missing/main",
        ];
        for (const ref of refs) {
          yield* runGit(repo.root, ["update-ref", ref, oid]);
        }
        const remotes = makeJjRemotes({ driver: repo.driver, process: repo.process });
        yield* remotes.fetchRemote({ cwd: repo.root, remoteName: "missing" }).pipe(Effect.flip);
        assert.equal((yield* runGit(repo.root, ["rev-parse", refs[3]!])).trim(), oid);
        yield* remotes.fetchRemote({ cwd: repo.root, remoteName: "origin" });
        assert.equal(
          (yield* runGit(repo.root, [
            "for-each-ref",
            "--format=%(refname)",
            "refs/t3/remotes/origin/",
          ])).trim(),
          "",
        );
        assert.equal((yield* runGit(repo.root, ["rev-parse", refs[2]!])).trim(), oid);
      }),
    ),
  );

  it.effect("clears only the successfully pushed bookmark's captured private ref", () =>
    withJjRepo({ prefix: "t3-jj-push-private-", withRemote: true }, (repo) =>
      Effect.gen(function* () {
        const oid = (yield* runGit(repo.root, ["rev-parse", "refs/heads/main"])).trim();
        const pushedRef = "refs/t3/remotes/origin/main";
        const untouchedRef = "refs/t3/remotes/origin/other";
        yield* runGit(repo.root, ["update-ref", pushedRef, oid]);
        yield* runGit(repo.root, ["update-ref", untouchedRef, oid]);
        yield* repo.fileSystem.writeFileString(repo.path.join(repo.root, "pushed.txt"), "pushed\n");
        yield* runJj(repo.root, ["commit", "-m", "Pushed work"]);
        const remotes = makeJjRemotes({ driver: repo.driver, process: repo.process });
        const result = yield* remotes.pushBookmark({
          cwd: repo.root,
          name: "main",
          remoteName: "origin",
          operation: "test",
        });
        assert.equal(result.status, "pushed");
        assert.equal(
          (yield* runGit(repo.root, ["for-each-ref", "--format=%(refname)", pushedRef])).trim(),
          "",
        );
        assert.equal((yield* runGit(repo.root, ["rev-parse", untouchedRef])).trim(), oid);
      }),
    ),
  );

  for (const mode of ["race", "error"] as const) {
    it.effect(
      mode === "race"
        ? "preserves a newer background fetch when compare-delete loses the race"
        : "propagates real private ref deletion errors",
      () =>
        withJjRepo({ prefix: `t3-jj-private-${mode}-`, withRemote: true }, (repo) =>
          Effect.gen(function* () {
            const ref = "refs/t3/remotes/origin/main";
            const oldOid = (yield* runGit(repo.root, ["rev-parse", "refs/heads/main"])).trim();
            yield* runGit(repo.root, ["update-ref", ref, oldOid]);
            yield* repo.fileSystem.writeFileString(
              repo.path.join(repo.root, "newer.txt"),
              "newer\n",
            );
            yield* runJj(repo.root, ["commit", "-m", "New background target"]);
            const newerOid = (yield* repo.driver.changeAt(repo.root, "@-"))!.commitId;
            let deletionAttempts = 0;
            const remotes = makeJjRemotes({
              driver: repo.driver,
              process: {
                ...repo.process,
                run: (input) =>
                  Effect.gen(function* () {
                    if (input.command === "git" && input.args.includes("update-ref")) {
                      deletionAttempts += 1;
                      assert.deepStrictEqual(input.args.slice(-4), [
                        "update-ref",
                        "-d",
                        ref,
                        oldOid,
                      ]);
                      if (mode === "error") {
                        return yield* repo.process.run({
                          ...input,
                          args: [
                            "-c",
                            "alias.t3-denied=!printf 'fatal: Permission denied' >&2; exit 1",
                            "t3-denied",
                          ],
                          allowNonZeroExit: true,
                        });
                      }
                      yield* runGit(repo.root, ["update-ref", ref, newerOid]).pipe(Effect.orDie);
                    }
                    return yield* repo.process.run(input);
                  }),
              },
            });
            const fetch = remotes.fetchRemote({ cwd: repo.root, remoteName: "origin" });
            if (mode === "error") {
              const failure = yield* fetch.pipe(Effect.flip);
              assert.include(failure.detail, "Permission denied");
            } else {
              yield* fetch;
            }
            assert.equal(deletionAttempts, 1);
            assert.equal(
              (yield* runGit(repo.root, ["rev-parse", ref])).trim(),
              mode === "race" ? newerOid : oldOid,
            );
          }),
        ),
    );
  }
});

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
  it.effect("refuses to publish an imported fork alias to the primary remote", () =>
    withRemote(({ driver, remotes, root }) =>
      Effect.gen(function* () {
        const alias = "t3code/pr-7/main";
        yield* runJj(root, ["bookmark", "create", alias, "-r", "@-"]);
        yield* runGit(root, ["config", `branch.${alias}.remote`, "contributor"]);
        yield* runGit(root, ["config", `branch.${alias}.merge`, "refs/heads/main"]);
        yield* runGit(root, ["config", `branch.${alias}.t3code-imported-pr-head`, "true"]);
        const before = (yield* driver.changeAt(root, `bookmarks(exact:"${alias}")`))?.commitId;
        const failure = yield* remotes
          .pushBookmark({ cwd: root, name: alias, remoteName: "origin", operation: "test" })
          .pipe(Effect.flip);
        assert.include(failure.detail, "source repository");
        assert.equal(
          (yield* driver.changeAt(root, `bookmarks(exact:"${alias}")`))?.commitId,
          before,
        );
        assert.isFalse(
          (yield* driver.listBookmarks(root)).some(
            (bookmark) => bookmark.name === alias && bookmark.remote === "origin",
          ),
        );
      }),
    ),
  );

  it.effect("pushes to a remote whose name contains glob punctuation literally", () =>
    withJjRepo({ prefix: "t3-jj-push-pattern-", withRemote: true }, (repo) =>
      Effect.gen(function* () {
        const { driver, fileSystem, path, process, root } = repo;
        const remoteName = "review{one,two}";
        yield* runJj(root, ["git", "remote", "rename", "origin", remoteName]);
        yield* fileSystem.writeFileString(path.join(root, "one.txt"), "one\n");
        yield* runJj(root, ["commit", "-m", "one"]);
        const result = yield* makeJjRemotes({ driver, process }).pushBookmark({
          cwd: root,
          name: "main",
          remoteName,
          operation: "test",
        });
        assert.equal(result.status, "pushed");
        const pushed = (yield* driver.listBookmarks(root)).find(
          (bookmark) => bookmark.name === "main" && bookmark.remote === remoteName,
        );
        assert.equal(pushed?.target, (yield* driver.changeAt(root, "@-"))?.commitId);
      }),
    ),
  );

  it.effect(
    "pushes to the requested remote despite another configured upstream, then skips if up to date",
    () =>
      withRemote(({ fileSystem, path, remotes, root }) =>
        Effect.gen(function* () {
          yield* fileSystem.writeFileString(path.join(root, "one.txt"), "one\n");
          yield* runJj(root, ["commit", "-m", "one"]);
          yield* runGit(root, ["config", "branch.main.remote", "upstream"]);
          yield* runGit(root, ["config", "branch.main.merge", "refs/heads/base"]);

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

        assert.include(failure.detail, "includes your working copy");
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
  for (const race of [false, true]) {
    it.effect(`preserves the working-copy change on pull with racing edits=${race}`, () =>
      withJjRepo({ prefix: "t3-jj-pull-preserve-", withRemote: true }, (repo) =>
        Effect.gen(function* () {
          const peer = repo.path.join(repo.base, "peer");
          yield* repo.fileSystem.makeDirectory(peer);
          yield* runJj(peer, ["git", "clone", "--colocate", repo.remotePath, peer]);
          yield* repo.fileSystem.writeFileString(repo.path.join(peer, "peer.txt"), "peer\n");
          yield* runJj(peer, ["commit", "-m", "peer"]);
          yield* runJj(peer, ["bookmark", "set", "main", "-r", "@-"]);
          yield* runJj(peer, ["git", "push", "--bookmark", "main", "--remote", "origin"]);
          yield* runJj(repo.root, ["new", "main"]);
          yield* runJj(repo.root, ["describe", "-m", "Keep my planned change"]);
          const before = yield* repo.driver.currentChange(repo.root);
          const changeId = yield* runJj(repo.root, [
            "log",
            "--no-graph",
            "-r",
            "@",
            "-T",
            "change_id",
          ]);
          let injected = false;
          const process: typeof repo.process = {
            run: (input) =>
              Effect.gen(function* () {
                if (
                  race &&
                  !injected &&
                  (input.args.includes("new") || input.args.includes("rebase"))
                ) {
                  injected = true;
                  yield* repo.fileSystem
                    .writeFileString(repo.path.join(repo.root, "racing.txt"), "racing\n")
                    .pipe(Effect.orDie);
                }
                return yield* repo.process.run(input);
              }),
          };
          const result = yield* makeJjRemotes({ driver: repo.driver, process }).pullCurrentBranch(
            repo.root,
          );
          assert.equal(result.status, "pulled");
          if (race)
            assert.isTrue(yield* repo.fileSystem.exists(repo.path.join(repo.root, "racing.txt")));
          const after = yield* repo.driver.currentChange(repo.root);
          assert.equal(
            yield* runJj(repo.root, ["log", "--no-graph", "-r", "@", "-T", "change_id"]),
            changeId,
          );
          assert.equal(after.description, before.description);
          assert.isTrue(yield* repo.fileSystem.exists(repo.path.join(repo.root, "peer.txt")));
          if (race) {
            assert.isTrue(injected);
            assert.equal(
              yield* repo.fileSystem.readFileString(repo.path.join(repo.root, "racing.txt")),
              "racing\n",
            );
          }
        }),
      ),
    );
  }

  for (const name of ["aaa-thread", "zzz-thread"]) {
    it.effect(`pulls ${name} only from its managed workspace`, () =>
      withJjRepo({ prefix: "t3-jj-pull-managed-", withRemote: true }, (repo) =>
        Effect.gen(function* () {
          const child = repo.path.join(repo.base, "child");
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
            child,
          ]);
          const remotes = makeJjRemotes({ driver: repo.driver, process: repo.process });
          const pulled = yield* remotes.pullCurrentBranch(child);
          assert.equal(pulled.refName, name);
          assert.equal(pulled.upstreamRef, `origin/${name}`);
          assert.equal(pulled.status, "skipped_up_to_date");
          assert.equal((yield* remotes.pullCurrentBranch(repo.root)).refName, "main");

          yield* runJj(child, ["bookmark", "delete", name]);
          const failure = yield* remotes.pullCurrentBranch(child).pipe(Effect.flip);
          assert.include(failure.detail, "not on a bookmark");
        }),
      ),
    );
  }

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
