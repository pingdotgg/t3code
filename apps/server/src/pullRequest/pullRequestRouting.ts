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
import { routingCredential, type SuccessOf } from "./pullRequestSupport.ts";
import { installRuntime } from "./pullRequestRuntime.ts";
import { installEpochs } from "./pullRequestEpochs.ts";
import { installWorkspace } from "./pullRequestWorkspace.ts";

export type Deps = SuccessOf<typeof installRuntime> & SuccessOf<typeof installEpochs> & SuccessOf<typeof installWorkspace>;

export const installRouting = Effect.fn("pullRequest.installRouting")(function* (d: Deps) {
    const { listWorkspaceProjects, registry, requireProject, toPullRequestError } = d;
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
    return {
      routing,
      routingIdentity,
      withRoutingCredential,
    };
  });
