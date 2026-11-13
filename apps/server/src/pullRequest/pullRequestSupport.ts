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
// Shared value/type vocabulary for the pull request service: cache budgets, cursor
// codec, provider error mapping, filter ranking and the routing credential reference.

export type SuccessOf<F> = F extends (...args: never[]) => import("effect/Effect").Effect<
  infer A,
  infer _E,
  infer _R
>
  ? A
  : never;

export interface PullRequestMergeEvent extends PullRequestRef {
  readonly mergedAt: string;
}

export type PullRequestReading = Pick<
  PullRequestSummary,
  "state" | "isDraft" | "updatedAt" | "observedAt"
>;

export function supersedesReading(current: PullRequestReading | undefined, next: PullRequestReading) {
  if (current === undefined) return true;
  if (current.state === "merged" && next.state !== "merged") return false;
  if (next.updatedAt !== current.updatedAt) return next.updatedAt > current.updatedAt;
  return (next.observedAt ?? -Infinity) >= (current.observedAt ?? -Infinity);
}

// Providers request one extra row; 99 stays within GitHub/GitLab's 100-row API limit.
export const DEFAULT_REPOSITORY_LIST_LIMIT = 99;
export const REPOSITORY_CONCURRENCY = 12;
export const REPOSITORY_SEARCH_CHUNK = 100;
export const FILTERED_LIST_READS = 5;

// Host reads spawn CLIs and hit low quotas; briefly share results and identical in-flight reads.
export const LIST_CACHE_TTL = Duration.seconds(30);
export const DETAIL_CACHE_TTL = Duration.seconds(60);
export const MERGED_DETAIL_CACHE_TTL = Duration.minutes(10);
export const detailTimeToLive = (state: PullRequestState | undefined) =>
  state === "merged" ? MERGED_DETAIL_CACHE_TTL : DETAIL_CACHE_TTL;
export const CHECKS_CACHE_TTL = Duration.seconds(15);
export const REPORTED_STATE_DEDUPE_MS = 5 * 60 * 1_000;
export const DIFF_CACHE_TTL = Duration.seconds(60);
export const COMMIT_DIFF_CACHE_TTL = Duration.minutes(10);
export const LIST_STATS_CACHE_TTL = Duration.seconds(60);
export const FILES_VIEWED_CACHE_TTL = Duration.seconds(15);
export const DIFF_STALE_WINDOW = Duration.minutes(10);
export const DIFF_SWEEP_INTERVAL = Duration.minutes(1);
export const VIEWER_CACHE_TTL = Duration.minutes(10);
export const STALE_DETAIL_WINDOW = Duration.minutes(10);
export const isPullRequestProviderError = Schema.is(PullRequestProviderError);
export const LIST_CACHE_CAPACITY = 64;
export const LIST_STATS_CACHE_CAPACITY = 32;
export const DETAIL_CACHE_CAPACITY = 128;
export const DIFF_CACHE_CAPACITY = 128;
// Each holder stays within this UTF-16 patch budget as well as its entry-count bound.
export const DIFF_CACHE_PATCH_BUDGET_BYTES = 32 * 1024 * 1024;
export const canCacheDiff = (value: PullRequestDiffResult) =>
  value.patch.length * 2 <= DIFF_CACHE_PATCH_BUDGET_BYTES;
