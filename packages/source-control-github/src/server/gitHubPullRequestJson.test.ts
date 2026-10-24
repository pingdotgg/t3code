import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildReviewSubmission,
  buildReviewerRequest,
  pullRequestLookup,
  toPullRequestWatchFingerprint,
  decodePullRequestDetailJson,
  decodePullRequestFilesJson,
  decodePullRequestStacksJson,
  LenientPullRequestList,
  reviewThreadConversation,
  toLabelCandidates,
  toPullRequestActivityPage,
  toPullRequestCore,
  toPullRequestFilesViewedPage,
  toPullRequestRows,
  toReviewerCandidates,
  toReviewThreadCommentsPage,
  toCanWrite,
  toReviewThreadPage,
  toViewerPermissions,
} from "./gitHubPullRequestJson.ts";
import { PullRequestWatchFingerprint } from "./pullRequestBatches.graphql.ts";
import {
  LabelCandidates,
  PullRequestActivity,
  PullRequestCore,
  PullRequestFilesViewed,
  ReviewerCandidates,
  ViewerPermissions,
} from "./pullRequestReads.graphql.ts";
import { ReviewThreadComments, ReviewThreads } from "./pullRequestReviews.graphql.ts";

/**
 * A GitHub answer (`{ data }` as JSON) through a generated operation's result schema and then its
 * mapping, the way the client decodes and the API maps. A mapping's null (nothing found) fails.
 */
const through =
  <S extends Schema.Codec<unknown, unknown>, A>(schema: S, map: (result: S["Type"]) => A | null) =>
  (raw: string): Result.Result<A, unknown> => {
    const decoded = Schema.decodeUnknownResult(schema)(
      (JSON.parse(raw) as { readonly data: unknown }).data,
    );
    if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
    const mapped = map(decoded.success);
    return mapped === null ? Result.fail("not found") : Result.succeed(mapped);
  };

/** An account as a selection with `__typename` answers it: GitHub always sends the type. */
const user = (login: string, fields: Record<string, unknown> = {}) => ({
  __typename: "User",
  login,
  ...fields,
});

/** A listing row with every field the row selection asks for, as GitHub always answers it. */
const row = (fields: Record<string, unknown>) => ({
  number: 1,
  title: "Add the pull requests page",
  url: "https://github.com/pingdotgg/t3code/pull/1",
  author: null,
  headRefName: "feat/page",
  baseRefName: "main",
  state: "OPEN",
  isDraft: false,
  mergeable: "UNKNOWN",
  reviewDecision: null,
  latestReviews: { nodes: [] },
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-02T00:00:00Z",
  mergedAt: null,
  repository: { nameWithOwner: "pingdotgg/t3code" },
  reviewRequests: { nodes: [] },
  labels: { nodes: [] },
  commits: { nodes: [] },
  ...fields,
});

const listPage = (page: ReturnType<typeof toPullRequestRows>) => ({
  items: page.rows.map((row) => ({
    ...row.item,
    ...(row.repository === null ? {} : { repository: row.repository }),
  })),
  rawCount: page.rawCount,
});
const decodePullRequestListJson = through(LenientPullRequestList.result, (result) =>
  listPage(toPullRequestRows(result.repository?.pullRequests)),
);
const decodePullRequestActivityJson = through(
  PullRequestActivity.result,
  toPullRequestActivityPage,
);
const decodePullRequestCoreJson = through(PullRequestCore.result, toPullRequestCore);
/**
 * Fills in what every review read answers with, so each fixture below says only what it is about:
 * a page with no more after it, an actor typed as a person, no reactions, no edits.
 */
// Fixtures are loose JSON on purpose: each one writes only the fields its test is about.
type Json = Record<string, any>;
const LAST_PAGE = { hasNextPage: false, endCursor: null };
const nodesIn = (connection: Json | null | undefined): ReadonlyArray<Json> =>
  connection?.["nodes"] ?? [];
const actor = (raw: Json | null | undefined) =>
  raw === null || raw === undefined ? null : { __typename: "User", avatarUrl: "", ...raw };
const reactionGroups = (groups: ReadonlyArray<Json> | undefined) =>
  (groups ?? []).map(({ reactors, ...group }) => ({
    viewerHasReacted: false,
    ...group,
    reactors: {
      totalCount: 0,
      ...reactors,
      nodes: nodesIn(reactors).map((node) => ({ __typename: "User", ...node })),
    },
  }));
const remark = ({ author, reactionGroups: groups, ...raw }: Json) => ({
  body: "",
  lastEditedAt: null,
  url: "https://github.com/acme/web/pull/1#discussion",
  ...raw,
  author: actor(author),
  reactionGroups: reactionGroups(groups),
});
const threadCommentsOf = ({ nodes, ...connection }: Json) => ({
  totalCount: (nodes ?? []).length,
  pageInfo: LAST_PAGE,
  ...connection,
  nodes: (nodes ?? []).map(remark),
});
const requestedReviewer = (raw: Json | null) =>
  raw === null
    ? null
    : "login" in raw
      ? { name: null, ...actor(raw) }
      : { __typename: "Team", ...raw };
const reviewCommit = ({ commit: { authors, ...commit } }: Json) => ({
  commit: {
    messageHeadline: "",
    committedDate: "",
    additions: 0,
    deletions: 0,
    parents: { totalCount: 1 },
    ...commit,
    authors: {
      nodes: nodesIn(authors).map((author) => ({
        name: null,
        avatarUrl: "",
        user: null,
        ...author,
      })),
    },
  },
});
const withReviewDefaults = (raw: string): string => {
  const { data } = JSON.parse(raw) as { data: Json };
  const pr = data["repository"]?.["pullRequest"];
  if (pr?.["reviewThreads"] !== undefined) {
    const {
      reviewThreads,
      author,
      reactionGroups: groups,
      comments,
      reviews,
      reviewRequests,
      latestReviews,
      commits,
      ...rest
    } = pr;
    data["repository"]["pullRequest"] = {
      viewerCanUpdate: true,
      viewerDidAuthor: false,
      reviewDismissals: { pageInfo: LAST_PAGE, nodes: [] },
      ...rest,
      author: actor(author),
      reactionGroups: reactionGroups(groups),
      comments: { nodes: nodesIn(comments).map(remark) },
      reviews: { nodes: nodesIn(reviews).map(remark) },
      reviewRequests: {
        nodes: nodesIn(reviewRequests).map((node) => ({
          requestedReviewer: requestedReviewer(node["requestedReviewer"]),
        })),
      },
      latestReviews: {
        nodes: nodesIn(latestReviews).map((node) => ({
          state: "COMMENTED",
          ...node,
          author: actor(node["author"]),
        })),
      },
      commits: { nodes: nodesIn(commits).map(reviewCommit) },
      reviewThreads: {
        totalCount: nodesIn(reviewThreads).length,
        pageInfo: LAST_PAGE,
        ...reviewThreads,
        nodes: nodesIn(reviewThreads).map((thread) => ({
          isResolved: false,
          isOutdated: false,
          line: null,
          diffSide: "RIGHT",
          ...thread,
          comments: threadCommentsOf(thread["comments"]),
        })),
      },
    };
  }
  if (data["node"] !== undefined && data["node"] !== null) {
    data["node"] = {
      __typename: "PullRequestReviewThread",
      ...data["node"],
      comments: threadCommentsOf(data["node"]["comments"]),
    };
  }
  data["viewer"] ??= { login: "viewer" };
  return JSON.stringify({ data });
};
const decodeReviewThreadsJson = (raw: string) =>
  through(ReviewThreads.result, toReviewThreadPage)(withReviewDefaults(raw));
