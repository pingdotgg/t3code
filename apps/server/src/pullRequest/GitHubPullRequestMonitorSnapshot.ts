import {
  type PullRequestCheckStatus,
  type PullRequestMonitorActor,
  type PullRequestMonitorCheckRun,
  type PullRequestMonitorIssueComment,
  type PullRequestMonitorReview,
  type PullRequestMonitorReviewThread,
  type PullRequestMonitorSnapshot,
  type PullRequestState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as NodeCrypto from "node:crypto";

import type { GitHubCliError } from "@t3tools/contracts";
import { GitHubCli } from "../git/Services/GitHubCli.ts";
import { PullRequestProviderError } from "./PullRequestProvider.ts";

const ActorSchema = Schema.Struct({
  login: Schema.optional(Schema.String),
  __typename: Schema.optional(Schema.String),
});

const PageInfoSchema = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});

const ReviewSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(ActorSchema),
  state: Schema.String,
  submittedAt: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
  body: Schema.optional(Schema.String),
});

const ThreadCommentSchema = Schema.Struct({
  author: Schema.NullOr(ActorSchema),
  body: Schema.optional(Schema.String),
  path: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Finite),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  viewerDidAuthor: Schema.optional(Schema.Boolean),
});

const ThreadSchema = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  comments: Schema.Struct({
    nodes: Schema.Array(ThreadCommentSchema),
  }),
});

const MonitorPageSchema = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            state: Schema.String,
            isDraft: Schema.Boolean,
            merged: Schema.Boolean,
            mergeable: Schema.String,
            headRefOid: Schema.String,
            baseRefName: Schema.String,
            headRefName: Schema.String,
            title: Schema.String,
            url: Schema.String,
            reviews: Schema.Struct({
              nodes: Schema.Array(ReviewSchema),
              pageInfo: PageInfoSchema,
            }),
            reviewThreads: Schema.Struct({
              nodes: Schema.Array(ThreadSchema),
              pageInfo: PageInfoSchema,
            }),
          }),
        ),
      }),
    ),
  }),
});

const MonitorConnectionsPageSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            reviews: Schema.Struct({
              nodes: Schema.Array(ReviewSchema),
              pageInfo: PageInfoSchema,
            }),
            reviewThreads: Schema.Struct({
              nodes: Schema.Array(ThreadSchema),
              pageInfo: PageInfoSchema,
            }),
          }),
        ),
      }),
    ),
  }),
});

const IssueCommentsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.Union([Schema.Finite, Schema.String]),
    user: Schema.NullOr(
      Schema.Struct({
        login: Schema.String,
        type: Schema.optional(Schema.String),
      }),
    ),
    body: Schema.optional(Schema.String),
    created_at: Schema.String,
    updated_at: Schema.String,
  }),
);

const CheckRunsSchema = Schema.Struct({
  total_count: Schema.Finite,
  check_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      head_sha: Schema.String,
      html_url: Schema.optional(Schema.NullOr(Schema.String)),
      output: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            title: Schema.optional(Schema.NullOr(Schema.String)),
            summary: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    }),
  ),
});

const StatusesSchema = Schema.Struct({
  total_count: Schema.optional(Schema.Finite),
  statuses: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.Finite,
        context: Schema.String,
        state: Schema.String,
        description: Schema.NullOr(Schema.String),
        target_url: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  sha: Schema.optional(Schema.String),
});

const MAX_PAGES = 10;
const PAGE_SIZE = 100;

const MONITOR_GRAPHQL = `
query(
  $owner: String!,
  $name: String!,
  $number: Int!,
  $reviewsCursor: String,
  $threadsCursor: String
) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      isDraft
      merged
      mergeable
      headRefOid
      baseRefName
      headRefName
      title
      url
      reviews(first: 100, after: $reviewsCursor) {
        nodes {
          id
          author { login __typename }
          state
          submittedAt
          commit { oid }
          body
        }
        pageInfo { hasNextPage endCursor }
      }
      reviewThreads(first: 100, after: $threadsCursor) {
        nodes {
          id
          isResolved
          comments(last: 20) {
            nodes {
              author { login __typename }
              body
              path
              line
              createdAt
              updatedAt
              viewerDidAuthor
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
`;

