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

interface RemotesFixture {
  readonly driver: JjVcsDriver.JjVcsDriverShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly remotes: JjRemoteOps;
  readonly root: string;
}

const withRemote = <A, E>(
  use: (fixture: RemotesFixture) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  withJjRepo({ prefix: "t3-jj-remotes-", withRemote: true }, (repo) =>
    Effect.gen(function* () {
      const { driver, fileSystem, path, process, root } = repo;
      const remotes = makeJjRemotes({ driver, process });

      return yield* use({ driver, fileSystem, path, remotes, root });
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
        yield* runJj(root, [
          "git",
          "push",
          "--bookmark",
          'exact:"fix(ui)"',
          "--remote",
          "origin",
        ]);
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
        assert.equal(
          (yield* runGit(repo.root, ["rev-parse", refs[3]!])).trim(),
          oid,
        );
        yield* remotes.fetchRemote({ cwd: repo.root, remoteName: "origin" });
        assert.equal(
          (yield* runGit(repo.root, ["for-each-ref", "--format=%(refname)", "refs/t3/remotes/origin/"])).trim(),
          "",
        );
        assert.equal(
          (yield* runGit(repo.root, ["rev-parse", refs[2]!])).trim(),
          oid,
        );
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
            yield* repo.fileSystem.writeFileString(repo.path.join(repo.root, "newer.txt"), "newer\n");
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
                      assert.deepStrictEqual(input.args.slice(-4), ["update-ref", "-d", ref, oldOid]);
                      if (mode === "error") {
                        return yield* repo.process.run({
                          ...input,
                          args: ["-c", "alias.t3-denied=!printf 'fatal: Permission denied' >&2; exit 1", "t3-denied"],
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
