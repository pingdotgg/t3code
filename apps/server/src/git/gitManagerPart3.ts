// @effect-diagnostics anyUnknownInErrorContext:off
// @effect-diagnostics missingReturnYieldStar:off
import * as Arr from "effect/Array";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  GitActionProgressEvent,
  GitActionProgressPhase,
  GitCommandError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  VcsStatusResult,
  ModelSelection,
  type OrchestrationV2TurnItem,
  type ProjectId,
  SourceControlProviderError,
  type SourceControlWritingStyleSettings,
  type ThreadId,
  type ThreadPullRequestKey,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
} from "@t3tools/contracts";
import {
  mergeGitStatusParts,
  resolveAutoFeatureBranchName,
  sanitizeBranchFragment,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/git";

import { GitManagerError, GitPullRequestMaterializationError } from "@t3tools/contracts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { detachStackFrame } from "./detachStackFrame.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { GitManager, PR_LOOKUP_CACHE_CAPACITY, SETTLED_PR_LOOKUP_RECHECK_INTERVAL, STATUS_RESULT_CACHE_CAPACITY, STATUS_RESULT_CACHE_TTL, isNotGitRepositoryError, isSourceControlProviderError, pullRequestRepositoryKey, toStatusPr, type SuccessOf } from "./GitManager.ts";
import type { BranchHeadContext, GitRemoteStatusOptions } from "./GitManager.ts";
import { install0 } from "./gitManagerPart0.ts";
import { install1 } from "./gitManagerPart1.ts";
import { install2 } from "./gitManagerPart2.ts";

export type Deps = SuccessOf<typeof install0> & SuccessOf<typeof install1> & SuccessOf<typeof install2>;

export const install3 = Effect.fn("gitManager.install3")(function* (d: Deps) {
  const { bumpPrLookupEpoch, forgetPrLookupGitState, gitCore, invalidateLocalStatusResultCache, lastKnownPrByBranchKey, localStatus, normalizeStatusCacheKey, prLookupCache, prLookupCacheKey, readPrLookupBranchRef, readSettledPrLookupFingerprint, rememberLastKnownPr, rememberPrLookupGitState, resolveLastKnownPr, resolveLookupHeadContext, resolvePrLookupRepositoryIdentity, settledPrLookupByBranchKey } = d;
  const invalidateLocalStatus: GitManager["Service"]["invalidateLocalStatus"] = Effect.fn(
    "invalidateLocalStatus",
  )(function* (cwd) {
    yield* invalidateLocalStatusResultCache(cwd);
  });

  const getPrLookup = (key: string) => detachStackFrame(Cache.get(prLookupCache, key));

  const lookupStatusPr = Effect.fn("lookupStatusPr")(function* (
    cwd: string,
    details: {
      branch: string;
      upstreamRef: string | null;
      defaultBranch: string | null;
      isDefaultBranch: boolean;
    },
    refreshMissingPullRequest = false,
  ) {
    // Upstream changes must not orphan the same branch's fallback value.
    const branchKey = `${cwd}\u0000${details.branch}`;
    const cacheKey = prLookupCacheKey(cwd, details);
    if (refreshMissingPullRequest) {
      const cached = yield* Cache.getOption(prLookupCache, cacheKey).pipe(
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isSome(cached) && cached.value.latest === null) {
        yield* Cache.invalidate(prLookupCache, cacheKey);
      }
    }
    return yield* getPrLookup(cacheKey).pipe(
      Effect.map(({ latest, headContext }) => {
        if (!latest) return { pr: null, headSha: null, headContext };
        // Merged/closed matches are usually reverse-merge history, not the thread's PR context.
        if (details.isDefaultBranch && latest.state !== "open") {
          return { pr: null, headSha: null, headContext };
        }
        return { pr: toStatusPr(latest), headSha: latest.headSha ?? null, headContext };
      }),
      Effect.tap(({ pr, headSha, headContext }) =>
        Effect.sync(() =>
          rememberLastKnownPr(branchKey, {
            pr,
            headSha,
            upstreamRef: details.upstreamRef,
            headBranch: headContext.headBranch,
            remoteName: headContext.remoteName,
            headRemoteUrlKey: headContext.headRemoteUrlKey,
          }),
        ),
      ),
      Effect.map(({ pr, headSha }) => ({ pr, headSha })),
      Effect.catch((error) => {
        const fallback = lastKnownPrByBranchKey.get(branchKey)?.pr
          ? resolveLookupHeadContext(cwd, details).pipe(
              Effect.map(({ headContext }) =>
                resolveLastKnownPr(branchKey, {
                  upstreamRef: details.upstreamRef,
                  headBranch: headContext.headBranch,
                  remoteName: headContext.remoteName,
                  headRemoteUrlKey: headContext.headRemoteUrlKey,
                }),
              ),
            )
          : Effect.succeed(null);
        return Effect.logWarning("PR lookup failed.").pipe(
          Effect.annotateLogs({
            operation: "lookupStatusPr",
            branch: details.branch,
            errorTag:
              typeof error === "object" && error !== null && "_tag" in error
                ? String(error._tag)
                : typeof error,
            ...(isSourceControlProviderError(error)
              ? {
                  provider: error.provider,
                  providerOperation: error.operation,
                  ...(error.command === undefined ? {} : { providerCommand: error.command }),
                  errorDetail: error.detail,
                }
              : {}),
          }),
          Effect.andThen(fallback),
          Effect.map((lastKnown) => ({
            pr: lastKnown?.pr ?? null,
            headSha: lastKnown?.headSha ?? null,
          })),
        );
      }),
    );
  });

  const lookupBranchPullRequest = Effect.fn("lookupBranchPullRequest")(function* (
    cacheCwd: string,
    branch: string,
    options: { readonly refresh: boolean; readonly freshGitState: boolean },
  ) {
    const remember = <E>(key: string, read: Effect.Effect<string | null, E>) =>
      rememberPrLookupGitState(cacheCwd, key, options.freshGitState, read);
    const remotes = yield* remember(
      "remotes",
      gitCore
        .execute({
          operation: "GitManager.branchPullRequest.remotes",
          cwd: cacheCwd,
          args: ["remote"],
        })
        .pipe(Effect.map((result) => result.stdout)),
    );
    const remoteNames = (remotes ?? "")
      .split("\n")
      .map((remoteName) => remoteName.trim())
      .filter((remoteName) => remoteName.length > 0);
    const [firstRemoteName] = remoteNames;
    if (firstRemoteName === undefined) return null;
    const branchRef = yield* readPrLookupBranchRef(cacheCwd, branch, options.freshGitState);
    const expectedRefName = `refs/heads/${branch}`;
    const exactBranch = (branchRef ?? "")
      .split("\n")
      .find((line) => line.split("\u0000", 1)[0] === expectedRefName);
    const [refName = "", savedUpstream = "", savedRemoteName = "", savedRemoteRef = ""] =
      exactBranch?.split("\u0000") ?? [];
    const localBranchExists = refName.length > 0;
    let upstreamRef: string | null = null;
    let remoteName: string | null = null;
    if (savedUpstream.length > 0) {
      if (savedRemoteName.length === 0 || savedRemoteRef.length === 0) {
        return yield* new GitManagerError({
          operation: "branchPullRequest",
          cwd: cacheCwd,
          detail: `Saved upstream for ${branch} is incomplete.`,
        });
      }
      remoteName = savedRemoteName;
      const upstreamBranch = savedRemoteRef.replace(/^refs\/heads\//, "");
      upstreamRef = `${remoteName}/${upstreamBranch}`;
    } else if (!localBranchExists) {
      const trackingRemotes = yield* remember(
        `trackingRemotes\u0000${branch}`,
        gitCore
          .execute({
            operation: "GitManager.branchPullRequest.remoteTrackingRefs",
            cwd: cacheCwd,
            args: ["for-each-ref", "--format=%(refname)", "refs/remotes"],
          })
          .pipe(
            Effect.map((trackingRefs) => {
              const refNames = new Set(
                trackingRefs.stdout
                  .split("\n")
                  .map((remoteRef) => remoteRef.trim())
                  .filter((remoteRef) => remoteRef.length > 0),
              );
              return remoteNames
                .filter((candidate) => refNames.has(`refs/remotes/${candidate}/${branch}`))
                .join("\n");
            }),
          ),
      );
      const matchingRemoteNames = (trackingRemotes ?? "")
        .split("\n")
        .filter((candidate) => candidate.length > 0);
      if (matchingRemoteNames.length > 1) {
        return yield* new GitManagerError({
          operation: "branchPullRequest",
          cwd: cacheCwd,
          detail: `Multiple remotes track ${branch}. Its pull request is ambiguous.`,
        });
      }
      remoteName = matchingRemoteNames[0] ?? null;
      if (remoteName !== null) {
        upstreamRef = `${remoteName}/${branch}`;
      }
    }
    const defaultRemoteName = remoteNames.includes("origin") ? "origin" : firstRemoteName;
    const defaultBranch = yield* remember(
      `defaultBranch\u0000${defaultRemoteName}`,
      gitCore.resolveDefaultBranchName(cacheCwd, defaultRemoteName),
    ).pipe(Effect.orElseSucceed(() => null));
    const cacheKey = prLookupCacheKey(cacheCwd, {
      branch,
      upstreamRef,
      defaultBranch,
      localBranchExists,
      ...(localBranchExists ? {} : { remoteName }),
    });
    if (options.refresh) {
      const cached = yield* Cache.getOption(prLookupCache, cacheKey).pipe(
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isSome(cached)) yield* Cache.invalidate(prLookupCache, cacheKey);
    }
    let cached = yield* getPrLookup(cacheKey);
    // Lookup may use a fork instead of the saved upstream; verify the remote actually queried.
    const identityRemoteName = (headContext: BranchHeadContext) =>
      headContext.remoteName ?? remoteName ?? undefined;
    const currentIdentity = yield* resolvePrLookupRepositoryIdentity(
      cacheCwd,
      branch,
      identityRemoteName(cached.headContext),
      options.freshGitState,
    );
    const canVerifyIdentity = (headContext: BranchHeadContext, identity: typeof currentIdentity) =>
      !(
        (headContext.headRemoteUrlKey !== null && identity.headRemoteUrlKey === null) ||
        (headContext.targetRemoteUrlKey !== null && identity.targetRemoteUrlKey === null)
      );
    const hasSameIdentity = (headContext: BranchHeadContext, identity: typeof currentIdentity) =>
      headContext.headRemoteUrlKey === identity.headRemoteUrlKey &&
      headContext.targetRemoteUrlKey === identity.targetRemoteUrlKey;
    if (!canVerifyIdentity(cached.headContext, currentIdentity)) {
      return yield* new GitManagerError({
        operation: "branchPullRequest",
        cwd: cacheCwd,
        detail: `Repository identity for ${branch} could not be verified.`,
      });
    }
    if (!hasSameIdentity(cached.headContext, currentIdentity)) {
      yield* Cache.invalidate(prLookupCache, cacheKey);
      cached = yield* getPrLookup(cacheKey);
      const refreshedIdentity = yield* resolvePrLookupRepositoryIdentity(
        cacheCwd,
        branch,
        identityRemoteName(cached.headContext),
        true,
      );
      if (
        !canVerifyIdentity(cached.headContext, refreshedIdentity) ||
        !hasSameIdentity(cached.headContext, refreshedIdentity)
      ) {
        return yield* new GitManagerError({
          operation: "branchPullRequest",
          cwd: cacheCwd,
          detail: `Repository identity for ${branch} changed during pull request lookup.`,
        });
      }
    }
    const { latest } = cached;
    if (latest === null) return null;
    if (
      (branch === defaultBranch ||
        (defaultBranch === null && (branch === "main" || branch === "master"))) &&
      latest.state !== "open"
    ) {
      return null;
    }
    return {
      ...toStatusPr(latest),
      closedAt: latest.closedAt ?? null,
      mergedAt: latest.mergedAt ?? null,
      headSha: latest.headSha ?? null,
      // Hosting CLIs may target upstream; the PR URL identifies its actual repository.
      repositoryKey: pullRequestRepositoryKey(latest.url),
    };
  });

  const readRemoteStatus = Effect.fn("readRemoteStatus")(function* (
    cwd: string,
    options?: GitRemoteStatusOptions,
  ) {
    const details = yield* gitCore
      .statusDetailsRemote(cwd, options)
      .pipe(Effect.catchIf(isNotGitRepositoryError, () => Effect.succeed(null)));
    if (details === null || !details.isRepo) {
      return null;
    }

    const { pr, headSha } =
      details.branch !== null
        ? yield* lookupStatusPr(
            cwd,
            {
              branch: details.branch,
              upstreamRef: details.upstreamRef,
              defaultBranch: details.defaultBranch,
              isDefaultBranch: details.isDefaultBranch,
            },
            options?.refreshMissingPullRequest,
          )
        : { pr: null, headSha: null };
    // Squash and rebase merges land new commits, so HEAD never becomes reachable from the base.
    const shippedByMergedPr =
      pr?.state === "merged" &&
      headSha !== null &&
      (yield* Effect.gen(function* () {
        const defaultBranch =
          details.defaultBranch ??
          (yield* gitCore.resolvePrimaryRemoteName(cwd).pipe(
            Effect.flatMap((remoteName) => gitCore.resolveDefaultBranchName(cwd, remoteName)),
            Effect.orElseSucceed(() => null),
          ));
        const mergedIntoDefault =
          defaultBranch === null
            ? pr.baseRef === "main" || pr.baseRef === "master"
            : pr.baseRef === defaultBranch;
        if (!mergedIntoDefault) return false;
        return yield* gitCore.resolveCommit({ cwd, revision: "HEAD" }).pipe(
          Effect.map(({ commitSha }) => commitSha === headSha),
          Effect.orElseSucceed(() => false),
        );
      }));

    return {
      hasUpstream: details.hasUpstream,
      // A real upstream delta stays; only the no-upstream fallback counts against the base.
      aheadCount: shippedByMergedPr && !details.hasUpstream ? 0 : details.aheadCount,
      behindCount: details.behindCount,
      aheadOfDefaultCount: shippedByMergedPr ? 0 : details.aheadOfDefaultCount,
      pr,
    } satisfies VcsStatusRemoteResult;
  });

  const branchPullRequest: GitManager["Service"]["branchPullRequest"] = Effect.fn(
    "branchPullRequest",
  )(function* ({ cwd, branch }, options) {
    const cacheCwd = yield* normalizeStatusCacheKey(cwd);
    const refresh = options?.refresh === true;
    const freshGitState = refresh || options?.freshGitState === true;
    const pullRequest = yield* lookupBranchPullRequest(cacheCwd, branch, {
      refresh,
      freshGitState,
    });
    if (pullRequest === null || pullRequest.state === "open" || freshGitState) return pullRequest;
    // A confirmed closed or merged result stays final until the branch or remotes change,
    // with a periodic fresh lookup so a new PR from a reused branch still shows up.
    const settledKey = `${cacheCwd}\u0000${branch}`;
    const now = yield* Clock.currentTimeMillis;
    const settled = settledPrLookupByBranchKey.get(settledKey);
    // Read before any fresh lookup, so a change made during it forces another one.
    const fingerprint = yield* readSettledPrLookupFingerprint(cacheCwd, branch);
    if (
      settled !== undefined &&
      settled.url === pullRequest.url &&
      settled.fingerprint === fingerprint &&
      now - settled.confirmedAtMs < Duration.toMillis(SETTLED_PR_LOOKUP_RECHECK_INTERVAL)
    ) {
      return pullRequest;
    }
    const confirmed = yield* lookupBranchPullRequest(cacheCwd, branch, {
      refresh: false,
      freshGitState: true,
    });
    settledPrLookupByBranchKey.delete(settledKey);
    if (confirmed !== null && confirmed.state !== "open") {
      if (settledPrLookupByBranchKey.size >= PR_LOOKUP_CACHE_CAPACITY) {
        const oldestKey = settledPrLookupByBranchKey.keys().next().value;
        if (oldestKey !== undefined) settledPrLookupByBranchKey.delete(oldestKey);
      }
      settledPrLookupByBranchKey.set(settledKey, {
        url: confirmed.url,
        fingerprint,
        confirmedAtMs: now,
      });
    }
    return confirmed;
  });

  const remoteStatusResultCache = yield* Cache.makeWith((cwd: string) => readRemoteStatus(cwd), {
    capacity: STATUS_RESULT_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? STATUS_RESULT_CACHE_TTL : Duration.zero),
  });

  const invalidateRemoteStatusResultCache = (cwd: string) =>
    normalizeStatusCacheKey(cwd).pipe(
      Effect.flatMap((cacheKey) => Cache.invalidate(remoteStatusResultCache, cacheKey)),
    );

  const remoteStatus: GitManager["Service"]["remoteStatus"] = Effect.fn("remoteStatus")(
    function* (input, options) {
      const cacheKey = yield* normalizeStatusCacheKey(input.cwd);
      if (options?.refreshUpstream === false || options?.refreshMissingPullRequest) {
        return yield* readRemoteStatus(cacheKey, options);
      }
      return yield* Cache.get(remoteStatusResultCache, cacheKey);
    },
  );

  const status: GitManager["Service"]["status"] = Effect.fn("status")(function* (input) {
    const [local, remote] = yield* Effect.all([localStatus(input), remoteStatus(input)], {
      concurrency: "unbounded",
    });
    return mergeGitStatusParts(local, remote);
  });
  // Closed PR results can settle threads or remove worktrees; confirm fresh git state before persisting.

  const invalidateRemoteStatus: GitManager["Service"]["invalidateRemoteStatus"] = Effect.fn(
    "invalidateRemoteStatus",
  )(function* (cwd) {
    yield* invalidateRemoteStatusResultCache(cwd);
  });

  const invalidateStatus: GitManager["Service"]["invalidateStatus"] = Effect.fn("invalidateStatus")(
    function* (cwd) {
      yield* invalidateLocalStatusResultCache(cwd);
      yield* invalidateRemoteStatusResultCache(cwd);
      yield* bumpPrLookupEpoch(cwd);
      yield* forgetPrLookupGitState(cwd);
    },
  );

  // A user is waiting on these, so a host's background rate-limit pause must not refuse them.
  return {
    invalidateLocalStatus,
    getPrLookup,
    lookupStatusPr,
    lookupBranchPullRequest,
    readRemoteStatus,
    branchPullRequest,
    remoteStatusResultCache,
    invalidateRemoteStatusResultCache,
    remoteStatus,
    status,
    invalidateRemoteStatus,
    invalidateStatus,
  };
});
