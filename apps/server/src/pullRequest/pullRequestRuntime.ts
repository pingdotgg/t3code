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
import { toPullRequestErrorWith, type SuccessOf } from "./pullRequestSupport.ts";
import type { PullRequestMergeEvent, UnavailableRequirementOf } from "./pullRequestSupport.ts";

export type Deps = {};

export const installRuntime = Effect.fn("pullRequest.installRuntime")(function* (d: Deps) {
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

  const context = yield* Effect.context<never>();

  const scope = yield* Effect.scope;

  const runFork = Effect.runForkWith(context);

  // Refuse failed viewer lookups; unnamed fallbacks hide marks and orphan subsequent writes.
    return {
      mergedPullRequests,
      stateChanges,
      pullRequestRefreshes,
      registry,
      requirementOf,
      toPullRequestError,
      serverSettings,
      projects,
      repositoryIdentities,
      sourceControlProviders,
      rateLimits,
      filesViewedStore,
      readCache,
      clock,
      context,
      scope,
      runFork,
    };
  });
