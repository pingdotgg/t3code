import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  buildReviewSubmissionJson,
  buildReviewerRequestJson,
  decodeBaseComparisonJson,
  decodePullRequestActivityJson,
  decodePullRequestDetailJson,
  decodePullRequestFilesJson,
  decodePullRequestListJson,
  decodePullRequestNodeIdJson,
  decodePullRequestSearchJson,
  decodeRepositoryAccessJson,
  decodeReviewerCandidatesJson,
  decodeReviewThreadCommentsJson,
  decodeReviewThreadsJson,
  decodeViewerPermissionsJson,
  reviewThreadConversation,
  REVIEW_THREADS_GRAPHQL_QUERY,
} from "./gitHubPullRequestJson.ts";

function listJson(entries: ReadonlyArray<Record<string, unknown>>): string {
  return JSON.stringify(
    entries.map((entry) => ({
      number: 1,
      title: "Add the pull requests page",
      url: "https://github.com/pingdotgg/t3code/pull/1",
      headRefName: "feat/page",
      baseRefName: "main",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      ...entry,
    })),
  );
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

  it("normalizes mergeability and defaults unknown values", () => {
    const batch = expectSuccess(
      decodePullRequestListJson(
        listJson([{ mergeable: "CONFLICTING" }, { mergeable: "SOMETHING_NEW" }, {}]),
      ),
    );
    expect(batch.items.map((entry) => entry.mergeability)).toEqual([
      "conflicting",
      "unknown",
      "unknown",
    ]);
  });

  it("keeps user review requests and drops team ones, which are not logins", () => {
    const [entry] = expectSuccess(
      decodePullRequestListJson(
        listJson([{ reviewRequests: [{ login: "octocat" }, { slug: "web-platform" }] }]),
      ),
    ).items;
    expect(entry?.reviewRequestLogins).toEqual(["octocat"]);
  });

  it("normalizes the review decision and reports nothing for one GitHub does not summarize", () => {
    const batch = expectSuccess(
      decodePullRequestListJson(
        listJson([
          { reviewDecision: "APPROVED" },
          { reviewDecision: "CHANGES_REQUESTED" },
          { reviewDecision: "REVIEW_REQUIRED" },
          { reviewDecision: null },
        ]),
      ),
    );
    expect(batch.items.map((entry) => entry.reviewDecision)).toEqual([
      "approved",
      "changes-requested",
      "review-required",
      null,
    ]);
  });

  it("rolls the head commit's checks up to the one word a row has space for", () => {
    const batch = expectSuccess(
      decodePullRequestListJson(
        listJson([
          // A failure outranks a run still going, and a completed run has to be read through its
          // conclusion rather than its status.
          {
            statusCheckRollup: [
              { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
              { name: "build", status: "IN_PROGRESS" },
              { name: "test", status: "COMPLETED", conclusion: "FAILURE" },
            ],
          },
          {
            statusCheckRollup: [
              { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
              { name: "build", status: "QUEUED" },
            ],
          },
          { statusCheckRollup: [{ name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }] },
          // A commit status reports one `state` and no `status` at all.
          { statusCheckRollup: [{ context: "ci/legacy", state: "ERROR" }] },
          // Neither a pass, a failure nor a wait is no verdict rather than a green tick.
          { statusCheckRollup: [{ name: "lint", status: "COMPLETED", conclusion: "SKIPPED" }] },
          { statusCheckRollup: [] },
          {},
        ]),
      ),
    );
    expect(batch.items.map((entry) => entry.checksState)).toEqual([
      "failing",
      "pending",
      "passing",
      "failing",
      null,
      null,
      null,
    ]);
  });

  it("skips malformed entries but still counts them, so paging does not stop early", () => {
    const raw = `[${listJson([{}]).slice(1, -1)},{"number":"not-a-number"}]`;
    const batch = expectSuccess(decodePullRequestListJson(raw));
    expect(batch.items).toHaveLength(1);
    expect(batch.rawCount).toBe(2);
  });
});

describe("pull request search decoding", () => {
  function searchJson(rollupStates: ReadonlyArray<string | null>): string {
    return JSON.stringify({
      data: {
        search: {
          pageInfo: { hasNextPage: false },
          nodes: rollupStates.map((state, index) => ({
            number: index + 1,
            title: "Add the pull requests page",
            url: "https://github.com/pingdotgg/t3code/pull/1",
            headRefName: "feat/page",
            baseRefName: "main",
            createdAt: "2026-07-01T00:00:00Z",
            updatedAt: "2026-07-02T00:00:00Z",
            repository: { nameWithOwner: "pingdotgg/t3code" },
            commits: {
              nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }],
            },
          })),
        },
      },
    });
  }

  it("maps the rollup enum the search answers with onto the same three words", () => {
    // The search asks GitHub for the verdict rather than the checks behind it, so this path sees
    // one enum where the listing sees an array.
    const batch = expectSuccess(
      decodePullRequestSearchJson(
        searchJson(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED", null]),
      ),
    );
    expect(batch.items.map((entry) => entry.checksState)).toEqual([
      "passing",
      "failing",
      "failing",
      "pending",
      "pending",
      null,
    ]);
  });
});

