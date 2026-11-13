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
  hasProjectSettingsOverrides,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import {
  type ChangeRequestTerminology,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
} from "@t3tools/source-control-core/shared/definition";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
} from "../sourceControl/threadPullRequests.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

import { GitManagerError, GitPullRequestMaterializationError } from "@t3tools/contracts";
import {
  historicalMessage,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  conventionalCommitsTextGenerationPolicy,
  customTextGenerationPolicy,
  repositoryConventionsTextGenerationPolicy,
} from "../textGeneration/TextGenerationPresets.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { PR_LOOKUP_CACHE_CAPACITY, PR_THREAD_CONTEXT_BYTES, limitCommandOutput, parseRepositoryNameWithOwnerFromRemoteUrl, parseRepositoryOwnerLogin, prLookupFailureTtl, resolveHeadRepositoryNameWithOwner, shouldPreferSshRemote, toStatusPr, type SuccessOf } from "./GitManager.ts";
import type { GitActionProgressPayload, GitRunStackedActionOptions, PullRequestHeadRemoteInfo, PullRequestInfo, ResolvedPullRequest, SourceControlTextGenerationSettings } from "./GitManager.ts";

export type Deps = {};

export const install0 = Effect.fn("gitManager.install0")(function* (d: Deps) {
  const gitCore = yield* GitVcsDriver.GitVcsDriver;

  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const textGeneration = yield* TextGeneration.TextGeneration;

  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;

  const random = yield* SecureRandom.SecureRandom;

  const fileSystem = yield* FileSystem.FileSystem;

  const path = yield* Path.Path;

  const serverSettingsService = yield* ServerSettings.ServerSettingsService;

  const threads = yield* ProjectionStore.ProjectionStoreV2;

  const projects = yield* ProjectStore.ProjectStoreV2;

  const pullRequestHostOptions = (url: string) => {
    const host = URL.parse(url)?.host;
    return host ? { host } : {};
  };

  const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

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

  const prLookupEpochByCwd = new Map<string, number>();

  const prLookupFailureStreakByKey = new Map<string, number>();

  const pullRequestStateChanges = yield* PubSub.sliding<ThreadPullRequestKey>(64);

  const lookupStates = new Map<
    string,
    { readonly state: PullRequestInfo["state"]; readonly isDraft: boolean }
  >();

  interface LastKnownPr {
    readonly pr: ReturnType<typeof toStatusPr> | null;
    readonly headSha: string | null;
    readonly upstreamRef: string | null;
    readonly headBranch: string;
    readonly remoteName: string | null;
    readonly headRemoteUrlKey: string | null;
  }

  const prLookupGitStateByKey = new Map<
    string,
    { readonly readAtMs: number; readonly value: string | null }
  >();

  const settledPrLookupByBranchKey = new Map<
    string,
    { readonly url: string; readonly fingerprint: string; readonly confirmedAtMs: number }
  >();

  const asUserAction = Effect.provideService(SourceControlRateLimit.Interactive, true);

  const sourceControlProvider = (cwd: string) => sourceControlProviders.resolve({ cwd });

  const projectSettingsFor = Effect.fnUntraced(function* (input: {
    readonly cwd: string;
    readonly threadId?: ThreadId | undefined;
    readonly projectId?: ProjectId | undefined;
  }) {
    const settings = yield* serverSettingsService.getSettings;
    if (!hasProjectSettingsOverrides(settings))
      return { settings, projectId: null as ProjectId | null };
    const threadProjectId =
      input.threadId === undefined
        ? null
        : yield* threads.getThreadShell(input.threadId).pipe(
            Effect.map((thread) => thread?.projectId ?? null),
            Effect.orElseSucceed(() => null),
          );
    const projectId =
      threadProjectId ??
      input.projectId ??
      (yield* projects.findActiveByWorkspaceRoot(input.cwd).pipe(
        Effect.map((project) => Option.getOrNull(project)?.projectId ?? null),
        Effect.orElseSucceed(() => null),
      ));
    return { settings: resolveProjectSettings(settings, projectId).settings, projectId };
  });

  const readThreadContext = Effect.fnUntraced(
    function* (threadId: ThreadId | undefined) {
      if (threadId === undefined) return undefined;
      const { visibleTurnItems } = yield* threads.getThreadProjection(threadId);
      const selected = selectHistory({
        messages: visibleTurnItems.flatMap(
          ({ item }) => historicalMessage(limitCommandOutput(item)) ?? [],
        ),
        coverage: "Digest of the thread that made this change, oldest first.",
        budget: PR_THREAD_CONTEXT_BYTES,
      });
      return selected.messages.length === 0
        ? undefined
        : renderHistory(selected.messages, selected.context);
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("GitManager.readThreadContext failed", {
            threadId,
            errorTag: error._tag,
          }).pipe(Effect.as(undefined)),
        ),
      ),
  );
  // Hands the base T3 recorded for a branch to the host, whose own tools may keep it elsewhere.
  // Best-effort: nothing T3 does reads it back from there.

  const readWorktreesDirectory = serverSettingsService.getSettings.pipe(
    Effect.map((settings) => settings.worktreesDirectory),
    Effect.orElseSucceed(() => ""),
  );

  const readRepositoryInstructions = Effect.fn("GitManager.readRepositoryInstructions")(
    function* (cwd: string, fileName: string) {
      const root = yield* fileSystem.realPath(cwd);
      const instructionPath = yield* fileSystem.realPath(path.join(root, fileName));
      const relative = path.relative(root, instructionPath);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        return "";
      }
      const info = yield* fileSystem.stat(instructionPath);
      if (info.type !== "File" || info.size > ByteSize.bytes(20_000)) {
        return "";
      }
      return (yield* fileSystem.readFileString(instructionPath)).trim();
    },
    Effect.orElseSucceed(() => ""),
  );

  const readRecentCommitSubjects = (cwd: string) =>
    gitCore
      .execute({
        operation: "GitManager.readRecentCommitSubjects",
        cwd,
        args: ["log", "-n", "20", "--no-merges", "--no-show-signature", "--pretty=format:%s"],
      })
      .pipe(
        Effect.map((result) =>
          result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        ),
        Effect.orElseSucceed(() => []),
      );

  const randomUUIDv4 = (cwd: string) =>
    random.uuidV4().pipe(
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

  const canonicalizeExistingPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));

  const prLookupEpoch = (cwd: string) => prLookupEpochByCwd.get(cwd) ?? 0;

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

  const noteLookupState = (pr: PullRequestInfo) =>
    Effect.suspend(() => {
      const parsed = sourceControlDefinitions.parseChangeRequestUrl(pr.url)?.link;
      if (parsed === undefined || parsed.number !== pr.number) return Effect.void;
      const key = normalizeThreadPullRequestKey(parsed);
      const id = threadPullRequestKeyOf(key);
      const previous = lookupStates.get(id);
      lookupStates.delete(id);
      if (lookupStates.size >= PR_LOOKUP_CACHE_CAPACITY) {
        const oldest = lookupStates.keys().next().value;
        if (oldest !== undefined) lookupStates.delete(oldest);
      }
      lookupStates.set(id, { state: pr.state, isDraft: pr.isDraft === true });
      return (previous?.state ?? "open") === pr.state &&
        (previous?.isDraft === true) === (pr.isDraft === true)
        ? Effect.void
        : PubSub.publish(pullRequestStateChanges, key);
    });

  const lastKnownPrByBranchKey = new Map<string, LastKnownPr>();

  const readConfigValueNullable = (cwd: string, key: string) =>
    gitCore.readConfigValue(cwd, key).pipe(Effect.orElseSucceed(() => null));

  // Whether the remote's host creates change requests in the only remote. A host's tools can let
  // configuration outside the remotes name another repository; the remote itself otherwise.

  const targetsOnlyRemote = Effect.fn("targetsOnlyRemote")(function* (
    cwd: string,
    remoteName: string,
    remote: { readonly remoteUrl: string | null; readonly repositoryNameWithOwner: string | null },
  ) {
    const provider =
      remote.remoteUrl === null ? null : sourceControlDefinitions.recognizeRemote(remote.remoteUrl);
    if (remote.remoteUrl === null || provider === null) return true;
    const context = { provider, remoteName, remoteUrl: remote.remoteUrl };
    const handle = yield* sourceControlProviders
      .resolveHandle({ cwd, context })
      .pipe(Effect.orElseSucceed(() => null));
    const createsChangeRequestsIn = handle?.provider.createsChangeRequestsIn;
    if (createsChangeRequestsIn === undefined) return true;
    return yield* createsChangeRequestsIn({
      cwd,
      context: handle?.context ?? context,
      repository: remote.repositoryNameWithOwner,
    });
  });

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

  const resolveBaseRangeRef = Effect.fn("resolveBaseRangeRef")(function* (
    cwd: string,
    baseBranch: string,
  ) {
    if (baseBranch.startsWith("refs/")) return baseBranch;
    const remoteName = yield* gitCore
      .resolvePrimaryRemoteName(cwd)
      .pipe(Effect.orElseSucceed(() => null));
    if (!remoteName) return baseBranch;

    return yield* gitCore
      .resolveRemoteTrackingCommit({
        cwd,
        refName: baseBranch,
        fallbackRemoteName: remoteName,
      })
      .pipe(
        Effect.map((resolved) => resolved.commitSha),
        Effect.orElseSucceed(() => baseBranch),
      );
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

  const changeRequestTermsFor = Effect.fn("GitManager.changeRequestTermsFor")(function* (
    cwd: string,
  ) {
    return yield* sourceControlProvider(cwd).pipe(
      Effect.map((provider) => sourceControlDefinitions.get(provider.kind).changeRequest),
      Effect.orElseSucceed(() => UNKNOWN_SOURCE_CONTROL_CLIENT.changeRequest),
    );
  });

  const shareBranchBase = Effect.fn("GitManager.shareBranchBase")(function* (
    cwd: string,
    branch: string,
  ) {
    const baseBranch = yield* gitCore
      .readBranchBase(cwd, branch)
      .pipe(Effect.orElseSucceed(() => null));
    if (baseBranch === null) return;
    const provider = yield* sourceControlProvider(cwd).pipe(Effect.orElseSucceed(() => null));
    yield* provider?.recordBranchBase?.({ cwd, branch, baseBranch }) ?? Effect.void;
  });
  // Publishing a branch that tracks its base records that base first, even when the push then
  // fails, so the host hears of it after every successful push rather than the first attempt.

  const resolveStylePolicy = Effect.fn("GitManager.resolveStylePolicy")(function* (
    cwd: string,
    settings: SourceControlTextGenerationSettings,
  ) {
    switch (settings.style.mode) {
      case "conventional_commits":
        return conventionalCommitsTextGenerationPolicy;
      case "custom":
        return customTextGenerationPolicy(
          settings.style.customInstructions
            ? {
                commitInstructions: settings.style.customInstructions,
                changeRequestInstructions: settings.style.customInstructions,
              }
            : {},
        );
      case "repo_conventions": {
        const subjects = yield* readRecentCommitSubjects(cwd);
        const agentInstructions = yield* readRepositoryInstructions(cwd, "AGENTS.md");
        const isClaudeWriter =
          settings.modelSelection.instanceId === "claudeAgent" ||
          (yield* providerRegistry.getProviders).some(
            (provider) =>
              provider.instanceId === settings.modelSelection.instanceId &&
              provider.driver === "claudeAgent",
          );
        const claudeInstructions = isClaudeWriter
          ? yield* readRepositoryInstructions(cwd, "CLAUDE.md")
          : "";
        const examples = [
          ...(subjects.length > 0
            ? [["Recent commit subjects from this repository:", ...subjects].join("\n")]
            : []),
          ...(agentInstructions ? [`Local AGENTS.md:\n${agentInstructions}`] : []),
          // CLAUDE.md is often a symlink or copy of AGENTS.md; skip the duplicate.
          ...(claudeInstructions && claudeInstructions !== agentInstructions
            ? [`Local CLAUDE.md:\n${claudeInstructions}`]
            : []),
        ].join("\n\n");
        if (!examples) {
          return repositoryConventionsTextGenerationPolicy;
        }
        return {
          ...repositoryConventionsTextGenerationPolicy,
          commitInstructions: `${repositoryConventionsTextGenerationPolicy.commitInstructions}\n\n${examples}`,
          changeRequestInstructions: `${repositoryConventionsTextGenerationPolicy.changeRequestInstructions}\n\n${examples}`,
        };
      }
    }
  });

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

  const changeRequestHeadRef = Effect.fn("GitManager.changeRequestHeadRef")(function* (
    cwd: string,
    number: number,
  ) {
    const provider = yield* sourceControlProvider(cwd);
    const ref = sourceControlDefinitions.get(provider.kind).changeRequestHeadRef?.(number);
    if (ref === undefined) {
      return yield* new GitManagerError({
        operation: "changeRequestHeadRef",
        cwd,
        detail: "This host publishes no ref for a change request's head.",
      });
    }
    return ref;
  });

  const normalizeStatusCacheKey = canonicalizeExistingPath;

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
  ): LastKnownPr | null => {
    const lastKnown = lastKnownPrByBranchKey.get(branchKey);
    if (!lastKnown) return null;
    if (lastKnown.headBranch !== current.headBranch) {
      return null;
    }

    // Config read failures become null; require both remote URLs before treating a mismatch as real.
    if (lastKnown.headRemoteUrlKey !== null && current.headRemoteUrlKey !== null) {
      return lastKnown.headRemoteUrlKey === current.headRemoteUrlKey ? lastKnown : null;
    }

    if (
      lastKnown.upstreamRef !== null &&
      current.upstreamRef !== null &&
      lastKnown.remoteName !== null &&
      current.remoteName !== null
    ) {
      return lastKnown.remoteName === current.remoteName ? lastKnown : null;
    }
    return lastKnown;
  };

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

    const provider = remoteUrl ? sourceControlDefinitions.recognizeRemote(remoteUrl) : null;
    if (!remoteUrl || provider?.kind !== "unknown") return provider;
    const handle = yield* sourceControlProviders
      .resolveHandle({
        cwd,
        context: { provider, remoteName: preferredRemoteName, remoteUrl },
      })
      .pipe(Effect.orElseSucceed(() => null));
    return handle?.context?.provider ?? provider;
  });

  const resolveRemoteRepositoryContext = Effect.fn("resolveRemoteRepositoryContext")(function* (
    cwd: string,
    remoteName: string | null,
  ) {
    if (!remoteName) {
      return {
        remoteUrl: null,
        remoteUrlKey: null,
        repositoryNameWithOwner: null,
        ownerLogin: null,
      };
    }

    const remoteUrl = yield* readConfigValueNullable(cwd, `remote.${remoteName}.url`);
    let repositoryNameWithOwner = parseRepositoryNameWithOwnerFromRemoteUrl(remoteUrl);
    if (
      remoteUrl !== null &&
      /^https?:\/\//iu.test(remoteUrl) &&
      (repositoryNameWithOwner?.split("/").length ?? 0) > 2
    ) {
      const kind = sourceControlDefinitions.recognizeRemote(remoteUrl)?.kind;
      const provider =
        kind === undefined
          ? undefined
          : yield* (
              kind === "unknown" ? sourceControlProvider(cwd) : sourceControlProviders.get(kind)
            ).pipe(Effect.orElseSucceed(() => undefined));
      repositoryNameWithOwner = parseRepositoryNameWithOwnerFromRemoteUrl(remoteUrl, provider);
    }
    return {
      remoteUrl,
      remoteUrlKey: remoteUrl ? sourceControlDefinitions.repositoryKeyFromRemote(remoteUrl) : null,
      repositoryNameWithOwner,
      ownerLogin: parseRepositoryOwnerLogin(repositoryNameWithOwner),
    };
  });
  return {
    gitCore,
    sourceControlProviders,
    textGeneration,
    providerRegistry,
    projectSetupScriptRunner,
    random,
    fileSystem,
    path,
    serverSettingsService,
    threads,
    projects,
    pullRequestHostOptions,
    tempDir,
    nonRepositoryStatusDetails,
    prLookupEpochByCwd,
    prLookupFailureStreakByKey,
    pullRequestStateChanges,
    lookupStates,
    // type LastKnownPr
    prLookupGitStateByKey,
    settledPrLookupByBranchKey,
    asUserAction,
    sourceControlProvider,
    projectSettingsFor,
    readThreadContext,
    readWorktreesDirectory,
    readRepositoryInstructions,
    readRecentCommitSubjects,
    randomUUIDv4,
    canonicalizeExistingPath,
    prLookupEpoch,
    nextPrLookupFailureTtl,
    noteLookupState,
    lastKnownPrByBranchKey,
    readConfigValueNullable,
    targetsOnlyRemote,
    findRemoteTrackingRemote,
    resolveBaseRangeRef,
    ensureNoTrackedChanges,
    moveToPullRequestHead,
    changeRequestTermsFor,
    shareBranchBase,
    resolveStylePolicy,
    createProgressEmitter,
    configurePullRequestHeadUpstreamBase,
    changeRequestHeadRef,
    normalizeStatusCacheKey,
    prLookupCacheKey,
    rememberLastKnownPr,
    resolveLastKnownPr,
    resolveHostingProvider,
    resolveRemoteRepositoryContext,
  };
});
