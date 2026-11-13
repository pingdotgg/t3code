import * as Result from "effect/Result";
import {
  describe,
  expect,
  it,
} from "vite-plus/test";
import { reviewThreadConversation, toCanWrite } from "./gitHubPullRequestJson.ts";
import { LAST_PAGE, decodeLabelCandidatesJson, decodePullRequestActivityJson, decodeReviewThreadCommentsJson, decodeReviewThreadsJson, decodeViewerPermissionsJson, expectSuccess, reactionGroups, remark, requestedReviewer, user } from "./gitHubPullRequestJson.part2.testkit.ts";

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

  it("selects stats only for non-merge activity commits", () => {
    const result = expectSuccess(
      decodePullRequestActivityJson(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                author: null,
                comments: { nodes: [], pageInfo: LAST_PAGE },
                reviews: { nodes: [], pageInfo: LAST_PAGE },
                commits: {
                  nodes: [1, 2].map((parents) => ({
                    commit: {
                      id: "commit-" + parents,
                      oid: "sha-" + parents,
                      messageHeadline: "Commit",
                      committedDate: "2026-07-05T00:00:00Z",
                      parents: { totalCount: parents },
                      authors: { nodes: [] },
                    },
                  })),
                },
              },
            },
          },
        }),
      ),
    );
    expect(result.nonMergeCommitIds).toEqual(["commit-1"]);
    expect(result.commits?.map((commit) => commit.oid)).toEqual(["sha-1", "sha-2"]);
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
    // Unselected GraphQL union members return no selected fields.
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
