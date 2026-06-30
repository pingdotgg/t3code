import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const processOutputWithExit = (
  stdout: string,
  exitCode: number,
  stderr = "",
): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout,
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();

const layer = GitHubCli.layer.pipe(
  Layer.provide(
    Layer.mock(VcsProcess.VcsProcess)({
      run: mockRun,
    }),
  ),
);

afterEach(() => {
  mockRun.mockReset();
});

describe("GitHubCli.layer", () => {
  it("does not classify a missing cwd as an unavailable gh executable", () => {
    const context = { command: "gh", cwd: "/repo" } as const;
    const missingCwd = new VcsProcessSpawnError({
      operation: "GitHubCli.execute",
      command: "gh",
      cwd: context.cwd,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method: "access",
        pathOrDescriptor: context.cwd,
      }),
    });

    const commandFailure = GitHubCli.fromVcsError(context, missingCwd);

    assert.equal(commandFailure._tag, "GitHubCliCommandError");
    assert.strictEqual(commandFailure.cause, missingCwd);
    assert.notProperty(commandFailure, "operation");
  });

  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 42,
              title: "Add PR thread creation",
              url: "https://github.com/pingdotgg/codething-mvp/pull/42",
              baseRefName: "main",
              headRefName: "feature/pr-threads",
              state: "OPEN",
              mergedAt: null,
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: "octocat/codething-mvp",
              },
              headRepositoryOwner: {
                login: "octocat",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: [
          "pr",
          "view",
          "#42",
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("trims pull request fields decoded from gh json", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 42,
              title: "  Add PR thread creation  \n",
              url: " https://github.com/pingdotgg/codething-mvp/pull/42 ",
              baseRefName: " main ",
              headRefName: "\tfeature/pr-threads\t",
              state: "OPEN",
              mergedAt: null,
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: " octocat/codething-mvp ",
              },
              headRepositoryOwner: {
                login: " octocat ",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("skips invalid entries when parsing pr lists", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 0,
                title: "invalid",
                url: "https://github.com/pingdotgg/codething-mvp/pull/0",
                baseRefName: "main",
                headRefName: "feature/invalid",
              },
              {
                number: 43,
                title: "  Valid PR  ",
                url: " https://github.com/pingdotgg/codething-mvp/pull/43 ",
                baseRefName: " main ",
                headRefName: " feature/pr-list ",
                headRepository: {
                  nameWithOwner: "   ",
                },
                headRepositoryOwner: {
                  login: "   ",
                },
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenPullRequests({
        cwd: "/repo",
        headSelector: "feature/pr-list",
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/43",
          baseRefName: "main",
          headRefName: "feature/pr-list",
          state: "open",
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              nameWithOwner: "octocat/codething-mvp",
              url: "https://github.com/octocat/codething-mvp",
              sshUrl: "git@github.com:octocat/codething-mvp.git",
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates repositories and parses clone URLs from create output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            "✓ Created repository octocat/codething-mvp on github.com\nhttps://github.com/octocat/codething-mvp\n",
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockRun).toHaveBeenNthCalledWith(1, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["repo", "create", "octocat/codething-mvp", "--private"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("falls back to constructed URLs when create output omits a URL", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitHubCli.execute",
        command: "gh pr view",
        cwd: "/repo",
        exitCode: 1,
        failureKind: "not-found",
        detail:
          "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequest({
          cwd: "/repo",
          reference: "4888",
        })
        .pipe(Effect.flip);

      assert.equal(error.message.includes("Pull request not found"), true);
      assert.strictEqual(error._tag, "GitHubPullRequestNotFoundError");
      assert.strictEqual(error.command, "gh");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes(cause.detail), false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates a draft pull request when draft is true", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/x",
        title: "My PR",
        bodyFile: "/tmp/body.md",
        draft: true,
      });

      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: [
          "pr",
          "create",
          "--base",
          "main",
          "--head",
          "feature/x",
          "--title",
          "My PR",
          "--body-file",
          "/tmp/body.md",
          "--draft",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("merges a pull request with the requested strategy", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.mergePullRequest({ cwd: "/repo", number: 7, strategy: "squash" });

      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["pr", "merge", "7", "--squash"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("maps merge/rebase strategies to the gh flag", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.mergePullRequest({ cwd: "/repo", number: 7, strategy: "merge" });
      yield* gh.mergePullRequest({ cwd: "/repo", number: 8, strategy: "rebase" });

      expect(mockRun).toHaveBeenNthCalledWith(1, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["pr", "merge", "7", "--merge"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
      expect(mockRun).toHaveBeenNthCalledWith(2, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["pr", "merge", "8", "--rebase"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces gh stderr when a merge fails", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessExitError({
            operation: "GitHubCli.execute",
            command: "gh pr merge",
            cwd: "/repo",
            exitCode: 1,
            detail: "Pull request is not mergeable: the base branch policy requires review.",
          }),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .mergePullRequest({ cwd: "/repo", number: 7, strategy: "squash" })
        .pipe(Effect.flip);

      // upstream redacts stderr in error.message; the real stderr lives in error.cause.detail
      const cause = (error as { readonly cause?: unknown }).cause;
      const causeDetail = cause !== null && cause !== undefined && typeof cause === "object"
        ? (cause as { readonly detail?: unknown }).detail
        : undefined;
      assert.equal(typeof causeDetail === "string" && causeDetail.includes("not mergeable"), true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads pull request detail json", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              state: "OPEN",
              mergedAt: null,
              reviewDecision: "CHANGES_REQUESTED",
              headRefOid: "abc123",
              url: "https://github.com/o/r/pull/7",
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequestDetail({ cwd: "/repo", number: 7 });

      assert.deepStrictEqual(result, {
        state: "OPEN",
        mergedAt: null,
        reviewDecision: "CHANGES_REQUESTED",
        headRefOid: "abc123",
        url: "https://github.com/o/r/pull/7",
      });
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["pr", "view", "7", "--json", "state,mergedAt,reviewDecision,headRefOid,url"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("treats pr checks exit codes 0, 1 and 8 as success", () =>
    Effect.gen(function* () {
      const checksJson =
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify([
          { name: "build", state: "SUCCESS", bucket: "pass", link: "https://x/runs/1" },
          { name: "test", state: "FAILURE", bucket: "fail", link: "https://x/runs/2" },
        ]);
      mockRun.mockReturnValueOnce(Effect.succeed(processOutputWithExit(checksJson, 0)));
      mockRun.mockReturnValueOnce(Effect.succeed(processOutputWithExit(checksJson, 1)));
      mockRun.mockReturnValueOnce(Effect.succeed(processOutputWithExit(checksJson, 8)));

      const gh = yield* GitHubCli.GitHubCli;
      const expected = [
        { name: "build", state: "SUCCESS", bucket: "pass", link: "https://x/runs/1" },
        { name: "test", state: "FAILURE", bucket: "fail", link: "https://x/runs/2" },
      ];

      const r0 = yield* gh.listPullRequestChecks({ cwd: "/repo", number: 7 });
      const r1 = yield* gh.listPullRequestChecks({ cwd: "/repo", number: 7 });
      const r8 = yield* gh.listPullRequestChecks({ cwd: "/repo", number: 7 });

      assert.deepStrictEqual(r0, expected);
      assert.deepStrictEqual(r1, expected);
      assert.deepStrictEqual(r8, expected);
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["pr", "checks", "7", "--json", "name,state,bucket,link"],
        cwd: "/repo",
        timeoutMs: 30_000,
        allowNonZeroExit: true,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("returns an empty checks list when gh reports no checks", () =>
    Effect.gen(function* () {
      // gh prints nothing and exits 0 when a PR has no checks configured.
      mockRun.mockReturnValueOnce(Effect.succeed(processOutputWithExit("", 0)));

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listPullRequestChecks({ cwd: "/repo", number: 7 });

      assert.deepStrictEqual(result, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails pr checks on an unexpected exit code", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(processOutputWithExit("boom", 2, "fatal: unexpected")),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh.listPullRequestChecks({ cwd: "/repo", number: 7 }).pipe(Effect.flip);

      assert.equal(error._tag, "GitHubCliCommandError");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads pull request reviews mapping gh shape", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              reviews: [
                {
                  id: "PRR_x",
                  author: { login: "alice" },
                  state: "CHANGES_REQUESTED",
                  body: "please fix",
                  submittedAt: "2026-06-12T10:00:00Z",
                },
              ],
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listPullRequestReviews({ cwd: "/repo", number: 7 });

      assert.deepStrictEqual(result, [
        {
          id: "PRR_x",
          author: "alice",
          state: "CHANGES_REQUESTED",
          body: "please fix",
          submittedAt: "2026-06-12T10:00:00Z",
        },
      ]);
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["pr", "view", "7", "--json", "reviews"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads pull request review comments via gh api", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                id: 555,
                user: { login: "bob" },
                body: "nit",
                path: "src/x.ts",
                created_at: "2026-06-12T11:00:00Z",
              },
              {
                id: 556,
                user: { login: "carol" },
                body: "general",
                path: null,
                created_at: "2026-06-12T12:00:00Z",
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listPullRequestReviewComments({
        cwd: "/repo",
        repo: "octocat/codething-mvp",
        number: 7,
      });

      assert.deepStrictEqual(result, [
        {
          id: 555,
          user: "bob",
          body: "nit",
          path: "src/x.ts",
          createdAt: "2026-06-12T11:00:00Z",
        },
        {
          id: 556,
          user: "carol",
          body: "general",
          path: null,
          createdAt: "2026-06-12T12:00:00Z",
        },
      ]);
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["api", "repos/octocat/codething-mvp/pulls/7/comments"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );
});
