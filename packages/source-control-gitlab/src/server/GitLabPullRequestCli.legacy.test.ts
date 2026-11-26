import { afterEach, expect, it, vi } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessExitError, VcsProcessTimeoutError } from "@t3tools/contracts";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as RateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";

const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();
const layer = it.layer(
  GitLabPullRequestCli.layer.pipe(
    Layer.provide(GitLabCli.layer),
    Layer.provide(TestSourceControlHost.layer({ process: { run } })),
    Layer.provide(FileSystem.layerNoop({})),
  ),
);
const input = { cwd: "/repo", repository: "acme/nested/web", number: 7 };
const batchInput = { ...input, host: "gitlab.example", numbers: [7, 8] };

function apiReply(
  body: unknown,
  { status = 200, header = "Content-Type: application/json", truncated = false } = {},
) {
  return (request: SourceControlHost.SourceControlProcessInput) => {
    const launch = Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(
        status >= 400 || (typeof body === "object" && body !== null && "errors" in body) ? 1 : 0,
      ),
      stdout: `HTTP/2.0 ${status} Response\n${header}\r\n\r\n${JSON.stringify(body)}`,
      stderr: "",
      stdoutTruncated: truncated,
      stderrTruncated: false,
    });
    return request.aroundLaunch?.(launch) ?? launch;
  };
}
const file = {
  old_path: "src/old.ts",
  new_path: "src/new.ts",
  renamed_file: true,
  new_file: false,
  deleted_file: false,
  a_mode: "100644",
  b_mode: "100644",
  diff: "@@ -1 +1 @@\n-before\n+after\n",
};
function output(body: unknown, stdoutTruncated = false) {
  return Effect.succeed({
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: JSON.stringify(body),
    stderr: "",
    stdoutTruncated,
    stderrTruncated: false,
  });
}
function failure(failureKind: "not-found" | "authentication" | "rate-limited" | "command-failed") {
  return Effect.fail(
    new VcsProcessExitError({
      operation: "GitLabCli.execute",
      command: "glab",
      cwd: input.cwd,
      exitCode: 1,
      detail: "GitLab HTTP failure",
      failureKind,
    }),
  );
}
afterEach(() => run.mockReset());

layer("legacy GitLab diff requests through GitLabCli", (it) => {
  it.effect.each([false, true])("accepts an unavailable legacy count (overflow: %s)", (overflow) =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(failure("not-found"));
      run.mockReturnValueOnce(output({ changes: [file], changes_count: null, overflow }));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const result = yield* cli.getMergeRequestDiff(input);
      expect(result.truncated).toBe(overflow);
      expect(result.nextCursor).toBeNull();
      expect(result.patch).toContain("@@ -1 +1 @@\n-before\n+after\n");
    }),
  );
  it.effect.each([{ overflow: true }, { changes_count: "247+" }])(
    "marks legacy limits %j truncated",
    (metadata) =>
      Effect.gen(function* () {
        run.mockReturnValueOnce(failure("not-found"));
        run.mockReturnValueOnce(output({ changes: [file], ...metadata }));
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
        expect(yield* cli.getMergeRequestDiff(input)).toMatchObject({
          truncated: true,
          nextCursor: null,
        });
      }),
  );
  it.effect.each([false, true])("marks skipped file entries truncated (legacy: %s)", (legacy) =>
    Effect.gen(function* () {
      const entries = [file, { new_path: "missing-old-path.ts" }];
      if (legacy) run.mockReturnValueOnce(failure("not-found"));
      run.mockReturnValueOnce(output(legacy ? { changes: entries } : entries));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const result = yield* cli.getMergeRequestDiff(input);
      expect(result.truncated).toBe(true);
      expect(result.nextCursor).toBeNull();
      expect(result.patch.match(/^diff --git /gm)).toHaveLength(1);
      expect(result.patch).toContain("@@ -1 +1 @@\n-before\n+after\n");
    }),
  );
  it.effect("rejects a byte-truncated legacy response", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(failure("not-found"));
      run.mockReturnValueOnce(output({ changes: [file] }, true));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      expect((yield* cli.getMergeRequestDiff(input).pipe(Effect.flip))._tag).toBe(
        "GitLabMergeRequestReadError",
      );
    }),
  );
  it.effect.each(["authentication", "rate-limited", "command-failed"] as const)(
    "does not fall back on %s",
    (kind) =>
      Effect.gen(function* () {
        run.mockReturnValueOnce(failure(kind));
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
        yield* cli.getMergeRequestDiff(input).pipe(Effect.flip);
        expect(run).toHaveBeenCalledTimes(1);
      }),
  );
  it.effect("does not fall back for a missing commit or later MR page", () =>
    Effect.gen(function* () {
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      for (const target of [
        { ...input, commit: "abc1234" },
        { ...input, cursor: "2" },
      ]) {
        run.mockReturnValueOnce(failure("not-found"));
        yield* cli.getMergeRequestDiff(target).pipe(Effect.flip);
      }
      expect(run).toHaveBeenCalledTimes(2);
    }),
  );
  // regression: #15886 the older-GitLab fallback still surfaces its own failure
  it.effect("propagates failure of the legacy endpoint", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(failure("not-found"));
      run.mockReturnValueOnce(failure("not-found"));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      expect((yield* cli.getMergeRequestDiff(input).pipe(Effect.flip))._tag).toBe(
        "GitLabCliCommandError",
      );
      expect(run).toHaveBeenCalledTimes(2);
    }),
  );
  it.effect("does not fall back on an unreadable successful modern response", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(output({ changes: [file] }));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      expect((yield* cli.getMergeRequestDiff(input).pipe(Effect.flip))._tag).toBe(
        "GitLabMergeRequestReadError",
      );
      expect(run).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect("keeps modern pagination without requesting legacy changes", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(output(Array.from({ length: 30 }, () => file)));
      run.mockReturnValueOnce(output([file]));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const first = yield* cli.getMergeRequestDiff(input);
      expect(first.nextCursor).toBe("2");
      expect(
        (yield* cli.getMergeRequestDiff({ ...input, cursor: first.nextCursor! })).nextCursor,
      ).toBeNull();
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1]?.[0].args).toContain(
        "projects/acme%2Fnested%2Fweb/merge_requests/7/diffs?per_page=30&page=2",
      );
    }),
  );
});

