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
import { CHECKS_CACHE_TTL, DETAIL_CACHE_CAPACITY, STALE_DETAIL_WINDOW, credentialNamespace, detailTimeToLive, isPullRequestProviderError, observeRead, supersedesReading, type SuccessOf } from "./pullRequestSupport.ts";
import type { CredentialRef, PullRequestError, PullRequestReading } from "./pullRequestSupport.ts";
import { installRuntime } from "./pullRequestRuntime.ts";
import { installEpochs } from "./pullRequestEpochs.ts";
import { installWorkspace } from "./pullRequestWorkspace.ts";
import { installRouting } from "./pullRequestRouting.ts";

export type Deps = SuccessOf<typeof installRuntime> & SuccessOf<typeof installEpochs> & SuccessOf<typeof installWorkspace> & SuccessOf<typeof installRouting>;

export const installDetailReads = Effect.fn("pullRequest.installDetailReads")(function* (d: Deps) {
    const { REF_EPOCH_CAPACITY, clock, noteMerged, readCache, recordStats, refCacheKey, refOfCacheKey, refScope, requireProject, runFork, stateChanges, statsCacheKey, toPullRequestError, viewerOf } = d;
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

  const stack: PullRequestService["Service"]["stack"] = (input, options) =>
    persistedRead(
      input,
      `stack:${options?.includeDetails !== false}`,
      stackCodec,
      stackUncached(input, options),
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

  const revalidate = <A, E>(read: Effect.Effect<A, E>) =>
    Effect.context<never>().pipe(
      Effect.flatMap((caller) =>
        Effect.sync(() => runFork(Effect.ignore(read).pipe(Effect.provideContext(caller)))),
      ),
    );

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

  const activity: PullRequestService["Service"]["activity"] = (input) => {
    const key = refCacheKey(input);
    return Cache.get(activityCache, key);
  };

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
    return {
      summaryUncached,
      summary,
      stackUncached,
      stack,
      detailCache,
      detailUncached,
      detail,
      summaryFromDetail,
      shouldReplaceHeldSummary,
      detailStates,
      noteDetailReading,
      makeLastGoodRead,
      lastGoodSummary,
      lastGoodDetail,
      persistedRead,
      summaryCodec,
      stackCodec,
      checksCache,
      watchFingerprintCache,
      revalidate,
      previewUncached,
      previewFields,
      previewCache,
      preview,
      activityUncached,
      activityCache,
      activity,
      threadComments,
    };
  });