const decodeReviewThreadCommentsJson = (raw: string) =>
  through(ReviewThreadComments.result, toReviewThreadCommentsPage)(withReviewDefaults(raw));
const decodeViewerPermissionsJson = through(ViewerPermissions.result, toViewerPermissions);
const decodeLabelCandidatesJson = through(LabelCandidates.result, toLabelCandidates);
const decodeReviewerCandidatesJson = through(ReviewerCandidates.result, toReviewerCandidates);
const decodePullRequestFilesViewedJson = through(
  PullRequestFilesViewed.result,
  toPullRequestFilesViewedPage,
);

function listJson(entries: ReadonlyArray<Record<string, unknown>>): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: entries.map(({ reviewRequests, latestReviews, checks, ...entry }) =>
            row({
              ...(reviewRequests === undefined
                ? {}
                : {
                    reviewRequests: {
                      nodes: (reviewRequests as ReadonlyArray<unknown>).map(
                        (requestedReviewer) => ({
                          requestedReviewer,
                        }),
                      ),
                    },
                  }),
              ...(latestReviews === undefined ? {} : { latestReviews: { nodes: latestReviews } }),
              ...(checks === undefined
                ? {}
                : { commits: { nodes: [{ commit: { statusCheckRollup: { state: checks } } }] } }),
              ...entry,
            }),
          ),
        },
      },
    },
  });
}

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("pull request list decoding", () => {
  it("treats a merge timestamp as merged even when the state still says closed", () => {
    const [entry] = expectSuccess(
      decodePullRequestListJson(listJson([{ state: "CLOSED", mergedAt: "2026-07-03T00:00:00Z" }])),
    ).items;
    expect(entry?.state).toBe("merged");
  });

  it("takes the verdict from the latest reviews when GitHub summarizes none, as for a bot's approval", () => {
    const batch = expectSuccess(
      decodePullRequestListJson(
        listJson([
          {
            reviewDecision: null,
            latestReviews: [{ author: user("macroscopeapp"), state: "APPROVED" }],
          },
          {
            reviewDecision: "REVIEW_REQUIRED",
            latestReviews: [
              { author: user("octocat"), state: "APPROVED" },
              { author: user("hubot"), state: "CHANGES_REQUESTED" },
            ],
          },
          {
            reviewDecision: "APPROVED",
            latestReviews: [{ author: user("hubot"), state: "CHANGES_REQUESTED" }],
          },
          {
            reviewDecision: null,
            latestReviews: [{ author: user("octocat"), state: "COMMENTED" }],
          },
        ]),
      ),
    );
    expect(batch.items.map((entry) => entry.reviewDecision)).toEqual([
      "approved",
      "changes-requested",
      "approved",
      null,
    ]);
  });

  it("skips malformed entries but still counts them, so paging does not stop early", () => {
    const batch = expectSuccess(
      decodePullRequestListJson(listJson([{}, { number: "not-a-number" }])),
    );
    expect(batch.items).toHaveLength(1);
    expect(batch.rawCount).toBe(2);
  });
});