layer("linked MR batches through GitLabCli", (it) => {
  it.effect("keeps the GraphQL page bounded, follows the cursor and rechecks stale MRs", () =>
    Effect.gen(function* () {
      const numbers = Array.from({ length: 41 }, (_, index) => index + 1);
      const nodes = numbers.map((number) => ({
        iid: String(number),
        title: `MR !${number}`,
        webUrl: `https://gitlab.example/acme/nested/web/-/merge_requests/${number}`,
        sourceBranch: "fork-branch",
        targetBranch: "main",
        state: "OPENED",
        updatedAt: "2026-08-28T12:00:00Z",
        mergeStatusEnum: number === 41 ? "UNCHECKED" : "CAN_BE_MERGED",
      }));
      run.mockImplementationOnce(
        apiReply({
          data: {
            project: {
              mergeRequests: {
                nodes: nodes.slice(0, 40),
                pageInfo: { hasNextPage: true, endCursor: "opaque" },
              },
            },
          },
        }),
      );
      run.mockImplementationOnce(
        apiReply({
          data: {
            project: {
              mergeRequests: {
                nodes: nodes.slice(40),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      );
      run.mockImplementationOnce(apiReply([]));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      expect([...(yield* cli.getLinkedSummaries({ ...batchInput, numbers })).keys()]).toEqual(
        numbers,
      );
      expect(run).toHaveBeenCalledTimes(3);
      expect(run.mock.calls[0]?.[0].stdin).toContain('"first":40,"after":null');
      expect(run.mock.calls[1]?.[0].stdin).toContain('"first":40,"after":"opaque"');
      expect(run.mock.calls[2]?.[0].args[1]).toContain(
        "merge_requests?iids[]=41&scope=all&state=all&with_merge_status_recheck=true",
      );
    }).pipe(Effect.provide(RateLimit.layer)),
  );

  it.effect("reduces a truncated REST page and keeps rows whose enrichment fails", () =>
    Effect.gen(function* () {
      run.mockImplementationOnce(apiReply({ errors: [{ message: "Unknown closedAt" }] }));
      run.mockImplementationOnce(apiReply(null, { truncated: true }));
      run.mockImplementationOnce(
        apiReply(
          [
            {
              iid: 7,
              title: "MR",
              web_url: "https://gitlab.example/acme/nested/web/-/merge_requests/7",
              source_branch: "fork-branch",
              target_branch: "main",
              state: "opened",
              created_at: "2026-08-28T12:00:00Z",
              updated_at: "2026-08-28T12:00:00Z",
            },
          ],
          { header: "X-Next-Page:" },
        ),
      );
      run.mockImplementationOnce(
        apiReply({
          data: {
            project: {
              mergeRequests: {
                nodes: [
                  {
                    iid: "7",
                    approved: true,
                    approvedBy: { nodes: [{}] },
                    headPipeline: { status: "SUCCESS" },
                  },
                ],
              },
            },
          },
        }),
      );
      run.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessTimeoutError({
            operation: "GitLabCli.execute",
            command: "glab",
            cwd: input.cwd,
            timeoutMs: 1,
          }),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const summaries = yield* cli.getLinkedSummaries(batchInput);
      expect([...summaries.keys()]).toEqual([7]);
      expect(summaries.get(7)).toMatchObject({
        headBranch: "fork-branch",
        reviewDecision: "approved",
        checksState: "passing",
      });
      expect(summaries.get(7)).not.toHaveProperty("additions");
      expect(run.mock.calls[2]?.[0].args[1]).toContain("per_page=1&page=1");
      expect(run.mock.calls[3]?.[0].stdin).toContain('"iids":["7"]');
      expect(run.mock.calls[4]?.[0].stdin).toContain('"iids":["7"]');
    }).pipe(Effect.provide(RateLimit.layer)),
  );

  it.effect("denies a compatibility read while a Retry-After is active", () =>
    Effect.gen(function* () {
      const launches: string[] = [];
      run.mockImplementationOnce(apiReply({ errors: [{ message: "Unknown closedAt" }] }));
      run.mockImplementation((request) =>
        request.aroundLaunch!(
          Effect.sync(() => {
            launches.push(request.args[1]!);
            return {
              exitCode: ChildProcessSpawner.ExitCode(1),
              stdout: "HTTP/2.0 429 Too Many Requests\nRetry-After: 120\r\n\r\n{}",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const retryAt = (yield* Clock.currentTimeMillis) + 120_000;
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(yield* cli.getLinkedSummaries(batchInput).pipe(Effect.flip)).toMatchObject({
          _tag: "GitLabCliRateLimitError",
          retryAt,
        });
      }
      expect(launches).toEqual([expect.stringContaining("/merge_requests?")]);
    }).pipe(Effect.provide(RateLimit.layer)),
  );
});
