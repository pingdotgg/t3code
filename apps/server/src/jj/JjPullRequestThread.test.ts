import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import type { ChangeRequest, ThreadId } from "@t3tools/contracts";

import * as GitManager from "../git/GitManager.ts";
import type * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as SourceControlProvider from "../sourceControl/SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import { describeJj, runGit, runJj, withJjRepo } from "../vcs/testing/JjTestSupport.ts";
import { makeJjPullRequestThread, type JjPullRequestThreadOps } from "./JjPullRequestThread.ts";
import { makeJjRefs } from "./JjRefs.ts";
import { makeJjRemotes } from "./JjRemotes.ts";
import { makeJjWorkspaces } from "./JjWorkspaces.ts";

const changeRequest = (input: {
  readonly headRefName: string;
  readonly isCrossRepository?: boolean;
}): ChangeRequest =>
  ({
    provider: "github",
    number: 7,
    title: "Add the thing",
    url: "https://example.com/pull/7",
    baseRefName: "main",
    headRefName: input.headRefName,
    state: "open",
    ...(input.isCrossRepository === true ? { isCrossRepository: true } : {}),
  }) as ChangeRequest;

const providersFor = (summary: ChangeRequest) =>
  SourceControlProviderRegistry.SourceControlProviderRegistry.pipe(
    Effect.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolve: () =>
          SourceControlProvider.SourceControlProvider.pipe(
            Effect.provide(
              Layer.mock(SourceControlProvider.SourceControlProvider)({
                kind: "github",
                getChangeRequest: () => Effect.succeed(summary),
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
}

const withRepo = <A, E>(
  input: { readonly summary: ChangeRequest },
  use: (fixture: ThreadFixture) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  withJjRepo({ prefix: "t3-jj-pr-", withRemote: true }, (repo) =>
    Effect.gen(function* () {
      const { base, driver, fileSystem, path, process, remotePath, root } = repo;
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
        sourceControlProviders: yield* providersFor(input.summary),
        projectSetupScriptRunner,
        invalidateStatus: () => Effect.void,
      });

      return yield* use({ driver, fileSystem, path, ops, setupScriptRuns, root, remotePath });
    }),
  );

describeJj("JjPullRequestThread worktree mode", () => {
  it.effect("runs the project setup script after creating and after reusing the workspace", () =>
    withRepo(
      { summary: changeRequest({ headRefName: "feat/pr" }) },
      ({ ops, root, setupScriptRuns }) =>
        Effect.gen(function* () {
          yield* runJj(root, ["bookmark", "create", "feat/pr", "-r", "@-"]);
          yield* runJj(root, ["git", "push", "--bookmark", "feat/pr", "--remote", "origin"]);

          const first = yield* ops.preparePullRequestThread({
            cwd: root,
            reference: "7",
            mode: "worktree",
            threadId: "thread-1" as ThreadId,
          });
          const second = yield* ops.preparePullRequestThread({
            cwd: root,
            reference: "7",
            mode: "worktree",
            threadId: "thread-1" as ThreadId,
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
