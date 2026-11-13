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
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { extractBranchNameFromRemoteRef } from "./remoteRefs.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { GitManager, PR_LOOKUP_CACHE_CAPACITY, PR_LOOKUP_GIT_STATE_TTL, STATUS_RESULT_CACHE_CAPACITY, STATUS_RESULT_CACHE_TTL, formatCommitMessage, headBranchProbe, isNotGitRepositoryError, limitContext, matchesBranchHeadContext, normalizePullRequestReference, parseCustomCommitMessage, pullRequestRepositoryKey, pullRequestUpdatedAtDescOrder, resolveHeadRepositoryNameWithOwner, sanitizeCommitMessage, shouldPreferSshRemote, toPullRequestInfo, toResolvedPullRequest, type SuccessOf } from "./GitManager.ts";
import type { BranchHeadContext, PullRequestHeadRemoteInfo, PullRequestInfo, ResolvedPullRequest, SourceControlTextGenerationSettings } from "./GitManager.ts";
import { install0 } from "./gitManagerPart0.ts";

export type Deps = SuccessOf<typeof install0>;

export const install1 = Effect.fn("gitManager.install1")(function* (d: Deps) {
  const { asUserAction, changeRequestHeadRef, configurePullRequestHeadUpstreamBase, findRemoteTrackingRemote, gitCore, nonRepositoryStatusDetails, normalizeStatusCacheKey, prLookupEpoch, prLookupEpochByCwd, prLookupGitStateByKey, projectSettingsFor, pullRequestHostOptions, readConfigValueNullable, readWorktreesDirectory, resolveHostingProvider, resolveRemoteRepositoryContext, resolveStylePolicy, shareBranchBase, sourceControlProvider, textGeneration } = d;
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
                // Exit 1 means non-ancestor; other failures must reject inference rather than pick another fork.
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

  // worktree add can set origin/main as upstream; this base is not the branch's published PR head.

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

  const findOpenPr = Effect.fn("findOpenPr")(function* (
    cwd: string,
    headContext: Pick<
      BranchHeadContext,
      | "headBranch"
      | "headSelectors"
      | "headRepositoryNameWithOwner"
      | "headRepositoryOwnerLogin"
      | "isCrossRepository"
    >,
  ) {
    const provider = yield* sourceControlProvider(cwd);
    const probe = headBranchProbe(provider, headContext.headSelectors, "open");
    for (const headSelector of probe.headSelectors) {
      const pullRequests = yield* provider.listChangeRequests({
        cwd,
        headSelector,
        state: "open",
        limit: probe.limit,
      });
      const normalizedPullRequests = pullRequests.map(toPullRequestInfo);

      const firstPullRequest = normalizedPullRequests.find((pullRequest) =>
        matchesBranchHeadContext(pullRequest, headContext),
      );
      if (firstPullRequest) {
        return {
          ...firstPullRequest,
          state: "open",
          updatedAt: Option.none(),
        } satisfies PullRequestInfo;
      }
    }

    return null;
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

  const resolvePrBase = Effect.fn("resolvePrBase")(function* (
    cwd: string,
    branch: string,
    upstreamRef: string | null,
    headContext: Pick<BranchHeadContext, "isCrossRepository" | "remoteName">,
  ) {
    const configuredRef = yield* gitCore.readConfigValue(cwd, `branch.${branch}.t3-merge-base-ref`);
    if (configuredRef?.startsWith("refs/heads/") || configuredRef?.startsWith("refs/remotes/")) {
      const configuredBranch = yield* gitCore.resolveBranchName(cwd, configuredRef);
      if (configuredBranch) return { baseBranch: configuredBranch, baseRef: configuredRef };
    }

    const configured = yield* gitCore.readBranchBase(cwd, branch);
    if (configured) {
      const localRef = configured.startsWith("refs/") ? configured : `refs/heads/${configured}`;
      const localBranch = yield* gitCore.resolveBranchName(cwd, localRef);
      if (localBranch) {
        const shadowsRemote =
          configured.includes("/") &&
          !configured.startsWith("refs/") &&
          (yield* gitCore.resolveBranchName(cwd, `refs/remotes/${configured}`)) !== null;
        return {
          baseBranch: localBranch,
          baseRef: configured.startsWith("refs/") || shadowsRemote ? localRef : localBranch,
        };
      }
      if (configured.includes("/") && !configured.startsWith("refs/")) {
        const remoteRef = `refs/remotes/${configured}`;
        const remoteBranch = yield* gitCore.resolveBranchName(cwd, remoteRef);
        if (remoteBranch) return { baseBranch: remoteBranch, baseRef: remoteRef };
      }
      const configuredBranch = yield* gitCore.resolveBranchName(cwd, configured);
      if (configuredBranch) return { baseBranch: configuredBranch, baseRef: configuredBranch };
    }

    if (upstreamRef && !headContext.isCrossRepository) {
      const upstreamBranch = extractBranchNameFromRemoteRef(upstreamRef, {
        remoteName: headContext.remoteName,
      });
      if (upstreamBranch.length > 0 && upstreamBranch !== branch) {
        return { baseBranch: upstreamBranch, baseRef: upstreamBranch };
      }
    }

    const defaultFromProvider = yield* sourceControlProvider(cwd).pipe(
      Effect.flatMap((provider) => provider.getDefaultBranch({ cwd })),
      Effect.orElseSucceed(() => null),
    );
    if (defaultFromProvider) {
      return { baseBranch: defaultFromProvider, baseRef: defaultFromProvider };
    }

    const defaultFromRemote = yield* gitCore.resolvePrimaryRemoteName(cwd).pipe(
      Effect.flatMap((remoteName) => gitCore.resolveDefaultBranchName(cwd, remoteName)),
      Effect.orElseSucceed(() => null),
    );
    if (defaultFromRemote) {
      return { baseBranch: defaultFromRemote, baseRef: defaultFromRemote };
    }

    return { baseBranch: "main", baseRef: "main" };
  });

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
  }, asUserAction);

  const pushCurrentBranch = Effect.fn("GitManager.pushCurrentBranch")(function* (
    cwd: string,
    branch: string | null,
  ) {
    const result = yield* gitCore.pushCurrentBranch(cwd, branch);
    if (result.status === "pushed" && result.branch) {
      yield* shareBranchBase(cwd, result.branch);
    }
    return result;
  });

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
    const result = yield* gitCore.createWorktree(input, {
      worktreesDirectory,
      ...options,
      submodules,
    });
    if (input.newRefName && input.baseRefName) {
      yield* shareBranchBase(input.cwd, input.newRefName);
    }
    return result;
  });

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

  // The kind comes from the provider, not the remote alone: an unrecognised remote can resolve
  // to a known host.

  const fetchChangeRequestHeadIntoBranch = Effect.fn("GitManager.fetchChangeRequestHeadIntoBranch")(
    function* (cwd: string, number: number, branch: string) {
      const ref = yield* changeRequestHeadRef(cwd, number);
      yield* gitCore.fetchRefIntoBranch({ cwd, ref, branch });
    },
  );

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

  const bumpPrLookupEpoch = (cwd: string) =>
    normalizeStatusCacheKey(cwd).pipe(
      Effect.map((cacheKey) => {
        prLookupEpochByCwd.set(cacheKey, prLookupEpoch(cacheKey) + 1);
      }),
    );

  const resolveHeadAndOriginContexts = (cwd: string, remoteName: string | null) =>
    remoteName === "origin"
      ? resolveRemoteRepositoryContext(cwd, "origin").pipe(
          Effect.map((origin) => [origin, origin] as const),
        )
      : Effect.all(
          [
            resolveRemoteRepositoryContext(cwd, remoteName),
            resolveRemoteRepositoryContext(cwd, "origin"),
          ],
          { concurrency: "unbounded" },
        );

  const resolveCommitAndBranchSuggestion = Effect.fn("resolveCommitAndBranchSuggestion")(
    function* (input: {
      cwd: string;
      branch: string | null;
      commitMessage?: string;
      includeBranch?: boolean;
      filePaths?: readonly string[];
      settings: SourceControlTextGenerationSettings;
    }) {
      const customCommit = parseCustomCommitMessage(input.commitMessage ?? "");
      const context = yield* gitCore.prepareCommitContext(input.cwd, input.filePaths, {
        includePatch: customCommit === null,
      });
      if (!context) {
        return null;
      }

      if (customCommit) {
        return {
          subject: customCommit.subject,
          body: customCommit.body,
          ...(input.includeBranch
            ? { branch: sanitizeFeatureBranchName(customCommit.subject) }
            : {}),
          commitMessage: formatCommitMessage(customCommit.subject, customCommit.body),
        };
      }

      const policy = yield* resolveStylePolicy(input.cwd, input.settings);

      const generated = yield* textGeneration
        .generateCommitMessage({
          cwd: input.cwd,
          branch: input.branch,
          stagedSummary: limitContext(context.stagedSummary, 8_000),
          stagedPatch: limitContext(context.stagedPatch, 50_000),
          ...(input.includeBranch ? { includeBranch: true } : {}),
          ...(policy ? { policy } : {}),
          modelSelection: input.settings.modelSelection,
        })
        .pipe(Effect.map((result) => sanitizeCommitMessage(result)));

      return {
        subject: generated.subject,
        body: generated.body,
        ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
        commitMessage: formatCommitMessage(generated.subject, generated.body),
      };
    },
  );

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
              Effect.map((remoteUrl) =>
                remoteUrl ? sourceControlDefinitions.repositoryKeyFromRemote(remoteUrl) : null,
              ),
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
  // objectname lets a settled PR result notice new commits on its branch.

  const readPrLookupBranchRef = (cacheCwd: string, branch: string, fresh: boolean) =>
    rememberPrLookupGitState(
      cacheCwd,
      `branchRef\u0000${branch}`,
      fresh,
      gitCore
        .execute({
          operation: "GitManager.branchPullRequest.branchRef",
          cwd: cacheCwd,
          args: [
            "for-each-ref",
            "--format=%(refname)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(objectname)",
            `refs/heads/${branch}`,
          ],
        })
        .pipe(Effect.map((result) => result.stdout)),
    );

  const materializePullRequestHeadBranchBase = Effect.fn("materializePullRequestHeadBranch")(
    function* (
      cwd: string,
      pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
      localBranch = pullRequest.headBranch,
    ) {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";

      if (repositoryNameWithOwner.length === 0) {
        yield* fetchChangeRequestHeadIntoBranch(cwd, pullRequest.number, localBranch).pipe(
          // Fall back to a branch fetch only for an open PR in the primary remote's repository.
          // A host can resolve a PR number from another repository, so verify the repository first.
          // Closed PR branches may have moved past the head recorded at closure.
          Effect.catch((cause) =>
            pullRequest.isCrossRepository === true || pullRequest.state !== "open"
              ? Effect.fail(cause)
              : Effect.gen(function* () {
                  const remoteName = yield* gitCore.resolvePrimaryRemoteName(cwd);
                  const remoteUrl = yield* gitCore.readConfigValue(cwd, `remote.${remoteName}.url`);
                  const pullRequestKey = pullRequestRepositoryKey(pullRequest.url);
                  if (
                    remoteUrl === null ||
                    pullRequestKey === null ||
                    sourceControlDefinitions.canonicalRepositoryKey(pullRequestKey) !==
                      sourceControlDefinitions.canonicalRepositoryKey(
                        sourceControlDefinitions.repositoryKeyFromRemote(remoteUrl),
                      )
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
        ...pullRequestHostOptions(pullRequest.url),
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

  const localStatusResultCache = yield* Cache.makeWith(readLocalStatus, {
    capacity: STATUS_RESULT_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? STATUS_RESULT_CACHE_TTL : Duration.zero),
  });
  return {
    findPublishedBranchRemote,
    isUnpublishedBranch,
    findOpenPr,
    findLatestPrForHeadContext,
    resolvePrBase,
    rememberPrLookupGitState,
    resolvePullRequest,
    pushCurrentBranch,
    createWorktree,
    configurePullRequestHeadUpstream,
    fetchChangeRequestHeadIntoBranch,
    readLocalStatus,
    bumpPrLookupEpoch,
    resolveHeadAndOriginContexts,
    resolveCommitAndBranchSuggestion,
    forgetPrLookupGitState,
    resolvePrLookupRepositoryIdentity,
    readPrLookupBranchRef,
    materializePullRequestHeadBranchBase,
    localStatusResultCache,
  };
});
