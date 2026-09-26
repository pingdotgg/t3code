import { assert, it } from "@effect/vitest";
import { GitHubCliError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitHubCli } from "../git/Services/GitHubCli.ts";
import { fetchGitHubPullRequestMonitorSnapshot } from "./GitHubPullRequestMonitorSnapshot.ts";

const graphqlResponse = JSON.stringify({
  data: {
    viewer: { login: "me" },
    repository: {
      pullRequest: {
        state: "OPEN",
        isDraft: false,
        merged: false,
        mergeable: "MERGEABLE",
        headRefOid: "head-sha",
        baseRefName: "main",
        headRefName: "feat/x",
        title: "Add monitor",
        url: "https://github.com/acme/app/pull/12",
        reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  },
});

const processResult = (stdout: string) => ({
  stdout,
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
  stdoutTruncated: false,
});

const review = (id: string) => ({
  id,
  author: { login: "reviewer", __typename: "User" },
  state: "CHANGES_REQUESTED",
  submittedAt: "2026-08-16T00:00:00.000Z",
  commit: { oid: "head" },
  body: id,
});

const thread = (id: string) => ({
  id,
  isResolved: false,
  comments: {
    nodes: [
      {
        author: { login: "reviewer", __typename: "User" },
        body: id,
        path: "src/index.ts",
        line: 1,
        createdAt: "2026-08-16T00:00:00.000Z",
        updatedAt: "2026-08-16T00:00:00.000Z",
        viewerDidAuthor: false,
      },
    ],
  },
});

const initialGraphql = JSON.stringify({
  data: {
    viewer: { login: "viewer" },
    repository: {
      pullRequest: {
        state: "OPEN",
        isDraft: false,
        merged: false,
        mergeable: "MERGEABLE",
        headRefOid: "head",
        baseRefName: "main",
        headRefName: "feature",
        title: "PR",
        url: "https://github.com/acme/app/pull/1",
        reviews: {
          nodes: [review("review-1")],
          pageInfo: { hasNextPage: true, endCursor: "review-cursor" },
        },
        reviewThreads: {
          nodes: [thread("thread-1")],
          pageInfo: { hasNextPage: true, endCursor: "thread-cursor" },
        },
      },
    },
  },
});

/** Ids increase with creation time, so the newest comment is always the highest id. */
const issueComment = (id: number, login: string, overrides: Record<string, unknown> = {}) => ({
  id,
  user: { login },
  body: `comment ${id}`,
  created_at: new Date(Date.UTC(2026, 0, 1) + id * 60_000).toISOString(),
  updated_at: new Date(Date.UTC(2026, 0, 1) + id * 60_000).toISOString(),
  ...overrides,
});

const fullPage = (page: number, login = "reviewer") =>
  Array.from({ length: 100 }, (_, index) => issueComment((page - 1) * 100 + index, login));

interface CommentPage {
  readonly comments: ReadonlyArray<unknown>;
  readonly next?: number;
  readonly last?: number;
}

const commentUrl = (page: number) =>
  `https://api.github.com/repos/acme/app/issues/12/comments?per_page=100&page=${page}`;

/** Mirrors `gh api --include`: status line, headers, blank line, then the JSON body. */
const includedResponse = (page: CommentPage) => {
  const links = [
    page.next === undefined ? null : `<${commentUrl(page.next)}>; rel="next"`,
    page.last === undefined ? null : `<${commentUrl(page.last)}>; rel="last"`,
  ].filter((entry): entry is string => entry !== null);
  const headers = ["HTTP/2.0 200 OK", "content-type: application/json"];
  if (links.length > 0) headers.push(`Link: ${links.join(", ")}`);
  return `${headers.join("\r\n")}\r\n\r\n${JSON.stringify(page.comments)}`;
};

const makeGitHubCli = (input: {
  readonly pages: ReadonlyMap<number, CommentPage>;
  readonly requested: Array<string>;
  readonly compare?: () => Effect.Effect<{ readonly stdout: string }, never>;
}) =>
  Layer.succeed(GitHubCli, {
    execute: (call: { readonly args: ReadonlyArray<string> }) => {
      const target = call.args.at(-1) ?? "";
      input.requested.push(target);
      if (call.args.includes("graphql")) return Effect.succeed({ stdout: graphqlResponse });
      if (target.includes("/comments?")) {
        const page = Number(new URL(`https://x/${target}`).searchParams.get("page") ?? "1");
        const body = input.pages.get(page) ?? { comments: [] };
        return Effect.succeed({ stdout: includedResponse(body) });
      }
      if (target.includes("check-runs")) {
        return Effect.succeed({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) });
      }
      if (target.includes("/status?")) {
        return Effect.succeed({ stdout: JSON.stringify({ statuses: [], sha: "head-sha" }) });
      }
      return input.compare?.() ?? Effect.succeed({ stdout: JSON.stringify({ behind_by: 0 }) });
    },
  } as unknown as GitHubCli["Service"]);

const snapshotWith = (input: {
  readonly pages: ReadonlyMap<number, CommentPage>;
  readonly requested: Array<string>;
  readonly compare?: () => Effect.Effect<{ readonly stdout: string }, never>;
}) =>
  fetchGitHubPullRequestMonitorSnapshot({
    cwd: "/workspace/app",
    host: "github.com",
    repository: "acme/app",
    number: 12,
  }).pipe(Effect.provide(makeGitHubCli(input)));

const requestedCommentPages = (requested: ReadonlyArray<string>) =>
  requested
    .filter((target) => target.includes("/comments?"))
    .map((target) => new URL(`https://x/${target}`).searchParams.get("page"));

it.effect("pages issue comments and marks our own comments as viewer-authored", () =>
  Effect.gen(function* () {
    const requested: Array<string> = [];
    // A host without Link metadata still pages by full-page length.
    const snapshot = yield* snapshotWith({
      requested,
      pages: new Map<number, CommentPage>([
        [1, { comments: fullPage(1) }],
        [2, { comments: [issueComment(200, "me"), issueComment(201, "reviewer")] }],
      ]),
    });

    assert.deepStrictEqual(requestedCommentPages(requested), ["1", "2"]);
    assert.strictEqual(snapshot.issueComments.length, 102);
    assert.isTrue(snapshot.completeness.issueCommentsComplete);

    const own = snapshot.issueComments.find((comment) => comment.id === "200");
    assert.isDefined(own);
    assert.isTrue(own?.authoredByViewer);
    const other = snapshot.issueComments.find((comment) => comment.id === "201");
    assert.isFalse(other?.authoredByViewer);
  }),
);

it.effect("serializes snapshot reads to avoid secondary-limit bursts", () =>
  Effect.gen(function* () {
    let active = 0;
    let maxActive = 0;

    const responseFor = (args: ReadonlyArray<string>) => {
      const target = args.at(-1) ?? "";
      if (args.includes("graphql")) return processResult(graphqlResponse);
      if (target.includes("/comments?")) {
        return processResult(includedResponse({ comments: [] }));
      }
      if (target.includes("check-runs")) {
        return processResult(JSON.stringify({ total_count: 0, check_runs: [] }));
      }
      if (target.includes("/status?")) {
        return processResult(JSON.stringify({ statuses: [], sha: "head-sha" }));
      }
      return processResult(JSON.stringify({ behind_by: 0 }));
    };

    yield* fetchGitHubPullRequestMonitorSnapshot({
      cwd: "/workspace/app",
      host: "github.com",
      repository: "acme/app",
      number: 12,
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubCli)({
          execute: ({ args }) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                active += 1;
                maxActive = Math.max(maxActive, active);
              }),
              () => Effect.yieldNow.pipe(Effect.as(responseFor(args))),
              () =>
                Effect.sync(() => {
                  active -= 1;
                }),
            ),
        }),
      ),
    );

    assert.strictEqual(maxActive, 1);
  }),
);

