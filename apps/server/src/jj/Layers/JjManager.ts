import { randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { Effect, Layer, Ref } from "effect";
import {
  GitActionProgressEvent,
  GitActionProgressPhase,
  GitRunStackedActionResult,
  GitStackedAction,
  ModelSelection,
} from "@t3tools/contracts";
import {
  resolveAutoFeatureBranchName,
  sanitizeBranchFragment,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/vcs";

import {
  type GitManagerShape,
  type GitRunStackedActionOptions,
} from "../../git/Services/GitManager.ts";
import { GitHubCli } from "../../git/Services/GitHubCli.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ProjectSetupScriptRunner } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { JjCore } from "../Services/JjCore.ts";
import { JjManager, type JjManagerShape } from "../Services/JjManager.ts";
import {
  branchConfigKey,
  canonicalizePath,
  parseMergeRefBranchName,
  resolveJjRoot,
} from "../Utils.ts";
import { GitManagerError } from "@t3tools/contracts";

const SHORT_SHA_LENGTH = 7;

function jjManagerError(operation: string, detail: string, cause?: unknown): GitManagerError {
  return new GitManagerError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function shortenSha(sha: string | undefined): string | null {
  if (!sha) return null;
  return sha.slice(0, SHORT_SHA_LENGTH);
}

function isCommitAction(
  action: GitStackedAction,
): action is "commit" | "commit_push" | "commit_push_pr" {
  return action === "commit" || action === "commit_push" || action === "commit_push_pr";
}

function formatCommitMessage(subject: string, body: string): string {
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    return subject;
  }
  return `${subject}\n\n${trimmedBody}`;
}

function parseCustomCommitMessage(raw: string): { subject: string; body: string } | null {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return null;
  }

  const [firstLine, ...rest] = normalized.split("\n");
  const subject = firstLine?.trim() ?? "";
  if (subject.length === 0) {
    return null;
  }

  return {
    subject,
    body: rest.join("\n").trim(),
  };
}

function sanitizeCommitMessage(generated: {
  subject: string;
  body: string;
  branch?: string | undefined;
}) {
  const rawSubject = generated.subject.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const subject = rawSubject.replace(/[.]+$/g, "").trim();
  const safeSubject = subject.length > 0 ? subject.slice(0, 72).trimEnd() : "Update project files";
  return {
    subject: safeSubject,
    body: generated.body.trim(),
    ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
  };
}

function limitContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

interface CommitAndBranchSuggestion {
  subject: string;
  body: string;
  branch?: string | undefined;
  commitMessage: string;
}

interface ResolvedPullRequest {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  state: "open" | "closed" | "merged";
}

interface PullRequestHeadRemoteInfo {
  isCrossRepository?: boolean;
  headRepositoryNameWithOwner?: string | null;
  headRepositoryOwnerLogin?: string | null;
}

function normalizePullRequestReference(reference: string): string {
  const trimmed = reference.trim();
  const hashNumber = /^#(\d+)$/.exec(trimmed);
  return hashNumber?.[1] ?? trimmed;
}

function parseRepositoryNameFromPullRequestUrl(url: string): string | null {
  const trimmed = url.trim();
  const match = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/\d+(?:\/.*)?$/i.exec(trimmed);
  const repositoryName = match?.[1]?.trim() ?? "";
  return repositoryName.length > 0 ? repositoryName : null;
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

function resolvePullRequestWorktreeLocalBranchName(
  pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
): string {
  if (!pullRequest.isCrossRepository) {
    return pullRequest.headBranch;
  }

  const sanitizedHeadBranch = sanitizeBranchFragment(pullRequest.headBranch).trim();
  const suffix = sanitizedHeadBranch.length > 0 ? sanitizedHeadBranch : "head";
  return `t3code/pr-${pullRequest.number}/${suffix}`;
}

function shouldPreferSshRemote(url: string | null): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  return trimmed.startsWith("git@") || trimmed.startsWith("ssh://");
}

function toResolvedPullRequest(pr: {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  state?: "open" | "closed" | "merged";
}): ResolvedPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    state: pr.state ?? "open",
  };
}

