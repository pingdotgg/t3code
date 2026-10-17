import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
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
  SourceControlProviderError,
  type ThreadId,
  type ThreadPullRequestKey,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
} from "@t3tools/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  mergeGitStatusParts,
  normalizeGitRemoteUrl,
  resolveAutoFeatureBranchName,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/git";
import {
  canonicalRepositoryKey,
  getChangeRequestTerminologyForKind,
  isSshRemoteUrl,
} from "@t3tools/shared/sourceControl";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
} from "@t3tools/shared/threadPullRequests";

import { GitManagerError, GitPullRequestMaterializationError } from "@t3tools/contracts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { detachStackFrame } from "./detachStackFrame.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { GitManagerServiceError } from "@t3tools/contracts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import {
  findOpenPr,
  headBranchProbe,
  isCommitAction,
  matchesBranchHeadContext,
  normalizePullRequestReference,
  parseRepositoryNameFromPullRequestUrl,
  pullRequestRepositoryKey,
  readProjectSettings,
  resolveBranchHeadContext,
  resolveCommitAndBranchSuggestion,
  resolvePullRequestWorktreeLocalBranchName,
  resolveTextGenerationSettings,
  runChangeRequestStep,
  summarizeGitActionResult,
  toPullRequestInfo,
  toResolvedPullRequest,
  type BranchHeadContext,
  type ChangeRequestStepServices,
  type ChangeRequestVcsReads,
  type CommitAndBranchSuggestion,
  type GitActionProgressPayload,
  type PullRequestHeadRemoteInfo,
  type PullRequestInfo,
  type ResolvedPullRequest,
  type SourceControlTextGenerationSettings,
} from "../sourceControl/ChangeRequestStep.ts";

type GitActionProgressEmitter = (event: GitActionProgressPayload) => Effect.Effect<void, never>;

export interface GitActionProgressReporter {
  readonly publish: (event: GitActionProgressEvent) => Effect.Effect<void, never>;
}

export interface GitRunStackedActionOptions {
  readonly actionId?: string;
  readonly progressReporter?: GitActionProgressReporter;
}

export interface GitRemoteStatusOptions extends GitVcsDriver.GitRemoteStatusOptions {
  readonly refreshMissingPullRequest?: boolean;
}

export type GitBranchPullRequest = NonNullable<VcsStatusResult["pr"]> & {
  readonly repositoryKey: string | null;
  readonly updatedAt: string | null;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly headSha?: string | null;
};

export class GitManager extends Context.Service<
  GitManager,
  {
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    /**
     * `refresh` asks the host again. `freshGitState` rereads the branch's git
     * state without forcing a host refresh; use it before persisting a result.
     */
    readonly branchPullRequest: (
      input: { readonly cwd: string; readonly branch: string },
      options?: { readonly refresh?: boolean; readonly freshGitState?: boolean },
    ) => Effect.Effect<GitBranchPullRequest | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitRunStackedActionOptions,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
    readonly subscribePullRequestStateChanges: Effect.Effect<
      Stream.Stream<ThreadPullRequestKey>,
      never,
      Scope.Scope
    >;
  }
>()("t3/git/GitManager") {}

const COMMIT_TIMEOUT_MS = 10 * 60_000;
const MAX_PROGRESS_TEXT_LENGTH = 500;
const STATUS_RESULT_CACHE_TTL = Duration.seconds(1);
const STATUS_RESULT_CACHE_CAPACITY = 2_048;
const PR_LOOKUP_CACHE_TTL = Duration.seconds(60);
const PR_LOOKUP_NO_OPEN_PR_CACHE_TTL = Duration.minutes(5);
const PR_LOOKUP_FAILURE_BASE_TTL = Duration.seconds(20);
const PR_LOOKUP_FAILURE_MAX_TTL = Duration.minutes(15);
const PR_LOOKUP_CACHE_CAPACITY = 2_048;
const PR_LOOKUP_GIT_STATE_TTL = Duration.minutes(5);
const isSourceControlProviderError = Schema.is(SourceControlProviderError);

/**
 * A hosting provider rejects a throttled request immediately, so caching every
 * failure for a flat 20s made a rate-limited poller re-ask *faster* than a
 * healthy one does (which waits PR_LOOKUP_CACHE_TTL), turning a transient 429
 * into sustained pressure. Backing off per branch keeps the retry rate below
 * the healthy rate once a branch has failed more than a couple of times.
 */
export function prLookupFailureTtl(consecutiveFailures: number): Duration.Duration {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const backoffMs = Duration.toMillis(PR_LOOKUP_FAILURE_BASE_TTL) * Math.pow(2, exponent);
  return Duration.min(Duration.millis(backoffMs), PR_LOOKUP_FAILURE_MAX_TTL);
}

function isNotGitRepositoryError(error: GitCommandError): boolean {
  return error.message.toLowerCase().includes("not a git repository");
}

const pullRequestUpdatedAtDescOrder: Order.Order<PullRequestInfo> = Order.mapInput(
  Order.flip(Option.makeOrder(DateTime.Order)),
  (pullRequest) => pullRequest.updatedAt,
);

function sanitizeProgressText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length <= MAX_PROGRESS_TEXT_LENGTH) {
    return trimmed;
  }
  return trimmed.slice(0, MAX_PROGRESS_TEXT_LENGTH).trimEnd();
}

function toStatusPr(pr: PullRequestInfo): {
  number: number;
  title: string;
  url: string;
  baseRef: string;
  headRef: string;
  state: "open" | "closed" | "merged";
  isDraft?: boolean;
  updatedAt: string | null;
} {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    state: pr.state,
    ...(pr.isDraft === true ? { isDraft: true } : {}),
    updatedAt: Option.match(pr.updatedAt, {
      onNone: () => null,
      onSome: (updatedAt) => DateTime.formatIso(updatedAt),
    }),
  };
}

function shouldPreferSshRemote(url: string | null): boolean {
  if (!url) return false;
  return isSshRemoteUrl(url);
}

function toPullRequestHeadRemoteInfo(pr: {
  isCrossRepository?: boolean | undefined;
  headRepositoryNameWithOwner?: string | null | undefined;
  headRepositoryOwnerLogin?: string | null | undefined;
}): PullRequestHeadRemoteInfo {
  return {
    ...(pr.isCrossRepository !== undefined ? { isCrossRepository: pr.isCrossRepository } : {}),
    ...(pr.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: pr.headRepositoryNameWithOwner }
      : {}),
    ...(pr.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: pr.headRepositoryOwnerLogin }
      : {}),
  };
}

function resolveHeadRepositoryNameWithOwner(
  pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
): string | null {
  const explicitRepository = pullRequest.headRepositoryNameWithOwner?.trim() ?? "";
  if (explicitRepository.length > 0) {
    return explicitRepository;
  }

  if (!pullRequest.isCrossRepository) {
    return null;
  }

  const ownerLogin = pullRequest.headRepositoryOwnerLogin?.trim() ?? "";
  const repositoryName = parseRepositoryNameFromPullRequestUrl(pullRequest.url);
  if (ownerLogin.length === 0 || !repositoryName) {
    return null;
  }

  return `${ownerLogin}/${repositoryName}`;
}