describe("pull request detail decoding", () => {
  /** A check run or commit status as the core read's `CheckContext` fragment answers it. */
  const check = (fields: Record<string, unknown>) =>
    fields["__typename"] === "StatusContext"
      ? {
          context: "",
          state: "PENDING",
          targetUrl: null,
          createdAt: "2026-07-01T00:00:00Z",
          description: null,
          ...fields,
        }
      : {
          __typename: "CheckRun",
          name: "",
          status: "COMPLETED",
          conclusion: null,
          startedAt: null,
          completedAt: null,
          detailsUrl: null,
          checkSuite: { workflowRun: null },
          ...fields,
        };
  /** A check run owned by a workflow, which is how the core read names the workflow. */
  const inWorkflow = ({ workflowName, ...fields }: Record<string, unknown>) =>
    check({
      ...fields,
      checkSuite: { workflowRun: { workflow: { name: workflowName } } },
    });

  /** The core read's answer for pull request 7, with `rollup` as its head commit's checks. */
  const coreJson = (
    rollup: ReadonlyArray<Record<string, unknown>>,
    pullRequest: Record<string, unknown> = {},
  ) =>
    JSON.stringify({
      data: {
        repository: {
          mergeCommitAllowed: true,
          squashMergeAllowed: true,
          rebaseMergeAllowed: true,
          autoMergeAllowed: true,
          viewerPermission: "WRITE",
          pullRequest: {
            number: 7,
            title: "Detail",
            url: "https://github.com/pingdotgg/t3code/pull/7",
            body: "Body",
            state: "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "BLOCKED",
            reviewDecision: null,
            additions: 0,
            deletions: 0,
            changedFiles: 0,
            createdAt: "2026-07-01T00:00:00Z",
            updatedAt: "2026-07-05T00:00:00Z",
            mergedAt: null,
            closedAt: null,
            headRefName: "feat/detail",
            baseRefName: "main",
            headRefOid: "abc123",
            isCrossRepository: false,
            headRepositoryOwner: null,
            headRepository: null,
            headRef: null,
            author: null,
            autoMergeRequest: null,
            viewerCanUpdate: true,
            viewerDidAuthor: false,
            viewerCanUpdateBranch: false,
            baseRef: null,
            reviewRequests: { nodes: [] },
            labels: { nodes: [] },
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: { nodes: rollup, pageInfo: { hasNextPage: false } },
                    },
                  },
                },
              ],
            },
            ...pullRequest,
          },
        },
      },
    });
  const detailOf = (
    rollup: ReadonlyArray<Record<string, unknown>>,
    pullRequest?: Record<string, unknown>,
  ) => expectSuccess(decodePullRequestCoreJson(coreJson(rollup, pullRequest)));

  /** The conversation the activity read carries, in the flat shape the tests below write. */
  const detailJson = JSON.stringify({
    comments: [{ id: "c1", body: "second", createdAt: "2026-07-04T00:00:00Z" }],
    reviews: [
      { id: "r1", body: "first", state: "CHANGES_REQUESTED", submittedAt: "2026-07-03T00:00:00Z" },
      { id: "r2", body: "   ", state: "APPROVED", submittedAt: "2026-07-06T00:00:00Z" },
    ],
    commits: [
      {
        oid: "abc1234",
        messageHeadline: "Ship the timeline",
        committedDate: "2026-07-05T00:00:00Z",
        authors: [
          { login: "octocat", name: "Octo Cat", email: "octo@example.com" },
          { name: "Pair Author", email: "pair@example.com" },
        ],
      },
    ],
  });

  const activityJson = (raw: Record<string, unknown>) =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            author: null,
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: ((raw["comments"] ?? []) as ReadonlyArray<Record<string, unknown>>).map(
                (comment) => ({
                  lastEditedAt: null,
                  url: "https://github.com/c",
                  author: null,
                  ...comment,
                }),
              ),
            },
            reviews: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: ((raw["reviews"] ?? []) as ReadonlyArray<Record<string, unknown>>).map(
                (review) => ({
                  lastEditedAt: null,
                  url: "https://github.com/r",
                  author: null,
                  submittedAt: null,
                  ...review,
                }),
              ),
            },
            commits: {
              nodes: ((raw["commits"] ?? []) as ReadonlyArray<Record<string, unknown>>).map(
                ({ authors, ...commit }) => ({
                  commit: {
                    ...commit,
                    authors: {
                      nodes: ((authors ?? []) as ReadonlyArray<Record<string, unknown>>).map(
                        ({ login, ...author }) => ({
                          name: null,
                          email: null,
                          ...author,
                          user: login === undefined ? null : { login },
                        }),
                      ),
                    },
                  },
                }),
              ),
            },
          },
        },
      },
    });
  const activity = (raw: Record<string, unknown>) =>
    Result.map(decodePullRequestActivityJson(activityJson(raw)), (page) => ({
      comments: page.remarks.toSorted((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
      commits: page.commits ?? [],
    }));

  it("keeps a workflow waiting for approval out of the passing state", () => {
    const detail = detailOf([
      check({ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }),
      check({ name: "contributor tests", status: "COMPLETED", conclusion: "ACTION_REQUIRED" }),
    ]);

    expect(detail.checks.map((check) => check.status)).toEqual(["success", "action-required"]);
    expect(detail.checksState).toBe("pending");
  });

  it("reads an auto-merge request and strategy, its null as off and its absence as neither", () => {
    expect(detailOf([], { autoMergeRequest: { mergeMethod: "SQUASH" } })).toMatchObject({
      autoMergeEnabled: true,
      autoMergeMethod: "squash",
    });
    expect(detailOf([], { autoMergeRequest: null }).autoMergeEnabled).toBe(false);
    // A detail read that never asked about auto-merge does not claim it is unarmed.
    expect(
      expectSuccess(
        decodePullRequestDetailJson(
          JSON.stringify({
            number: 7,
            title: "Detail",
            url: "https://github.com/pingdotgg/t3code/pull/7",
            headRefName: "feat/detail",
            baseRefName: "main",
            createdAt: "2026-07-01T00:00:00Z",
            updatedAt: "2026-07-05T00:00:00Z",
          }),
        ),
      ).autoMergeEnabled,
    ).toBeUndefined();
  });

  it("shows a re-running check once, as the run that is happening now", () => {
    // What `statusCheckRollup` reports while a workflow is being re-run: the same check twice,
    // the finished run and the one that replaced it, with no id to tell them apart.
    const detail = detailOf([
      inWorkflow({
        name: "Prepare PR size config",
        workflowName: "PR Size",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        startedAt: "2026-08-11T16:06:20Z",
        completedAt: "2026-08-11T16:06:25Z",
      }),
      inWorkflow({
        name: "Prepare PR size config",
        workflowName: "PR Size",
        status: "IN_PROGRESS",
        conclusion: null,
        startedAt: "2026-08-11T17:01:04Z",
        completedAt: "0001-01-01T00:00:00Z",
      }),
    ]);

    expect(detail.checks.map((check) => [check.name, check.status])).toEqual([
      ["Prepare PR size config", "pending"],
    ]);
    expect(detail.checksState).toBe("pending");
  });

  it("keeps a check pending while another run of it on the same commit is still going", () => {
    // A workflow on both `push` and `pull_request` runs the same check twice on one commit. The
    // `pull_request` run finished after the `push` run started, and the `push` run is still going.
    const finished = {
      name: "check",
      workflowName: "Checks",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-10-08T04:06:10Z",
      completedAt: "2026-10-08T04:18:58Z",
    };
    const running = {
      ...finished,
      status: "IN_PROGRESS",
      conclusion: null,
      startedAt: "2026-10-08T04:06:13Z",
      completedAt: "0001-01-01T00:00:00Z",
    };
    const queued = { ...running, status: "QUEUED", startedAt: "0001-01-01T00:00:00Z" };
    const checksOf = (rollup: ReadonlyArray<Record<string, unknown>>) => {
      const detail = detailOf(rollup.map(inWorkflow));
      return [detail.checks.map((check) => [check.name, check.status]), detail.checksState];
    };

    for (const rollup of [
      [finished, running],
      [running, finished],
      [finished, queued],
      [queued, finished],
    ]) {
      expect(checksOf(rollup)).toEqual([[["check", "pending"]], "pending"]);
    }
  });

  it("merges reviews with comments in time order and keeps a bodyless approval", () => {
    const detail = expectSuccess(activity(JSON.parse(detailJson) as Record<string, unknown>));
    expect(detail.comments.map((comment) => comment.id)).toEqual(["r1", "c1", "r2"]);
    expect(detail.comments.at(-1)?.reviewState).toBe("APPROVED");
  });

  it("drops the bodyless review GitHub opens to hold line comments", () => {
    const raw = JSON.parse(detailJson) as Record<string, unknown>;
    const detail = expectSuccess(
      activity({
        ...raw,
        reviews: [
          { id: "r4", body: "", state: "COMMENTED", submittedAt: "2026-07-07T00:00:00Z" },
          {
            id: "r5",
            body: "Looks good.",
            state: "COMMENTED",
            submittedAt: "2026-07-08T00:00:00Z",
          },
        ],
      }),
    );

    expect(detail.comments.map((comment) => comment.id)).toEqual(["c1", "r5"]);
  });

  it.each(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"])(
    "keeps a bodyless %s review, which is the event itself",
    (state) => {
      const raw = JSON.parse(detailJson) as Record<string, unknown>;
      const detail = expectSuccess(
        activity({
          ...raw,
          reviews: [{ id: "r6", body: "", state, submittedAt: "2026-07-07T00:00:00Z" }],
        }),
      );

      expect(detail.comments.map((comment) => comment.id)).toContain("r6");
    },
  );
});

