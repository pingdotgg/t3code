import { isCommitSha } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestReviewCommentDraft,
  PullRequestReviewPosition,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
} from "@t3tools/contracts";

import * as BitbucketApi from "./BitbucketApi.ts";
import { parseDiffFileRevisions } from "@t3tools/source-control-core/server/diffFileRevisions";
import { sortChecks } from "@t3tools/source-control-core/server/pullRequestChecks";
import {
  buildReviewThreads,
  decodeCommentsJson,
  decodeCommitsJson,
  decodeConflictsJson,
  decodeDiffstatJson,
  decodePullRequestJson,
  decodePullRequestPageJson,
  decodeRepositoryPermissionJson,
  decodeStatusesJson,
  decodeViewerJson,
  decodeWorkspaceMembersJson,
  type BitbucketDiffStat,
  type BitbucketPullRequest,
  type BitbucketRawComment,
} from "./bitbucketPullRequestJson.ts";
import type { ProviderListCursor } from "@t3tools/source-control-core/server/PullRequestProvider";
import { makeBitbucketApi } from "./bitbucketApiMake.ts";

export class BitbucketPullRequestReadError extends Schema.TaggedError<BitbucketPullRequestReadError>()(
  "BitbucketPullRequestReadError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Bitbucket returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `Bitbucket failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketViewerUnavailableError extends Schema.TaggedError<BitbucketViewerUnavailableError>()(
  "BitbucketViewerUnavailableError",
  {},
) {
  get detail(): string {
    return "Bitbucket returned no account name for the configured credentials.";
  }

  override get message(): string {
    return `Bitbucket failed in getViewer: ${this.detail}`;
  }
}

