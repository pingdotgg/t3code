import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubGraphQlBudget from "../sourceControl/githubGraphQlBudget.ts";
import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import { BASE_COMPARISON_GRAPHQL_QUERY } from "./gitHubPullRequestJson.ts";

const mockedExecute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>();
const mockedGetPullRequest = vi.fn<GitHubCli.GitHubCli["Service"]["getPullRequest"]>();

const layer = it.layer(
  GitHubPullRequestCli.layer.pipe(
    Layer.provide(
      Layer.mock(GitHubCli.GitHubCli)({
        execute: mockedExecute,
        getPullRequest: mockedGetPullRequest,
      }),
    ),
    Layer.provide(GitHubGraphQlBudget.layer),
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

function pullRequests(
  count: number,
  firstNumber: number,
  overrides: (number: number) => Readonly<Record<string, unknown>> = () => ({}),
): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      number: firstNumber + index,
      title: `Pull request ${firstNumber + index}`,
      url: `https://github.com/acme/web/pull/${firstNumber + index}`,
      headRefName: "feat/page",
      baseRefName: "main",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      ...overrides(firstNumber + index),
    })),
  );
}

function pullRequestFiles(count: number, firstIndex: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      filename: `src/file${firstIndex + index}.ts`,
      status: "modified",
      patch: "@@ -1 +1 @@\n-old\n+new",
    })),
  );
}

/** One thread's comments as the GraphQL read returns them, cursor and all. */
function threadComments(
  ids: ReadonlyArray<string>,
  endCursor: string | null,
  totalCount = ids.length,
) {
  return {
    totalCount,
    pageInfo: { hasNextPage: endCursor !== null, endCursor },
    nodes: ids.map((id) => ({ id, body: id, createdAt: "2026-07-01T00:00:00Z" })),
  };
}

function thread(id: string, ...commentIds: ReadonlyArray<string>) {
  return {
    id,
    path: "src/a.ts",
    line: 1,
    diffSide: "RIGHT",
    isResolved: false,
    isOutdated: false,
    comments: threadComments(commentIds, null),
  };
}

function reviewThreadsPage(
  nodes: ReadonlyArray<Record<string, unknown>>,
  endCursor: string | null,
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            totalCount: nodes.length,
            pageInfo: { hasNextPage: endCursor !== null, endCursor },
            nodes,
          },
        },
      },
    },
  });
}

function threadCommentsPage(
  ids: ReadonlyArray<string>,
  endCursor: string | null,
  totalCount: number,
  pullRequestId = "PR_7",
): string {
  return JSON.stringify({
    data: {
      repository: { pullRequest: { id: "PR_7" } },
      node: {
        pullRequest: { id: pullRequestId },
        comments: threadComments(ids, endCursor, totalCount),
      },
    },
  });
}

/** What `gh pr diff` answers on a pull request GitHub will not serve a diff for. */
const diffRefused = new GitHubCli.GitHubCliCommandError({
  command: "gh",
  cwd: "/w",
  cause: new Error("HTTP 406: the diff exceeded the maximum number of files (300)"),
});