describe("review thread decoding", () => {
  const threadsJson = (
    nodes: ReadonlyArray<Record<string, unknown>>,
    totalCount = nodes.length,
    pageInfo: Record<string, unknown> = { hasNextPage: false, endCursor: null },
  ): string =>
    JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { totalCount, pageInfo, nodes } } } },
    });

  const reviewJson = (input: {
    readonly requested?: ReadonlyArray<unknown>;
    readonly reviewed?: ReadonlyArray<unknown>;
  }): string =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { totalCount: 0, nodes: [] },
            reviewRequests: {
              nodes: (input.requested ?? []).map((r) => ({ requestedReviewer: r })),
            },
            latestReviews: { nodes: (input.reviewed ?? []).map((a) => ({ author: a })) },
          },
        },
      },
    });

  it("omits misleading line counts from merge commits", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { totalCount: 0, nodes: [] },
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: "merge123",
                        additions: 36_858,
                        deletions: 12_928,
                        parents: { totalCount: 2 },
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      ),
    );

    expect([...result.commitStats]).toEqual([]);
  });

  it("decodes the newest commits off the same connection, oldest to newest", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { totalCount: 0, nodes: [] },
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: "abc123",
                        messageHeadline: "Ship the timeline",
                        committedDate: "2026-07-05T00:00:00Z",
                        additions: 18,
                        deletions: 7,
                        authors: { nodes: [{ name: "Julius", user: { login: "julius" } }] },
                      },
                    },
                    {
                      commit: {
                        oid: "def456",
                        messageHeadline: "Fix the flaky test",
                        committedDate: "2026-07-06T00:00:00Z",
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      ),
    );

    expect(result.commits).toEqual([
      {
        oid: "abc123",
        messageHeadline: "Ship the timeline",
        committedDate: "2026-07-05T00:00:00Z",
        authors: [{ login: "julius", name: "Julius", avatarUrl: null }],
      },
      {
        oid: "def456",
        messageHeadline: "Fix the flaky test",
        committedDate: "2026-07-06T00:00:00Z",
        authors: [],
      },
    ]);
  });

  it("lists someone who was asked and then answered only once", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        reviewJson({
          requested: [{ login: "julius", avatarUrl: "https://avatars/j.png" }],
          reviewed: [{ login: "julius", avatarUrl: "https://avatars/j.png" }],
        }),
      ),
    );

    expect(result.reviewers).toHaveLength(1);
  });

  it("lists a requested team by org/slug, apart from a user who shares its slug", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        reviewJson({
          requested: [
            {
              combinedSlug: "pingdotgg/ping-devs",
              teamName: "Ping Devs",
              teamAvatarUrl: "https://avatars.githubusercontent.com/t/6692390?s=400&v=4",
            },
          ],
          reviewed: [
            { __typename: "User", login: "ping-devs", avatarUrl: "https://avatars/u.png" },
          ],
        }),
      ),
    );

    expect(result.reviewers).toEqual([
      {
        login: "pingdotgg/ping-devs",
        name: "Ping Devs",
        avatarUrl: "https://avatars.githubusercontent.com/t/6692390?s=400&v=4",
      },
      { login: "ping-devs", name: null, avatarUrl: "https://avatars/u.png" },
    ]);
  });

  it("keeps the conversation when a reviewer has neither a login nor a team slug", () => {
    // GraphQL answers with an empty object for a union member the query has no fragment for,
    // such as a mannequin. Failing on it would take the whole response down, comments included.
    const result = expectSuccess(
      decodeReviewThreadsJson(
        reviewJson({
          requested: [
            { __typename: "Mannequin" },
            { login: "julius", avatarUrl: "https://avatars/j.png" },
          ],
        }),
      ),
    );

    expect(result.reviewers).toEqual([
      { login: "julius", name: null, avatarUrl: "https://avatars/j.png" },
    ]);
  });

  it("carries a resolved thread into the conversation, which was still said", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        threadsJson([
          {
            id: "PRRT_a",
            isResolved: false,
            path: "apps/server/src/ws.ts",
            comments: {
              nodes: [{ id: "t1", body: "fix this", createdAt: "2026-07-01T00:00:00Z" }],
            },
          },
          {
            id: "PRRT_b",
            isResolved: true,
            path: "apps/web/src/main.tsx",
            comments: { nodes: [{ id: "t2", body: "done", createdAt: "2026-07-01T00:00:00Z" }] },
          },
        ]),
      ),
    );
    const comments = reviewThreadConversation(result.threads.map((entry) => entry.thread));
    expect(comments.map((comment) => comment.id)).toEqual(["t1", "t2"]);
    expect(comments[0]).toMatchObject({
      id: "t1",
      kind: "review-comment",
      path: "apps/server/src/ws.ts",
    });
  });

  it("carries every reply, not only the remark each thread opened with", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        threadsJson([
          {
            id: "PRRT_c",
            isResolved: false,
            path: "apps/server/src/ws.ts",
            comments: {
              nodes: [
                { id: "t1", body: "fix this", createdAt: "2026-07-01T00:00:00Z" },
                { id: "t2", body: "fixed", createdAt: "2026-07-01T01:00:00Z" },
              ],
            },
          },
        ]),
      ),
    );
    const comments = reviewThreadConversation(result.threads.map((entry) => entry.thread));
    expect(comments.map((comment) => comment.id)).toEqual(["t1", "t2"]);
  });

  it("keeps GitHub's own count of a thread whose comments were not all read", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        threadsJson([
          {
            id: "PRRT_e",
            path: "apps/server/src/ws.ts",
            isResolved: false,
            comments: {
              totalCount: 140,
              pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29yOjI" },
              nodes: [{ id: "t1", createdAt: "2026-07-01T00:00:00Z" }],
            },
          },
        ]),
      ),
    );
    expect(result.threads[0]).toMatchObject({
      commentCount: 140,
      nextCommentCursor: "Y3Vyc29yOjI",
    });
  });

  it("ends a thread's walk on the last page, which still names a cursor", () => {
    const decoded = expectSuccess(
      decodeReviewThreadCommentsJson(
        JSON.stringify({
          data: {
            repository: { pullRequest: { id: "PR_1" } },
            node: {
              pullRequest: { id: "PR_1" },
              comments: {
                pageInfo: { hasNextPage: false, endCursor: "Y3Vyc29yOjk" },
                nodes: [{ id: "t9", body: "last", createdAt: "2026-07-01T00:00:00Z" }],
              },
            },
          },
        }),
      ),
    );
    expect(decoded.comments.map((comment) => comment.id)).toEqual(["t9"]);
    expect(decoded.nextCursor).toBeNull();
  });
});

