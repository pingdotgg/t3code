// @effect-diagnostics preferSchemaOverJson:off effectFnOpportunity:off
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";
import {
  LenientPullRequestList,
  toLabelCandidates,
  toPullRequestActivityPage,
  toPullRequestCore,
  toPullRequestFilesViewedPage,
  toPullRequestRows,
  toReviewerCandidates,
  toReviewThreadCommentsPage,
  toReviewThreadPage,
  toViewerPermissions,
} from "./gitHubPullRequestJson.ts";
import {
  LabelCandidates,
  PullRequestActivity,
  PullRequestCore,
  PullRequestFilesViewed,
  ReviewerCandidates,
  ViewerPermissions,
} from "./pullRequestReads.graphql.ts";
import { ReviewThreadComments, ReviewThreads } from "./pullRequestReviews.graphql.ts";

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

export const user = (login: string, fields: Record<string, unknown> = {}) => ({
  __typename: "User",
  login,
  ...fields,
});

export const row = (fields: Record<string, unknown>) => ({
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

export const decodePullRequestListJson = through(LenientPullRequestList.result, (result) =>
  listPage(toPullRequestRows(result.repository?.pullRequests)),
);

export const decodePullRequestActivityJson = through(
  PullRequestActivity.result,
  toPullRequestActivityPage,
);

export const decodePullRequestCoreJson = through(PullRequestCore.result, toPullRequestCore);

type Json = Record<string, any>;

export const LAST_PAGE = { hasNextPage: false, endCursor: null };

const nodesIn = (connection: Json | null | undefined): ReadonlyArray<Json> =>
  connection?.["nodes"] ?? [];

const actor = (raw: Json | null | undefined) =>
  raw === null || raw === undefined ? null : { __typename: "User", avatarUrl: "", ...raw };

export const reactionGroups = (groups: ReadonlyArray<Json> | undefined) =>
  (groups ?? []).map(({ reactors, ...group }) => ({
    viewerHasReacted: false,
    ...group,
    reactors: {
      totalCount: 0,
      ...reactors,
      nodes: nodesIn(reactors).map((node) => ({ __typename: "User", ...node })),
    },
  }));

export const remark = ({ author, reactionGroups: groups, ...raw }: Json) => ({
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

export const requestedReviewer = (raw: Json | null) =>
  raw === null
    ? null
    : "login" in raw
      ? { name: null, ...actor(raw) }
      : { __typename: "Team", ...raw };

const reviewCommit = ({ commit: { authors, ...commit } }: Json) => ({
  commit: {
    messageHeadline: "",
    committedDate: "",
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

export const decodeReviewThreadsJson = (raw: string) =>
  through(ReviewThreads.result, toReviewThreadPage)(withReviewDefaults(raw));

export const decodeReviewThreadCommentsJson = (raw: string) =>
  through(ReviewThreadComments.result, toReviewThreadCommentsPage)(withReviewDefaults(raw));

export const decodeViewerPermissionsJson = through(ViewerPermissions.result, toViewerPermissions);

export const decodeLabelCandidatesJson = through(LabelCandidates.result, toLabelCandidates);

export const decodeReviewerCandidatesJson = through(ReviewerCandidates.result, toReviewerCandidates);

export const decodePullRequestFilesViewedJson = through(
  PullRequestFilesViewed.result,
  toPullRequestFilesViewedPage,
);

export function listJson(entries: ReadonlyArray<Record<string, unknown>>): string {
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

export function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}
