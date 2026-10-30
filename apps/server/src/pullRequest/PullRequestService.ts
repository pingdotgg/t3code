import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import { parseDiffFilePaths } from "@t3tools/source-control-core/server/diffFileRevisions";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  resolvePullRequestAuthorFilter,
  type OrchestrationProjectShell,
  type ProjectId,
  type PullRequestAction,
  type PullRequestActionInput,
  type PullRequestActivity,
  type PullRequestCommentInput,
  type PullRequestCommentUpdateInput,
  type PullRequestDetail,
  type PullRequestPreview,
  type PullRequestChecks,
  type PullRequestDiffFileContentsInput,
  type PullRequestDiffFileContentsResult,
  type PullRequestDiffStat,
  type PullRequestDiffInput,
  type PullRequestChangeBreakdown,
  type PullRequestFilesViewedResult,
  type PullRequestDiffResult,
  type PullRequestInvalidateInput,
  type PullRequestReportStateInput,
  type PullRequestListEntry,
  type PullRequestListFilters,
  type PullRequestListInput,
  type PullRequestListProjectError,
  type PullRequestListResult,
  type PullRequestListStatsInput,
  type PullRequestFilterOptions,
  type PullRequestFilterOptionsInput,
  type PullRequestActor,
  type PullRequestLabel,
  type PullRequestListStatsResult,
  type PullRequestProviderSummary,
  type PullRequestReactionInput,
  type PullRequestRef,
  type PullRequestRoutingResult,
  type PullRequestRoutingIdentityInput,
  type PullRequestRoutingIdentityResult,
  type PullRequestReviewVerdict,
  type PullRequestReviewerCandidateList,
  type PullRequestReviewerRequestInput,
  type PullRequestLabelCandidateList,
  type PullRequestLabelChangeInput,
  type PullRequestSetFilesViewedInput,
  type PullRequestState,
  type PullRequestSubmitReviewInput,
  PullRequestStack,
  PullRequestSummary,
  type PullRequestThreadReplyInput,
  type PullRequestThreadResolutionInput,
  type PullRequestThreadCommentsInput,
  type PullRequestThreadCommentsResult,
  type PullRequestUpdateInput,
  type SourceControlProviderInfo,
  SourceControlProviderKind,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import type { SourceControlProviderContext } from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  type ProviderChangeRequest,
  type ProviderDiffFilePaths,
  type ProviderFilterOptionPage,
  type ProviderListCursor,
  type ProviderChangeRequestWatchFingerprint,
  type PullRequestProviderApi,
  PullRequestProviderError,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as ViewedFiles from "./pullRequestViewedFiles.ts";
import { toChangeBreakdown } from "./pullRequestChangeBreakdown.ts";

export interface PullRequestMergeEvent extends PullRequestRef {
  readonly mergedAt: string;
}

type PullRequestReading = Pick<
  PullRequestSummary,
  "state" | "isDraft" | "updatedAt" | "observedAt"
>;

function supersedesReading(current: PullRequestReading | undefined, next: PullRequestReading) {
  if (current === undefined) return true;
  if (current.state === "merged" && next.state !== "merged") return false;
  if (next.updatedAt !== current.updatedAt) return next.updatedAt > current.updatedAt;
  return (next.observedAt ?? -Infinity) >= (current.observedAt ?? -Infinity);
}

// Providers request one extra row; 99 stays within GitHub/GitLab's 100-row API limit.
const DEFAULT_REPOSITORY_LIST_LIMIT = 99;
const REPOSITORY_CONCURRENCY = 12;
const REPOSITORY_SEARCH_CHUNK = 100;
const FILTERED_LIST_READS = 5;

// Host reads spawn CLIs and hit low quotas; briefly share results and identical in-flight reads.
const LIST_CACHE_TTL = Duration.seconds(30);
const DETAIL_CACHE_TTL = Duration.seconds(60);
const MERGED_DETAIL_CACHE_TTL = Duration.minutes(10);
const detailTimeToLive = (state: PullRequestState | undefined) =>
  state === "merged" ? MERGED_DETAIL_CACHE_TTL : DETAIL_CACHE_TTL;
const CHECKS_CACHE_TTL = Duration.seconds(15);
const REPORTED_STATE_DEDUPE_MS = 5 * 60 * 1_000;
const DIFF_CACHE_TTL = Duration.seconds(60);
const COMMIT_DIFF_CACHE_TTL = Duration.minutes(10);
const LIST_STATS_CACHE_TTL = Duration.seconds(60);
const FILES_VIEWED_CACHE_TTL = Duration.seconds(15);
const DIFF_STALE_WINDOW = Duration.minutes(10);
const DIFF_SWEEP_INTERVAL = Duration.minutes(1);
const VIEWER_CACHE_TTL = Duration.minutes(10);
const STALE_DETAIL_WINDOW = Duration.minutes(10);
const isPullRequestProviderError = Schema.is(PullRequestProviderError);
const LIST_CACHE_CAPACITY = 64;
const LIST_STATS_CACHE_CAPACITY = 32;
const DETAIL_CACHE_CAPACITY = 128;
const DIFF_CACHE_CAPACITY = 128;
// Each holder stays within this UTF-16 patch budget as well as its entry-count bound.
const DIFF_CACHE_PATCH_BUDGET_BYTES = 32 * 1024 * 1024;
const canCacheDiff = (value: PullRequestDiffResult) =>
  value.patch.length * 2 <= DIFF_CACHE_PATCH_BUDGET_BYTES;
const diffCacheEvictions = (entries: Iterable<readonly [string, PullRequestDiffResult]>) => {
  let bytes = 0;
  const evictions: string[] = [];
  for (const [key, value] of Array.from(entries).toReversed()) {
    const size = value.patch.length * 2;
    if (bytes + size > DIFF_CACHE_PATCH_BUDGET_BYTES) {
      evictions.push(key);
    } else {
      bytes += size;
    }
  }
  return evictions;
};
const FILES_VIEWED_CACHE_CAPACITY = 128;
const VIEWER_CACHE_CAPACITY = 32;

export type PullRequestError = PullRequestUnavailableError | PullRequestOperationError;

const routingCredential = Context.Reference<{
  readonly credentialFingerprint: string;
  readonly viewer: string;
} | null>("t3/PullRequestService/routingCredential", { defaultValue: () => null });
const credentialNamespace = Symbol("pullRequestCredentialNamespace");
type CredentialRef = PullRequestRef & { readonly [credentialNamespace]?: string };

