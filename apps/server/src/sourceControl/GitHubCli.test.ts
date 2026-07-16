import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";

const processOutput = (stdout: string, exitCode = 0, stderr = ""): VcsProcess.VcsProcessOutput => ({
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
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
          "--",
          "#42",
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
        args: ["repo", "create", "--private", "--", "octocat/codething-mvp"],
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

  it.effect("creates draft pull requests with the fork gh args", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/pr",
        title: "Open PR",
        bodyFile: "/tmp/pr.md",
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
          "feature/pr",
          "--title",
          "Open PR",
          "--body-file",
          "/tmp/pr.md",
          "--draft",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("merges pull requests with the selected strategy flag", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.mergePullRequest({
        cwd: "/repo",
        number: 42,
        strategy: "rebase",
      });

      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["pr", "merge", "--rebase", "--", "42"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps an option-shaped PR number a positional (no gh flag injection)", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      // A dynamically-loaded plugin can supply a value the TS `number` type does not
      // enforce at runtime. Without the `--` terminator, "--admin" would parse as a
      // gh flag (branch-protection bypass). It must land AFTER `--`, as a positional.
      yield* gh.mergePullRequest({
        cwd: "/repo",
        number: "--admin" as unknown as number,
        strategy: "squash",
      });

      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["pr", "merge", "--squash", "--", "--admin"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps gh merge stderr matchable through the command error cause", () =>
    Effect.gen(function* () {
      const stderr = "Pull request is not mergeable: branch protection rules must be satisfied.";
      mockRun.mockReturnValueOnce(
        Effect.fail(
          VcsProcessExitError.fromProcessExit(
            {
              operation: "GitHubCli.execute",
              command: "gh",
              cwd: "/repo",
              argumentCount: 5,
            },
            { exitCode: 1, stderr, stderrTruncated: false },
            "command-failed",
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .mergePullRequest({
          cwd: "/repo",
          number: 42,
          strategy: "squash",
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "GitHubCliCommandError");
      // In-process consumers can still classify off the raw stderr...
      assert.equal((error.cause as { readonly stderr?: string }).stderr, stderr);
      assert.notInclude(error.message, "branch protection");
      // ...but the stderr never reaches serialized output.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.notInclude(JSON.stringify(error.cause), "branch protection");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("parses pull request detail output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              state: "MERGED",
              mergedAt: "2026-07-03T12:00:00Z",
              reviewDecision: "APPROVED",
              headRefOid: "abc123",
              url: "https://github.com/o/r/pull/42",
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const detail = yield* gh.getPullRequestDetail({ cwd: "/repo", number: 42 });

      assert.deepStrictEqual(detail, {
        state: "MERGED",
        mergedAt: "2026-07-03T12:00:00Z",
        reviewDecision: "APPROVED",
        headRefOid: "abc123",
        url: "https://github.com/o/r/pull/42",
      });
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["pr", "view", "--json", "state,mergedAt,reviewDecision,headRefOid,url", "--", "42"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("parses pull request checks while tolerating gh pending exit code", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                name: "test",
                state: "PENDING",
                bucket: "pending",
                link: "https://github.com/o/r/actions/runs/1",
              },
              {
                name: null,
                state: null,
                bucket: null,
                link: null,
              },
            ]),
            8,
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const checks = yield* gh.listPullRequestChecks({ cwd: "/repo", number: 42 });

      assert.deepStrictEqual(checks, [
        {
          name: "test",
          state: "PENDING",
          bucket: "pending",
          link: "https://github.com/o/r/actions/runs/1",
        },
        {
          name: "",
          state: "",
          bucket: "",
          link: "",
        },
      ]);
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["pr", "checks", "--json", "name,state,bucket,link", "--", "42"],
        cwd: "/repo",
        timeoutMs: 30_000,
        allowNonZeroExit: true,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects unexpected gh pr checks exit codes", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("[]", 2, "bad exit")));

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh.listPullRequestChecks({ cwd: "/repo", number: 42 }).pipe(Effect.flip);

      assert.equal(error._tag, "GitHubCliCommandError");
      const cause = error.cause as VcsProcessExitError;
      assert.equal(cause._tag, "VcsProcessExitError");
      assert.equal(cause.exitCode, 2);
      // Raw stderr is server-side only: readable in-process, never serialized.
      assert.equal(cause.stderr, "bad exit");
      assert.notInclude(cause.message, "bad exit");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.notInclude(JSON.stringify(cause), "bad exit");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails loudly when gh pr checks exits 1 with only stderr (error, not JSON)", () =>
    Effect.gen(function* () {
      // Auth failure / missing PR / API error: exit 1, empty stdout, stderr
      // carries the error text. This must NOT read as "no checks".
      mockRun.mockReturnValueOnce(
        Effect.succeed(processOutput("", 1, "HTTP 401: Bad credentials (https://api.github.com)")),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh.listPullRequestChecks({ cwd: "/repo", number: 42 }).pipe(Effect.flip);

      assert.equal(error._tag, "GitHubCliCommandError");
      const cause = error.cause as VcsProcessExitError;
      assert.equal(cause.exitCode, 1);
      assert.include(cause.stderr ?? "", "Bad credentials");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.notInclude(JSON.stringify(error), "Bad credentials");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("treats the documented gh 'no checks reported' exit-1 case as an empty list", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(processOutput("", 1, "no checks reported on the 'feature/x' branch")),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const checks = yield* gh.listPullRequestChecks({ cwd: "/repo", number: 42 });

      assert.deepStrictEqual(checks, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("parses gh pr checks JSON on exit 1 when some checks are failing", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                name: "test",
                state: "FAILURE",
                bucket: "fail",
                link: "https://github.com/o/r/actions/runs/2",
              },
            ]),
            1,
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const checks = yield* gh.listPullRequestChecks({ cwd: "/repo", number: 42 });

      assert.deepStrictEqual(checks, [
        {
          name: "test",
          state: "FAILURE",
          bucket: "fail",
          link: "https://github.com/o/r/actions/runs/2",
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("parses pull request review output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              reviews: [
                {
                  id: "R_1",
                  author: { login: "octocat" },
                  state: "APPROVED",
                  body: "ship it",
                  submittedAt: "2026-07-03T12:00:00Z",
                },
                {
                  id: null,
                  author: null,
                  state: null,
                  body: null,
                  submittedAt: null,
                },
              ],
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const reviews = yield* gh.listPullRequestReviews({ cwd: "/repo", number: 42 });

      assert.deepStrictEqual(reviews, [
        {
          id: "R_1",
          author: "octocat",
          state: "APPROVED",
          body: "ship it",
          submittedAt: "2026-07-03T12:00:00Z",
        },
        {
          id: "",
          author: "",
          state: "",
          body: "",
          submittedAt: "",
        },
      ]);
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["pr", "view", "--json", "reviews", "--", "42"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("parses pull request review comments output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                id: 123,
                user: { login: "octocat" },
                body: "please fix",
                path: "src/file.ts",
                created_at: "2026-07-03T12:00:00Z",
              },
              {
                id: 124,
                user: null,
                body: null,
                path: null,
                created_at: null,
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const comments = yield* gh.listPullRequestReviewComments({
        cwd: "/repo",
        repo: "o/r",
        number: 42,
      });

      assert.deepStrictEqual(comments, [
        {
          id: 123,
          user: "octocat",
          body: "please fix",
          path: "src/file.ts",
          createdAt: "2026-07-03T12:00:00Z",
        },
        {
          id: 124,
          user: "",
          body: "",
          path: null,
          createdAt: "",
        },
      ]);
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["api", "--paginate", "repos/o/r/pulls/42/comments"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects a malformed repo identifier before it reaches the gh api path", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;

      for (const repo of ["o/r/extra", "o", "../o/r", "o/r?per_page=100", "o r/name", ""]) {
        const error = yield* gh
          .listPullRequestReviewComments({ cwd: "/repo", repo, number: 42 })
          .pipe(Effect.flip);
        assert.equal(error._tag, "GitHubCliCommandError");
      }
      expect(mockRun).not.toHaveBeenCalled();
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
});
