import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  SourceControlProviderError,
  SourceControlProviderKind,
  ThreadId,
  type ChangeRequest,
} from "@t3tools/contracts";

import * as GitManager from "../git/GitManager.ts";
import type * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import { describeJj, runGit, runJj, withJjRepo } from "../vcs/testing/JjTestSupport.ts";
import {
  makeJjPullRequestThread,
  type JjPullRequestThreadDeps,
  type JjPullRequestThreadOps,
} from "./JjPullRequestThread.ts";
import { makeJjRefs } from "./JjRefs.ts";
import { makeJjRemotes } from "./JjRemotes.ts";
import { makeJjWorkspaces } from "./JjWorkspaces.ts";

const changeRequest = (input: {
  readonly headRefName: string;
  readonly isCrossRepository?: boolean;
  readonly state?: ChangeRequest["state"];
  readonly url?: string;
  readonly headRepositoryNameWithOwner?: string;
}): ChangeRequest => ({
  provider: SourceControlProviderKind.make("github"),
  number: 7,
  title: "Add the thing",
  url: input.url ?? "https://example.com/pull/7",
  baseRefName: "main",
  headRefName: input.headRefName,
  state: input.state ?? "open",
  updatedAt: Option.none(),
  ...(input.isCrossRepository === true ? { isCrossRepository: true } : {}),
  ...(input.headRepositoryNameWithOwner !== undefined
    ? { headRepositoryNameWithOwner: input.headRepositoryNameWithOwner }
    : {}),
});

const providersFor = (
  summary: ChangeRequest,
  forkPath: string,
  providerError?: SourceControlProviderError,
) =>
  SourceControlProviderRegistry.SourceControlProviderRegistry.pipe(
    Effect.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
        resolve: () =>
          providerError?.operation === "resolve"
            ? Effect.fail(providerError)
            : SourceControlProvider.SourceControlProvider.pipe(
                Effect.provide(
                  Layer.mock(SourceControlProvider.SourceControlProvider)({
                    kind: SourceControlProviderKind.make("github"),
                    getChangeRequest: () =>
                      providerError?.operation === "getChangeRequest"
                        ? Effect.fail(providerError)
                        : Effect.succeed(summary),
                    getRepositoryCloneUrls: ({ repository }) => {
                      if (providerError?.operation === "getRepositoryCloneUrls") {
                        return Effect.fail(providerError);
                      }
                      assert.equal(repository, "contributor/repo");
                      return Effect.succeed({
                        nameWithOwner: repository,
                        url: forkPath,
                        sshUrl: forkPath,
                      });
                    },
                  }),
                ),
              ),
      }),
    ),
  );

interface ThreadFixture {
  readonly driver: JjVcsDriver.JjVcsDriverShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly ops: JjPullRequestThreadOps;
  readonly setupScriptRuns: Array<string>;
  readonly root: string;
  readonly remotePath: string;
  readonly forkPath: string;
}

