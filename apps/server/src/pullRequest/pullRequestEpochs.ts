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
import { credentialNamespace, type SuccessOf } from "./pullRequestSupport.ts";
import type { CredentialRef } from "./pullRequestSupport.ts";
import { installRuntime } from "./pullRequestRuntime.ts";

export type Deps = SuccessOf<typeof installRuntime>;

export const installEpochs = Effect.fn("pullRequest.installEpochs")(function* (d: Deps) {
    const { pullRequestRefreshes, readCache, registry } = d;
  let epochCounter = 0;

  let listingsEpoch = 0;

  const refEpochs = new Map<string, number>();

  const projectEpochs = new Map<ProjectId, number>();

  let projectEpochFloor = 0;

  const REF_EPOCH_CAPACITY = 2_048;

  const mergedEpochs = new Map<string, number>();

  const refScope = (ref: PullRequestRef) =>
    JSON.stringify([
      ref.projectId,
      ref.host?.toLowerCase() ?? "",
      ref.repository.toLowerCase(),
      ref.number,
    ]);

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

  const statsCacheKey = (key: string) => JSON.stringify([listingsEpoch, key]);

  const forgetProviderReads = (scope?: { readonly repository: string; readonly number?: number }) =>
    Effect.forEach(
      registry.kinds,
      (kind) => registry.get(kind)?.forgetChangeRequestReads?.(scope) ?? Effect.void,
      { discard: true },
    );

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
    return {
      epochCounter,
      listingsEpoch,
      refEpochs,
      projectEpochs,
      projectEpochFloor,
      REF_EPOCH_CAPACITY,
      mergedEpochs,
      refScope,
      refEpoch,
      noteMerged,
      refCacheKey,
      refOfCacheKey,
      bumpEpoch,
      bumpRefEpoch,
      filesViewedEpochs,
      filesViewedEpoch,
      bumpFilesViewedEpoch,
      everyFileRevisionEpoch,
      statsCacheKey,
      forgetProviderReads,
      refreshAfterTurn,
      recentStats,
      recordStats,
    };
  });
