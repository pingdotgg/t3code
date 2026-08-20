import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitHubGraphQlBudget from "../sourceControl/githubGraphQlBudget.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubIssueCli from "./GitHubIssueCli.ts";

const mockedExecute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>();

const layer = it.layer(
  GitHubIssueCli.layer.pipe(
    Layer.provide(
      Layer.mock(GitHubCli.GitHubCli)({
        execute: mockedExecute,
      }),
    ),
    Layer.provide(GitHubGraphQlBudget.layer),
  ),
);

function output(stdout: string) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
  };
}

/**
 * Instants a minute apart, newest first, which is the order every listing here reads in. Rows share
 * one only where a test hands them one, because sharing one is what a continuation has to work
 * around.
 */
function instant(step: number): string {
  return `2026-07-02T00:${String(59 - step).padStart(2, "0")}:00Z`;
}

/** Rows as `gh issue list --json` answers with them. */
function issues(count: number, firstNumber: number, updatedAt?: string): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      number: firstNumber + index,
      title: `Issue ${firstNumber + index}`,
      url: `https://github.com/acme/web/issues/${firstNumber + index}`,
      state: "OPEN",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: updatedAt ?? instant(index),
    })),
  );
}

/** One issue as `gh issue view --json` answers with it. */
function issueJson(entry: Record<string, unknown>): string {
  return JSON.stringify({
    number: 7,
    title: "The page never loads",
    url: "https://github.com/acme/web/issues/7",
    state: "OPEN",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    ...entry,
  });
}