describe("reaction decoding", () => {
  const commentWithGroups = (reactionGroups: ReadonlyArray<Record<string, unknown>>) =>
    JSON.stringify({
      data: {
        repository: { pullRequest: { id: "PR_1" } },
        node: {
          pullRequest: { id: "PR_1" },
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "t1", body: "nice", createdAt: "2026-07-01T00:00:00Z", reactionGroups }],
          },
        },
      },
    });

  it("keeps a named group, widens a group whose reactors were cut short, drops an unknown content and an empty group", () => {
    const decoded = expectSuccess(
      decodeReviewThreadCommentsJson(
        commentWithGroups([
          {
            content: "THUMBS_UP",
            viewerHasReacted: true,
            reactors: { totalCount: 2, nodes: [{ login: "julius" }, { login: "bilal" }] },
          },
          {
            content: "PARTY_PARROT",
            reactors: { totalCount: 1, nodes: [{ login: "hubot" }] },
          },
          { content: "HEART", reactors: { totalCount: 0, nodes: [] } },
          {
            content: "ROCKET",
            reactors: { totalCount: 140, nodes: [{ login: "a" }, { login: "b" }, { login: "c" }] },
          },
        ]),
      ),
    );

    expect(decoded.comments[0]?.reactions).toEqual([
      { content: "thumbs-up", count: 2, actors: ["julius", "bilal"], viewerHasReacted: true },
      { content: "rocket", count: 140, actors: ["a", "b", "c"], viewerHasReacted: false },
    ]);
  });
});

describe("repository access decoding", () => {
  const repositoryJson = (viewerPermission?: string | null) =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: null,
          mergeCommitAllowed: true,
          squashMergeAllowed: false,
          rebaseMergeAllowed: true,
          autoMergeAllowed: true,
          viewerPermission: viewerPermission ?? null,
        },
      },
    });

  it("fails rather than defaulting open when a setting is missing", () => {
    const decoded = decodeViewerPermissionsJson(
      JSON.stringify({ data: { repository: { pullRequest: null, mergeCommitAllowed: true } } }),
    );
    expect(Result.isSuccess(decoded)).toBe(false);
  });

  it("counts the roles that can push as write, and the ones that cannot as read", () => {
    for (const permission of ["ADMIN", "MAINTAIN", "WRITE"]) {
      expect(expectSuccess(decodeViewerPermissionsJson(repositoryJson(permission))).canWrite).toBe(
        true,
      );
    }
    for (const permission of ["TRIAGE", "READ", "NONE"]) {
      expect(expectSuccess(decodeViewerPermissionsJson(repositoryJson(permission))).canWrite).toBe(
        false,
      );
    }
  });

  it("withholds write where gh names no permission, which is not a standing it gave", () => {
    // The one place an unknown answer is not granted: a Merge button a reader cannot use wastes
    // the press, where a missing one still leaves the pull request open on its host.
    expect(toCanWrite(undefined)).toBe(false);
  });

  it("grants write and triage to a GitHub App, which GitHub answers with a null permission", () => {
    const access = expectSuccess(decodeViewerPermissionsJson(repositoryJson(null)));
    expect(access.canWrite).toBe(true);
    expect(access.canTriage).toBe(true);
  });
});

describe("viewer permission decoding", () => {
  const viewerJson = (repository: Record<string, unknown>) =>
    JSON.stringify({
      data: {
        repository: {
          mergeCommitAllowed: true,
          squashMergeAllowed: false,
          rebaseMergeAllowed: true,
          autoMergeAllowed: true,
          ...repository,
        },
      },
    });

  it("says no to a passer-by on a repository they can only read", () => {
    expect(
      expectSuccess(
        decodeViewerPermissionsJson(
          viewerJson({
            viewerPermission: "READ",
            pullRequest: { viewerCanUpdate: false, viewerDidAuthor: false, headRepository: null },
          }),
        ),
      ),
    ).toEqual({
      mergeCapabilities: { merge: true, squash: false, rebase: true },
      autoMergeAllowed: true,
      canWrite: false,
      canTriage: false,
      canUpdate: false,
      didAuthor: false,
      canDeleteBranch: false,
    });
  });

  it("reads silence as permission, but not as authorship", () => {
    // A node the viewer cannot see comes back null. Updating is a permission, so an unknown
    // answer grants it and lets the host refuse; authorship is a fact about who wrote the change,
    // and claiming it for someone who did not is how an author's own rules get handed out.
    expect(
      expectSuccess(
        decodeViewerPermissionsJson(viewerJson({ viewerPermission: "READ", pullRequest: null })),
      ),
    ).toEqual({
      mergeCapabilities: { merge: true, squash: false, rebase: true },
      autoMergeAllowed: true,
      canWrite: false,
      canTriage: false,
      canUpdate: true,
      didAuthor: false,
      canDeleteBranch: false,
    });
  });
});

