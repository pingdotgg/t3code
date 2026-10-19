import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  PullRequestStackMembership,
  PullRequestAction,
  PullRequestStackHead,
  PullRequestActor,
  PullRequestBaseComparison,
  PullRequestCapabilities,
  PullRequestChecksState,
  PullRequestCheck,
  PullRequestChecks,
  PullRequestComment,
  PullRequestFileViewed,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestLabel,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestOmittedFileStat,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewDecision,
  PullRequestReviewThread,
  PullRequestThreadCommentsResult,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
  PullRequestReviewerKind,
  PullRequestLabelCandidateList,
  PullRequestState,
  PullRequestPreview,
  PullRequestUpdateMethod,
  PullRequestViewerPermissions,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { SourceControlProviderKind as SourceControlProviderKindSchema } from "@t3tools/contracts";

export class PullRequestProviderError extends Schema.TaggedError<PullRequestProviderError>()(
  "PullRequestProviderError",
  {
    provider: SourceControlProviderKindSchema,
    operation: Schema.String,
    reason: Schema.Literals([
      "missing-tool",
      "unauthenticated",
      "rate-limited",
      "not-found",
      "failed",
    ]),
    detail: Schema.String,
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

export interface ProviderChangeRequestWatchFingerprint {
  readonly status: string;
  readonly remarks: string;
}

export interface PullRequestProviderFailure {
  readonly reason: PullRequestProviderError["reason"];
  readonly retryAt?: number | undefined;
}

export interface ProviderChangeRequest {
  readonly stack?: PullRequestStackMembership;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt: string;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly reviewDecision?: PullRequestReviewDecision | null | undefined;
  readonly checksState?: PullRequestChecksState | null | undefined;
}

export interface ProviderChangeRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft?: boolean;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt: string;
  readonly author?: PullRequestActor | null | undefined;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  readonly changedFiles?: number | undefined;
  readonly reviewDecision?: PullRequestReviewDecision | null | undefined;
  readonly checksState?: PullRequestChecksState | null | undefined;
  readonly mergeability?: PullRequestMergeability | undefined;
  /**
   * Null when the host says it is in none; absent when the read did not ask.
   */
  readonly stack?: PullRequestStackMembership | null | undefined;
}

export interface ProviderChangeRequestStackLayer {
  readonly title?: string;
  readonly isDraft?: boolean;
  readonly headSha?: string;
  readonly number: number;
  readonly headBranch: string;
  readonly state: PullRequestState;
}

export interface ProviderChangeRequestStack {
  readonly id: string;
  readonly number: number;
  readonly url: string;
  readonly base: string;
  readonly layers: ReadonlyArray<ProviderChangeRequestStackLayer>;
}

export interface ProviderChangeRequestPage {
  readonly items: ReadonlyArray<ProviderChangeRequest>;
  readonly truncated: boolean;
  /**
   * Most hosts advance by the rows delivered after local de-duplication; an offset-paged host
   * may need to count malformed raw rows it consumed too.
   */
  readonly cursorAdvance?: number;
  readonly continues: boolean;
}

export interface ProviderListCursor {
  /**
   * Asked for inclusively: several rows share one instant often enough — a bot that touches eight
   * change requests writes one timestamp on all eight — and asking for strictly older would lose
   * whichever of them the slice ended before.
   */
  readonly updatedBefore: string;
  readonly delivered: number;
}

export interface ProviderBatchedChangeRequest extends ProviderChangeRequest {
  readonly repository: string;
}

export interface ProviderBatchedChangeRequestPage {
  readonly items: ReadonlyArray<ProviderBatchedChangeRequest>;
  readonly truncated: boolean;
}

export interface ProviderChangeRequestStat {
  readonly repository: string;
  readonly number: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface ProviderChangeRequestDetail extends ProviderChangeRequest {
  readonly headSha?: string | null;
  readonly body: string;
  readonly changedFiles: number;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly mergeCapabilities: PullRequestMergeCapabilities;
  readonly viewerPermissions: PullRequestViewerPermissions;
  readonly baseComparison?: PullRequestBaseComparison;
  readonly behindBy?: number;
  readonly autoMergeEnabled?: boolean;
  readonly autoMergeMethod?: PullRequestMergeMethod;
  readonly workflowApprovalsRequired?: number;
}

export interface ProviderChangeRequestActivity {
  readonly author?: PullRequestActor | null;
  readonly reviewers?: ReadonlyArray<PullRequestActor>;
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly commentCount: number;
  readonly commentsTruncated: boolean;
  readonly reviewThreadsTruncated?: boolean;
  readonly reviewThreads: ReadonlyArray<PullRequestReviewThread>;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly reactions?: ReadonlyArray<PullRequestReaction>;
}

export interface ProviderDiffSlice {
  readonly patch: string;
  /** Something in this slice could not be shown, as opposed to there being more slices. */
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats?: ReadonlyArray<PullRequestOmittedFileStat>;
}

export interface ProviderDiffFileContents {
  readonly oldContents: string;
  readonly newContents: string;
}

export interface ProviderFilesViewed {
  readonly files: ReadonlyArray<PullRequestFileViewed>;
  /** The host has more files than were read, so the ones missing here are not "unviewed". */
  readonly truncated: boolean;
}

/**
 * Opaque strings, compared only against one another, where the empty string is the answer for a
 * file the change request deletes rather than a gap. A path is absent only where the read could
 * not say, so a provider converts its host's own absences on the way here.
 */
export interface ProviderFileRevisions {
  readonly revisions: ReadonlyMap<string, string>;
  /**
   * A host with no per-file version reads the whole change to answer for one file, and saying so
   * is what keeps the next tick, naming a path nothing asked about before, from making it read
   * the whole change again. False for a read cut short, which cannot speak past the cut.
   */
  readonly complete?: boolean;
}

export interface ProviderRepositoryRef {
  readonly cwd: string;
  readonly repository: string;
  readonly host: string;
}

export interface PullRequestProviderApi {
  readonly withVerifiedCredential?: <A, E, R>(
    input: { readonly cwd: string; readonly host: string },
    use: (identity: {
      readonly accountId: string;
      readonly viewer: string;
      readonly credentialFingerprint: string;
    }) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PullRequestProviderError, R>;
  readonly getRoutingIdentity?: (input: {
    readonly cwd: string;
    readonly host: string;
  }) => Effect.Effect<
    { readonly accountId: string; readonly viewer: string },
    PullRequestProviderError
  >;
  readonly kind: SourceControlProviderKind;
  readonly capabilities: PullRequestCapabilities;
  readonly mergeMessageRewrite?: (message: string) => string;
  /**
   * Absent means `owner/name` on the host identifies it, and any checkout on the host can serve a
   * change request in another repository there.
   *
   * A host that resolves it (Azure DevOps: `dev.azure.com/org/project/_git/repo`) derives its
   * organization from the checkout, so only a checkout whose key matches the reference serves it.
   */
  readonly repositoryKey?: (input: { readonly canonicalKey: string }) => string;

  readonly getViewer: (input: {
    readonly cwd: string;
    readonly host?: string;
  }) => Effect.Effect<string, PullRequestProviderError>;

  readonly listChangeRequests: (
    input: ProviderRepositoryRef & {
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /**
       * A host with no text filter of its own ignores it and answers with the page it
       * would have answered with anyway — the caller narrows what it gets, so an
       * unfiltered page is a wider answer rather than a wrong one.
       */
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
      /**
       * Further narrowings, which a host applies as far as it can and ignores the rest of —
       * an unnarrowed page is a wider answer rather than a wrong one, and the caller narrows
       * what it gets for the fields a row carries.
       */
      readonly filters?: PullRequestListFilters | undefined;
    },
  ) => Effect.Effect<ProviderChangeRequestPage, PullRequestProviderError>;

  /**
   * `limit` is the whole slice rather than a size per repository, because that is the shape of
   * the answer: the newest `limit` rows across every repository named, which is exactly the
   * rows a page ordered by update shows. `cursor` is one boundary for all of them, so a caller
   * with repositories standing at different boundaries asks in groups rather than in one call.
   */
  readonly listChangeRequestsAcross?: (input: {
    readonly cwd: string;
    readonly host: string;
    readonly repositories: ReadonlyArray<string>;
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly limit: number;
    readonly query?: string | undefined;
    readonly cursor?: ProviderListCursor | undefined;
    readonly filters?: PullRequestListFilters | undefined;
  }) => Effect.Effect<ProviderBatchedChangeRequestPage, PullRequestProviderError>;

  readonly listChangeRequestStats?: (input: {
    readonly cwd: string;
    readonly host: string;
    readonly changeRequests: ReadonlyArray<{
      readonly repository: string;
      readonly number: number;
    }>;
  }) => Effect.Effect<ReadonlyArray<ProviderChangeRequestStat>, PullRequestProviderError>;

  readonly getChangeRequestChecks?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestChecks, PullRequestProviderError>;

  readonly getChangeRequest: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestDetail, PullRequestProviderError>;

  readonly getChangeRequestPreview?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<
    Omit<PullRequestPreview, "projectId" | "repository">,
    PullRequestProviderError
  >;

  readonly getChangeRequestSummary?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestSummary, PullRequestProviderError>;

  /**
   * Null when the host gave no answer for it. Optional: a host without one has
   * its watched change requests read in full on every pass.
   */
  readonly getChangeRequestWatchFingerprint?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestWatchFingerprint | null, PullRequestProviderError>;

  readonly getChangeRequestStack?: (
    input: ProviderRepositoryRef & { readonly includeDetails?: boolean; readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestStack | null, PullRequestProviderError>;

  readonly getChangeRequestActivity: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestActivity, PullRequestProviderError>;

  readonly getReviewThreadComments?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly cursor: string;
    },
  ) => Effect.Effect<PullRequestThreadCommentsResult, PullRequestProviderError>;

  /**
   * Asked before anything is written, so a request that reached the server without going past
   * the page is refused by what the host says rather than by what the client claimed — and
   * asked freshly, because access granted or taken away since the page loaded is exactly the
   * case this guards.
   */
  readonly getViewerPermissions: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly includeUpdateBranch?: boolean;
    },
  ) => Effect.Effect<PullRequestViewerPermissions, PullRequestProviderError>;

  readonly getDiff: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly cursor?: string | undefined;
      readonly commit?: string | undefined;
    },
  ) => Effect.Effect<ProviderDiffSlice, PullRequestProviderError>;

  readonly getDiffFileContents?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly commit?: string | undefined;
      readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
      readonly oldPath: string;
      readonly newPath: string;
    },
  ) => Effect.Effect<ProviderDiffFileContents, PullRequestProviderError>;

  readonly getFilesViewed?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderFilesViewed, PullRequestProviderError>;

  /**
   * A host with no bulk form is still owed one round trip for the batch rather than one per
   * file, since the point of gathering presses is that the host is asked once.
   */
  readonly setFilesViewed?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly files: ReadonlyArray<{ readonly path: string; readonly viewed: boolean }>;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * Required of a host whose `capabilities.viewedFiles` is `"environment"`, and unused by one
   * that keeps the marks itself: the marks live here, but only the host can say whether what a
   * reader cleared last week is still what is in front of them.
   */
  readonly getFileRevisions?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly paths: ReadonlyArray<string>;
    },
  ) => Effect.Effect<ProviderFileRevisions, PullRequestProviderError>;

  readonly runAction: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly action: PullRequestAction;
      readonly stackNumber?: number;
      readonly expectedStackHeads?: ReadonlyArray<PullRequestStackHead>;
      readonly removeAgentCreditsOnMerge?: boolean;
      readonly mergeMethod?: PullRequestMergeMethod;
      readonly updateMethod?: PullRequestUpdateMethod;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * Only called when `capabilities.edit.changeRequest` is true, and never with both fields
   * absent — the caller refuses that before it gets here, because a host asked to change
   * nothing answers differently on each of them.
   */
  readonly updateChangeRequest?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly comment: (
    input: ProviderRepositoryRef & { readonly number: number; readonly body: string },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * Whether this remark is the reader's to rewrite is the host's own answer: no read here can
   * settle it, since access can be taken away between the conversation being read and the
   * rewrite being sent, and a host refuses a stranger's remark with a sentence saying so.
   */
  readonly updateComment?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly commentId: string;
      readonly kind: "issue-comment" | "review-comment";
      readonly body: string;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly submitReview: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * The author is left out by each provider rather than by the caller, because only the
   * provider knows how the host spells the same person in a candidate list and on a pull
   * request.
   */
  readonly listReviewerCandidates: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestReviewerCandidateList, PullRequestProviderError>;

  readonly setReviewerRequest: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly reviewers: ReadonlyArray<{
        readonly id: string;
        readonly kind: PullRequestReviewerKind;
      }>;
      readonly requested: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly listLabelCandidates?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestLabelCandidateList, PullRequestProviderError>;

  readonly setLabels?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly labels: ReadonlyArray<string>;
      readonly applied: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly replyToThread: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly body: string;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * `subjectId` is a remark's id as the conversation carried it; absent means the change
   * request itself, whose reactions sit on its description.
   */
  readonly setReaction: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly subjectId?: string | undefined;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly setThreadResolution: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly resolved: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;
}
