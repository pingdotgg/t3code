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
import type { PullRequestError, PullRequestMergeEvent } from "./pullRequestSupport.ts";
import { installRuntime } from "./pullRequestRuntime.ts";
import { installEpochs } from "./pullRequestEpochs.ts";
import { installWorkspace } from "./pullRequestWorkspace.ts";
import { installRouting } from "./pullRequestRouting.ts";
import { installDetailReads } from "./pullRequestDetailReads.ts";
import { installDiffs } from "./pullRequestDiffs.ts";
import { installListing } from "./pullRequestListing.ts";
import { installMutations } from "./pullRequestMutations.ts";
import { installLifecycle } from "./pullRequestLifecycle.ts";

export type {
  PullRequestError,
  PullRequestMergeEvent,
  SupportedProject,
  WorkspaceProjects,
} from "./pullRequestSupport.ts";

// Pull request service composition root: the service tag, its shape and the layer that
// installs the per-concern read, mutation and lifecycle modules in dependency order.

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
    /** Project and remote lookups inside `effect` read once per filter, e.g. across one sync sweep. */
    readonly withSharedProjectReads: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
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

export const make = Effect.gen(function* () {
  const d0 = yield* installRuntime({});
  const d1 = Object.assign(d0, yield* installEpochs(d0));
  const d2 = Object.assign(d1, yield* installWorkspace(d1));
  const d3 = Object.assign(d2, yield* installRouting(d2));
  const d4 = Object.assign(d3, yield* installDetailReads(d3));
  const d5 = Object.assign(d4, yield* installDiffs(d4));
  const d6 = Object.assign(d5, yield* installListing(d5));
  const d7 = Object.assign(d6, yield* installMutations(d6));
  const d8 = Object.assign(d7, yield* installLifecycle(d7));

  return PullRequestService.of({
    withSharedProjectReads: d8.withSharedProjectReads,
    routing: d8.routing,
    routingIdentity: d8.routingIdentity,
    withRoutingCredential: d8.withRoutingCredential,
    list: d8.list,
    filterOptions: d8.filterOptions,
    // The local operation owns the span; this wrapper only canonicalizes refs.
    listStats: Effect.fnUntraced(function* (input) {
      const refs = yield* Effect.forEach(input.refs, (ref) =>
        d8.canonicalRef(ref).pipe(Effect.option),
      );
      return yield* d8.listStats({ ...input, refs: refs.flatMap(Option.toArray) });
    }),
    summary: d8.credentialCached(d8.summary),
    stack: d8.credentialCached(d8.stack),
    subscribeMerges: PubSub.subscribe(d8.mergedPullRequests).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
    subscribeStateChanges: PubSub.subscribe(d8.stateChanges).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
    reportState: d8.reportState,
    subscribeRefreshes: SubscriptionRef.changes(d8.pullRequestRefreshes).pipe(
      Stream.filter((revision) => revision > 0),
    ),
    refreshAfterTurn: d8.refreshAfterTurn,
    detail: d8.credentialCached(d8.detail),
    checks: d8.credentialCached((input) => Cache.get(d8.checksCache, d8.refCacheKey(input))),
    watchFingerprint: d8.credentialCached((input) =>
      Cache.get(d8.watchFingerprintCache, d8.refCacheKey(input)),
    ),
    activity: d8.credentialCached(d8.activity),
    preview: d8.credentialCached(d8.preview),
    threadComments: d8.threadComments,
    diff: d8.credentialCached(d8.diff),
    diffFileContents: d8.diffFileContents,
    filesViewed: d8.credentialCached(d8.filesViewed),
    setFilesViewed: d8.setFilesViewed,
    changeBreakdown: d8.credentialCached((input) =>
      Cache.get(d8.changeBreakdownCache, d8.refCacheKey(input)),
    ),
    runAction: d8.runActionAndInvalidate,
    update: d8.invalidatedByMutation(d8.update),
    comment: d8.invalidatedByMutation(d8.comment),
    updateComment: d8.invalidatedByMutation(d8.updateComment),
    submitReview: d8.invalidatedByMutation(d8.submitReview),
    replyToThread: d8.invalidatedByMutation(d8.replyToThread),
    setThreadResolution: d8.invalidatedByMutation(d8.setThreadResolution),
    setReaction: d8.invalidatedByMutation(d8.setReaction),
    reviewerCandidates: d8.reviewerCandidates,
    requestReviewers: d8.invalidatedByMutation(d8.requestReviewers),
    labelCandidates: d8.labelCandidates,
    setLabels: d8.invalidatedByMutation(d8.setLabels),
    invalidate: d8.invalidate,
  });
});

export const layer = Layer.effect(PullRequestService, make);
