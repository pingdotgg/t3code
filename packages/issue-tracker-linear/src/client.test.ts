import { assert, describe, it } from "@effect/vitest";
import { apiKeyAuth } from "@t3tools/issue-tracker-core/IssueTrackerAuth";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { makeLinearTracker, normalizeIssueFilter } from "./client.ts";
import { buildIssueFilter } from "./queries.ts";

interface Recorded {
  readonly body: { readonly query: string; readonly variables: Record<string, unknown> };
  readonly authorization: string | undefined;
}

type Handler = (call: Recorded, index: number) => Response | "network-error";

const makeHttp = (handler: Handler) => {
  const calls: Recorded[] = [];
  const http = HttpClient.make((request) => {
    const raw =
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
    const call = { body: JSON.parse(raw), authorization: request.headers.authorization };
    calls.push(call);
    const result = handler(call, calls.length - 1);
    return result === "network-error"
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, result));
  });
  return { http, calls };
};

const issueNode = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `issue-${n}`,
  identifier: `ATT-${n}`,
  title: `Issue ${n}`,
  url: `https://linear.app/acme/issue/ATT-${n}`,
  priority: 2,
  priorityLabel: "High",
  branchName: `att-${n}`,
  updatedAt: "2026-10-30T10:00:00.000Z",
  state: { id: "s1", name: "Todo", type: "unstarted", color: "#ccc" },
  assignee: null,
  labels: { nodes: [{ id: "l1", name: "bug", color: "#f00" }] },
  cycle: null,
  projectMilestone: null,
  project: null,
  team: { id: "t1", key: "ATT", name: "Attio" },
  parent: null,
  children: {
    nodes: [
      { id: "c1", state: { type: "completed" } },
      { id: "c2", state: { type: "started" } },
      { id: "c3", state: { type: "canceled" } },
    ],
  },
  attachments: { nodes: [] },
  ...overrides,
});

const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);
const tracker = (http: HttpClient.HttpClient, key = "lin_api_secret") =>
  makeLinearTracker({ auth: apiKeyAuth(Effect.succeed(key)) }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
  );

const viewerBody = {
  data: {
    viewer: { id: "u1", name: "Ada", email: "ada@example.com", avatarUrl: null },
    organization: { id: "o1", name: "Acme", urlKey: "acme" },
  },
};

