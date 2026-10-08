import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as GitHubIssueCli from "./GitHubIssueCli.ts";
import * as GitHubIssueProvider from "./GitHubIssueProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>();
const rest = vi.fn<GitHubApi.GitHubApi["Service"]["rest"]>();
const layer = GitHubIssueCli.layer.pipe(
  Layer.provideMerge(Layer.mock(GitHubApi.GitHubApi)({ graphql, rest })),
);
const target = { cwd: "/w", host: "enterprise.test", repository: "acme/web", number: 7 };
const listing = {
  ...target,
  state: "open" as const,
  involvement: "all" as const,
  viewer: "bilal",
  limit: 2,
};
const instant = "2026-07-02T00:00:00Z";
const row = (number: number, updatedAt = instant) => ({
  number,
  title: `Issue ${number}`,
  url: `https://enterprise.test/acme/web/issues/${number}`,
  state: "OPEN",
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt,
  author: { login: "bilal", avatarUrl: "https://avatars/bilal" },
  repository: { nameWithOwner: "acme/web" },
  comments: { totalCount: 123 },
});
const search = (nodes: ReadonlyArray<unknown>, next: string | null = null) =>
  encodeJson({
    data: { search: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } },
  });
const core = (extra: Record<string, unknown> = {}, role = "WRITE") =>
  encodeJson({
    data: {
      viewer: { login: "bilal" },
      repository: {
        viewerPermission: role,
        issue: {
          ...row(7),
          body: "The page never loads",
          viewerCanUpdate: true,
          viewerDidAuthor: false,
          labels: { nodes: [{ name: "bug", color: "ff0000" }] },
          assignees: { nodes: [{ login: "julius", avatarUrl: "https://avatars/julius" }] },
          closedByPullRequestsReferences: {
            nodes: [
              {
                number: 9,
                title: "Fix",
                url: "https://enterprise.test/acme/web/pull/9",
                state: "MERGED",
                repository: { nameWithOwner: "acme/web" },
              },
            ],
          },
          timelineItems: { nodes: [] },
          parent: null,
          subIssues: { nodes: [] },
          ...extra,
        },
      },
    },
  });
const response = (value: unknown): GitHubApi.GitHubRestResponse => ({
  status: 200,
  headers: {},
  body: encodeJson(value),
  truncated: false,
  invalidUtf8: false,
});
const refused = new GitHubApi.GitHubApiResponseError({
  host: target.host,
  operation: "test",
  status: 403,
});
afterEach(() => {
  graphql.mockReset();
  rest.mockReset();
});