describe("pull request detail decoding", () => {
  const detailJson = JSON.stringify({
    number: 7,
    title: "Detail",
    url: "https://github.com/pingdotgg/t3code/pull/7",
    headRefName: "feat/detail",
    baseRefName: "main",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-05T00:00:00Z",
    body: "Body",
    statusCheckRollup: [
      { __typename: "CheckRun", name: "build", status: "IN_PROGRESS" },
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS" },
    ],
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

  it("maps check-run status and commit-status state onto one vocabulary", () => {
    const detail = expectSuccess(decodePullRequestDetailJson(detailJson));
    expect(detail.checks.map((check) => [check.name, check.status])).toEqual([
      ["build", "pending"],
      ["test", "failure"],
      ["ci/legacy", "success"],
    ]);
  });

  it("reads an auto-merge request as armed, its null as off and its absence as neither", () => {
    const raw = JSON.parse(detailJson) as Record<string, unknown>;
    const armed = (entry: Record<string, unknown>) =>
      expectSuccess(decodePullRequestDetailJson(JSON.stringify({ ...raw, ...entry })))
        .autoMergeEnabled;

    expect(
      armed({ autoMergeRequest: { enabledBy: { login: "octocat" }, mergeMethod: "SQUASH" } }),
    ).toBe(true);
    expect(armed({ autoMergeRequest: null })).toBe(false);
    // `gh` not answering for the field at all is not GitHub saying the merge is unarmed.
    expect(armed({})).toBeUndefined();
  });

  it("shows a re-running check once, as the run that is happening now", () => {
    // What `statusCheckRollup` reports while a workflow is being re-run: the same check twice,
    // the finished run and the one that replaced it, with no id to tell them apart.
    const raw = JSON.parse(detailJson) as Record<string, unknown>;
    const detail = expectSuccess(
      decodePullRequestDetailJson(
        JSON.stringify({
          ...raw,
          statusCheckRollup: [
            {
              __typename: "CheckRun",
              name: "Prepare PR size config",
              workflowName: "PR Size",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              startedAt: "2026-08-11T16:06:20Z",
              completedAt: "2026-08-11T16:06:25Z",
            },
            {
              __typename: "CheckRun",
              name: "Prepare PR size config",
              workflowName: "PR Size",
              status: "IN_PROGRESS",
              conclusion: "",
              startedAt: "2026-08-11T17:01:04Z",
              completedAt: "0001-01-01T00:00:00Z",
            },
          ],
        }),
      ),
    );

    expect(detail.checks.map((check) => [check.name, check.status])).toEqual([
      ["Prepare PR size config", "pending"],
    ]);
    expect(detail.checksState).toBe("pending");
  });

  it("merges reviews with comments in time order and keeps a bodyless approval", () => {
    const detail = expectSuccess(decodePullRequestActivityJson(detailJson));
    // r2 approved without writing anything, which is still the event worth seeing.
    expect(detail.comments.map((comment) => comment.id)).toEqual(["r1", "c1", "r2"]);
    expect(detail.comments.at(-1)?.reviewState).toBe("APPROVED");
  });

  it("keeps every attributed commit author, including an unlinked signature", () => {
    const detail = expectSuccess(decodePullRequestActivityJson(detailJson));
    expect(detail.commits[0]?.authors).toEqual([
      { login: "octocat", name: "Octo Cat", avatarUrl: null },
      { login: "Pair Author", name: "Pair Author", avatarUrl: null },
    ]);
  });

  it("drops the bodyless review GitHub opens to hold line comments", () => {
    const raw = JSON.parse(detailJson) as Record<string, unknown>;
    const detail = expectSuccess(
      decodePullRequestActivityJson(
        JSON.stringify({
          ...raw,
          reviews: [
            // What a reviewer leaving inline comments produces: a container with a state but
            // nothing to read. Its comments come from the review threads instead.
            { id: "r4", body: "", state: "COMMENTED", submittedAt: "2026-07-07T00:00:00Z" },
            {
              id: "r5",
              body: "Looks good.",
              state: "COMMENTED",
              submittedAt: "2026-07-08T00:00:00Z",
            },
          ],
        }),
      ),
    );

    expect(detail.comments.map((comment) => comment.id)).toEqual(["c1", "r5"]);
  });

  it.each(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"])(
    "keeps a bodyless %s review, which is the event itself",
    (state) => {
      const raw = JSON.parse(detailJson) as Record<string, unknown>;
      const detail = expectSuccess(
        decodePullRequestActivityJson(
          JSON.stringify({
            ...raw,
            reviews: [{ id: "r6", body: "", state, submittedAt: "2026-07-07T00:00:00Z" }],
          }),
        ),
      );

      expect(detail.comments.map((comment) => comment.id)).toContain("r6");
    },
  );

  it("drops a review that carries neither a body nor a state", () => {
    const raw = JSON.parse(detailJson) as Record<string, unknown>;
    const detail = expectSuccess(
      decodePullRequestActivityJson(
        JSON.stringify({
          ...raw,
          reviews: [{ id: "r3", body: "  ", submittedAt: "2026-07-07T00:00:00Z" }],
        }),
      ),
    );
    expect(detail.comments.map((comment) => comment.id)).toEqual(["c1"]);
  });
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

  /** The same query carries the review roster, so it is built alongside the threads. */
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

  it("keeps a reviewer who has already reviewed, app or person, with their avatar", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        reviewJson({
          requested: [{ login: "julius", name: "Julius", avatarUrl: "https://avatars/j.png" }],
          // An app that has reviewed is no longer an outstanding request, which is why asking
          // only for requests reported nobody on a pull request a bot had reviewed.
          reviewed: [{ login: "macroscopeapp", avatarUrl: "https://avatars/in/900172.png" }],
        }),
      ),
    );

    expect(result.reviewers).toEqual([
      { login: "julius", name: "Julius", avatarUrl: "https://avatars/j.png" },
      { login: "macroscopeapp", name: null, avatarUrl: "https://avatars/in/900172.png" },
    ]);
  });

  it("carries per-commit line counts from the pull-request connection", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { totalCount: 0, nodes: [] },
                commits: {
                  nodes: [
                    { commit: { oid: "abc123", additions: 18, deletions: 7 } },
                    { commit: { oid: "def456", additions: 3, deletions: 0 } },
                  ],
                },
              },
            },
          },
        }),
      ),
    );

    expect([...result.commitStats]).toEqual([
      ["abc123", { additions: 18, deletions: 7 }],
      ["def456", { additions: 3, deletions: 0 }],
    ]);
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

  it("skips a team request, which names nobody to show", () => {
    const result = expectSuccess(decodeReviewThreadsJson(reviewJson({ requested: [null] })));

    expect(result.reviewers).toEqual([]);
  });

  it("keeps the conversation when a request is from a team, which has no login", () => {
    // GraphQL answers with an empty object for a union member the query has no fragment for.
    // Failing on it would take the whole response down, comments included.
    const result = expectSuccess(
      decodeReviewThreadsJson(
        reviewJson({ requested: [{}, { login: "julius", avatarUrl: "https://avatars/j.png" }] }),
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

  it("hands back the cursor the next page of threads carries on from", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        threadsJson(
          [
            {
              id: "PRRT_d",
              path: "apps/server/src/ws.ts",
              isResolved: false,
              comments: { nodes: [{ id: "t1", createdAt: "2026-07-01T00:00:00Z" }] },
            },
          ],
          80,
          { hasNextPage: true, endCursor: "Y3Vyc29yOjE" },
        ),
      ),
    );
    expect(result.nextCursor).toBe("Y3Vyc29yOjE");
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
            node: {
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
        node: {
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
          // Not one of the eight the contract carries.
          {
            content: "PARTY_PARROT",
            reactors: { totalCount: 1, nodes: [{ login: "hubot" }] },
          },
          // Nobody behind it, which GitHub still answers a group for.
          { content: "HEART", reactors: { totalCount: 0, nodes: [] } },
          // More reactors than the bounded read named, and no `viewerHasReacted` at all.
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

  it("leaves the viewer's own login out of actors, matched case-insensitively, while count still counts them", () => {
    const decoded = expectSuccess(
      decodeReviewThreadCommentsJson(
        JSON.stringify({
          data: {
            viewer: { login: "Bilal" },
            node: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "t1",
                    body: "nice",
                    createdAt: "2026-07-01T00:00:00Z",
                    reactionGroups: [
                      {
                        content: "HEART",
                        viewerHasReacted: true,
                        reactors: {
                          totalCount: 2,
                          nodes: [{ login: "bilal" }, { login: "julius" }],
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        }),
      ),
    );

    expect(decoded.comments[0]?.reactions).toEqual([
      { content: "heart", count: 2, actors: ["julius"], viewerHasReacted: true },
    ]);
  });
});

describe("repository access decoding", () => {
  const repositoryJson = (viewerPermission?: string | null) =>
    JSON.stringify({
      mergeCommitAllowed: true,
      squashMergeAllowed: false,
      rebaseMergeAllowed: true,
      ...(viewerPermission === undefined ? {} : { viewerPermission }),
    });

  it("reads the three settings gh reports", () => {
    expect(
      expectSuccess(decodeRepositoryAccessJson(repositoryJson("ADMIN"))).mergeCapabilities,
    ).toEqual({ merge: true, squash: false, rebase: true });
  });

  it("fails rather than defaulting open when a setting is missing", () => {
    const decoded = decodeRepositoryAccessJson(JSON.stringify({ mergeCommitAllowed: true }));
    expect(Result.isSuccess(decoded)).toBe(false);
  });

  it("counts the roles that can push as write, and the ones that cannot as read", () => {
    for (const permission of ["ADMIN", "MAINTAIN", "WRITE"]) {
      expect(expectSuccess(decodeRepositoryAccessJson(repositoryJson(permission))).canWrite).toBe(
        true,
      );
    }
    for (const permission of ["TRIAGE", "READ", "NONE"]) {
      expect(expectSuccess(decodeRepositoryAccessJson(repositoryJson(permission))).canWrite).toBe(
        false,
      );
    }
  });

  it("withholds write where gh names no permission, which is not a standing it gave", () => {
    // The one place an unknown answer is not granted: a Merge button a reader cannot use wastes
    // the press, where a missing one still leaves the pull request open on its host.
    expect(expectSuccess(decodeRepositoryAccessJson(repositoryJson())).canWrite).toBe(false);
    expect(expectSuccess(decodeRepositoryAccessJson(repositoryJson(null))).canWrite).toBe(false);
  });
});

describe("viewer permission decoding", () => {
  const viewerJson = (repository: Record<string, unknown>) =>
    JSON.stringify({ data: { repository } });

  it("reads the repository's role and the pull request's own viewer fields together", () => {
    expect(
      expectSuccess(
        decodeViewerPermissionsJson(
          viewerJson({
            viewerPermission: "READ",
            pullRequest: { viewerCanUpdate: true, viewerDidAuthor: true },
          }),
        ),
      ),
    ).toEqual({ canWrite: false, canUpdate: true, didAuthor: true });
  });

  it("says no to a passer-by on a repository they can only read", () => {
    expect(
      expectSuccess(
        decodeViewerPermissionsJson(
          viewerJson({
            viewerPermission: "READ",
            pullRequest: { viewerCanUpdate: false, viewerDidAuthor: false },
          }),
        ),
      ),
    ).toEqual({ canWrite: false, canUpdate: false, didAuthor: false });
  });

  it("reads silence as permission, but not as authorship", () => {
    // A node the viewer cannot see comes back null. Updating is a permission, so an unknown
    // answer grants it and lets the host refuse; authorship is a fact about who wrote the change,
    // and claiming it for someone who did not is how an author's own rules get handed out.
    expect(expectSuccess(decodeViewerPermissionsJson(viewerJson({ pullRequest: null })))).toEqual({
      canWrite: false,
      canUpdate: true,
      didAuthor: false,
    });
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
    // The same response the threads arrive in, so knowing this costs no request of its own.
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
            comments: { totalCount: 2, nodes: [comment("c1", "first"), comment("c2", "second")] },
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
            url: "https://github.com/acme/web/pull/1#discussion_rc1",
            reactions: [],
          },
          {
            id: "c2",
            author: { login: "bilal", name: null, avatarUrl: "https://avatars/b.png" },
            body: "second",
            createdAt: "2026-07-01T00:00:00Z",
            url: "https://github.com/acme/web/pull/1#discussion_rc2",
            reactions: [],
          },
        ],
      },
    ]);
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
            // GitHub reports no current line once the thread has fallen off the diff.
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

  it("keeps a resolved thread in the conversation as well as against its line", () => {
    const decoded = expectSuccess(
      decodeReviewThreadsJson(
        threadsJson([
          {
            id: "PRRT_3",
            isResolved: true,
            path: "src/a.ts",
            line: 7,
            diffSide: "RIGHT",
            comments: { totalCount: 1, nodes: [comment("c4", "done")] },
          },
        ]),
      ),
    );
    // A resolved conversation is finished work, not unsaid work: the timeline reads it and the
    // diff pins it to its line, the same as any other.
    const threads = decoded.threads.map((entry) => entry.thread);
    expect(reviewThreadConversation(threads).map((comment) => comment.id)).toEqual(["c4"]);
    expect(threads).toHaveLength(1);
  });

  it("puts an issue comment's and a review's reactions in reactionsById, and the pull request's own in reactions", () => {
    const result = expectSuccess(
      decodeReviewThreadsJson(
        threadsJson([], {
          reactionGroups: [
            {
              content: "HEART",
              viewerHasReacted: true,
              reactors: { totalCount: 1, nodes: [{ login: "bilal" }] },
            },
          ],
          comments: {
            nodes: [
              {
                id: "c1",
                reactionGroups: [
                  {
                    content: "THUMBS_UP",
                    reactors: { totalCount: 1, nodes: [{ login: "julius" }] },
                  },
                ],
              },
            ],
          },
          reviews: {
            nodes: [
              {
                id: "r1",
                reactionGroups: [
                  { content: "EYES", reactors: { totalCount: 1, nodes: [{ login: "hubot" }] } },
                ],
              },
            ],
          },
        }),
      ),
    );

    expect(result.reactions).toEqual([
      { content: "heart", count: 1, actors: ["bilal"], viewerHasReacted: true },
    ]);
    expect([...result.reactionsById]).toEqual([
      ["c1", [{ content: "thumbs-up", count: 1, actors: ["julius"], viewerHasReacted: false }]],
      ["r1", [{ content: "eyes", count: 1, actors: ["hubot"], viewerHasReacted: false }]],
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

describe("decodePullRequestNodeIdJson", () => {
  it("reads the pull request's own node id, which a reaction on its description is addressed by", () => {
    expect(
      expectSuccess(
        decodePullRequestNodeIdJson(
          JSON.stringify({ data: { repository: { pullRequest: { id: "PR_kwDOA" } } } }),
        ),
      ),
    ).toBe("PR_kwDOA");
  });
});

describe("REVIEW_THREADS_GRAPHQL_QUERY", () => {
  it("asks for reactionGroups on the pull request itself, its comments, its reviews and each thread's comments", () => {
    expect(REVIEW_THREADS_GRAPHQL_QUERY.match(/reactionGroups/g)).toHaveLength(4);
    // The reviews connection is new: only reactions were ever wanted off it.
    expect(REVIEW_THREADS_GRAPHQL_QUERY).toContain("reviews(first:");
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
            nodes: input.assignable,
          },
          pullRequest: {
            author: input.author === undefined ? null : { login: input.author },
            reviewRequests: {
              nodes: (input.requested ?? []).map((requestedReviewer) => ({ requestedReviewer })),
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

  it("marks whoever has already been asked, and leaves the rest to be asked", () => {
    const list = expectSuccess(
      decodeReviewerCandidatesJson(
        candidatesJson({
          assignable: [{ login: "octocat" }, { login: "hubot" }],
          requested: [{ login: "octocat" }],
        }),
      ),
    );
    expect(list.candidates.map((candidate) => [candidate.login, candidate.isRequested])).toEqual([
      ["octocat", true],
      ["hubot", false],
    ]);
  });

  it("keeps a requested team apart from the people, so the request can be taken back", () => {
    // A team is never among the assignable users, and a request that cannot be seen cannot be
    // undone — so the ones GitHub reports are carried, marked as the teams they are.
    const list = expectSuccess(
      decodeReviewerCandidatesJson(
        candidatesJson({
          assignable: [{ login: "octocat" }],
          requested: [{ slug: "reviewers", name: "Reviewers" }],
        }),
      ),
    );
    expect(list.candidates).toEqual([
      {
        id: "reviewers",
        kind: "team",
        login: "reviewers",
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

  it("says so when the repository has more people than the read asked for", () => {
    expect(
      expectSuccess(
        decodeReviewerCandidatesJson(
          candidatesJson({ assignable: [{ login: "octocat" }], hasNextPage: true }),
        ),
      ).truncated,
    ).toBe(true);
  });
});

describe("reviewer request payload", () => {
  it("sends people and teams in the two lists GitHub keeps them in", () => {
    expect(
      JSON.parse(
        buildReviewerRequestJson([
          { id: "octocat", kind: "user" },
          { id: "reviewers", kind: "team" },
          { id: "hubot", kind: "user" },
        ]),
      ),
    ).toEqual({ reviewers: ["octocat", "hubot"], team_reviewers: ["reviewers"] });
  });

  it("sends both lists even where one of them is empty, which is what GitHub reads", () => {
    expect(JSON.parse(buildReviewerRequestJson([{ id: "octocat", kind: "user" }]))).toEqual({
      reviewers: ["octocat"],
      team_reviewers: [],
    });
  });
});

describe("review submission payload", () => {
  it("sends the verdict, the summary and every line comment in one body", () => {
    const payload = JSON.parse(
      buildReviewSubmissionJson({
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
      }),
    ) as Record<string, unknown>;
    expect(payload).toEqual({
      event: "REQUEST_CHANGES",
      body: "Two things.",
      comments: [
        { path: "src/a.ts", line: 12, side: "RIGHT", body: "rename this" },
        { path: "src/b.ts", line: 3, side: "LEFT", body: "why remove?" },
      ],
    });
  });

  it("sends an approval with no words and no comments", () => {
    expect(
      JSON.parse(buildReviewSubmissionJson({ verdict: "approve", body: "", comments: [] })),
    ).toEqual({ event: "APPROVE", body: "", comments: [] });
  });
});

describe("decodePullRequestFilesJson", () => {
  it("assembles a unified patch the files API does not return", () => {
    const result = expectSuccess(
      decodePullRequestFilesJson(
        JSON.stringify([
          { filename: "src/app.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" },
        ]),
      ),
    );

    expect(result.patch).toBe(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );
    expect(result.truncated).toBe(false);
    expect(result.rawCount).toBe(1);
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
          // Binary: it changed, and none of it can be shown.
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

    // Dropping it would take the file out of the change altogether, not just its contents.
    expect(result.patch).toContain("diff --git a/logo.png b/logo.png");
    expect(result.patch).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(result.truncated).toBe(true);
    expect(result.rawCount).toBe(2);
  });

  it("does not call a pure rename incomplete, since it has no hunks to withhold", () => {
    const result = expectSuccess(
      decodePullRequestFilesJson(
        JSON.stringify([
          {
            filename: "src/new.ts",
            previous_filename: "src/old.ts",
            status: "renamed",
            additions: 0,
            deletions: 0,
          },
        ]),
      ),
    );

    expect(result.patch).toContain("rename from src/old.ts");
    expect(result.truncated).toBe(false);
  });
});

describe("how far a branch trails its base", () => {
  const comparison = (pullRequest: unknown) =>
    JSON.stringify({ data: { repository: { pullRequest } } });

  it("reads the commit count and whether this viewer may move the branch", () => {
    const decoded = expectSuccess(
      decodeBaseComparisonJson(
        comparison({ viewerCanUpdateBranch: true, baseRef: { compare: { behindBy: 12 } } }),
      ),
    );
    expect(decoded).toEqual({ behindBy: 12, viewerCanUpdate: true });
  });

  it("reads a current branch as nothing to do", () => {
    expect(
      expectSuccess(
        decodeBaseComparisonJson(
          comparison({ viewerCanUpdateBranch: false, baseRef: { compare: { behindBy: 0 } } }),
        ),
      ),
    ).toEqual({ behindBy: 0, viewerCanUpdate: false });
  });

  it("answers unknown where the head could not be compared", () => {
    // A pull request from a fork whose repository is gone, which GitHub answers with a null
    // comparison beside a perfectly good pull request.
    expect(
      expectSuccess(
        decodeBaseComparisonJson(comparison({ viewerCanUpdateBranch: true, baseRef: null })),
      ).behindBy,
    ).toBeNull();
    expect(expectSuccess(decodeBaseComparisonJson(comparison(null)))).toEqual({
      behindBy: null,
      viewerCanUpdate: false,
    });
  });

  it("refuses a body that is not the answer to this question", () => {
    expect(Result.isSuccess(decodeBaseComparisonJson("{"))).toBe(false);
  });
});