export const make = Effect.gen(function* () {
  const gitCore = yield* GitVcsDriver.GitVcsDriver;
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

  const sourceControlProvider = (cwd: string) => sourceControlProviders.resolve({ cwd });

  /** The shared remote-context helpers read the provider registry from context; discharge it once. */
  const withSourceControlProviders = <A, E>(
    effect: Effect.Effect<A, E, SourceControlProviderRegistry.SourceControlProviderRegistry>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(
        SourceControlProviderRegistry.SourceControlProviderRegistry,
        sourceControlProviders,
      ),
      Effect.provideService(HostProcess.Environment, environment),
    );

  /**
   * The shared change-request step takes its services from context; every method on this service
   * is declared with an empty requirement channel, so they are discharged here, once.
   */
  const withChangeRequestServices = <A, E>(
    effect: Effect.Effect<A, E, ChangeRequestStepServices>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(HostProcess.Environment, environment),
      Effect.provideService(ServerSettings.ServerSettingsService, serverSettingsService),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProviderRegistry.ProviderRegistry, providerRegistry),
      Effect.provideService(
        SourceControlProviderRegistry.SourceControlProviderRegistry,
        sourceControlProviders,
      ),
      Effect.provideService(TextGeneration.TextGeneration, textGeneration),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, threads),
      Effect.provideService(ProjectStore.ProjectStoreV2, projects),
    );
  const serverSettingsService = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projectSettingsFor = (input: {
    readonly cwd: string;
    readonly threadId?: ThreadId | undefined;
  }) =>
    readProjectSettings(input).pipe(
      Effect.provideService(ServerSettings.ServerSettingsService, serverSettingsService),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, threads),
      Effect.provideService(ProjectStore.ProjectStoreV2, projects),
    );
  const readWorktreesDirectory = serverSettingsService.getSettings.pipe(
    Effect.map((settings) => settings.worktreesDirectory),
    Effect.orElseSucceed(() => ""),
  );
  const createWorktree: GitManager["Service"]["createWorktree"] = Effect.fn(
    "GitManager.createWorktree",
  )(function* (input, options) {
    const submodules =
      options?.submodules !== undefined
        ? options.submodules
        : yield* projectSettingsFor(input).pipe(
            Effect.map(({ settings }) => settings.worktreeSubmodules),
            Effect.orElseSucceed(() => null),
          );
    const worktreesDirectory = yield* readWorktreesDirectory;
    return yield* gitCore.createWorktree(input, { worktreesDirectory, ...options, submodules });
  });
  const randomUUIDv4 = (cwd: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation: "randomUUIDv4",
            cwd,
            detail: "Failed to generate Git operation identifier.",
            cause,
          }),
      ),
    );

  const createProgressEmitter = (
    input: { cwd: string; action: GitStackedAction },
    options?: GitRunStackedActionOptions,
  ) =>
    (options?.actionId === undefined
      ? randomUUIDv4(input.cwd)
      : Effect.succeed(options.actionId)
    ).pipe(
      Effect.map((actionId) => {
        const reporter = options?.progressReporter;
        const emit = (event: GitActionProgressPayload) =>
          reporter
            ? reporter.publish({
                actionId,
                cwd: input.cwd,
                action: input.action,
                ...event,
              } as GitActionProgressEvent)
            : Effect.void;

        return {
          actionId,
          emit,
        };
      }),
    );

  const configurePullRequestHeadUpstreamBase = Effect.fn("configurePullRequestHeadUpstream")(
    function* (
      cwd: string,
      pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
      localBranch = pullRequest.headBranch,
    ) {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";
      if (repositoryNameWithOwner.length === 0 && pullRequest.isCrossRepository !== true) {
        const remoteName = yield* gitCore.resolvePrimaryRemoteName(cwd);
        yield* gitCore.fetchRemoteTrackingBranch({
          cwd,
          remoteName,
          remoteBranch: pullRequest.headBranch,
        });
        yield* gitCore.setBranchUpstream({
          cwd,
          branch: localBranch,
          remoteName,
          remoteBranch: pullRequest.headBranch,
        });
        return;
      }

      if (repositoryNameWithOwner.length === 0) {
        return;
      }

      const cloneUrls = yield* (yield* sourceControlProvider(cwd)).getRepositoryCloneUrls({
        cwd,
        repository: repositoryNameWithOwner,
      });
      const originRemoteUrl = yield* gitCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* gitCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
      });

      yield* gitCore.fetchRemoteTrackingBranch({
        cwd,
        remoteName,
        remoteBranch: pullRequest.headBranch,
      });
      yield* gitCore.setBranchUpstream({
        cwd,
        branch: localBranch,
        remoteName,
        remoteBranch: pullRequest.headBranch,
      });
    },
  );

  const configurePullRequestHeadUpstream = (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    localBranch = pullRequest.headBranch,
  ) =>
    configurePullRequestHeadUpstreamBase(cwd, pullRequest, localBranch).pipe(
      Effect.catch((error) =>
        Effect.logWarning("GitManager.configurePullRequestHeadUpstream failed", {
          cwd,
          localBranch,
          headBranch: pullRequest.headBranch,
          cause: error,
        }).pipe(Effect.asVoid),
      ),
    );

  const materializePullRequestHeadBranchBase = Effect.fn("materializePullRequestHeadBranch")(
    function* (
      cwd: string,
      pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
      localBranch = pullRequest.headBranch,
    ) {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";

      if (repositoryNameWithOwner.length === 0) {
        yield* gitCore
          .fetchPullRequestBranch({
            cwd,
            prNumber: pullRequest.number,
            branch: localBranch,
          })
          .pipe(
            // Azure DevOps, GitLab and Bitbucket publish no `refs/pull/<n>/head`. A head in the
            // same repository is a branch on the primary remote, so it is fetched by name instead,
            // but only when that remote is the pull request's own repository: Azure finds a pull
            // request by number anywhere in the organization. Only while it is open, too: the
            // branch of a closed one may have moved on past the head it was closed with.
            Effect.catch((cause) =>
              pullRequest.isCrossRepository === true || pullRequest.state !== "open"
                ? Effect.fail(cause)
                : Effect.gen(function* () {
                    const remoteName = yield* gitCore.resolvePrimaryRemoteName(cwd);
                    const remoteUrl = yield* gitCore.readConfigValue(
                      cwd,
                      `remote.${remoteName}.url`,
                    );
                    const pullRequestKey = pullRequestRepositoryKey(pullRequest.url);
                    if (
                      remoteUrl === null ||
                      pullRequestKey === null ||
                      canonicalRepositoryKey(pullRequestKey) !==
                        canonicalRepositoryKey(normalizeGitRemoteUrl(remoteUrl))
                    ) {
                      return yield* cause;
                    }
                    yield* gitCore.fetchRemoteBranch({
                      cwd,
                      remoteName,
                      remoteBranch: pullRequest.headBranch,
                      localBranch,
                    });
                  }),
            ),
          );
        return;
      }

      const cloneUrls = yield* (yield* sourceControlProvider(cwd)).getRepositoryCloneUrls({
        cwd,
        repository: repositoryNameWithOwner,
      });
      const originRemoteUrl = yield* gitCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* gitCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
      });

      yield* gitCore.fetchRemoteBranch({
        cwd,
        remoteName,
        remoteBranch: pullRequest.headBranch,
        localBranch,
      });
      yield* gitCore.setBranchUpstream({
        cwd,
        branch: localBranch,
        remoteName,
        remoteBranch: pullRequest.headBranch,
      });
    },
  );

  const materializePullRequestHeadBranch = (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    localBranch = pullRequest.headBranch,
  ) =>
    materializePullRequestHeadBranchBase(cwd, pullRequest, localBranch).pipe(
      Effect.catch((primaryCause) =>
        gitCore
          .fetchPullRequestBranch({
            cwd,
            prNumber: pullRequest.number,
            branch: localBranch,
          })
          .pipe(
            Effect.mapError(
              (fallbackCause) =>
                new GitPullRequestMaterializationError({
                  cwd,
                  pullRequestNumber: pullRequest.number,
                  headRepository: resolveHeadRepositoryNameWithOwner(pullRequest),
                  headBranch: pullRequest.headBranch,
                  localBranch,
                  cause: new AggregateError(
                    [primaryCause, fallbackCause],
                    `Repository-head and pull-request-ref fetches both failed for pull request #${pullRequest.number}.`,
                    { cause: primaryCause },
                  ),
                }),
            ),
          ),
      ),
    );
  const canonicalizeExistingPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));
  const normalizeStatusCacheKey = canonicalizeExistingPath;
  const nonRepositoryStatusDetails: GitVcsDriver.GitStatusDetails = {
    isRepo: false,
    hasOriginRemote: false,
    isDefaultBranch: false,
    branch: null,
    upstreamRef: null,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
  };
  const readLocalStatus = Effect.fn("readLocalStatus")(function* (cwd: string) {
    const details = yield* gitCore
      .statusDetailsLocal(cwd, { includeDivergence: false, includeBranchChanges: true })
      .pipe(
        Effect.catchIf(isNotGitRepositoryError, () => Effect.succeed(nonRepositoryStatusDetails)),
      );
    const hostingProvider = details.isRepo
      ? yield* resolveHostingProvider(cwd, details.branch)
      : null;

    return {
      isRepo: details.isRepo,
      ...(hostingProvider ? { sourceControlProvider: hostingProvider } : {}),
      hasPrimaryRemote: details.hasOriginRemote,
      isDefaultRef: details.isDefaultBranch,
      refName: details.branch,
      hasWorkingTreeChanges: details.hasWorkingTreeChanges,
      workingTree: details.workingTree,
      ...(details.branchChanges ? { branchChanges: details.branchChanges } : {}),
    } satisfies VcsStatusLocalResult;
  });
  const localStatusResultCache = yield* Cache.makeWith(readLocalStatus, {
    capacity: STATUS_RESULT_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? STATUS_RESULT_CACHE_TTL : Duration.zero),
  });
  const invalidateLocalStatusResultCache = (cwd: string) =>
    normalizeStatusCacheKey(cwd).pipe(
      Effect.flatMap((cacheKey) => Cache.invalidate(localStatusResultCache, cacheKey)),
    );
  const prLookupEpochByCwd = new Map<string, number>();
  const prLookupEpoch = (cwd: string) => prLookupEpochByCwd.get(cwd) ?? 0;
  const bumpPrLookupEpoch = (cwd: string) =>
    normalizeStatusCacheKey(cwd).pipe(
      Effect.map((cacheKey) => {
        prLookupEpochByCwd.set(cacheKey, prLookupEpoch(cacheKey) + 1);
      }),
    );
  const prLookupCacheKey = (
    cwd: string,
    details: {
      branch: string;
      upstreamRef: string | null;
      defaultBranch: string | null;
      localBranchExists?: boolean;
      remoteName?: string | null;
    },
  ) =>
    [
      cwd,
      details.branch,
      details.upstreamRef ?? "",
      details.defaultBranch ?? "",
      details.localBranchExists === false ? "0" : "1",
      details.remoteName ?? "",
      String(prLookupEpoch(cwd)),
    ].join("\u0000");
  const prLookupFailureStreakByKey = new Map<string, number>();
  const nextPrLookupFailureTtl = (key: string) => {
    if (
      !prLookupFailureStreakByKey.has(key) &&
      prLookupFailureStreakByKey.size >= PR_LOOKUP_CACHE_CAPACITY
    ) {
      const oldestKey = prLookupFailureStreakByKey.keys().next().value;
      if (oldestKey !== undefined) {
        prLookupFailureStreakByKey.delete(oldestKey);
      }
    }
    const streak = (prLookupFailureStreakByKey.get(key) ?? 0) + 1;
    prLookupFailureStreakByKey.set(key, streak);
    return prLookupFailureTtl(streak);
  };
  const pullRequestStateChanges = yield* PubSub.sliding<ThreadPullRequestKey>(64);
  const lookupStates = new Map<string, PullRequestInfo["state"]>();
  const noteLookupState = (pr: PullRequestInfo) =>
    Effect.suspend(() => {
      const parsed = parseChangeRequestUrl(pr.url);
      if (parsed === null || parsed.number !== pr.number) return Effect.void;
      const key = normalizeThreadPullRequestKey(parsed);
      const id = threadPullRequestKeyOf(key);
      const previous = lookupStates.get(id) ?? "open";
      lookupStates.delete(id);
      if (lookupStates.size >= PR_LOOKUP_CACHE_CAPACITY) {
        const oldest = lookupStates.keys().next().value;
        if (oldest !== undefined) lookupStates.delete(oldest);
      }
      lookupStates.set(id, pr.state);
      return previous === pr.state ? Effect.void : PubSub.publish(pullRequestStateChanges, key);
    });
  const prLookupCache = yield* Cache.makeWith(
    (key: string) => {
      const [
        cwd = "",
        branch = "",
        upstreamRef = "",
        defaultBranch = "",
        branchExists = "1",
        remoteName = "",
      ] = key.split("\u0000");
      const details = {
        branch,
        upstreamRef: upstreamRef.length > 0 ? upstreamRef : null,
        defaultBranch: defaultBranch.length > 0 ? defaultBranch : null,
        localBranchExists: branchExists !== "0",
        ...(remoteName.length > 0 ? { remoteName } : {}),
      };
      return Effect.gen(function* () {
        const { headContext, lookup } = yield* resolveLookupHeadContext(cwd, details);
        if (!lookup) {
          return { latest: null, headContext };
        }
        if (
          details.localBranchExists &&
          details.upstreamRef === null &&
          (yield* isUnpublishedBranch(cwd, headContext))
        ) {
          return { latest: null, headContext };
        }
        const latest = yield* findLatestPrForHeadContext(cwd, headContext);
        if (latest !== null) yield* noteLookupState(latest);
        return { latest, headContext };
      });
    },
    {
      capacity: PR_LOOKUP_CACHE_CAPACITY,
      timeToLive: (exit, key) => {
        if (Exit.isSuccess(exit)) {
          prLookupFailureStreakByKey.delete(key);
          return exit.value.latest?.state === "open"
            ? PR_LOOKUP_CACHE_TTL
            : PR_LOOKUP_NO_OPEN_PR_CACHE_TTL;
        }
        return nextPrLookupFailureTtl(key);
      },
    },
  );
  const getPrLookup = (key: string) => detachStackFrame(Cache.get(prLookupCache, key));
  interface LastKnownPr {
    readonly pr: ReturnType<typeof toStatusPr> | null;
    readonly upstreamRef: string | null;
    readonly headBranch: string;
    readonly remoteName: string | null;
    readonly headRemoteUrlKey: string | null;
  }
  const lastKnownPrByBranchKey = new Map<string, LastKnownPr>();
  const rememberLastKnownPr = (branchKey: string, entry: LastKnownPr) => {
    if (
      !lastKnownPrByBranchKey.has(branchKey) &&
      lastKnownPrByBranchKey.size >= PR_LOOKUP_CACHE_CAPACITY
    ) {
      const oldestKey = lastKnownPrByBranchKey.keys().next().value;
      if (oldestKey !== undefined) {
        lastKnownPrByBranchKey.delete(oldestKey);
      }
    }
    lastKnownPrByBranchKey.set(branchKey, entry);
  };
  const resolveLastKnownPr = (
    branchKey: string,
    current: Pick<LastKnownPr, "upstreamRef" | "headBranch" | "remoteName" | "headRemoteUrlKey">,
  ): ReturnType<typeof toStatusPr> | null => {
    const lastKnown = lastKnownPrByBranchKey.get(branchKey);
    if (!lastKnown) return null;
    if (lastKnown.headBranch !== current.headBranch) {
      return null;
    }

    // Both sides must be resolved before treating a mismatch as real:
    // `readConfigValueNullable` swallows any git-config read failure into
    // `null`, so a transient failure to resolve the *current* remote URL must
    // read as "unknown", not as "no remote" — the latter would otherwise drop
    // an already-known PR badge on every hiccup.
    if (lastKnown.headRemoteUrlKey !== null && current.headRemoteUrlKey !== null) {
      return lastKnown.headRemoteUrlKey === current.headRemoteUrlKey ? lastKnown.pr : null;
    }

    if (
      lastKnown.upstreamRef !== null &&
      current.upstreamRef !== null &&
      lastKnown.remoteName !== null &&
      current.remoteName !== null
    ) {
      return lastKnown.remoteName === current.remoteName ? lastKnown.pr : null;
    }
    return lastKnown.pr;
  };
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
    // Keyed by (cwd, branch) only: the upstream ref changing (e.g. a first
    // `push -u`) must not orphan the fallback value for the same branch.
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
        if (!latest) return { pr: null, headContext };
        // Merged/closed matches are usually reverse-merge history, not the thread's PR context.
        if (details.isDefaultBranch && latest.state !== "open") {
          return { pr: null, headContext };
        }
        return { pr: toStatusPr(latest), headContext };
      }),
      Effect.tap(({ pr, headContext }) =>
        Effect.sync(() =>
          rememberLastKnownPr(branchKey, {
            pr,
            upstreamRef: details.upstreamRef,
            headBranch: headContext.headBranch,
            remoteName: headContext.remoteName,
            headRemoteUrlKey: headContext.headRemoteUrlKey,
          }),
        ),
      ),
      Effect.map(({ pr }) => pr),
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
        );
      }),
    );
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

    const pr =
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
        : null;

    return {
      hasUpstream: details.hasUpstream,
      aheadCount: details.aheadCount,
      behindCount: details.behindCount,
      aheadOfDefaultCount: details.aheadOfDefaultCount,
      pr,
    } satisfies VcsStatusRemoteResult;
  });
  const remoteStatusResultCache = yield* Cache.makeWith((cwd: string) => readRemoteStatus(cwd), {
    capacity: STATUS_RESULT_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? STATUS_RESULT_CACHE_TTL : Duration.zero),
  });
  const invalidateRemoteStatusResultCache = (cwd: string) =>
    normalizeStatusCacheKey(cwd).pipe(
      Effect.flatMap((cacheKey) => Cache.invalidate(remoteStatusResultCache, cacheKey)),
    );

  const readConfigValueNullable = (cwd: string, key: string) =>
    gitCore.readConfigValue(cwd, key).pipe(Effect.orElseSucceed(() => null));

  const resolveHostingProvider = Effect.fn("resolveHostingProvider")(function* (
    cwd: string,
    branch: string | null,
  ) {
    const preferredRemoteName =
      branch === null
        ? "origin"
        : ((yield* readConfigValueNullable(cwd, `branch.${branch}.remote`)) ?? "origin");
    const remoteUrl =
      (yield* readConfigValueNullable(cwd, `remote.${preferredRemoteName}.url`)) ??
      (yield* readConfigValueNullable(cwd, "remote.origin.url"));

    const provider = remoteUrl ? detectSourceControlProviderFromGitRemoteUrl(remoteUrl) : null;
    if (!remoteUrl || provider?.kind !== "unknown") return provider;
    const handle = yield* sourceControlProviders
      .resolveHandle({
        cwd,
        context: { provider, remoteName: preferredRemoteName, remoteUrl },
      })
      .pipe(Effect.orElseSucceed(() => null));
    return handle?.context?.provider ?? provider;
  });

  // Remote names may contain slashes, so refs are matched literally per remote
  // instead of with a glob.
  const findRemoteTrackingRemote = Effect.fn("findRemoteTrackingRemote")(function* (
    cwd: string,
    branch: string,
    preferredRemoteName: string | null,
  ) {
    if (branch.length === 0) return null;
    return yield* Effect.gen(function* () {
      const remoteNames = (yield* gitCore.execute({
        operation: "GitManager.findRemoteTrackingRemote.remotes",
        cwd,
        args: ["remote"],
        timeoutMs: 5_000,
      })).stdout
        .split("\n")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      if (remoteNames.length === 0) return null;
      const refs = new Set(
        (yield* gitCore.execute({
          operation: "GitManager.findRemoteTrackingRemote.refs",
          cwd,
          args: [
            "for-each-ref",
            "--format=%(refname)",
            ...remoteNames.map((name) => `refs/remotes/${name}/${branch}`),
          ],
          timeoutMs: 5_000,
        })).stdout
          .split("\n")
          .map((ref) => ref.trim())
          .filter((ref) => ref.length > 0),
      );
      const matching = remoteNames.filter((name) => refs.has(`refs/remotes/${name}/${branch}`));
      if (preferredRemoteName !== null && matching.includes(preferredRemoteName)) {
        return preferredRemoteName;
      }
      if (matching.includes("origin")) return "origin";
      return matching[0] ?? null;
    });
  });

  const findPublishedBranchRemote = Effect.fn("findPublishedBranchRemote")(function* (
    cwd: string,
    branch: string,
  ) {
    const localRef = `refs/heads/${branch}`;
    const remoteNames = (yield* gitCore.execute({
      operation: "GitManager.findPublishedBranchRemote.remotes",
      cwd,
      args: ["remote"],
      timeoutMs: 5_000,
    })).stdout
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    if (remoteNames.length === 0) return null;

    const refs = yield* gitCore.execute({
      operation: "GitManager.findPublishedBranchRemote",
      cwd,
      args: [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)",
        localRef,
        ...remoteNames.map((name) => `refs/remotes/${name}/${branch}`),
      ],
      timeoutMs: 5_000,
    });
    const oidByRef = new Map(
      refs.stdout
        .split("\n")
        .map((line) => line.trim().split("\u0000"))
        .filter((entry): entry is [string, string] => entry.length === 2),
    );
    const localOid = oidByRef.get(localRef);
    if (!localOid) return null;

    const remoteRefs = remoteNames.flatMap((name) => {
      const oid = oidByRef.get(`refs/remotes/${name}/${branch}`);
      return oid ? [{ name, oid }] : [];
    });
    const exactRemotes = remoteRefs.filter((remote) => remote.oid === localOid);
    if (exactRemotes.length > 1) return null;
    let remoteName = exactRemotes[0]?.name;
    if (remoteName === undefined) {
      const ancestorRemotes = yield* Effect.forEach(
        remoteRefs,
        (remote) =>
          gitCore
            .execute({
              operation: "GitManager.findPublishedBranchRemote.ancestor",
              cwd,
              args: ["merge-base", "--is-ancestor", remote.oid, localOid],
              allowNonZeroExit: true,
              timeoutMs: 5_000,
            })
            .pipe(
              Effect.flatMap((result) => {
                // `merge-base --is-ancestor` reports 0 for ancestor and 1
                // for not-ancestor; any other non-zero exit is a failed
                // probe, not a negative result. A failed probe rejects the
                // whole inference instead of letting a surviving probe win
                // by default and attach the wrong fork's PR.
                if (result.exitCode === 0) return Effect.succeed(remote.name);
                if (result.exitCode === 1) return Effect.succeed(null);
                return new GitCommandError({
                  operation: "GitManager.findPublishedBranchRemote.ancestor",
                  command: "git merge-base --is-ancestor",
                  cwd,
                  exitCode: result.exitCode,
                  detail: "Ancestry probe failed; rejecting ancestry inference.",
                });
              }),
            ),
        { concurrency: "unbounded" },
      );
      const matches = ancestorRemotes.filter((name) => name !== null);
      if (matches.length !== 1) return null;
      remoteName = matches[0];
    }
    if (remoteName === undefined) return null;
    const remoteUrl = yield* readConfigValueNullable(cwd, `remote.${remoteName}.url`);
    return remoteUrl === null ? null : remoteName;
  });

  // `git worktree add -b feature origin/main` makes the new local branch track
  // origin/main. That upstream is the branch's base, not its published PR head.
  // Looking up PRs for it can attach an old reverse merge from main and
  // auto-settle an unrelated feature thread.
  const resolveLookupHeadContext = Effect.fn("resolveLookupHeadContext")(function* (
    cwd: string,
    details: {
      branch: string;
      upstreamRef: string | null;
      defaultBranch: string | null;
      remoteName?: string;
    },
  ) {
    const headContext = yield* withSourceControlProviders(
      resolveBranchHeadContext(readConfigValueNullable, gitCore.execute, cwd, details),
    );
    if (details.upstreamRef === null) {
      const remoteName = yield* findPublishedBranchRemote(cwd, details.branch).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (remoteName !== null && remoteName !== headContext.remoteName) {
        return {
          headContext: yield* withSourceControlProviders(
            resolveBranchHeadContext(readConfigValueNullable, gitCore.execute, cwd, {
              ...details,
              remoteName,
            }),
          ),
          lookup: true,
        };
      }
    }
    const upstreamHeadIsDefault =
      headContext.headBranch === details.defaultBranch ||
      (details.defaultBranch === null &&
        (headContext.headBranch === "main" || headContext.headBranch === "master"));
    if (
      headContext.headBranch === details.branch ||
      !upstreamHeadIsDefault ||
      headContext.isCrossRepository
    ) {
      return { headContext, lookup: true };
    }
    const remoteName = yield* findRemoteTrackingRemote(
      cwd,
      details.branch,
      headContext.remoteName,
    ).pipe(Effect.orElseSucceed(() => null));
    if (remoteName === null) {
      return { headContext, lookup: false };
    }
    const ownNameContext = yield* withSourceControlProviders(
      resolveBranchHeadContext(readConfigValueNullable, gitCore.execute, cwd, {
        branch: details.branch,
        upstreamRef: null,
        remoteName,
      }),
    );
    return { headContext: ownNameContext, lookup: true };
  });

  const isUnpublishedBranch = Effect.fn("isUnpublishedBranch")(function* (
    cwd: string,
    headContext: Pick<BranchHeadContext, "headBranch" | "localBranch">,
  ) {
    if (headContext.headBranch.length === 0) {
      return false;
    }
    const matchesRef = (pattern: string) =>
      gitCore
        .execute({
          operation: "GitManager.isUnpublishedBranch",
          cwd,
          args: ["for-each-ref", "--count=1", "--format=%(refname)", pattern],
          timeoutMs: 5_000,
        })
        .pipe(Effect.map((result) => result.stdout.trim().length > 0));

    return yield* Effect.gen(function* () {
      const [configuredRemote, configuredMerge] = yield* Effect.all(
        [
          gitCore.readConfigValue(cwd, `branch.${headContext.localBranch}.remote`),
          gitCore.readConfigValue(cwd, `branch.${headContext.localBranch}.merge`),
        ],
        { concurrency: "unbounded" },
      );
      if (configuredRemote !== null && configuredMerge !== null) {
        return false;
      }

      const [tracksAnyRemote, trackedRemote] = yield* Effect.all(
        [matchesRef("refs/remotes"), findRemoteTrackingRemote(cwd, headContext.headBranch, null)],
        { concurrency: "unbounded" },
      );
      return tracksAnyRemote && trackedRemote === null;
    }).pipe(Effect.orElseSucceed(() => false));
  });

  const findLatestPrForHeadContext = Effect.fn("findLatestPrForHeadContext")(function* (
    cwd: string,
    headContext: BranchHeadContext,
  ) {
    const parsedByNumber = new Map<number, PullRequestInfo>();

    const provider = yield* sourceControlProvider(cwd);
    const probe = headBranchProbe(provider, headContext.headSelectors, "all");
    for (const headSelector of probe.headSelectors) {
      const pullRequests = yield* provider.listChangeRequests({
        cwd,
        headSelector,
        state: "all",
        limit: probe.limit,
      });

      for (const pr of pullRequests.map(toPullRequestInfo)) {
        if (!matchesBranchHeadContext(pr, headContext)) {
          continue;
        }
        parsedByNumber.set(pr.number, pr);
      }
    }

    const parsed = Arr.sort(parsedByNumber.values(), pullRequestUpdatedAtDescOrder);

    const latestOpenPr = parsed.find((pr) => pr.state === "open");
    if (latestOpenPr) {
      return latestOpenPr;
    }
    return parsed[0] ?? null;
  });
  const buildCompletionToast = Effect.fn("buildCompletionToast")(function* (
    cwd: string,
    result: Pick<GitRunStackedActionResult, "action" | "branch" | "commit" | "push" | "pr">,
  ) {
    const terms = yield* sourceControlProvider(cwd).pipe(
      Effect.map((provider) => getChangeRequestTerminologyForKind(provider.kind)),
      Effect.orElseSucceed(() =>
        getChangeRequestTerminologyForKind(SourceControlProviderKind.make("unknown")),
      ),
    );
    const summary = summarizeGitActionResult(result, terms);
    let latestOpenPr: PullRequestInfo | null = null;
    let currentBranchIsDefault = false;
    let finalBranchContext: {
      branch: string;
      upstreamRef: string | null;
      hasUpstream: boolean;
    } | null = null;

    if (result.action !== "commit") {
      const finalStatus = yield* gitCore.statusDetails(cwd);
      if (finalStatus.branch) {
        finalBranchContext = {
          branch: finalStatus.branch,
          upstreamRef: finalStatus.upstreamRef,
          hasUpstream: finalStatus.hasUpstream,
        };
        currentBranchIsDefault = finalStatus.isDefaultBranch;
      }
    }

    const explicitResultPr =
      (result.pr.status === "created" || result.pr.status === "opened_existing") && result.pr.url
        ? {
            url: result.pr.url,
            state: "open" as const,
          }
        : null;
    const shouldLookupExistingOpenPr =
      (result.action === "commit_push" || result.action === "push") &&
      result.push.status === "pushed" &&
      result.branch.status !== "created" &&
      !currentBranchIsDefault &&
      explicitResultPr === null &&
      finalBranchContext?.hasUpstream === true;

    if (shouldLookupExistingOpenPr && finalBranchContext) {
      latestOpenPr = yield* withSourceControlProviders(
        resolveBranchHeadContext(readConfigValueNullable, gitCore.execute, cwd, {
          branch: finalBranchContext.branch,
          upstreamRef: finalBranchContext.upstreamRef,
        }).pipe(
          Effect.flatMap((headContext) => withChangeRequestServices(findOpenPr(cwd, headContext))),
          Effect.orElseSucceed(() => null),
        ),
      );
    }

    const openPr = latestOpenPr ?? explicitResultPr;

    const cta =
      result.action === "commit" && result.commit.status === "created"
        ? {
            kind: "run_action" as const,
            label: "Push",
            action: { kind: "push" as const },
          }
        : (result.action === "push" ||
              result.action === "create_pr" ||
              result.action === "commit_push" ||
              result.action === "commit_push_pr") &&
            openPr?.url &&
            (!currentBranchIsDefault ||
              result.pr.status === "created" ||
              result.pr.status === "opened_existing")
          ? {
              kind: "open_pr" as const,
              label: `View ${terms.shortLabel}`,
              url: openPr.url,
            }
          : (result.action === "push" || result.action === "commit_push") &&
              result.push.status === "pushed" &&
              !currentBranchIsDefault
            ? {
                kind: "run_action" as const,
                label: `Create ${terms.shortLabel}`,
                action: { kind: "create_pr" as const },
              }
            : {
                kind: "none" as const,
              };

    return {
      ...summary,
      cta,
    };
  });

  /** Git's half of the shared change-request step: every read comes from `GitVcsDriver`. */
  const gitChangeRequestReads = Effect.fn("GitManager.gitChangeRequestReads")(function* (
    cwd: string,
  ) {
    const provider = yield* sourceControlProvider(cwd);
    const details = yield* gitCore.statusDetails(cwd);
    const reads = {
      refName: details.branch,
      hasUpstream: details.hasUpstream,
      upstreamRef: details.upstreamRef,
      readRangeContext: gitCore.readRangeContext,
      executeGit: gitCore.execute,
      providerCwd: cwd,
      readConfigValue: gitCore.readConfigValue,
      resolvePrimaryRemoteName: gitCore.resolvePrimaryRemoteName,
      resolveRefName: gitCore.resolveBranchName,
      resolveDefaultRefName: gitCore.resolveDefaultBranchName,
      resolveRemoteTrackingCommit: gitCore.resolveRemoteTrackingCommit,
    } satisfies ChangeRequestVcsReads;
    return { provider, reads };
  });

  const runCommitStep = Effect.fn("runCommitStep")(function* (
    settings: SourceControlTextGenerationSettings,
    cwd: string,
    action: "commit" | "commit_push" | "commit_push_pr",
    branch: string | null,
    commitMessage?: string,
    preResolvedSuggestion?: CommitAndBranchSuggestion,
    filePaths?: readonly string[],
    progressReporter?: GitActionProgressReporter,
    actionId?: string,
  ) {
    const emit = (event: GitActionProgressPayload) =>
      progressReporter && actionId
        ? progressReporter.publish({
            actionId,
            cwd,
            action,
            ...event,
          } as GitActionProgressEvent)
        : Effect.void;

    let suggestion: CommitAndBranchSuggestion | null | undefined = preResolvedSuggestion;
    if (!suggestion) {
      const needsGeneration = !commitMessage?.trim();
      if (needsGeneration) {
        yield* emit({
          kind: "phase_started",
          phase: "commit",
          label: "Generating commit message...",
        });
      }
      suggestion = yield* withChangeRequestServices(
        resolveCommitAndBranchSuggestion({
          cwd,
          branch,
          ...(commitMessage ? { commitMessage } : {}),
          ...(filePaths ? { filePaths } : {}),
          settings,
          executeGit: gitCore.execute,
          prepareCommitContext: gitCore.prepareCommitContext,
        }),
      );
    }
    if (!suggestion) {
      return { status: "skipped_no_changes" as const };
    }

    yield* emit({
      kind: "phase_started",
      phase: "commit",
      label: "Committing...",
    });

    let currentHookName: string | null = null;
    const commitProgress =
      progressReporter && actionId
        ? {
            onOutputLine: ({ stream, text }: { stream: "stdout" | "stderr"; text: string }) => {
              const sanitized = sanitizeProgressText(text);
              if (!sanitized) {
                return Effect.void;
              }
              return emit({
                kind: "hook_output",
                hookName: currentHookName,
                stream,
                text: sanitized,
              });
            },
            onHookStarted: (hookName: string) => {
              currentHookName = hookName;
              return emit({
                kind: "hook_started",
                hookName,
              });
            },
            onHookFinished: ({
              hookName,
              exitCode,
              durationMs,
            }: {
              hookName: string;
              exitCode: number | null;
              durationMs: number | null;
            }) => {
              if (currentHookName === hookName) {
                currentHookName = null;
              }
              return emit({
                kind: "hook_finished",
                hookName,
                exitCode,
                durationMs,
              });
            },
          }
        : null;
    const { commitSha } = yield* gitCore.commit(cwd, suggestion.subject, suggestion.body, {
      timeoutMs: COMMIT_TIMEOUT_MS,
      stage: filePaths ? { filePaths } : {},
      ...(commitProgress ? { progress: commitProgress } : {}),
    });
    if (currentHookName !== null) {
      yield* emit({
        kind: "hook_finished",
        hookName: currentHookName,
        exitCode: 0,
        durationMs: null,
      });
      currentHookName = null;
    }
    return {
      status: "created" as const,
      commitSha,
      subject: suggestion.subject,
    };
  });

  const localStatus: GitManager["Service"]["localStatus"] = Effect.fn("localStatus")(
    function* (input) {
      const cacheKey = yield* normalizeStatusCacheKey(input.cwd);
      return yield* Cache.get(localStatusResultCache, cacheKey);
    },
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
  // A merged or closed answer can settle a thread or remove its worktree, so
  // branchPullRequest confirms one against fresh reads, and discovery asks for
  // fresh reads (`freshGitState`) before it persists an answer.
  const prLookupGitStateByKey = new Map<
    string,
    { readonly readAtMs: number; readonly value: string | null }
  >();
  const rememberPrLookupGitState = Effect.fn("GitManager.rememberPrLookupGitState")(function* <E>(
    cwd: string,
    key: string,
    fresh: boolean,
    read: Effect.Effect<string | null, E>,
  ) {
    const entryKey = `${cwd}\u0000${key}`;
    const readAtMs = yield* Clock.currentTimeMillis;
    const remembered = prLookupGitStateByKey.get(entryKey);
    if (
      !fresh &&
      remembered !== undefined &&
      readAtMs - remembered.readAtMs < Duration.toMillis(PR_LOOKUP_GIT_STATE_TTL)
    ) {
      return remembered.value;
    }
    // invalidateStatus bumps the epoch. A read that started before a T3 git
    // action, or before a newer read finished, must not replace their state.
    const epoch = prLookupEpoch(cwd);
    const value = yield* read;
    const latest = prLookupGitStateByKey.get(entryKey);
    if (prLookupEpoch(cwd) !== epoch || (latest !== undefined && latest.readAtMs > readAtMs)) {
      return value;
    }
    prLookupGitStateByKey.delete(entryKey);
    if (prLookupGitStateByKey.size >= PR_LOOKUP_CACHE_CAPACITY) {
      const oldestKey = prLookupGitStateByKey.keys().next().value;
      if (oldestKey !== undefined) prLookupGitStateByKey.delete(oldestKey);
    }
    prLookupGitStateByKey.set(entryKey, { readAtMs, value });
    return value;
  });
  const forgetPrLookupGitState = (cwd: string) =>
    normalizeStatusCacheKey(cwd).pipe(
      Effect.map((cacheCwd) => {
        const prefix = `${cacheCwd}\u0000`;
        for (const key of prLookupGitStateByKey.keys()) {
          if (key.startsWith(prefix)) prLookupGitStateByKey.delete(key);
        }
      }),
    );
  const resolvePrLookupRepositoryIdentity = Effect.fn("resolvePrLookupRepositoryIdentity")(
    function* (
      cwd: string,
      branch: string,
      remoteNameOverride: string | undefined,
      fresh: boolean,
    ) {
      const readConfig = (key: string) =>
        rememberPrLookupGitState(
          cwd,
          `config\u0000${key}`,
          fresh,
          gitCore.readConfigValue(cwd, key),
        ).pipe(Effect.orElseSucceed(() => null));
      const readRemoteUrlKey = (remoteName: string | null) =>
        remoteName === null
          ? Effect.succeed(null)
          : readConfig(`remote.${remoteName}.url`).pipe(
              Effect.map((remoteUrl) => (remoteUrl ? normalizeGitRemoteUrl(remoteUrl) : null)),
            );
      const remoteName = remoteNameOverride ?? (yield* readConfig(`branch.${branch}.remote`));
      const [headRemoteUrlKey, targetRemoteUrlKey] =
        remoteName === "origin"
          ? yield* readRemoteUrlKey("origin").pipe(Effect.map((key) => [key, key] as const))
          : yield* Effect.all([readRemoteUrlKey(remoteName), readRemoteUrlKey("origin")], {
              concurrency: "unbounded",
            });
      return {
        remoteName,
        headRemoteUrlKey: headRemoteUrlKey ?? (remoteName === null ? targetRemoteUrlKey : null),
        targetRemoteUrlKey,
      };
    },
  );
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
    const branchRef = yield* remember(
      `branchRef\u0000${branch}`,
      gitCore
        .execute({
          operation: "GitManager.branchPullRequest.branchRef",
          cwd: cacheCwd,
          args: [
            "for-each-ref",
            "--format=%(refname)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)",
            `refs/heads/${branch}`,
          ],
        })
        .pipe(Effect.map((result) => result.stdout)),
    );
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
    // The cached head context may have resolved on a different remote than
    // the saved upstream: a branch tracking origin/main but pushed to a fork
    // is looked up on the fork. Verify against the remote the lookup used.
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
      // Hosting CLIs can select an upstream repository instead of origin.
      // The returned PR URL names the repository that actually owns it.
      repositoryKey: pullRequestRepositoryKey(latest.url),
    };
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
    return yield* lookupBranchPullRequest(cacheCwd, branch, {
      refresh: false,
      freshGitState: true,
    });
  });
  const invalidateLocalStatus: GitManager["Service"]["invalidateLocalStatus"] = Effect.fn(
    "invalidateLocalStatus",
  )(function* (cwd) {
    yield* invalidateLocalStatusResultCache(cwd);
  });
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

  const resolvePullRequest: GitManager["Service"]["resolvePullRequest"] = Effect.fn(
    "resolvePullRequest",
  )(function* (input) {
    const pullRequest = yield* (yield* sourceControlProvider(input.cwd))
      .getChangeRequest({
        cwd: input.cwd,
        reference: normalizePullRequestReference(input.reference),
      })
      .pipe(Effect.map((resolved) => toResolvedPullRequest(resolved)));

    return { pullRequest };
  });

  const ensureNoTrackedChanges = Effect.fn("ensureNoTrackedChanges")(function* (
    cwd: string,
    pullRequestNumber: number,
  ) {
    const trackedChanges = yield* gitCore.execute({
      operation: "GitManager.preparePullRequestThread.trackedChanges",
      cwd,
      args: ["status", "--porcelain", "--untracked-files=no"],
    });
    if (trackedChanges.stdout.trim().length > 0) {
      return yield* new GitManagerError({
        operation: "preparePullRequestThread",
        cwd,
        detail: `This repository has uncommitted changes. Commit or stash them before checking out pull request #${pullRequestNumber} here, or check it out in its own folder.`,
      });
    }
  });

  // Some hosts only switch branches on checkout; use the existing lossless refresh to advance them.
  const moveToPullRequestHead = (cwd: string, headSha: string | undefined) =>
    headSha === undefined || !/^[0-9a-f]{7,64}$/i.test(headSha)
      ? Effect.succeed(false)
      : gitCore.resolveCommit({ cwd, revision: headSha }).pipe(
          Effect.flatMap(({ commitSha }) =>
            gitCore.refreshCheckedOutBranch({ cwd, targetCommit: commitSha }),
          ),
          Effect.map((refreshed) => refreshed.onTarget),
          Effect.orElseSucceed(() => false),
        );

  const preparePullRequestThread: GitManager["Service"]["preparePullRequestThread"] = Effect.fn(
    "preparePullRequestThread",
  )(function* (input) {
    const maybeRunSetupScript = (worktreePath: string) => {
      if (!input.threadId) {
        return Effect.void;
      }
      return projectSetupScriptRunner
        .runForThread({
          threadId: input.threadId,
          projectCwd: input.cwd,
          worktreePath,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("GitManager.preparePullRequestThread setup script failed", {
              threadId: input.threadId,
              worktreePath,
              cause: error,
            }).pipe(Effect.asVoid),
          ),
        );
    };
    return yield* Effect.gen(function* () {
      const normalizedReference = normalizePullRequestReference(input.reference);
      const rootWorktreePath = yield* canonicalizeExistingPath(input.cwd);
      const pullRequestSummary = yield* (yield* sourceControlProvider(input.cwd)).getChangeRequest({
        cwd: input.cwd,
        reference: normalizedReference,
      });
      const pullRequest = toResolvedPullRequest(pullRequestSummary);

      if (input.mode === "local") {
        yield* ensureNoTrackedChanges(input.cwd, pullRequest.number);
        yield* (yield* sourceControlProvider(input.cwd)).checkoutChangeRequest({
          cwd: input.cwd,
          reference: normalizedReference,
        });
        const details = yield* gitCore.statusDetails(input.cwd);
        const branch = details.branch ?? pullRequest.headBranch;
        yield* configurePullRequestHeadUpstream(
          input.cwd,
          {
            ...pullRequest,
            ...toPullRequestHeadRemoteInfo(pullRequestSummary),
          },
          branch,
        );
        return {
          pullRequest,
          branch,
          worktreePath: null,
          isOnPullRequestHead: yield* moveToPullRequestHead(input.cwd, pullRequestSummary.headSha),
        };
      }

      const ensureExistingWorktreeUpstream = Effect.fn("ensureExistingWorktreeUpstream")(function* (
        worktreePath: string,
      ) {
        const details = yield* gitCore.statusDetails(worktreePath);
        yield* configurePullRequestHeadUpstream(
          worktreePath,
          {
            ...pullRequest,
            ...toPullRequestHeadRemoteInfo(pullRequestSummary),
          },
          details.branch ?? pullRequest.headBranch,
        );
      });

      const pullRequestWithRemoteInfo = {
        ...pullRequest,
        ...toPullRequestHeadRemoteInfo(pullRequestSummary),
      } as const;
      const localPullRequestBranch =
        resolvePullRequestWorktreeLocalBranchName(pullRequestWithRemoteInfo);

      // Git refuses to move a branch that is checked out in a worktree, so the
      // reuse paths cannot go through materializePullRequestHeadBranch and instead
      // advance the checkout from inside the worktree.
      const reuseExistingWorktree = Effect.fn("reuseExistingWorktree")(function* (
        worktreePath: string,
        checkedOutBranch: string,
      ) {
        if (checkedOutBranch !== localPullRequestBranch) {
          // findLocalHeadBranch also accepts a branch that merely shares the head's bare name —
          // a fork PR opened from "main" matches the user's own local main. That checkout is
          // somebody else's work, so it keeps its tracking config and nothing else.
          return {
            pullRequest,
            branch: localPullRequestBranch,
            worktreePath,
            isOnPullRequestHead: false,
          };
        }

        // Read before ensureExistingWorktreeUpstream: it force-updates the remote-tracking ref,
        // and once that has jumped to a rewritten head there is no way left to tell a checkout
        // that holds nothing of its own from one carrying local commits.
        const upstreamCommitBeforeFetch = yield* gitCore
          .resolveCommit({ cwd: worktreePath, revision: "@{upstream}" })
          .pipe(
            Effect.map((resolved) => resolved.commitSha),
            Effect.orElseSucceed(() => null),
          );

        yield* ensureExistingWorktreeUpstream(worktreePath);

        const refreshed = yield* gitCore
          // The pull request's own ref, because it is the only thing that certainly names its
          // head. The branch's upstream does not: configuring it is best-effort, so a branch cut
          // from `origin/main` whose head branch has since been deleted still resolves — and
          // following it would move the checkout onto main and call that the pull request.
          .fetchPullRequestHeadCommit({ cwd: worktreePath, prNumber: pullRequest.number })
          .pipe(
            // A host that publishes no `refs/pull/<n>/head` leaves the remote-tracking branch,
            // taken only where it is the head branch's own rather than whatever the checkout
            // happened to be cut from.
            Effect.catch(() =>
              Effect.gen(function* () {
                const details = yield* gitCore.statusDetails(worktreePath);
                if (
                  details.upstreamRef === null ||
                  !details.upstreamRef.endsWith(`/${pullRequest.headBranch}`)
                ) {
                  return yield* new GitManagerError({
                    operation: "preparePullRequestThread",
                    cwd: worktreePath,
                    detail: "The pull request head could not be resolved for this checkout.",
                  });
                }
                return yield* gitCore.resolveCommit({
                  cwd: worktreePath,
                  revision: details.upstreamRef,
                });
              }),
            ),
            Effect.flatMap((target) =>
              gitCore.refreshCheckedOutBranch({
                cwd: worktreePath,
                targetCommit: target.commitSha,
                resetWhenHeadCommit: upstreamCommitBeforeFetch,
              }),
            ),
            Effect.catch((error) =>
              Effect.logWarning(
                "GitManager.preparePullRequestThread reused worktree refresh failed",
                {
                  worktreePath,
                  localBranch: localPullRequestBranch,
                  cause: error,
                },
              ).pipe(Effect.as({ moved: false, onTarget: false })),
            ),
          );

        // Only when the checkout actually moved: another thread may be running in this worktree,
        // and re-running the setup script under it buys nothing when the code did not change.
        if (refreshed.moved) {
          yield* maybeRunSetupScript(worktreePath);
        }

        return {
          pullRequest,
          branch: localPullRequestBranch,
          worktreePath,
          isOnPullRequestHead: refreshed.onTarget,
        };
      });

      const findLocalHeadBranch = Effect.fn("findLocalHeadBranch")(function* (cwd: string) {
        for (const [index, name] of [
          ...new Set([localPullRequestBranch, pullRequest.headBranch]),
        ].entries()) {
          let cursor: number | undefined;
          do {
            const result = yield* gitCore.listRefs({
              cwd,
              refKind: "local",
              query: name,
              cursor,
              refresh: index === 0 && cursor === undefined,
            });
            for (const branch of result.refs) {
              if (branch.name !== name) {
                continue;
              }
              if (name === localPullRequestBranch) {
                return branch;
              }
              if (branch.worktreePath) {
                const worktreePath = yield* canonicalizeExistingPath(branch.worktreePath);
                if (worktreePath !== rootWorktreePath) {
                  return branch;
                }
              }
            }
            cursor = result.nextCursor ?? undefined;
          } while (cursor !== undefined);
        }

        return null;
      });

      const existingBranchBeforeFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchBeforeFetchPath = existingBranchBeforeFetch?.worktreePath
        ? yield* canonicalizeExistingPath(existingBranchBeforeFetch.worktreePath)
        : null;
      if (
        existingBranchBeforeFetch?.worktreePath &&
        existingBranchBeforeFetchPath !== rootWorktreePath
      ) {
        return yield* reuseExistingWorktree(
          existingBranchBeforeFetch.worktreePath,
          existingBranchBeforeFetch.name,
        );
      }
      if (existingBranchBeforeFetchPath === rootWorktreePath) {
        return yield* new GitManagerError({
          operation: "preparePullRequestThread",
          cwd: input.cwd,
          detail:
            "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        });
      }

      yield* materializePullRequestHeadBranch(
        input.cwd,
        pullRequestWithRemoteInfo,
        localPullRequestBranch,
      );

      const existingBranchAfterFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchAfterFetchPath = existingBranchAfterFetch?.worktreePath
        ? yield* canonicalizeExistingPath(existingBranchAfterFetch.worktreePath)
        : null;
      if (
        existingBranchAfterFetch?.worktreePath &&
        existingBranchAfterFetchPath !== rootWorktreePath
      ) {
        return yield* reuseExistingWorktree(
          existingBranchAfterFetch.worktreePath,
          existingBranchAfterFetch.name,
        );
      }
      if (existingBranchAfterFetchPath === rootWorktreePath) {
        return yield* new GitManagerError({
          operation: "preparePullRequestThread",
          cwd: input.cwd,
          detail:
            "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        });
      }

      const worktree = yield* gitCore.createWorktree(
        {
          cwd: input.cwd,
          refName: localPullRequestBranch,
          path: null,
        },
        {
          worktreesDirectory: yield* readWorktreesDirectory,
          submodules: yield* projectSettingsFor(input).pipe(
            Effect.map(({ settings }) => settings.worktreeSubmodules),
            Effect.orElseSucceed(() => null),
          ),
        },
      );
      yield* ensureExistingWorktreeUpstream(worktree.worktree.path);
      yield* maybeRunSetupScript(worktree.worktree.path);

      return {
        pullRequest,
        branch: worktree.worktree.refName,
        worktreePath: worktree.worktree.path,
        isOnPullRequestHead: true,
      };
    }).pipe(Effect.ensuring(invalidateStatus(input.cwd)));
  });

  const runFeatureBranchStep = Effect.fn("runFeatureBranchStep")(function* (
    settings: SourceControlTextGenerationSettings,
    cwd: string,
    branch: string | null,
    commitMessage?: string,
    filePaths?: readonly string[],
  ) {
    const suggestion = yield* withChangeRequestServices(
      resolveCommitAndBranchSuggestion({
        cwd,
        branch,
        ...(commitMessage ? { commitMessage } : {}),
        ...(filePaths ? { filePaths } : {}),
        includeBranch: true,
        settings,
        executeGit: gitCore.execute,
        prepareCommitContext: gitCore.prepareCommitContext,
      }),
    );
    if (!suggestion) {
      return yield* new GitManagerError({
        operation: "runFeatureBranchStep",
        cwd,
        detail: "Cannot create a feature branch because there are no changes to commit.",
      });
    }

    const preferredBranch = suggestion.branch ?? sanitizeFeatureBranchName(suggestion.subject);
    const existingBranchNames = yield* gitCore.listLocalBranchNames(cwd);
    const resolvedBranch = resolveAutoFeatureBranchName(existingBranchNames, preferredBranch);

    yield* gitCore.createRef({ cwd, refName: resolvedBranch });
    yield* Effect.scoped(gitCore.switchRef({ cwd, refName: resolvedBranch }));

    return {
      branchStep: { status: "created" as const, name: resolvedBranch },
      resolvedCommitMessage: suggestion.commitMessage,
      resolvedCommitSuggestion: suggestion,
    };
  });

  const runStackedAction: GitManager["Service"]["runStackedAction"] = Effect.fn("runStackedAction")(
    function* (input, options) {
      const progress = yield* createProgressEmitter(input, options);
      const currentPhase = yield* Ref.make<Option.Option<GitActionProgressPhase>>(Option.none());

      const runAction = Effect.fn("runStackedAction.runAction")(function* (): Effect.fn.Return<
        GitRunStackedActionResult,
        GitManagerServiceError
      > {
        const initialStatus = yield* gitCore.statusDetails(input.cwd);
        const wantsCommit = isCommitAction(input.action);
        const wantsPush =
          input.action === "push" ||
          input.action === "commit_push" ||
          input.action === "commit_push_pr" ||
          (input.action === "create_pr" &&
            (!initialStatus.hasUpstream || initialStatus.aheadCount > 0));
        const wantsPr = input.action === "create_pr" || input.action === "commit_push_pr";

        if (input.featureBranch && !wantsCommit) {
          return yield* new GitManagerError({
            operation: "runStackedAction",
            cwd: input.cwd,
            detail: "Feature-branch checkout is only supported for commit actions.",
          });
        }
        const phases: GitActionProgressPhase[] = [
          ...(input.featureBranch ? (["branch"] as const) : []),
          ...(wantsCommit ? (["commit"] as const) : []),
          ...(wantsPush ? (["push"] as const) : []),
          ...(wantsPr ? (["pr"] as const) : []),
        ];

        yield* progress.emit({
          kind: "action_started",
          phases,
        });

        if (!input.featureBranch && wantsPush && !initialStatus.branch) {
          return yield* new GitManagerError({
            operation: "runStackedAction",
            cwd: input.cwd,
            detail: "Cannot push from detached HEAD.",
          });
        }
        if (!input.featureBranch && wantsPr && !initialStatus.branch) {
          return yield* new GitManagerError({
            operation: "runStackedAction",
            cwd: input.cwd,
            detail: "Cannot create a pull request from detached HEAD.",
          });
        }

        let branchStep: { status: "created" | "skipped_not_requested"; name?: string };
        let commitMessageForStep = input.commitMessage;
        let preResolvedCommitSuggestion: CommitAndBranchSuggestion | undefined = undefined;

        const textGenerationSettings = yield* withChangeRequestServices(
          resolveTextGenerationSettings({
            operation: "runStackedAction",
            cwd: input.cwd,
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
          }),
        );

        if (input.featureBranch) {
          yield* Ref.set(currentPhase, Option.some("branch"));
          yield* progress.emit({
            kind: "phase_started",
            phase: "branch",
            label: "Preparing feature branch...",
          });
          const result = yield* runFeatureBranchStep(
            textGenerationSettings,
            input.cwd,
            initialStatus.branch,
            input.commitMessage,
            input.filePaths,
          );
          branchStep = result.branchStep;
          commitMessageForStep = result.resolvedCommitMessage;
          preResolvedCommitSuggestion = result.resolvedCommitSuggestion;
        } else {
          branchStep = { status: "skipped_not_requested" as const };
        }

        const currentBranch = branchStep.name ?? initialStatus.branch;
        const commitAction = isCommitAction(input.action) ? input.action : null;
        const changeRequestTerms = wantsPr
          ? yield* sourceControlProvider(input.cwd).pipe(
              Effect.map((provider) => getChangeRequestTerminologyForKind(provider.kind)),
              Effect.orElseSucceed(() =>
                getChangeRequestTerminologyForKind(SourceControlProviderKind.make("unknown")),
              ),
            )
          : null;

        const commit = commitAction
          ? yield* Ref.set(currentPhase, Option.some("commit")).pipe(
              Effect.flatMap(() =>
                runCommitStep(
                  textGenerationSettings,
                  input.cwd,
                  commitAction,
                  currentBranch,
                  commitMessageForStep,
                  preResolvedCommitSuggestion,
                  input.filePaths,
                  options?.progressReporter,
                  progress.actionId,
                ),
              ),
            )
          : { status: "skipped_not_requested" as const };

        const push = wantsPush
          ? yield* progress
              .emit({
                kind: "phase_started",
                phase: "push",
                label: "Pushing...",
              })
              .pipe(
                Effect.tap(() => Ref.set(currentPhase, Option.some("push"))),
                Effect.flatMap(() => gitCore.pushCurrentBranch(input.cwd, currentBranch)),
              )
          : { status: "skipped_not_requested" as const };

        const pr = wantsPr
          ? yield* progress
              .emit({
                kind: "phase_started",
                phase: "pr",
                label: `Preparing ${changeRequestTerms?.shortLabel ?? "PR"}...`,
              })
              .pipe(
                Effect.tap(() => Ref.set(currentPhase, Option.some("pr"))),
                Effect.flatMap(() => gitChangeRequestReads(input.cwd)),
                Effect.flatMap(({ provider, reads }) =>
                  withChangeRequestServices(
                    runChangeRequestStep({
                      settings: textGenerationSettings,
                      cwd: input.cwd,
                      fallbackRefName: currentBranch,
                      threadId: input.threadId,
                      tempDir,
                      emit: progress.emit,
                      reads,
                      provider,
                    }),
                  ),
                ),
              )
          : { status: "skipped_not_requested" as const };

        const toast = yield* buildCompletionToast(input.cwd, {
          action: input.action,
          branch: branchStep,
          commit,
          push,
          pr,
        });

        const result = {
          action: input.action,
          branch: branchStep,
          commit,
          push,
          pr,
          toast,
        };
        yield* progress.emit({
          kind: "action_finished",
          result,
        });
        return result;
      });

      return yield* runAction().pipe(
        Effect.ensuring(invalidateStatus(input.cwd)),
        Effect.tapError((error) =>
          Effect.flatMap(Ref.get(currentPhase), (phase) =>
            progress.emit({
              kind: "action_failed",
              phase: Option.getOrNull(phase),
              message: error.message,
            }),
          ),
        ),
      );
    },
  );

  return GitManager.of({
    createWorktree,
    localStatus,
    remoteStatus,
    status,
    branchPullRequest,
    invalidateLocalStatus,
    invalidateRemoteStatus,
    invalidateStatus,
    resolvePullRequest,
    preparePullRequestThread,
    runStackedAction,
    subscribePullRequestStateChanges: PubSub.subscribe(pullRequestStateChanges).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
  });
});

export const layer = Layer.effect(GitManager, make);