/** One row as the cross-repository search answers it. */
function searchItem(number: number, repository: string, updatedAt?: string) {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${repository}/issues/${number}`,
    author: { login: "bilal", avatarUrl: "https://avatars/bilal" },
    state: "OPEN",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: updatedAt ?? instant(number),
    repository: { nameWithOwner: repository },
    comments: { totalCount: 3 },
  };
}

function searchPage(nodes: ReadonlyArray<unknown>, hasNextPage = false, endCursor?: string) {
  return output(
    JSON.stringify({
      data: {
        search: {
          pageInfo: { hasNextPage, ...(endCursor === undefined ? {} : { endCursor }) },
          nodes,
        },
      },
    }),
  );
}

/** A page of the conversation as the GraphQL reads answer with it, cursor and all. */
function commentPage(ids: ReadonlyArray<string>, startCursor: string | null, totalCount: number) {
  return output(
    JSON.stringify({
      data: {
        repository: {
          issue: {
            author: { login: "bilal", avatarUrl: "https://avatars/bilal" },
            comments: {
              totalCount,
              pageInfo: { hasPreviousPage: startCursor !== null, startCursor },
              nodes: ids.map((id) => ({ id, body: id, createdAt: "2026-07-02T00:00:00Z" })),
            },
            timelineItems: {
              nodes: [
                {
                  __typename: "ClosedEvent",
                  id: "CE_1",
                  createdAt: "2026-07-03T00:00:00Z",
                  actor: { login: "julius" },
                },
                // A kind this page has no words for, dropped rather than guessed at.
                { __typename: "TransferredEvent", id: "TE_1", createdAt: "2026-07-03T00:00:00Z" },
              ],
            },
          },
        },
      },
    }),
  );
}

/** Everything `gh issue view --json` cannot answer about one issue, as GraphQL answers it. */
function supplementPage(issue: Record<string, unknown> | null, viewerPermission: string) {
  return output(JSON.stringify({ data: { repository: { viewerPermission, issue } } }));
}

function assigneeCandidatesPage(input: {
  readonly assignable: ReadonlyArray<unknown>;
  readonly assigned: ReadonlyArray<unknown>;
  readonly hasNextPage: boolean;
}) {
  return output(
    JSON.stringify({
      data: {
        repository: {
          assignableUsers: {
            pageInfo: { hasNextPage: input.hasNextPage },
            nodes: input.assignable,
          },
          issue: { assignees: { nodes: input.assigned } },
        },
      },
    }),
  );
}

/** A full page of a repository's labels, which is what keeps the walk going. */
function labelPage(count: number): string {
  return JSON.stringify(Array.from({ length: count }, (_, index) => ({ name: `label-${index}` })));
}

/** What `gh` answers with when a command it ran was refused. */
const refused = new GitHubCli.GitHubCliCommandError({
  command: "gh",
  cwd: "/w",
  cause: new Error("HTTP 410: Issues are disabled for this repository"),
});

/** The whole invocation the nth call made, so both argv and stdin can be asserted. */
function callAt(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

function argsOfCall(index: number): ReadonlyArray<string> {
  return callAt(index).args;
}

/** The one argument `--search` carries, which is where every listing qualifier ends up. */
function searchOfCall(index: number): string | undefined {
  const args = argsOfCall(index);
  const flag = args.indexOf("--search");
  // Absent is its own answer: a read carrying no `--search` at all is what the fallback is.
  return flag === -1 ? undefined : args[flag + 1];
}

/** The search a batched read sent, which travels in the request body rather than in argv. */
function searchQueryOfCall(index: number): string | undefined {
  const body = JSON.parse(callAt(index).stdin ?? "{}") as { variables?: { q?: string } };
  return body.variables?.q;
}

/** Where a batched read carries on from, which travels beside the search in the request body. */
function searchCursorOfCall(index: number): string | undefined {
  const body = JSON.parse(callAt(index).stdin ?? "{}") as { variables?: { cursor?: string } };
  return body.variables?.cursor;
}

/** The page size a listing asked `gh` for. */
function limitOfCall(index: number): string | undefined {
  const args = argsOfCall(index);
  return args[args.indexOf("--limit") + 1];
}

/** Several fixture arrays as one, which is how a page of rows sharing an instant is written. */
function rowsOf(...parts: ReadonlyArray<string>): string {
  return `[${parts.map((part) => part.slice(1, -1)).join(",")}]`;
}

/** The words a write carried, which every write sends over stdin. */
function stdinOfCall(index: number): unknown {
  return JSON.parse(callAt(index).stdin ?? "null");
}

const repository = { cwd: "/w", repository: "acme/web", host: "github.com" } as const;
const target = { ...repository, number: 7 } as const;

afterEach(() => {
  mockedExecute.mockReset();
});

layer("GitHubIssueCli.layer", (it) => {
  it.effect("asks for one row more than the page, against the repository's own host", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(issues(3, 1))));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const batch = yield* cli.listIssues({
        ...repository,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      expect(batch.items.map((item) => item.number)).toEqual([1, 2, 3]);
      assert.isFalse(batch.truncated);
      assert.isTrue(batch.continues);
      const args = argsOfCall(0);
      expect(args.slice(0, 2)).toEqual(["issue", "list"]);
      // The host is named, so an Enterprise repository resolves to its own install rather than
      // to a same-named one on github.com.
      expect(args).toContain("--repo");
      expect(args).toContain("github.com/acme/web");
      expect(args).toContain("--state");
      expect(args).toContain("open");
      expect(args).toContain("--limit");
      expect(args).toContain("11");
    }),
  );

  it.effect("carries is:issue in the listing search, so a pull request cannot arrive as one", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(issues(1, 1))));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      yield* cli.listIssues({
        ...repository,
        state: "all",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      // GitHub's search index holds pull requests as issues, so the qualifier is what keeps them
      // off the issues page — and it leads every search this module makes.
      assert.strictEqual(searchOfCall(0), "is:issue sort:updated-desc");
    }),
  );

  it.effect("uses GitHub sorting and grows non-recency pages instead of cursoring them", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(issues(1, 1))));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const batch = yield* cli.listIssues({
        ...repository,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        sort: "reactions-thumbs-up",
        order: "desc",
      });

      assert.strictEqual(searchOfCall(0), "is:issue sort:reactions-+1-desc");
      assert.isFalse(batch.continues);
    }),
  );

  it.effect("preserves GitHub best-match ranking without a sort qualifier", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(issues(1, 1))));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      yield* cli.listIssues({
        ...repository,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        sort: "best-match",
        query: "compiler crash",
      });

      assert.strictEqual(searchOfCall(0), `is:issue "compiler crash"`);
    }),
  );

  it.effect("narrows the listing to the viewer's own work with the flags gh has for it", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      const read = (involvement: "assigned" | "authored" | "mentioned") =>
        cli.listIssues({
          ...repository,
          state: "open",
          involvement,
          viewer: "bilal",
          limit: 10,
        });

      yield* read("assigned");
      yield* read("authored");
      yield* read("mentioned");

      // Flags rather than qualifiers, which is what lets the search-free fallback narrow the
      // same way. Each read falls back once, so every second call is the one to look at.
      expect(argsOfCall(0)).toContain("--assignee");
      expect(argsOfCall(2)).toContain("--author");
      expect(argsOfCall(4)).toContain("--mention");
      for (const index of [0, 2, 4]) expect(argsOfCall(index)).toContain("bilal");
    }),
  );

  it.effect("keeps the words a reader typed inside one quoted phrase", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      yield* cli.listIssues({
        ...repository,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: 'x" is:pr label:wontfix',
      });

      // Outside the quotes GitHub would read those as qualifiers of their own, and the words a
      // reader typed to narrow the listing would widen it instead.
      assert.strictEqual(searchOfCall(0), 'is:issue "x\\" is:pr label:wontfix" sort:updated-desc');
    }),
  );

  it.effect("searches for no phrase at all when the reader typed only spaces", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      yield* cli.listIssues({
        ...repository,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "   ",
      });

      // An empty phrase is a phrase GitHub matches nothing against, so there must not be one.
      assert.strictEqual(searchOfCall(0), "is:issue sort:updated-desc");
    }),
  );

  it.effect("carries on from the instant the last slice ended on, inclusively", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(issues(1, 1))));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      yield* cli.listIssues({
        ...repository,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z" },
      });

      // Inclusive, because rows sharing one instant are ordinary: the caller drops the ones it
      // has already sent, where asking for strictly older would lose them.
      assert.strictEqual(
        searchOfCall(0),
        "is:issue updated:<=2026-07-02T00:00:00Z sort:updated-desc",
      );
    }),
  );

  it.effect("reads again without a search when GitHub will not search the repository", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output("[]")))
        .mockReturnValueOnce(Effect.succeed(output(issues(2, 1))));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const batch = yield* cli.listIssues({
        ...repository,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      // A repository GitHub does not index answers a search with no rows rather than with an
      // error, so the rows are asked for again in gh's own order — which no `updated:` qualifier
      // can carry on from, and the batch says so.
      assert.strictEqual(searchOfCall(1), undefined);
      expect(batch.items.map((item) => item.number)).toEqual([1, 2]);
      assert.isFalse(batch.continues);
    }),
  );

  it.effect(
    "never falls back for a slice that carries on, nor for a search that found nothing",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
        const cli = yield* GitHubIssueCli.GitHubIssueCli;

        const continued = yield* cli.listIssues({
          ...repository,
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          cursor: { updatedBefore: "2026-07-02T00:00:00Z" },
        });
        const searched = yield* cli.listIssues({
          ...repository,
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          query: "never loads",
        });

        // A repository that answered the search once answers it again, so an empty slice under a
        // cursor has run out; and falling back on a search would answer it with every issue the
        // reader did not search for.
        assert.strictEqual(mockedExecute.mock.calls.length, 2);
        expect(continued.items).toEqual([]);
        expect(searched.items).toEqual([]);
      }),
  );

  it.effect("reports truncation from the extra row, counted before decoding", () =>
    Effect.gen(function* () {
      const rows = `[{"number":"not a number"},${issues(11, 1).slice(1)}`;
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(rows)));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const batch = yield* cli.listIssues({
        ...repository,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      // Ten rows handed on out of twelve raw ones, and the malformed row still counted: a skipped
      // row must not end paging.
      assert.strictEqual(batch.items.length, 10);
      assert.isTrue(batch.truncated);
    }),
  );

  // Half an instant is a slice nothing can carry on from: the read after it asks the same
  // question, is handed the same rows, and drops every one of them as already sent.
  it.effect("asks for a larger page rather than ending one inside an instant", () =>
    Effect.gen(function* () {
      const tied = "2026-07-02T00:30:00Z";
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(issues(11, 1, tied))))
        .mockReturnValueOnce(Effect.succeed(output(rowsOf(issues(11, 1, tied), issues(1, 12)))));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const batch = yield* cli.listIssues({
        ...repository,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(limitOfCall(0), "11");
      assert.strictEqual(limitOfCall(1), "22");
      // The whole instant travels, page or no page, so the slice after it starts on rows that are
      // strictly older.
      expect(batch.items.map((item) => item.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      assert.isTrue(batch.truncated);
      assert.isTrue(batch.continues);
    }),
  );

  it.effect("says a page cannot be continued once one instant fills GitHub's own ceiling", () =>
    Effect.gen(function* () {
      const tied = "2026-07-02T00:30:00Z";
      mockedExecute.mockReturnValue(Effect.succeed(output(issues(1000, 1, tied))));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const batch = yield* cli.listIssues({
        ...repository,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      // GitHub answers no search past its thousandth result, so there is no larger read left to
      // finish the instant with — and a cursor would only be answered with these same rows.
      assert.strictEqual(limitOfCall(mockedExecute.mock.calls.length - 1), "1000");
      assert.isFalse(batch.continues);
    }),
  );

  it.effect("answers with nothing when gh printed nothing at all", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("   ")));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const batch = yield* cli.listIssues({
        ...repository,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      expect(batch.items).toEqual([]);
      assert.isFalse(batch.truncated);
    }),
  );

  it.effect("says a repository keeps no issues when its tracker is switched off", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.fail(refused))
        .mockReturnValueOnce(Effect.succeed(output("false")));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const error = yield* Effect.flip(
        cli.listIssues({
          ...repository,
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
        }),
      );

      assert.strictEqual(error._tag, "GitHubIssuesDisabledError");
      // Asked only once a listing has already been refused, so a repository that answers costs
      // nothing.
      expect(argsOfCall(1)).toContain("hasIssuesEnabled");
    }),
  );

  it.effect("lets an ordinary refusal stand where the tracker is switched on", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.fail(refused))
        .mockReturnValueOnce(Effect.succeed(output("true")));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const error = yield* Effect.flip(
        cli.listIssues({
          ...repository,
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
        }),
      );

      assert.strictEqual(error._tag, "GitHubCliCommandError");
    }),
  );

  it.effect("carries every repository and every qualifier into one search", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      yield* cli.searchIssues({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web", "pingdotgg/t3code"],
        state: "closed",
        involvement: "assigned",
        viewer: "bilal",
        limit: 10,
        query: "never loads",
        cursor: { updatedBefore: "2026-07-02T00:00:00Z" },
      });

      // One request for both repositories, carrying everything the per-repository read expresses
      // as a flag — and `is:issue` first, because the index it searches holds pull requests too.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      assert.strictEqual(
        searchQueryOfCall(0),
        'is:issue "never loads" updated:<=2026-07-02T00:00:00Z sort:updated-desc is:closed ' +
          "assignee:bilal repo:acme/web repo:pingdotgg/t3code",
      );
      expect(argsOfCall(0)).toEqual(["api", "graphql", "--hostname", "github.com", "--input", "-"]);
    }),
  );

  it.effect("spells each involvement as the qualifier a search has instead of a flag", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      const search = (involvement: "all" | "authored" | "mentioned") =>
        cli.searchIssues({
          cwd: "/w",
          host: "github.com",
          repositories: ["acme/web"],
          state: "open",
          involvement,
          viewer: "bilal",
          limit: 10,
        });

      yield* search("authored");
      yield* search("mentioned");
      yield* search("all");

      assert.strictEqual(
        searchQueryOfCall(0),
        "is:issue sort:updated-desc is:open author:bilal repo:acme/web",
      );
      assert.strictEqual(
        searchQueryOfCall(1),
        "is:issue sort:updated-desc is:open mentions:bilal repo:acme/web",
      );
      // Every issue of the repository, which is what the All tab asks for.
      assert.strictEqual(searchQueryOfCall(2), "is:issue sort:updated-desc is:open repo:acme/web");
    }),
  );

  it.effect("keeps a searched-for qualifier inside the phrase, and out of argv", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      yield* cli.searchIssues({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web"],
        state: "all",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: 'x" is:pr repo:evil/repo',
      });

      // Quoted and escaped, so the words narrow the listing rather than widening it — and the
      // whole document travels over stdin rather than in a visible argv.
      assert.strictEqual(
        searchQueryOfCall(0),
        'is:issue "x\\" is:pr repo:evil/repo" sort:updated-desc repo:acme/web',
      );
      expect(argsOfCall(0)).not.toContain("-f");
    }),
  );

  it.effect("refuses to search for a repository GitHub cannot address", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const error = yield* Effect.flip(
        cli.searchIssues({
          cwd: "/w",
          host: "github.com",
          repositories: ["acme/web", "acme/web is:pr"],
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
        }),
      );

      // Nothing is sent: a name that could end its own qualifier is refused rather than escaped.
      assert.strictEqual(error._tag, "GitHubIssueRepositorySelectorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("files each searched row under the repository it came from", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          searchPage([
            searchItem(7, "acme/web"),
            searchItem(9, "pingdotgg/t3code"),
            // Not an issue, which the decode skips rather than fails on.
            {},
          ]),
        ),
      );
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const batch = yield* cli.searchIssues({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web", "pingdotgg/t3code"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      expect(batch.items.map((item) => [item.repository, item.number, item.commentCount])).toEqual([
        ["acme/web", 7, 3],
        ["pingdotgg/t3code", 9, 3],
      ]);
      assert.isFalse(batch.truncated);
    }),
  );

  it.effect("reports truncation from the extra row, and from a page GitHub says has more", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            searchPage([
              searchItem(1, "acme/web"),
              searchItem(2, "acme/web"),
              searchItem(3, "acme/web"),
            ]),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(searchPage([searchItem(1, "acme/web")], true)));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      const search = () =>
        cli.searchIssues({
          cwd: "/w",
          host: "github.com",
          repositories: ["acme/web"],
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 2,
        });

      const overflowing = yield* search();
      const capped = yield* search();

      // The extra row is the probe, and it is not handed on.
      assert.strictEqual(overflowing.items.length, 2);
      assert.isTrue(overflowing.truncated);
      // A slice at GitHub's own ceiling has no extra row to probe with, so `hasNextPage` answers.
      assert.isTrue(capped.truncated);
    }),
  );

  // GitHub's ceiling on a search page is a hundred rows, so an instant holding more than the page
  // is read on past it: a slice ending inside one instant is one the read after it drops whole.
  it.effect("reads on past the page GitHub cuts a search at to finish an instant", () =>
    Effect.gen(function* () {
      const tied = "2026-07-02T00:30:00Z";
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            searchPage(
              [1, 2, 3].map((number) => searchItem(number, "acme/web", tied)),
              true,
              "PAGE_2",
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            searchPage(
              [searchItem(4, "acme/web", tied), searchItem(5, "acme/web")],
              true,
              "PAGE_3",
            ),
          ),
        );
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const batch = yield* cli.searchIssues({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 2,
      });

      // The second read carries GitHub's own cursor: asking the same question again would answer
      // with the same first rows for ever.
      assert.isUndefined(searchCursorOfCall(0));
      assert.strictEqual(searchCursorOfCall(1), "PAGE_2");
      expect(batch.items.map((item) => item.number)).toEqual([1, 2, 3, 4]);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("stops at GitHub's ceiling rather than offering a slice it cannot answer", () =>
    Effect.gen(function* () {
      const tied = "2026-07-02T00:30:00Z";
      mockedExecute.mockImplementation((input) => {
        const first = Number(/type: ISSUE, first: (\d+)/.exec(input.stdin ?? "")?.[1]);
        return Effect.succeed(
          searchPage(
            Array.from({ length: first }, (_, index) => searchItem(index + 1, "acme/web", tied)),
            true,
            "MORE",
          ),
        ) as ReturnType<GitHubCli.GitHubCli["Service"]["execute"]>;
      });
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const batch = yield* cli.searchIssues({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 2,
      });

      // GitHub answers no search past its thousandth result, so those rows are everything this
      // query has: a continuation could only be answered with them again.
      assert.strictEqual(mockedExecute.mock.calls.length, 11);
      expect(callAt(10).stdin).toContain("first: 97");
      assert.isFalse(batch.truncated);
    }),
  );

  it.effect("reads one issue with its body from gh's own JSON", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(issueJson({ body: "It 500s.", labels: [{ name: "bug" }] }))),
      );
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const issue = yield* cli.getIssueDetail(target);

      expect(argsOfCall(0).slice(0, 5)).toEqual([
        "issue",
        "view",
        "7",
        "--repo",
        "github.com/acme/web",
      ]);
      expect(issue).toMatchObject({ number: 7, body: "It 500s.", state: "open" });
    }),
  );

  it.effect("fails the read when gh answered something unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"message":"Not Found"}')));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const error = yield* Effect.flip(cli.getIssueDetail(target));

      assert.strictEqual(error._tag, "GitHubIssueReadError");
      // The failure names the read it came from rather than borrowing another one's words.
      expect(error.message).toContain("getIssueDetail");
    }),
  );

  it.effect("asks GitHub for everything gh cannot answer about one issue", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          supplementPage(
            {
              viewerCanUpdate: true,
              viewerDidAuthor: false,
              author: { login: "bilal", avatarUrl: "https://avatars/bilal" },
              comments: { totalCount: 4 },
              closedByPullRequestsReferences: {
                nodes: [
                  {
                    number: 12,
                    title: "Fix the page",
                    url: "https://github.com/acme/web/pull/12",
                    state: "MERGED",
                    repository: { nameWithOwner: "acme/web" },
                  },
                ],
              },
            },
            "TRIAGE",
          ),
        ),
      );
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const supplement = yield* cli.getIssueSupplement(target);

      // Owner and name travel as typed variables, and the number as a number.
      expect(argsOfCall(0).slice(0, 10)).toEqual([
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
      ]);
      assert.isTrue(supplement.viewer.canTriage);
      assert.strictEqual(supplement.commentCount, 4);
      expect(supplement.linkedPullRequests.map((link) => [link.number, link.closesIssue])).toEqual([
        [12, true],
      ]);
      expect([...supplement.avatarsByLogin]).toEqual([["bilal", "https://avatars/bilal"]]);
    }),
  );

  it.effect("asks what the viewer may do here on its own, before a write", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(supplementPage({ viewerCanUpdate: true, viewerDidAuthor: true }, "READ")),
      );
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const access = yield* cli.getViewerAccess(target);

      // The author of an issue may still retitle and close it without any access to the code.
      expect(access).toEqual({ canTriage: false, canUpdate: true, didAuthor: true });
      expect(argsOfCall(0)).toContain("--hostname");
    }),
  );

  it.effect("stops issue GraphQL reads at the protected reserve until reset", () =>
    Effect.gen(function* () {
      const page = commentPage(["IC_1"], null, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const limited = JSON.parse(page.stdout) as { data: Record<string, unknown> };
      limited.data.rateLimit = {
        cost: 1,
        limit: 5_000,
        remaining: 500,
        resetAt: "2099-08-13T14:00:00Z",
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      mockedExecute.mockReturnValue(Effect.succeed(output(JSON.stringify(limited))));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      yield* cli.getIssueActivity(target);
      expect(argsOfCall(0).at(-1)).toContain("rateLimit { cost limit remaining resetAt }");

      const error = yield* Effect.flip(cli.getIssueActivity(target));

      assert.strictEqual(error._tag, "SourceControlRateLimitPausedError");
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      yield* TestClock.setTime(Date.parse("2100-01-01T00:00:00Z"));
    }),
  );
  it.effect("reads the conversation and the history in one request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(commentPage(["IC_1", "IC_2"], null, 2)));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const activity = yield* cli.getIssueActivity(target);

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      // The first page starts at the beginning, which gh can only send as a typed null.
      expect(argsOfCall(0)).toContain("cursor=null");
      expect(argsOfCall(0)).toContain("-F");
      expect(activity.comments.map((comment) => comment.id)).toEqual(["IC_1", "IC_2"]);
      expect(activity.events.map((event) => [event.id, event.kind])).toEqual([["CE_1", "closed"]]);
      assert.strictEqual(activity.commentCount, 2);
      assert.isFalse(activity.commentsTruncated);
      expect(activity.author).toEqual({
        login: "bilal",
        name: null,
        avatarUrl: "https://avatars/bilal",
      });
    }),
  );

  it.effect("leaves the rest of a long conversation for an explicit page read", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(commentPage(["IC_1"], "Y3Vyc29y", 250)))
        .mockReturnValueOnce(Effect.succeed(commentPage(["IC_2"], null, 250)));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const activity = yield* cli.getIssueActivity(target);

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(activity.comments.map((comment) => comment.id)).toEqual(["IC_1"]);
      assert.strictEqual(activity.nextCommentsCursor, "Y3Vyc29y");
      assert.isTrue(activity.commentsTruncated);

      const page = yield* cli.getIssueComments({ ...target, cursor: "Y3Vyc29y" });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(argsOfCall(1)).toContain("cursor=Y3Vyc29y");
      expect(page.comments.map((comment) => comment.id)).toEqual(["IC_2"]);
      assert.isNull(page.nextCursor);
      assert.strictEqual(activity.commentCount, 250);
      expect(activity.events.map((event) => event.id)).toEqual(["CE_1"]);
    }),
  );

  it.effect("closes with each reason GitHub knows, and reopens without one", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("")));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      yield* cli.runIssueAction({ ...target, action: "close", reason: "completed" });
      yield* cli.runIssueAction({ ...target, action: "close", reason: "not-planned" });
      yield* cli.runIssueAction({ ...target, action: "close" });
      yield* cli.runIssueAction({ ...target, action: "reopen" });

      expect(argsOfCall(0)).toEqual([
        "issue",
        "close",
        "7",
        "--repo",
        "github.com/acme/web",
        "--reason",
        "completed",
      ]);
      // GitHub spells this one with a space in it, and takes no other words.
      expect(argsOfCall(1).slice(5)).toEqual(["--reason", "not planned"]);
      expect(argsOfCall(2)).not.toContain("--reason");
      expect(argsOfCall(3).slice(0, 3)).toEqual(["issue", "reopen", "7"]);
      expect(argsOfCall(3)).not.toContain("--reason");
    }),
  );

  it.effect("sends a comment body over stdin, never in argv", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      yield* cli.commentOnIssue({ ...target, body: "--body=nice try" });

      expect(argsOfCall(0)).toEqual([
        "issue",
        "comment",
        "7",
        "--repo",
        "github.com/acme/web",
        "--body-file",
        "-",
      ]);
      // argv is visible in process listings and echoed back inside a runner's failure message.
      assert.strictEqual(callAt(0).stdin, "--body=nice try");
    }),
  );

  it.effect("files a new issue with its title and body over stdin, never in argv", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output('{"number":9,"html_url":"https://github.com/acme/web/issues/9"}')),
      );
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const created = yield* cli.createIssue({
        ...repository,
        title: "The page never loads",
        body: "Steps to reproduce.",
        labels: ["bug"],
        assignees: ["julius"],
      });

      expect(argsOfCall(0)).toEqual([
        "api",
        "--method",
        "POST",
        "--hostname",
        "github.com",
        "repos/acme/web/issues",
        "--input",
        "-",
      ]);
      expect(stdinOfCall(0)).toEqual({
        title: "The page never loads",
        body: "Steps to reproduce.",
        labels: ["bug"],
        assignees: ["julius"],
      });
      expect(created).toEqual({ number: 9, url: "https://github.com/acme/web/issues/9" });
    }),
  );

  it.effect("rewrites only the fields the edit carried, over stdin", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      yield* cli.updateIssue({ ...target, title: "A better title" });
      yield* cli.updateIssue({ ...target, body: "It 500s." });

      expect(argsOfCall(0)).toEqual([
        "api",
        "--method",
        "PATCH",
        "--hostname",
        "github.com",
        "repos/acme/web/issues/7",
        "--input",
        "-",
      ]);
      // The body is absent rather than empty, so a rename cannot blank what somebody wrote.
      expect(stdinOfCall(0)).toEqual({ title: "A better title" });
      expect(stdinOfCall(1)).toEqual({ body: "It 500s." });
    }),
  );

  it.effect("rewrites a comment only after GitHub confirms it belongs to the issue", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({
                data: {
                  repository: { issue: { id: "I_7" } },
                  node: { issue: { id: "I_7" } },
                },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      yield* cli.updateComment({ ...target, commentId: "IC_1", body: "Second thoughts" });

      expect(argsOfCall(0)).toContain("graphql");
      expect(argsOfCall(1)).toContain("graphql");
      expect(stdinOfCall(1)).toMatchObject({
        variables: { commentId: "IC_1", body: "Second thoughts" },
      });
    }),
  );

  it.effect("reacts to the issue body through its node id", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({ data: { repository: { issue: { id: "I_7" } } } }),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      yield* cli.setReaction({ ...target, content: "heart", reacted: true });

      expect(stdinOfCall(1)).toMatchObject({
        variables: { subjectId: "I_7", content: "HEART" },
      });
    }),
  );

  it.effect("writes the whole label and assignee set, and the empty set to clear it", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      yield* cli.setLabels({ ...target, labels: ["bug", "needs, care"] });
      yield* cli.setAssignees({ ...target, assignees: [] });

      // The whole set rather than a change to it, which is what this endpoint writes.
      expect(stdinOfCall(0)).toEqual({ labels: ["bug", "needs, care"] });
      expect(stdinOfCall(1)).toEqual({ assignees: [] });
      expect(argsOfCall(1)).toContain("PATCH");
    }),
  );

  it.effect("offers the repository's labels and marks the ones the issue has", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) =>
        Effect.succeed(
          output(
            input.args[0] === "issue"
              ? issueJson({ labels: [{ name: "bug" }] })
              : JSON.stringify([
                  { name: "bug", color: "d73a4a", description: "Something is broken" },
                  { name: "wontfix" },
                ]),
          ),
        ),
      );
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const list = yield* cli.listLabelCandidates(target);

      expect(list.candidates.map((candidate) => [candidate.name, candidate.isApplied])).toEqual([
        ["bug", true],
        ["wontfix", false],
      ]);
      assert.isFalse(list.truncated);
      const labelCall = mockedExecute.mock.calls.find((call) => call[0].args[0] === "api");
      assert.isDefined(labelCall);
      expect(labelCall[0].args).toEqual([
        "api",
        "--hostname",
        "github.com",
        "repos/acme/web/labels?per_page=100&page=1",
      ]);
    }),
  );

  it.effect("stops the label walk at its bound and says the list is not all of them", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) =>
        Effect.succeed(output(input.args[0] === "issue" ? issueJson({}) : labelPage(100))),
      );
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const list = yield* cli.listLabelCandidates(target);

      // Five pages of a hundred, which is more labels than any repository offers a picker for.
      assert.strictEqual(list.candidates.length, 500);
      assert.isTrue(list.truncated);
      const pages = mockedExecute.mock.calls.filter((call) => call[0].args[0] === "api");
      assert.strictEqual(pages.length, 5);
      expect(pages.at(-1)?.[0].args.at(-1)).toContain("page=5");
    }),
  );

  it.effect("offers the people GitHub says may be assigned, and marks who already is", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          assigneeCandidatesPage({
            assignable: [{ login: "hubot" }, { login: "julius" }],
            assigned: [{ login: "julius", name: "Julius" }],
            hasNextPage: true,
          }),
        ),
      );
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const list = yield* cli.listAssigneeCandidates(target);

      expect(list.candidates.map((candidate) => [candidate.id, candidate.isAssigned])).toEqual([
        ["julius", true],
        ["hubot", false],
      ]);
      // Bounded: GitHub has more people with access than one page holds.
      assert.isTrue(list.truncated);
      expect(argsOfCall(0)).toContain("owner=acme");
    }),
  );

  it.effect("reads the login of the signed-in account, and fails where there is none", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output("bilal\n")))
        .mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const viewer = yield* cli.getViewerLogin({
        cwd: "/w",
        host: "github.example.com",
      });
      const error = yield* Effect.flip(
        cli.getViewerLogin({ cwd: "/w", host: "github.example.com" }),
      );

      assert.strictEqual(viewer, "bilal");
      expect(argsOfCall(0)).toEqual([
        "api",
        "user",
        "--hostname",
        "github.example.com",
        "--jq",
        ".login",
      ]);
      assert.strictEqual(error._tag, "GitHubIssueViewerLoginUnavailableError");
    }),
  );

  it.effect("combines a repository's templates with its config file into one offering", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) =>
        Effect.succeed(
          output(
            input.args[1] === "graphql"
              ? JSON.stringify({
                  data: {
                    repository: {
                      issueTemplates: [
                        {
                          filename: "bug_report.md",
                          name: "Bug report",
                          about: "File a bug",
                          title: "Bug: ",
                          body: "### Steps",
                          assignees: { nodes: [{ login: "julius" }] },
                          labels: { nodes: [{ name: "bug" }] },
                        },
                      ],
                    },
                  },
                })
              : "blank_issues_enabled: false\ncontact_links:\n  - name: Chat\n    url: https://example.com/chat\n",
          ),
        ),
      );
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const list = yield* cli.listIssueTemplates(repository);

      expect(list.templates).toEqual([
        {
          key: "bug_report.md",
          name: "Bug report",
          about: "File a bug",
          title: "Bug: ",
          body: "### Steps",
          labels: ["bug"],
          assignees: ["julius"],
        },
      ]);
      expect(list.blankIssuesEnabled).toBe(false);
      expect(list.contactLinks).toEqual([
        { name: "Chat", url: "https://example.com/chat", about: "" },
      ]);
      const graphqlCall = mockedExecute.mock.calls.find((call) => call[0].args[1] === "graphql");
      assert.isDefined(graphqlCall);
      expect(graphqlCall[0].args).toContain("owner=acme");
      const configCall = mockedExecute.mock.calls.find((call) => call[0].args[1] === "--hostname");
      assert.isDefined(configCall);
      expect(configCall[0].args).toContain(
        "repos/acme/web/contents/.github/ISSUE_TEMPLATE/config.yml",
      );
    }),
  );

  it.effect("offers GitHub's own defaults when the config file cannot be read", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) =>
        input.args[1] === "graphql"
          ? Effect.succeed(
              output(
                JSON.stringify({
                  data: {
                    repository: {
                      issueTemplates: [{ filename: "bug_report.md" }],
                    },
                  },
                }),
              ),
            )
          : // Most repositories keep no config file, which GitHub answers with a refusal — not a
            // reason to fail a read whose templates arrived.
            Effect.fail(refused),
      );
      const cli = yield* GitHubIssueCli.GitHubIssueCli;

      const list = yield* cli.listIssueTemplates(repository);

      expect(list.templates.map((template) => template.key)).toEqual(["bug_report.md"]);
      expect(list.blankIssuesEnabled).toBe(true);
      expect(list.contactLinks).toEqual([]);
    }),
  );
});