export class PullRequestService extends Context.Service<
  PullRequestService,
  {
    readonly list: (
      input: PullRequestListInput,
    ) => Effect.Effect<PullRequestListResult, PullRequestError>;
    readonly listStats: (
      input: PullRequestListStatsInput,
    ) => Effect.Effect<PullRequestListStatsResult, PullRequestError>;
    readonly filterOptions: (
      input: PullRequestFilterOptionsInput,
    ) => Effect.Effect<PullRequestFilterOptions, PullRequestError>;
    readonly routing: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestRoutingResult, PullRequestError>;
    readonly routingIdentity: (
      input: PullRequestRoutingIdentityInput,
    ) => Effect.Effect<PullRequestRoutingIdentityResult, PullRequestError>;
    readonly withRoutingCredential: <A, E, R>(
      input: PullRequestRef,
      operation: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | PullRequestError, R>;
    readonly summary: (
      input: PullRequestRef,
      options?: { readonly recoverTransientFailure?: boolean },
    ) => Effect.Effect<PullRequestSummary, PullRequestError>;
    readonly stack: (
      input: PullRequestRef,
      options?: { readonly includeDetails?: boolean },
    ) => Effect.Effect<PullRequestStack | null, PullRequestError>;
    readonly subscribeMerges: Effect.Effect<
      Stream.Stream<PullRequestMergeEvent>,
      never,
      Scope.Scope
    >;
    readonly subscribeStateChanges: Effect.Effect<
      Stream.Stream<ThreadPullRequestKey>,
      never,
      Scope.Scope
    >;
    readonly reportState: (
      input: PullRequestReportStateInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly subscribeRefreshes: Stream.Stream<number>;
    readonly refreshAfterTurn: (projectId: ProjectId) => Effect.Effect<void>;
    readonly detail: (input: PullRequestRef) => Effect.Effect<PullRequestDetail, PullRequestError>;
    readonly preview: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestPreview, PullRequestError>;
    readonly checks: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestChecks | null, PullRequestError>;
    readonly watchFingerprint: (
      input: PullRequestRef,
    ) => Effect.Effect<ProviderChangeRequestWatchFingerprint | null, PullRequestError>;
    readonly activity: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestActivity, PullRequestError>;
    readonly threadComments: (
      input: PullRequestThreadCommentsInput,
    ) => Effect.Effect<PullRequestThreadCommentsResult, PullRequestError>;
    readonly diff: (
      input: PullRequestDiffInput,
    ) => Effect.Effect<PullRequestDiffResult, PullRequestError>;
    readonly diffFileContents: (
      input: PullRequestDiffFileContentsInput,
    ) => Effect.Effect<PullRequestDiffFileContentsResult, PullRequestError>;
    readonly filesViewed: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestFilesViewedResult, PullRequestError>;
    readonly setFilesViewed: (
      input: PullRequestSetFilesViewedInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly changeBreakdown: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestChangeBreakdown, PullRequestError>;
    readonly runAction: (input: PullRequestActionInput) => Effect.Effect<void, PullRequestError>;
    readonly update: (input: PullRequestUpdateInput) => Effect.Effect<void, PullRequestError>;
    readonly comment: (input: PullRequestCommentInput) => Effect.Effect<void, PullRequestError>;
    readonly updateComment: (
      input: PullRequestCommentUpdateInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly submitReview: (
      input: PullRequestSubmitReviewInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly replyToThread: (
      input: PullRequestThreadReplyInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly setThreadResolution: (
      input: PullRequestThreadResolutionInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly setReaction: (
      input: PullRequestReactionInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly reviewerCandidates: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestReviewerCandidateList, PullRequestError>;
    readonly requestReviewers: (
      input: PullRequestReviewerRequestInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly labelCandidates: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestLabelCandidateList, PullRequestError>;
    readonly setLabels: (
      input: PullRequestLabelChangeInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly invalidate: (
      input: PullRequestInvalidateInput,
      options?: { readonly notifyReaders?: boolean },
    ) => Effect.Effect<void>;
  }
>()("t3/pullRequest/PullRequestService") {}

const VERDICT_LABELS: Record<PullRequestReviewVerdict, string> = {
  comment: "review",
  approve: "approve",
  "request-changes": "request changes on",
};

const ACTION_ACCESS_REFUSALS: Record<PullRequestAction, string> = {
  merge: "You need write access on this repository to merge.",
  ready:
    "You need write access on this repository, or to have opened this change request, to mark it ready for review.",
  draft:
    "You need write access on this repository, or to have opened this change request, to return it to a draft.",
  close:
    "You need write access on this repository, or to have opened this change request, to close it.",
  "update-branch":
    "You need write access on this repository, or to have opened this change request, to update its branch.",
  reopen:
    "You need write access on this repository, or to have opened this change request, to reopen it.",
  "enable-auto-merge":
    "Auto-merge needs write access on this repository, and the repository has to allow it.",
  "disable-auto-merge":
    "You need write access on this repository to stop it being merged for you once it is ready.",
  revert: "You need write access on this repository to open a revert pull request.",
  "delete-branch": "You need write access on the source repository to delete its branch.",
  "approve-workflows":
    "You need write access on this repository to approve workflows from a fork pull request.",
};

const REVIEWER_REQUEST_REFUSAL = "You need write access on this repository to ask for a review.";
const LABEL_CHANGE_REFUSAL = "You need triage access on this repository to change its labels.";

export interface SupportedProject {
  readonly cursorKey: string;
  readonly project: OrchestrationProjectShell;
  readonly api: PullRequestProviderApi;
  readonly repository: string;
  readonly host: string;
  /** Unlike Azure repository names, remotes are unique across an organization. */
  readonly remote: string;
  readonly repositoryKey: string | null;
}

interface WorkspaceProjects {
  readonly supported: ReadonlyArray<SupportedProject>;
  readonly unimplemented: ReadonlyMap<
    string,
    { readonly kind: SourceControlProviderKind; readonly projectCount: number }
  >;
  readonly viewerRoots: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly refinedProjectIdsByHost: ReadonlyMap<string, ReadonlyArray<ProjectId>>;
}

interface RepositoryBatch {
  readonly key: string;
  readonly entries: ReadonlyArray<PullRequestListEntry>;
  readonly errors: ReadonlyArray<PullRequestListProjectError>;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

interface ListCursor extends ProviderListCursor {
  readonly seenAt: ReadonlyArray<number>;
}

const LIST_CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))\|(\d{1,9})\|(\d{1,9}(?:,\d{1,9})*)?(?:\|([\w.:~+-]{1,128}))?$/;

function parseListCursor(raw: string): ListCursor | null {
  const match = LIST_CURSOR_PATTERN.exec(raw);
  if (match === null) return null;
  const seenAt = match[3];
  return {
    updatedBefore: match[1]!,
    delivered: Number(match[2]),
    seenAt: seenAt === undefined ? [] : seenAt.split(",").map(Number),
    ...(match[4] === undefined ? {} : { resumeAfter: match[4] }),
  };
}

function listCursorKey(host: string, repository: string): string {
  return `${host} ${repository.toLowerCase()}`;
}

// Preserve exclusions across slices sharing a timestamp to avoid redelivery.
function nextListCursor(
  previous: ListCursor | undefined,
  fetched: ReadonlyArray<ProviderChangeRequest>,
  delivered: ReadonlyArray<ProviderChangeRequest>,
  /** A provider may consume malformed offset-paged rows that never appear in `delivered`. */
  cursorAdvance = delivered.length,
  resumeAfter?: string,
): string | null {
  if (fetched.length === 0) return null;
  // Use all fetched rows: a slice containing only duplicates must still advance to older rows.
  const oldest = fetched.reduce((left, right) => (right.updatedAt < left.updatedAt ? right : left));
  return listCursorAt(previous, oldest.updatedAt, fetched, cursorAdvance, resumeAfter);
}

function listCursorAt(
  previous: ListCursor | undefined,
  boundary: string,
  fetched: ReadonlyArray<ProviderChangeRequest>,
  deliveredCount: number,
  resumeAfter?: string,
): string {
  const seenAt = new Set([
    ...(previous?.updatedBefore === boundary ? previous.seenAt : []),
    ...fetched.filter((item) => item.updatedAt === boundary).map((item) => item.number),
  ]);
  const cursor = `${boundary}|${(previous?.delivered ?? 0) + deliveredCount}|${[...seenAt].join(",")}`;
  return resumeAfter === undefined ? cursor : `${cursor}|${resumeAfter}`;
}

function isProviderUnusable(error: PullRequestProviderError): boolean {
  return error.reason === "missing-tool" || error.reason === "unauthenticated";
}

type UnavailableRequirementOf = (
  kind: SourceControlProviderKind,
) => PullRequestProviderApi["unavailableRequirement"];

function unavailableRequirement(
  requirementOf: UnavailableRequirementOf,
  error: PullRequestProviderError,
): string | undefined {
  const requirement = requirementOf(error.provider);
  if (requirement === undefined) return undefined;
  return error.reason === "missing-tool" ? requirement.missing : requirement.unauthenticated;
}

function providerDetail(
  requirementOf: UnavailableRequirementOf,
  error: PullRequestProviderError,
): string {
  if (!isProviderUnusable(error)) return error.detail;
  return unavailableRequirement(requirementOf, error) ?? error.detail;
}

function toPullRequestErrorWith(
  requirementOf: UnavailableRequirementOf,
): (operation: string) => (error: PullRequestProviderError) => PullRequestError {
  return (operation) => (error) => {
    if (isProviderUnusable(error)) {
      const requirement = unavailableRequirement(requirementOf, error);
      return new PullRequestUnavailableError({
        reason: error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
        provider: error.provider,
        ...(requirement === undefined ? {} : { requirement }),
        cause: error,
      });
    }
    return new PullRequestOperationError({
      operation,
      detail: error.detail,
      ...(error.reason === "not-found" ? { reason: "not-found" as const } : {}),
      cause: error,
    });
  };
}

function withRateLimitBackoff(
  api: PullRequestProviderApi,
  host: string,
  limits: SourceControlRateLimit.SourceControlRateLimit["Service"],
  options?: { readonly viewerAllowsPause: boolean },
): PullRequestProviderApi {
  const key = { provider: api.kind, host };
  const protect = <A>(
    operation: string,
    effect: Effect.Effect<A, PullRequestProviderError>,
    allowPaused: boolean,
  ) =>
    limits.check(key, allowPaused ? { allowPaused: true } : undefined).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestProviderError({
            provider: api.kind,
            operation,
            reason: "rate-limited",
            detail: error.detail,
            retryAt: error.retryAt,
            cause: error,
          }),
      ),
      Effect.flatMap((lease) =>
        effect.pipe(
          Effect.provideService(SourceControlRateLimit.Interactive, allowPaused),
          Effect.tap(() => limits.recordSuccess({ ...key, lease })),
          Effect.tapError((error) =>
            error.reason === "rate-limited"
              ? limits.recordRateLimit({
                  ...key,
                  lease,
                  ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
                })
              : Effect.void,
          ),
        ),
      ),
    );
  const wrap =
    <Args extends ReadonlyArray<unknown>, A>(
      operation: string,
      call: (...args: Args) => Effect.Effect<A, PullRequestProviderError>,
      allowPaused = false,
    ) =>
    (...args: Args) =>
      protect(operation, call(...args), allowPaused);
  const interactive = <Args extends ReadonlyArray<unknown>, A>(
    operation: string,
    call: (...args: Args) => Effect.Effect<A, PullRequestProviderError>,
  ) => wrap(operation, call, true);

  const wrapped = {
    kind: api.kind,
    capabilities: api.capabilities,
    ...(api.mergeMessageRewrite === undefined
      ? {}
      : { mergeMessageRewrite: api.mergeMessageRewrite }),
    ...(api.unavailableRequirement === undefined
      ? {}
      : { unavailableRequirement: api.unavailableRequirement }),
    ...(api.repositoryKey === undefined ? {} : { repositoryKey: api.repositoryKey }),
    ...(api.readsPublicHostWithoutCheckout === undefined
      ? {}
      : { readsPublicHostWithoutCheckout: api.readsPublicHostWithoutCheckout }),
    getViewer:
      options?.viewerAllowsPause === true
        ? interactive("getViewer", api.getViewer)
        : wrap("getViewer", api.getViewer),
    ...(api.getRoutingIdentity === undefined ? {} : { getRoutingIdentity: api.getRoutingIdentity }),
    ...(api.withVerifiedCredential === undefined
      ? {}
      : { withVerifiedCredential: api.withVerifiedCredential }),
    listChangeRequests: wrap("listChangeRequests", api.listChangeRequests),
    ...(api.listChangeRequestsAcross === undefined
      ? {}
      : {
          listChangeRequestsAcross: wrap("listChangeRequestsAcross", api.listChangeRequestsAcross),
        }),
    ...(api.listChangeRequestStats === undefined
      ? {}
      : {
          listChangeRequestStats: wrap("listChangeRequestStats", api.listChangeRequestStats),
        }),
    getChangeRequest: wrap("getChangeRequest", api.getChangeRequest),
    ...(api.forgetChangeRequestReads === undefined
      ? {}
      : { forgetChangeRequestReads: api.forgetChangeRequestReads }),
    ...(api.getChangeRequestPreview === undefined
      ? {}
      : { getChangeRequestPreview: wrap("getChangeRequestPreview", api.getChangeRequestPreview) }),
    ...(api.getChangeRequestChecks === undefined
      ? {}
      : { getChangeRequestChecks: wrap("getChangeRequestChecks", api.getChangeRequestChecks) }),
    ...(api.getChangeRequestSummary === undefined
      ? {}
      : {
          getChangeRequestSummary: wrap("getChangeRequestSummary", api.getChangeRequestSummary),
        }),
    ...(api.getChangeRequestStack === undefined
      ? {}
      : { getChangeRequestStack: wrap("getChangeRequestStack", api.getChangeRequestStack) }),
    ...(api.getChangeRequestWatchFingerprint === undefined
      ? {}
      : {
          getChangeRequestWatchFingerprint: wrap(
            "getChangeRequestWatchFingerprint",
            api.getChangeRequestWatchFingerprint,
          ),
        }),
    getChangeRequestActivity: wrap("getChangeRequestActivity", api.getChangeRequestActivity),
    ...(api.getReviewThreadComments === undefined
      ? {}
      : {
          getReviewThreadComments: wrap("getReviewThreadComments", api.getReviewThreadComments),
        }),
    getViewerPermissions: interactive("getViewerPermissions", api.getViewerPermissions),
    getDiff: wrap("getDiff", api.getDiff),
    ...(api.getDiffFilePaths === undefined
      ? {}
      : { getDiffFilePaths: wrap("getDiffFilePaths", api.getDiffFilePaths) }),
    ...(api.getDiffFileContents === undefined
      ? {}
      : { getDiffFileContents: wrap("getDiffFileContents", api.getDiffFileContents) }),
    ...(api.getFilesViewed === undefined
      ? {}
      : { getFilesViewed: wrap("getFilesViewed", api.getFilesViewed) }),
    ...(api.getFileStats === undefined
      ? {}
      : { getFileStats: wrap("getFileStats", api.getFileStats) }),
    ...(api.setFilesViewed === undefined
      ? {}
      : { setFilesViewed: interactive("setFilesViewed", api.setFilesViewed) }),
    ...(api.getFileRevisions === undefined
      ? {}
      : { getFileRevisions: wrap("getFileRevisions", api.getFileRevisions) }),
    runAction: interactive("runAction", api.runAction),
    ...(api.updateChangeRequest === undefined
      ? {}
      : {
          updateChangeRequest: interactive("updateChangeRequest", api.updateChangeRequest),
        }),
    comment: interactive("comment", api.comment),
    ...(api.updateComment === undefined
      ? {}
      : { updateComment: interactive("updateComment", api.updateComment) }),
    submitReview: interactive("submitReview", api.submitReview),
    listReviewerCandidates: interactive("listReviewerCandidates", api.listReviewerCandidates),
    setReviewerRequest: interactive("setReviewerRequest", api.setReviewerRequest),
    ...(api.listLabelCandidates === undefined
      ? {}
      : { listLabelCandidates: interactive("listLabelCandidates", api.listLabelCandidates) }),
    ...(api.setLabels === undefined ? {} : { setLabels: interactive("setLabels", api.setLabels) }),
    ...(api.listRepositoryLabels === undefined
      ? {}
      : { listRepositoryLabels: interactive("listRepositoryLabels", api.listRepositoryLabels) }),
    ...(api.searchRepositoryAuthors === undefined
      ? {}
      : {
          searchRepositoryAuthors: interactive(
            "searchRepositoryAuthors",
            api.searchRepositoryAuthors,
          ),
        }),
    replyToThread: interactive("replyToThread", api.replyToThread),
    setReaction: interactive("setReaction", api.setReaction),
    setThreadResolution: interactive("setThreadResolution", api.setThreadResolution),
  };
  // Optional provider methods must be forwarded too; returning the interface alone permits omissions.
  return wrapped satisfies PullRequestProviderApi &
    Record<Exclude<keyof PullRequestProviderApi, keyof typeof wrapped>, never>;
}

const FILTER_OPTIONS_LIMIT = 100;

/**
 * Exact matches first, then names that begin with the query, then the rest, so a short query
 * still puts the obvious answer at the top of a long list.
 */
function rankFilterOptions<A>(
  pages: ReadonlyArray<ProviderFilterOptionPage<A>>,
  input: {
    readonly query: string | undefined;
    readonly keyOf: (item: A) => string;
    readonly textsOf: (item: A) => ReadonlyArray<string | null>;
  },
): { readonly items: ReadonlyArray<A>; readonly truncated: boolean } {
  const query = input.query?.trim().toLowerCase() ?? "";
  const unique = new Map<string, A>();
  for (const page of pages) {
    for (const item of page.items) {
      const key = input.keyOf(item).toLowerCase();
      if (!unique.has(key)) unique.set(key, item);
    }
  }
  const rank = (item: A) => {
    const texts = input.textsOf(item).flatMap((text) => (text ? [text.toLowerCase()] : []));
    if (query.length === 0) return 0;
    if (texts.includes(query)) return 0;
    if (texts.some((text) => text.startsWith(query))) return 1;
    if (texts.some((text) => text.includes(query))) return 2;
    return null;
  };
  const ranked = [...unique.values()]
    .flatMap((item) => {
      const score = rank(item);
      return score === null ? [] : [{ item, score, key: input.keyOf(item) }];
    })
    .toSorted(
      (left, right) =>
        left.score - right.score ||
        left.key.localeCompare(right.key, undefined, { sensitivity: "base" }),
    );
  return {
    items: ranked.slice(0, FILTER_OPTIONS_LIMIT).map(({ item }) => item),
    truncated: ranked.length > FILTER_OPTIONS_LIMIT || pages.some((page) => page.truncated),
  };
}

const remoteHostKey = (recognized: SourceControlProviderInfo, remoteUrl: string) =>
  `${recognized.baseUrl}\n${isSshRemoteUrl(remoteUrl) ? "ssh" : "web"}`;

/** An HTTP remote names its server's web host, port included. */
function httpRemoteHost(remoteUrl: string): string | null {
  try {
    const remote = new URL(remoteUrl);
    return remote.protocol === "http:" || remote.protocol === "https:"
      ? remote.host.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

// Capture before the provider read so a slow response keeps its original freshness through caches.
const observeRead = Effect.fnUntraced(function* <A, E, R>(read: Effect.Effect<A, E, R>) {
  const observedAt = yield* Clock.currentTimeMillis;
  return { value: yield* read, observedAt };
});

export const make = Effect.gen(function* () {
  const mergedPullRequests = yield* PubSub.sliding<PullRequestMergeEvent>(64);
  const stateChanges = yield* PubSub.sliding<ThreadPullRequestKey>(64);
  const pullRequestRefreshes = yield* SubscriptionRef.make(0);
  const registry = yield* PullRequestProviderRegistry.PullRequestProviderRegistry;
  const requirementOf: UnavailableRequirementOf = (kind) =>
    registry.get(kind)?.unavailableRequirement;
  const toPullRequestError = toPullRequestErrorWith(requirementOf);
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const rateLimits = yield* SourceControlRateLimit.SourceControlRateLimit;
  const filesViewedStore = yield* PullRequestFilesViewed.PullRequestFilesViewedRepository;
  const readCache = yield* PullRequestReadCache.PullRequestReadCache;
  const clock = yield* Clock.Clock;

  /**
   * Where each project's remote is served from, by the remote's recognised base URL: a remote no
   * definition placed is identified by the hosting CLIs, and a host whose remotes may not name
   * its web server says which one does. One project per base URL and transport answers for all
   * of them.
   */
  const resolveRemoteHosts = Effect.fn("PullRequestService.resolveRemoteHosts")(function* (
    projects: ReadonlyArray<OrchestrationProjectShell>,
    filter: Pick<PullRequestListInput, "projectId" | "host">,
  ) {
    type Candidate = {
      readonly project: OrchestrationProjectShell;
      readonly context: SourceControlProviderContext;
    };
    const candidatesByKey = new Map<string, Candidate[]>();
    for (const project of projects) {
      if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
      const identity = project.repositoryIdentity;
      if (
        !identity ||
        identity.provider === undefined ||
        sourceControlDefinitions.repositorySelector(identity) === null
      )
        continue;
      if (identity.provider !== "unknown") {
        const provider = yield* sourceControlProviders
          .get(identity.provider)
          .pipe(Effect.orElseSucceed(() => null));
        if (provider?.resolveRemoteWebHost === undefined) continue;
      }
      const host = sourceControlDefinitions.changeRequestHost(identity, "unknown");
      if (
        filter.host !== undefined &&
        host !== "unknown" &&
        host !== filter.host.toLowerCase() &&
        httpRemoteHost(identity.locator.remoteUrl) !== filter.host.toLowerCase() &&
        !isSshRemoteUrl(identity.locator.remoteUrl)
      ) {
        continue;
      }
      const { remoteName, remoteUrl } = identity.locator;
      const recognized = sourceControlDefinitions.recognizeRemote(remoteUrl);
      if (recognized === null) continue;
      const candidate = {
        project,
        context: {
          provider:
            identity.provider === "unknown"
              ? recognized
              : { ...recognized, kind: identity.provider },
          remoteName,
          remoteUrl,
          ...(filter.host !== undefined && isSshRemoteUrl(remoteUrl)
            ? { requestedHost: filter.host }
            : {}),
        },
      };
      const key = remoteHostKey(recognized, remoteUrl);
      const candidates = candidatesByKey.get(key);
      if (candidates === undefined) candidatesByKey.set(key, [candidate]);
      else candidates.push(candidate);
    }

    const resolveContext = (input: {
      readonly cwd: string;
      readonly context: SourceControlProviderContext;
    }) => sourceControlProviders.resolveHandle(input).pipe(Effect.map((handle) => handle.context));
    type RemoteHost = { readonly kind: SourceControlProviderKind; readonly host: string | null };
    const resolveCandidate = ({ project, context }: Candidate) =>
      (context.provider.kind === "unknown"
        ? resolveContext({ cwd: project.workspaceRoot, context }).pipe(
            Effect.map((resolved) =>
              resolved === null || resolved.provider.kind === "unknown"
                ? null
                : { context: resolved, discovered: true },
            ),
          )
        : Effect.succeed({ context, discovered: false })
      ).pipe(
        Effect.flatMap((found) =>
          found === null
            ? Effect.succeed(null)
            : sourceControlProviders.get(found.context.provider.kind).pipe(
                Effect.flatMap(
                  (provider) =>
                    provider.resolveRemoteWebHost?.({
                      cwd: project.workspaceRoot,
                      context: found.context,
                      // A remote discovery just placed is not looked up a second time.
                      resolveContext: found.discovered
                        ? () => Effect.succeed(found.context)
                        : resolveContext,
                    }) ?? Effect.succeed(null),
                ),
                Effect.orElseSucceed(() => null),
                Effect.map((host): RemoteHost => ({ kind: found.context.provider.kind, host })),
              ),
        ),
        Effect.orElseSucceed(() => null),
      );

    // An SSH remote whose web host one checkout could not name may be named by the next; a
    // kind found without a host still stands if none can.
    const resolveKey = Effect.fn("PullRequestService.resolveRemoteHost")(function* (
      candidates: ReadonlyArray<Candidate>,
    ) {
      let fallback: RemoteHost | null = null;
      for (const candidate of candidates) {
        const resolved = yield* resolveCandidate(candidate);
        if (resolved === null) continue;
        if (resolved.host !== null || !isSshRemoteUrl(candidate.context.remoteUrl)) {
          return resolved;
        }
        fallback ??= resolved;
      }
      return fallback;
    });

    return yield* Effect.forEach(
      candidatesByKey,
      ([key, candidates]) =>
        resolveKey(candidates).pipe(Effect.map((resolved) => [key, resolved] as const)),
      { concurrency: REPOSITORY_CONCURRENCY },
    ).pipe(Effect.map((resolved) => new Map(resolved)));
  });

  const listWorkspaceProjects = (
    filter: Pick<PullRequestListInput, "projectId" | "projectIds" | "host">,
  ): Effect.Effect<WorkspaceProjects, PullRequestError> =>
    (filter.projectId === undefined
      ? projects.listShells(
          filter.projectIds === undefined ? undefined : { projectIds: filter.projectIds },
        )
      : projects.getShell(filter.projectId).pipe(Effect.map(Option.toArray))
    ).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestOperationError({
            operation: "listProjects",
            detail: "The project list could not be read.",
            cause: error,
          }),
      ),
      Effect.flatMap((projects) =>
        Effect.forEach(
          projects,
          (project) =>
            project.repositoryIdentity != null
              ? Effect.succeed(project)
              : repositoryIdentities
                  .resolve(project.workspaceRoot)
                  .pipe(Effect.map((repositoryIdentity) => ({ ...project, repositoryIdentity }))),
          { concurrency: REPOSITORY_CONCURRENCY },
        ),
      ),
      Effect.flatMap((projects) =>
        resolveRemoteHosts(projects, filter).pipe(
          Effect.map((remoteHosts) => ({ remoteHosts, projects })),
        ),
      ),
      Effect.map(({ remoteHosts, projects }) => {
        const supported: SupportedProject[] = [];
        const unimplemented = new Map<
          string,
          { kind: SourceControlProviderKind; projectCount: number }
        >();
        const viewerRoots = new Map<string, string[]>();
        const refinedProjectIdsByHost = new Map<string, ProjectId[]>();
        const seen = new Set<string>();
        for (const project of projects) {
          if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
          if (filter.projectIds !== undefined && !filter.projectIds.includes(project.id)) continue;
          const identity = project.repositoryIdentity;
          let kind = identity?.provider;
          const repository = sourceControlDefinitions.repositorySelector(
            project.repositoryIdentity,
          );
          if (!identity || kind === undefined || repository === null) continue;
          const recognized = sourceControlDefinitions.recognizeRemote(identity.locator.remoteUrl);
          const remote =
            recognized === null
              ? undefined
              : remoteHosts.get(remoteHostKey(recognized, identity.locator.remoteUrl));
          kind = remote?.kind ?? kind;
          const host = remote?.host ?? sourceControlDefinitions.changeRequestHost(identity, kind);
          if (filter.host !== undefined && host !== filter.host.toLowerCase()) {
            continue;
          }
          if (host !== sourceControlDefinitions.changeRequestHost(identity, identity.provider)) {
            const projectIds = refinedProjectIdsByHost.get(host);
            if (projectIds === undefined) refinedProjectIdsByHost.set(host, [project.id]);
            else projectIds.push(project.id);
          }
          const api = registry.get(kind);
          if (api !== null) {
            const roots = viewerRoots.get(host);
            if (roots === undefined) viewerRoots.set(host, [project.workspaceRoot]);
            else if (!roots.includes(project.workspaceRoot)) roots.push(project.workspaceRoot);
          }
          const repositoryKey =
            api?.repositoryKey?.({ canonicalKey: identity.canonicalKey }) ?? null;
          const key = listCursorKey(host, repositoryKey ?? repository);
          if (seen.has(key)) continue;
          seen.add(key);
          if (api === null) {
            const counted = unimplemented.get(host);
            if (counted === undefined) unimplemented.set(host, { kind, projectCount: 1 });
            else counted.projectCount += 1;
            continue;
          }
          supported.push({
            cursorKey: key,
            project,
            api: withRateLimitBackoff(api, host, rateLimits),
            repository,
            host,
            remote:
              repositoryKey ??
              sourceControlDefinitions.repositoryKeyFromRemote(`https://${host}/${repository}`),
            repositoryKey:
              repositoryKey === null
                ? null
                : sourceControlDefinitions.canonicalRepositoryKey(repositoryKey.toLowerCase()),
          });
        }
        return { supported, unimplemented, viewerRoots, refinedProjectIdsByHost };
      }),
    );

  // Azure derives organization from the checkout; require the matching repository.
  const requireProject = (ref: PullRequestRef): Effect.Effect<SupportedProject, PullRequestError> =>
    listWorkspaceProjects({ projectId: ref.projectId }).pipe(
      Effect.flatMap(({ supported }): Effect.Effect<SupportedProject, PullRequestError> => {
        const own = supported[0];
        const repository = ref.repository.trim();
        const host = ref.host?.trim().toLowerCase();
        if (own !== undefined && own.repository.toLowerCase() === repository.toLowerCase()) {
          if (host === undefined || host === own.host) return Effect.succeed(own);
        }
        if (host === undefined) {
          if (own === undefined) {
            return Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" }));
          }
          return Effect.fail(
            new PullRequestOperationError({
              operation: "resolveRepository",
              detail: "The change request does not belong to the selected project.",
            }),
          );
        }
        const referenceKey = `${host}/${repository}`.toLowerCase();
        const repositoryKey = sourceControlDefinitions.canonicalRepositoryKey(referenceKey);
        // A host that spells one repository several ways (Azure's SSH and legacy clone hosts)
        // can differ from the browser URL's host. Compare the complete repository identity
        // before narrowing those checkouts by host.
        return listWorkspaceProjects(
          sourceControlDefinitions.findByRepositoryKey(referenceKey) ? {} : { host },
        ).pipe(
          Effect.flatMap(({ supported }) => {
            const onHost = supported.filter((candidate) => candidate.host === host);
            const route =
              supported.find(
                (candidate) =>
                  candidate.repositoryKey !== null && candidate.repositoryKey === repositoryKey,
              ) ??
              onHost.find(
                (candidate) =>
                  candidate.repositoryKey === null &&
                  candidate.repository.toLowerCase() === repository.toLowerCase(),
              ) ??
              onHost.find((candidate) => candidate.repositoryKey === null);
            if (route === undefined) {
              return Effect.gen(function* () {
                const publicHost = sourceControlDefinitions.findByPublicHost(host);
                const api = publicHost === undefined ? null : registry.get(publicHost.kind);
                if (api?.readsPublicHostWithoutCheckout) {
                  const selected = yield* projects.getShell(ref.projectId).pipe(
                    Effect.mapError(
                      (cause) =>
                        new PullRequestOperationError({
                          operation: "resolveRepository",
                          detail: "The selected project could not be read.",
                          cause,
                        }),
                    ),
                  );
                  if (Option.isSome(selected)) {
                    return {
                      cursorKey: listCursorKey(host, repository),
                      project: selected.value,
                      api: withRateLimitBackoff(api, host, rateLimits),
                      repository,
                      host,
                      remote: sourceControlDefinitions.repositoryKeyFromRemote(
                        `https://${host}/${repository}`,
                      ),
                      repositoryKey: null,
                    };
                  }
                }
                return yield* new PullRequestUnavailableError({ reason: "provider-unsupported" });
              });
            }
            return Effect.succeed(
              route.repositoryKey !== null ||
                route.repository.toLowerCase() === repository.toLowerCase()
                ? route
                : {
                    ...route,
                    repository,
                    remote: sourceControlDefinitions.repositoryKeyFromRemote(
                      `https://${host}/${repository}`,
                    ),
                  },
            );
          }),
        );
      }),
    );

  const canonicalRef = Effect.fn("PullRequestService.canonicalRef")(function* <
    I extends PullRequestRef,
  >(input: I) {
    const project = yield* requireProject(input);
    return {
      ...input,
      projectId: project.project.id,
      host: project.host,
      repository: project.repository,
    };
  });

  // Access can change after page load; recheck every write.
  const viewerPermissionsOf = (
    project: SupportedProject,
    ref: PullRequestRef,
    operation: string,
    includeUpdateBranch = false,
  ) =>
    project.api
      .getViewerPermissions({
        cwd: project.project.workspaceRoot,
        repository: project.repository,
        host: project.host,
        number: ref.number,
        includeUpdateBranch,
      })
      .pipe(Effect.mapError(toPullRequestError(operation)));

  const decodeCursors = (
    cursors: PullRequestListInput["cursors"],
  ): Effect.Effect<ReadonlyMap<string, ListCursor> | null, PullRequestError> => {
    if (cursors === undefined) return Effect.succeed(null);
    const decoded = new Map<string, ListCursor>();
    for (const [key, raw] of Object.entries(cursors)) {
      const cursor = parseListCursor(raw);
      if (cursor === null) {
        return Effect.fail(
          new PullRequestOperationError({
            operation: "list",
            detail: "The list could not be carried on from where it left off.",
          }),
        );
      }
      decoded.set(key, cursor);
    }
    return Effect.succeed(decoded);
  };

  type ResolvedViewer = {
    readonly host: string;
    readonly kind: SourceControlProviderKind;
    readonly viewer: string | null;
    readonly error: PullRequestProviderError | null;
  };
  const viewersByHost = new Map<string, { readonly at: number; readonly result: ResolvedViewer }>();
  const viewerFlights = yield* Cache.makeWith(
    (key: string): Effect.Effect<ResolvedViewer> => {
      const [host, kind, roots] = JSON.parse(key) as [
        string,
        SourceControlProviderKind,
        ReadonlyArray<string>,
      ];
      const registered = registry.get(kind);
      if (registered === null) {
        return Effect.die(new Error(`Missing pull request provider: ${kind}`));
      }
      const api = withRateLimitBackoff(registered, host, rateLimits, { viewerAllowsPause: true });
      return Effect.firstSuccessOf(roots.map((cwd) => api.getViewer({ cwd, host }))).pipe(
        Effect.map((viewer) => ({
          host,
          kind,
          viewer: viewer as string | null,
          error: null as PullRequestProviderError | null,
        })),
        Effect.tap((result) =>
          Effect.map(Clock.currentTimeMillis, (at) => viewersByHost.set(host, { at, result })),
        ),
        Effect.catch((error) =>
          Effect.succeed({
            host,
            kind,
            viewer: null,
            error,
          }),
        ),
      );
    },
    {
      capacity: VIEWER_CACHE_CAPACITY,
      // Share cold-page lookups briefly; keep failures retryable.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value.error === null ? Duration.seconds(1) : Duration.zero,
    },
  );

  const resolveViewers = (
    projects: ReadonlyArray<SupportedProject>,
    viewerRoots: WorkspaceProjects["viewerRoots"],
    options?: { readonly allowPaused: boolean },
  ) =>
    Effect.forEach(
      [...new Set(projects.map(({ host }) => host))],
      (host) =>
        Effect.flatMap(Clock.currentTimeMillis, (now): Effect.Effect<ResolvedViewer> => {
          const held = viewersByHost.get(host);
          if (held !== undefined && now - held.at <= Duration.toMillis(VIEWER_CACHE_TTL)) {
            return Effect.succeed(held.result);
          }
          const forHost = projects.filter((project) => project.host === host);
          const api = forHost[0]!.api;
          // Include deduplicated checkouts too; one unreadable worktree must not mark the whole host signed out.
          const roots =
            viewerRoots.get(host) ?? forHost.map(({ project }) => project.workspaceRoot);
          const key = JSON.stringify([host, api.kind, [...new Set(roots)].sort()]);
          if (options?.allowPaused === true) return Cache.get(viewerFlights, key);
          // Check pauses outside the shared lookup so background reads cannot spawn repeated failing CLIs and extend the pause.
          return rateLimits.check({ provider: api.kind, host }).pipe(
            Effect.flatMap(() => Cache.get(viewerFlights, key)),
            Effect.catch((error) =>
              Effect.succeed<ResolvedViewer>({
                host,
                kind: api.kind,
                viewer: null,
                error: new PullRequestProviderError({
                  provider: api.kind,
                  operation: "getViewer",
                  reason: "rate-limited",
                  detail: error.detail,
                  retryAt: error.retryAt,
                  cause: error,
                }),
              }),
            ),
          );
        }),
      { concurrency: REPOSITORY_CONCURRENCY },
    );

  // Only the host can filter checks; listed rows have no check state.
  const matchesRowFilters = (
    item: ProviderChangeRequest,
    filters: PullRequestListFilters | undefined,
    viewer: string,
  ): boolean => {
    if (filters === undefined) return true;
    const labels = new Set(item.labels.map((label) => label.name.trim().toLowerCase()));
    const holds = (label: string) => labels.has(label.trim().toLowerCase());
    return (
      (filters.draft === undefined || item.isDraft === (filters.draft === "only")) &&
      (filters.review === undefined ||
        item.reviewDecision === undefined ||
        (filters.review === "none"
          ? item.reviewDecision === null
          : item.reviewDecision === filters.review)) &&
      (filters.labels === undefined || filters.labels.every((group) => group.some(holds))) &&
      (filters.excludedLabels === undefined || !filters.excludedLabels.some(holds)) &&
      (filters.author === undefined ||
        item.author?.login.toLowerCase() ===
          resolvePullRequestAuthorFilter(filters.author, viewer).toLowerCase())
    );
  };

  const toEntry = (input: {
    readonly project: SupportedProject;
    readonly item: ProviderChangeRequest;
    readonly viewer: string;
    readonly observedAt: number;
  }): PullRequestListEntry => {
    const viewer = input.viewer.toLowerCase();
    return {
      ...(input.item.stack === undefined ? {} : { stack: input.item.stack }),
      provider: input.project.api.kind,
      host: input.project.host,
      projectId: input.project.project.id,
      projectTitle: input.project.project.title,
      repository: input.project.repository,
      number: input.item.number,
      title: input.item.title,
      url: input.item.url,
      author: input.item.author,
      headBranch: input.item.headBranch,
      baseBranch: input.item.baseBranch,
      state: input.item.state,
      isDraft: input.item.isDraft,
      mergeability: input.item.mergeability,
      additions: input.item.additions,
      deletions: input.item.deletions,
      createdAt: input.item.createdAt,
      updatedAt: input.item.updatedAt,
      observedAt: input.observedAt,
      ...(input.item.checksState === undefined || input.item.checksState === null
        ? {}
        : { checksState: input.item.checksState }),
      viewerReviewRequested:
        input.item.author?.login.toLowerCase() !== viewer &&
        input.item.reviewRequestLogins.some((login) => login.toLowerCase() === viewer),
      labels: input.item.labels,
      ...(input.item.reviewDecision === undefined || input.item.reviewDecision === null
        ? {}
        : { reviewDecision: input.item.reviewDecision }),
    };
  };

  const listUncached: PullRequestService["Service"]["list"] = Effect.fn(
    "PullRequestService.listUncached",
  )(function* (input) {
    const involvement = input.involvement ?? "all";
    const continuation = yield* decodeCursors(input.cursors);
    const {
      supported: projects,
      unimplemented,
      viewerRoots,
      refinedProjectIdsByHost,
    } = yield* listWorkspaceProjects(input);
    const projectCounts = new Map<string, number>();
    for (const { host } of projects) {
      projectCounts.set(host, (projectCounts.get(host) ?? 0) + 1);
    }

    const viewerResults = yield* resolveViewers(projects, viewerRoots);
    const viewers: Record<string, string> = {};
    for (const result of viewerResults) {
      if (result.viewer !== null) viewers[result.host] = result.viewer;
    }

    const providers: ReadonlyArray<PullRequestProviderSummary> = [
      ...viewerResults.map((result) => {
        const capabilities = projects.find((project) => project.host === result.host)?.api
          .capabilities;
        return {
          host: result.host,
          kind: result.kind,
          searchesOnHost: capabilities?.search ?? false,
          actions: capabilities?.actions ?? [],
          projectCount: projectCounts.get(result.host) ?? 1,
          projectIds: refinedProjectIdsByHost.get(result.host),
          configured: result.viewer !== null,
          detail: result.error === null ? null : providerDetail(requirementOf, result.error),
        };
      }),
      ...[...unimplemented].map(([host, { kind, projectCount }]) => ({
        host,
        kind,
        searchesOnHost: false,
        actions: [],
        projectCount,
        projectIds: refinedProjectIdsByHost.get(host),
        configured: false,
        detail: "This host cannot be browsed here yet.",
      })),
    ];

    const selected =
      continuation === null
        ? projects
        : projects.filter(({ cursorKey }) => continuation.has(cursorKey));
    const readable = selected.filter(({ host }) => viewers[host] !== undefined);
    const unreadable = selected
      .filter(({ host }) => viewers[host] === undefined)
      .map(({ project, repository }) => ({
        projectId: project.id,
        projectTitle: project.title,
        message: `${repository} could not be read.`,
      }));
    if (readable.length === 0) {
      const listResult: PullRequestListResult = {
        viewers: viewers as PullRequestListResult["viewers"],
        providers,
        entries: [],
        errors: unreadable,
        truncated: false,
        nextCursors: {},
      };
      const errors = viewerResults.flatMap((result) =>
        result.error === null || !selected.some(({ host }) => host === result.host)
          ? []
          : [result.error],
      );
      const blocking = errors.find(isProviderUnusable) ?? errors[0];
      if (blocking) {
        // Preserve failure/retry semantics while letting clients try another server for these hosts.
        const error = toPullRequestError("list")(blocking);
        return yield* error._tag === "PullRequestUnavailableError"
          ? new PullRequestUnavailableError({ ...error, listResult })
          : new PullRequestOperationError({ ...error, listResult });
      }
      return listResult;
    }

    const limit = input.limit ?? DEFAULT_REPOSITORY_LIST_LIMIT;
    const cursorOf = (project: SupportedProject): ListCursor | undefined =>
      continuation?.get(project.cursorKey);

    const readSlice = (
      project: SupportedProject,
      cursor: ListCursor | undefined,
    ): Effect.Effect<RepositoryBatch> => {
      {
        const viewer = viewers[project.host]!;
        const key = project.cursorKey;
        return project.api
          .listChangeRequests({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            state: input.state,
            involvement,
            viewer,
            limit,
            query: input.query,
            filters: input.filters,
            ...(cursor === undefined
              ? {}
              : {
                  cursor: {
                    updatedBefore: cursor.updatedBefore,
                    delivered: cursor.delivered,
                    seenAt: cursor.seenAt,
                    resumeAfter: cursor.resumeAfter,
                  },
                }),
          })
          .pipe(
            observeRead,
            Effect.map(({ value: page, observedAt }): RepositoryBatch => {
              // The boundary instant was asked for inclusively, so the rows already sent at it
              // come back with the slice. Dropping them here rather than asking for strictly
              // older is what keeps their neighbours at the same instant from being skipped.
              const items =
                cursor === undefined
                  ? page.items
                  : page.items.filter(
                      (item) =>
                        item.updatedAt !== cursor.updatedBefore ||
                        !cursor.seenAt.includes(item.number),
                    );
              return {
                key,
                entries: items
                  .filter((item) => matchesRowFilters(item, input.filters, viewer))
                  .map((item) => toEntry({ project, item, viewer, observedAt })),
                errors: [],
                truncated: page.truncated,
                nextCursor:
                  page.continues && page.truncated
                    ? nextListCursor(
                        cursor,
                        page.items,
                        items,
                        page.cursorAdvance,
                        page.resumeAfter,
                      )
                    : null,
              };
            }),
            Effect.catch((error): Effect.Effect<RepositoryBatch> =>
              Effect.succeed({
                key,
                entries: [],
                errors: [
                  {
                    projectId: project.project.id,
                    projectTitle: project.project.title,
                    message:
                      error.accessHint === undefined
                        ? `${project.repository} could not be read.`
                        : `${project.repository} could not be read. ${error.accessHint}`,
                  },
                ],
                truncated: false,
                nextCursor: null,
              }),
            ),
          );
      }
    };

    // Filters a host cannot apply thin out the slices it hands over, so a repository keeps
    // reading until it has a page's worth or runs out. The reads are bounded: a filter that
    // matches nothing would otherwise walk the repository's whole history in one request.
    const readRepository = (project: SupportedProject): Effect.Effect<RepositoryBatch> => {
      const fill = (batch: RepositoryBatch, reads: number): Effect.Effect<RepositoryBatch> => {
        const cursor = batch.nextCursor === null ? null : parseListCursor(batch.nextCursor);
        if (
          input.filters === undefined ||
          cursor === null ||
          batch.entries.length >= limit ||
          reads >= FILTERED_LIST_READS
        ) {
          return Effect.succeed(batch);
        }
        return readSlice(project, cursor).pipe(
          Effect.flatMap((next) =>
            // A slice that failed keeps the cursor before it, so the reader can try again.
            next.errors.length > 0
              ? Effect.succeed(batch)
              : fill({ ...next, entries: [...batch.entries, ...next.entries] }, reads + 1),
          ),
        );
      };
      return readSlice(project, cursorOf(project)).pipe(Effect.flatMap((batch) => fill(batch, 1)));
    };

    const readTogether = (
      chunk: ReadonlyArray<SupportedProject>,
    ): Effect.Effect<ReadonlyArray<RepositoryBatch>> => {
      const first = chunk[0]!;
      const readAcross = first.api.listChangeRequestsAcross;
      const separately = () =>
        Effect.forEach(chunk, readRepository, { concurrency: REPOSITORY_CONCURRENCY });
      if (readAcross === undefined) return separately();
      const viewer = viewers[first.host]!;
      const cursor = cursorOf(first);
      return readAcross({
        cwd: first.project.workspaceRoot,
        host: first.host,
        repositories: chunk.map((project) => project.repository),
        state: input.state,
        involvement,
        viewer,
        limit,
        query: input.query,
        filters: input.filters,
        ...(cursor === undefined
          ? {}
          : { cursor: { updatedBefore: cursor.updatedBefore, delivered: cursor.delivered } }),
      }).pipe(
        observeRead,
        Effect.flatMap(({ value: page, observedAt }) => {
          const rows = new Map<string, Array<ProviderChangeRequest>>();
          for (const item of page.items) {
            const key = item.repository.trim().toLowerCase();
            const held = rows.get(key);
            if (held === undefined) rows.set(key, [item]);
            else held.push(item);
          }
          const unresolved = new Set(
            (page.unresolved ?? []).map((repository) => repository.trim().toLowerCase()),
          );
          const boundary = page.items.reduce<string | null>(
            (oldest, item) =>
              oldest === null || item.updatedAt < oldest ? item.updatedAt : oldest,
            null,
          );
          return Effect.forEach(
            chunk,
            (project): Effect.Effect<RepositoryBatch> => {
              const key = project.repository.trim().toLowerCase();
              const fetched = rows.get(key) ?? [];
              if (fetched.length === 0 && unresolved.has(key)) return readRepository(project);
              const cursorHere = cursorOf(project);
              const items =
                cursorHere === undefined
                  ? fetched
                  : fetched.filter(
                      (item) =>
                        item.updatedAt !== cursorHere.updatedBefore ||
                        !cursorHere.seenAt.includes(item.number),
                    );
              return Effect.succeed({
                key: project.cursorKey,
                entries: items
                  .filter((item) => matchesRowFilters(item, input.filters, viewer))
                  .map((item) => toEntry({ project, item, viewer, observedAt })),
                errors: [],
                truncated: page.truncated,
                nextCursor:
                  page.truncated && boundary !== null
                    ? listCursorAt(cursorHere, boundary, fetched, items.length)
                    : null,
              });
            },
            { concurrency: REPOSITORY_CONCURRENCY },
          );
        }),
        Effect.catch(separately),
      );
    };

    const together = new Map<string, Array<SupportedProject>>();
    const separate: Array<SupportedProject> = [];
    for (const project of readable) {
      if (project.api.listChangeRequestsAcross === undefined) {
        separate.push(project);
        continue;
      }
      const key = `${project.host}\n${cursorOf(project)?.updatedBefore ?? ""}`;
      const group = together.get(key);
      if (group === undefined) together.set(key, [project]);
      else group.push(project);
    }
    const reads: Array<Effect.Effect<ReadonlyArray<RepositoryBatch>>> = separate.map((project) =>
      readRepository(project).pipe(Effect.map((batch) => [batch])),
    );
    for (const group of together.values()) {
      for (let start = 0; start < group.length; start += REPOSITORY_SEARCH_CHUNK) {
        reads.push(readTogether(group.slice(start, start + REPOSITORY_SEARCH_CHUNK)));
      }
    }
    const batches = (yield* Effect.all(reads, { concurrency: REPOSITORY_CONCURRENCY })).flat();

    const nextCursors: Record<string, string> = {};
    for (const batch of batches) {
      if (batch.nextCursor !== null) nextCursors[batch.key] = batch.nextCursor;
    }

    return {
      viewers: viewers as PullRequestListResult["viewers"],
      providers,
      entries: batches
        .flatMap((batch) => batch.entries)
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      errors: [...unreadable, ...batches.flatMap((batch) => batch.errors)],
      truncated: batches.some((batch) => batch.truncated),
      nextCursors,
    };
  });

  const viewerOf = (project: SupportedProject): Effect.Effect<string | null> =>
    routingCredential.pipe(
      Effect.flatMap((credential) =>
        credential !== null
          ? Effect.succeed(credential.viewer)
          : resolveViewers([project], new Map()).pipe(
              Effect.map(([resolved]) => resolved?.viewer ?? null),
            ),
      ),
    );

  const routingIdentity: PullRequestService["Service"]["routingIdentity"] = Effect.fn(
    "PullRequestService.routingIdentity",
  )(function* (input) {
    const host = input.host.toLowerCase();
    const { supported } = yield* listWorkspaceProjects({ host });
    const project = supported.find(
      (candidate) => registry.get(candidate.api.kind)?.getRoutingIdentity !== undefined,
    );
    const api = project === undefined ? null : registry.get(project.api.kind);
    if (project === undefined || api?.getRoutingIdentity === undefined) {
      return yield* new PullRequestUnavailableError({ reason: "provider-unsupported" });
    }
    const identity = yield* api
      .getRoutingIdentity({
        cwd: project.project.workspaceRoot,
        host,
      })
      .pipe(Effect.mapError(toPullRequestError("routeIdentity")));
    return { ...identity, host, provider: api.kind };
  });

  const withRoutingCredential: PullRequestService["Service"]["withRoutingCredential"] = Effect.fn(
    "PullRequestService.withRoutingCredential",
  )(function* (input, operation) {
    if (input.expectedAccountId === undefined) return yield* operation;
    const rejected = () =>
      new PullRequestOperationError({
        operation: "routeIdentity",
        detail: "The signed-in account could not be verified before starting the operation.",
      });
    const project = yield* requireProject(input).pipe(Effect.mapError(rejected));
    const api = registry.get(project.api.kind);
    if (
      api?.withVerifiedCredential === undefined ||
      input.host?.toLowerCase() !== project.host.toLowerCase()
    ) {
      return yield* rejected();
    }
    const result = yield* api
      .withVerifiedCredential(
        { cwd: project.project.workspaceRoot, host: project.host, repository: project.repository },
        (identity) =>
          identity.accountId === input.expectedAccountId
            ? operation.pipe(Effect.provideService(routingCredential, identity), Effect.result)
            : Effect.fail(rejected()),
      )
      .pipe(Effect.catchTags({ PullRequestProviderError: () => Effect.fail(rejected()) }));
    return yield* Effect.fromResult(result);
  });

  const routing = Effect.fn("PullRequestService.routing")(function* (input: PullRequestRef) {
    const project = yield* requireProject(input);
    const api = registry.get(project.api.kind);
    if (api?.getRoutingIdentity === undefined) {
      return yield* new PullRequestUnavailableError({ reason: "provider-unsupported" });
    }
    const identity = yield* api
      .getRoutingIdentity({
        cwd: project.project.workspaceRoot,
        host: project.host,
      })
      .pipe(Effect.mapError(toPullRequestError("routeIdentity")));
    if (!identity.viewer.trim() || !identity.accountId.trim()) {
      return yield* new PullRequestOperationError({
        operation: "routeIdentity",
        detail: "The signed-in account could not be verified.",
      });
    }
    return {
      host: project.host,
      provider: project.api.kind,
      ...identity,
      projectTitle: project.project.title,
      workspaceRoot: project.project.workspaceRoot,
    };
  });

  const summaryUncached: PullRequestService["Service"]["summary"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) => {
        const providerInput = {
          cwd: project.project.workspaceRoot,
          repository: project.repository,
          host: project.host,
          number: input.number,
        };
        const read =
          project.api.getChangeRequestSummary === undefined
            ? project.api.getChangeRequest(providerInput)
            : project.api.getChangeRequestSummary(providerInput);
        return read.pipe(
          Effect.mapError(toPullRequestError("summary")),
          observeRead,
          Effect.map(({ value: changeRequest, observedAt }): PullRequestSummary => ({
            provider: project.api.kind,
            projectId: project.project.id,
            repository: project.repository,
            number: changeRequest.number,
            title: changeRequest.title,
            url: changeRequest.url,
            state: changeRequest.state,
            headBranch: changeRequest.headBranch,
            baseBranch: changeRequest.baseBranch,
            closedAt: changeRequest.closedAt ?? null,
            mergedAt: changeRequest.mergedAt ?? null,
            updatedAt: changeRequest.updatedAt,
            observedAt,
            ...(changeRequest.isDraft === undefined ? {} : { isDraft: changeRequest.isDraft }),
            ...(changeRequest.author === undefined ? {} : { author: changeRequest.author }),
            ...(changeRequest.additions === undefined
              ? {}
              : { additions: changeRequest.additions }),
            ...(changeRequest.deletions === undefined
              ? {}
              : { deletions: changeRequest.deletions }),
            ...(changeRequest.changedFiles === undefined
              ? {}
              : { changedFiles: changeRequest.changedFiles }),
            ...(changeRequest.reviewDecision === undefined
              ? {}
              : { reviewDecision: changeRequest.reviewDecision }),
            ...(changeRequest.checksState === undefined
              ? {}
              : { checksState: changeRequest.checksState }),
            ...(changeRequest.mergeability === undefined
              ? {}
              : { mergeability: changeRequest.mergeability }),
            ...(changeRequest.stack === undefined ? {} : { stack: changeRequest.stack }),
          })),
        );
      }),
    );

  const stackUncached: PullRequestService["Service"]["stack"] = (input, options) =>
    requireProject(input).pipe(
      Effect.flatMap((project) => {
        const read = project.api.getChangeRequestStack;
        if (read === undefined) return Effect.succeed(null);
        return read({
          cwd: project.project.workspaceRoot,
          repository: project.repository,
          host: project.host,
          number: input.number,
          includeDetails: options?.includeDetails !== false,
        }).pipe(
          Effect.mapError(toPullRequestError("stack")),
          Effect.map((stack): PullRequestStack | null =>
            stack === null
              ? null
              : {
                  id: stack.id,
                  number: stack.number,
                  url: stack.url,
                  base: stack.base,
                  layers: stack.layers.map((layer) => ({
                    ...layer,
                    number: layer.number,
                    headBranch: layer.headBranch,
                    state: layer.state,
                  })),
                },
          ),
        );
      }),
    );

  const detailUncached: PullRequestService["Service"]["detail"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        Effect.all(
          [
            project.api
              .getChangeRequest({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
              })
              .pipe(Effect.mapError(toPullRequestError("detail")), observeRead),
            viewerOf(project),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([{ value: changeRequest, observedAt }, viewer]): PullRequestDetail => ({
            provider: project.api.kind,
            capabilities: project.api.capabilities,
            projectId: project.project.id,
            projectTitle: project.project.title,
            workspaceRoot: project.project.workspaceRoot,
            repository: project.repository,
            number: changeRequest.number,
            title: changeRequest.title,
            body: changeRequest.body,
            url: changeRequest.url,
            author: changeRequest.author,
            state: changeRequest.state,
            isDraft: changeRequest.isDraft,
            mergeability: changeRequest.mergeability,
            additions: changeRequest.additions,
            deletions: changeRequest.deletions,
            changedFiles: changeRequest.changedFiles,
            headBranch: changeRequest.headBranch,
            ...(changeRequest.headRepositoryNameWithOwner === undefined
              ? {}
              : { headRepositoryNameWithOwner: changeRequest.headRepositoryNameWithOwner }),
            ...(changeRequest.headSha ? { headSha: changeRequest.headSha } : {}),
            baseBranch: changeRequest.baseBranch,
            createdAt: changeRequest.createdAt,
            updatedAt: changeRequest.updatedAt,
            observedAt,
            mergedAt: changeRequest.mergedAt,
            closedAt: changeRequest.closedAt,
            reviewers: changeRequest.reviewers,
            labels: changeRequest.labels,
            checks: changeRequest.checks,
            mergeCapabilities: changeRequest.mergeCapabilities,
            viewerPermissions: changeRequest.viewerPermissions,
            ...(viewer === null || viewer.trim().length === 0 ? {} : { viewer }),
            ...(changeRequest.baseComparison === undefined
              ? {}
              : { baseComparison: changeRequest.baseComparison }),
            ...(changeRequest.behindBy === undefined ? {} : { behindBy: changeRequest.behindBy }),
            ...(changeRequest.autoMergeEnabled === undefined
              ? {}
              : { autoMergeEnabled: changeRequest.autoMergeEnabled }),
            ...(changeRequest.autoMergeMethod === undefined
              ? {}
              : { autoMergeMethod: changeRequest.autoMergeMethod }),
            ...(changeRequest.maintainerCanModify === undefined
              ? {}
              : { maintainerCanModify: changeRequest.maintainerCanModify }),
            ...(changeRequest.workflowApprovalsRequired === undefined
              ? {}
              : { workflowApprovalsRequired: changeRequest.workflowApprovalsRequired }),
          })),
        ),
      ),
    );

  const previewFields = (value: PullRequestPreview): PullRequestPreview => ({
    projectId: value.projectId,
    repository: value.repository,
    number: value.number,
    title: value.title,
    url: value.url,
    author: value.author,
    state: value.state,
    isDraft: value.isDraft,
    createdAt: value.createdAt,
  });
  const previewUncached: PullRequestService["Service"]["preview"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        (project.api.getChangeRequestPreview ?? project.api.getChangeRequest)({
          cwd: project.project.workspaceRoot,
          repository: project.repository,
          host: project.host,
          number: input.number,
        }).pipe(
          Effect.mapError(toPullRequestError("preview")),
          Effect.map((value) =>
            previewFields({
              ...value,
              projectId: project.project.id,
              repository: project.repository,
            }),
          ),
        ),
      ),
    );

  const activityUncached: PullRequestService["Service"]["activity"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api
          .getChangeRequestActivity({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
          })
          .pipe(
            Effect.mapError(toPullRequestError("activity")),
            Effect.map((activity): PullRequestActivity => ({
              ...(activity.author === undefined ? {} : { author: activity.author }),
              ...(activity.reviewers === undefined ? {} : { reviewers: activity.reviewers }),
              comments: activity.comments,
              commentCount: activity.commentCount,
              commentsTruncated: activity.commentsTruncated,
              ...(activity.reviewThreadsTruncated === undefined
                ? {}
                : { reviewThreadsTruncated: activity.reviewThreadsTruncated }),
              reviewThreads: activity.reviewThreads,
              commits: activity.commits,
              ...(activity.reactions === undefined ? {} : { reactions: activity.reactions }),
            })),
          ),
      ),
    );

  const threadComments: PullRequestService["Service"]["threadComments"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap(
        (project): Effect.Effect<PullRequestThreadCommentsResult, PullRequestError> => {
          const read = project.api.getReviewThreadComments;
          if (read === undefined) {
            return Effect.fail(
              new PullRequestOperationError({
                operation: "threadComments",
                detail: "This host does not page review thread comments.",
              }),
            );
          }
          return read({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
            threadId: input.threadId,
            cursor: input.cursor,
          }).pipe(Effect.mapError(toPullRequestError("threadComments")));
        },
      ),
    );

  const diffUncached: PullRequestService["Service"]["diff"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api.capabilities.diff
          ? project.api
              .getDiff({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                ...(input.commit === undefined ? {} : { commit: input.commit }),
              })
              .pipe(Effect.mapError(toPullRequestError("diff")))
          : Effect.fail(
              new PullRequestOperationError({
                operation: "diff",
                detail: "This host cannot provide a diff for a change request.",
              }),
            ),
      ),
    );

  const readDiffFileContents: PullRequestService["Service"]["diffFileContents"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) => {
        const read = project.api.getDiffFileContents;
        return project.api.capabilities.diff && read
          ? read({
              cwd: project.project.workspaceRoot,
              repository: project.repository,
              host: project.host,
              number: input.number,
              ...(input.commit === undefined ? {} : { commit: input.commit }),
              changeType: input.changeType,
              oldPath: input.oldPath,
              newPath: input.newPath,
            }).pipe(Effect.mapError(toPullRequestError("diffFileContents")))
          : Effect.fail(
              new PullRequestOperationError({
                operation: "diffFileContents",
                detail: "This host cannot expand unchanged pull request lines.",
              }),
            );
      }),
    );

  const context = yield* Effect.context<never>();
  const scope = yield* Effect.scope;
  const runFork = Effect.runForkWith(context);

  // Refuse failed viewer lookups; unnamed fallbacks hide marks and orphan subsequent writes.
  const requiredViewerOf = (
    project: SupportedProject,
    operation: string,
  ): Effect.Effect<string | null, PullRequestError> =>
    resolveViewers([project], new Map(), { allowPaused: true }).pipe(
      Effect.flatMap(([resolved]) => {
        const error = resolved?.error ?? null;
        return error === null
          ? Effect.succeed(resolved?.viewer ?? null)
          : Effect.fail(toPullRequestError(operation)(error));
      }),
    );

  const setFilesViewed: PullRequestService["Service"]["setFilesViewed"] = (input) =>
    canonicalRef(input).pipe(
      Effect.flatMap((ref) =>
        viewedFiles.setFilesViewed(input).pipe(
          // Deliberately not `invalidatedByMutation`: ticking a file off says nothing about the
          // change request, and dropping a 300-file diff on every checkbox is the whole cost of
          // the feature.
          Effect.ensuring(Effect.sync(() => bumpFilesViewedEpoch(ref))),
        ),
      ),
    );

  const runAction = (input: PullRequestActionInput): Effect.Effect<string, PullRequestError> =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<string, PullRequestError> => {
        if (input.action === "delete-branch" && project.api.capabilities.deleteBranch !== true) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "runAction",
              detail: "This host cannot delete a change request's source branch.",
            }),
          );
        }
        if (
          input.stackNumber !== undefined &&
          (project.api.capabilities.stackActions !== true ||
            !["merge", "update-branch"].includes(input.action) ||
            input.expectedStackHeads === undefined ||
            (input.action === "update-branch" && input.updateMethod !== "rebase"))
        ) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "runAction",
              detail: "This stack action is not supported or has no expected head revision.",
            }),
          );
        }
        if (!project.api.capabilities.actions.includes(input.action)) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "runAction",
              detail: `This host cannot ${input.action} a change request.`,
            }),
          );
        }
        // Refuse unsupported strategies; providers silently map unrecognized methods to their default.
        if (
          input.mergeMethod !== undefined &&
          !project.api.capabilities.mergeMethods.includes(input.mergeMethod)
        ) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "runAction",
              detail: `This host cannot merge with the ${input.mergeMethod} strategy.`,
            }),
          );
        }
        if (
          input.updateMethod !== undefined &&
          !(project.api.capabilities.updateMethods ?? []).includes(input.updateMethod)
        ) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "runAction",
              detail: `This host cannot update a branch by ${input.updateMethod}.`,
            }),
          );
        }
        const operation = viewerPermissionsOf(
          project,
          input,
          "runAction",
          input.action === "update-branch",
        ).pipe(
          Effect.flatMap((viewer): Effect.Effect<string, PullRequestError> => {
            const stackRebase = input.stackNumber !== undefined && input.action === "update-branch";
            if (
              stackRebase ? viewer.stackRebase !== true : !viewer.actions.includes(input.action)
            ) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "runAction",
                  detail: ACTION_ACCESS_REFUSALS[input.action],
                }),
              );
            }
            if (
              !stackRebase &&
              input.updateMethod !== undefined &&
              !(viewer.updateMethods ?? []).includes(input.updateMethod)
            ) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "runAction",
                  detail: ACTION_ACCESS_REFUSALS["update-branch"],
                }),
              );
            }
            const mergeSettings =
              project.api.mergeMessageRewrite !== undefined &&
              input.stackNumber === undefined &&
              (input.action === "merge" || input.action === "enable-auto-merge")
                ? serverSettings.getSettings.pipe(
                    Effect.map(
                      (settings) =>
                        resolveProjectSettings(settings, project.project.id).settings
                          .removeAgentCreditsOnMerge,
                    ),
                    Effect.mapError(
                      () =>
                        new PullRequestOperationError({
                          operation: "runAction",
                          detail: "Could not read merge settings.",
                        }),
                    ),
                  )
                : Effect.succeed(false);
            return mergeSettings.pipe(
              Effect.flatMap((removeAgentCreditsOnMerge) =>
                project.api
                  .runAction({
                    cwd: project.project.workspaceRoot,
                    repository: project.repository,
                    host: project.host,
                    number: input.number,
                    action: input.action,
                    ...(removeAgentCreditsOnMerge ? { removeAgentCreditsOnMerge: true } : {}),
                    ...(input.stackNumber === undefined ? {} : { stackNumber: input.stackNumber }),
                    ...(input.expectedStackHeads === undefined
                      ? {}
                      : { expectedStackHeads: input.expectedStackHeads }),
                    ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
                    ...(input.updateMethod === undefined
                      ? {}
                      : { updateMethod: input.updateMethod }),
                  })
                  .pipe(
                    Effect.ensuring(
                      input.stackNumber === undefined
                        ? Effect.void
                        : refreshAfterTurn(project.project.id),
                    ),
                    Effect.mapError(toPullRequestError("runAction")),
                    Effect.as(
                      project.repositoryKey !== null ? input.repository.trim() : project.repository,
                    ),
                  ),
              ),
            );
          }),
        );
        return input.action === "delete-branch" && project.api.withVerifiedCredential !== undefined
          ? project.api
              .withVerifiedCredential(
                {
                  cwd: project.project.workspaceRoot,
                  host: project.host,
                  repository: project.repository,
                },
                () => operation.pipe(Effect.result),
              )
              .pipe(
                Effect.mapError(toPullRequestError("runAction")),
                Effect.flatMap(Effect.fromResult),
              )
          : operation;
      }),
    );

  const comment: PullRequestService["Service"]["comment"] = (input) =>
    (input.body.trim().length === 0
      ? Effect.fail(
          new PullRequestOperationError({
            operation: "comment",
            detail: "A comment cannot be empty.",
          }),
        )
      : requireProject(input)
    ).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (!project.api.capabilities.comment) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "comment",
              detail: "This host cannot post a comment on a change request.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "comment").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.comment) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "comment",
                  detail:
                    "You need write access on this repository to comment on a change request.",
                }),
              );
            }
            return project.api
              .comment({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                body: input.body,
              })
              .pipe(Effect.mapError(toPullRequestError("comment")));
          }),
        );
      }),
    );

  // Hosts let authors edit without reporting that permission; checking it would wrongly deny access.
  const update: PullRequestService["Service"]["update"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        const rewrite = project.api.updateChangeRequest;
        if (project.api.capabilities.edit?.changeRequest !== true || rewrite === undefined) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "update",
              detail: "This host cannot rewrite a change request.",
            }),
          );
        }
        if (
          input.maintainerCanModify !== undefined &&
          project.api.capabilities.edit?.maintainerEdits !== true
        ) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "update",
              detail: "This host does not support maintainer edits.",
            }),
          );
        }
        if (
          input.title === undefined &&
          input.body === undefined &&
          input.maintainerCanModify === undefined
        ) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "update",
              detail: "Nothing was changed.",
            }),
          );
        }
        return rewrite({
          cwd: project.project.workspaceRoot,
          repository: project.repository,
          host: project.host,
          number: input.number,
          ...(input.maintainerCanModify === undefined
            ? {}
            : { maintainerCanModify: input.maintainerCanModify }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        }).pipe(Effect.mapError(toPullRequestError("update")));
      }),
    );

  const updateComment: PullRequestService["Service"]["updateComment"] = (input) =>
    (input.body.trim().length === 0
      ? Effect.fail(
          new PullRequestOperationError({
            operation: "updateComment",
            detail: "A comment cannot be empty.",
          }),
        )
      : requireProject(input)
    ).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        const rewrite = project.api.updateComment;
        if (project.api.capabilities.edit?.comment !== true || rewrite === undefined) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "updateComment",
              detail: "This host cannot rewrite a comment.",
            }),
          );
        }
        return rewrite({
          cwd: project.project.workspaceRoot,
          repository: project.repository,
          host: project.host,
          number: input.number,
          commentId: input.commentId,
          kind: input.kind,
          body: input.body,
        }).pipe(Effect.mapError(toPullRequestError("updateComment")));
      }),
    );

  const submitReview: PullRequestService["Service"]["submitReview"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        const review = project.api.capabilities.review;
        const refuse = (detail: string) =>
          Effect.fail(new PullRequestOperationError({ operation: "submitReview", detail }));
        if (!review.verdicts.includes(input.verdict)) {
          return refuse(`This host cannot ${VERDICT_LABELS[input.verdict]} a change request.`);
        }
        if (input.comments.length > 0 && !review.inlineComment) {
          return refuse("This host cannot comment on a line of a change request.");
        }
        if (
          input.verdict !== "approve" &&
          input.body.trim().length === 0 &&
          input.comments.length === 0
        ) {
          return refuse("A review needs a summary or at least one comment.");
        }
        return viewerPermissionsOf(project, input, "submitReview").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.verdicts.includes(input.verdict)) {
              return refuse(
                `You need write access on this repository to ${
                  VERDICT_LABELS[input.verdict]
                } a change request.`,
              );
            }
            if (input.comments.length > 0 && !viewer.comment) {
              return refuse(
                "You need write access on this repository to comment on a line of a change request.",
              );
            }
            return project.api
              .submitReview({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                verdict: input.verdict,
                body: input.body,
                comments: input.comments,
              })
              .pipe(Effect.mapError(toPullRequestError("submitReview")));
          }),
        );
      }),
    );

  const replyToThread: PullRequestService["Service"]["replyToThread"] = (input) =>
    (input.body.trim().length === 0
      ? Effect.fail(
          new PullRequestOperationError({
            operation: "replyToThread",
            detail: "A reply cannot be empty.",
          }),
        )
      : requireProject(input)
    ).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (!project.api.capabilities.review.reply) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "replyToThread",
              detail: "This host cannot reply to a review conversation.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "replyToThread").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.comment) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "replyToThread",
                  detail:
                    "You need write access on this repository to reply to a review conversation.",
                }),
              );
            }
            return project.api
              .replyToThread({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                threadId: input.threadId,
                body: input.body,
              })
              .pipe(Effect.mapError(toPullRequestError("replyToThread")));
          }),
        );
      }),
    );

  const setThreadResolution: PullRequestService["Service"]["setThreadResolution"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (!project.api.capabilities.review.resolve) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "setThreadResolution",
              detail: "This host cannot resolve a review conversation.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "setThreadResolution").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.resolve) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "setThreadResolution",
                  detail:
                    "You need write access on this repository, or to have opened this change request, to resolve a review conversation.",
                }),
              );
            }
            return project.api
              .setThreadResolution({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                threadId: input.threadId,
                resolved: input.resolved,
              })
              .pipe(Effect.mapError(toPullRequestError("setThreadResolution")));
          }),
        );
      }),
    );

  // Hosts permit reactions from any reader; reading the PR already checks access.
  const setReaction: PullRequestService["Service"]["setReaction"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (project.api.capabilities.reactions !== true) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "setReaction",
              detail: "This host has no reactions.",
            }),
          );
        }
        return project.api
          .setReaction({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
            ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
            content: input.content,
            reacted: input.reacted,
          })
          .pipe(Effect.mapError(toPullRequestError("setReaction")));
      }),
    );

  const reviewerCandidates: PullRequestService["Service"]["reviewerCandidates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap(
        (project): Effect.Effect<PullRequestReviewerCandidateList, PullRequestError> => {
          if (!project.api.capabilities.reviewers.listCandidates) {
            return Effect.fail(
              new PullRequestOperationError({
                operation: "reviewerCandidates",
                detail: "This host cannot say who may review a change request.",
              }),
            );
          }
          return viewerPermissionsOf(project, input, "reviewerCandidates").pipe(
            Effect.flatMap(
              (viewer): Effect.Effect<PullRequestReviewerCandidateList, PullRequestError> =>
                viewer.requestReviewers
                  ? project.api
                      .listReviewerCandidates({
                        cwd: project.project.workspaceRoot,
                        repository: project.repository,
                        host: project.host,
                        number: input.number,
                      })
                      .pipe(Effect.mapError(toPullRequestError("reviewerCandidates")))
                  : Effect.fail(
                      new PullRequestOperationError({
                        operation: "reviewerCandidates",
                        detail: REVIEWER_REQUEST_REFUSAL,
                      }),
                    ),
            ),
          );
        },
      ),
    );

  const requestReviewers: PullRequestService["Service"]["requestReviewers"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (!project.api.capabilities.reviewers.request) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "requestReviewers",
              detail: "This host cannot ask somebody for a review.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "requestReviewers").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.requestReviewers) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "requestReviewers",
                  detail: REVIEWER_REQUEST_REFUSAL,
                }),
              );
            }
            return project.api
              .setReviewerRequest({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                reviewers: input.reviewers,
                requested: input.requested,
              })
              .pipe(Effect.mapError(toPullRequestError("requestReviewers")));
          }),
        );
      }),
    );

  const filterOptions: PullRequestService["Service"]["filterOptions"] = Effect.fn(
    "PullRequestService.filterOptions",
  )(function* (input) {
    const { supported } = yield* listWorkspaceProjects(input);
    // Worktrees of one checkout are separate projects over the same repository.
    const repositories = [
      ...new Map(supported.map((project) => [project.cursorKey, project])).values(),
    ];
    const refOf = (project: SupportedProject) => ({
      cwd: project.project.workspaceRoot,
      repository: project.repository,
      host: project.host,
      query: input.query,
    });
    // One repository the host cannot read leaves the others' options standing, as a listing does.
    const gather = <A>(
      read: (
        project: SupportedProject,
      ) => Effect.Effect<ProviderFilterOptionPage<A>, PullRequestProviderError> | undefined,
    ) =>
      Effect.forEach(
        repositories,
        (project): Effect.Effect<ReadonlyArray<ProviderFilterOptionPage<A>>> => {
          const page = read(project);
          return page === undefined
            ? Effect.succeed([])
            : page.pipe(
                Effect.map((answered) => [answered]),
                Effect.orElseSucceed(() => []),
              );
        },
        { concurrency: REPOSITORY_CONCURRENCY },
      ).pipe(Effect.map((pages) => pages.flat()));
    if (input.kind === "labels") {
      const pages = yield* gather<PullRequestLabel>((project) =>
        project.api.listRepositoryLabels?.(refOf(project)),
      );
      const { items, truncated } = rankFilterOptions(pages, {
        query: input.query,
        keyOf: (label) => label.name,
        textsOf: (label) => [label.name],
      });
      return { labels: items, authors: [], truncated };
    }
    const pages = yield* gather<PullRequestActor>((project) =>
      project.api.searchRepositoryAuthors?.(refOf(project)),
    );
    const { items, truncated } = rankFilterOptions(pages, {
      query: input.query,
      keyOf: (author) => author.login,
      textsOf: (author) => [author.login, author.name],
    });
    return { labels: [], authors: items, truncated };
  });

  const labelCandidates: PullRequestService["Service"]["labelCandidates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<PullRequestLabelCandidateList, PullRequestError> => {
        const list = project.api.listLabelCandidates;
        if (project.api.capabilities.labels !== true || list === undefined) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "labelCandidates",
              detail: "This host cannot change the labels on a change request.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "labelCandidates").pipe(
          Effect.flatMap(
            (viewer): Effect.Effect<PullRequestLabelCandidateList, PullRequestError> =>
              viewer.labels === false
                ? Effect.fail(
                    new PullRequestOperationError({
                      operation: "labelCandidates",
                      detail: LABEL_CHANGE_REFUSAL,
                    }),
                  )
                : list({
                    cwd: project.project.workspaceRoot,
                    repository: project.repository,
                    host: project.host,
                    number: input.number,
                  }).pipe(Effect.mapError(toPullRequestError("labelCandidates"))),
          ),
        );
      }),
    );

  const setLabels: PullRequestService["Service"]["setLabels"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        const change = project.api.setLabels;
        if (project.api.capabilities.labels !== true || change === undefined) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "setLabels",
              detail: "This host cannot change the labels on a change request.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "setLabels").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> =>
            viewer.labels === false
              ? Effect.fail(
                  new PullRequestOperationError({
                    operation: "setLabels",
                    detail: LABEL_CHANGE_REFUSAL,
                  }),
                )
              : change({
                  cwd: project.project.workspaceRoot,
                  repository: project.repository,
                  host: project.host,
                  number: input.number,
                  labels: input.labels,
                  applied: input.applied,
                }).pipe(Effect.mapError(toPullRequestError("setLabels"))),
          ),
        );
      }),
    );

  /**
   * The line counts for rows already on the page, which the listing left out because on GitHub
   * they cost more than everything else on the row put together.
   */
  const listStatsUncached: PullRequestService["Service"]["listStats"] = Effect.fn(
    "PullRequestService.listStatsUncached",
  )(function* (input) {
    if (input.refs.length === 0) return { stats: [] };
    const { supported } = yield* listWorkspaceProjects({});
    const byProject = new Map(supported.map((project) => [project.project.id, project]));
    const wanted = new Map<
      string,
      { readonly project: SupportedProject; readonly number: number }
    >();
    for (const ref of input.refs) {
      const project = byProject.get(ref.projectId);
      if (
        project === undefined ||
        project.api.listChangeRequestStats === undefined ||
        project.repository.toLowerCase() !== ref.repository.trim().toLowerCase()
      ) {
        continue;
      }
      wanted.set(`${project.project.id} ${ref.number}`, { project, number: ref.number });
    }
    const byHost = new Map<string, Array<{ project: SupportedProject; number: number }>>();
    for (const entry of wanted.values()) {
      const held = byHost.get(entry.project.host);
      if (held === undefined) byHost.set(entry.project.host, [entry]);
      else held.push(entry);
    }
    const stats = yield* Effect.forEach(
      [...byHost.values()],
      (entries) => {
        const first = entries[0]!;
        const readStats = first.project.api.listChangeRequestStats;
        if (readStats === undefined) return Effect.succeed<ReadonlyArray<PullRequestDiffStat>>([]);
        const projectsByRepository = new Map(
          entries.map((entry) => [
            `${entry.project.repository.toLowerCase()} ${entry.number}`,
            entry.project,
          ]),
        );
        return readStats({
          cwd: first.project.project.workspaceRoot,
          host: first.project.host,
          changeRequests: entries.map((entry) => ({
            repository: entry.project.repository,
            number: entry.number,
          })),
        }).pipe(
          Effect.map((read) =>
            read.flatMap((stat): ReadonlyArray<PullRequestDiffStat> => {
              const project = projectsByRepository.get(
                `${stat.repository.toLowerCase()} ${stat.number}`,
              );
              return project === undefined
                ? []
                : [
                    {
                      projectId: project.project.id,
                      repository: project.repository,
                      number: stat.number,
                      additions: stat.additions,
                      deletions: stat.deletions,
                    },
                  ];
            }),
          ),
          Effect.orElseSucceed((): ReadonlyArray<PullRequestDiffStat> => []),
        );
      },
      { concurrency: REPOSITORY_CONCURRENCY },
    );
    return { stats: stats.flat() };
  });

  const revalidate = <A, E>(read: Effect.Effect<A, E>) =>
    Effect.context<never>().pipe(
      Effect.flatMap((caller) =>
        Effect.sync(() => runFork(Effect.ignore(read).pipe(Effect.provideContext(caller)))),
      ),
    );

  const staleDiff = (() => {
    const staleMs = Duration.toMillis(DIFF_STALE_WINDOW);
    const held = new Map<string, { readonly at: number; readonly value: PullRequestDiffResult }>();
    const record = (key: string, value: PullRequestDiffResult) =>
      Effect.map(Clock.currentTimeMillis, (at) => {
        held.delete(key);
        if (!canCacheDiff(value)) return;
        if (held.size >= DIFF_CACHE_CAPACITY) {
          const oldest = held.keys().next().value;
          if (oldest !== undefined) held.delete(oldest);
        }
        held.set(key, { at, value });
        for (const evicted of diffCacheEvictions(
          Array.from(held, ([key, snapshot]) => [key, snapshot.value] as const),
        )) {
          held.delete(evicted);
        }
        armDiffSweep();
      });
    const serve = <E>(key: string, read: Effect.Effect<PullRequestDiffResult, E>) => {
      const recorded = read.pipe(Effect.tap((value) => record(key, value)));
      return Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const snapshot = held.get(key);
        if (snapshot === undefined || now - snapshot.at > staleMs) return recorded;
        // Use an independent fiber; refresh outlives the answered caller.
        return revalidate(recorded).pipe(Effect.as(snapshot.value));
      });
    };
    const dropExpired = Effect.map(Clock.currentTimeMillis, (now) => {
      for (const [key, snapshot] of held) {
        if (now - snapshot.at > staleMs) held.delete(key);
      }
      return held.size;
    });
    return { serve, dropExpired };
  })();

  const makeLastGoodRead = <A>(capacity: number) => {
    const held = new Map<string, { readonly at: number; readonly value: A }>();
    const record = (key: string, value: A) =>
      Effect.map(Clock.currentTimeMillis, (at) => {
        held.delete(key);
        if (held.size >= capacity) {
          const oldest = held.keys().next().value;
          if (oldest !== undefined) held.delete(oldest);
        }
        held.set(key, { at, value });
      });
    const read = (key: string, effect: Effect.Effect<A, PullRequestError>) =>
      effect.pipe(
        Effect.tap((value) => record(key, value)),
        Effect.catchTags({
          PullRequestOperationError: (error) => {
            if (!isPullRequestProviderError(error.cause)) {
              return Effect.fail(error);
            }
            const provider = error.cause;
            if (provider.reason !== "failed" && provider.reason !== "rate-limited") {
              return Effect.fail(error);
            }
            return Effect.flatMap(Clock.currentTimeMillis, (now) => {
              const snapshot = held.get(key);
              if (
                snapshot === undefined ||
                now - snapshot.at > Duration.toMillis(STALE_DETAIL_WINDOW)
              ) {
                return Effect.fail(error);
              }
              return Effect.logWarning("using recent pull request data after a failed refresh", {
                operation: error.operation,
                reason: provider.reason,
              }).pipe(Effect.as(snapshot.value));
            });
          },
        }),
      );
    const serveHeld = (key: string, effect: Effect.Effect<A, PullRequestError>) => {
      const snapshot = held.get(key);
      if (snapshot === undefined) return read(key, effect);
      return revalidate(read(key, effect)).pipe(Effect.as(snapshot.value));
    };
    return { peek: (key: string) => held.get(key)?.value, read, record, serveHeld };
  };
  const lastGoodSummary = makeLastGoodRead<PullRequestSummary>(DETAIL_CACHE_CAPACITY);
  const lastGoodDetail = makeLastGoodRead<PullRequestDetail>(DETAIL_CACHE_CAPACITY);

  // A shared monotonic counter prevents evicted scopes reusing epochs held by old entries.
  let epochCounter = 0;
  let listingsEpoch = 0;
  const refEpochs = new Map<string, number>();
  const projectEpochs = new Map<ProjectId, number>();
  let projectEpochFloor = 0;
  const REF_EPOCH_CAPACITY = 2_048;
  const refScope = (ref: PullRequestRef) =>
    JSON.stringify([
      ref.projectId,
      ref.host?.toLowerCase() ?? "",
      ref.repository.toLowerCase(),
      ref.number,
    ]);
  const mergedEpochs = new Map<string, number>();
  const refEpoch = (ref: PullRequestRef) => {
    const scope = refScope(ref);
    return Math.max(
      mergedEpochs.get(scope) ?? projectEpochs.get(ref.projectId) ?? projectEpochFloor,
      refEpochs.get(scope) ?? 0,
    );
  };
  const noteMerged = (ref: PullRequestRef) => {
    const scope = refScope(ref);
    if (mergedEpochs.has(scope)) return;
    if (mergedEpochs.size >= REF_EPOCH_CAPACITY) {
      const oldest = mergedEpochs.keys().next().value;
      if (oldest !== undefined) mergedEpochs.delete(oldest);
    }
    mergedEpochs.set(scope, projectEpochs.get(ref.projectId) ?? projectEpochFloor);
  };
  const refCacheKey = (ref: CredentialRef) =>
    JSON.stringify([
      refEpoch(ref),
      ref.projectId,
      ref.host?.toLowerCase() ?? null,
      ref.repository.toLowerCase(),
      ref.number,
      ref.expectedAccountId ?? null,
      ref[credentialNamespace] ?? null,
    ]);
  const refOfCacheKey = (key: string): PullRequestRef => {
    const [, projectId, host, repository, number, expectedAccountId, fingerprint] = JSON.parse(
      key,
    ) as [number, string, string | null, string, number, string | null, string | null];
    return {
      projectId,
      ...(host === null ? {} : { host }),
      ...(expectedAccountId === null ? {} : { expectedAccountId }),
      ...(fingerprint === null ? {} : { [credentialNamespace]: fingerprint }),
      repository,
      number,
    } as PullRequestRef;
  };
  const statsCacheKey = (key: string) => JSON.stringify([listingsEpoch, key]);
  const recentStats = new Map<
    string,
    { readonly at: number; readonly value: PullRequestDiffStat }
  >();
  const recordStats = (key: string, value: PullRequestDiffStat, at: number) => {
    recentStats.delete(key);
    recentStats.set(key, { at, value });
    if (recentStats.size > REF_EPOCH_CAPACITY) {
      const oldest = recentStats.keys().next().value;
      if (oldest !== undefined) recentStats.delete(oldest);
    }
  };
  const bumpEpoch = (epochs: Map<string, number>, ref: PullRequestRef) => {
    const scope = refScope(ref);
    if (!epochs.has(scope) && epochs.size >= REF_EPOCH_CAPACITY) {
      const oldest = epochs.keys().next().value;
      if (oldest !== undefined) epochs.delete(oldest);
    }
    epochs.set(scope, ++epochCounter);
  };
  const bumpRefEpoch = (ref: PullRequestRef) => bumpEpoch(refEpochs, ref);
  const filesViewedEpochs = new Map<string, number>();
  const filesViewedEpoch = (ref: PullRequestRef) => filesViewedEpochs.get(refScope(ref)) ?? 0;
  const bumpFilesViewedEpoch = (ref: PullRequestRef) => bumpEpoch(filesViewedEpochs, ref);

  let everyFileRevisionEpoch = 0;
  const viewedFiles = ViewedFiles.make({
    filesViewedStore,
    requireProject,
    requiredViewerOf,
    toPullRequestError,
    runFork,
    refEpoch,
    fileRevisionsEpoch: () => everyFileRevisionEpoch,
  });

  const filtersOfKey = (
    slots: ReadonlyArray<
      string | ReadonlyArray<string> | ReadonlyArray<ReadonlyArray<string>> | null
    >,
  ): PullRequestListFilters => {
    const [draft, review, checks, author, labels, excludedLabels] = slots;
    return {
      ...(typeof draft === "string" ? { draft: draft as "only" | "hide" } : {}),
      ...(typeof review === "string" ? { review: review as PullRequestListFilters["review"] } : {}),
      ...(typeof checks === "string" ? { checks: checks as PullRequestListFilters["checks"] } : {}),
      ...(typeof author === "string" ? { author } : {}),
      ...(Array.isArray(labels) ? { labels: labels as ReadonlyArray<ReadonlyArray<string>> } : {}),
      ...(Array.isArray(excludedLabels) ? { excludedLabels } : {}),
    };
  };

  const persistedRead = Effect.fn("PullRequestService.persistedRead")(function* <A>(
    input: CredentialRef,
    operation: string,
    codec: Schema.Codec<A, string>,
    read: Effect.Effect<A, PullRequestError>,
  ) {
    const project = yield* requireProject(input);
    const key = [
      operation,
      project.api.kind,
      project.host.toLowerCase(),
      project.repository.toLowerCase(),
      project.project.id,
      project.project.workspaceRoot,
      String(input.number),
      input.expectedAccountId ?? "",
      input[credentialNamespace] ?? "",
    ]
      .map(encodeURIComponent)
      .join(":");
    const lookup = yield* Effect.cached(read);
    const encodedRead = lookup.pipe(
      Effect.flatMap((value) =>
        Schema.encodeEffect(codec)(value).pipe(
          Effect.mapError(
            (cause) =>
              new PullRequestOperationError({
                operation: "cache",
                detail: "Could not encode PR cache data.",
                cause,
              }),
          ),
        ),
      ),
    );
    const payload = yield* readCache.get(key, encodedRead, [
      `project:${input.projectId}`,
      refScope(input),
    ]);
    const decoded = yield* Schema.decodeEffect(codec)(payload).pipe(Effect.option);
    return Option.isSome(decoded) ? decoded.value : yield* lookup;
  });
  const summaryCodec = Schema.fromJsonString(PullRequestSummary);
  const stackCodec = Schema.fromJsonString(Schema.NullOr(PullRequestStack));

  const summary: PullRequestService["Service"]["summary"] = (input, options) => {
    const key = refCacheKey(input);
    const cached = persistedRead(input, "summary", summaryCodec, summaryUncached(input));
    const held = lastGoodSummary.peek(key);
    return held !== undefined &&
      input.allowStale !== false &&
      (options?.recoverTransientFailure !== false || held.state === "merged")
      ? Effect.succeed(held)
      : cached.pipe(
          Effect.tap((value) =>
            shouldReplaceHeldSummary(key, value) ? lastGoodSummary.record(key, value) : Effect.void,
          ),
        );
  };

  const stack: PullRequestService["Service"]["stack"] = (input, options) =>
    persistedRead(
      input,
      `stack:${options?.includeDetails !== false}`,
      stackCodec,
      stackUncached(input, options),
    );

  const listCache = yield* Cache.makeWith(
    (key: string) => {
      const [
        ,
        state,
        involvement,
        filters,
        projectId,
        projectIds,
        host,
        limit,
        query,
        cursorEntries,
      ] = JSON.parse(key) as [
        number,
        string,
        string | null,
        ReadonlyArray<string | ReadonlyArray<string> | null> | null,
        string | null,
        ReadonlyArray<string> | null,
        string | null,
        number | null,
        string | null,
        ReadonlyArray<[string, string]> | null,
      ];
      return listUncached({
        state,
        ...(involvement === null ? {} : { involvement }),
        ...(filters === null ? {} : { filters: filtersOfKey(filters) }),
        ...(projectId === null ? {} : { projectId }),
        ...(projectIds === null ? {} : { projectIds }),
        ...(host === null ? {} : { host }),
        ...(limit === null ? {} : { limit }),
        ...(query === null ? {} : { query }),
        ...(cursorEntries === null ? {} : { cursors: Object.fromEntries(cursorEntries) }),
      } as PullRequestListInput);
    },
    {
      capacity: LIST_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_CACHE_TTL : Duration.zero),
    },
  );
  const list: PullRequestService["Service"]["list"] = (input) => {
    const key = JSON.stringify([
      listingsEpoch,
      input.state,
      input.involvement ?? null,
      input.filters === undefined
        ? null
        : [
            input.filters.draft ?? null,
            input.filters.review ?? null,
            input.filters.checks ?? null,
            input.filters.author ?? null,
            input.filters.labels ?? null,
            input.filters.excludedLabels ?? null,
          ],
      input.projectId ?? null,
      input.projectIds === undefined ? null : [...input.projectIds].sort(),
      input.host ?? null,
      input.limit ?? null,
      input.query ?? null,
      input.cursors === undefined
        ? null
        : Object.entries(input.cursors).toSorted(([left], [right]) => left.localeCompare(right)),
    ]);
    // A replacement reader can join a lookup still finishing its previous reader's cancellation.
    return Cache.get(listCache, key).pipe(
      Effect.catchCauseIf(
        (cause) => Cause.hasInterruptsOnly(cause),
        (_cause) => Cache.get(listCache, key),
      ),
    );
  };

  const checksCache = yield* Cache.makeWith(
    (key: string) => {
      const input = refOfCacheKey(key);
      return requireProject(input).pipe(
        Effect.flatMap((project) =>
          project.api.getChangeRequestChecks === undefined
            ? Effect.succeed(null)
            : project.api
                .getChangeRequestChecks({
                  cwd: project.project.workspaceRoot,
                  repository: project.repository,
                  host: project.host,
                  number: input.number,
                })
                .pipe(
                  Effect.mapError(toPullRequestError("checks")),
                  observeRead,
                  Effect.map(({ value, observedAt }) => ({ ...value, observedAt })),
                ),
        ),
      );
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      // Expire from the read's start so checks seeded from a slow detail read keep their age.
      timeToLive: (exit) =>
        !Exit.isSuccess(exit)
          ? Duration.zero
          : exit.value === null
            ? CHECKS_CACHE_TTL
            : Duration.millis(
                Math.max(
                  0,
                  exit.value.observedAt +
                    Duration.toMillis(CHECKS_CACHE_TTL) -
                    clock.currentTimeMillisUnsafe(),
                ),
              ),
    },
  );

  const watchFingerprintCache = yield* Cache.makeWith(
    (key: string) => {
      const input = refOfCacheKey(key);
      return requireProject(input).pipe(
        Effect.flatMap((project) =>
          project.api.getChangeRequestWatchFingerprint === undefined
            ? Effect.succeed(null)
            : project.api
                .getChangeRequestWatchFingerprint({
                  cwd: project.project.workspaceRoot,
                  repository: project.repository,
                  host: project.host,
                  number: input.number,
                })
                .pipe(Effect.mapError(toPullRequestError("watchFingerprint"))),
        ),
      );
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? CHECKS_CACHE_TTL : Duration.zero),
    },
  );

  const detailCache = yield* Cache.makeWith(
    (key: string) => {
      const statsKey = statsCacheKey(key);
      return detailUncached(refOfCacheKey(key)).pipe(
        Effect.tap(
          Effect.fn("PullRequestService.recordDetailStats")(function* (value: PullRequestDetail) {
            // GitHub detail includes the same checks; the checks TTL counts from their observation.
            if (
              value.provider === "github" &&
              value.observedAt !== undefined &&
              !(yield* Cache.has(checksCache, key))
            ) {
              yield* Cache.set(checksCache, key, {
                state: value.state,
                checks: value.checks,
                observedAt: value.observedAt,
              });
            }
            recordStats(
              statsKey,
              {
                projectId: value.projectId,
                repository: value.repository,
                number: value.number,
                additions: value.additions,
                deletions: value.deletions,
              },
              yield* Clock.currentTimeMillis,
            );
          }),
        ),
      );
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? detailTimeToLive(exit.value.state) : Duration.zero,
    },
  );
  const summaryFromDetail = (
    detail: PullRequestDetail,
    previous: PullRequestSummary | undefined,
  ): PullRequestSummary => ({
    // Detail does not carry review/check summaries. Keep the last summary observation.
    ...previous,
    provider: detail.provider,
    projectId: detail.projectId,
    repository: detail.repository,
    number: detail.number,
    title: detail.title,
    url: detail.url,
    state: detail.state,
    isDraft: detail.isDraft,
    author: detail.author,
    additions: detail.additions,
    deletions: detail.deletions,
    changedFiles: detail.changedFiles,
    mergeability: detail.mergeability,
    headBranch: detail.headBranch,
    baseBranch: detail.baseBranch,
    closedAt: detail.closedAt,
    mergedAt: detail.mergedAt,
    updatedAt: detail.updatedAt,
    observedAt: detail.observedAt,
  });
  const shouldReplaceHeldSummary = (key: string, next: PullRequestSummary) =>
    supersedesReading(lastGoodSummary.peek(key), next);
  // Keep newest detail states across epochs/credentials; summary reads would mask subsequent detail changes.
  const detailStates = new Map<string, PullRequestReading>();
  const noteDetailReading = (ref: PullRequestRef, next: PullRequestSummary) =>
    Effect.suspend(() => {
      const scope = refScope(ref);
      const current = detailStates.get(scope);
      if (!supersedesReading(current, next)) return Effect.void;
      detailStates.delete(scope);
      if (detailStates.size >= REF_EPOCH_CAPACITY) {
        const oldest = detailStates.keys().next().value;
        if (oldest !== undefined) detailStates.delete(oldest);
      }
      detailStates.set(scope, {
        state: next.state,
        isDraft: next.isDraft,
        updatedAt: next.updatedAt,
        observedAt: next.observedAt,
      });
      return (current?.state !== next.state || current?.isDraft !== next.isDraft) &&
        ref.host !== undefined
        ? PubSub.publish(stateChanges, {
            host: ref.host,
            repository: ref.repository,
            number: ref.number,
          })
        : Effect.void;
    });
  // Keep routed reports separate; unverified reports must not outrank this environment's reads.
  const reportedStates = new Map<
    string,
    {
      readonly state: PullRequestState;
      readonly isDraft: boolean | undefined;
      readonly atMs: number;
    }
  >();
  const reportState: PullRequestService["Service"]["reportState"] = ({
    reference,
    state,
    isDraft,
  }) =>
    Effect.all([canonicalRef(reference), Clock.currentTimeMillis]).pipe(
      Effect.flatMap(([ref, nowMs]) =>
        Effect.suspend(() => {
          const scope = refScope(ref);
          const reported = reportedStates.get(scope);
          if (
            reported?.state === state &&
            reported.isDraft === isDraft &&
            nowMs - reported.atMs < REPORTED_STATE_DEDUPE_MS
          )
            return Effect.void;
          reportedStates.delete(scope);
          if (reportedStates.size >= REF_EPOCH_CAPACITY) {
            const oldest = reportedStates.keys().next().value;
            if (oldest !== undefined) reportedStates.delete(oldest);
          }
          reportedStates.set(scope, { state, isDraft, atMs: nowMs });
          return ref.host === undefined
            ? Effect.void
            : PubSub.publish(stateChanges, {
                host: ref.host,
                repository: ref.repository,
                number: ref.number,
              });
        }),
      ),
    );
  const detail: PullRequestService["Service"]["detail"] = (input) => {
    const key = refCacheKey(input);
    // Skip reads older than strict summaries; caching them would preserve regressions without asking the host again.
    const read = Cache.get(detailCache, key).pipe(
      Effect.tap((value) => {
        if (value.state === "merged") noteMerged(input);
        const summary = summaryFromDetail(value, lastGoodSummary.peek(key));
        return noteDetailReading(input, summary).pipe(
          Effect.andThen(
            shouldReplaceHeldSummary(key, summary)
              ? lastGoodSummary.record(key, summary)
              : Effect.void,
          ),
        );
      }),
    );
    return input.allowStale === false
      ? read.pipe(Effect.tap((value) => lastGoodDetail.record(key, value)))
      : lastGoodDetail.serveHeld(key, read);
  };

  const activityCache = yield* Cache.makeWith(
    (key: string) => {
      return activityUncached(refOfCacheKey(key));
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      timeToLive: (exit, key) =>
        Exit.isSuccess(exit) ? detailTimeToLive(lastGoodSummary.peek(key)?.state) : Duration.zero,
    },
  );

  const changeBreakdownCache = yield* Cache.makeWith(
    (key: string) => {
      const ref = refOfCacheKey(key);
      return requireProject(ref).pipe(
        Effect.flatMap((project) => {
          const read = project.api.getFileStats;
          if (read === undefined) return Effect.succeed(null);
          return read({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: ref.number,
          }).pipe(
            Effect.map(toChangeBreakdown),
            Effect.mapError(toPullRequestError("changeBreakdown")),
          );
        }),
      );
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      timeToLive: (exit, key) =>
        Exit.isSuccess(exit) ? detailTimeToLive(lastGoodSummary.peek(key)?.state) : Duration.zero,
    },
  );

  const previewCache = yield* Cache.makeWith(
    (key: string) => {
      return previewUncached(refOfCacheKey(key));
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? detailTimeToLive(exit.value.state) : Duration.zero,
    },
  );
  const preview: PullRequestService["Service"]["preview"] = (input) => {
    const key = refCacheKey(input);
    return Cache.getSuccess(detailCache, key).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Cache.get(previewCache, key),
          onSome: (detail) => Effect.succeed(previewFields(detail)),
        }),
      ),
    );
  };
  const activity: PullRequestService["Service"]["activity"] = (input) => {
    const key = refCacheKey(input);
    return Cache.get(activityCache, key);
  };

  const diffCache = yield* Cache.makeWith(
    (key: string) => {
      const [reference, cursor, commit] = JSON.parse(key) as [string, string | null, string | null];
      return diffUncached({
        ...refOfCacheKey(reference),
        ...(cursor === null ? {} : { cursor }),
        ...(commit === null ? {} : { commit }),
      } as PullRequestDiffInput).pipe(
        observeRead,
        Effect.tap(({ value, observedAt }) => {
          // Keep the loader's epoch and read time if a refresh occurs during the provider read.
          diffFiles.record(JSON.stringify([reference, cursor, commit]), value, observedAt);
          return Effect.void;
        }),
      );
    },
    {
      capacity: DIFF_CACHE_CAPACITY,
      timeToLive: (exit, key) => {
        if (!Exit.isSuccess(exit)) return Duration.zero;
        const commit = (JSON.parse(key) as ReadonlyArray<unknown>)[2];
        const ttl = Duration.toMillis(commit === null ? DIFF_CACHE_TTL : COMMIT_DIFF_CACHE_TTL);
        return Duration.millis(
          Math.max(0, exit.value.observedAt + ttl - clock.currentTimeMillisUnsafe()),
        );
      },
    },
  );
  // Diffs expire only when their keys are reread; push-dependent keys leave closed pages' patches retained.
  let diffSweepPending = false;
  // Fork in service context atomically with the flag to avoid stranded flags and retained caller requests.
  const armDiffSweep = () => {
    if (diffSweepPending) return;
    diffSweepPending = true;
    runFork(Effect.forkIn(sweepDiffs, scope));
  };
  const sweepDiffs: Effect.Effect<void> = Effect.sleep(DIFF_SWEEP_INTERVAL).pipe(
    Effect.andThen(
      Effect.suspend(() => {
        diffSweepPending = false;
        return staleDiff.dropExpired;
      }),
    ),
    Effect.flatMap((stale) =>
      Effect.map(Cache.keys(diffCache), (keys) => stale + Array.from(keys).length),
    ),
    Effect.map((held) => {
      if (held > 0) armDiffSweep();
    }),
  );
  const readDiff = (input: PullRequestDiffInput) => {
    const key = JSON.stringify([
      refCacheKey(input),
      input.cursor ?? null,
      input.commit ?? null,
      input.commit === undefined
        ? (lastGoodSummary.peek(refCacheKey(input))?.updatedAt ?? null)
        : null,
    ]);
    const evictDiffs = Cache.entries(diffCache).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          diffCacheEvictions(Array.from(entries, ([key, read]) => [key, read.value] as const)),
          (evicted) => Cache.invalidate(diffCache, evicted),
        ),
      ),
      Effect.uninterruptible,
    );
    const read = Cache.get(diffCache, key).pipe(
      Effect.ensuring(evictDiffs),
      Effect.ensuring(Effect.sync(armDiffSweep)),
    );
    return { key, read };
  };
  const diff: PullRequestService["Service"]["diff"] = (input) => {
    const { key, read } = readDiff(input);
    return staleDiff.serve(key, read.pipe(Effect.map((read) => read.value)));
  };

  const filesViewedCache = yield* Cache.makeWith(
    (key: string) => {
      const [referenceKey] = JSON.parse(key) as [string, number];
      return viewedFiles.filesViewed(refOfCacheKey(referenceKey));
    },
    {
      capacity: FILES_VIEWED_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? FILES_VIEWED_CACHE_TTL : Duration.zero),
    },
  );
  // Key canonical refs to match epochs bumped with the remote's spelling.
  const filesViewed: PullRequestService["Service"]["filesViewed"] = (input) =>
    canonicalRef(input).pipe(
      Effect.flatMap((ref) =>
        Cache.get(filesViewedCache, JSON.stringify([refCacheKey(ref), filesViewedEpoch(ref)])),
      ),
    );

  const listStatsCache = yield* Cache.makeWith(
    (key: string) => {
      const [, refs] = JSON.parse(key) as [number, ReadonlyArray<[string, string, number, number]>];
      return listStatsUncached({
        refs: refs.map(([projectId, repository, number]) => ({ projectId, repository, number })),
      } as unknown as PullRequestListStatsInput).pipe(
        Effect.flatMap((result) =>
          Clock.currentTimeMillis.pipe(Effect.map((at) => ({ result, at }))),
        ),
      );
    },
    {
      capacity: LIST_STATS_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_STATS_CACHE_TTL : Duration.zero),
    },
  );
  const statsBatchKey = (refs: Iterable<PullRequestRef>) =>
    JSON.stringify([
      listingsEpoch,
      [...refs]
        .map((ref) => [ref.projectId, ref.repository, ref.number, refEpoch(ref)] as const)
        .toSorted((left, right) =>
          `${left[0]} ${left[1]} ${left[2]}`.localeCompare(`${right[0]} ${right[1]} ${right[2]}`),
        ),
    ]);
  const listStats: PullRequestService["Service"]["listStats"] = Effect.fn(
    "PullRequestService.listStats",
  )(function* (input: PullRequestListStatsInput) {
    if (input.refs.length === 0) return { stats: [] };
    const now = yield* Clock.currentTimeMillis;
    const held: PullRequestDiffStat[] = [];
    const missing = new Map<string, PullRequestRef>();
    for (const ref of input.refs) {
      const key = statsCacheKey(refCacheKey(ref));
      const cached = recentStats.get(key);
      if (cached !== undefined && now - cached.at < Duration.toMillis(LIST_STATS_CACHE_TTL)) {
        held.push(cached.value);
      } else {
        missing.set(key, ref);
      }
    }
    if (missing.size === 0) return { stats: held };
    const key = statsBatchKey(missing.values());
    const { result, at } = yield* Cache.get(listStatsCache, key).pipe(
      Effect.catchCauseIf(
        (cause) => Cause.hasInterruptsOnly(cause),
        (_cause) => Cache.get(listStatsCache, key),
      ),
    );
    for (const [key, ref] of missing) {
      const stat = result.stats.find(
        (stat) =>
          stat.projectId === ref.projectId &&
          stat.repository.toLowerCase() === ref.repository.toLowerCase() &&
          stat.number === ref.number,
      );
      if (stat !== undefined) recordStats(key, stat, at);
    }
    return { stats: [...held, ...result.stats] };
  });

  const forgetProviderReads = (scope?: { readonly repository: string; readonly number?: number }) =>
    Effect.forEach(
      registry.kinds,
      (kind) => registry.get(kind)?.forgetChangeRequestReads?.(scope) ?? Effect.void,
      { discard: true },
    );

  const invalidate: PullRequestService["Service"]["invalidate"] = Effect.fn(
    "PullRequestService.invalidate",
  )(function* (input, options) {
    const reference = input.reference;
    if (input.filesViewedOnly === true) {
      return yield* reference === undefined
        ? Cache.invalidateAll(filesViewedCache)
        : canonicalRef(reference).pipe(
            Effect.flatMap((ref) => Effect.sync(() => bumpFilesViewedEpoch(ref))),
            Effect.ignore,
          );
    }
    if (reference !== undefined) {
      yield* canonicalRef(reference).pipe(
        Effect.flatMap((ref) =>
          forgetProviderReads({ repository: ref.repository, number: ref.number }).pipe(
            Effect.andThen(readCache.invalidate(refScope(ref))),
            Effect.andThen(Effect.sync(() => bumpRefEpoch(ref))),
          ),
        ),
        Effect.ignore,
      );
    } else {
      yield* forgetProviderReads();
      listingsEpoch = ++epochCounter;
      everyFileRevisionEpoch = ++epochCounter;
      viewersByHost.clear();
      yield* Cache.invalidateAll(viewerFlights);
    }
    if (options?.notifyReaders) {
      yield* SubscriptionRef.set(pullRequestRefreshes, ++epochCounter);
    }
  });

  const refreshAfterTurn: PullRequestService["Service"]["refreshAfterTurn"] = Effect.fn(
    "PullRequestService.refreshAfterTurn",
  )(function* (projectId) {
    // Everything the provider holds, not just the project's repository: a turn can touch a
    // change request reached through another repository, and no epoch may move until those
    // reads are gone, or a reader in between keeps the old one under the new epoch.
    yield* forgetProviderReads();
    listingsEpoch = ++epochCounter;
    projectEpochs.delete(projectId);
    if (projectEpochs.size >= REF_EPOCH_CAPACITY) {
      const oldest = projectEpochs.keys().next().value;
      if (oldest !== undefined) {
        projectEpochFloor = projectEpochs.get(oldest)!;
        projectEpochs.delete(oldest);
      }
    }
    projectEpochs.set(projectId, listingsEpoch);
    const epoch = listingsEpoch;
    yield* readCache.invalidate(`project:${projectId}`);
    yield* SubscriptionRef.set(pullRequestRefreshes, epoch);
  });

  const invalidatedByMutation =
    <I extends PullRequestRef>(
      method: (input: I) => Effect.Effect<void, PullRequestError>,
    ): ((input: I) => Effect.Effect<void, PullRequestError>) =>
    (input) =>
      Effect.gen(function* () {
        const ref = yield* canonicalRef(input);
        yield* readCache.invalidate(refScope(ref)).pipe(
          Effect.andThen(method(input)),
          Effect.ensuring(readCache.invalidate(refScope(ref))),
          Effect.tap(() =>
            Effect.sync(() => {
              bumpRefEpoch(ref);
              listingsEpoch = ++epochCounter;
            }),
          ),
        );
        yield* SubscriptionRef.set(pullRequestRefreshes, listingsEpoch);
      });
  const runActionAndInvalidate: PullRequestService["Service"]["runAction"] = Effect.fn(
    "PullRequestService.runActionAndInvalidate",
  )(function* (input) {
    const ref = yield* canonicalRef(input);
    yield* readCache.invalidate(refScope(ref));
    const repository = yield* runAction(input).pipe(
      Effect.ensuring(readCache.invalidate(refScope(ref))),
    );
    bumpRefEpoch({ ...ref, repository });
    listingsEpoch = ++epochCounter;
    yield* SubscriptionRef.set(pullRequestRefreshes, listingsEpoch);
    if (input.action === "merge") {
      // A successful merge action can merely enqueue the PR or enable auto-merge.
      const confirmed = yield* summaryUncached({ ...input, repository }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to confirm pull request merge", { error }).pipe(
            Effect.as(null),
          ),
        ),
      );
      if (confirmed?.state !== "merged") return;
      yield* PubSub.publish(mergedPullRequests, {
        projectId: input.projectId,
        repository,
        number: input.number,
        mergedAt: DateTime.formatIso(yield* DateTime.now),
      });
    }
  });

  const credentialCached =
    <I extends PullRequestRef, Args extends ReadonlyArray<unknown>, A, E>(
      read: (input: I, ...args: Args) => Effect.Effect<A, E>,
    ) =>
    (input: I, ...args: Args) =>
      Effect.gen(function* () {
        const ref = yield* canonicalRef(input);
        const credential = yield* routingCredential;
        return yield* read(
          credential === null
            ? ref
            : { ...ref, [credentialNamespace]: credential.credentialFingerprint },
          ...args,
        );
      });

  // Cache small filename lists even when patches exceed limits, avoiding diff refetches on file expansion.
  const diffFiles = (() => {
    const held = new Map<
      string,
      {
        readonly at: number;
        readonly files: ReadonlySet<string>;
        readonly nextCursor: string | null;
      }
    >();
    const ttlMs = Duration.toMillis(DIFF_CACHE_TTL);
    const fileKey = (oldPath: string, newPath: string) => JSON.stringify([oldPath, newPath]);
    const sliceKey = (input: PullRequestDiffInput) =>
      JSON.stringify([refCacheKey(input), input.cursor ?? null, input.commit ?? null]);
    const recordPaths = (key: string, slice: ProviderDiffFilePaths, at: number) => {
      const entry = {
        at,
        files: new Set(slice.files.map((file) => fileKey(file.oldPath, file.newPath))),
        nextCursor: slice.nextCursor,
      };
      held.delete(key);
      if (held.size >= DIFF_CACHE_CAPACITY) {
        const oldest = held.keys().next().value;
        if (oldest !== undefined) held.delete(oldest);
      }
      held.set(key, entry);
      return entry;
    };
    const record = (key: string, slice: PullRequestDiffResult, at: number) =>
      recordPaths(
        key,
        {
          files: parseDiffFilePaths(slice.patch).map((file) => ({
            oldPath: file.oldPath ?? file.newPath ?? "",
            newPath: file.newPath ?? file.oldPath ?? "",
          })),
          nextCursor: slice.nextCursor,
        },
        at,
      );
    const read = Effect.fn("PullRequestService.read")(function* (input: PullRequestDiffInput) {
      const key = sliceKey(input);
      const now = yield* Clock.currentTimeMillis;
      const cached = held.get(key);
      if (cached !== undefined && now - cached.at <= ttlMs) return cached;
      const project = yield* requireProject(input);
      if (project.api.capabilities.diff && project.api.getDiffFilePaths) {
        const slice = yield* project.api
          .getDiffFilePaths({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            ...(input.commit === undefined ? {} : { commit: input.commit }),
          })
          .pipe(Effect.mapError(toPullRequestError("diffFileContents")));
        return recordPaths(key, slice, now);
      }
      const { value, observedAt } = yield* readDiff(input).read;
      return record(key, value, observedAt);
    });
    return { read: credentialCached(read), record, fileKey };
  })();
  const changesFile = (input: PullRequestDiffFileContentsInput) => {
    const wanted = diffFiles.fileKey(input.oldPath, input.newPath);
    const walk = (cursor: string | undefined): Effect.Effect<boolean, PullRequestError> =>
      diffFiles
        .read({
          ...input,
          ...(cursor === undefined ? {} : { cursor }),
          ...(input.commit === undefined ? {} : { commit: input.commit }),
        })
        .pipe(
          Effect.flatMap((slice) =>
            slice.files.has(wanted)
              ? Effect.succeed(true)
              : slice.nextCursor === null
                ? Effect.succeed(false)
                : walk(slice.nextCursor),
          ),
        );
    return walk(undefined);
  };
  // PR read access does not grant arbitrary repository reads with the project credential; restrict to changed files.
  const diffFileContents: PullRequestService["Service"]["diffFileContents"] = (input) =>
    changesFile(input).pipe(
      Effect.flatMap((changed) =>
        changed
          ? readDiffFileContents(input)
          : Effect.fail(
              new PullRequestOperationError({
                operation: "diffFileContents",
                detail: "This file is not part of the change request.",
                reason: "not-found",
              }),
            ),
      ),
    );

  return PullRequestService.of({
    routing,
    routingIdentity,
    withRoutingCredential,
    list,
    filterOptions,
    // The local operation owns the span; this wrapper only canonicalizes refs.
    listStats: Effect.fnUntraced(function* (input) {
      const refs = yield* Effect.forEach(input.refs, (ref) =>
        canonicalRef(ref).pipe(Effect.option),
      );
      return yield* listStats({ ...input, refs: refs.flatMap(Option.toArray) });
    }),
    summary: credentialCached(summary),
    stack: credentialCached(stack),
    subscribeMerges: PubSub.subscribe(mergedPullRequests).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
    subscribeStateChanges: PubSub.subscribe(stateChanges).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
    reportState,
    subscribeRefreshes: SubscriptionRef.changes(pullRequestRefreshes).pipe(
      Stream.filter((revision) => revision > 0),
    ),
    refreshAfterTurn,
    detail: credentialCached(detail),
    checks: credentialCached((input) => Cache.get(checksCache, refCacheKey(input))),
    watchFingerprint: credentialCached((input) =>
      Cache.get(watchFingerprintCache, refCacheKey(input)),
    ),
    activity: credentialCached(activity),
    preview: credentialCached(preview),
    threadComments,
    diff: credentialCached(diff),
    diffFileContents,
    filesViewed: credentialCached(filesViewed),
    setFilesViewed,
    changeBreakdown: credentialCached((input) =>
      Cache.get(changeBreakdownCache, refCacheKey(input)),
    ),
    runAction: runActionAndInvalidate,
    update: invalidatedByMutation(update),
    comment: invalidatedByMutation(comment),
    updateComment: invalidatedByMutation(updateComment),
    submitReview: invalidatedByMutation(submitReview),
    replyToThread: invalidatedByMutation(replyToThread),
    setThreadResolution: invalidatedByMutation(setThreadResolution),
    setReaction: invalidatedByMutation(setReaction),
    reviewerCandidates,
    requestReviewers: invalidatedByMutation(requestReviewers),
    labelCandidates,
    setLabels: invalidatedByMutation(setLabels),
    invalidate,
  });
});

export const layer = Layer.effect(PullRequestService, make);
