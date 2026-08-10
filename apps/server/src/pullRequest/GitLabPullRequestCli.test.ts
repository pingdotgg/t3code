import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";

const mockedExecute = vi.fn<GitLabCli.GitLabCli["Service"]["execute"]>();

const layer = it.layer(
  GitLabPullRequestCli.layer.pipe(
    Layer.provide(
      Layer.mock(GitLabCli.GitLabCli)({
        execute: mockedExecute,
      }),
    ),
  ),
);

function output(stdout: string, stdoutTruncated = false, stdoutInvalidUtf8 = false) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated,
    stderrTruncated: false,
    stdoutInvalidUtf8,
  };
}

function mergeRequests(count: number, firstNumber: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      iid: firstNumber + index,
      title: `Merge request ${firstNumber + index}`,
      web_url: `https://gitlab.com/acme/web/-/merge_requests/${firstNumber + index}`,
      source_branch: "feat/page",
      target_branch: "main",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
    })),
  );
}

/** A page of `/diffs` as GitLab serves it, a full one unless the count says otherwise. */
function diffPage(firstIndex: number, count = 100): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      old_path: `src/${firstIndex + index}.ts`,
      new_path: `src/${firstIndex + index}.ts`,
      diff: "@@ -1 +1 @@\n-a\n+b\n",
    })),
  );
}

/** A page of merge request notes, which is what the flat conversation is read from. */
function notes(count: number, firstId: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      id: firstId + index,
      body: `note ${firstId + index}`,
      author: { username: "bilal" },
      created_at: "2026-07-01T00:00:00Z",
    })),
  );
}

/** Who opened the merge request, and somebody already reviewing it. */
const author = { id: 1, username: "bilal" };
const reviewer = { id: 5, username: "octocat" };

/** One merge request as `/merge_requests/:iid` answers with it. */
function mergeRequestJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    iid: 7,
    title: "Merge request 7",
    web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
    source_branch: "feat/page",
    target_branch: "main",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    author,
    ...overrides,
  });
}

/** The endpoint or subcommand of the nth glab invocation. */
function argsOfCall(index: number): ReadonlyArray<string> {
  return callAt(index).args;
}