describe("Linear tracker transport", () => {
  it.effect("verifies a key and sends it without a Bearer prefix", () =>
    Effect.gen(function* () {
      const { http, calls } = makeHttp(() => json(viewerBody));
      const result = yield* (yield* tracker(http)).verify;
      assert.strictEqual(result.organization.urlKey, "acme");
      assert.strictEqual(result.viewer.name, "Ada");
      assert.strictEqual(calls[0]?.authorization, "lin_api_secret");
    }),
  );

  it.effect("maps HTTP 401 to Unauthorized without echoing the key", () =>
    Effect.gen(function* () {
      const { http } = makeHttp(() => json({ errors: [{ message: "bad" }] }, { status: 401 }));
      const exit = yield* Effect.exit((yield* tracker(http)).verify);
      assert.isTrue(Exit.isFailure(exit));
      const text = JSON.stringify(exit);
      assert.include(text, "IssueTrackerUnauthorized");
      assert.notInclude(text, "lin_api_secret");
    }),
  );

  it.effect("maps an authentication GraphQL error to Unauthorized", () =>
    Effect.gen(function* () {
      const { http } = makeHttp(() =>
        json(
          { errors: [{ message: "x", extensions: { type: "authentication error" } }] },
          { status: 400 },
        ),
      );
      const error = yield* Effect.flip((yield* tracker(http)).verify);
      assert.strictEqual(error._tag, "IssueTrackerUnauthorized");
    }),
  );

  it.effect("maps permission and input errors to Rejected, never an outage or a bad key", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<[Response, string]> = [
        [
          json(
            { errors: [{ message: "x", extensions: { code: "FORBIDDEN", type: "forbidden" } }] },
            { status: 400 },
          ),
          "Your Linear key can't access that.",
        ],
        [new Response("{}", { status: 403 }), "Your Linear key can't access that."],
        [
          json({ errors: [{ message: "bad", extensions: { type: "invalid input" } }] }),
          "Linear rejected the request.",
        ],
        [
          json({ errors: [{ message: "Query too complex" }] }, { status: 400 }),
          "Linear rejected the request.",
        ],
      ];
      for (const [response, message] of cases) {
        const { http } = makeHttp(() => response.clone());
        const error = yield* Effect.flip((yield* tracker(http)).verify);
        assert.deepStrictEqual(
          [error._tag, "message" in error ? error.message : null],
          ["IssueTrackerRejected", message],
        );
      }
    }),
  );

  it.effect("keeps partial data beside a field error, and a 5xx GraphQL error is an outage", () =>
    Effect.gen(function* () {
      const partial = makeHttp(() =>
        json({ ...viewerBody, errors: [{ message: "x", extensions: { type: "forbidden" } }] }),
      );
      assert.strictEqual((yield* (yield* tracker(partial.http)).verify).viewer.name, "Ada");

      const outage = makeHttp(() => json({ errors: [{ message: "boom" }] }, { status: 502 }));
      const error = yield* Effect.flip((yield* tracker(outage.http)).verify);
      assert.strictEqual(error._tag, "IssueTrackerUnavailable");
    }),
  );

  it.effect("maps network failures to Unavailable", () =>
    Effect.gen(function* () {
      const { http } = makeHttp(() => "network-error");
      const error = yield* Effect.flip((yield* tracker(http)).verify);
      assert.strictEqual(error._tag, "IssueTrackerUnavailable");
    }),
  );

  it.effect("maps 5xx to Unavailable", () =>
    Effect.gen(function* () {
      const { http } = makeHttp(() => new Response("oops", { status: 503 }));
      const error = yield* Effect.flip((yield* tracker(http)).verify);
      assert.strictEqual(error._tag, "IssueTrackerUnavailable");
    }),
  );

  it.effect("maps a RATELIMITED error to RateLimited using the reset header", () =>
    Effect.gen(function* () {
      const observed: Array<{ remaining: number | null; resetsAtMs: number | null }> = [];
      const resetsAt = (yield* Clock.currentTimeMillis) + 90_000;
      const { http } = makeHttp(() =>
        json(
          { errors: [{ message: "slow down", extensions: { code: "RATELIMITED" } }] },
          {
            status: 400,
            headers: {
              "x-ratelimit-requests-remaining": "0",
              "x-ratelimit-requests-reset": String(resetsAt),
            },
          },
        ),
      );
      const linear = yield* makeLinearTracker({
        auth: apiKeyAuth(Effect.succeed("k")),
        observeRateLimit: (observation) => Effect.sync(() => void observed.push(observation)),
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
      const error = yield* Effect.flip(linear.verify);
      assert.strictEqual(error._tag, "IssueTrackerRateLimited");
      if (error._tag === "IssueTrackerRateLimited") {
        assert.isAtLeast(error.retryAfterSeconds, 85);
        assert.isAtMost(error.retryAfterSeconds, 91);
      }
      assert.deepStrictEqual(observed, [{ remaining: 0, resetsAtMs: resetsAt }]);
    }),
  );

  it.effect("maps HTTP 429 with Retry-After to RateLimited", () =>
    Effect.gen(function* () {
      const { http } = makeHttp(
        () => new Response("{}", { status: 429, headers: { "retry-after": "17" } }),
      );
      const error = yield* Effect.flip((yield* tracker(http)).verify);
      assert.deepStrictEqual(
        error._tag === "IssueTrackerRateLimited" ? error.retryAfterSeconds : null,
        17,
      );
    }),
  );
});