function toPullRequestHeadRemoteInfo(pr: {
  isCrossRepository?: boolean;
  headRepositoryNameWithOwner?: string | null;
  headRepositoryOwnerLogin?: string | null;
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

type StripProgressContext<T> = T extends any ? Omit<T, "actionId" | "cwd" | "action"> : never;
type GitActionProgressPayload = StripProgressContext<GitActionProgressEvent>;

export const makeJjManager = Effect.fn("makeJjManager")(function* () {
  const jjCore = yield* JjCore;
  const gitHubCli = yield* GitHubCli;
  const textGeneration = yield* TextGeneration;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
  const serverSettingsService = yield* ServerSettingsService;

  const createProgressEmitter = (
    input: { cwd: string; action: GitStackedAction },
    options?: GitRunStackedActionOptions,
  ) => {
    const actionId = options?.actionId ?? randomUUID();
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
  };

  const resolveHeadSelectorBranch = Effect.fn("resolveHeadSelectorBranch")(function* (
    cwd: string,
    branch: string,
  ) {
    const mergeRef = yield* jjCore
      .readConfigValue(cwd, branchConfigKey(branch, "merge"))
      .pipe(Effect.catch(() => Effect.succeed(null)));
    return parseMergeRefBranchName(mergeRef) ?? branch;
  });

  const configurePullRequestHeadUpstreamBase = Effect.fn("configurePullRequestHeadUpstream")(
    function* (
      cwd: string,
      pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
      localBranch = pullRequest.headBranch,
    ) {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";
      if (repositoryNameWithOwner.length === 0) {
        return;
      }

      const workspaceRoot = yield* resolveJjRoot(cwd);
      const cloneUrls = yield* gitHubCli.getRepositoryCloneUrls({
        cwd: workspaceRoot,
        repository: repositoryNameWithOwner,
      });
      const originRemoteUrl = yield* jjCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* jjCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
      });

      yield* jjCore.setBranchUpstream({
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
        Effect.logWarning(
          `JjManager.configurePullRequestHeadUpstream: failed to configure upstream for ${localBranch} -> ${pullRequest.headBranch} in ${cwd}: ${error.message}`,
        ).pipe(Effect.asVoid),
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
        yield* jjCore.fetchPullRequestBranch({
          cwd,
          prNumber: pullRequest.number,
          branch: localBranch,
          remoteBranch: pullRequest.headBranch,
        });
        return;
      }

      const workspaceRoot = yield* resolveJjRoot(cwd);
      const cloneUrls = yield* gitHubCli.getRepositoryCloneUrls({
        cwd: workspaceRoot,
        repository: repositoryNameWithOwner,
      });
      const originRemoteUrl = yield* jjCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* jjCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
      });

      yield* jjCore.fetchRemoteBranch({
        cwd,
        remoteName,
        remoteBranch: pullRequest.headBranch,
        localBranch,
      });
      yield* jjCore.setBranchUpstream({
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
      Effect.catch((error) =>
        (resolveHeadRepositoryNameWithOwner(pullRequest) ?? "").length > 0
          ? Effect.fail(error)
          : jjCore.fetchPullRequestBranch({
              cwd,
              prNumber: pullRequest.number,
              branch: localBranch,
              remoteBranch: pullRequest.headBranch,
            }),
      ),
    );

  const resolveCommitAndBranchSuggestion = Effect.fn("resolveCommitAndBranchSuggestion")(
    function* (input: {
      cwd: string;
      branch: string | null;
      commitMessage?: string;
      includeBranch?: boolean;
      filePaths?: readonly string[];
      modelSelection: ModelSelection;
    }) {
      const context = yield* jjCore.prepareCommitContext(input.cwd, input.filePaths);
      if (!context) {
        return null;
      }

      const customCommit = parseCustomCommitMessage(input.commitMessage ?? "");
      if (customCommit) {
        return {
          subject: customCommit.subject,
          body: customCommit.body,
          ...(input.includeBranch
            ? { branch: sanitizeFeatureBranchName(customCommit.subject) }
            : {}),
          commitMessage: formatCommitMessage(customCommit.subject, customCommit.body),
        } satisfies CommitAndBranchSuggestion;
      }

      const generated = yield* textGeneration
        .generateCommitMessage({
          cwd: input.cwd,
          branch: input.branch,
          stagedSummary: limitContext(context.stagedSummary, 8_000),
          stagedPatch: limitContext(context.stagedPatch, 50_000),
          ...(input.includeBranch ? { includeBranch: true } : {}),
          modelSelection: input.modelSelection,
        })
        .pipe(Effect.map((result) => sanitizeCommitMessage(result)));

      return {
        subject: generated.subject,
        body: generated.body,
        ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
        commitMessage: formatCommitMessage(generated.subject, generated.body),
      } satisfies CommitAndBranchSuggestion;
    },
  );

  const findOpenPr = Effect.fn("findOpenPr")(function* (cwd: string, headSelector: string) {
    const workspaceRoot = yield* resolveJjRoot(cwd);
    const pullRequests = yield* gitHubCli.listOpenPullRequests({
      cwd: workspaceRoot,
      headSelector,
      limit: 1,
    });

    return pullRequests[0] ?? null;
  });

  const status: JjManagerShape["status"] = Effect.fn("status")(function* (input) {
    const current = yield* jjCore.status(input);
    if (!current.isRepo || !current.branch || !current.hasOriginRemote) {
      return current;
    }

    const headSelector = yield* resolveHeadSelectorBranch(input.cwd, current.branch);
    const pullRequest = yield* findOpenPr(input.cwd, headSelector).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );

    return {
      ...current,
      pr: pullRequest
        ? {
            number: pullRequest.number,
            title: pullRequest.title,
            url: pullRequest.url,
            baseBranch: pullRequest.baseRefName,
            headBranch: pullRequest.headRefName,
            state: pullRequest.state ?? "open",
          }
        : null,
    };
  });

  const resolvePullRequest: JjManagerShape["resolvePullRequest"] = Effect.fn("resolvePullRequest")(
    function* (input) {
      const workspaceRoot = yield* resolveJjRoot(input.cwd);
      const pullRequest = yield* gitHubCli.getPullRequest({
        cwd: workspaceRoot,
        reference: normalizePullRequestReference(input.reference),
      });

      return {
        pullRequest: toResolvedPullRequest(pullRequest),
      };
    },
  );

  const preparePullRequestThread: JjManagerShape["preparePullRequestThread"] = Effect.fn(
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
            Effect.logWarning(
              `JjManager.preparePullRequestThread: failed to launch worktree setup script for thread ${input.threadId} in ${worktreePath}: ${error.message}`,
            ).pipe(Effect.asVoid),
          ),
        );
    };

    const normalizedReference = normalizePullRequestReference(input.reference);
    const workspaceRoot = yield* resolveJjRoot(input.cwd);
    const rootWorktreePath = canonicalizePath(workspaceRoot);
    const pullRequestSummary = yield* gitHubCli.getPullRequest({
      cwd: workspaceRoot,
      reference: normalizedReference,
    });
    const pullRequest = toResolvedPullRequest(pullRequestSummary);
    const pullRequestWithRemoteInfo = {
      ...pullRequest,
      ...toPullRequestHeadRemoteInfo(pullRequestSummary),
    } as const;
    const localPullRequestBranch = pullRequestWithRemoteInfo.isCrossRepository
      ? resolvePullRequestWorktreeLocalBranchName(pullRequestWithRemoteInfo)
      : pullRequest.headBranch;

    if (input.mode === "local") {
      const existingLocalBranchNames = yield* jjCore
        .listLocalBranchNames(workspaceRoot)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])));
      if (!existingLocalBranchNames.includes(localPullRequestBranch)) {
        yield* materializePullRequestHeadBranch(
          workspaceRoot,
          pullRequestWithRemoteInfo,
          localPullRequestBranch,
        );
      }
      yield* Effect.scoped(
        jjCore.checkoutBranch({
          cwd: workspaceRoot,
          branch: localPullRequestBranch,
        }),
      );
      const details = yield* jjCore.statusDetails(workspaceRoot);
      yield* configurePullRequestHeadUpstream(
        workspaceRoot,
        pullRequestWithRemoteInfo,
        details.branch ?? localPullRequestBranch,
      );

      return {
        pullRequest,
        branch: details.branch ?? localPullRequestBranch,
        worktreePath: null,
      };
    }

    const ensureExistingWorktreeUpstream = Effect.fn("ensureExistingWorktreeUpstream")(function* (
      worktreePath: string,
    ) {
      const details = yield* jjCore.statusDetails(worktreePath);
      yield* configurePullRequestHeadUpstream(
        worktreePath,
        pullRequestWithRemoteInfo,
        details.branch ?? pullRequest.headBranch,
      );
    });

    const findLocalHeadBranch = (cwd: string) =>
      jjCore.listBranches({ cwd }).pipe(
        Effect.map((result) => {
          const localBranch = result.branches.find(
            (branch) => !branch.isRemote && branch.name === localPullRequestBranch,
          );
          if (localBranch) {
            return localBranch;
          }
          if (localPullRequestBranch === pullRequest.headBranch) {
            return null;
          }
          return (
            result.branches.find(
              (branch) =>
                !branch.isRemote &&
                branch.name === pullRequest.headBranch &&
                branch.worktreePath !== null &&
                canonicalizePath(branch.worktreePath) !== rootWorktreePath,
            ) ?? null
          );
        }),
      );

    const existingBranchBeforeFetch = yield* findLocalHeadBranch(input.cwd);
    const existingBranchBeforeFetchPath = existingBranchBeforeFetch?.worktreePath
      ? canonicalizePath(existingBranchBeforeFetch.worktreePath)
      : null;
    if (
      existingBranchBeforeFetch?.worktreePath &&
      existingBranchBeforeFetchPath !== rootWorktreePath
    ) {
      yield* ensureExistingWorktreeUpstream(existingBranchBeforeFetch.worktreePath);
      return {
        pullRequest,
        branch: localPullRequestBranch,
        worktreePath: existingBranchBeforeFetch.worktreePath,
      };
    }
    if (existingBranchBeforeFetchPath === rootWorktreePath) {
      return yield* jjManagerError(
        "preparePullRequestThread",
        "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
      );
    }

    yield* materializePullRequestHeadBranch(
      input.cwd,
      pullRequestWithRemoteInfo,
      localPullRequestBranch,
    );

    const existingBranchAfterFetch = yield* findLocalHeadBranch(input.cwd);
    const existingBranchAfterFetchPath = existingBranchAfterFetch?.worktreePath
      ? canonicalizePath(existingBranchAfterFetch.worktreePath)
      : null;
    if (
      existingBranchAfterFetch?.worktreePath &&
      existingBranchAfterFetchPath !== rootWorktreePath
    ) {
      yield* ensureExistingWorktreeUpstream(existingBranchAfterFetch.worktreePath);
      return {
        pullRequest,
        branch: localPullRequestBranch,
        worktreePath: existingBranchAfterFetch.worktreePath,
      };
    }
    if (existingBranchAfterFetchPath === rootWorktreePath) {
      return yield* jjManagerError(
        "preparePullRequestThread",
        "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
      );
    }

    const worktree = yield* jjCore.createWorktree({
      cwd: input.cwd,
      branch: localPullRequestBranch,
      path: null,
    });
    yield* ensureExistingWorktreeUpstream(worktree.worktree.path);
    yield* maybeRunSetupScript(worktree.worktree.path);

    return {
      pullRequest,
      branch: worktree.worktree.branch,
      worktreePath: worktree.worktree.path,
    };
  });

  const runFeatureBranchStep = Effect.fn("runFeatureBranchStep")(function* (
    modelSelection: ModelSelection,
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
      modelSelection,
    });
    if (!suggestion) {
      return yield* jjManagerError(
        "runFeatureBranchStep",
        "Cannot create a feature branch because there are no changes to commit.",
      );
    }

    const existingBranchNames = yield* jjCore.listLocalBranchNames(cwd);
    const preferredBranch = suggestion.branch ?? sanitizeFeatureBranchName(suggestion.subject);
    const resolvedBranch = resolveAutoFeatureBranchName(existingBranchNames, preferredBranch);

    // In JJ, createBranch points the bookmark at @ (the working copy with
    // changes).  There is no need to checkout — the working copy already
    // contains the changes that will be committed in the next step.
    yield* jjCore.createBranch({ cwd, branch: resolvedBranch });

    return {
      branchStep: { status: "created" as const, name: resolvedBranch },
      resolvedCommitMessage: suggestion.commitMessage,
      resolvedCommitSuggestion: suggestion,
    };
  });

  const runCommitStep = Effect.fn("runCommitStep")(function* (
    modelSelection: ModelSelection,
    cwd: string,
    branch: string | null,
    commitMessage?: string,
    preResolvedSuggestion?: CommitAndBranchSuggestion,
    filePaths?: readonly string[],
  ) {
    let suggestion: CommitAndBranchSuggestion | null | undefined = preResolvedSuggestion;
    if (!suggestion) {
      suggestion = yield* resolveCommitAndBranchSuggestion({
        cwd,
        branch,
        ...(commitMessage ? { commitMessage } : {}),
        ...(filePaths ? { filePaths } : {}),
        modelSelection,
      });
    }
    if (!suggestion) {
      return { status: "skipped_no_changes" as const };
    }

    const { commitSha } = yield* jjCore.commit(cwd, suggestion.subject, suggestion.body);
    return {
      status: "created" as const,
      commitSha,
      subject: suggestion.subject,
    };
  });

  const runPrStep = Effect.fn("runPrStep")(function* (
    modelSelection: ModelSelection,
    cwd: string,
    branch: string | null,
  ) {
    if (!branch) {
      return yield* jjManagerError(
        "runPrStep",
        "Cannot create a pull request without an active bookmark.",
      );
    }

    const headSelector = yield* resolveHeadSelectorBranch(cwd, branch);
    const existing = yield* findOpenPr(cwd, headSelector).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
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

    const details = yield* jjCore.statusDetails(cwd);
    if (!details.hasUpstream) {
      return yield* jjManagerError(
        "runPrStep",
        "Current bookmark has not been pushed. Push it first.",
      );
    }

    const baseBranch =
      (yield* jjCore
        .readConfigValue(cwd, branchConfigKey(branch, "gh-merge-base"))
        .pipe(Effect.catch(() => Effect.succeed(null)))) ??
      (details.isDefaultBranch ? branch : "main");
    const rangeContext = yield* jjCore.readRangeContext(cwd, baseBranch);

    const generated = yield* textGeneration.generatePrContent({
      cwd,
      baseBranch,
      headBranch: headSelector,
      commitSummary: limitContext(rangeContext.commitSummary, 20_000),
      diffSummary: limitContext(rangeContext.diffSummary, 20_000),
      diffPatch: limitContext(rangeContext.diffPatch, 60_000),
      modelSelection,
    });

    const workspaceRoot = yield* resolveJjRoot(cwd);
    const bodyFile = path.join(
      process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp",
      `t3code-jj-pr-body-${process.pid}-${randomUUID()}.md`,
    );
    yield* Effect.tryPromise({
      try: () => fsPromises.writeFile(bodyFile, generated.body, "utf8"),
      catch: (cause) => jjManagerError("runPrStep", "Failed to write PR body file.", cause),
    });
    yield* gitHubCli
      .createPullRequest({
        cwd: workspaceRoot,
        baseBranch,
        headSelector,
        title: generated.title,
        bodyFile,
      })
      .pipe(
        Effect.ensuring(
          Effect.tryPromise({
            try: () => fsPromises.unlink(bodyFile),
            catch: () => undefined,
          }).pipe(Effect.ignore),
        ),
      );

    const created = yield* findOpenPr(cwd, headSelector).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    return created
      ? {
          status: "created" as const,
          url: created.url,
          number: created.number,
          baseBranch: created.baseRefName,
          headBranch: created.headRefName,
          title: created.title,
        }
      : {
          status: "created" as const,
          baseBranch,
          headBranch: headSelector,
          title: generated.title,
        };
  });

  const runStackedAction: JjManagerShape["runStackedAction"] = Effect.fn("runStackedAction")(
    function* (input, options) {
      const progress = createProgressEmitter(input, options);
      const currentPhase = yield* Ref.make<GitActionProgressPhase | null>(null);
      const runAction = Effect.fn("runStackedAction.runAction")(function* () {
        const initialStatus = yield* jjCore.statusDetails(input.cwd);
        const wantsCommit = isCommitAction(input.action);
        const wantsPush =
          input.action === "push" ||
          input.action === "commit_push" ||
          input.action === "commit_push_pr" ||
          (input.action === "create_pr" &&
            (!initialStatus.hasUpstream || initialStatus.aheadCount > 0));
        const wantsPr = input.action === "create_pr" || input.action === "commit_push_pr";

        if (input.featureBranch && !wantsCommit) {
          return yield* jjManagerError(
            "runStackedAction",
            "Feature-branch creation is only supported for commit actions.",
          );
        }
        if (input.action === "push" && initialStatus.hasWorkingTreeChanges) {
          return yield* jjManagerError(
            "runStackedAction",
            "Commit or revert local changes before pushing.",
          );
        }
        if (input.action === "create_pr" && initialStatus.hasWorkingTreeChanges) {
          return yield* jjManagerError(
            "runStackedAction",
            "Commit local changes before creating a PR.",
          );
        }

        yield* progress.emit({
          kind: "action_started",
          phases: [
            ...(input.featureBranch ? (["branch"] as const) : []),
            ...(wantsCommit ? (["commit"] as const) : []),
            ...(wantsPush ? (["push"] as const) : []),
            ...(wantsPr ? (["pr"] as const) : []),
          ],
        });

        const modelSelection = yield* serverSettingsService.getSettings.pipe(
          Effect.map((settings) => settings.textGenerationModelSelection),
          Effect.mapError((cause) =>
            jjManagerError("runStackedAction", "Failed to load server settings.", cause),
          ),
        );

        let branchStep: { status: "created" | "skipped_not_requested"; name?: string };
        let commitMessageForStep = input.commitMessage;
        let preResolvedCommitSuggestion: CommitAndBranchSuggestion | undefined = undefined;

        if (input.featureBranch) {
          yield* Ref.set(currentPhase, "branch");
          yield* progress.emit({
            kind: "phase_started",
            phase: "branch",
            label: "Preparing feature bookmark...",
          });
          const featureBranchResult = yield* runFeatureBranchStep(
            modelSelection,
            input.cwd,
            initialStatus.branch,
            input.commitMessage,
            input.filePaths,
          );
          branchStep = featureBranchResult.branchStep;
          commitMessageForStep = featureBranchResult.resolvedCommitMessage;
          preResolvedCommitSuggestion = featureBranchResult.resolvedCommitSuggestion;
        } else {
          branchStep = { status: "skipped_not_requested" as const };
        }

        const currentBranch = branchStep.name ?? initialStatus.branch;

        const commit = wantsCommit
          ? yield* Effect.gen(function* () {
              yield* Ref.set(currentPhase, "commit");
              return yield* runCommitStep(
                modelSelection,
                input.cwd,
                currentBranch,
                commitMessageForStep,
                preResolvedCommitSuggestion,
                input.filePaths,
              );
            })
          : { status: "skipped_not_requested" as const };

        const push = wantsPush
          ? yield* Effect.gen(function* () {
              yield* Ref.set(currentPhase, "push");
              yield* progress.emit({
                kind: "phase_started",
                phase: "push",
                label: "Pushing...",
              });
              return yield* jjCore.pushCurrentBranch(input.cwd, currentBranch);
            })
          : { status: "skipped_not_requested" as const };

        const pr = wantsPr
          ? yield* Effect.gen(function* () {
              yield* Ref.set(currentPhase, "pr");
              yield* progress.emit({
                kind: "phase_started",
                phase: "pr",
                label: "Creating PR...",
              });
              return yield* runPrStep(modelSelection, input.cwd, currentBranch);
            })
          : { status: "skipped_not_requested" as const };

        const committedSha = commit.status === "created" ? shortenSha(commit.commitSha) : null;

        const toast = (() => {
          if (pr.status === "created" || pr.status === "opened_existing") {
            return {
              title: `${pr.status === "created" ? "Created PR" : "Opened PR"}${pr.number ? ` #${pr.number}` : ""}`,
              ...(pr.title ? { description: pr.title } : {}),
              cta: pr.url
                ? {
                    kind: "open_pr" as const,
                    label: "View PR",
                    url: pr.url,
                  }
                : { kind: "none" as const },
            };
          }
          if (push.status === "pushed") {
            return {
              title: `Pushed${committedSha ? ` ${committedSha}` : ""}`,
              ...(commit.status === "created" && commit.subject
                ? { description: commit.subject }
                : {}),
              cta: wantsPr
                ? {
                    kind: "run_action" as const,
                    label: "Create PR",
                    action: { kind: "create_pr" as const },
                  }
                : { kind: "none" as const },
            };
          }
          if (commit.status === "created") {
            return {
              title: `Committed${committedSha ? ` ${committedSha}` : ""}`,
              ...(commit.subject ? { description: commit.subject } : {}),
              cta: {
                kind: "run_action" as const,
                label: "Push",
                action: { kind: "push" as const },
              },
            };
          }
          return {
            title: "Done",
            cta: { kind: "none" as const },
          };
        })();

        const result = {
          action: input.action,
          branch: branchStep,
          commit,
          push,
          pr,
          toast,
        } satisfies GitRunStackedActionResult;

        yield* progress.emit({
          kind: "action_finished",
          result,
        });

        return result;
      });

      return yield* runAction().pipe(
        Effect.tapError((error) =>
          Effect.flatMap(Ref.get(currentPhase), (phase) =>
            progress.emit({
              kind: "action_failed",
              phase,
              message: error.message,
            }),
          ),
        ),
      );
    },
  );

  return {
    status,
    resolvePullRequest,
    preparePullRequestThread,
    runStackedAction,
  } satisfies GitManagerShape;
});

export const JjManagerLive = Layer.effect(JjManager, makeJjManager());