const MONITOR_CONNECTIONS_GRAPHQL = `
query(
  $owner: String!,
  $name: String!,
  $number: Int!,
  $reviewsCursor: String,
  $threadsCursor: String
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $reviewsCursor) {
        nodes {
          id
          author { login __typename }
          state
          submittedAt
          commit { oid }
          body
        }
        pageInfo { hasNextPage endCursor }
      }
      reviewThreads(first: 100, after: $threadsCursor) {
        nodes {
          id
          isResolved
          comments(last: 20) {
            nodes {
              author { login __typename }
              body
              path
              line
              createdAt
              updatedAt
              viewerDidAuthor
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
`;

function excerpt(value: string | undefined | null, max = 500): string {
  const text = (value ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function actorOf(
  value: { readonly login?: string | undefined; readonly __typename?: string | undefined } | null,
  userType?: string | undefined,
): PullRequestMonitorActor {
  const login = value?.login?.trim() || "ghost";
  if (value?.__typename === "Bot" || userType === "Bot") {
    return { login, kind: "bot" };
  }
  if (login === "ghost") return { login, kind: "unknown" };
  return { login, kind: "user" };
}

function normalizeReviewState(state: string): PullRequestMonitorReview["state"] {
  switch (state.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "DISMISSED":
      return "dismissed";
    case "PENDING":
      return "pending";
    default:
      return "commented";
  }
}

function normalizeCheckStatus(status: string, conclusion: string | null): PullRequestCheckStatus {
  if (status !== "completed") return "pending";
  switch ((conclusion ?? "").toLowerCase()) {
    case "success":
      return "success";
    case "neutral":
      return "neutral";
    case "skipped":
      return "skipped";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "failure";
  }
}

function normalizeLegacyStatus(state: string): PullRequestCheckStatus {
  switch (state.toLowerCase()) {
    case "success":
      return "success";
    case "pending":
      return "pending";
    case "error":
    case "failure":
      return "failure";
    default:
      return "neutral";
  }
}

function pullRequestState(raw: {
  readonly state: string;
  readonly merged: boolean;
}): PullRequestState {
  if (raw.merged || raw.state.toUpperCase() === "MERGED") return "merged";
  if (raw.state.toUpperCase() === "CLOSED") return "closed";
  return "open";
}

function mergeabilityOf(value: string): PullRequestMonitorSnapshot["mergeability"] {
  switch (value.toUpperCase()) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

function decodeOrFail<A>(schema: Schema.Codec<A, unknown>, raw: string, operation: string) {
  const decoded = decodeJsonResult(schema)(raw);
  if (Result.isSuccess(decoded)) return Effect.succeed(decoded.success);
  return Effect.fail(
    new PullRequestProviderError({
      provider: "github",
      operation,
      reason: "failed",
      detail: `Unreadable ${operation} response.`,
      cause: decoded.failure,
    }),
  );
}

function sourceRevisionOf(parts: ReadonlyArray<string>): string {
  return NodeCrypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

/**
 * Bound how far back a single poll walks; deeper history stays "incomplete", never
 * "resolved". The newest comments matter most, so the walk starts at the last page.
 */
const ISSUE_COMMENT_PAGE_SIZE = 100;
const MAX_ISSUE_COMMENT_REQUESTS = 10;
const MAX_RETAINED_ISSUE_COMMENTS = 200;

type IssueCommentPage = typeof IssueCommentsSchema.Type;
type IssueComment = IssueCommentPage[number];

/** `link: <...page=7>; rel="next", <...page=42>; rel="last"` */
function linkPage(header: string | null, rel: string): number | null {
  if (header === null) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part);
    if (!match || match[2] !== rel) continue;
    try {
      const page = Number(new URL(match[1] ?? "").searchParams.get("page"));
      return Number.isSafeInteger(page) && page > 0 ? page : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** `gh api --include` prints the status line and headers, a blank line, then the body. */
function splitIncludedResponse(stdout: string): {
  readonly link: string | null;
  readonly body: string;
} {
  if (!stdout.startsWith("HTTP/")) return { link: null, body: stdout };
  const separator = stdout.search(/\r?\n\r?\n/);
  if (separator < 0) return { link: null, body: "" };
  const header = stdout
    .slice(0, separator)
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().startsWith("link:"));
  return {
    link: header === undefined ? null : header.slice(header.indexOf(":") + 1).trim(),
    body: stdout.slice(separator).replace(/^\r?\n\r?\n/, ""),
  };
}

function compareIssueComments(left: IssueComment, right: IssueComment): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1;
  const leftId = Number(left.id);
  const rightId = Number(right.id);
  if (Number.isFinite(leftId) && Number.isFinite(rightId)) return leftId - rightId;
  return String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0;
}

/**
 * Page issue comments newest-first: a busy pull request can have far more history than one
 * poll may read, and walking pages 1..N forward permanently hides everything appended past
 * the budget. `Link` metadata locates the last page, `rel="next"` follows comments appended
 * after that discovery, and older pages backfill with whatever budget is left. Anything the
 * walk could not reach leaves `complete` false, so absence never reads as resolution.
 */
const fetchIssueComments = Effect.fn("fetchGitHubPullRequestIssueComments")(function* (input: {
  readonly github: typeof GitHubCli.Service;
  readonly cwd: string;
  readonly host: string;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly mapCliError: (error: GitHubCliError) => PullRequestProviderError;
}) {
  const byId = new Map<string, IssueComment>();
  const fetched = new Set<number>();
  let requests = 0;

  const readPage = (page: number) =>
    Effect.gen(function* () {
      const raw = yield* input.github
        .execute({
          cwd: input.cwd,
          args: [
            "api",
            "--include",
            "--hostname",
            input.host,
            "-H",
            "Accept: application/vnd.github+json",
            `repos/${input.owner}/${input.repository}/issues/${input.number}/comments?per_page=${ISSUE_COMMENT_PAGE_SIZE}&page=${page}`,
          ],
        })
        .pipe(Effect.mapError(input.mapCliError));
      const { link, body } = splitIncludedResponse(raw.stdout);
      const decoded = yield* decodeOrFail(
        IssueCommentsSchema,
        body.trim() === "" ? "[]" : body,
        "monitorSnapshot.issueComments",
      );
      for (const comment of decoded) {
        const id = String(comment.id);
        const previous = byId.get(id);
        // Overlapping reads are expected while the list shifts; the newest edit wins.
        if (previous === undefined || previous.updated_at <= comment.updated_at) {
          byId.set(id, comment);
        }
      }
      fetched.add(page);
      return {
        last: linkPage(link, "last"),
        // Hosts that omit Link metadata still page by full-page length.
        next:
          linkPage(link, "next") ?? (decoded.length === ISSUE_COMMENT_PAGE_SIZE ? page + 1 : null),
      };
    });

  const first = yield* readPage(1);
  requests += 1;
  let cursor = first.last !== null && first.last > 1 ? first.last : first.next;
  let unreadNewer = false;
  while (cursor !== null && !fetched.has(cursor)) {
    if (requests >= MAX_ISSUE_COMMENT_REQUESTS) {
      unreadNewer = true;
      break;
    }
    const page = yield* readPage(cursor);
    requests += 1;
    cursor = page.next;
  }

  const newest = Math.max(...fetched);
  for (let page = newest - 1; page >= 2; page--) {
    if (requests >= MAX_ISSUE_COMMENT_REQUESTS) break;
    if (fetched.has(page)) continue;
    yield* readPage(page);
    requests += 1;
  }

  const collected = [...byId.values()].sort(compareIssueComments);
  const retained = collected.slice(-MAX_RETAINED_ISSUE_COMMENTS);
  return {
    comments: retained,
    complete: !unreadNewer && fetched.size === newest && retained.length === collected.length,
  };
});

function nextPageUrl(url: string, page: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`;
}

export const fetchGitHubPullRequestMonitorSnapshot = Effect.fn(
  "fetchGitHubPullRequestMonitorSnapshot",
)(function* (input: {
  readonly cwd: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}) {
  const github = yield* GitHubCli;
  const [owner, ...rest] = input.repository.split("/");
  const name = rest.join("/");
  if (!owner || !name) {
    return yield* new PullRequestProviderError({
      provider: "github",
      operation: "monitorSnapshot",
      reason: "failed",
      detail: `Invalid repository identity: ${input.repository}`,
    });
  }

  const mapCliError = (error: GitHubCliError) =>
    new PullRequestProviderError({
      provider: "github",
      operation: "monitorSnapshot",
      reason: error.detail.includes("required but not available on PATH")
        ? "missing-tool"
        : error.detail.includes("not authenticated")
          ? "unauthenticated"
          : "failed",
      detail: error.detail,
      cause: error,
    });

  const pageRaw = yield* github
    .execute({
      cwd: input.cwd,
      args: [
        "api",
        "graphql",
        "--hostname",
        input.host,
        "-f",
        `query=${MONITOR_GRAPHQL}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${input.number}`,
      ],
    })
    .pipe(Effect.mapError(mapCliError));

  const page = yield* decodeOrFail(MonitorPageSchema, pageRaw.stdout, "monitorSnapshot.graphql");
  const pullRequest = page.data.repository?.pullRequest;
  if (!pullRequest) {
    return yield* new PullRequestProviderError({
      provider: "github",
      operation: "monitorSnapshot",
      reason: "failed",
      detail: `Pull request #${input.number} was not found on ${input.repository}.`,
    });
  }

  const headSha = pullRequest.headRefOid;
  const [ownerName, repoName] = [owner, name];

  const reviews = [...pullRequest.reviews.nodes];
  const reviewThreads = [...pullRequest.reviewThreads.nodes];
  let reviewsPageInfo = pullRequest.reviews.pageInfo;
  let reviewThreadsPageInfo = pullRequest.reviewThreads.pageInfo;
  let connectionPage = 1;
  while (
    connectionPage < MAX_PAGES &&
    (reviewsPageInfo.hasNextPage || reviewThreadsPageInfo.hasNextPage)
  ) {
    const raw = yield* github
      .execute({
        cwd: input.cwd,
        args: [
          "api",
          "graphql",
          "--hostname",
          input.host,
          "-f",
          `query=${MONITOR_CONNECTIONS_GRAPHQL}`,
          "-F",
          `owner=${owner}`,
          "-F",
          `name=${name}`,
          "-F",
          `number=${input.number}`,
          "-F",
          `reviewsCursor=${
            reviewsPageInfo.hasNextPage && reviewsPageInfo.endCursor
              ? reviewsPageInfo.endCursor
              : "{null}"
          }`,
          "-F",
          `threadsCursor=${
            reviewThreadsPageInfo.hasNextPage && reviewThreadsPageInfo.endCursor
              ? reviewThreadsPageInfo.endCursor
              : "{null}"
          }`,
        ],
      })
      .pipe(Effect.mapError(mapCliError));
    const decoded = yield* decodeOrFail(
      MonitorConnectionsPageSchema,
      raw.stdout,
      "monitorSnapshot.graphql.connections",
    );
    const connections = decoded.data.repository?.pullRequest;
    if (!connections) {
      return yield* new PullRequestProviderError({
        provider: "github",
        operation: "monitorSnapshot.graphql.connections",
        reason: "failed",
        detail: `Pull request #${input.number} disappeared while paginating.`,
      });
    }
    if (reviewsPageInfo.hasNextPage) reviews.push(...connections.reviews.nodes);
    if (reviewThreadsPageInfo.hasNextPage) {
      reviewThreads.push(...connections.reviewThreads.nodes);
    }
    reviewsPageInfo = reviewsPageInfo.hasNextPage ? connections.reviews.pageInfo : reviewsPageInfo;
    reviewThreadsPageInfo = reviewThreadsPageInfo.hasNextPage
      ? connections.reviewThreads.pageInfo
      : reviewThreadsPageInfo;
    connectionPage += 1;
  }

  const fetchCheckRuns = Effect.gen(function* () {
    const all = [];
    let totalCount = 0;
    let pageNumber = 1;
    for (; pageNumber <= MAX_PAGES; pageNumber += 1) {
      const raw = yield* github
        .execute({
          cwd: input.cwd,
          args: [
            "api",
            "--hostname",
            input.host,
            "-H",
            "Accept: application/vnd.github+json",
            nextPageUrl(`repos/${ownerName}/${repoName}/commits/${headSha}/check-runs`, pageNumber),
          ],
        })
        .pipe(Effect.mapError(mapCliError));
      const decoded = yield* decodeOrFail(CheckRunsSchema, raw.stdout, "monitorSnapshot.checkRuns");
      totalCount = decoded.total_count;
      all.push(...decoded.check_runs);
      if (all.length >= totalCount || decoded.check_runs.length < PAGE_SIZE) break;
    }
    return {
      total_count: totalCount,
      check_runs: all,
      complete: all.length >= totalCount,
    };
  });

  const fetchStatuses = Effect.gen(function* () {
    const all = [];
    let sha: string | undefined;
    let complete = false;
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      const raw = yield* github
        .execute({
          cwd: input.cwd,
          args: [
            "api",
            "--hostname",
            input.host,
            "-H",
            "Accept: application/vnd.github+json",
            nextPageUrl(`repos/${ownerName}/${repoName}/commits/${headSha}/status`, pageNumber),
          ],
        })
        .pipe(Effect.mapError(mapCliError));
      const decoded = yield* decodeOrFail(StatusesSchema, raw.stdout, "monitorSnapshot.statuses");
      const statuses = decoded.statuses ?? [];
      all.push(...statuses);
      sha = decoded.sha ?? sha;
      if (
        (decoded.total_count !== undefined && all.length >= decoded.total_count) ||
        statuses.length < PAGE_SIZE
      ) {
        complete = true;
        break;
      }
    }
    return { statuses: all, sha, complete };
  });

  // Keep the independent host reads serialized. Poll latency is higher, but each monitor runs
  // in the background and avoiding request bursts protects GitHub's secondary rate limit.
  const [issueCommentsDecoded, checkRunsDecoded, statusesDecoded] = yield* Effect.all(
    [
      fetchIssueComments({
        github,
        cwd: input.cwd,
        host: input.host,
        owner: ownerName,
        repository: repoName,
        number: input.number,
        mapCliError,
      }),
      fetchCheckRuns,
      fetchStatuses,
    ],
    { concurrency: 1 },
  );

  const normalizedReviews: PullRequestMonitorReview[] = reviews.map((review) => ({
    id: review.id,
    author: actorOf(review.author),
    state: normalizeReviewState(review.state),
    submittedAt: review.submittedAt,
    commitSha: review.commit?.oid ?? null,
    bodyExcerpt: excerpt(review.body),
  }));

  const normalizedReviewThreads: PullRequestMonitorReviewThread[] = reviewThreads.map((thread) => {
    const latest = thread.comments.nodes.at(-1);
    const first = thread.comments.nodes[0];
    return {
      id: thread.id,
      author: actorOf(latest?.author ?? first?.author ?? null),
      path: latest?.path ?? first?.path ?? null,
      line: latest?.line ?? first?.line ?? null,
      createdAt: first?.createdAt ?? latest?.createdAt ?? new Date(0).toISOString(),
      updatedAt: latest?.updatedAt ?? first?.updatedAt ?? new Date(0).toISOString(),
      resolved: thread.isResolved,
      latestCommentByViewer: latest?.viewerDidAuthor === true,
      bodyExcerpt: excerpt(latest?.body ?? first?.body),
    };
  });

  const viewerLogin = page.data.viewer.login;
  const issueComments: PullRequestMonitorIssueComment[] = issueCommentsDecoded.comments.map(
    (comment) => ({
      id: String(comment.id),
      author: actorOf(comment.user ? { login: comment.user.login } : null, comment.user?.type),
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      authoredByViewer: comment.user?.login === viewerLogin,
      bodyExcerpt: excerpt(comment.body),
    }),
  );

  const checkRuns: PullRequestMonitorCheckRun[] = [
    ...checkRunsDecoded.check_runs.map((run) => ({
      id: String(run.id),
      name: run.name,
      status: normalizeCheckStatus(run.status, run.conclusion),
      headSha: run.head_sha,
      url: run.html_url ?? null,
      description: run.output?.title ?? run.output?.summary ?? null,
    })),
    ...(statusesDecoded.statuses ?? []).map((status) => ({
      id: `status:${status.id}`,
      name: status.context,
      status: normalizeLegacyStatus(status.state),
      headSha,
      url: status.target_url,
      description: status.description,
    })),
  ];

  const fetchedAt = new Date().toISOString();
  const state = pullRequestState(pullRequest);
  const sourceRevision = sourceRevisionOf([
    headSha,
    state,
    String(pullRequest.isDraft),
    pullRequest.mergeable,
    ...normalizedReviews.map(
      (review) => `${review.id}:${review.state}:${review.submittedAt ?? ""}`,
    ),
    ...normalizedReviewThreads.map(
      (thread) => `${thread.id}:${thread.updatedAt}:${thread.resolved ? "1" : "0"}`,
    ),
    ...issueComments.map(
      (comment) => `${comment.id}:${comment.updatedAt}:${comment.authoredByViewer ? "1" : "0"}`,
    ),
    ...checkRuns.map((check) => `${check.id}:${check.status}:${check.headSha}`),
  ]);

  const snapshot: PullRequestMonitorSnapshot = {
    provider: "github",
    host: input.host,
    repository: input.repository,
    number: input.number,
    state,
    isDraft: pullRequest.isDraft,
    headSha,
    baseBranch: pullRequest.baseRefName,
    headBranch: pullRequest.headRefName,
    mergeability: mergeabilityOf(pullRequest.mergeable),
    behindBaseBy: null,
    titleExcerpt: excerpt(pullRequest.title, 200),
    url: pullRequest.url,
    fetchedAt,
    sourceRevision,
    completeness: {
      reviewsComplete: !reviewsPageInfo.hasNextPage,
      reviewThreadsComplete: !reviewThreadsPageInfo.hasNextPage,
      issueCommentsComplete: issueCommentsDecoded.complete,
      checksComplete: checkRunsDecoded.complete && statusesDecoded.complete,
      // GitHub check-runs endpoint is observed checks, not branch protection required set.
      requiredChecksKnown: false,
      // Base distance is informational and does not justify a REST request on every poll.
      baseComparisonKnown: false,
    },
    requiredCheckCoverage: {
      expected: [],
      observed: checkRuns.map((check) => ({
        name: check.name,
        status: check.status,
        headSha: check.headSha,
      })),
      completeness: "unknown",
    },
    reviews: normalizedReviews,
    reviewThreads: normalizedReviewThreads,
    issueComments,
    checkRuns,
  };

  return snapshot;
});