const withRepo = <A, E>(
  input: {
    readonly summary: ChangeRequest;
    readonly providerError?: SourceControlProviderError;
    readonly readWorktreeSubmodules?: JjPullRequestThreadDeps["readWorktreeSubmodules"];
  },
  use: (fixture: ThreadFixture) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  withJjRepo({ prefix: "t3-jj-pr-", withRemote: true }, (repo) =>
    Effect.gen(function* () {
      const { base, driver, fileSystem, path, process, remotePath, root } = repo;
      const forkPath = path.join(base, "fork.git");
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
      const setupScriptRuns: Array<string> = [];
      const projectSetupScriptRunner: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"] =
        {
          runForThread: (runInput) =>
            Effect.sync(() => {
              setupScriptRuns.push(runInput.worktreePath);
              return { status: "no-script" as const };
            }),
        };

      const ops = makeJjPullRequestThread({
        driver,
        process,
        refs,
        workspaces,
        gitManager: yield* GitManager.GitManager.pipe(
          Effect.provide(Layer.mock(GitManager.GitManager)({})),
        ),
        sourceControlProviders: yield* providersFor(input.summary, forkPath, input.providerError),
        projectSetupScriptRunner,
        invalidateStatus: () => Effect.void,
        readWorktreeSubmodules: input.readWorktreeSubmodules ?? (() => Effect.succeed(null)),
      });

      return yield* use({
        driver,
        fileSystem,
        path,
        ops,
        setupScriptRuns,
        root,
        remotePath,
        forkPath,
      });
    }),
  );

describeJj("JjPullRequestThread worktree mode", () => {
  it.effect("uses the requesting thread's submodule policy for the pull-request workspace", () => {
    const threadId = ThreadId.make("submodules-thread");
    return withRepo(
      {
        summary: changeRequest({ headRefName: "feat/pr" }),
        readWorktreeSubmodules: (input) => {
          assert.equal(input.threadId, threadId);
          return Effect.succeed("none");
        },
      },
      ({ fileSystem, ops, path, remotePath, root }) =>
        Effect.gen(function* () {
          yield* runGit(root, [
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            remotePath,
            "modules/tool",
          ]);
          yield* runGit(root, [
            "-c",
            "user.name=T3",
            "-c",
            "user.email=t3@example.com",
            "commit",
            "-am",
            "Add submodule",
          ]);
          yield* runJj(root, ["git", "import"]);
          yield* runJj(root, ["bookmark", "create", "feat/pr", "-r", "@-"]);
          yield* runJj(root, ["git", "push", "--bookmark", "feat/pr", "--remote", "origin"]);

          const prepared = yield* ops.preparePullRequestThread({
            cwd: root,
            reference: "7",
            mode: "worktree",
            threadId,
          });
          assert.isNotNull(prepared.worktreePath);
          assert.isTrue(yield* fileSystem.exists(path.join(prepared.worktreePath!, ".gitmodules")));
          assert.isFalse(
            yield* fileSystem.exists(path.join(prepared.worktreePath!, "modules/tool/.git")),
          );
        }),
    );
  });

  for (const operation of ["resolve", "getChangeRequest", "getRepositoryCloneUrls"]) {
    it.effect(`preserves the ${operation} hosting error`, () => {
      const cause = new SourceControlProviderError({
        provider: SourceControlProviderKind.make("github"),
        operation,
        cwd: "/unused",
        detail: "Authenticate with the source repository.",
      });
      return withRepo(
        {
          summary: changeRequest({
            headRefName: "their-branch",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "contributor/repo",
          }),
          providerError: cause,
        },
        ({ ops, root }) =>
          Effect.gen(function* () {
            const failure = yield* ops
              .preparePullRequestThread({ cwd: root, reference: "7", mode: "worktree" })
              .pipe(Effect.flip);
            assert.strictEqual(failure, cause);
          }),
      );
    });
  }

  for (const headBranch of ["their-branch", "main"]) {
    it.effect(`imports fork ${headBranch} from provider metadata without moving main`, () =>
      withRepo(
        {
          summary: changeRequest({
            headRefName: headBranch,
            isCrossRepository: true,
            headRepositoryNameWithOwner: "contributor/repo",
            url: "https://gitcafe.example/team/repo/pull/7",
          }),
        },
        ({ driver, fileSystem, forkPath, ops, path, remotePath, root }) =>
          Effect.gen(function* () {
            const mainBefore = (yield* driver.changeAt(root, "main"))?.commitId;
            yield* runGit(root, ["clone", "--bare", remotePath, forkPath]);
            yield* fileSystem.writeFileString(path.join(root, "fork.txt"), "fork\n");
            yield* runJj(root, ["commit", "-m", "Fork work"]);
            const head = (yield* driver.changeAt(root, "@-"))?.commitId;
            assert.isDefined(head);
            yield* runGit(root, ["push", forkPath, `${head}:refs/heads/${headBranch}`]);
            const prepared = yield* ops.preparePullRequestThread({
              cwd: root,
              reference: "7",
              mode: "worktree",
            });
            const localBranch = `t3code/pr-7/${headBranch}`;
            assert.equal(prepared.branch, localBranch);
            assert.isTrue(prepared.isOnPullRequestHead);
            assert.equal(
              (yield* driver.changeAt(root, `bookmarks(exact:"${localBranch}")`))?.commitId,
              head,
            );
            assert.equal(
              (yield* runGit(root, ["config", `branch.${localBranch}.remote`])).trim(),
              "contributor",
            );
            assert.equal(
              (yield* runGit(root, ["config", `branch.${localBranch}.merge`])).trim(),
              `refs/heads/${headBranch}`,
            );
            assert.equal(
              (yield* runGit(root, [
                "config",
                `branch.${localBranch}.t3code-imported-pr-head`,
              ])).trim(),
              "true",
            );
            assert.isFalse(
              (yield* driver.listBookmarks(root)).some(
                (bookmark) => bookmark.remote === "contributor" && bookmark.name === headBranch,
              ),
            );
            assert.equal((yield* driver.changeAt(root, "main"))?.commitId, mainBefore);
            yield* fileSystem.writeFileString(path.join(root, "fork-more.txt"), "more\n");
            yield* runJj(root, ["commit", "-m", "More fork work"]);
            const updatedHead = (yield* driver.changeAt(root, "@-"))?.commitId;
            assert.isDefined(updatedHead);
            yield* runGit(root, ["push", forkPath, `${updatedHead}:refs/heads/${headBranch}`]);
            yield* ops.preparePullRequestThread({ cwd: root, reference: "7", mode: "worktree" });
            assert.equal(
              (yield* driver.changeAt(root, `bookmarks(exact:"${localBranch}")`))?.commitId,
              updatedHead,
            );
            const worktreePath = prepared.worktreePath;
            if (worktreePath === null) throw new Error("Expected a pull-request workspace");
            yield* runJj(worktreePath, ["new", `bookmarks(exact:"${localBranch}")`]);
            yield* fileSystem.writeFileString(path.join(worktreePath, "local.txt"), "local\n");
            yield* runJj(worktreePath, ["commit", "-m", "Local PR work"]);
            yield* runJj(worktreePath, ["bookmark", "set", localBranch, "-r", "@-"]);
            const localHead = (yield* driver.changeAt(root, `bookmarks(exact:"${localBranch}")`))
              ?.commitId;
            yield* fileSystem.writeFileString(path.join(root, "fork-diverged.txt"), "diverged\n");
            yield* runJj(root, ["commit", "-m", "Diverging fork work"]);
            const divergedHead = (yield* driver.changeAt(root, "@-"))?.commitId;
            assert.isDefined(divergedHead);
            yield* runGit(root, ["push", forkPath, `${divergedHead}:refs/heads/${headBranch}`]);
            const reused = yield* ops.preparePullRequestThread({
              cwd: root,
              reference: "7",
              mode: "worktree",
            });
            assert.isFalse(reused.isOnPullRequestHead);
            assert.equal(
              (yield* driver.changeAt(root, `bookmarks(exact:"${localBranch}")`))?.commitId,
              localHead,
            );
            assert.equal((yield* driver.changeAt(root, "main"))?.commitId, mainBefore);
          }),
      ),
    );
  }

  for (const hasPullRef of [true, false]) {
    it.effect(
      hasPullRef
        ? "opens a deleted source head through the retained pull-request ref"
        : "preserves both causes when source and pull-request refs are unavailable",
      () =>
        withRepo(
          {
            summary: changeRequest({
              headRefName: "deleted-head",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "contributor/repo",
              state: "closed",
            }),
          },
          ({ driver, forkPath, ops, remotePath, root }) =>
            Effect.gen(function* () {
              yield* runGit(root, ["clone", "--bare", remotePath, forkPath]);
              const head = (yield* driver.changeAt(root, "main"))?.commitId;
              assert.isDefined(head);
              if (hasPullRef) {
                yield* runGit(remotePath, ["update-ref", "refs/pull/7/head", head ?? ""]);
                const prepared = yield* ops.preparePullRequestThread({
                  cwd: root,
                  reference: "7",
                  mode: "worktree",
                });
                assert.equal(prepared.branch, "t3code/pr-7/deleted-head");
                assert.isTrue(prepared.isOnPullRequestHead);
              } else {
                const failure = yield* ops
                  .preparePullRequestThread({
                    cwd: root,
                    reference: "7",
                    mode: "worktree",
                  })
                  .pipe(Effect.flip);
                if (failure._tag !== "GitPullRequestMaterializationError") throw failure;
                const cause = failure.cause;
                assert.instanceOf(cause, AggregateError);
                if (!(cause instanceof AggregateError))
                  throw new Error("Expected both fetch causes");
                assert.lengthOf(cause.errors, 2);
              }
              assert.isFalse(
                (yield* driver.listBookmarks(root)).some((bookmark) =>
                  bookmark.name.startsWith("t3code/import/"),
                ),
              );
            }),
        ),
    );
  }

  it.effect("runs the project setup script after creating and after reusing the workspace", () =>
    withRepo(
      {
        summary: changeRequest({
          headRefName: "feat/pr",
          headRepositoryNameWithOwner: "team/repo",
        }),
      },
      ({ ops, root, setupScriptRuns }) =>
        Effect.gen(function* () {
          yield* runJj(root, ["bookmark", "create", "feat/pr", "-r", "@-"]);
          yield* runJj(root, ["git", "push", "--bookmark", "feat/pr", "--remote", "origin"]);

          const first = yield* ops.preparePullRequestThread({
            cwd: root,
            reference: "7",
            mode: "worktree",
            threadId: ThreadId.make("thread-1"),
          });
          const second = yield* ops.preparePullRequestThread({
            cwd: root,
            reference: "7",
            mode: "worktree",
            threadId: ThreadId.make("thread-1"),
          });

          assert.equal(first.worktreePath, second.worktreePath);
          assert.equal(first.branch, "feat/pr");
          assert.isTrue(first.isOnPullRequestHead);
          assert.deepStrictEqual(setupScriptRuns, [first.worktreePath, second.worktreePath]);
        }),
    ),
  );

  it.effect("materialises a fork head that only exists as refs/pull/<n>/head", () =>
    withRepo(
      { summary: changeRequest({ headRefName: "their-branch", isCrossRepository: true }) },
      ({ fileSystem, ops, path, remotePath, root }) =>
        Effect.gen(function* () {
          yield* fileSystem.writeFileString(path.join(root, "fork.txt"), "fork\n");
          yield* runJj(root, ["commit", "-m", "fork work"]);
          yield* runJj(root, ["bookmark", "create", "fork-head", "-r", "@-"]);
          yield* runJj(root, ["git", "push", "--bookmark", "fork-head", "--remote", "origin"]);
          const forkCommit = (yield* runGit(remotePath, [
            "rev-parse",
            "refs/heads/fork-head",
          ])).trim();
          yield* runGit(remotePath, ["update-ref", "refs/pull/7/head", forkCommit]);
          yield* runGit(remotePath, ["update-ref", "-d", "refs/heads/fork-head"]);

          const prepared = yield* ops.preparePullRequestThread({
            cwd: root,
            reference: "7",
            mode: "worktree",
          });

          assert.equal(prepared.branch, "t3code/pr-7/their-branch");
          assert.isTrue(prepared.isOnPullRequestHead);
        }),
    ),
  );

  it.effect("fetches an open same-repository head by name when no pull ref exists", () =>
    withRepo(
      {
        summary: changeRequest({
          headRefName: "feat/pr",
          url: "https://gitlab.example/team/repo/-/merge_requests/7",
        }),
      },
      ({ driver, ops, remotePath, root }) =>
        Effect.gen(function* () {
          const headCommit = (yield* runGit(remotePath, ["rev-parse", "refs/heads/main"])).trim();
          yield* runGit(remotePath, ["update-ref", "refs/heads/feat/pr", headCommit]);
          yield* runGit(root, [
            "config",
            "remote.origin.url",
            "https://gitlab.example/team/repo.git",
          ]);
          yield* runGit(root, [
            "config",
            `url.${remotePath}.insteadOf`,
            "https://gitlab.example/team/repo.git",
          ]);
          assert.isFalse(
            (yield* driver.listBookmarks(root)).some((bookmark) => bookmark.name === "feat/pr"),
          );

          const prepared = yield* ops.preparePullRequestThread({
            cwd: root,
            reference: "7",
            mode: "worktree",
          });

          assert.equal(prepared.branch, "feat/pr");
          assert.isTrue(prepared.isOnPullRequestHead);
          assert.equal(
            (yield* runGit(root, ["rev-parse", "refs/heads/feat/pr"])).trim(),
            headCommit,
          );
          const headOnRemote = (yield* driver.listBookmarks(root)).find(
            (bookmark) => bookmark.name === "feat/pr" && bookmark.remote === "origin",
          );
          assert.isDefined(headOnRemote);
          assert.isTrue(headOnRemote?.tracked);
          assert.equal(headOnRemote?.target, headCommit);
        }),
    ),
  );

  for (const guard of [
    { name: "fork", isCrossRepository: true },
    { name: "closed", state: "closed" },
    { name: "merged", state: "merged" },
    { name: "different repository", url: "https://gitlab.example/other/repo/-/merge_requests/7" },
    { name: "unrecognized repository", url: "https://gitlab.example/not-a-pull-request" },
  ] as const) {
    it.effect(`does not fall back to a branch name for a ${guard.name} pull request`, () =>
      withRepo(
        {
          summary: changeRequest({
            headRefName: "feat/pr",
            url: "https://gitlab.example/team/repo/-/merge_requests/7",
            ...guard,
          }),
        },
        ({ driver, ops, remotePath, root }) =>
          Effect.gen(function* () {
            const headCommit = (yield* runGit(remotePath, ["rev-parse", "refs/heads/main"])).trim();
            yield* runGit(remotePath, ["update-ref", "refs/heads/feat/pr", headCommit]);
            yield* runGit(root, [
              "config",
              "remote.origin.url",
              "https://gitlab.example/team/repo.git",
            ]);
            yield* runGit(root, [
              "config",
              `url.${remotePath}.insteadOf`,
              "https://gitlab.example/team/repo.git",
            ]);

            const failure = yield* ops
              .preparePullRequestThread({ cwd: root, reference: "7", mode: "worktree" })
              .pipe(Effect.flip);

            assert.equal(failure._tag, "GitCommandError");
            assert.isFalse(
              (yield* driver.listBookmarks(root)).some((bookmark) => bookmark.name === "feat/pr"),
            );
          }),
      ),
    );
  }
});

describeJj("JjPullRequestThread local mode", () => {
  it.effect("refuses to strand an unbookmarked commit before moving onto the head", () =>
    withRepo(
      { summary: changeRequest({ headRefName: "feat/pr" }) },
      ({ fileSystem, ops, path, root }) =>
        Effect.gen(function* () {
          yield* runJj(root, ["bookmark", "create", "feat/pr", "-r", "@-"]);
          yield* runJj(root, ["git", "push", "--bookmark", "feat/pr", "--remote", "origin"]);
          yield* runJj(root, ["new", 'bookmarks(exact:"main")']);
          yield* fileSystem.writeFileString(path.join(root, "agent.txt"), "agent\n");
          yield* runJj(root, ["commit", "-m", "agent work"]);

          const failure = yield* ops
            .preparePullRequestThread({ cwd: root, reference: "7", mode: "local" })
            .pipe(Effect.flip);
          assert.equal(failure._tag, "GitCommandError");
          if (failure._tag !== "GitCommandError") return;

          assert.include(failure.detail, "not on a bookmark yet");
        }),
    ),
  );

  it.effect("moves onto the head and reports being on it", () =>
    withRepo({ summary: changeRequest({ headRefName: "feat/pr" }) }, ({ ops, root }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["bookmark", "create", "feat/pr", "-r", "@-"]);
        yield* runJj(root, ["git", "push", "--bookmark", "feat/pr", "--remote", "origin"]);

        const prepared = yield* ops.preparePullRequestThread({
          cwd: root,
          reference: "7",
          mode: "local",
        });

        assert.equal(prepared.branch, "feat/pr");
        assert.equal(prepared.worktreePath, null);
        assert.isTrue(prepared.isOnPullRequestHead);
      }),
    ),
  );
});
