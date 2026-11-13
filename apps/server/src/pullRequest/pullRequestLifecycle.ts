// @effect-diagnostics anyUnknownInErrorContext:off
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
import type { PullRequestService } from "./PullRequestService.ts";
import { REPORTED_STATE_DEDUPE_MS, type SuccessOf } from "./pullRequestSupport.ts";
import { installRuntime } from "./pullRequestRuntime.ts";
import { installEpochs } from "./pullRequestEpochs.ts";
import { installWorkspace } from "./pullRequestWorkspace.ts";
import { installRouting } from "./pullRequestRouting.ts";
import { installDetailReads } from "./pullRequestDetailReads.ts";
import { installDiffs } from "./pullRequestDiffs.ts";
import { installListing } from "./pullRequestListing.ts";
import { installMutations } from "./pullRequestMutations.ts";

export type Deps = SuccessOf<typeof installRuntime> & SuccessOf<typeof installEpochs> & SuccessOf<typeof installWorkspace> & SuccessOf<typeof installRouting> & SuccessOf<typeof installDetailReads> & SuccessOf<typeof installDiffs> & SuccessOf<typeof installListing> & SuccessOf<typeof installMutations>;

export const installLifecycle = Effect.fn("pullRequest.installLifecycle")(function* (d: Deps) {
    const { REF_EPOCH_CAPACITY, bumpFilesViewedEpoch, bumpRefEpoch, canonicalRef, filesViewedCache, forgetProviderReads, pullRequestRefreshes, readCache, refScope, stateChanges, viewerFlights, viewersByHost } = d;
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
      d.listingsEpoch = ++d.epochCounter;
      d.everyFileRevisionEpoch = ++d.epochCounter;
      viewersByHost.clear();
      yield* Cache.invalidateAll(viewerFlights);
    }
    if (options?.notifyReaders) {
      yield* SubscriptionRef.set(pullRequestRefreshes, ++d.epochCounter);
    }
  });

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
    return {
      invalidate,
      reportedStates,
      reportState,
    };
  });
