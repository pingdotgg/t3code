import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestReviewAuthor,
  PullRequestReviewComment,
  PullRequestReviewResult,
  PullRequestReviewSummary,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

const RawAuthor = Schema.NullOr(
  Schema.Struct({
    __typename: Schema.optional(Schema.String),
    login: Schema.String,
    avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

const RawCommentFields = {
  id: Schema.String,
  author: RawAuthor,
  authorAssociation: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.String,
  url: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
} as const;

const RawComment = Schema.Struct(RawCommentFields);
const RawReview = Schema.Struct({
  ...RawCommentFields,
  state: Schema.String,
});

const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
});

const RawThread = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
  originalLine: Schema.NullOr(Schema.Number),
  diffSide: Schema.NullOr(Schema.String),
  comments: Schema.Struct({
    nodes: Schema.Array(Schema.NullOr(RawComment)),
    pageInfo: PageInfo,
  }),
});

const RawGitHubPullRequestReview = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({
        number: Schema.Number,
        url: Schema.String,
        comments: Schema.Struct({
          nodes: Schema.Array(Schema.NullOr(RawComment)),
          pageInfo: PageInfo,
        }),
        reviews: Schema.Struct({
          nodes: Schema.Array(Schema.NullOr(RawReview)),
          pageInfo: PageInfo,
        }),
        reviewThreads: Schema.Struct({
          nodes: Schema.Array(Schema.NullOr(RawThread)),
          pageInfo: PageInfo,
        }),
      }),
    }),
  }),
});

const decodeRawGitHubPullRequestReview = decodeJsonResult(RawGitHubPullRequestReview);

type RawCommentValue = Schema.Schema.Type<typeof RawComment>;
type RawReviewValue = Schema.Schema.Type<typeof RawReview>;
type RawThreadValue = Schema.Schema.Type<typeof RawThread>;

function normalizeAuthor(raw: Schema.Schema.Type<typeof RawAuthor>): PullRequestReviewAuthor {
  const login = raw?.login.trim() || "ghost";
  const typename = raw?.__typename?.trim().toLowerCase();
  return {
    login,
    avatarUrl: raw?.avatarUrl?.trim() || null,
    isBot: typename === "bot" || login.toLowerCase().endsWith("[bot]"),
  };
}

function normalizeComment(raw: RawCommentValue): PullRequestReviewComment {
  return {
    id: raw.id.trim(),
    author: normalizeAuthor(raw.author),
    authorAssociation: raw.authorAssociation?.trim() || null,
    body: raw.body,
    url: raw.url.trim(),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function normalizeReview(raw: RawReviewValue): PullRequestReviewSummary {
  return {
    ...normalizeComment(raw),
    state: raw.state.trim().toUpperCase() || "COMMENTED",
  };
}

function normalizeLine(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeThread(raw: RawThreadValue): PullRequestReviewThread {
  const diffSide = raw.diffSide?.trim().toUpperCase();
  return {
    id: raw.id.trim(),
    isResolved: raw.isResolved,
    isOutdated: raw.isOutdated,
    path: raw.path.trim(),
    line: normalizeLine(raw.line),
    originalLine: normalizeLine(raw.originalLine),
    diffSide: diffSide === "LEFT" || diffSide === "RIGHT" ? diffSide : null,
    comments: raw.comments.nodes
      .filter((comment): comment is RawCommentValue => comment !== null)
      .map(normalizeComment),
  };
}

export function decodeGitHubPullRequestReviewJson(
  raw: string,
): Result.Result<PullRequestReviewResult, Cause.Cause<Schema.SchemaError>> {
  const decoded = decodeRawGitHubPullRequestReview(raw);
  if (Result.isFailure(decoded)) {
    return Result.fail(decoded.failure);
  }

  const pullRequest = decoded.success.data.repository.pullRequest;
  const rawThreads = pullRequest.reviewThreads.nodes.filter(
    (thread): thread is RawThreadValue => thread !== null,
  );
  const threads = rawThreads.map(normalizeThread);
  const nestedCommentsTruncated = rawThreads.some((thread) => thread.comments.pageInfo.hasNextPage);

  return Result.succeed({
    provider: "github",
    number: pullRequest.number,
    url: pullRequest.url.trim(),
    comments: pullRequest.comments.nodes
      .filter((comment): comment is RawCommentValue => comment !== null)
      .map(normalizeComment),
    reviews: pullRequest.reviews.nodes
      .filter(
        (review): review is RawReviewValue => review !== null && review.body.trim().length > 0,
      )
      .map(normalizeReview),
    threads,
    unresolvedThreadCount: threads.filter((thread) => !thread.isResolved && !thread.isOutdated)
      .length,
    truncated:
      pullRequest.comments.pageInfo.hasNextPage ||
      pullRequest.reviews.pageInfo.hasNextPage ||
      pullRequest.reviewThreads.pageInfo.hasNextPage ||
      nestedCommentsTruncated,
  });
}
