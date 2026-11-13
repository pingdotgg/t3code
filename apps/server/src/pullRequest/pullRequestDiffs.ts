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
import { COMMIT_DIFF_CACHE_TTL, DETAIL_CACHE_CAPACITY, DIFF_CACHE_CAPACITY, DIFF_CACHE_TTL, DIFF_STALE_WINDOW, DIFF_SWEEP_INTERVAL, FILES_VIEWED_CACHE_CAPACITY, FILES_VIEWED_CACHE_TTL, canCacheDiff, detailTimeToLive, diffCacheEvictions, observeRead, type SuccessOf } from "./pullRequestSupport.ts";
import type { PullRequestError } from "./pullRequestSupport.ts";
import { installRuntime } from "./pullRequestRuntime.ts";
import { installEpochs } from "./pullRequestEpochs.ts";
import { installWorkspace } from "./pullRequestWorkspace.ts";
import { installRouting } from "./pullRequestRouting.ts";
import { installDetailReads } from "./pullRequestDetailReads.ts";

export type Deps = SuccessOf<typeof installRuntime> & SuccessOf<typeof installEpochs> & SuccessOf<typeof installWorkspace> & SuccessOf<typeof installRouting> & SuccessOf<typeof installDetailReads>;

export const installDiffs = Effect.fn("pullRequest.installDiffs")(function* (d: Deps) {
    const { canonicalRef, clock, credentialCached, filesViewedEpoch, filesViewedStore, lastGoodSummary, refCacheKey, refEpoch, refOfCacheKey, requireProject, requiredViewerOf, revalidate, runFork, scope, toPullRequestError } = d;
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

  let diffSweepPending = false;
  // Fork in service context atomically with the flag to avoid stranded flags and retained caller requests.

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

  const viewedFiles = ViewedFiles.make({
    filesViewedStore,
    requireProject,
    requiredViewerOf,
    toPullRequestError,
    runFork,
    refEpoch,
    fileRevisionsEpoch: () => d.everyFileRevisionEpoch,
  });
    return {
      diffUncached,
      readDiffFileContents,
      diffCache,
      staleDiff,
      armDiffSweep,
      sweepDiffs,
      diffSweepPending,
      readDiff,
      diff,
      filesViewedCache,
      filesViewed,
      changeBreakdownCache,
      diffFiles,
      changesFile,
      diffFileContents,
      viewedFiles,
    };
  });