describe("label candidate decoding", () => {
  const labelsJson = (input: {
    readonly defined: ReadonlyArray<Record<string, unknown>>;
    readonly applied?: ReadonlyArray<string>;
    readonly hasNextPage?: boolean;
  }) =>
    JSON.stringify({
      data: {
        repository: {
          labels: {
            pageInfo: { hasNextPage: input.hasNextPage ?? false },
            nodes: input.defined,
          },
          pullRequest: { labels: { nodes: (input.applied ?? []).map((name) => ({ name })) } },
        },
      },
    });

  it("keeps a worn label the repository no longer defines, so it can be taken off", () => {
    const list = expectSuccess(
      decodeLabelCandidatesJson(
        labelsJson({
          defined: [{ name: "bug", color: "d73a4a", description: null }],
          applied: ["legacy"],
        }),
      ),
    );
    expect(list.candidates.map((label) => [label.name, label.isApplied])).toEqual([
      ["legacy", true],
      ["bug", false],
    ]);
  });
});

describe("review thread decoding", () => {
  const threadsJson = (
    nodes: ReadonlyArray<Record<string, unknown>>,
    pullRequest: Record<string, unknown> = {},
  ) =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { totalCount: nodes.length, nodes },
            author: null,
            comments: { nodes: [] },
            reviewRequests: { nodes: [] },
            latestReviews: { nodes: [] },
            ...pullRequest,
          },
        },
      },
    });

  it("carries what the reader may do with the pull request, off the conversation read", () => {
    expect(
      expectSuccess(
        decodeReviewThreadsJson(
          threadsJson([], { viewerCanUpdate: false, viewerDidAuthor: false }),
        ),
      ).viewer,
    ).toEqual({ canUpdate: false, didAuthor: false });
    expect(expectSuccess(decodeReviewThreadsJson(threadsJson([]))).viewer).toEqual({
      canUpdate: true,
      didAuthor: false,
    });
  });

  const comment = (id: string, body: string) => ({
    id,
    author: { login: "bilal", avatarUrl: "https://avatars/b.png" },
    body,
    createdAt: "2026-07-01T00:00:00Z",
    url: `https://github.com/acme/web/pull/1#discussion_r${id}`,
  });

  it("anchors a thread to its line and side, keeping the whole conversation", () => {
    const reviewThreads = expectSuccess(
      decodeReviewThreadsJson(
        threadsJson([
          {
            id: "PRRT_1",
            isResolved: false,
            isOutdated: false,
            path: "src/a.ts",
            line: 42,
            diffSide: "LEFT",
            comments: {
              totalCount: 2,
              nodes: [
                { ...comment("c1", "first"), lastEditedAt: "2026-07-02T00:00:00Z" },
                comment("c2", "second"),
              ],
            },
          },
        ]),
      ),
    );
    expect(reviewThreads.threads.map((entry) => entry.thread)).toEqual([
      {
        id: "PRRT_1",
        path: "src/a.ts",
        line: 42,
        side: "left",
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            id: "c1",
            author: { login: "bilal", name: null, avatarUrl: "https://avatars/b.png" },
            body: "first",
            createdAt: "2026-07-01T00:00:00Z",
            editedAt: "2026-07-02T00:00:00Z",
            url: "https://github.com/acme/web/pull/1#discussion_rc1",
            reactions: [],
          },
          {
            id: "c2",
            author: { login: "bilal", name: null, avatarUrl: "https://avatars/b.png" },
            body: "second",
            createdAt: "2026-07-01T00:00:00Z",
            editedAt: null,
            url: "https://github.com/acme/web/pull/1#discussion_rc2",
            reactions: [],
          },
        ],
      },
    ]);
    expect(
      reviewThreadConversation(reviewThreads.threads.map((entry) => entry.thread))[0]?.editedAt,
    ).toBe("2026-07-02T00:00:00Z");
  });

  it("leaves an outdated thread without a line rather than pinning it to a stale one", () => {
    const reviewThreads = expectSuccess(
      decodeReviewThreadsJson(
        threadsJson([
          {
            id: "PRRT_2",
            isResolved: true,
            isOutdated: true,
            path: "src/a.ts",
            line: null,
            diffSide: "RIGHT",
            comments: { totalCount: 1, nodes: [comment("c3", "stale")] },
          },
        ]),
      ),
    );
    expect(reviewThreads.threads[0]?.thread).toMatchObject({
      line: null,
      isOutdated: true,
      isResolved: true,
    });
  });

  it("reads edit times for issue comments and reviews without using reaction updates", () => {
    const editedAt = "2026-10-02T12:06:00Z";
    const result = expectSuccess(
      decodeReviewThreadsJson(
        threadsJson([], {
          comments: {
            nodes: [
              { id: "edited", lastEditedAt: editedAt },
              { id: "reaction-only", lastEditedAt: null, updatedAt: editedAt },
            ],
          },
          reviews: { nodes: [{ id: "review", lastEditedAt: editedAt }] },
        }),
      ),
    );
    expect([...result.editedAtById]).toEqual([
      ["edited", editedAt],
      ["review", editedAt],
    ]);
  });

  it("leaves the viewer's own login out of the pull request's own reactions, matched case-insensitively, while count still counts them", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        JSON.stringify({
          data: {
            viewer: { login: "Bilal" },
            repository: {
              pullRequest: {
                reviewThreads: { totalCount: 0, nodes: [] },
                reactionGroups: [
                  {
                    content: "HEART",
                    viewerHasReacted: true,
                    reactors: { totalCount: 2, nodes: [{ login: "bilal" }, { login: "julius" }] },
                  },
                ],
              },
            },
          },
        }),
      ),
    );

    expect(result.reactions).toEqual([
      { content: "heart", count: 2, actors: ["julius"], viewerHasReacted: true },
    ]);
  });
});