describe("Linear tracker data mapping", () => {
  it.effect("paginates 50 at a time and caps lists at 250 with a truncated flag", () =>
    Effect.gen(function* () {
      const { http, calls } = makeHttp((_call, index) =>
        json({
          data: {
            issues: {
              nodes: Array.from({ length: 50 }, (_, i) => issueNode(index * 50 + i)),
              pageInfo: { hasNextPage: true, endCursor: `cursor-${index}` },
            },
          },
        }),
      );
      const page = yield* (yield* tracker(http)).issues({});
      assert.strictEqual(page.issues.length, 250);
      assert.isTrue(page.truncated);
      assert.strictEqual(calls.length, 5);
      assert.strictEqual(calls[0]?.body.variables.after, null);
      assert.strictEqual(calls[1]?.body.variables.after, "cursor-0");
    }),
  );

  it.effect("is not truncated when Linear has no more pages", () =>
    Effect.gen(function* () {
      const { http, calls } = makeHttp(() =>
        json({
          data: {
            issues: {
              nodes: [issueNode(1), issueNode(2)],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      );
      const page = yield* (yield* tracker(http)).issues({ teamId: "t1" });
      assert.strictEqual(page.issues.length, 2);
      assert.isFalse(page.truncated);
      assert.strictEqual(calls.length, 1);
    }),
  );

  it.effect("maps issues, sub-issue counts and GitHub pull request attachments", () =>
    Effect.gen(function* () {
      const { http } = makeHttp(() =>
        json({
          data: {
            issue: issueNode(7, {
              attachments: {
                nodes: [
                  {
                    id: "a1",
                    title: "PR",
                    url: "https://github.com/acme/web/pull/1362",
                    sourceType: "github",
                    metadata: { status: "open" },
                  },
                  {
                    id: "a2",
                    title: "dup",
                    url: "https://github.com/acme/web/pull/1362/files",
                    sourceType: "github",
                  },
                  { id: "a3", title: "Figma", url: "https://figma.com/x", sourceType: "figma" },
                  {
                    id: "a4",
                    title: "Issue",
                    url: "https://github.com/acme/web/issues/5",
                    sourceType: "github",
                  },
                ],
              },
              priority: 9,
              state: { id: "s", name: "Weird", type: "future-type", color: "#000" },
            }),
          },
        }),
      );
      const issue = yield* (yield* tracker(http)).issue("ATT-7");
      assert.deepStrictEqual(issue.linkedPullRequests, [
        {
          repository: "acme/web",
          number: 1362,
          state: "open",
          url: "https://github.com/acme/web/pull/1362",
        },
      ]);
      assert.strictEqual(issue.subIssueCount, 2);
      assert.strictEqual(issue.completedSubIssueCount, 1);
      assert.strictEqual(issue.priority, 0);
      assert.strictEqual(issue.state.type, "unstarted");
      assert.strictEqual(issue.milestone, null);
    }),
  );

  it.effect("fails NotFound for a missing issue", () =>
    Effect.gen(function* () {
      const { http } = makeHttp(() => json({ data: { issue: null } }));
      const error = yield* Effect.flip((yield* tracker(http)).issue("nope"));
      assert.strictEqual(error._tag, "IssueTrackerNotFound");
    }),
  );

  it.effect("counts assigned issues per team and keeps teams when the count query fails", () =>
    Effect.gen(function* () {
      const teamNode = {
        id: "t1",
        key: "ATT",
        name: "Attio",
        description: null,
        color: null,
        icon: null,
        projects: { nodes: [{ id: "p1" }, { id: "p2" }] },
      };
      const ok = makeHttp((call) =>
        call.body.query.includes("AssignedIssues")
          ? json({
              data: {
                viewer: {
                  assignedIssues: { nodes: [{ team: { id: "t1" } }, { team: { id: "t1" } }] },
                },
              },
            })
          : json({
              data: {
                teams: { nodes: [teamNode], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            }),
      );
      const [team] = yield* (yield* tracker(ok.http)).teams;
      assert.strictEqual(team?.projectCount, 2);
      assert.strictEqual(team?.assignedToViewerCount, 2);

      const degraded = makeHttp((call) =>
        call.body.query.includes("AssignedIssues")
          ? new Response("boom", { status: 500 })
          : json({
              data: {
                teams: { nodes: [teamNode], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            }),
      );
      const [fallback] = yield* (yield* tracker(degraded.http)).teams;
      assert.strictEqual(fallback?.assignedToViewerCount, 0);
    }),
  );

  it.effect("marks milestones completed at progress 1 or status done and caps issue counts", () =>
    Effect.gen(function* () {
      const { http } = makeHttp(() =>
        json({
          data: {
            project: {
              id: "p1",
              projectMilestones: {
                nodes: [
                  {
                    id: "m2",
                    name: "B",
                    progress: 0.4,
                    targetDate: null,
                    sortOrder: 2,
                    status: "done",
                    issues: { nodes: [], pageInfo: { hasNextPage: false } },
                  },
                  {
                    id: "m1",
                    name: "A",
                    progress: 1,
                    targetDate: "2026-11-01",
                    sortOrder: 1,
                    status: "next",
                    issues: { nodes: [{ id: "i" }], pageInfo: { hasNextPage: false } },
                  },
                  {
                    id: "m3",
                    name: "C",
                    progress: 0.2,
                    targetDate: null,
                    sortOrder: 3,
                    status: "unstarted",
                    issues: { nodes: [{ id: "j" }], pageInfo: { hasNextPage: true } },
                  },
                ],
              },
            },
          },
        }),
      );
      const milestones = yield* (yield* tracker(http)).milestones("p1");
      assert.deepStrictEqual(
        milestones.map((m) => [m.id, m.completed, m.issueCount, m.issueCountCapped]),
        [
          ["m1", true, 1, false],
          ["m2", true, 0, false],
          ["m3", false, 1, true],
        ],
      );
    }),
  );

  it.effect("returns the last comments oldest first in issue detail", () =>
    Effect.gen(function* () {
      const { http } = makeHttp((call) =>
        call.body.query.includes("IssueDetail")
          ? json({
              data: {
                issue: {
                  ...issueNode(3, { projectMilestone: { id: "m", name: "M", progress: 50 } }),
                  description: null,
                  comments: {
                    nodes: [
                      { id: "c2", body: "later", createdAt: "2026-10-02T00:00:00Z", user: null },
                      { id: "c1", body: "first", createdAt: "2026-10-01T00:00:00Z", user: null },
                    ],
                  },
                },
              },
            })
          : json({
              data: {
                issue: {
                  children: {
                    nodes: [issueNode(4)],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            }),
      );
      const detail = yield* (yield* tracker(http)).issueDetail("ATT-3");
      assert.deepStrictEqual(
        detail.comments.map((c) => c.id),
        ["c1", "c2"],
      );
      assert.strictEqual(detail.description, "");
      assert.strictEqual(detail.milestoneProgress, 0.5);
      assert.strictEqual(detail.subIssues.length, 1);
      assert.isFalse(detail.subIssuesFailed);
    }),
  );

  it.effect("keeps the issue detail when its comments or sub-issues fail", () =>
    Effect.gen(function* () {
      const { http } = makeHttp((call) =>
        call.body.query.includes("IssueDetail")
          ? json({
              data: { issue: { ...issueNode(3), description: "Body", comments: null } },
              errors: [{ message: "comments failed", path: ["issue", "comments"] }],
            })
          : new Response("down", { status: 503 }),
      );
      const detail = yield* (yield* tracker(http)).issueDetail("ATT-3");
      assert.strictEqual(detail.description, "Body");
      assert.deepStrictEqual(detail.comments, []);
      assert.deepStrictEqual(detail.subIssues, []);
      assert.isTrue(detail.subIssuesFailed);
    }),
  );

  it.effect("reports an unreadable response as Unavailable", () =>
    Effect.gen(function* () {
      const { http } = makeHttp(() => json({ data: { viewer: {} } }));
      const error = yield* Effect.flip((yield* tracker(http)).verify);
      assert.strictEqual(error._tag, "IssueTrackerUnavailable");
    }),
  );
});

describe("Linear issue filters", () => {
  it("hides completed work by default and ANDs conditions", () => {
    assert.deepStrictEqual(buildIssueFilter({ teamId: "t", assignee: "me" }), {
      and: [
        { team: { id: { eq: "t" } } },
        { assignee: { isMe: { eq: true } } },
        { state: { type: { nin: ["completed", "canceled"] } } },
      ],
    });
  });

  it("does not hide completed when requested or when states are chosen", () => {
    assert.deepStrictEqual(buildIssueFilter({ includeCompleted: true }), {});
    assert.deepStrictEqual(buildIssueFilter({ stateTypes: ["completed"] }), {
      and: [{ state: { type: { in: ["completed"] } } }],
    });
  });

  it("maps milestone none, labels, cycle, priority, text and ids", () => {
    const filter = buildIssueFilter({
      milestoneId: "none",
      labelIds: ["a"],
      cycleId: "c",
      priorities: [1, 2],
      text: " fix ",
      issueIds: ["x"],
      includeCompleted: true,
    });
    assert.deepStrictEqual(filter, {
      and: [
        { projectMilestone: { null: true } },
        { priority: { in: [1, 2] } },
        { labels: { some: { id: { in: ["a"] } } } },
        { cycle: { id: { eq: "c" } } },
        { title: { containsIgnoreCase: "fix" } },
        { id: { in: ["x"] } },
      ],
    });
  });

  it("normalizes array order so equal filters share a cache key", () => {
    assert.deepStrictEqual(
      normalizeIssueFilter({ labelIds: ["b", "a", "a"], priorities: [3, 1] }),
      normalizeIssueFilter({ labelIds: ["a", "b"], priorities: [1, 3] }),
    );
  });
});