it.layer(layer)("GitHub issue API", (it) => {
  it.effect("loads the issue, viewer, avatars, permissions and links in one read", () =>
    Effect.gen(function* () {
      graphql.mockReturnValue(Effect.succeed(core()));
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      const detail = yield* cli.getIssueDetail(target);
      assert.equal(detail.body, "The page never loads");
      assert.equal(detail.commentCount, 123);
      assert.equal(detail.viewerLogin, "bilal");
      assert.equal(detail.author?.avatarUrl, "https://avatars/bilal");
      assert.equal(detail.assignees[0]?.avatarUrl, "https://avatars/julius");
      assert.equal(detail.viewerAccess.canTriage, true);
      assert.equal(detail.linkedPullRequests[0]?.number, 9);
      assert.deepEqual(detail.ancestors, []);
      assert.deepEqual(detail.subIssues, []);
      expect(graphql).toHaveBeenCalledTimes(1);
      expect(rest).not.toHaveBeenCalled();
      expect(graphql.mock.calls[0]?.[0].host).toBe(target.host);
      expect(graphql.mock.calls[0]?.[0].query).not.toContain("comments(last:");
      expect(graphql.mock.calls[0]?.[0].minimumCost).toBe(3);
      const limits = [
        ...graphql.mock.calls[0]![0].query.matchAll(/subIssues\(first: (\d+)\)/g),
      ].map((match) => Number(match[1]));
      assert.lengthOf(limits, 3);
      const [children, grandchildren, greatGrandchildren] = limits;
      const descendants = children! * (1 + grandchildren! * (1 + greatGrandchildren!));
      assert.isAtMost(descendants, 1_220);
    }),
  );

  it.effect("exposes cross-repository ancestors, nested children and their pull requests", () =>
    Effect.gen(function* () {
      const relative = (
        repository: string,
        number: number,
        extra: Record<string, unknown> = {},
      ) => ({
        number,
        title: `${repository}#${number}`,
        url: `https://enterprise.test/${repository}/issues/${number}`,
        repository: { nameWithOwner: repository },
        state: "CLOSED",
        ...extra,
      });
      graphql.mockReturnValue(
        Effect.succeed(
          core({
            parent: relative("acme/api", 7, {
              parent: relative("acme/root", 7, { parent: relative("acme/top", 1) }),
              closedByPullRequestsReferences: {
                nodes: [
                  {
                    number: 9,
                    title: "Parent fix",
                    url: "https://enterprise.test/acme/api/pull/9",
                    state: "MERGED",
                    repository: { nameWithOwner: "acme/api" },
                  },
                ],
              },
            }),
            subIssues: {
              nodes: [
                relative("acme/web", 8, {
                  state: "OPEN",
                  subIssues: {
                    nodes: [
                      relative("acme/api", 8, {
                        subIssues: { nodes: [relative("acme/deep", 8)] },
                      }),
                    ],
                  },
                  timelineItems: {
                    nodes: [
                      {
                        __typename: "CrossReferencedEvent",
                        source: {
                          __typename: "PullRequest",
                          number: 9,
                          title: "Child fix",
                          url: "https://enterprise.test/acme/web/pull/9",
                          state: "OPEN",
                          isDraft: true,
                          repository: { nameWithOwner: "acme/web" },
                        },
                      },
                    ],
                  },
                }),
                relative("acme/api", 8),
              ],
            },
          }),
        ),
      );
      const provider = yield* GitHubIssueProvider.make;
      const detail = yield* provider.getIssue(target);
      assert.deepEqual(
        detail.ancestors?.map((issue) => [issue.repository, issue.number, issue.state]),
        [
          ["acme/top", 1, "closed"],
          ["acme/root", 7, "closed"],
          ["acme/api", 7, "closed"],
        ],
      );
      assert.equal(detail.ancestors?.[2]?.linkedPullRequests?.[0]?.state, "merged");
      assert.deepEqual(
        detail.subIssues?.map((issue) => [issue.repository, issue.number, issue.url]),
        [
          ["acme/web", 8, "https://enterprise.test/acme/web/issues/8"],
          ["acme/api", 8, "https://enterprise.test/acme/api/issues/8"],
        ],
      );
      const child = detail.subIssues?.[0];
      assert.equal(child?.state, "open");
      assert.equal(child?.linkedPullRequests?.[0]?.closesIssue, false);
      assert.equal(child?.linkedPullRequests?.[0]?.isDraft, true);
      assert.equal(child?.subIssues[0]?.subIssues[0]?.repository, "acme/deep");
      assert.deepEqual(child?.subIssues[0]?.subIssues[0]?.subIssues, []);
      assert.equal(child?.subIssues[0]?.linkedPullRequests, undefined);
      expect(graphql).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("retries only unsupported hierarchy fields with the legacy query", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      for (const [index, message] of [
        "Field 'parent' doesn't exist on type 'Issue'",
        "Field 'subIssues' doesn't exist on type 'Issue'",
      ].entries()) {
        graphql.mockReset();
        graphql
          .mockReturnValueOnce(
            Effect.fail(
              new GitHubApi.GitHubApiResponseError({
                host: target.host,
                operation: "getIssueDetail",
                status: 200,
                githubErrors: [message],
              }),
            ),
          )
          .mockReturnValueOnce(Effect.succeed(core({ parent: undefined, subIssues: undefined })));
        const host = `${index}.${target.host}`;
        const detail = yield* cli.getIssueDetail({ ...target, host });
        assert.deepEqual(detail.ancestors, []);
        assert.deepEqual(detail.subIssues, []);
        assert.equal(detail.linkedPullRequests[0]?.number, 9);
        expect(graphql).toHaveBeenCalledTimes(2);
        const fallback = graphql.mock.calls[1]![0];
        expect(fallback.query).not.toContain("subIssues(");
        expect(fallback.query).not.toContain("parent {");
        assert.deepEqual(fallback.variables, { owner: "acme", name: "web", number: 7 });
        assert.equal(fallback.host, host);
      }
    }),
  );

  it.effect("remembers unsupported hierarchy per host and probes again after expiry", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      const input = { ...target, host: "old.github.test" };
      graphql
        .mockReturnValueOnce(
          Effect.fail(
            new GitHubApi.GitHubApiResponseError({
              host: input.host,
              operation: "getIssueDetail",
              status: 200,
              githubErrors: ["Field 'parent' doesn't exist on type 'Issue'"],
            }),
          ),
        )
        .mockReturnValue(Effect.succeed(core()));
      yield* cli.getIssueDetail(input);
      expect(graphql).toHaveBeenCalledTimes(2);
      yield* cli.getIssueDetail({ ...input, number: 8 });
      expect(graphql).toHaveBeenCalledTimes(3);
      expect(graphql.mock.calls[2]![0].query).not.toContain("subIssues(");
      yield* cli.getIssueDetail({ ...input, host: "new.github.test" });
      expect(graphql.mock.calls[3]![0].query).toContain("subIssues(");
      yield* TestClock.adjust("10 minutes");
      yield* cli.getIssueDetail(input);
      expect(graphql.mock.calls[4]![0].query).toContain("subIssues(");
    }),
  );

  it.effect("does not retry authentication or unrelated schema failures", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      for (const error of [
        new GitHubApi.GitHubApiAuthenticationError({
          host: target.host,
          operation: "getIssueDetail",
        }),
        refused,
        new GitHubApi.GitHubApiResponseError({
          host: target.host,
          operation: "getIssueDetail",
          status: 200,
          githubErrors: [
            'Field "parent" does not exist on type "Issue"',
            "Resource not accessible by integration",
          ],
        }),
        new GitHubApi.GitHubApiResponseError({
          host: target.host,
          operation: "getIssueDetail",
          status: 200,
          githubErrors: ['Field "body" does not exist on type "Issue"'],
        }),
      ]) {
        graphql.mockReset();
        graphql.mockReturnValue(Effect.fail(error));
        assert.strictEqual(yield* cli.getIssueDetail(target).pipe(Effect.flip), error);
        expect(graphql).toHaveBeenCalledTimes(1);
      }
    }),
  );

  it.effect("rejects malformed and missing issue details", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      for (const raw of [
        "{",
        core({ number: null }),
        core({ parent: { number: 1 } }),
        core({ subIssues: { nodes: [{ number: 8 }] } }),
        encodeJson({ data: { repository: { issue: null } } }),
      ]) {
        graphql.mockReset();
        graphql.mockReturnValue(Effect.succeed(raw));
        assert.equal(
          (yield* cli.getIssueDetail(target).pipe(Effect.flip))._tag,
          "GitHubIssueReadError",
        );
        expect(graphql).toHaveBeenCalledTimes(1);
      }
    }),
  );

  it.effect("keeps a triage role and an author's update right separate", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockReturnValue(
        Effect.succeed(core({ viewerCanUpdate: true, viewerDidAuthor: true }, "READ")),
      );
      const detail = yield* cli.getIssueDetail(target);
      assert.equal(detail.viewerAccess.canUpdate, true);
      assert.equal(detail.viewerAccess.canTriage, false);
    }),
  );

  it.effect("preserves rate-limit reset times", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      const error = new GitHubApi.GitHubApiRateLimitError({
        host: target.host,
        operation: "getIssueDetail",
        retryAt: 123456,
      });
      graphql.mockReturnValue(Effect.fail(error));
      assert.strictEqual(yield* cli.getIssueDetail(target).pipe(Effect.flip), error);
      expect(graphql).toHaveBeenCalledTimes(1);
      graphql.mockReset();
      graphql
        .mockReturnValueOnce(
          Effect.fail(
            new GitHubApi.GitHubApiResponseError({
              host: target.host,
              operation: "getIssueDetail",
              status: 200,
              githubErrors: ["Field 'parent' doesn't exist on type 'Issue'"],
            }),
          ),
        )
        .mockReturnValue(Effect.fail(error));
      assert.strictEqual(yield* cli.getIssueDetail(target).pipe(Effect.flip), error);
      expect(graphql).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("lists multiple repositories with all filters in one request", () =>
    Effect.gen(function* () {
      graphql.mockReturnValue(
        Effect.succeed(search([row(7), row(8), row(9, "2026-07-01T00:00:00Z")])),
      );
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      const batch = yield* cli.searchIssues({
        ...listing,
        repositories: ["acme/web", "acme/api"],
        involvement: "assigned",
        query: 'crash is:closed "x"',
        cursor: { updatedBefore: instant },
      });
      assert.deepEqual(
        batch.items.map((item) => item.number),
        [7, 8],
      );
      assert.equal(batch.truncated, true);
      const query = graphql.mock.calls[0]![0].variables!["q"];
      expect(query).toContain("is:issue");
      expect(query).toContain("is:open");
      expect(query).toContain("assignee:bilal");
      expect(query).toContain("repo:acme/web repo:acme/api");
      expect(query).toContain(`updated:<=${instant}`);
      expect(query).toContain('"crash is:closed \\"x\\""');
      expect(graphql).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("uses each involvement qualifier and preserves host selection", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockReturnValue(Effect.succeed(search([row(7)])));
      for (const [involvement, qualifier] of [
        ["assigned", "assignee"],
        ["authored", "author"],
        ["mentioned", "mentions"],
      ] as const) {
        yield* cli.listIssues({ ...listing, involvement });
        const input = graphql.mock.calls.at(-1)![0];
        assert.equal(input.host, target.host);
        expect(input.variables!["q"]).toContain(`${qualifier}:bilal`);
      }
    }),
  );

  it.effect("keeps non-recency sorting out of timestamp paging", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockReturnValue(Effect.succeed(search([row(7), row(8), row(9)])));
      const batch = yield* cli.listIssues({
        ...listing,
        sort: "reactions-thumbs-up",
        order: "asc",
        cursor: { updatedBefore: instant },
      });
      assert.equal(batch.continues, false);
      expect(graphql.mock.calls[0]![0].variables!["q"]).toContain("sort:reactions-+1-asc");
      expect(graphql.mock.calls[0]![0].variables!["q"]).not.toContain("updated:<=");
    }),
  );

  it.effect("keeps best-match ranking without a sort qualifier", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockReturnValue(Effect.succeed(search([row(7)])));
      yield* cli.listIssues({ ...listing, sort: "best-match" });
      expect(graphql.mock.calls[0]![0].variables!["q"]).not.toContain("sort:");
    }),
  );

  it.effect("does not turn an empty text search or continuation into an unfiltered list", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockReturnValue(Effect.succeed(search([])));
      for (const extra of [{ query: "missing" }, { cursor: { updatedBefore: instant } }]) {
        const batch = yield* cli.listIssues({ ...listing, ...extra });
        assert.equal(batch.items.length, 0);
      }
      expect(graphql).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("uses a search-free repository query when its search index is empty", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockReturnValueOnce(Effect.succeed(search([]))).mockReturnValueOnce(
        Effect.succeed(
          encodeJson({
            data: {
              repository: {
                hasIssuesEnabled: true,
                issues: { nodes: [row(7)], pageInfo: { hasNextPage: true } },
              },
            },
          }),
        ),
      );
      const batch = yield* cli.listIssues({ ...listing, involvement: "mentioned" });
      assert.deepEqual(
        batch.items.map((item) => item.number),
        [7],
      );
      assert.equal(batch.continues, false);
      assert.equal(batch.truncated, true);
      assert.equal(graphql.mock.calls[1]![0].variables!["mentioned"], "bilal");
    }),
  );

  it.effect("reports a disabled tracker", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql
        .mockReturnValueOnce(Effect.succeed(search([])))
        .mockReturnValueOnce(
          Effect.succeed(
            encodeJson({ data: { repository: { hasIssuesEnabled: false, issues: null } } }),
          ),
        );
      assert.equal(
        (yield* cli.listIssues(listing).pipe(Effect.flip))._tag,
        "GitHubIssuesDisabledError",
      );
    }),
  );

  it.effect("refuses invalid repositories before calling the API", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      assert.equal(
        (yield* cli
          .searchIssues({ ...listing, repositories: ["acme/web is:closed"] })
          .pipe(Effect.flip))._tag,
        "GitHubIssueRepositorySelectorError",
      );
      expect(graphql).not.toHaveBeenCalled();
    }),
  );

  it.effect("counts malformed rows when detecting an extra page", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockReturnValue(Effect.succeed(search([row(7), row(8), { number: 9 }])));
      const batch = yield* cli.listIssues({ ...listing, sort: "created" });
      assert.equal(batch.items.length, 2);
      assert.equal(batch.truncated, true);
    }),
  );

  it.effect("reads past GitHub's page limit to keep a timestamp group whole", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql
        .mockReturnValueOnce(
          Effect.succeed(
            search(
              Array.from({ length: 100 }, (_, i) => row(i + 1)),
              "next",
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(search([row(101), row(102, "2026-07-01T00:00:00Z")])));
      const batch = yield* cli.listIssues({ ...listing, limit: 99 });
      assert.equal(batch.items.length, 101);
      assert.equal(batch.truncated, true);
      assert.equal(batch.continues, true);
      assert.equal(graphql.mock.calls[1]![0].variables!["cursor"], "next");
    }),
  );

  it.effect("fills search slices larger than GitHub's page limit in every sort", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      for (const sort of ["updated", "created", "best-match"] as const) {
        graphql.mockReset();
        graphql
          .mockReturnValueOnce(
            Effect.succeed(
              search(
                Array.from({ length: 100 }, (_, i) => row(i + 1)),
                "next",
              ),
            ),
          )
          .mockReturnValueOnce(
            Effect.succeed(
              search([row(101, "2026-07-01T00:00:00Z"), row(102, "2026-06-30T00:00:00Z")]),
            ),
          );
        const batch = yield* cli.searchIssues({
          ...listing,
          repositories: [target.repository],
          limit: 101,
          sort,
        });
        assert.equal(batch.items.length, 101);
        assert.equal(batch.items.at(-1)?.number, 101);
        assert.equal(batch.truncated, true);
        assert.equal(graphql.mock.calls[1]?.[0].variables?.["cursor"], "next");
        expect(graphql).toHaveBeenCalledTimes(2);
      }
    }),
  );

  it.effect("finishes a timestamp group when the requested slice exceeds one search page", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql
        .mockReturnValueOnce(
          Effect.succeed(
            search(
              Array.from({ length: 100 }, (_, i) => row(i + 1)),
              "next",
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            search([
              ...Array.from({ length: 21 }, (_, i) => row(i + 101)),
              row(122, "2026-07-01T00:00:00Z"),
            ]),
          ),
        );
      const batch = yield* cli.listIssues({ ...listing, limit: 101 });
      assert.equal(batch.items.length, 121);
      assert.equal(batch.items.at(-1)?.number, 121);
      assert.equal(batch.truncated, true);
      assert.equal(batch.continues, true);
      assert.equal(graphql.mock.calls[1]?.[0].variables?.["cursor"], "next");
      expect(graphql).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect.each([1000, 1001])("reports whether %i tied rows exceed the search ceiling", (total) =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockImplementation(({ variables }) => {
        const start = Number(variables?.["cursor"] ?? 0);
        const end = Math.min(start + 100, total);
        return Effect.succeed(
          search(
            Array.from({ length: end - start }, (_, i) => row(start + i + 1)),
            end < total ? String(end) : null,
          ),
        );
      });
      const searched = yield* cli.searchIssues({
        ...listing,
        repositories: [target.repository],
        limit: 99,
      });
      assert.equal(searched.ceilingReached, total > 1000);
      const batch = yield* cli.listIssues({ ...listing, limit: 99 });
      assert.equal(batch.items.length, 1000);
      assert.equal(batch.continues, total === 1000);
      assert.equal(batch.truncated, total > 1000);
      expect(graphql).toHaveBeenCalledTimes(20);
    }),
  );

  it.effect("reads older issues after skipping a sent timestamp group larger than one page", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql
        .mockReturnValueOnce(
          Effect.succeed(
            search(
              Array.from({ length: 100 }, (_, i) => row(i + 1)),
              "next",
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            search([
              ...Array.from({ length: 21 }, (_, i) => row(i + 101)),
              row(122, "2026-07-01T00:00:00Z"),
            ]),
          ),
        );
      const batch = yield* cli.listIssues({
        ...listing,
        limit: 101,
        cursor: { updatedBefore: instant, seenAt: Array.from({ length: 121 }, (_, i) => i + 1) },
      });
      assert.deepEqual(
        batch.items.map((item) => item.number),
        [122],
      );
      assert.equal(batch.truncated, false);
      expect(graphql).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("skips sent timestamp rows by repository in a grouped search", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockReturnValue(
        Effect.succeed(
          search([
            row(7),
            {
              ...row(7),
              repository: { nameWithOwner: "acme/api" },
              url: "https://enterprise.test/acme/api/issues/7",
            },
            row(8, "2026-07-01T00:00:00Z"),
          ]),
        ),
      );
      const batch = yield* cli.searchIssues({
        ...listing,
        repositories: ["acme/web", "acme/api"],
        cursor: { updatedBefore: instant, seenAtByRepository: { "acme/web": [7] } },
      });
      assert.deepEqual(
        batch.items.map((item) => [item.repository, item.number]),
        [
          ["acme/api", 7],
          ["acme/web", 8],
        ],
      );
      assert.equal(batch.truncated, false);
    }),
  );

  it.effect("keeps sent-row continuation inside the search ceiling", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockImplementation(() =>
        Effect.succeed(
          search(
            Array.from({ length: 100 }, (_, i) => row(i + 1)),
            "next",
          ),
        ),
      );
      const batch = yield* cli.listIssues({
        ...listing,
        limit: 99,
        cursor: { updatedBefore: instant, seenAt: Array.from({ length: 100 }, (_, i) => i + 1) },
      });
      assert.equal(batch.items.length, 0);
      assert.equal(batch.continues, false);
      assert.equal(batch.truncated, true);
      expect(graphql).toHaveBeenCalledTimes(10);
    }),
  );

  it.effect("stops an empty search page even when the host advertises a cursor", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockReturnValue(Effect.succeed(search([], "next")));
      const batch = yield* cli.searchIssues({ ...listing, repositories: [target.repository] });
      assert.deepEqual(batch.items, []);
      expect(graphql).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("reads recent comments and activity separately from the detail", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockReturnValue(
        Effect.succeed(
          encodeJson({
            data: {
              repository: {
                issue: {
                  author: { login: "bilal" },
                  comments: {
                    totalCount: 123,
                    pageInfo: { hasPreviousPage: true, startCursor: "older" },
                    nodes: [{ id: "C1", body: "Comment", createdAt: instant }],
                  },
                  timelineItems: {
                    nodes: [{ __typename: "ClosedEvent", id: "E1", createdAt: instant }],
                  },
                },
              },
            },
          }),
        ),
      );
      const activity = yield* cli.getIssueActivity(target);
      assert.equal(activity.commentCount, 123);
      assert.equal(activity.comments.length, 1);
      assert.equal(activity.commentsTruncated, true);
      assert.equal(activity.nextCommentsCursor, "older");
      assert.equal(activity.events.length, 1);
      yield* cli.getIssueComments({ ...target, cursor: "older" });
      assert.equal(graphql.mock.calls[1]![0].variables!["cursor"], "older");
    }),
  );

  it.effect("closes with supported reasons and reopens without one", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      rest.mockReturnValue(Effect.succeed(response({})));
      for (const reason of ["completed", "not-planned"] as const) {
        yield* cli.runIssueAction({ ...target, action: "close", reason });
        expect(rest.mock.calls.at(-1)![0].body).toEqual({
          state: "closed",
          state_reason: reason === "completed" ? "completed" : "not_planned",
        });
      }
      yield* cli.runIssueAction({ ...target, action: "reopen" });
      expect(rest.mock.calls.at(-1)![0].body).toEqual({ state: "open" });
    }),
  );

  it.effect("creates an issue and keeps user text in the JSON body", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      rest.mockReturnValue(
        Effect.succeed(
          response({ number: 12, html_url: "https://enterprise.test/acme/web/issues/12" }),
        ),
      );
      const created = yield* cli.createIssue({
        ...target,
        title: "Title",
        body: "Body\nsecond line",
        labels: ["bug"],
        assignees: ["bilal"],
      });
      assert.equal(created.number, 12);
      expect(rest.mock.calls[0]![0]).toMatchObject({
        host: target.host,
        method: "POST",
        path: "repos/acme/web/issues",
        body: { title: "Title", body: "Body\nsecond line", labels: ["bug"], assignees: ["bilal"] },
      });
    }),
  );

  it.effect("writes only edited fields and clears whole label and assignee sets", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      rest.mockReturnValue(Effect.succeed(response({})));
      yield* cli.updateIssue({ ...target, title: "New title" });
      expect(rest.mock.calls.at(-1)![0].body).toEqual({ title: "New title" });
      yield* cli.setLabels({ ...target, labels: [] });
      expect(rest.mock.calls.at(-1)![0].body).toEqual({ labels: [] });
      yield* cli.setAssignees({ ...target, assignees: [] });
      expect(rest.mock.calls.at(-1)![0].body).toEqual({ assignees: [] });
      yield* cli.commentOnIssue({ ...target, body: "Comment" });
      expect(rest.mock.calls.at(-1)![0]).toMatchObject({
        path: "repos/acme/web/issues/7/comments",
        body: { body: "Comment" },
      });
    }),
  );

  it.effect("rejects comment edits and reactions outside the selected issue", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockReturnValue(
        Effect.succeed(
          encodeJson({
            data: {
              node: { __typename: "IssueComment", issue: { id: "I8" } },
              repository: { issue: { id: "I7" } },
            },
          }),
        ),
      );
      for (const read of [
        cli.updateComment({ ...target, commentId: "C1", body: "Edit" }),
        cli.setReaction({ ...target, subjectId: "C1", content: "thumbs-up", reacted: true }),
      ]) {
        assert.equal((yield* read.pipe(Effect.flip))._tag, "GitHubIssueCommentScopeError");
      }
      expect(graphql).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("reacts to the body through its node ID", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql
        .mockReturnValueOnce(
          Effect.succeed(encodeJson({ data: { repository: { issue: { id: "I7" } } } })),
        )
        .mockReturnValueOnce(Effect.succeed("{}"));
      yield* cli.setReaction({ ...target, content: "thumbs-up", reacted: true });
      expect(graphql.mock.calls[1]![0].variables).toEqual({
        subjectId: "I7",
        content: "THUMBS_UP",
      });
    }),
  );

  it.effect("gets labels with their applied state without reading the body", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockReturnValue(
        Effect.succeed(
          encodeJson({
            data: {
              repository: {
                viewerPermission: "WRITE",
                labels: {
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    { name: "bug", color: "ff0000", description: "Broken" },
                    { name: "feature" },
                  ],
                },
                issue: { labels: { nodes: [{ name: "bug" }] } },
              },
            },
          }),
        ),
      );
      const labels = yield* cli.listLabelCandidates(target);
      assert.deepEqual(
        labels.candidates.map((label) => [label.name, label.isApplied]),
        [
          ["bug", true],
          ["feature", false],
        ],
      );
      expect(graphql).toHaveBeenCalledTimes(1);
      expect(graphql.mock.calls[0]![0].query).not.toContain("body");
    }),
  );

  it.effect("limits label pagination and marks an incomplete picker", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockReturnValue(
        Effect.succeed(
          encodeJson({
            data: {
              repository: {
                viewerPermission: "WRITE",
                labels: {
                  pageInfo: { hasNextPage: true, endCursor: "more" },
                  nodes: [{ name: "bug" }],
                },
                issue: { labels: { nodes: [] } },
              },
            },
          }),
        ),
      );
      const labels = yield* cli.listLabelCandidates(target);
      assert.equal(labels.truncated, true);
      expect(graphql).toHaveBeenCalledTimes(5);
    }),
  );

  it.effect("preserves assigned people who are no longer assignable", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockReturnValue(
        Effect.succeed(
          encodeJson({
            data: {
              repository: {
                viewerPermission: "WRITE",
                assignableUsers: { pageInfo: { hasNextPage: true }, nodes: [{ login: "bilal" }] },
                issue: { assignees: { nodes: [{ login: "former" }] } },
              },
            },
          }),
        ),
      );
      const people = yield* cli.listAssigneeCandidates(target);
      assert.deepEqual(
        people.candidates.map((person) => [person.id, person.isAssigned]),
        [
          ["former", true],
          ["bilal", false],
        ],
      );
      assert.equal(people.truncated, true);
    }),
  );

  it.effect("reads the viewer and rejects an empty login", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql
        .mockReturnValueOnce(Effect.succeed('{"data":{"viewer":{"login":"bilal"}}}'))
        .mockReturnValueOnce(Effect.succeed('{"data":{"viewer":{"login":""}}}'));
      assert.equal(yield* cli.getViewerLogin(target), "bilal");
      assert.equal(
        (yield* cli.getViewerLogin(target).pipe(Effect.flip))._tag,
        "GitHubIssueReadError",
      );
    }),
  );

  it.effect("keeps templates when optional form and config reads fail", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql
        .mockReturnValueOnce(Effect.succeed('{"data":{"repository":{"issueTemplates":[]}}}'))
        .mockReturnValueOnce(Effect.fail(refused));
      rest.mockReturnValue(Effect.fail(refused));
      const templates = yield* cli.listIssueTemplates(target);
      assert.deepEqual(templates.templates, []);
      assert.equal(templates.blankIssuesEnabled, true);
    }),
  );

  it.effect("preserves rate-limit errors from optional template reads", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      for (const error of [
        new GitHubApi.GitHubApiRateLimitError({
          host: target.host,
          operation: "listIssueTemplates",
          retryAt: 123456,
        }),
        new SourceControlRateLimit.SourceControlRateLimitPausedError({
          provider: "github",
          host: target.host,
          retryAt: 123456,
        }),
      ]) {
        for (const stage of ["forms", "config"] as const) {
          graphql.mockImplementation((input) =>
            input.operation === "listIssueTemplates"
              ? Effect.succeed(encodeJson({ data: { repository: { issueTemplates: [] } } }))
              : Effect.fail(stage === "forms" ? error : refused),
          );
          rest.mockReturnValue(Effect.fail(stage === "config" ? error : refused));
          assert.strictEqual(yield* cli.listIssueTemplates(target).pipe(Effect.flip), error);
        }
      }
    }),
  );

  it.effect("batches concurrent status reads while keeping different hosts separate", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockImplementation((input) =>
        Effect.succeed(
          encodeJson({
            data: {
              rateLimit: { cost: 1, remaining: 5000 },
              ...Object.fromEntries(
                [...input.query.matchAll(/issue(\d+): repository[^}]+issue\(number: (\d+)\)/g)].map(
                  (match) => [`issue${match[1]}`, { issue: row(Number(match[2])) }],
                ),
              ),
            },
          }),
        ),
      );
      const pending = yield* Effect.all(
        [
          cli.getIssueSummary(target),
          cli.getIssueSummary({ ...target, number: 8 }),
          cli.getIssueSummary({ ...target, host: "github.com" }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 millis");
      const results = yield* Fiber.await(pending);
      expect(results._tag).toBe("Success");
      expect(graphql).toHaveBeenCalledTimes(2);
      expect(graphql.mock.calls.some(([input]) => input.query.includes("issue1:"))).toBe(true);
      for (const [input] of graphql.mock.calls) expect(input.query).not.toContain("body");
    }),
  );

  it.effect("bounds summary batches to 25 issues", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockImplementation((input) =>
        Effect.succeed(
          encodeJson({
            data: Object.fromEntries(
              [...input.query.matchAll(/issue(\d+): repository[^}]+issue\(number: (\d+)\)/g)].map(
                (match) => [`issue${match[1]}`, { issue: row(Number(match[2])) }],
              ),
            ),
          }),
        ),
      );
      const pending = yield* Effect.all(
        Array.from({ length: 26 }, (_, index) =>
          cli.getIssueSummary({ ...target, number: index + 1 }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 millis");
      const results = yield* Fiber.join(pending);
      assert.equal(results.length, 26);
      expect(graphql).toHaveBeenCalledTimes(2);
      expect(
        graphql.mock.calls.every(([input]) => [...input.query.matchAll(/issue\d+:/g)].length <= 25),
      ).toBe(true);
    }),
  );

  it.effect("recovers readable issues when a summary batch is refused", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockImplementation((input) =>
        input.query.includes("issue1:") || input.query.includes("number: 8")
          ? Effect.fail(refused)
          : Effect.succeed(encodeJson({ data: { issue0: { issue: row(7) } } })),
      );
      const pending = yield* Effect.all(
        [
          cli.getIssueSummary(target).pipe(Effect.exit),
          cli.getIssueSummary({ ...target, number: 8 }).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 millis");
      const results = yield* Fiber.join(pending);
      assert.equal(results[0]?._tag, "Success");
      assert.equal(results[1]?._tag, "Failure");
      expect(graphql).toHaveBeenCalledTimes(3);
    }),
  );

  it.effect("does not fan out a rate-limited summary batch", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      graphql.mockReturnValue(
        Effect.fail(
          new GitHubApi.GitHubApiRateLimitError({
            host: target.host,
            operation: "summary",
            retryAt: 123456,
          }),
        ),
      );
      const pending = yield* Effect.all(
        [
          cli.getIssueSummary(target).pipe(Effect.flip),
          cli.getIssueSummary({ ...target, number: 8 }).pipe(Effect.flip),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 millis");
      const results = yield* Fiber.join(pending);
      assert.equal(
        results.every(
          (error) => error._tag === "GitHubApiRateLimitError" && error.retryAt === 123456,
        ),
        true,
      );
      expect(graphql).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("reads more than one fallback page without a timestamp cursor", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      const repositoryPage = (nodes: ReadonlyArray<unknown>, cursor: string | null) =>
        encodeJson({
          data: {
            repository: {
              hasIssuesEnabled: true,
              issues: { nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } },
            },
          },
        });
      graphql
        .mockReturnValueOnce(Effect.succeed(search([])))
        .mockReturnValueOnce(
          Effect.succeed(
            repositoryPage(
              Array.from({ length: 100 }, (_, index) => row(index + 1)),
              "next",
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(repositoryPage([row(101), row(102)], null)));
      const batch = yield* cli.listIssues({ ...listing, limit: 101 });
      assert.equal(batch.items.length, 101);
      assert.equal(batch.items.at(-1)?.number, 101);
      assert.equal(batch.truncated, true);
      assert.equal(batch.continues, false);
      assert.equal(graphql.mock.calls[2]?.[0].variables?.["cursor"], "next");
      assert.equal(graphql.mock.calls[2]?.[0].variables?.["first"], 2);
    }),
  );

  it.effect("keeps different pinned credentials in separate summary batches", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubIssueCli.GitHubIssueCli;
      const used: string[] = [];
      graphql.mockImplementation(() =>
        Effect.map(GitHubApi.PinnedGitHubCredential, (credential) => {
          used.push(credential?.credentialFingerprint ?? "missing");
          return encodeJson({ data: { issue0: { issue: row(7) } } });
        }),
      );
      const read = (fingerprint: string) =>
        cli.getIssueSummary(target).pipe(
          Effect.provideService(GitHubApi.PinnedGitHubCredential, {
            host: target.host,
            token: Redacted.make("test"),
            credentialFingerprint: fingerprint,
          }),
        );
      const pending = yield* Effect.all([read("a"), read("b")], { concurrency: "unbounded" }).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("10 millis");
      yield* Fiber.await(pending);
      expect(graphql).toHaveBeenCalledTimes(2);
      assert.deepEqual(used.toSorted(), ["a", "b"]);
    }),
  );
});
