import { assert, it, afterEach, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import { VcsProcessExitError, VcsProcessTimeoutError } from "@t3tools/contracts";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitLabCli from "./GitLabCli.ts";

const mockedRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();
const layer = it.layer(
  GitLabCli.layer.pipe(Layer.provide(TestSourceControlHost.layer({ process: { run: mockedRun } }))),
);

function processOutput(stdout: string): SourceControlHost.SourceControlProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

afterEach(() => {
  mockedRun.mockReset();
});

layer("GitLabCli.layer", (it) => {
  it.effect("parses merge request view output", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              iid: 42,
              title: "Add MR thread creation",
              web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
              target_branch: "main",
              source_branch: "feature/mr-threads",
              sha: "a".repeat(40),
              state: "closed",
              closed_at: "2026-08-23T10:00:00Z",
              source_project_id: 101,
              target_project_id: 100,
              source_project: {
                path_with_namespace: "octocat/t3code",
              },
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "42",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add MR thread creation",
        url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
        baseRefName: "main",
        headRefName: "feature/mr-threads",
        headSha: "a".repeat(40),
        state: "closed",
        closedAt: "2026-08-23T10:00:00Z",
        mergedAt: null,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/t3code",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "view", "--output", "json", "--", "42"],
        }),
      );
      const classifyFailure = mockedRun.mock.calls.at(-1)?.[0].classifyFailure;
      assert.strictEqual(
        classifyFailure?.(
          "x gitlab.example.test has not been authenticated with glab. Run `glab auth login`",
        ),
        "authentication",
      );
      assert.strictEqual(
        classifyFailure?.(
          'Failed to get merge request 42: oauth2: "invalid_grant" "The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client."',
        ),
        "authentication",
      );
    }),
  );

  it.effect("skips invalid entries when parsing MR lists", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify([
              {
                iid: 0,
                title: "invalid",
                web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/0",
                target_branch: "main",
                source_branch: "feature/invalid",
              },
              {
                iid: 43,
                title: "  Valid MR  ",
                web_url: " https://gitlab.com/pingdotgg/t3code/-/merge_requests/43 ",
                target_branch: " main ",
                source_branch: " feature/mr-list ",
                state: "merged",
                merged_at: "2026-08-23T11:00:00Z",
              },
            ]),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.listMergeRequests({
          cwd: "/repo",
          headSelector: "feature/mr-list",
          state: "all",
        });
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid MR",
          url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/43",
          baseRefName: "main",
          headRefName: "feature/mr-list",
          state: "merged",
          closedAt: null,
          mergedAt: "2026-08-23T11:00:00Z",
        },
      ]);
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "mr",
            "list",
            "--source-branch",
            "feature/mr-list",
            "--all",
            "--per-page",
            "20",
            "--output",
            "json",
          ],
        }),
      );
    }),
  );

  it.effect("surfaces a friendly error when the merge request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "GET 404 merge request not found",
        failureKind: "not-found",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Merge request 4888 was not found"), true);
      assert.strictEqual(error._tag, "GitLabMergeRequestNotFoundError");
      assert.strictEqual(error.command, "glab");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes(cause.detail), false);
    }),
  );

  it.effect("names non-merge-request not-found failures without claiming a missing MR", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "GET 404 project not found",
        failureKind: "not-found",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "missing/project",
        });
      }).pipe(Effect.flip);

      assert.strictEqual(error.cause, cause);
      assert.strictEqual(error.detail, "GitLab CLI command failed (not-found).");
      assert(error._tag === "GitLabCliCommandError");
      assert.strictEqual(error.reason, "not-found");
    }),
  );

  it.effect("preserves rate-limit failures as a distinct error", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "API rate limit exceeded.",
        failureKind: "rate-limited",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .execute({ cwd: "/repo", args: ["api", "projects"] })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliRateLimitError");
      assert.strictEqual(error.cause, cause);
    }),
  );

  it.effect("names a not-found exit in a failed command's detail", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "Merge request not found.",
        failureKind: "not-found",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .listMergeRequests({ cwd: "/repo", headSelector: "main", state: "open" })
        .pipe(Effect.flip);

      assert.strictEqual(error.cause, cause);
      assert.strictEqual(error.detail, "GitLab CLI command failed (not-found).");
      assert(error._tag === "GitLabCliCommandError");
      assert.strictEqual(error.reason, "not-found");
      assert.notInclude(error.message, "Merge request not found.");
    }),
  );

  it.effect("names recognized failure classes and leaves unclassified exits generic", () =>
    Effect.gen(function* () {
      const timeoutCause = new VcsProcessTimeoutError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        timeoutMs: 30_000,
      });
      const exitCause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "Process exited with a non-zero status.",
        failureKind: "command-failed",
      });
      // The boundary always sets failureKind; an absent one is a schema-optional
      // fallback that must still stay generic.
      const unclassifiedCause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "Process exited with a non-zero status.",
      });
      mockedRun
        .mockReturnValueOnce(Effect.fail(timeoutCause))
        .mockReturnValueOnce(Effect.fail(exitCause))
        .mockReturnValueOnce(Effect.fail(unclassifiedCause));

      const glab = yield* GitLabCli.GitLabCli;
      const timedOut = yield* glab
        .execute({ cwd: "/repo", args: ["api", "projects"] })
        .pipe(Effect.flip);
      const failed = yield* glab
        .execute({ cwd: "/repo", args: ["api", "projects"] })
        .pipe(Effect.flip);
      const unclassified = yield* glab
        .execute({ cwd: "/repo", args: ["api", "projects"] })
        .pipe(Effect.flip);

      assert.strictEqual(timedOut.detail, "GitLab CLI command failed (timed-out).");
      assert(timedOut._tag === "GitLabCliCommandError");
      assert.strictEqual(timedOut.reason, "timed-out");
      assert.strictEqual(failed.detail, "GitLab CLI command failed.");
      assert(failed._tag === "GitLabCliCommandError");
      assert.strictEqual(failed.reason, undefined);
      assert.strictEqual(unclassified.detail, "GitLab CLI command failed.");
      assert(unclassified._tag === "GitLabCliCommandError");
      assert.strictEqual(unclassified.reason, undefined);
    }),
  );
});
