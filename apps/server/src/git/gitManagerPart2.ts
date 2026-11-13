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

import { GitManagerError, GitPullRequestMaterializationError } from "@t3tools/contracts";
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
import { COMMIT_TIMEOUT_MS, GitManager, PR_LOOKUP_CACHE_CAPACITY, PR_LOOKUP_CACHE_TTL, PR_LOOKUP_NO_OPEN_PR_CACHE_TTL, appendUnique, limitContext, resolveHeadRepositoryNameWithOwner, sanitizeProgressText, summarizeGitActionResult, type SuccessOf } from "./GitManager.ts";
import type { BranchHeadContext, CommitAndBranchSuggestion, GitActionProgressEmitter, GitActionProgressPayload, GitActionProgressReporter, PullRequestHeadRemoteInfo, PullRequestInfo, ResolvedPullRequest, SourceControlTextGenerationSettings } from "./GitManager.ts";
import { install0 } from "./gitManagerPart0.ts";
import { install1 } from "./gitManagerPart1.ts";

export type Deps = SuccessOf<typeof install0> & SuccessOf<typeof install1>;

export const install2 = Effect.fn("gitManager.install2")(function* (d: Deps) {
  const { changeRequestTermsFor, fetchChangeRequestHeadIntoBranch, fileSystem, findLatestPrForHeadContext, findOpenPr, findPublishedBranchRemote, findRemoteTrackingRemote, gitCore, isUnpublishedBranch, localStatusResultCache, materializePullRequestHeadBranchBase, nextPrLookupFailureTtl, normalizeStatusCacheKey, noteLookupState, path, prLookupFailureStreakByKey, randomUUIDv4, readConfigValueNullable, readPrLookupBranchRef, readThreadContext, resolveBaseRangeRef, resolveCommitAndBranchSuggestion, resolveHeadAndOriginContexts, resolvePrBase, resolveStylePolicy, sourceControlProvider, targetsOnlyRemote, tempDir, textGeneration } = d;
  const resolveBranchHeadContext = Effect.fn("resolveBranchHeadContext")(function* (
    cwd: string,
    details: { branch: string; upstreamRef: string | null; remoteName?: string },
  ) {
    const remoteName =
      details.remoteName ??
      (yield* readConfigValueNullable(cwd, `branch.${details.branch}.remote`));
    const headBranchFromUpstream = details.upstreamRef
      ? extractBranchNameFromRemoteRef(details.upstreamRef, { remoteName })
      : "";
    const headBranch = headBranchFromUpstream.length > 0 ? headBranchFromUpstream : details.branch;
    const shouldProbeLocalBranchSelector =
      headBranchFromUpstream.length === 0 || headBranch === details.branch;

    const [remoteRepository, originRepository] = yield* resolveHeadAndOriginContexts(
      cwd,
      remoteName,
    );

    // With no origin to compare against, the only remote is the repository change requests
    // are created in unless the host's own configuration names another, so a branch on it is
    // not a fork. With several remotes, or with that other target, it may still be a fork.
    const isOnlyRemote =
      remoteName !== null &&
      remoteName !== "origin" &&
      originRepository.remoteUrlKey === null &&
      (yield* gitCore
        .execute({
          operation: "GitManager.resolveBranchHeadContext.remotes",
          cwd,
          args: ["remote"],
          timeoutMs: 5_000,
        })
        .pipe(
          Effect.map(
            (result) => result.stdout.split("\n").filter((name) => name.trim().length > 0).length,
          ),
          Effect.orElseSucceed(() => 0),
        )) === 1 &&
      (yield* targetsOnlyRemote(cwd, remoteName, remoteRepository));
    const isForeignRemote = remoteName !== null && remoteName !== "origin" && !isOnlyRemote;

    const isCrossRepository =
      remoteRepository.repositoryNameWithOwner !== null &&
      originRepository.repositoryNameWithOwner !== null
        ? remoteRepository.repositoryNameWithOwner.toLowerCase() !==
          originRepository.repositoryNameWithOwner.toLowerCase()
        : isForeignRemote && remoteRepository.repositoryNameWithOwner !== null;

    const ownerHeadSelector =
      remoteRepository.ownerLogin && headBranch.length > 0
        ? `${remoteRepository.ownerLogin}:${headBranch}`
        : null;
    const remoteAliasHeadSelector =
      remoteName && headBranch.length > 0 ? `${remoteName}:${headBranch}` : null;
    const shouldProbeRemoteOwnedSelectors = isCrossRepository || isForeignRemote;

    const headSelectors: string[] = [];
    if (isCrossRepository && shouldProbeRemoteOwnedSelectors) {
      appendUnique(headSelectors, ownerHeadSelector);
      appendUnique(
        headSelectors,
        remoteAliasHeadSelector !== ownerHeadSelector ? remoteAliasHeadSelector : null,
      );
    }
    if (shouldProbeLocalBranchSelector) {
      appendUnique(headSelectors, details.branch);
    }
    appendUnique(headSelectors, headBranch !== details.branch ? headBranch : null);
    if (!isCrossRepository && shouldProbeRemoteOwnedSelectors) {
      appendUnique(headSelectors, ownerHeadSelector);
      appendUnique(
        headSelectors,
        remoteAliasHeadSelector !== ownerHeadSelector ? remoteAliasHeadSelector : null,
      );
    }

    return {
      localBranch: details.branch,
      headBranch,
      headSelectors,
      preferredHeadSelector:
        ownerHeadSelector && isCrossRepository ? ownerHeadSelector : headBranch,
      remoteName,
      headRemoteUrlKey:
        remoteRepository.remoteUrlKey ??
        (remoteName === null ? originRepository.remoteUrlKey : null),
      targetRemoteUrlKey: originRepository.remoteUrlKey,
      headRepositoryNameWithOwner: remoteRepository.repositoryNameWithOwner,
      headRepositoryOwnerLogin: remoteRepository.ownerLogin,
      isCrossRepository,
    } satisfies BranchHeadContext;
  });

  // Remote names can contain slashes; match refs literally.

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
      suggestion = yield* resolveCommitAndBranchSuggestion({
        cwd,
        branch,
        ...(commitMessage ? { commitMessage } : {}),
        ...(filePaths ? { filePaths } : {}),
        settings,
      });
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

  const readSettledPrLookupFingerprint = (cacheCwd: string, branch: string) =>
    Effect.all(
      [
        readPrLookupBranchRef(cacheCwd, branch, true),
        gitCore
          .execute({
            operation: "GitManager.branchPullRequest.remoteUrls",
            cwd: cacheCwd,
            args: ["config", "--get-regexp", "^remote\\..*\\.url$"],
            allowNonZeroExit: true,
          })
          .pipe(Effect.map((result) => result.stdout)),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map((parts) => parts.join("\u0000")));

  const runFeatureBranchStep = Effect.fn("runFeatureBranchStep")(function* (
    settings: SourceControlTextGenerationSettings,
    cwd: string,
    branch: string | null,
    commitMessage?: string,
    filePaths?: readonly string[],
  ) {
    const suggestion = yield* resolveCommitAndBranchSuggestion({
      cwd,
      branch,
      ...(commitMessage ? { commitMessage } : {}),
      ...(filePaths ? { filePaths } : {}),
      includeBranch: true,
      settings,
    });
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

  const materializePullRequestHeadBranch = (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    localBranch = pullRequest.headBranch,
  ) =>
    materializePullRequestHeadBranchBase(cwd, pullRequest, localBranch).pipe(
      Effect.catch((primaryCause) =>
        fetchChangeRequestHeadIntoBranch(cwd, pullRequest.number, localBranch).pipe(
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

  const invalidateLocalStatusResultCache = (cwd: string) =>
    normalizeStatusCacheKey(cwd).pipe(
      Effect.flatMap((cacheKey) => Cache.invalidate(localStatusResultCache, cacheKey)),
    );

  const resolveLookupHeadContext = Effect.fn("resolveLookupHeadContext")(function* (
    cwd: string,
    details: {
      branch: string;
      upstreamRef: string | null;
      defaultBranch: string | null;
      remoteName?: string;
    },
  ) {
    const headContext = yield* resolveBranchHeadContext(cwd, details);
    if (details.upstreamRef === null) {
      const remoteName = yield* findPublishedBranchRemote(cwd, details.branch).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (remoteName !== null && remoteName !== headContext.remoteName) {
        return {
          headContext: yield* resolveBranchHeadContext(cwd, { ...details, remoteName }),
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
    const ownNameContext = yield* resolveBranchHeadContext(cwd, {
      branch: details.branch,
      upstreamRef: null,
      remoteName,
    });
    return { headContext: ownNameContext, lookup: true };
  });

  const buildCompletionToast = Effect.fn("buildCompletionToast")(function* (
    cwd: string,
    result: Pick<GitRunStackedActionResult, "action" | "branch" | "commit" | "push" | "pr">,
  ) {
    const terms = yield* changeRequestTermsFor(cwd);
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
      latestOpenPr = yield* resolveBranchHeadContext(cwd, {
        branch: finalBranchContext.branch,
        upstreamRef: finalBranchContext.upstreamRef,
      }).pipe(
        Effect.flatMap((headContext) => findOpenPr(cwd, headContext)),
        Effect.orElseSucceed(() => null),
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

  const runPrStep = Effect.fn("runPrStep")(function* (
    settings: SourceControlTextGenerationSettings,
    cwd: string,
    fallbackBranch: string | null,
    threadId: ThreadId | undefined,
    emit: GitActionProgressEmitter,
  ) {
    const provider = yield* sourceControlProvider(cwd);
    const terms = sourceControlDefinitions.get(provider.kind).changeRequest;
    const details = yield* gitCore.statusDetails(cwd);
    const branch = details.branch ?? fallbackBranch;
    if (!branch) {
      return yield* new GitManagerError({
        operation: "runPrStep",
        cwd,
        detail: "Cannot create a pull request from detached HEAD.",
      });
    }
    if (!details.hasUpstream) {
      return yield* new GitManagerError({
        operation: "runPrStep",
        cwd,
        detail: "Current branch has not been pushed. Push before creating a PR.",
      });
    }

    const headContext = yield* resolveBranchHeadContext(cwd, {
      branch,
      upstreamRef: details.upstreamRef,
    });

    const existing = yield* findOpenPr(cwd, headContext);
    if (existing) {
      return {
        status: "opened_existing" as const,
        url: existing.url,
        number: existing.number,
        baseBranch: existing.baseRefName,
        headBranch: existing.headRefName,
        title: existing.title,
      };
    }

    const { baseBranch, baseRef } = yield* resolvePrBase(
      cwd,
      branch,
      details.upstreamRef,
      headContext,
    );
    yield* emit({
      kind: "phase_started",
      phase: "pr",
      label: `Generating ${terms.shortLabel} content...`,
    });
    const baseRangeRef = yield* resolveBaseRangeRef(cwd, baseRef);
    const rangeContext = yield* gitCore.readRangeContext(cwd, baseRangeRef);
    const policy = yield* resolveStylePolicy(cwd, settings);
    const changeRequestTemplate =
      settings.style.followChangeRequestTemplates && provider.readChangeRequestTemplate
        ? Option.getOrUndefined(
            yield* provider.readChangeRequestTemplate({ cwd, treeish: baseRangeRef }),
          )
        : undefined;
    const threadContext = yield* readThreadContext(threadId);

    const generated = yield* textGeneration.generatePrContent({
      cwd,
      baseBranch,
      headBranch: headContext.headBranch,
      commitSummary: limitContext(rangeContext.commitSummary, 20_000),
      diffSummary: limitContext(rangeContext.diffSummary, 20_000),
      diffPatch: limitContext(rangeContext.diffPatch, 60_000),
      ...(changeRequestTemplate ? { changeRequestTemplate } : {}),
      ...(threadContext ? { threadContext } : {}),
      ...(policy ? { policy } : {}),
      modelSelection: settings.modelSelection,
    });

    const bodyFile = path.join(
      tempDir,
      `t3code-pr-body-${process.pid}-${yield* randomUUIDv4(cwd)}.md`,
    );
    yield* fileSystem.writeFileString(bodyFile, generated.body).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation: "runPrStep",
            cwd,
            detail: "Failed to write pull request body temp file.",
            cause,
          }),
      ),
    );
    yield* emit({
      kind: "phase_started",
      phase: "pr",
      label: `Creating ${terms.singular}...`,
    });
    yield* provider
      .createChangeRequest({
        cwd,
        baseRefName: baseBranch,
        headSelector: headContext.preferredHeadSelector,
        title: generated.title,
        bodyFile,
      })
      .pipe(Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.ignore)));

    // The PR already exists at this point, so a failed lookup only loses its metadata.
    const created = yield* findOpenPr(cwd, headContext).pipe(
      Effect.catch((error) =>
        Effect.logWarning("GitManager.runPrStep lookup after create failed", {
          provider: provider.kind,
          errorTag: error._tag,
        }).pipe(Effect.as(null)),
      ),
    );
    if (!created) {
      return {
        status: "created" as const,
        baseBranch,
        headBranch: headContext.headBranch,
        title: generated.title,
      };
    }

    return {
      status: "created" as const,
      url: created.url,
      number: created.number,
      baseBranch: created.baseRefName,
      headBranch: created.headRefName,
      title: created.title,
    };
  });

  const localStatus: GitManager["Service"]["localStatus"] = Effect.fn("localStatus")(
    function* (input) {
      const cacheKey = yield* normalizeStatusCacheKey(input.cwd);
      return yield* Cache.get(localStatusResultCache, cacheKey);
    },
  );

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
  return {
    resolveBranchHeadContext,
    runCommitStep,
    readSettledPrLookupFingerprint,
    runFeatureBranchStep,
    materializePullRequestHeadBranch,
    invalidateLocalStatusResultCache,
    resolveLookupHeadContext,
    buildCompletionToast,
    runPrStep,
    localStatus,
    prLookupCache,
  };
});
