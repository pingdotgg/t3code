import { afterEach, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessExitError } from "@t3tools/contracts";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";

const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();
const layer = it.layer(
  GitLabPullRequestCli.layer.pipe(
    Layer.provide(GitLabCli.layer),
    Layer.provide(TestSourceControlHost.layer({ process: { run } })),
  ),
);
const input = { cwd: "/repo", repository: "acme/nested/web", number: 7 };
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