/** The whole nth invocation, so a request body can be asserted alongside its path. */
function callAt(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

afterEach(() => {
  mockedExecute.mockReset();
});

layer("GitLabPullRequestCli.layer", (it) => {
  it.effect("asks GitLab for one row more than the page, to probe for a next page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(mergeRequests(3, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 3);
      assert.isFalse(batch.truncated);
      assert.strictEqual(batch.cursorAdvance, 3);
      const path = argsOfCall(0)[1] ?? "";
      expect(path).toContain("projects/acme%2Fweb/merge_requests");
      expect(path).toContain("per_page=11");
      expect(path).toContain("state=opened");
    }),
  );

  it.effect("walks pages at a fixed size, because GitLab pages by offset", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(100, 1))))
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(100, 101))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 150,
      });

      assert.strictEqual(batch.items.length, 150);
      assert.isTrue(batch.truncated);
      for (const index of [0, 1]) {
        expect(argsOfCall(index)[1]).toContain("per_page=100");
      }
      expect(argsOfCall(0)[1]).toContain("page=1");
      expect(argsOfCall(1)[1]).toContain("page=2");
    }),
  );

  it.effect("hands a search to GitLab's own search parameter", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "page",
      });

      // GitLab matches `search` against title and description, which is more than the row shows.
      expect(argsOfCall(0)[1]).toContain("search=page");
    }),
  );

  it.effect("carries on from the number of rows already delivered", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(mergeRequests(3, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      // GitLab's timestamp filter has no tie-breaker, so an offset is what advances through a
      // boundary shared by more rows than one page can hold.
      const path = argsOfCall(0)[1] ?? "";
      expect(path).not.toContain("updated_before=");
      expect(path).toContain("order_by=updated_at");
      expect(path).toContain("per_page=11");
      expect(path).toContain("page=1");
    }),
  );

  it.effect("advances beyond several pages sharing the cursor timestamp", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(11, 144))))
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(11, 155))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 150 },
      });

      expect(argsOfCall(0)[1]).toContain("per_page=11");
      expect(argsOfCall(0)[1]).toContain("page=14");
      expect(argsOfCall(1)[1]).toContain("page=15");
      expect(batch.items.map((item) => item.number)).toEqual([
        151, 152, 153, 154, 155, 156, 157, 158, 159, 160,
      ]);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("advances the cursor through malformed raw rows", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const rows = JSON.parse(mergeRequests(2, 1)) as ReadonlyArray<unknown>;
      mockedExecute.mockReturnValueOnce(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        Effect.succeed(output(JSON.stringify([{ iid: "malformed" }, ...rows]))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 2,
      });

      expect(batch.items.map((item) => item.number)).toEqual([1, 2]);
      assert.strictEqual(batch.cursorAdvance, 3);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("URL-encodes a search, so it cannot add a parameter of its own", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: '-a&per_page=1 "b"',
      });

      const path = argsOfCall(0)[1] ?? "";
      expect(path).toContain("search=-a%26per_page%3D1%20%22b%22");
      // The page size the walk fixed is still the only one in the query.
      assert.strictEqual(path.match(/per_page=/g)?.length, 1);
    }),
  );

  it.effect("asks for no search at all when the reader typed only spaces", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "   ",
      });

      expect(argsOfCall(0)[1]).not.toContain("search=");
    }),
  );

  it.effect("stops walking on a short page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(mergeRequests(40, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 150,
      });

      assert.strictEqual(batch.items.length, 40);
      assert.isFalse(batch.truncated);
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("stops walking when every row on a page fails to decode", () =>
    Effect.gen(function* () {
      // Full pages of unusable rows: nothing is collected, so the collected-count bound never
      // trips and only the page bound can end the walk.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const unusable = JSON.stringify(Array.from({ length: 100 }, () => ({ iid: "nope" })));
      mockedExecute.mockReturnValue(Effect.succeed(output(unusable)));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 150,
      });

      assert.strictEqual(batch.items.length, 0);
      // ceil((150 + 1) / 100) pages, not one request per page forever.
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("asks GitLab for every state on the All tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "all",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      expect(argsOfCall(0)[1]).toContain("state=all");
    }),
  );

  it.effect("filters by the reviewer when the viewer is reviewing", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
      });

      expect(argsOfCall(0)[1]).toContain("reviewer_username=bilal");
    }),
  );

  it.effect("addresses a nested group project by its encoded full path", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/platform/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      expect(argsOfCall(0)[1]).toContain("projects/acme%2Fplatform%2Fweb/merge_requests");
    }),
  );

  it.effect("merges immediately rather than leaving auto-merge armed", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.runMergeRequestAction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        action: "merge",
        mergeMethod: "squash",
      });

      expect(argsOfCall(0)).toEqual([
        "mr",
        "merge",
        "7",
        "--repo",
        "acme/web",
        "--auto-merge=false",
        "--yes",
        "--squash",
      ]);
    }),
  );

  it.effect("moves a merge request back to draft through glab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.runMergeRequestAction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        action: "draft",
      });

      expect(argsOfCall(0)).toEqual(["mr", "update", "7", "--repo", "acme/web", "--draft"]);
    }),
  );

  it.effect("sends a comment body over stdin, never in argv", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.commentOnMergeRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        body: "true",
      });

      const call = mockedExecute.mock.calls[0];
      assert.isDefined(call);
      expect(call[0].args).toEqual([
        "api",
        "projects/acme%2Fweb/merge_requests/7/notes",
        "--method",
        "POST",
        "--input",
        "-",
        "--header",
        "Content-Type: application/json",
      ]);
      // A JSON body, so a comment reading as a literal `true` stays text.
      expect(call[0].stdin).toBe('{"body":"true"}');
    }),
  );

  it.effect("reads one diff page and hands back the cursor for the next", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(diffPage(0))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const diff = yield* cli.getMergeRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      // One page per call: the reader asks for the rest, the walk does not run on by itself.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      assert.isNotNull(diff.nextCursor);
      // A full page means more files, not a slice with something missing from it.
      assert.isFalse(diff.truncated);
      expect(argsOfCall(0)[1]).toContain("merge_requests/7/diffs?per_page=100&page=1");
    }),
  );

  it.effect("carries on from a cursor at the page it names", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(diffPage(0))))
        .mockReturnValueOnce(Effect.succeed(output(diffPage(100, 3))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const target = { cwd: "/w", repository: "acme/web", number: 7 };

      const first = yield* cli.getMergeRequestDiff(target);
      assert.isNotNull(first.nextCursor);
      const second = yield* cli.getMergeRequestDiff({ ...target, cursor: first.nextCursor });

      expect(argsOfCall(1)[1]).toContain("page=2");
      // A short page is the end of the change set, so there is nothing to carry on from.
      assert.isNull(second.nextCursor);
      expect(second.patch).toContain("diff --git a/src/100.ts b/src/100.ts");
    }),
  );

  it.effect("refuses a cursor it never handed out rather than reading it into a query", () =>
    Effect.gen(function* () {
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          cursor: "1&per_page=1",
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffCursorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("reads a named commit from its own diff, and pages inside it", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(diffPage(0))))
        .mockReturnValueOnce(Effect.succeed(output(diffPage(100, 3))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const target = {
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        commit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      };

      const first = yield* cli.getMergeRequestDiff(target);
      assert.isNotNull(first.nextCursor);
      const second = yield* cli.getMergeRequestDiff({ ...target, cursor: first.nextCursor });

      const commitPath =
        "projects/acme%2Fweb/repository/commits/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/diff";
      expect(argsOfCall(0)[1]).toBe(`${commitPath}?per_page=100&page=1`);
      // The whole path, not just the page: a cursor branch that dropped the commit would still
      // ask for page 2, of the merge request's own diff.
      expect(argsOfCall(1)[1]).toBe(`${commitPath}?per_page=100&page=2`);
      assert.isNull(second.nextCursor);
    }),
  );

  it.effect("refuses a commit that is not a sha rather than reading it into a path", () =>
    Effect.gen(function* () {
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          commit: "../../merge_requests/8/diffs",
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffCommitError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("reports a commit with no parent as a structured error", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        Effect.succeed(output(JSON.stringify({ id: "a1b2c3d", parent_ids: [] }))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          commit: "a1b2c3d",
          changeType: "change",
          oldPath: "src/a.ts",
          newPath: "src/a.ts",
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffCommitParentUnavailableError");
      if (error._tag === "GitLabDiffCommitParentUnavailableError") {
        assert.strictEqual(error.commit, "a1b2c3d");
      }
    }),
  );

  it.effect("expands a new file from a root commit without requiring a parent", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        Effect.succeed(output(JSON.stringify({ id: "a1b2c3d", parent_ids: [] }))),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("first contents\n")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const contents = yield* cli.getMergeRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        commit: "a1b2c3d",
        changeType: "new",
        oldPath: "src/first.ts",
        newPath: "src/first.ts",
      });

      expect(contents).toEqual({ oldContents: "", newContents: "first contents\n" });
      expect(argsOfCall(1)[1]).toContain("raw?ref=a1b2c3d");
    }),
  );

  it.effect("reports an oversized diff file with its path and reason", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              diff_refs: {
                base_sha: "a1b2c3d",
                head_sha: "b1c2d3e",
                start_sha: "a1b2c3d",
              },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("partial", true)));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          changeType: "deleted",
          oldPath: "src/large.ts",
          newPath: "src/large.ts",
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffFileContentsUnavailableError");
      if (error._tag === "GitLabDiffFileContentsUnavailableError") {
        assert.strictEqual(error.path, "src/large.ts");
        assert.strictEqual(error.reason, "oversized");
      }
    }),
  );

  it.effect("reports undecodable diff file contents as binary", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              diff_refs: {
                base_sha: "a1b2c3d",
                head_sha: "b1c2d3e",
                start_sha: "a1b2c3d",
              },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output("binary\uFFFDcontents", false, true)),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          changeType: "deleted",
          oldPath: "assets/logo.png",
          newPath: "assets/logo.png",
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffFileContentsUnavailableError");
      if (error._tag === "GitLabDiffFileContentsUnavailableError") {
        assert.strictEqual(error.path, "assets/logo.png");
        assert.strictEqual(error.reason, "binary");
      }
    }),
  );

  it.effect("returns valid text containing a literal replacement character", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              diff_refs: {
                base_sha: "a1b2c3d",
                head_sha: "b1c2d3e",
                start_sha: "a1b2c3d",
              },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("before\uFFFDafter")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const contents = yield* cli.getMergeRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        changeType: "deleted",
        oldPath: "docs/encoding.md",
        newPath: "docs/encoding.md",
      });

      assert.strictEqual(contents.oldContents, "before\uFFFDafter");
    }),
  );

  it.effect("ends the diff on a page with no files rather than asking for it again", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const diff = yield* cli.getMergeRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        cursor: "4",
      });

      assert.strictEqual(diff.patch, "");
      assert.isNull(diff.nextCursor);
    }),
  );

  it.effect("fails a diff page cut off mid-JSON rather than calling the diff whole", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        // A byte-truncated prefix: valid JSON never survives the cut.
        Effect.succeed({ ...output('[{"old_path":"src/x.ts","new_p'), stdoutTruncated: true }),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiff({ cwd: "/w", repository: "acme/web", number: 7 }),
      );

      // An empty slice with no cursor would report every file from this page on as already
      // read, which is the one answer that loses a change without saying so.
      assert.strictEqual(error._tag, "GitLabMergeRequestReadError");
    }),
  );

  it.effect("offers no squash when the project does not say it allows one", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        Effect.succeed(output(JSON.stringify({ merge_method: "merge" }))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const capabilities = yield* cli.getProjectMergeCapabilities({
        cwd: "/w",
        repository: "acme/web",
      });

      assert.deepStrictEqual(capabilities, { merge: true, squash: false, rebase: false });
    }),
  );

  it.effect("reads the project's merge settings as its merge capabilities", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        Effect.succeed(output(JSON.stringify({ merge_method: "ff", squash_option: "never" }))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const capabilities = yield* cli.getProjectMergeCapabilities({
        cwd: "/w",
        repository: "acme/web",
      });

      assert.deepStrictEqual(capabilities, { merge: false, squash: false, rebase: true });
    }),
  );

  it.effect("fails the read when GitLab returns something unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"message":"404 Not Found"}')));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDetail({ cwd: "/w", repository: "acme/web", number: 7 }),
      );

      assert.strictEqual(error._tag, "GitLabMergeRequestReadError");
    }),
  );

  it.effect("fails when the authenticated account has no username", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(JSON.stringify({ username: "" }))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(cli.getViewerUsername({ cwd: "/w" }));

      assert.strictEqual(error._tag, "GitLabViewerUnavailableError");
    }),
  );

  it.effect("walks the notes until GitLab answers with a short page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(notes(100, 1))));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(notes(2, 101))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const { comments, truncated } = yield* cli.listNotes({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(argsOfCall(0).join(" ")).toContain("page=1");
      expect(argsOfCall(1).join(" ")).toContain("page=2");
      assert.strictEqual(comments.length, 102);
      assert.isFalse(truncated);
    }),
  );

  it.effect("stops the note walk at its bound and says the conversation was cut short", () =>
    Effect.gen(function* () {
      // GitLab that never answers short: the walk has to end itself.
      mockedExecute.mockReturnValue(Effect.succeed(output(notes(100, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const { truncated } = yield* cli.listNotes({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 10);
      assert.isTrue(truncated);
    }),
  );

  it.effect("reads a positioned discussion as a thread anchored to its line", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                id: "abc123",
                notes: [
                  {
                    id: 1,
                    body: "rename this",
                    author: { username: "bilal", avatar_url: "https://avatars/b.png" },
                    created_at: "2026-07-01T00:00:00Z",
                    resolvable: true,
                    resolved: true,
                    position: {
                      position_type: "text",
                      new_path: "src/a.ts",
                      old_path: "src/a.ts",
                      new_line: 12,
                      old_line: null,
                    },
                  },
                  {
                    id: 2,
                    body: "done",
                    author: { username: "julius" },
                    created_at: "2026-07-01T01:00:00Z",
                  },
                ],
              },
              // A plain note is the timeline's business, not the diff's.
              { id: "def456", notes: [{ id: 3, body: "ship it", created_at: "2026-07-01Z" }] },
            ]),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const { threads } = yield* cli.listDiscussions({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.strictEqual(threads.length, 1);
      expect(threads[0]).toMatchObject({
        id: "abc123",
        path: "src/a.ts",
        line: 12,
        side: "right",
        isResolved: true,
      });
      assert.strictEqual(threads[0]?.comments.length, 2);
    }),
  );

  it.effect("sends a review as its comments, then its summary, then the verdict", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.submitReview({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        verdict: "approve",
        body: "Looks right.",
        comments: [
          { path: "src/b.ts", oldPath: "src/a.ts", line: 4, side: "left", body: "why remove?" },
        ],
      });

      // The diff revisions first, because a positioned comment cannot be placed without them.
      expect(argsOfCall(0)[1]).toContain("merge_requests/7");
      expect(argsOfCall(1)[1]).toContain("/discussions");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({
        body: "why remove?",
        position: {
          base_sha: "base",
          head_sha: "head",
          start_sha: "start",
          position_type: "text",
          // A renamed file is the only case the two differ, and GitLab cannot place a
          // position that names the same path on both sides of the rename.
          old_path: "src/a.ts",
          new_path: "src/b.ts",
          old_line: 4,
        },
      });
      expect(argsOfCall(2)[1]).toContain("/notes");
      // The verdict goes last, so a review that failed part-way is never an approval.
      expect(argsOfCall(3)[1]).toContain("/approve");
    }),
  );

  it.effect("does not ask for diff revisions when a review carries no line comments", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.submitReview({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        verdict: "comment",
        body: "One thought.",
        comments: [],
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(argsOfCall(0)[1]).toContain("/notes");
    }),
  );

  it.effect("resolves a discussion in place rather than posting to it", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setDiscussionResolution({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        discussionId: "abc123",
        resolved: true,
      });

      expect(argsOfCall(0)).toContain("--method");
      expect(argsOfCall(0)).toContain("PUT");
      expect(argsOfCall(0)[1]).toContain("/discussions/abc123");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({ resolved: true });
    }),
  );

  it.effect("names a merge request with no diff revisions rather than calling it unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: null,
            }),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.submitReview({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          verdict: "comment",
          body: "",
          comments: [{ path: "src/a.ts", line: 4, side: "right", body: "nit" }],
        }),
      );

      // Nothing failed to decode: GitLab answered, and the answer has nowhere to put a
      // positioned comment.
      assert.strictEqual(error._tag, "GitLabDiffRefsUnavailableError");
    }),
  );

  it.effect("reads who has access to the project and who is already on the merge request", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequestJson({ reviewers: [reviewer] }))))
        .mockReturnValueOnce(
          Effect.succeed(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            output(JSON.stringify([author, reviewer, { id: 9, username: "hubot" }])),
          ),
        );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const list = yield* cli.listReviewerCandidates({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(argsOfCall(1)[1]).toBe("projects/acme%2Fweb/users?per_page=100");
      // The author is left out, and whoever GitLab already has as a reviewer is marked.
      expect(list.candidates.map((candidate) => [candidate.id, candidate.isRequested])).toEqual([
        ["5", true],
        ["9", false],
      ]);
      assert.isFalse(list.truncated);
    }),
  );

  it.effect("writes the reviewer set back with the one being asked added to it", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequestJson({ reviewers: [reviewer] }))))
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "9" }],
        requested: true,
      });

      // GitLab replaces the whole set, so the reviewer already on the merge request has to be
      // sent back with the new one or the request would take them off it.
      expect(argsOfCall(1)).toContain("PUT");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ reviewer_ids: [5, 9] });
    }),
  );

  it.effect("takes a reviewer out of the set rather than clearing it", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(mergeRequestJson({ reviewers: [reviewer, { id: 9, username: "hubot" }] })),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "9" }],
        requested: false,
      });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ reviewer_ids: [5] });
    }),
  );

  it.effect("ignores an id GitLab could not have handed out, which names nobody", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequestJson({ reviewers: [reviewer] }))))
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "octocat" }],
        requested: true,
      });

      // Sending it as a number would rewrite the reviewer set around something nobody chose.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ reviewer_ids: [5] });
    }),
  );
});