it.effect("reports incomplete issue comments when the page budget is exhausted", () =>
  Effect.gen(function* () {
    const requested: Array<string> = [];
    const pages = new Map<number, CommentPage>();
    for (let page = 1; page <= 20; page++) pages.set(page, { comments: fullPage(page) });

    const snapshot = yield* snapshotWith({ requested, pages });

    assert.strictEqual(requestedCommentPages(requested).length, 10);
    assert.isFalse(snapshot.completeness.issueCommentsComplete);
  }),
);

it.effect("reads the newest comments of a pull request with more than 1000 of them", () =>
  Effect.gen(function* () {
    const requested: Array<string> = [];
    const pages = new Map<number, CommentPage>();
    for (let page = 1; page <= 11; page++) {
      pages.set(page, { comments: fullPage(page), next: page + 1, last: 12 });
    }
    // The newest comment lives on page 12, far past a forward walk's budget.
    pages.set(12, { comments: [issueComment(9_999, "reviewer")], last: 12 });

    const snapshot = yield* snapshotWith({ requested, pages });

    const walked = requestedCommentPages(requested);
    assert.strictEqual(walked.length, 10);
    assert.deepStrictEqual(walked.slice(0, 2), ["1", "12"]);
    assert.isTrue(
      snapshot.issueComments.some((comment) => comment.id === "9999"),
      "the newest comment must be observed",
    );
    // Old history the walk could not reach stays unknown, never silently resolved.
    assert.isFalse(snapshot.completeness.issueCommentsComplete);
  }),
);