export class BitbucketRepositoryUnsupportedError extends Schema.TaggedError<BitbucketRepositoryUnsupportedError>()(
  "BitbucketRepositoryUnsupportedError",
  {
    repository: Schema.String,
  },
) {
  get detail(): string {
    return "A Bitbucket repository is addressed as workspace/repository.";
  }

  override get message(): string {
    return `Bitbucket failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketDiffCommitError extends Schema.TaggedError<BitbucketDiffCommitError>()(
  "BitbucketDiffCommitError",
  {},
) {
  get detail(): string {
    return "The named commit was not a commit sha.";
  }

  override get message(): string {
    return `Bitbucket failed in getPullRequestDiff: ${this.detail}`;
  }
}

export type BitbucketPullRequestApiError =
  | BitbucketApi.BitbucketApiError
  | BitbucketPullRequestReadError
  | BitbucketViewerUnavailableError
  | BitbucketRepositoryUnsupportedError
  | BitbucketDiffCommitError;

export function isRepositoryPermissionUnavailableError(
  error: BitbucketPullRequestApiError,
): error is BitbucketApi.BitbucketResponseError {
  return (
    error._tag === "BitbucketResponseError" &&
    (error.status === 403 || error.status === 404 || error.status === 410)
  );
}

/** Requests above this size return an empty page without an error. */
export const MAX_PAGE_SIZE = 50;
export const MAX_LIST_PAGES = 10;
export const CONVERSATION_PAGE_SIZE = 50;
export const CONVERSATION_PAGES = 10;
export const DIFF_MAX_BYTES = 8 * 1024 * 1024;
/** Must expire before the caller's version cache so refreshes reach Bitbucket. */
export const REVISION_PATCH_TTL = Duration.seconds(5);
export const REVISION_PATCH_CAPACITY = 16;
export const encodeRevisionKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Number])),
);
export interface BitbucketPullRequestBatch {
  readonly items: ReadonlyArray<BitbucketPullRequest>;
  readonly truncated: boolean;
}

export class BitbucketPullRequestApi extends Context.Service<
  BitbucketPullRequestApi,
  {
    readonly getViewer: () => Effect.Effect<string, BitbucketPullRequestApiError>;

    readonly listPullRequests: (input: {
      readonly repository: string;
      readonly state: PullRequestListState;
      readonly limit: number;
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
      /** Matched against the login a row shows, which is the nickname or else the display name. */
      readonly author?: string | undefined;
      readonly draft?: boolean | undefined;
    }) => Effect.Effect<BitbucketPullRequestBatch, BitbucketPullRequestApiError>;

    readonly getPullRequest: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<BitbucketPullRequest, BitbucketPullRequestApiError>;

    readonly getRepositoryPermission: (input: {
      readonly repository: string;
    }) => Effect.Effect<boolean, BitbucketPullRequestApiError>;

    readonly getPullRequestDiff: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commit?: string | undefined;
    }) => Effect.Effect<
      { readonly patch: string; readonly truncated: boolean },
      BitbucketPullRequestApiError
    >;

    readonly getDiffStat: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<BitbucketDiffStat, BitbucketPullRequestApiError>;

    /** Truncated patches cannot identify absent paths as deleted. */
    readonly getFileRevisions: (input: {
      readonly repository: string;
      readonly number: number;
      readonly paths: ReadonlyArray<string>;
    }) => Effect.Effect<
      { readonly revisions: ReadonlyMap<string, string>; readonly complete: boolean },
      BitbucketPullRequestApiError
    >;

    readonly getMergeability: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestMergeability, BitbucketPullRequestApiError>;

    readonly listComments: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      {
        readonly comments: ReadonlyArray<PullRequestComment>;
        readonly threads: ReadonlyArray<PullRequestReviewThread>;
        readonly truncated: boolean;
      },
      BitbucketPullRequestApiError
    >;

    readonly listCommits: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCommit>, BitbucketPullRequestApiError>;

    readonly listChecks: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCheck>, BitbucketPullRequestApiError>;

    readonly listReviewerCandidates: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestReviewerCandidateList, BitbucketPullRequestApiError>;

    readonly setReviewerRequest: (input: {
      readonly repository: string;
      readonly number: number;
      readonly reviewers: ReadonlyArray<{ readonly id: string }>;
      readonly requested: boolean;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;

    readonly runAction: (input: {
      readonly repository: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;

    readonly updateChangeRequest: (input: {
      readonly repository: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;

    readonly comment: (input: {
      readonly repository: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;

    readonly updateComment: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commentId: string;
      readonly body: string;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;

    readonly submitReview: (input: {
      readonly repository: string;
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;

    readonly replyToComment: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commentId: string;
      readonly body: string;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;

    readonly setCommentResolution: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commentId: string;
      readonly resolved: boolean;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;
  }
>()("@t3tools/source-control-bitbucket/server/BitbucketPullRequestApi") {}

export function repositorySegments(
  repository: string,
): Result.Result<
  { readonly workspace: string; readonly slug: string },
  BitbucketRepositoryUnsupportedError
> {
  const segments = repository
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const [workspace, slug] = segments;
  if (segments.length !== 2 || workspace === undefined || slug === undefined) {
    return Result.fail(new BitbucketRepositoryUnsupportedError({ repository }));
  }
  return Result.succeed({ workspace, slug });
}

export function repositoryPathOf(segments: { readonly workspace: string; readonly slug: string }): string {
  return `/repositories/${encodeURIComponent(segments.workspace)}/${encodeURIComponent(
    segments.slug,
  )}`;
}

export function stateParams(state: PullRequestListState): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return ["OPEN"];
    case "merged":
      return ["MERGED"];
    case "closed":
      return ["DECLINED", "SUPERSEDED"];
    case "all":
      return ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"];
  }
}

export function searchFilter(query: string): string {
  const literal = filterLiteral(query);
  return `(title ~ "${literal}" OR description ~ "${literal}")`;
}

export function authorFilter(login: string): string {
  const literal = filterLiteral(login);
  return `(author.nickname = "${literal}" OR author.display_name = "${literal}")`;
}

/**
 * The backslash is escaped first, or escaping the quote would only produce a literal
 * backslash followed by a live quote.
 */
export function filterLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

// Bitbucket keeps microseconds; include the cursor's whole millisecond before excluding seen IDs.
export function updatedBeforeFilter(updatedBefore: string): string {
  return Option.match(DateTime.make(updatedBefore), {
    onNone: () => `updated_on <= ${updatedBefore}`,
    onSome: (instant) =>
      `updated_on < ${DateTime.formatIso(DateTime.add(instant, { milliseconds: 1 }))}`,
  });
}

export function mergeStrategy(method: PullRequestMergeMethod | undefined): string {
  switch (method) {
    case "squash":
      return "squash";
    case "rebase":
      return "rebase_fast_forward";
    default:
      return "merge_commit";
  }
}

export function bitbucketReviewPosition(
  position: PullRequestReviewPosition,
): { readonly from: number } | { readonly to: number } {
  switch (position.kind) {
    case "added":
      return { to: position.newLine };
    case "deleted":
      return { from: position.oldLine };
    case "context":
      return position.side === "left" ? { from: position.oldLine } : { to: position.newLine };
  }
}

/** @public */
export type BitbucketPullRequestApiShape = Parameters<typeof BitbucketPullRequestApi.of>[0];

export const make = makeBitbucketApi.pipe(Effect.map((impl) => BitbucketPullRequestApi.of(impl)));
export const layer = Layer.effect(BitbucketPullRequestApi, make);