describe("ReviewThreads", () => {
  it("caps the initial query after the 104-point rate-limit regression", () => {
    const match = ReviewThreads.document.match(
      /reviewThreads\(first:(\d+)[\s\S]*?\.\.\.ThreadComment[\s\S]*$/u,
    );
    const comments = ReviewThreads.document.match(/comments\(first:(\d+)\)\{totalCount/u);

    expect(match).not.toBeNull();
    expect(comments).not.toBeNull();
    if (match === null || comments === null) throw new Error("expected review-thread connections");
    expect(Number(match[1]) * Number(comments[1])).toBeLessThanOrEqual(1_000);
  });
});

describe("reviewer candidate decoding", () => {
  const candidatesJson = (input: {
    readonly assignable: ReadonlyArray<Record<string, unknown> | null>;
    readonly requested?: ReadonlyArray<Record<string, unknown> | null>;
    readonly author?: string;
    readonly hasNextPage?: boolean;
  }) =>
    JSON.stringify({
      data: {
        repository: {
          assignableUsers: {
            pageInfo: { hasNextPage: input.hasNextPage ?? false },
            nodes: input.assignable.map((node) =>
              node === null ? null : { name: null, avatarUrl: "", ...node },
            ),
          },
          pullRequest: {
            author: input.author === undefined ? null : { __typename: "User", login: input.author },
            reviewRequests: {
              nodes: (input.requested ?? []).map((requestedReviewer) => ({
                requestedReviewer:
                  requestedReviewer === null
                    ? null
                    : "slug" in requestedReviewer
                      ? {
                          __typename: "Team",
                          teamAvatarUrl: null,
                          ...requestedReviewer,
                        }
                      : { __typename: "User", name: null, avatarUrl: "", ...requestedReviewer },
              })),
            },
          },
        },
      },
    });

  it("leaves the author out of the people their own pull request can be sent to", () => {
    const list = expectSuccess(
      decodeReviewerCandidatesJson(
        candidatesJson({
          assignable: [{ login: "bilal" }, { login: "octocat", name: "The Octocat" }],
          author: "bilal",
        }),
      ),
    );
    expect(list.candidates).toEqual([
      {
        id: "octocat",
        kind: "user",
        login: "octocat",
        name: "The Octocat",
        avatarUrl: null,
        isRequested: false,
      },
    ]);
    expect(list.truncated).toBe(false);
  });

  it("keeps a requested team apart from the people, so the request can be taken back", () => {
    const list = expectSuccess(
      decodeReviewerCandidatesJson(
        candidatesJson({
          assignable: [{ login: "octocat" }],
          requested: [{ slug: "reviewers", combinedSlug: "acme/reviewers", teamName: "Reviewers" }],
        }),
      ),
    );
    expect(list.candidates).toEqual([
      {
        id: "reviewers",
        kind: "team",
        login: "acme/reviewers",
        name: "Reviewers",
        avatarUrl: null,
        isRequested: true,
      },
      {
        id: "octocat",
        kind: "user",
        login: "octocat",
        name: null,
        avatarUrl: null,
        isRequested: false,
      },
    ]);
  });
});

describe("reviewer request payload", () => {
  it("sends people and teams in the two lists GitHub keeps them in", () => {
    expect(
      buildReviewerRequest([
        { id: "octocat", kind: "user" },
        { id: "reviewers", kind: "team" },
        { id: "hubot", kind: "user" },
      ]),
    ).toEqual({ reviewers: ["octocat", "hubot"], team_reviewers: ["reviewers"] });
  });

  it("sends both lists even where one of them is empty, which is what GitHub reads", () => {
    expect(buildReviewerRequest([{ id: "octocat", kind: "user" }])).toEqual({
      reviewers: ["octocat"],
      team_reviewers: [],
    });
  });
});

describe("review submission payload", () => {
  it("sends the verdict, the summary and every line comment in one body", () => {
    const payload = buildReviewSubmission({
      verdict: "request-changes",
      body: "Two things.",
      comments: [
        {
          path: "src/a.ts",
          position: { kind: "added", newLine: 12 },
          body: "rename this",
        },
        {
          path: "src/b.ts",
          position: { kind: "deleted", oldLine: 3 },
          body: "why remove?",
        },
      ],
    });
    expect(payload).toEqual({
      event: "REQUEST_CHANGES",
      body: "Two things.",
      comments: [
        { path: "src/a.ts", line: 12, side: "RIGHT", body: "rename this" },
        { path: "src/b.ts", line: 3, side: "LEFT", body: "why remove?" },
      ],
    });
  });

  it("sends a range from its first line, and a one-line range as one line", () => {
    const payload = buildReviewSubmission({
      verdict: "comment",
      body: "",
      comments: [
        {
          path: "src/a.ts",
          startPosition: { kind: "context", oldLine: 4, newLine: 5, side: "right" },
          position: { kind: "added", newLine: 9 },
          body: "this block",
        },
        {
          path: "src/b.ts",
          startPosition: { kind: "added", newLine: 2 },
          position: { kind: "added", newLine: 2 },
          body: "this line",
        },
      ],
    });
    expect(payload.comments).toEqual([
      {
        path: "src/a.ts",
        start_line: 5,
        start_side: "RIGHT",
        line: 9,
        side: "RIGHT",
        body: "this block",
      },
      { path: "src/b.ts", line: 2, side: "RIGHT", body: "this line" },
    ]);
  });
});

describe("decodePullRequestFilesJson", () => {
  it("quotes literal backslashes without interpreting them as escapes", () => {
    const result = expectSuccess(
      decodePullRequestFilesJson(
        JSON.stringify([
          {
            filename: String.raw`src\notes.ts`,
            status: "modified",
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ]),
      ),
    );

    expect(result.patch).toBe(
      [
        String.raw`diff --git "a/src\\notes.ts" "b/src\\notes.ts"`,
        String.raw`--- "a/src\\notes.ts"`,
        String.raw`+++ "b/src\\notes.ts"`,
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );
  });

  it("preserves spaces and literal backslashes in both rename paths", () => {
    const result = expectSuccess(
      decodePullRequestFilesJson(
        JSON.stringify([
          {
            previous_filename: String.raw` old\name.ts `,
            filename: String.raw` new\name.ts `,
            status: "renamed",
          },
        ]),
      ),
    );

    expect(result.patch).toBe(
      [
        String.raw`diff --git "a/ old\\name.ts " "b/ new\\name.ts "`,
        String.raw`rename from " old\\name.ts "`,
        String.raw`rename to " new\\name.ts "`,
        String.raw`--- "a/ old\\name.ts "`,
        String.raw`+++ "b/ new\\name.ts "`,
        "",
      ].join("\n"),
    );
  });

  it("points an added file at /dev/null on the left and a removed one on the right", () => {
    const result = expectSuccess(
      decodePullRequestFilesJson(
        JSON.stringify([
          { filename: "src/new.ts", status: "added", patch: "@@ -0,0 +1 @@\n+hello" },
          { filename: "src/gone.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-bye" },
        ]),
      ),
    );

    expect(result.patch).toBe(
      [
        "diff --git a/src/new.ts b/src/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/new.ts",
        "@@ -0,0 +1 @@",
        "+hello",
        "diff --git a/src/gone.ts b/src/gone.ts",
        "deleted file mode 100644",
        "--- a/src/gone.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
        "",
      ].join("\n"),
    );
  });

  it("names both paths of a rename, counting its hunks against the old one", () => {
    const result = expectSuccess(
      decodePullRequestFilesJson(
        JSON.stringify([
          {
            filename: "src/new.ts",
            status: "renamed",
            previous_filename: "src/old.ts",
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ]),
      ),
    );

    expect(result.patch).toBe(
      [
        "diff --git a/src/old.ts b/src/new.ts",
        "rename from src/old.ts",
        "rename to src/new.ts",
        "--- a/src/old.ts",
        "+++ b/src/new.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );
  });

  it("still lists a file GitHub sent no hunks for, and says what was withheld", () => {
    const result = expectSuccess(
      decodePullRequestFilesJson(
        JSON.stringify([
          { filename: "logo.png", status: "modified", additions: 4, deletions: 2 },
          {
            filename: "src/app.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ]),
      ),
    );

    expect(result.patch).toContain("diff --git a/logo.png b/logo.png");
    expect(result.patch).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(result.truncated).toBe(true);
    expect(result.rawCount).toBe(2);
  });
});

describe("decodePullRequestFilesViewedJson", () => {
  const page = (
    nodes: ReadonlyArray<unknown>,
    pageInfo: { hasNextPage: boolean; endCursor: string | null },
  ) =>
    JSON.stringify({
      data: { repository: { pullRequest: { files: { pageInfo, nodes } } } },
    });

  it("treats a state it has never heard of as unread rather than failing the page", () => {
    const decoded = decodePullRequestFilesViewedJson(
      page([{ path: "src/a.ts", viewerViewedState: "SOMETHING_NEW" }], {
        hasNextPage: false,
        endCursor: null,
      }),
    );
    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    expect(decoded.success).toEqual({
      files: [{ path: "src/a.ts", state: "unviewed" }],
      nextCursor: null,
    });
  });
});

describe("host-native stack decoding", () => {
  function stack(overrides: Record<string, unknown> = {}) {
    return {
      id: 42,
      number: 3,
      node_id: "STK_kwDO",
      url: "https://api.github.com/repos/acme/web/stacks/3",
      base: { ref: "main", sha: "abc" },
      open: true,
      created_at: "2026-09-01T00:00:00Z",
      pull_requests: [
        {
          number: 10,
          head: { ref: "feat/one" },
          state: "closed",
          merged_at: "2026-09-02T00:00:00Z",
        },
        { number: 11, head: { ref: "feat/two" }, state: "open", merged_at: null },
        { number: 12, head: { ref: "feat/three" }, state: "closed", merged_at: null },
      ],
      ...overrides,
    };
  }

  function expectStack(overrides: Record<string, unknown> = {}) {
    const decoded = expectSuccess(decodePullRequestStacksJson(JSON.stringify([stack(overrides)])));
    if (decoded === null) throw new Error("expected a stack");
    return decoded;
  }

  it("reads the first stack, bottom to top, with merged_at outranking state", () => {
    expect(expectStack()).toEqual({
      id: "42",
      number: 3,
      url: "https://api.github.com/repos/acme/web/stacks/3",
      base: "main",
      layers: [
        { number: 10, headBranch: "feat/one", state: "merged" },
        { number: 11, headBranch: "feat/two", state: "open" },
        { number: 12, headBranch: "feat/three", state: "closed" },
      ],
    });
  });
});

const decodeWatchedResult = Schema.decodeUnknownSync(PullRequestWatchFingerprint.result);
const decodeWatched = (pullRequest: object) =>
  decodeWatchedResult({ repository: { pullRequest } }).repository!.pullRequest!;

describe("pull request lookups", () => {
  it("refuses what GitHub cannot name, so one bad row cannot fail a whole batch", () => {
    expect(pullRequestLookup({ repository: "acme/web", number: 7 })).toEqual({
      owner: "acme",
      name: "web",
      number: 7,
    });
    expect(pullRequestLookup({ repository: 'acme/web") { x } #', number: 1 })).toBeNull();
    expect(pullRequestLookup({ repository: "acme/web", number: 0 })).toBeNull();
    expect(pullRequestLookup({ repository: "acme/web", number: 1.5 })).toBeNull();
    expect(pullRequestLookup({ repository: "acme/web", number: 2 ** 31 })).toBeNull();
  });
});

describe("pull request watch fingerprints", () => {
  it("moves status with checks and remarks with comments, each without the other", () => {
    const pullRequest = (input: {
      readonly running: number;
      readonly failed: number;
      readonly commentEditedAt: string | null;
      readonly reviews: number;
    }) => ({
      state: "OPEN",
      mergeable: "MERGEABLE",
      headRefOid: "abc123",
      comments: { totalCount: 1, nodes: [{ lastEditedAt: input.commentEditedAt }] },
      reviews: { totalCount: input.reviews, nodes: [] },
      reviewThreads: { totalCount: 0 },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  checkRunCountsByState: [
                    { state: "IN_PROGRESS", count: input.running },
                    { state: "FAILURE", count: input.failed },
                    { state: "SUCCESS", count: 0 },
                  ],
                  statusContextCountsByState: null,
                },
              },
            },
          },
        ],
      },
    });
    const fingerprint = (input: Parameters<typeof pullRequest>[0]) =>
      toPullRequestWatchFingerprint(decodeWatched(pullRequest(input)));
    const base = { running: 2, failed: 0, commentEditedAt: null, reviews: 1 };
    const before = fingerprint(base);
    const checkFinished = fingerprint({ ...base, running: 1, failed: 1 });
    const summaryEdited = fingerprint({ ...base, commentEditedAt: "2026-10-05T23:47:43Z" });
    const replied = fingerprint({ ...base, reviews: 2 });

    expect(checkFinished.status).not.toBe(before.status);
    expect(checkFinished.remarks).toBe(before.remarks);
    expect(summaryEdited.remarks).not.toBe(before.remarks);
    expect(summaryEdited.status).toBe(before.status);
    expect(replied.remarks).not.toBe(before.remarks);
  });
});