it.effect("follows comments appended after the last page was discovered", () =>
  Effect.gen(function* () {
    const requested: Array<string> = [];
    const pages = new Map<number, CommentPage>([
      [1, { comments: fullPage(1), next: 2, last: 10 }],
      ...Array.from({ length: 8 }, (_, index) => {
        const page = index + 2;
        return [page, { comments: fullPage(page), next: page + 1, last: 10 }] as const;
      }),
      // Page 10 filled up and a new comment landed on page 11 after discovery.
      [10, { comments: fullPage(10), next: 11, last: 10 }],
      [11, { comments: [issueComment(5_000, "reviewer")], last: 11 }],
    ]);

    const snapshot = yield* snapshotWith({ requested, pages });

    const walked = requestedCommentPages(requested);
    assert.deepStrictEqual(walked.slice(0, 3), ["1", "10", "11"]);
    assert.isTrue(snapshot.issueComments.some((comment) => comment.id === "5000"));
  }),
);

it.effect("keeps the edited version of a comment seen on overlapping pages", () =>
  Effect.gen(function* () {
    const requested: Array<string> = [];
    const edited = issueComment(150, "reviewer", {
      body: "edited body",
      updated_at: "2026-02-01T00:00:00.000Z",
    });
    const stale = issueComment(150, "reviewer", { body: "stale body" });
    const pages = new Map<number, CommentPage>([
      [1, { comments: [issueComment(1, "reviewer"), issueComment(2, "reviewer")], last: 3 }],
      // Read last during backfill, so the newer edit must survive the overlap.
      [2, { comments: [stale, issueComment(151, "reviewer")] }],
      [3, { comments: [edited, issueComment(152, "reviewer")], last: 3 }],
    ]);

    const snapshot = yield* snapshotWith({ requested, pages });

    assert.deepStrictEqual(requestedCommentPages(requested), ["1", "3", "2"]);
    const overlapped = snapshot.issueComments.filter((comment) => comment.id === "150");
    assert.strictEqual(overlapped.length, 1);
    assert.strictEqual(overlapped[0]?.bodyExcerpt, "edited body");
    assert.strictEqual(overlapped[0]?.updatedAt, "2026-02-01T00:00:00.000Z");
    assert.isTrue(snapshot.completeness.issueCommentsComplete);
  }),
);

it.effect("does not spend a REST request on informational base distance", () =>
  Effect.gen(function* () {
    const requested: Array<string> = [];
    const snapshot = yield* snapshotWith({
      requested,
      pages: new Map<number, CommentPage>([[1, { comments: [], last: 1 }]]),
    });

    assert.isNull(snapshot.behindBaseBy);
    assert.isFalse(snapshot.completeness.baseComparisonKnown);
    assert.isFalse(requested.some((target) => target.includes("/compare/")));
  }),
);