export const diffCacheEvictions = (entries: Iterable<readonly [string, PullRequestDiffResult]>) => {
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
export const FILES_VIEWED_CACHE_CAPACITY = 128;
export const VIEWER_CACHE_CAPACITY = 32;

export type PullRequestError = PullRequestUnavailableError | PullRequestOperationError;

export const routingCredential = Context.Reference<{
  readonly credentialFingerprint: string;
  readonly viewer: string;
} | null>("t3/PullRequestService/routingCredential", { defaultValue: () => null });
export const credentialNamespace = Symbol("pullRequestCredentialNamespace");
export type CredentialRef = PullRequestRef & { readonly [credentialNamespace]?: string };

export const VERDICT_LABELS: Record<PullRequestReviewVerdict, string> = {
  comment: "review",
  approve: "approve",
  "request-changes": "request changes on",
};

export const ACTION_ACCESS_REFUSALS: Record<PullRequestAction, string> = {
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

export const REVIEWER_REQUEST_REFUSAL = "You need write access on this repository to ask for a review.";
export const LABEL_CHANGE_REFUSAL = "You need triage access on this repository to change its labels.";

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

export interface WorkspaceProjects {
  readonly supported: ReadonlyArray<SupportedProject>;
  readonly unimplemented: ReadonlyMap<
    string,
    { readonly kind: SourceControlProviderKind; readonly projectCount: number }
  >;
  readonly viewerRoots: ReadonlyMap<string, ReadonlyArray<string>>;
}

// Inherited by fibers forked inside the scope, so it is closed, not just dropped, when the scope ends.
export const sharedProjectReads = Context.Reference<{
  open: boolean;
  readonly reads: Map<string, Effect.Effect<WorkspaceProjects, PullRequestError>>;
} | null>("t3/PullRequestService/sharedProjectReads", { defaultValue: () => null });

export interface RepositoryBatch {
  readonly key: string;
  readonly entries: ReadonlyArray<PullRequestListEntry>;
  readonly errors: ReadonlyArray<PullRequestListProjectError>;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export interface ListCursor extends ProviderListCursor {
  readonly seenAt: ReadonlyArray<number>;
}

export const LIST_CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))\|(\d{1,9})\|(\d{1,9}(?:,\d{1,9})*)?(?:\|([\w.:~+-]{1,128}))?$/;

export function parseListCursor(raw: string): ListCursor | null {
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

export function listCursorKey(host: string, repository: string): string {
  return `${host} ${repository.toLowerCase()}`;
}

// Preserve exclusions across slices sharing a timestamp to avoid redelivery.
export function nextListCursor(
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

export function listCursorAt(
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

export function isProviderUnusable(error: PullRequestProviderError): boolean {
  return error.reason === "missing-tool" || error.reason === "unauthenticated";
}

export type UnavailableRequirementOf = (
  kind: SourceControlProviderKind,
) => PullRequestProviderApi["unavailableRequirement"];

export function unavailableRequirement(
  requirementOf: UnavailableRequirementOf,
  error: PullRequestProviderError,
): string | undefined {
  const requirement = requirementOf(error.provider);
  if (requirement === undefined) return undefined;
  return error.reason === "missing-tool" ? requirement.missing : requirement.unauthenticated;
}

export function providerDetail(
  requirementOf: UnavailableRequirementOf,
  error: PullRequestProviderError,
): string {
  if (!isProviderUnusable(error)) return error.detail;
  return unavailableRequirement(requirementOf, error) ?? error.detail;
}

export function toPullRequestErrorWith(
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

export function withRateLimitBackoff(
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
    ...(api.servesHost === undefined ? {} : { servesHost: api.servesHost }),
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

export const FILTER_OPTIONS_LIMIT = 100;

/**
 * Exact matches first, then names that begin with the query, then the rest, so a short query
 * still puts the obvious answer at the top of a long list.
 */
export function rankFilterOptions<A>(
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

export const remoteHostKey = (recognized: SourceControlProviderInfo, remoteUrl: string) =>
  `${recognized.baseUrl}\n${isSshRemoteUrl(remoteUrl) ? "ssh" : "web"}`;

/** An HTTP remote names its server's web host, port included. */
export function httpRemoteHost(remoteUrl: string): string | null {
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
export const observeRead = Effect.fnUntraced(function* <A, E, R>(read: Effect.Effect<A, E, R>) {
  const observedAt = yield* Clock.currentTimeMillis;
  return { value: yield* read, observedAt };
});