/** The whole invocation the nth call made, so both argv and stdin can be asserted. */
function callAt(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

/** The one argument `--search` carries, which is where every listing filter ends up. */
function searchOfCall(index: number): string | undefined {
  const args = callAt(index).args;
  const flag = args.indexOf("--search");
  // Absent is its own answer: a read that carries no `--search` at all is what the fallback is.
  return flag === -1 ? undefined : args[flag + 1];
}

/** One row as a search answers it, which is the listing's row one connection deeper. */
function searchItem(number: number, repository: string, updatedAt: string) {
  return {
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/${repository}/pull/${number}`,
    author: { login: "octocat", avatarUrl: "https://avatars/octocat" },
    headRefName: "feat/page",
    baseRefName: "main",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    repository: { nameWithOwner: repository },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "hubot" } }] },
    labels: { nodes: [{ name: "bug", color: "ff0000" }] },
  };
}

function searchPage(nodes: ReadonlyArray<unknown>, hasNextPage = false) {
  return output(JSON.stringify({ data: { search: { pageInfo: { hasNextPage }, nodes } } }));
}

/** The search a batched read sent, which travels in the request body rather than in argv. */
function searchQueryOfCall(index: number): string | undefined {
  const body = JSON.parse(callAt(index).stdin ?? "{}") as { variables?: { q?: string } };
  return body.variables?.q;
}

afterEach(() => {
  mockedExecute.mockReset();
  mockedGetPullRequest.mockReset();
});

layer("GitHubPullRequestCli.layer", (it) => {
  it.effect("reads linked pull request status through one narrow request", () =>
    Effect.gen(function* () {
      mockedGetPullRequest.mockReturnValueOnce(
        Effect.succeed({
          number: 7,
          title: "Reuse the summary",
          url: "https://github.com/acme/web/pull/7",
          baseRefName: "main",
          headRefName: "feat/summary",
          state: "open",
          updatedAt: "2026-08-24T12:34:56.000Z",
        }),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const summary = yield* cli.getPullRequestSummary({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.deepStrictEqual(summary, {
        number: 7,
        title: "Reuse the summary",
        url: "https://github.com/acme/web/pull/7",
        headBranch: "feat/summary",
        baseBranch: "main",
        state: "open",
        updatedAt: "2026-08-24T12:34:56.000Z",
      });
      expect(mockedGetPullRequest).toHaveBeenCalledOnce();
      expect(mockedGetPullRequest).toHaveBeenCalledWith({
        cwd: "/w",
        reference: "https://github.com/acme/web/pull/7",
      });
      expect(mockedExecute).not.toHaveBeenCalled();
    }),
  );

  it.effect("asks for one row more than the page, to probe for a next page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(3, 1))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 3);
      assert.isFalse(batch.truncated);
      const args = callAt(0).args;
      expect(args).toContain("--repo");
      expect(args).toContain("github.com/acme/web");
      expect(args).toContain("--state");
      expect(args).toContain("open");
      expect(args).toContain("--limit");
      expect(args).toContain("11");
    }),
  );

  it.effect("reports truncation from the extra row, counted before decoding", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(11, 1))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 10);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("excludes merged pull requests from the Closed tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      // `--state closed` includes merged pull requests, so the tab narrows through search.
      expect(searchOfCall(0)).toBe("is:unmerged sort:updated-desc");
    }),
  );

  it.effect("narrows to the author on the authored tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "authored",
        viewer: "bilal",
        limit: 10,
      });

      const args = callAt(0).args;
      expect(args).toContain("--author");
      expect(args).toContain("bilal");
    }),
  );

  it.effect("narrows through search on the reviewing tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
      });

      expect(searchOfCall(0)).toBe("review-requested:bilal sort:updated-desc");
    }),
  );

  it.effect("carries every repository and every qualifier into one search", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web", "pingdotgg/t3code"],
        state: "closed",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
        query: "pull requests page",
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      // One request for both repositories, carrying everything the per-repository read expresses
      // as a flag: the tab, the involvement, the reader's words, where to carry on from, and the
      // order the page reads in.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      assert.strictEqual(
        searchQueryOfCall(0),
        'is:pr is:closed is:unmerged review-requested:bilal "pull requests page" ' +
          "updated:<=2026-07-02T00:00:00Z sort:updated-desc repo:acme/web repo:pingdotgg/t3code",
      );
    }),
  );

  it.effect("narrows a search to the author, and to merged on the merged tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web"],
        state: "merged",
        involvement: "authored",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(
        searchQueryOfCall(0),
        "is:pr is:merged author:bilal sort:updated-desc repo:acme/web",
      );
    }),
  );

  it.effect("keeps a searched-for qualifier inside the phrase, and out of argv", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: 'x" is:merged repo:evil/repo',
      });

      // Quoted and escaped, so the words a reader typed narrow the listing rather than widening
      // it — and the whole document travels over stdin rather than in a visible argv.
      assert.strictEqual(
        searchQueryOfCall(0),
        'is:pr is:open "x\\" is:merged repo:evil/repo" sort:updated-desc repo:acme/web',
      );
      expect(callAt(0).args).not.toContain("-f");
    }),
  );

  it.effect("refuses to search for a repository GitHub cannot address", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const failure = yield* Effect.flip(
        cli.searchPullRequests({
          cwd: "/w",
          host: "github.com",
          repositories: ["acme/web", "acme/web is:merged"],
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
        }),
      );

      // Nothing is sent: a name that could end its own qualifier is refused rather than escaped.
      assert.strictEqual(failure._tag, "GitHubRepositorySelectorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("files each searched row under the repository it came from", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          searchPage([
            searchItem(7, "acme/web", "2026-07-03T00:00:00Z"),
            searchItem(9, "pingdotgg/t3code", "2026-07-02T00:00:00Z"),
            // Not a pull request, which `is:pr` excludes and a decode skips rather than fails on.
            {},
          ]),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const batch = yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web", "pingdotgg/t3code"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.deepStrictEqual(
        batch.items.map((item) => [item.repository, item.number, item.author?.avatarUrl]),
        [
          ["acme/web", 7, "https://avatars/octocat"],
          ["pingdotgg/t3code", 9, "https://avatars/octocat"],
        ],
      );
      // The listing leaves the line counts to a read of their own.
      assert.deepStrictEqual(
        batch.items.map((item) => [item.additions, item.deletions]),
        [
          [0, 0],
          [0, 0],
        ],
      );
      assert.isFalse(batch.truncated);
    }),
  );

  it.effect("reports truncation from the extra row, and from a page GitHub says has more", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            searchPage([
              searchItem(1, "acme/web", "2026-07-03T00:00:00Z"),
              searchItem(2, "acme/web", "2026-07-02T00:00:00Z"),
              searchItem(3, "acme/web", "2026-07-01T00:00:00Z"),
            ]),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(searchPage([searchItem(1, "acme/web", "2026-07-03T00:00:00Z")], true)),
        );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;
      const read = () =>
        cli.searchPullRequests({
          cwd: "/w",
          host: "github.com",
          repositories: ["acme/web"],
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 2,
        });

      const overflowing = yield* read();
      const capped = yield* read();

      // The extra row is the probe, and it is not handed on.
      assert.strictEqual(overflowing.items.length, 2);
      assert.isTrue(overflowing.truncated);
      // A slice at GitHub's own ceiling has no extra row to probe with, so `hasNextPage` answers.
      assert.isTrue(capped.truncated);
    }),
  );

  it.effect("reads the line counts in chunks, and files them back by position", () =>
    Effect.gen(function* () {
      const changeRequests = Array.from({ length: 26 }, (_, index) => ({
        repository: "acme/web",
        number: index + 1,
      }));
      mockedExecute.mockImplementation(() =>
        // Every chunk answers for its first alias only, so a row GitHub said nothing about is
        // dropped rather than shown as a change of no size.
        Effect.succeed(
          output(JSON.stringify({ data: { s0: { pullRequest: { additions: 4, deletions: 1 } } } })),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const stats = yield* cli.listPullRequestStats({
        cwd: "/w",
        host: "github.com",
        changeRequests,
      });

      // Twenty-five aliases a request, so twenty-six rows are two requests.
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      assert.deepStrictEqual(stats, [
        { repository: "acme/web", number: 1, additions: 4, deletions: 1 },
        { repository: "acme/web", number: 26, additions: 4, deletions: 1 },
      ]);
      const document = callAt(0).args.at(-1) ?? "";
      expect(document).toContain('s0: repository(owner: "acme", name: "web")');
      expect(document).toContain("pullRequest(number: 25)");
    }),
  );

  it.effect("refuses to look up counts for a repository GitHub cannot address", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const failure = yield* Effect.flip(
        cli.listPullRequestStats({
          cwd: "/w",
          host: "github.com",
          changeRequests: [{ repository: 'acme/web") { x } #', number: 1 }],
        }),
      );

      assert.strictEqual(failure._tag, "GitHubRepositorySelectorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("hands a search to GitHub rather than to the rows already read", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "pull requests page",
      });

      // The recency qualifier rides along, because free text would otherwise reorder the page
      // by relevance and truncation would drop the newest matches.
      expect(searchOfCall(0)).toBe('"pull requests page" sort:updated-desc');
    }),
  );

  it.effect("joins a search onto the tab's own qualifiers instead of replacing them", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
        query: "page",
      });

      // One `--search` is all gh reads, so a second would silently drop the first.
      const args = callAt(0).args;
      assert.strictEqual(args.filter((arg) => arg === "--search").length, 1);
      expect(searchOfCall(0)).toBe('review-requested:bilal is:unmerged "page" sort:updated-desc');
    }),
  );

  it.effect("carries the further narrowings into the search as qualifiers", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: {
          draft: "hide",
          review: "changes-requested",
          checks: "failing",
          labels: [["needs design"], ['quo"te']],
          excludedLabels: ["wip"],
          author: "octocat",
        },
      });

      // Quotes around anything a reader typed, and the one character that could end a quoted
      // value early dropped rather than escaped.
      expect(searchOfCall(0)).toBe(
        'label:"needs design" label:"quote" -label:"wip" author:"octocat" draft:false ' +
          "review:changes_requested status:failure sort:updated-desc",
      );
    }),
  );

  it.effect('resolves an author filter of "me" to the viewer, not the literal word', () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { author: "me" },
      });

      expect(searchOfCall(0)).toBe('author:"bilal" sort:updated-desc');
    }),
  );

  it.effect("sends one label qualifier per group, its names joined the way GitHub ors them", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { labels: [["size:S", "size:XS"], ["bug"]] },
      });

      // One qualifier satisfied by either size, and a second one that must hold as well.
      expect(searchOfCall(0)).toBe('label:"size:S","size:XS" label:"bug" sort:updated-desc');
      expect(callAt(0).args).toContain('label:"size:S","size:XS" label:"bug" sort:updated-desc');
    }),
  );

  it.effect(
    "falls back for a repository the index does not cover under a checks filter, keeping only the matching rows",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              pullRequests(2, 1, (number) => ({
                statusCheckRollup:
                  number === 1
                    ? [{ name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }]
                    : [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
              })),
            ),
          ),
        );
        const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

        const batch = yield* cli.listPullRequests({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          filters: { checks: "passing" },
        });

        // The fallback's rows carry `checksState` exactly as a search's rows do, so `checks` is
        // now a filter the fallback judges itself, the same as `draft`: an empty search answer
        // under it is still ambiguous, and the row picked out afterwards is the one whose own
        // `checksState` reads "passing".
        expect(searchOfCall(1)).toBeUndefined();
        assert.deepStrictEqual(
          batch.items.map((item) => item.number),
          [1],
        );
      }),
  );

  it.effect("fails a checks filter for a row whose checks are still pending", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            pullRequests(1, 1, () => ({
              statusCheckRollup: [{ name: "build", status: "IN_PROGRESS" }],
            })),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { checks: "passing" },
      });

      // Pending equals neither "passing" nor "failing", so it satisfies neither filter value —
      // the same row would also be dropped by `checks: "failing"`.
      assert.deepStrictEqual(batch.items, []);
    }),
  );

  it.effect(
    "falls back for a repository the index does not cover even under a judgeable filter",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(output(pullRequests(2, 1, (number) => ({ isDraft: number === 1 })))),
        );
        const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

        const batch = yield* cli.listPullRequests({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          filters: { draft: "hide" },
        });

        // `draft` is a filter the fallback can judge over its own rows just as search judges it,
        // so an empty search answer under it alone is still ambiguous between "nothing matches"
        // and "this repository is not indexed" — and the fallback applies the filter itself,
        // keeping only the non-draft row.
        expect(searchOfCall(1)).toBeUndefined();
        expect(batch.items.map((item) => item.number)).toEqual([2]);
      }),
  );

  it.effect("carries the further narrowings into a batched search", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { draft: "only", review: "none", labels: [["bug"]] },
      });

      assert.strictEqual(
        searchQueryOfCall(0),
        'is:pr is:open label:"bug" draft:true review:none sort:updated-desc repo:acme/web',
      );
    }),
  );

  it.effect("quotes a search, so it cannot add a qualifier or a flag of its own", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: '-- is:merged label:secret "widen me"',
      });

      // Every word stays inside one phrase: nothing before it, nothing after it, and the
      // leading dashes are text rather than the start of another argument.
      expect(searchOfCall(0)).toBe(
        String.raw`"-- is:merged label:secret \"widen me\"" sort:updated-desc`,
      );
      expect(callAt(0).args).not.toContain("is:merged");
    }),
  );

  it.effect("escapes a backslash before the quote it would otherwise let out", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: String.raw`a\" is:merged`,
      });

      // GitHub reads `\\` as one backslash and `\"` as one quote, so the phrase ends where
      // this says it does; escaping the quote alone would have closed it early.
      expect(searchOfCall(0)).toBe(String.raw`"a\\\" is:merged" sort:updated-desc`);
    }),
  );

  it.effect("asks for nothing but the order when the reader typed only spaces", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "   ",
      });

      // An empty phrase would match nothing rather than everything, so it is left out; the
      // order the page reads rows in is asked for whether or not anything was typed.
      expect(searchOfCall(0)).toBe("sort:updated-desc");
    }),
  );

  it.effect("carries on from the instant the last slice ended on", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output(pullRequests(3, 1))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      // Inclusive, so the rows already sent at that instant come back for the caller to drop —
      // which is what keeps the ones beside them from being skipped.
      expect(searchOfCall(0)).toBe("updated:<=2026-07-02T00:00:00Z sort:updated-desc");
      assert.isTrue(batch.continues);
    }),
  );

  it.effect("answers a search that found nothing with nothing, not with the whole repository", () =>
    Effect.gen(function* () {
      // The fallback is for a repository the index does not cover. Under a text search an empty
      // answer means the text matched nothing, and listing everything instead would fill the
      // page with rows the reader did not search for.
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "fdsfklj",
      });

      assert.strictEqual(batch.items.length, 0);
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("reads a repository GitHub will not search the way gh lists one", () =>
    Effect.gen(function* () {
      // GitHub answers for a repository outside its search index with no rows and no error.
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(pullRequests(3, 1, () => ({ state: "CLOSED" })))),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 3);
      // The fallback itself uses no search, then narrows the decoded rows locally. They still
      // arrive in gh's own order, so nothing can carry on from them.
      expect(searchOfCall(1)).toBeUndefined();
      assert.isFalse(batch.continues);
    }),
  );

  it.effect("keeps state and involvement filters on the search-free fallback", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            pullRequests(4, 1, (number) => ({
              state: number === 4 ? "OPEN" : "CLOSED",
              ...(number === 3 ? { mergedAt: "2026-07-03T00:00:00Z" } : {}),
              reviewRequests:
                number === 2 ? [{ slug: "platform", name: "Platform" }] : [{ login: "bilal" }],
            })),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
      });

      // Individual requests for this viewer and team requests survive. The fallback cannot
      // resolve team membership, so dropping team-routed reviews would hide legitimate work.
      expect(batch.items.map((item) => item.number)).toEqual([1, 2]);
      expect(searchOfCall(1)).toBeUndefined();
      assert.isFalse(batch.continues);
    }),
  );

  it.effect("grows the search-free fallback until it fills the filtered page", () =>
    Effect.gen(function* () {
      const unrelated = () => ({ reviewRequests: [{ login: "somebody-else" }] });
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(3, 1, unrelated))));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            pullRequests(4, 1, (number) =>
              number === 4 ? { reviewRequests: [{ login: "bilal" }] } : unrelated(),
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 2,
      });

      expect(batch.items.map((item) => item.number)).toEqual([4]);
      const firstFallbackArgs = callAt(1).args;
      const secondFallbackArgs = callAt(2).args;
      expect(firstFallbackArgs[firstFallbackArgs.indexOf("--limit") + 1]).toBe("3");
      expect(secondFallbackArgs[secondFallbackArgs.indexOf("--limit") + 1]).toBe("6");
      assert.isFalse(batch.truncated);
    }),
  );

  it.effect("bounds a sparse search-free fallback and reports the unread tail", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((_input) => {
        if (mockedExecute.mock.calls.length === 1) return Effect.succeed(output("[]"));
        const args = callAt(mockedExecute.mock.calls.length - 1).args;
        const limit = Number(args[args.indexOf("--limit") + 1]);
        return Effect.succeed(
          output(
            pullRequests(limit, 1, () => ({
              reviewRequests: [{ login: "somebody-else" }],
            })),
          ),
        );
      });
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 2,
      });

      const finalArgs = callAt(mockedExecute.mock.calls.length - 1).args;
      expect(finalArgs[finalArgs.indexOf("--limit") + 1]).toBe("1000");
      assert.strictEqual(batch.items.length, 0);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("takes an empty slice for a repository that has run out, not one to read again", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      // A repository that answered the search once answers it again, so an empty slice under a
      // cursor is the end of it rather than a repository search cannot reach.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("updates a stale branch with a merge commit unless asked to rebase", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "update-branch",
      });
      // GitHub's own default, and `gh`'s: a merge commit unless the rebase flag says otherwise.
      expect(callAt(0).args).toEqual(["pr", "update-branch", "7", "--repo", "github.com/acme/web"]);

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "update-branch",
        updateMethod: "rebase",
      });
      expect(callAt(1).args).toEqual([
        "pr",
        "update-branch",
        "7",
        "--repo",
        "github.com/acme/web",
        "--rebase",
      ]);
    }),
  );

  it.effect("merges with the strategy it was asked for", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "merge",
        mergeMethod: "squash",
      });

      expect(callAt(0).args).toEqual([
        "pr",
        "merge",
        "7",
        "--repo",
        "github.com/acme/web",
        "--squash",
      ]);
    }),
  );

  it.effect("arms auto-merge with the same strategy a merge would have used", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "enable-auto-merge",
        mergeMethod: "squash",
      });
      expect(callAt(0).args).toEqual([
        "pr",
        "merge",
        "7",
        "--repo",
        "github.com/acme/web",
        "--auto",
        "--squash",
      ]);

      // No strategy asked for is GitHub's own default, exactly as it is for a merge now.
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "enable-auto-merge",
      });
      expect(callAt(1).args).toEqual([
        "pr",
        "merge",
        "7",
        "--repo",
        "github.com/acme/web",
        "--auto",
        "--merge",
      ]);
    }),
  );

  it.effect("takes auto-merge back off without naming a strategy", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "disable-auto-merge",
        mergeMethod: "squash",
      });

      expect(callAt(0).args).toEqual([
        "pr",
        "merge",
        "7",
        "--repo",
        "github.com/acme/web",
        "--disable-auto",
      ]);
    }),
  );

  it.effect("opens a pull request that reverts a merged pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off - canned gh GraphQL response.
            JSON.stringify({
              data: { repository: { pullRequest: { id: "PR_7" } } },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "revert",
      });

      expect(callAt(0).args).toContain("owner=acme");
      expect(callAt(0).args).toContain("name=web");
      expect(callAt(0).args).toContain("number=7");
      expect(callAt(1).args).toEqual([
        "api",
        "graphql",
        "--hostname",
        "github.com",
        "--input",
        "-",
      ]);
      expect(callAt(1).stdin).toContain("revertPullRequest");
      expect(callAt(1).stdin).toContain('"pullRequestId":"PR_7"');
    }),
  );

  it.effect("does not approve action-required runs for a same-repository pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off - canned gh response.
            JSON.stringify({
              number: 7,
              title: "Pull request 7",
              url: "https://github.com/acme/web/pull/7",
              headRefName: "feat/page",
              headRefOid: "abc123",
              isCrossRepository: false,
              headRepositoryOwner: { login: "acme" },
              baseRefName: "main",
              createdAt: "2026-07-01T00:00:00Z",
              updatedAt: "2026-07-02T00:00:00Z",
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "approve-workflows",
      });

      expect(mockedExecute).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("finds and approves every workflow waiting on a maintainer", () =>
    Effect.gen(function* () {
      const detail = output(
        // @effect-diagnostics-next-line preferSchemaOverJson:off - canned gh response.
        JSON.stringify({
          number: 7,
          title: "Pull request 7",
          url: "https://github.com/acme/web/pull/7",
          headRefName: "feat/page",
          headRefOid: "abc123",
          isCrossRepository: true,
          headRepositoryOwner: { login: "octocat" },
          baseRefName: "main",
          createdAt: "2026-07-01T00:00:00Z",
          updatedAt: "2026-07-02T00:00:00Z",
        }),
      );
      const heads = output(
        // @effect-diagnostics-next-line preferSchemaOverJson:off - canned gh response.
        JSON.stringify([
          {
            number: 7,
            headRefOid: "abc123",
            isCrossRepository: true,
            headRepositoryOwner: { login: "octocat" },
          },
        ]),
      );
      const runs = output(
        // @effect-diagnostics-next-line preferSchemaOverJson:off - canned gh response.
        JSON.stringify([
          { databaseId: 10, workflowName: "build", url: "https://example.com/10" },
          { databaseId: 11, workflowName: "test", url: "https://example.com/11" },
        ]),
      );
      for (const result of [
        detail,
        heads,
        runs,
        detail,
        heads,
        runs,
        output(""),
        detail,
        heads,
        runs,
        output(""),
      ]) {
        mockedExecute.mockReturnValueOnce(Effect.succeed(result));
      }
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "approve-workflows",
      });

      expect(callAt(1).args).toEqual([
        "pr",
        "list",
        "--repo",
        "github.com/acme/web",
        "--state",
        "open",
        "--head",
        "feat/page",
        "--limit",
        "1001",
        "--json",
        "number,headRefOid,isCrossRepository,headRepositoryOwner",
      ]);
      expect(callAt(2).args).toEqual([
        "run",
        "list",
        "--repo",
        "github.com/acme/web",
        "--commit",
        "abc123",
        "--branch",
        "feat/page",
        "--event",
        "pull_request",
        "--status",
        "action_required",
        "--limit",
        "1001",
        "--json",
        "databaseId,workflowName,url",
      ]);
      expect([callAt(6).args, callAt(10).args]).toEqual([
        [
          "api",
          "--method",
          "POST",
          "--hostname",
          "github.com",
          "repos/acme/web/actions/runs/10/approve",
          "--silent",
        ],
        [
          "api",
          "--method",
          "POST",
          "--hostname",
          "github.com",
          "repos/acme/web/actions/runs/11/approve",
          "--silent",
        ],
      ]);
      expect(mockedExecute).toHaveBeenCalledTimes(11);
    }),
  );

  it.effect("refuses a stale workflow approval after the pull request head changes", () =>
    Effect.gen(function* () {
      const detail = {
        number: 7,
        title: "Pull request 7",
        url: "https://github.com/acme/web/pull/7",
        headRefName: "feat/page",
        headRefOid: "abc123",
        isCrossRepository: true,
        headRepositoryOwner: { login: "octocat" },
        baseRefName: "main",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-02T00:00:00Z",
      };
      for (const value of [
        detail,
        [
          {
            number: 7,
            headRefOid: "abc123",
            isCrossRepository: true,
            headRepositoryOwner: { login: "octocat" },
          },
        ],
        [{ databaseId: 10, workflowName: "build", url: "https://example.com/10" }],
        { ...detail, headRefOid: "def456" },
      ]) {
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              // @effect-diagnostics-next-line preferSchemaOverJson:off - canned gh response.
              JSON.stringify(value),
            ),
          ),
        );
      }
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "approve-workflows",
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalHeadChangedError",
        number: 7,
      });
      expect(mockedExecute).toHaveBeenCalledTimes(4);
    }),
  );

  it.effect("refuses workflow approval when one head belongs to several pull requests", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off - canned gh response.
            JSON.stringify(
              [7, 8].map((number) => ({
                number,
                headRefOid: "abc123",
                isCrossRepository: true,
                headRepositoryOwner: { login: "octocat" },
              })),
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.listWorkflowRunsRequiringApproval({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          headSha: "abc123",
          headBranch: "feat/page",
          headRepositoryOwner: "octocat",
          isCrossRepository: true,
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalRefusedError",
        reason: "head-not-unique",
        number: 7,
        observedCount: 2,
        limit: 1_000,
      });
      expect(error.detail).toContain("instead of uniquely matching #7");
      expect(mockedExecute).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("refuses workflow approval when GitHub omits the head repository", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off - canned gh response.
            JSON.stringify({
              number: 7,
              title: "Pull request 7",
              url: "https://github.com/acme/web/pull/7",
              headRefName: "feat/page",
              headRefOid: "abc123",
              isCrossRepository: true,
              headRepositoryOwner: null,
              baseRefName: "main",
              createdAt: "2026-07-01T00:00:00Z",
              updatedAt: "2026-07-02T00:00:00Z",
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "approve-workflows",
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalHeadUnavailableError",
        number: 7,
      });
      expect(mockedExecute).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("surfaces a workflow run list beyond the safe approval bound", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off - canned gh response.
            JSON.stringify([
              {
                number: 7,
                headRefOid: "abc123",
                isCrossRepository: true,
                headRepositoryOwner: { login: "octocat" },
              },
            ]),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off - canned gh response.
            JSON.stringify(Array.from({ length: 1_001 }, (_, id) => ({ databaseId: id + 1 }))),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.listWorkflowRunsRequiringApproval({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          headSha: "abc123",
          headBranch: "feat/page",
          headRepositoryOwner: "octocat",
          isCrossRepository: true,
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalRefusedError",
        reason: "run-list-truncated",
        number: 7,
        observedCount: 1_001,
        limit: 1_000,
      });
      expect(error.detail).toContain("more than 1000 workflow runs");
      expect(mockedExecute).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("returns a pull request to draft by undoing ready", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "draft",
      });

      // gh has no `draft` command; going back is `ready --undo`.
      expect(callAt(0).args).toEqual([
        "pr",
        "ready",
        "7",
        "--repo",
        "github.com/acme/web",
        "--undo",
      ]);
    }),
  );

  it.effect("sends a comment body over stdin, never in argv", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.commentOnPullRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        body: "Looks good.",
      });

      // argv shows up in process listings and in process-runner failure messages.
      expect(callAt(0).args).toEqual([
        "pr",
        "comment",
        "7",
        "--repo",
        "github.com/acme/web",
        "--body-file",
        "-",
      ]);
      expect(callAt(0).stdin).toBe("Looks good.");
      expect(callAt(0).args).not.toContain("Looks good.");
    }),
  );

  it.effect("names the host on every repository it addresses", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      // A bare `owner/repo` resolves against github.com, which is a different repository.
      expect(callAt(0).args).toContain("github.acme.dev/acme/web");
    }),
  );

  it.effect("asks a GitHub Enterprise host for its own review threads", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              data: {
                repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        number: 7,
      });

      const args = callAt(0).args;
      expect(args).toContain("--hostname");
      expect(args).toContain("github.acme.dev");
      expect(args).toContain("owner=acme");
      expect(args).toContain("name=web");
    }),
  );

  it.effect("serves a diff GitHub hands over whole in one request, with no next slice", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("diff --git a/a b/a")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.isNull(diff.nextCursor);
      assert.isFalse(diff.truncated);
      // The common case pays for one request and not the files API on top of it.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      // `--patch` asks gh for a format-patch stream, which repeats a file once per commit.
      // The review needs GitHub's combined pull-request diff: one section per changed file.
      expect(callAt(0).args).not.toContain("--patch");
    }),
  );

  it.effect("reads one files page when GitHub refuses the diff, and says it is the last", () =>
    Effect.gen(function* () {
      // GitHub answers 406 rather than a diff past 300 changed files.
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(2, 1))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        number: 7,
      });

      assert.isFalse(diff.truncated);
      // A short page is the end of the change set, so there is nothing to carry on from.
      assert.isNull(diff.nextCursor);
      expect(diff.patch).toContain("diff --git a/src/file1.ts b/src/file1.ts");
      expect(diff.patch).toContain("diff --git a/src/file2.ts b/src/file2.ts");
      const args = callAt(1).args;
      expect(args).toContain("--hostname");
      expect(args).toContain("github.acme.dev");
      expect(args).toContain("repos/acme/web/pulls/7/files?per_page=100&page=1");
    }),
  );

  it.effect("hands back a cursor for the next page rather than walking on by itself", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(100, 0))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      // A full page means more files, which the reader asks for; it is not a truncated slice.
      assert.isFalse(diff.truncated);
      assert.isNotNull(diff.nextCursor);
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("carries on from a cursor without asking `gh pr diff` again", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(100, 0))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;
      const target = { cwd: "/w", repository: "acme/web", host: "github.com", number: 7 };

      const first = yield* cli.getPullRequestDiff(target);
      assert.isNotNull(first.nextCursor);
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(4, 100))));
      const second = yield* cli.getPullRequestDiff({ ...target, cursor: first.nextCursor });

      assert.isNull(second.nextCursor);
      expect(second.patch).toContain("diff --git a/src/file100.ts b/src/file100.ts");
      // The second slice is one request: the cursor already says where to read.
      assert.strictEqual(mockedExecute.mock.calls.length, 3);
      expect(callAt(2).args).toContain("repos/acme/web/pulls/7/files?per_page=100&page=2");
    }),
  );

  it.effect("refuses a cursor it never handed out rather than reading it into a request", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          cursor: "1&per_page=1",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffCursorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("reads a named commit from the commit endpoint rather than from `gh pr diff`", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(2, 1))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        commit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      });

      // One request: the commit's own changes never take the `gh pr diff` road.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      assert.isNull(diff.nextCursor);
      expect(diff.patch).toContain("diff --git a/src/file1.ts b/src/file1.ts");
      const args = callAt(0).args;
      expect(args).toContain(
        "repos/acme/web/commits/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0?per_page=100&page=1",
      );
      // The commit endpoint wraps its files in an object, which jq unwraps for the decoder.
      expect(args).toContain(".files // []");
    }),
  );

  it.effect("pages inside a commit the way it pages the pull request's own files", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(100, 0))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;
      const target = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        commit: "a1b2c3d",
      };

      const first = yield* cli.getPullRequestDiff(target);
      assert.isNotNull(first.nextCursor);
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(4, 100))));
      const second = yield* cli.getPullRequestDiff({ ...target, cursor: first.nextCursor });

      assert.isNull(second.nextCursor);
      expect(callAt(1).args).toContain("repos/acme/web/commits/a1b2c3d?per_page=100&page=2");
    }),
  );

  it.effect("refuses a commit that is not a sha rather than reading it into a request", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commit: "../../pulls/8/files",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffCommitError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("expands a new file from a root commit without requiring a parent", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("\ta1b2c3d\n")));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("root contents\n")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const contents = yield* cli.getPullRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        commit: "a1b2c3d",
        changeType: "new",
        oldPath: "src/root.ts",
        newPath: "src/root.ts",
      });

      expect(contents).toEqual({ oldContents: "", newContents: "root contents\n" });
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(callAt(1).args.join(" ")).toContain("contents/src/root.ts?ref=a1b2c3d");
    }),
  );

  it.effect("reports unusable diff revisions as a structured error", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("not-a-sha\tstill-not-a-sha\n")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.getPullRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commit: "a1b2c3d",
          changeType: "change",
          oldPath: "src/a.ts",
          newPath: "src/a.ts",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffRevisionsUnavailableError");
      if (error._tag === "GitHubDiffRevisionsUnavailableError") {
        assert.strictEqual(error.number, 7);
        assert.strictEqual(error.commit, "a1b2c3d");
      }
    }),
  );

  it.effect("reports an oversized diff file with its path and reason", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("a1b2c3d\tb1c2d3e\n")));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("partial", true)));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.getPullRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          changeType: "deleted",
          oldPath: "src/large.ts",
          newPath: "src/large.ts",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffFileContentsUnavailableError");
      if (error._tag === "GitHubDiffFileContentsUnavailableError") {
        assert.strictEqual(error.path, "src/large.ts");
        assert.strictEqual(error.reason, "oversized");
      }
    }),
  );

  it.effect("reports undecodable diff file contents as binary", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("a1b2c3d\tb1c2d3e\n")));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output("binary\uFFFDcontents", false, true)),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.getPullRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          changeType: "deleted",
          oldPath: "assets/logo.png",
          newPath: "assets/logo.png",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffFileContentsUnavailableError");
      if (error._tag === "GitHubDiffFileContentsUnavailableError") {
        assert.strictEqual(error.path, "assets/logo.png");
        assert.strictEqual(error.reason, "binary");
      }
    }),
  );

  it.effect("returns valid text containing a literal replacement character", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("a1b2c3d\tb1c2d3e\n")));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("before\uFFFDafter")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const contents = yield* cli.getPullRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
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
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        cursor: "4",
      });

      assert.strictEqual(diff.patch, "");
      assert.isNull(diff.nextCursor);
    }),
  );

  it.effect("reports the refused diff when the files API cannot answer either", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("not json")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      assert.strictEqual(error, diffRefused);
    }),
  );

  it.effect("skips the avatar lookup when a listing named nobody", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const avatars = yield* cli.listActorAvatars({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        ids: [],
      });

      assert.strictEqual(avatars.size, 0);
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("accounts for the avatar lookup in the GraphQL budget", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              data: {
                nodes: [{ login: "octocat", avatarUrl: "https://avatars/octocat" }],
                rateLimit: {
                  cost: 1,
                  limit: 5_000,
                  remaining: 4_999,
                  resetAt: "2099-08-13T14:00:00Z",
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const avatars = yield* cli.listActorAvatars({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        ids: ["MDQ6VXNlcjE="],
      });

      expect(callAt(0).args).toContain("ids[]=MDQ6VXNlcjE=");
      expect(callAt(0).args.at(-1)).toContain("rateLimit { cost limit remaining resetAt }");
      expect(avatars.get("octocat")).toBe("https://avatars/octocat");
    }),
  );

  it.effect("fails when the authenticated account has no login", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("  ")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(cli.getViewerLogin({ cwd: "/w" }));

      assert.strictEqual(error._tag, "GitHubViewerLoginUnavailableError");
    }),
  );

  it.effect("sends a whole review as one request body over stdin", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.submitReview({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        verdict: "approve",
        body: "Looks right.",
        comments: [{ path: "src/a.ts", position: { kind: "added", newLine: 4 }, body: "nit" }],
      });

      expect(callAt(0).args).toEqual([
        "api",
        "--method",
        "POST",
        "--hostname",
        "github.com",
        "repos/acme/web/pulls/7/reviews",
        "--input",
        "-",
      ]);
      // One request, so nothing is on the pull request until the verdict is.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({
        event: "APPROVE",
        body: "Looks right.",
        comments: [{ path: "src/a.ts", line: 4, side: "RIGHT", body: "nit" }],
      });
    }),
  );

  it.effect("sends a reply body over stdin, never in argv", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.replyToReviewThread({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        threadId: "PRRT_1",
        body: "Fixed in 42ff8ec.",
      });

      // A reply is the reader's own words, so it travels the same way a comment body does.
      expect(callAt(0).args).toEqual([
        "api",
        "graphql",
        "--hostname",
        "github.com",
        "--input",
        "-",
      ]);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const request = JSON.parse(callAt(0).stdin ?? "") as {
        query: string;
        variables: Record<string, string>;
      };
      expect(request.query).toContain("addPullRequestReviewThreadReply");
      expect(request.variables).toEqual({ threadId: "PRRT_1", body: "Fixed in 42ff8ec." });
      expect(callAt(0).args.join(" ")).not.toContain("Fixed in 42ff8ec.");
    }),
  );

  it.effect("resolves and unresolves through the mutation each one needs", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.setReviewThreadResolution({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        threadId: "PRRT_1",
        resolved: true,
      });
      yield* cli.setReviewThreadResolution({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        threadId: "PRRT_1",
        resolved: false,
      });

      const parse = (index: number) => JSON.parse(callAt(index).stdin ?? "") as { query: string };
      expect(parse(0).query).toContain("resolveReviewThread(");
      expect(parse(1).query).toContain("unresolveReviewThread(");
      // A GitHub Enterprise thread is resolved on its own host, not on github.com.
      expect(callAt(0).args).toContain("github.acme.dev");
    }),
  );

  it.effect("confirms a given subject belongs to the named pull request, then reacts to it", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              data: {
                repository: { pullRequest: { id: "PR_kwDOA" } },
                node: { id: "IC_1", pullRequest: { id: "PR_kwDOA" } },
              },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        subjectId: "IC_1",
        content: "heart",
        reacted: true,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      const scopeCheck = callAt(0).args;
      expect(scopeCheck).toContain("owner=acme");
      expect(scopeCheck).toContain("name=web");
      expect(scopeCheck).toContain("number=7");
      expect(scopeCheck).toContain("subjectId=IC_1");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const request = JSON.parse(callAt(1).stdin ?? "") as {
        query: string;
        variables: Record<string, string>;
      };
      expect(request.query).toContain("addReaction(");
      expect(request.variables).toEqual({ subjectId: "IC_1", content: "HEART" });
    }),
  );

  it.effect("refuses a given subject that belongs to a different pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              data: {
                repository: { pullRequest: { id: "PR_thisOne" } },
                // A comment on pull request #99 of a different repository, named as though it
                // belonged to #7 here.
                node: { id: "IC_99", pullRequest: { id: "PR_someOtherOne" } },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.setReaction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          subjectId: "IC_99",
          content: "heart",
          reacted: true,
        }),
      );

      assert.strictEqual(error._tag, "GitHubSubjectScopeError");
      // Refused before any mutation was sent.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("looks up the pull request's own node id when no subject was given", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({ data: { repository: { pullRequest: { id: "PR_kwDOA" } } } }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        content: "rocket",
        reacted: true,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      const lookup = callAt(0).args;
      expect(lookup).toContain("owner=acme");
      expect(lookup).toContain("name=web");
      expect(lookup).toContain("number=7");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const request = JSON.parse(callAt(1).stdin ?? "") as {
        query: string;
        variables: Record<string, string>;
      };
      expect(request.query).toContain("addReaction(");
      expect(request.variables).toEqual({ subjectId: "PR_kwDOA", content: "ROCKET" });
    }),
  );

  it.effect("takes a reaction back through the remove mutation", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              data: {
                repository: { pullRequest: { id: "PR_kwDOA" } },
                node: { id: "IC_1", pullRequest: { id: "PR_kwDOA" } },
              },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        subjectId: "IC_1",
        content: "heart",
        reacted: false,
      });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const request = JSON.parse(callAt(1).stdin ?? "") as { query: string };
      expect(request.query).toContain("removeReaction(");
    }),
  );

  it.effect("rewrites only the words a request named", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({ data: { repository: { pullRequest: { id: "PR_kwDOA" } } } }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;
      const rewrite = (fields: { readonly title?: string; readonly body?: string }) =>
        cli.updatePullRequest({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          ...fields,
        });

      yield* rewrite({ title: "A better title" });
      yield* rewrite({ body: "A better description." });
      yield* rewrite({ title: "Both", body: "at once." });

      // Each rewrite looks the pull request's node id up first, then mutates.
      const variablesAt = (index: number) =>
        (JSON.parse(callAt(index).stdin ?? "") as { variables: Record<string, string> }).variables;
      expect(variablesAt(1)).toEqual({ pullRequestId: "PR_kwDOA", title: "A better title" });
      expect(variablesAt(3)).toEqual({
        pullRequestId: "PR_kwDOA",
        body: "A better description.",
      });
      expect(variablesAt(5)).toEqual({
        pullRequestId: "PR_kwDOA",
        title: "Both",
        body: "at once.",
      });
      // The reader's own words, so they travel the way every other body does.
      expect(callAt(5).args.join(" ")).not.toContain("at once.");
    }),
  );

  it.effect("rewrites a remark through the mutation its kind needs", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              data: {
                repository: { pullRequest: { id: "PR_kwDOA" } },
                node: { id: "IC_1", pullRequest: { id: "PR_kwDOA" } },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;
      const rewrite = (kind: "issue-comment" | "review-comment") =>
        cli.updateComment({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commentId: "IC_1",
          kind,
          body: "Reworded.",
        });

      yield* rewrite("issue-comment");
      yield* rewrite("review-comment");

      const parse = (index: number) =>
        JSON.parse(callAt(index).stdin ?? "") as {
          query: string;
          variables: Record<string, string>;
        };
      expect(callAt(0).args).toContain("subjectId=IC_1");
      expect(parse(1).query).toContain("updateIssueComment(");
      expect(parse(1).variables).toEqual({ commentId: "IC_1", body: "Reworded." });
      expect(parse(3).query).toContain("updatePullRequestReviewComment(");
      expect(parse(3).variables).toEqual({ commentId: "IC_1", body: "Reworded." });
    }),
  );

  it.effect("refuses a comment that belongs to a different pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              data: {
                repository: { pullRequest: { id: "PR_thisOne" } },
                node: { id: "IC_99", pullRequest: { id: "PR_someOtherOne" } },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.updateComment({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commentId: "IC_99",
          kind: "issue-comment",
          body: "Reworded.",
        }),
      );

      assert.strictEqual(error._tag, "GitHubSubjectScopeError");
      expect(error.message).toContain("updateComment");
      // Refused before any mutation was sent.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("fails the read when gh returns something unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"message":"not found"}')));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.getPullRequestDetail({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      assert.strictEqual(error._tag, "GitHubPullRequestReadError");
    }),
  );

  it.effect("keeps the core detail read separate from conversation activity", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 7,
              title: "Progressive detail",
              url: "https://github.com/acme/web/pull/7",
              author: { login: "octocat" },
              headRefName: "feature",
              baseRefName: "main",
              createdAt: "2026-07-01T00:00:00Z",
              updatedAt: "2026-07-02T00:00:00Z",
              body: "Core body",
              changedFiles: 2,
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              author: { login: "octocat" },
              comments: [],
              reviews: [],
              commits: [],
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;
      const input = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      } as const;

      const detail = yield* cli.getPullRequestDetail(input);
      const activity = yield* cli.getPullRequestActivity(input);

      expect(detail.body).toBe("Core body");
      expect(activity.author?.login).toBe("octocat");
      expect(callAt(0).args.at(-1)).toBe(
        "number,title,url,author,headRefName,baseRefName,state,isDraft,mergeable,reviewDecision,additions,deletions,createdAt,updatedAt,mergedAt,reviewRequests,labels,statusCheckRollup,body,changedFiles,closedAt,isCrossRepository,headRepositoryOwner,headRefOid,autoMergeRequest",
      );
      expect(callAt(1).args.at(-1)).toBe("author,comments,reviews,commits");
    }),
  );

  it.effect("fails a files page too large to read rather than calling the diff whole", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(1, 1), true)));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      // What matters is that it fails at all: an empty patch with no cursor would render as a
      // change with no files and report the rest of it as already read. The refusal that sent
      // the read down this road is the one reported, by design.
      assert.strictEqual(error._tag, "GitHubCliCommandError");
    }),
  );

  it.effect("pages an oversized patch by file rather than handing back a severed one", () =>
    Effect.gen(function* () {
      // `gh pr diff` succeeded but its output was cut at a byte, which lands mid-file.
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output("diff --git a/a b/a\n@@ -1 +1 @@", true)),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(1, 1))));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const slice = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      // The severed patch is thrown away; what comes back is assembled from whole files.
      expect(callAt(1).args.join(" ")).toContain("/pulls/7/files");
      expect(slice.patch).toContain("src/file1.ts");
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("follows the cursor to the review threads the first page left behind", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(reviewThreadsPage([thread("PRRT_1", "c1")], "Y3Vyc29yOjE"))),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(reviewThreadsPage([thread("PRRT_2", "c2")], null))),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const conversation = yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      // The first page asks from the beginning, which gh only sends as a typed JSON null.
      expect(callAt(0).args).toContain("cursor=null");
      expect(callAt(1).args).toContain("cursor=Y3Vyc29yOjE");
      expect(conversation.comments.map((comment) => comment.id)).toEqual(["c1", "c2"]);
      assert.isFalse(conversation.truncated);
    }),
  );

  it.effect("stops at the thread bound and says the conversation was cut short", () =>
    Effect.gen(function* () {
      // A host that never runs out of pages: the walk has to end itself.
      mockedExecute.mockReturnValue(
        Effect.succeed(output(reviewThreadsPage([thread("PRRT_1", "c1")], "Y3Vyc29yOjE"))),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const conversation = yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 10);
      assert.isTrue(conversation.truncated);
    }),
  );

  it.effect("leaves a long thread paged until the reader asks for more", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            reviewThreadsPage(
              [{ ...thread("PRRT_1", "c1"), comments: threadComments(["c1"], "Y3Vyc29yOjI", 3) }],
              null,
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const conversation = yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(conversation.comments.map((comment) => comment.id)).toEqual(["c1"]);
      expect(conversation.reviewThreads[0]).toMatchObject({
        commentCount: 3,
        nextCommentsCursor: "Y3Vyc29yOjI",
      });
      assert.isTrue(conversation.truncated);
    }),
  );

  it.effect("reads one requested page from a review thread cursor", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(threadCommentsPage(["c2", "c3"], null, 3))),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const page = yield* cli.getReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        threadId: "PRRT_1",
        cursor: "Y3Vyc29yOjI",
      });

      expect(callAt(0).args).toContain("owner=acme");
      expect(callAt(0).args).toContain("name=web");
      expect(callAt(0).args).toContain("number=7");
      expect(callAt(0).args).toContain("threadId=PRRT_1");
      expect(callAt(0).args).toContain("cursor=Y3Vyc29yOjI");
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(page.comments.map((comment) => comment.id)).toEqual(["c2", "c3"]);
      expect(page.nextCursor).toBeNull();
    }),
  );

  it.effect("refuses a review thread from another pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(threadCommentsPage(["foreign"], null, 1, "PR_8"))),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const error = yield* Effect.flip(
        cli.getReviewThreadComments({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          threadId: "PRRT_FOREIGN",
          cursor: "Y3Vyc29yOjI",
        }),
      );

      assert.strictEqual(error._tag, "GitHubSubjectScopeError");
    }),
  );

  it.effect(
    "asks for the reader's standing on the repository and on the pull request at once",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValue(
          Effect.succeed(
            output(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({
                data: {
                  repository: {
                    viewerPermission: "READ",
                    pullRequest: { viewerCanUpdate: true, viewerDidAuthor: true },
                  },
                },
              }),
            ),
          ),
        );
        const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

        const access = yield* cli.getViewerAccess({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        });

        // One request, because both answers hang off the same repository object.
        assert.strictEqual(mockedExecute.mock.calls.length, 1);
        expect(callAt(0).args).toContain("number=7");
        expect(access).toEqual({
          canWrite: false,
          canTriage: false,
          canUpdate: true,
          didAuthor: true,
        });
      }),
  );

  it.effect("sends the base comparison's variables as gh flags, not as bare words", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    viewerCanUpdateBranch: true,
                    baseRef: { compare: { behindBy: 4 } },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const comparison = yield* cli.getPullRequestBaseComparison({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        headRef: "fork:feat/page",
      });

      // The tuples are flattened straight into argv, so a variable without its flag is a
      // positional argument gh refuses outright.
      const args = callAt(0).args;
      expect(args.slice(0, -2)).toEqual([
        "api",
        "graphql",
        "--hostname",
        "github.com",
        "-f",
        "owner=acme",
        "-f",
        "name=web",
        "-F",
        "number=7",
        "-f",
        "headRef=fork:feat/page",
      ]);
      expect(comparison).toEqual({ behindBy: 4, viewerCanUpdate: true });
      expect(args.at(-2)).toBe("-f");
      expect(args.at(-1)).toContain(`query=${BASE_COMPARISON_GRAPHQL_QUERY.slice(0, -2)}`);
    }),
  );

  it.effect("stops GraphQL reads at the protected reserve until reset", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    viewerCanUpdateBranch: true,
                    baseRef: { compare: { behindBy: 4 } },
                  },
                },
                rateLimit: {
                  cost: 1,
                  limit: 5_000,
                  remaining: 500,
                  resetAt: "2099-08-13T14:00:00Z",
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;
      const input = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        headRef: "fork:feat/page",
      } as const;

      yield* cli.getPullRequestBaseComparison(input);
      expect(callAt(0).args.at(-1)).toContain("rateLimit { cost limit remaining resetAt }");

      const error = yield* Effect.flip(cli.getPullRequestBaseComparison(input));

      assert.strictEqual(error._tag, "SourceControlRateLimitPausedError");
      if (error._tag !== "SourceControlRateLimitPausedError") return;
      assert.strictEqual(error.host, "github.com");
      assert.strictEqual(error.retryAt, Date.parse("2099-08-13T14:00:00Z"));
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      yield* TestClock.setTime(Date.parse("2100-01-01T00:00:00Z"));
    }),
  );

  it.effect("lets an interactive permission read use the protected reserve", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      viewerCanUpdateBranch: true,
                      baseRef: { compare: { behindBy: 4 } },
                    },
                  },
                  rateLimit: {
                    cost: 1,
                    limit: 5_000,
                    remaining: 500,
                    resetAt: "2099-08-13T14:00:00Z",
                  },
                },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({
                data: {
                  repository: {
                    viewerPermission: "READ",
                    pullRequest: { viewerCanUpdate: true, viewerDidAuthor: true },
                  },
                },
              }),
            ),
          ),
        );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.getPullRequestBaseComparison({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        headRef: "fork:feat/page",
      });
      const access = yield* cli.getViewerAccess({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        allowReserve: true,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(access).toEqual({
        canWrite: false,
        canTriage: false,
        canUpdate: true,
        didAuthor: true,
      });
      yield* TestClock.setTime(Date.parse("2100-01-01T00:00:00Z"));
    }),
  );

  it.effect("reads the viewer's role off the same call as the merge settings", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              mergeCommitAllowed: false,
              squashMergeAllowed: true,
              rebaseMergeAllowed: true,
              viewerPermission: "WRITE",
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const access = yield* cli.getRepositoryAccess({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(callAt(0).args).toContain(
        "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerPermission",
      );
      assert.isTrue(access.canWrite);
      expect(access.mergeCapabilities).toEqual({ merge: false, squash: true, rebase: true });
    }),
  );

  it.effect("asks GitHub to review, naming the collection a request is added to", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        reviewers: [
          { id: "octocat", kind: "user" },
          { id: "reviewers", kind: "team" },
        ],
        requested: true,
      });

      const call = callAt(0);
      expect(call.args).toEqual([
        "api",
        "--method",
        "POST",
        "--hostname",
        "github.com",
        "repos/acme/web/pulls/7/requested_reviewers",
        "--input",
        "-",
      ]);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(call.stdin ?? "")).toEqual({
        reviewers: ["octocat"],
        team_reviewers: ["reviewers"],
      });
    }),
  );

  it.effect("takes a request back by deleting from the same collection it was added to", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        reviewers: [{ id: "octocat", kind: "user" }],
        requested: false,
      });

      const call = callAt(0);
      expect(call.args).toContain("DELETE");
      expect(call.args).toContain("repos/acme/web/pulls/7/requested_reviewers");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(call.stdin ?? "")).toEqual({
        reviewers: ["octocat"],
        team_reviewers: [],
      });
    }),
  );

  it.effect("reads who may review and who already has in one request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              data: {
                repository: {
                  assignableUsers: {
                    pageInfo: { hasNextPage: false },
                    nodes: [{ login: "bilal" }, { login: "octocat" }, { login: "hubot" }],
                  },
                  pullRequest: {
                    author: { login: "bilal" },
                    reviewRequests: { nodes: [{ requestedReviewer: { login: "octocat" } }] },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      const list = yield* cli.listReviewerCandidates({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      // The people, who has been asked and who opened the pull request all hang off the same
      // repository object, so the menu costs one request.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(callAt(0).args).toContain("number=7");
      expect(list.candidates.map((candidate) => [candidate.login, candidate.isRequested])).toEqual([
        ["octocat", true],
        ["hubot", false],
      ]);
    }),
  );

  it.effect("puts labels on by posting to the issue's own collection, all at once", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.setLabels({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        labels: ["bug", "size:XL"],
        applied: true,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      const call = callAt(0);
      expect(call.args).toEqual([
        "api",
        "--method",
        "POST",
        "--hostname",
        "github.com",
        "repos/acme/web/issues/7/labels",
        "--input",
        "-",
      ]);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - asserting the raw gh request body.
      expect(JSON.parse(call.stdin ?? "")).toEqual({ labels: ["bug", "size:XL"] });
    }),
  );

  it.effect("takes labels off one at a time, naming each in the path encoded", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

      yield* cli.setLabels({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        labels: ["good first issue", "area/web"],
        applied: false,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(callAt(0).args).toContain("repos/acme/web/issues/7/labels/good%20first%20issue");
      expect(callAt(0).args).toContain("DELETE");
      expect(callAt(1).args).toContain("repos/acme/web/issues/7/labels/area%2Fweb");
    }),
  );
});