it.effect("paginates reviews, threads, check runs, and legacy statuses", () => {
  const commands: string[] = [];
  return Effect.gen(function* () {
    const snapshot = yield* fetchGitHubPullRequestMonitorSnapshot({
      cwd: "/workspace",
      host: "github.com",
      repository: "acme/app",
      number: 1,
    });

    assert.deepStrictEqual(
      snapshot.reviews.map(({ id }) => id),
      ["review-1", "review-2"],
    );
    assert.deepStrictEqual(
      snapshot.reviewThreads.map(({ id }) => id),
      ["thread-1", "thread-2"],
    );
    assert.strictEqual(snapshot.checkRuns.length, 202);
    assert.isTrue(snapshot.completeness.reviewsComplete);
    assert.isTrue(snapshot.completeness.reviewThreadsComplete);
    assert.isTrue(snapshot.completeness.checksComplete);
    assert.isTrue(commands.some((command) => command.includes("check-runs?per_page=100&page=2")));
    assert.isTrue(commands.some((command) => command.includes("/status?per_page=100&page=2")));
  }).pipe(
    Effect.provide(
      Layer.mock(GitHubCli)({
        execute: ({ args }) =>
          Effect.sync(() => {
            const command = args.join(" ");
            commands.push(command);
            if (command.includes("graphql") && command.includes("MONITOR_CONNECTIONS") === false) {
              const query = args.find((arg) => arg.startsWith("query=")) ?? "";
              if (query.includes("viewer { login }")) return processResult(initialGraphql);
              return processResult(
                JSON.stringify({
                  data: {
                    repository: {
                      pullRequest: {
                        reviews: {
                          nodes: [review("review-2")],
                          pageInfo: { hasNextPage: false, endCursor: "review-end" },
                        },
                        reviewThreads: {
                          nodes: [thread("thread-2")],
                          pageInfo: { hasNextPage: false, endCursor: "thread-end" },
                        },
                      },
                    },
                  },
                }),
              );
            }
            if (command.includes("/issues/1/comments")) return processResult("[]");
            if (command.includes("/compare/")) return processResult('{"behind_by":0}');
            if (command.includes("check-runs")) {
              const page = command.includes("page=2") ? 2 : 1;
              const count = page === 1 ? 100 : 1;
              return processResult(
                JSON.stringify({
                  total_count: 101,
                  check_runs: Array.from({ length: count }, (_, index) => ({
                    id: (page - 1) * 100 + index,
                    name: `check-${page}-${index}`,
                    status: "completed",
                    conclusion: "success",
                    head_sha: "head",
                  })),
                }),
              );
            }
            const page = command.includes("page=2") ? 2 : 1;
            const count = page === 1 ? 100 : 1;
            return processResult(
              JSON.stringify({
                sha: "head",
                statuses: Array.from({ length: count }, (_, index) => ({
                  id: (page - 1) * 100 + index,
                  context: `status-${page}-${index}`,
                  state: "success",
                  description: null,
                  target_url: null,
                })),
              }),
            );
          }),
      }),
    ),
  );
});

it.effect("propagates legacy status request failures", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      fetchGitHubPullRequestMonitorSnapshot({
        cwd: "/workspace",
        host: "github.com",
        repository: "acme/app",
        number: 1,
      }),
    );
    assert.isTrue(result._tag === "Failure");
  }).pipe(
    Effect.provide(
      Layer.mock(GitHubCli)({
        execute: ({ args }) => {
          const command = args.join(" ");
          if (command.includes("graphql")) {
            return Effect.succeed(
              processResult(
                initialGraphql
                  .replace('"hasNextPage":true', '"hasNextPage":false')
                  .replace('"hasNextPage":true', '"hasNextPage":false'),
              ),
            );
          }
          if (command.includes("/status?")) {
            return Effect.fail(
              new GitHubCliError({
                operation: "api",
                detail: "not authenticated",
              }),
            );
          }
          if (command.includes("/issues/1/comments")) return Effect.succeed(processResult("[]"));
          if (command.includes("/compare/")) {
            return Effect.succeed(processResult('{"behind_by":0}'));
          }
          return Effect.succeed(processResult('{"total_count":0,"check_runs":[]}'));
        },
      }),
    ),
  ),
);
