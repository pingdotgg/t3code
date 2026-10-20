import {
  GitManagerError,
  type GitCommandError,
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
  type GitStackedAction,
  type GitManagerServiceError,
  type ModelSelection,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type SourceControlWritingStyleSettings,
  type TextGenerationError,
  type ThreadId,
  type ChangeRequest,
} from "@t3tools/contracts";
import {
  historicalMessage,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import * as Crypto from "effect/Crypto";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  hasProjectSettingsOverrides,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
  sanitizeBranchFragment,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/git";
import {
  getChangeRequestTerminologyForKind,
  type ChangeRequestTerminology,
} from "@t3tools/shared/sourceControl";
import {
  parseGitHubRepositorySelector,
  resolveGitHubRepository,
} from "@t3tools/source-control-github/server/gitHubRepositoryResolution";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  conventionalCommitsTextGenerationPolicy,
  customTextGenerationPolicy,
  repositoryConventionsTextGenerationPolicy,
} from "../textGeneration/TextGenerationPresets.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { extractBranchNameFromRemoteRef } from "../git/remoteRefs.ts";

const SHORT_SHA_LENGTH = 7;
const TOAST_DESCRIPTION_MAX = 72;
const PR_THREAD_CONTEXT_BYTES = 16_000;
const PR_THREAD_COMMAND_OUTPUT_CHARS = 2_000;

export interface SourceControlTextGenerationSettings {
  readonly modelSelection: ModelSelection;
  readonly style: SourceControlWritingStyleSettings;
}
type StripProgressContext<T> = T extends any ? Omit<T, "actionId" | "cwd" | "action"> : never;
export type GitActionProgressPayload = StripProgressContext<GitActionProgressEvent>;
type GitActionProgressEmitter = (event: GitActionProgressPayload) => Effect.Effect<void, never>;
interface OpenPrInfo {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
}

export interface PullRequestInfo extends OpenPrInfo, PullRequestHeadRemoteInfo {
  state: "open" | "closed" | "merged";
  isDraft?: boolean;
  closedAt?: string | null;
  mergedAt?: string | null;
  updatedAt: Option.Option<DateTime.Utc>;
  headSha?: string | undefined;
}

export interface ResolvedPullRequest {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  state: "open" | "closed" | "merged";
}

export interface PullRequestHeadRemoteInfo {
  isCrossRepository?: boolean | undefined;
  headRepositoryNameWithOwner?: string | null | undefined;
  headRepositoryOwnerLogin?: string | null | undefined;
}

export interface BranchHeadContext {
  localBranch: string;
  headBranch: string;
  headSelectors: ReadonlyArray<string>;
  preferredHeadSelector: string;
  remoteName: string | null;
  headRemoteUrlKey: string | null;
  targetRemoteUrlKey: string | null;
  headRepositoryNameWithOwner: string | null;
  headRepositoryOwnerLogin: string | null;
  isCrossRepository: boolean;
}

export function pullRequestRepositoryKey(value: string): string | null {
  try {
    const url = new URL(value);
    const match =
      /^(.*)(?:\/pull\/|\/-\/merge_requests\/|\/pull-requests\/|\/pullrequest\/)\d+(?:\/.*)?$/iu.exec(
        url.pathname,
      );
    if (match?.[1] === undefined) return null;
    url.pathname = match[1];
    url.search = "";
    url.hash = "";
    return normalizeGitRemoteUrl(url.toString());
  } catch {
    return null;
  }
}

export function normalizePullRequestReference(reference: string): string {
  const trimmed = reference.trim();
  const hashNumber = /^#(\d+)$/.exec(trimmed);
  return hashNumber?.[1] ?? trimmed;
}

export function toResolvedPullRequest(pr: {
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

export function parseRepositoryNameFromPullRequestUrl(url: string): string | null {
  const trimmed = url.trim();
  const match = /^https?:\/\/[^/]+\/[^/]+\/([^/]+)\/pull\/\d+(?:\/.*)?$/i.exec(trimmed);
  const repositoryName = match?.[1]?.trim() ?? "";
  return repositoryName.length > 0 ? repositoryName : null;
}

export function resolvePullRequestWorktreeLocalBranchName(
  pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
): string {
  if (!pullRequest.isCrossRepository) {
    return pullRequest.headBranch;
  }

  const sanitizedHeadBranch = sanitizeBranchFragment(pullRequest.headBranch).trim();
  const suffix = sanitizedHeadBranch.length > 0 ? sanitizedHeadBranch : "head";
  return `t3code/pr-${pullRequest.number}/${suffix}`;
}

export function parseRepositoryNameWithOwnerFromRemoteUrl(
  url: string | null,
  provider?: Pick<
    SourceControlProvider.SourceControlProvider["Service"],
    "repositoryNameFromRemoteUrl"
  >,
): string | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) return null;
  return (
    provider?.repositoryNameFromRemoteUrl?.(trimmed) ??
    SourceControlProvider.repositoryPathFromRemoteUrl(trimmed)
  );
}

function parseRepositoryOwnerLogin(nameWithOwner: string | null): string | null {
  const trimmed = nameWithOwner?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  // GitLab reports the top-level group as owner. The full path distinguishes subgroups.
  const [ownerLogin] = trimmed.split("/");
  const normalizedOwnerLogin = ownerLogin?.trim() ?? "";
  return normalizedOwnerLogin.length > 0 ? normalizedOwnerLogin : null;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalRepositoryNameWithOwner(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeOptionalOwnerLogin(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function resolvePullRequestHeadRepositoryNameWithOwner(
  pr: PullRequestHeadRemoteInfo & { url: string },
) {
  const explicitRepository = normalizeOptionalString(pr.headRepositoryNameWithOwner);
  if (explicitRepository) {
    return explicitRepository;
  }

  if (!pr.isCrossRepository) {
    return null;
  }

  const ownerLogin = normalizeOptionalString(pr.headRepositoryOwnerLogin);
  const repositoryName = parseRepositoryNameFromPullRequestUrl(pr.url);
  if (!ownerLogin || !repositoryName) {
    return null;
  }

  return `${ownerLogin}/${repositoryName}`;
}

interface PullRequestHeadIdentity {
  readonly repositoryNameWithOwner: string | null;
  readonly ownerLogin: string | null;
}

function resolveExpectedHeadIdentity(
  headContext: Pick<BranchHeadContext, "headRepositoryNameWithOwner" | "headRepositoryOwnerLogin">,
): PullRequestHeadIdentity {
  const repositoryNameWithOwner = normalizeOptionalRepositoryNameWithOwner(
    headContext.headRepositoryNameWithOwner,
  );
  return {
    repositoryNameWithOwner,
    ownerLogin:
      normalizeOptionalOwnerLogin(headContext.headRepositoryOwnerLogin) ??
      parseRepositoryOwnerLogin(repositoryNameWithOwner),
  };
}

function resolvePullRequestHeadIdentity(pr: PullRequestInfo): PullRequestHeadIdentity {
  const repositoryNameWithOwner = normalizeOptionalRepositoryNameWithOwner(
    resolvePullRequestHeadRepositoryNameWithOwner(pr),
  );
  return {
    repositoryNameWithOwner,
    ownerLogin:
      normalizeOptionalOwnerLogin(pr.headRepositoryOwnerLogin) ??
      parseRepositoryOwnerLogin(repositoryNameWithOwner),
  };
}

export function matchesBranchHeadContext(
  pr: PullRequestInfo,
  headContext: Pick<
    BranchHeadContext,
    "headBranch" | "headRepositoryNameWithOwner" | "headRepositoryOwnerLogin" | "isCrossRepository"
  >,
): boolean {
  if (pr.headRefName !== headContext.headBranch) {
    return false;
  }

  const expectedHead = resolveExpectedHeadIdentity(headContext);
  const pullRequestHead = resolvePullRequestHeadIdentity(pr);

  if (expectedHead.repositoryNameWithOwner) {
    if (pullRequestHead.repositoryNameWithOwner) {
      if (expectedHead.repositoryNameWithOwner !== pullRequestHead.repositoryNameWithOwner) {
        return false;
      }
    }
    if (expectedHead.ownerLogin && pullRequestHead.ownerLogin) {
      if (expectedHead.ownerLogin !== pullRequestHead.ownerLogin) {
        return false;
      }
    }
  }

  if (expectedHead.ownerLogin && pullRequestHead.ownerLogin) {
    if (expectedHead.ownerLogin !== pullRequestHead.ownerLogin) {
      return false;
    }
  }

  if (headContext.isCrossRepository) {
    if (pr.isCrossRepository === false) {
      return false;
    }
    if (
      (expectedHead.repositoryNameWithOwner || expectedHead.ownerLogin) &&
      !pullRequestHead.repositoryNameWithOwner &&
      !pullRequestHead.ownerLogin
    ) {
      return false;
    }
    return true;
  }

  if (pr.isCrossRepository === true) {
    if (
      (!expectedHead.repositoryNameWithOwner && !expectedHead.ownerLogin) ||
      (!pullRequestHead.repositoryNameWithOwner && !pullRequestHead.ownerLogin)
    ) {
      return false;
    }
  }

  return true;
}

export function toPullRequestInfo(summary: ChangeRequest): PullRequestInfo {
  return {
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    ...(summary.headSha !== undefined ? { headSha: summary.headSha } : {}),
    state: summary.state ?? "open",
    ...(summary.isDraft === true ? { isDraft: true } : {}),
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
    updatedAt: summary.updatedAt,
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}
function limitContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function shortenSha(sha: string | undefined): string | null {
  if (!sha) return null;
  return sha.slice(0, SHORT_SHA_LENGTH);
}

function truncateText(
  value: string | undefined,
  maxLength = TOAST_DESCRIPTION_MAX,
): string | undefined {
  if (!value) return undefined;
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return "...".slice(0, maxLength);
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function withDescription(title: string, description: string | undefined) {
  return description ? { title, description } : { title };
}

export function summarizeGitActionResult(
  result: Pick<GitRunStackedActionResult, "commit" | "push" | "pr">,
  terms: ChangeRequestTerminology,
): {
  title: string;
  description?: string;
} {
  if (result.pr.status === "created" || result.pr.status === "opened_existing") {
    const prNumber = result.pr.number ? ` #${result.pr.number}` : "";
    const title = `${result.pr.status === "created" ? "Created" : "Opened"} ${terms.shortLabel}${prNumber}`;
    return withDescription(title, truncateText(result.pr.title));
  }

  if (result.push.status === "pushed") {
    const shortSha = shortenSha(result.commit.commitSha);
    const branch = result.push.upstreamBranch ?? result.push.branch;
    const pushedCommitPart = shortSha ? ` ${shortSha}` : "";
    const branchPart = branch ? ` to ${branch}` : "";
    return withDescription(
      `Pushed${pushedCommitPart}${branchPart}`,
      truncateText(result.commit.subject),
    );
  }

  if (result.commit.status === "created") {
    const shortSha = shortenSha(result.commit.commitSha);
    const title = shortSha ? `Committed ${shortSha}` : "Committed changes";
    return withDescription(title, truncateText(result.commit.subject));
  }

  return { title: "Done" };
}

function sanitizeCommitMessage(generated: {
  subject: string;
  body: string;
  branch?: string | undefined;
}): {
  subject: string;
  body: string;
  branch?: string | undefined;
} {
  const rawSubject = generated.subject.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const subject = rawSubject.replace(/[.]+$/g, "").trim();
  const safeSubject = subject.length > 0 ? subject.slice(0, 72).trimEnd() : "Update project files";
  return {
    subject: safeSubject,
    body: generated.body.trim(),
    ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
  };
}
export interface CommitAndBranchSuggestion {
  subject: string;
  body: string;
  branch?: string | undefined;
  commitMessage: string;
}

export function isCommitAction(
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

export function headBranchProbe(
  provider: SourceControlProvider.SourceControlProvider["Service"],
  headSelectors: ReadonlyArray<string>,
  state: "open" | "all",
) {
  return (
    provider.headBranchProbe?.({ headSelectors, state }) ?? {
      headSelectors,
      limit: state === "open" ? 1 : 20,
    }
  );
}
/** A URL's host as `new URL` reads it: lowercased, any non-default port kept, `:443` dropped. */
function urlHost(url: string): string | null {
  return URL.canParse(url) ? new URL(url).host : null;
}

function appendUnique(values: string[], next: string | null | undefined): void {
  const trimmed = next?.trim() ?? "";
  if (trimmed.length === 0 || values.includes(trimmed)) {
    return;
  }
  values.push(trimmed);
}

/** Every service the shared step needs; the caller discharges them from its own context. */
export type ChangeRequestStepServices =
  | Crypto.Crypto
  | ServerSettings.ServerSettingsService
  | FileSystem.FileSystem
  | Path.Path
  | ProviderRegistry.ProviderRegistry
  | SourceControlProviderRegistry.SourceControlProviderRegistry
  | TextGeneration.TextGeneration
  | ProjectionStore.ProjectionStoreV2;

type ExecuteGit = GitVcsDriver.GitVcsDriver["Service"]["execute"];

/** A git config read that reports a missing key and a failed read alike as `null`. */
type ReadConfigValue = (cwd: string, key: string) => Effect.Effect<string | null, never>;

const readRepositoryInstructions = Effect.fn("GitManager.readRepositoryInstructions")(
  function* (cwd: string, fileName: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
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

const readRecentCommitSubjects = (
  executeGit: ExecuteGit,
  cwd: string,
): Effect.Effect<ReadonlyArray<string>> =>
  executeGit({
    operation: "GitManager.readRecentCommitSubjects",
    cwd,
    args: ["log", "-n", "20", "--no-merges", "--pretty=format:%s"],
  }).pipe(
    Effect.map((result) =>
      result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
    Effect.orElseSucceed(() => []),
  );

const resolveStylePolicy = Effect.fn("GitManager.resolveStylePolicy")(function* (
  executeGit: ExecuteGit,
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
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const subjects = yield* readRecentCommitSubjects(executeGit, cwd);
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
        ...(claudeInstructions ? [`Local CLAUDE.md:\n${claudeInstructions}`] : []),
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

const resolveRemoteRepositoryContext = Effect.fn("resolveRemoteRepositoryContext")(
  function* (readConfigValue: ReadConfigValue, cwd: string, remoteName: string | null) {
    if (!remoteName) {
      return {
        remoteUrl: null,
        remoteUrlKey: null,
        repositoryNameWithOwner: null,
        ownerLogin: null,
      };
    }

    const remoteUrl = yield* readConfigValue(cwd, `remote.${remoteName}.url`);
    let repositoryNameWithOwner = parseRepositoryNameWithOwnerFromRemoteUrl(remoteUrl);
    if (
      remoteUrl !== null &&
      /^https?:\/\//iu.test(remoteUrl) &&
      (repositoryNameWithOwner?.split("/").length ?? 0) > 2
    ) {
      const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
      const kind = detectSourceControlProviderFromGitRemoteUrl(remoteUrl)?.kind;
      const provider =
        kind === undefined
          ? undefined
          : yield* (kind === "unknown" ? providers.resolve({ cwd }) : providers.get(kind)).pipe(
              Effect.orElseSucceed(() => undefined),
            );
      repositoryNameWithOwner = parseRepositoryNameWithOwnerFromRemoteUrl(remoteUrl, provider);
    }
    return {
      remoteUrl,
      remoteUrlKey: remoteUrl ? normalizeGitRemoteUrl(remoteUrl) : null,
      repositoryNameWithOwner,
      ownerLogin: parseRepositoryOwnerLogin(repositoryNameWithOwner),
    };
  },
);

const resolveHeadAndOriginContexts = (
  readConfigValue: ReadConfigValue,
  cwd: string,
  remoteName: string | null,
) =>
  remoteName === "origin"
    ? resolveRemoteRepositoryContext(readConfigValue, cwd, "origin").pipe(
        Effect.map((origin) => [origin, origin] as const),
      )
    : Effect.all(
        [
          resolveRemoteRepositoryContext(readConfigValue, cwd, remoteName),
          resolveRemoteRepositoryContext(readConfigValue, cwd, "origin"),
        ],
        { concurrency: "unbounded" },
      );

const targetsOnlyRemote = Effect.fn("targetsOnlyRemote")(function* (
  readConfigValueNullable: ReadConfigValue,
  cwd: string,
  remoteName: string,
  remote: { readonly remoteUrl: string | null; readonly repositoryNameWithOwner: string | null },
) {
  const environment = yield* HostProcess.Environment;
  const baseUrl =
    remote.remoteUrl === null
      ? undefined
      : detectSourceControlProviderFromGitRemoteUrl(remote.remoteUrl)?.baseUrl;
  const host = baseUrl === undefined ? null : urlHost(baseUrl);
  const repository = remote.repositoryNameWithOwner?.toLowerCase();
  const fromEnvironment = parseGitHubRepositorySelector(environment.GH_REPO ?? "", host ?? "");
  if (fromEnvironment !== null) {
    const { host: targetHost, owner, name } = fromEnvironment;
    return (
      host !== null &&
      urlHost(`https://${targetHost}`) === host &&
      `${owner}/${name}`.toLowerCase() === repository
    );
  }
  const mark = yield* readConfigValueNullable(cwd, `remote.${remoteName}.gh-resolved`);
  const { locator } = resolveGitHubRepository({
    remotes: remote.remoteUrl === null ? "" : `${remoteName}\t${remote.remoteUrl} (fetch)`,
    resolved: mark === null ? "" : `remote.${remoteName}.gh-resolved ${mark}`,
    hostHint: host ?? undefined,
    defaultHost: host ?? "github.com",
  });
  return locator === null || `${locator.owner}/${locator.name}`.toLowerCase() === repository;
});

export const resolveBranchHeadContext = Effect.fn("resolveBranchHeadContext")(function* (
  readConfigValue: ReadConfigValue,
  executeGit: ExecuteGit,
  cwd: string,
  details: { branch: string; upstreamRef: string | null; remoteName?: string },
) {
  const remoteName =
    details.remoteName ?? (yield* readConfigValue(cwd, `branch.${details.branch}.remote`));
  const headBranchFromUpstream = details.upstreamRef
    ? extractBranchNameFromRemoteRef(details.upstreamRef, { remoteName })
    : "";
  const headBranch = headBranchFromUpstream.length > 0 ? headBranchFromUpstream : details.branch;
  const shouldProbeLocalBranchSelector =
    headBranchFromUpstream.length === 0 || headBranch === details.branch;

  const [remoteRepository, originRepository] = yield* resolveHeadAndOriginContexts(
    readConfigValue,
    cwd,
    remoteName,
  );

  // With no origin to compare against, the only remote is the repository gh targets
  // unless GH_REPO or `gh repo set-default` (gh-resolved) names another, so a branch on it
  // is not a fork. With several remotes, or with that other target, it may still be a fork.
  const isOnlyRemote =
    remoteName !== null &&
    remoteName !== "origin" &&
    originRepository.remoteUrlKey === null &&
    (yield* executeGit({
      operation: "GitManager.resolveBranchHeadContext.remotes",
      cwd,
      args: ["remote"],
      timeoutMs: 5_000,
    }).pipe(
      Effect.map(
        (result) => result.stdout.split("\n").filter((name) => name.trim().length > 0).length,
      ),
      Effect.orElseSucceed(() => 0),
    )) === 1 &&
    (yield* targetsOnlyRemote(readConfigValue, cwd, remoteName, remoteRepository));
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
    preferredHeadSelector: ownerHeadSelector && isCrossRepository ? ownerHeadSelector : headBranch,
    remoteName,
    headRemoteUrlKey:
      remoteRepository.remoteUrlKey ?? (remoteName === null ? originRepository.remoteUrlKey : null),
    targetRemoteUrlKey: originRepository.remoteUrlKey,
    headRepositoryNameWithOwner: remoteRepository.repositoryNameWithOwner,
    headRepositoryOwnerLogin: remoteRepository.ownerLogin,
    isCrossRepository,
  } satisfies BranchHeadContext;
});

export const findOpenPr = Effect.fn("findOpenPr")(function* (
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
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const provider = yield* providers.resolve({ cwd });
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

export interface ChangeRequestVcsReads {
  /** Current ref/bookmark name; null means "no named line of work". */
  readonly refName: string | null;
  readonly hasUpstream: boolean;
  readonly upstreamRef: string | null;
  readonly readRangeContext: (
    cwd: string,
    baseRef: string,
  ) => Effect.Effect<GitVcsDriver.GitRangeContext, GitCommandError>;
  /** Raw execution against the repository's Git store, for PR-template detection. */
  readonly executeGit: ExecuteGit;
  /** Directory the hosting provider CLI runs in, the main workspace root under jj. */
  readonly providerCwd: string;
  /** Returns `null` only for an unset key; execution failures must propagate. */
  readonly readConfigValue: (
    cwd: string,
    key: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
  /** Returns the host's bare branch name (e.g. origin/main or refs/heads/main → main), or null. */
  readonly resolveRefName: (
    cwd: string,
    refName: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  readonly resolveDefaultRefName: (
    cwd: string,
    remoteName: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  readonly resolveRemoteTrackingCommit: (input: {
    readonly cwd: string;
    readonly refName: string;
    readonly fallbackRemoteName: string;
  }) => Effect.Effect<{ readonly commitSha: string }, GitCommandError>;
}

const resolvePrBase = Effect.fn("resolvePrBase")(function* (
  reads: ChangeRequestVcsReads,
  cwd: string,
  branch: string,
  upstreamRef: string | null,
  headContext: Pick<BranchHeadContext, "isCrossRepository" | "remoteName">,
) {
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const configuredRef = yield* reads.readConfigValue(cwd, `branch.${branch}.t3-merge-base-ref`);
  if (configuredRef?.startsWith("refs/heads/") || configuredRef?.startsWith("refs/remotes/")) {
    const configuredBranch = yield* reads.resolveRefName(cwd, configuredRef);
    if (configuredBranch) return { baseBranch: configuredBranch, baseRef: configuredRef };
  }

  const configured = yield* reads.readConfigValue(cwd, `branch.${branch}.gh-merge-base`);
  if (configured) {
    const localRef = configured.startsWith("refs/") ? configured : `refs/heads/${configured}`;
    const localBranch = yield* reads.resolveRefName(cwd, localRef);
    if (localBranch) {
      const shadowsRemote =
        configured.includes("/") &&
        !configured.startsWith("refs/") &&
        (yield* reads.resolveRefName(cwd, `refs/remotes/${configured}`)) !== null;
      return {
        baseBranch: localBranch,
        baseRef: configured.startsWith("refs/") || shadowsRemote ? localRef : localBranch,
      };
    }
    if (configured.includes("/") && !configured.startsWith("refs/")) {
      const remoteRef = `refs/remotes/${configured}`;
      const remoteBranch = yield* reads.resolveRefName(cwd, remoteRef);
      if (remoteBranch) return { baseBranch: remoteBranch, baseRef: remoteRef };
    }
    const configuredBranch = yield* reads.resolveRefName(cwd, configured);
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

  const defaultFromProvider = yield* providers.resolve({ cwd: reads.providerCwd }).pipe(
    Effect.flatMap((provider) => provider.getDefaultBranch({ cwd: reads.providerCwd })),
    Effect.orElseSucceed(() => null),
  );
  if (defaultFromProvider) {
    return { baseBranch: defaultFromProvider, baseRef: defaultFromProvider };
  }

  const defaultFromRemote = yield* reads.resolvePrimaryRemoteName(cwd).pipe(
    Effect.flatMap((remoteName) => reads.resolveDefaultRefName(cwd, remoteName)),
    Effect.orElseSucceed(() => null),
  );
  if (defaultFromRemote) {
    return { baseBranch: defaultFromRemote, baseRef: defaultFromRemote };
  }

  return { baseBranch: "main", baseRef: "main" };
});

const resolveBaseRangeRef = Effect.fn("resolveBaseRangeRef")(function* (
  reads: ChangeRequestVcsReads,
  cwd: string,
  baseBranch: string,
) {
  if (baseBranch.startsWith("refs/")) return baseBranch;
  const remoteName = yield* reads
    .resolvePrimaryRemoteName(cwd)
    .pipe(Effect.orElseSucceed(() => null));
  if (!remoteName) return baseBranch;

  return yield* reads
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

/**
 * The commit message (and, for a feature-branch action, the branch name) a stacked action commits
 * with. Only the working-copy context read is VCS-specific, so it is the one thing passed in.
 */
export const resolveCommitAndBranchSuggestion = Effect.fn("resolveCommitAndBranchSuggestion")(
  function* (input: {
    readonly cwd: string;
    readonly branch: string | null;
    readonly commitMessage?: string;
    /** When true, also produce a semantic feature branch name. */
    readonly includeBranch?: boolean;
    readonly filePaths?: readonly string[];
    readonly settings: SourceControlTextGenerationSettings;
    readonly executeGit: ExecuteGit;
    readonly prepareCommitContext: (
      cwd: string,
      filePaths?: readonly string[],
      options?: { readonly includePatch?: boolean },
    ) => Effect.Effect<GitVcsDriver.GitPreparedCommitContext | null, GitCommandError>;
  }): Effect.fn.Return<
    CommitAndBranchSuggestion | null,
    GitCommandError | TextGenerationError,
    ChangeRequestStepServices
  > {
    const textGeneration = yield* TextGeneration.TextGeneration;
    const customCommit = parseCustomCommitMessage(input.commitMessage ?? "");
    const context = yield* input.prepareCommitContext(input.cwd, input.filePaths, {
      includePatch: customCommit === null,
    });
    if (!context) {
      return null;
    }

    if (customCommit) {
      return {
        subject: customCommit.subject,
        body: customCommit.body,
        ...(input.includeBranch ? { branch: sanitizeFeatureBranchName(customCommit.subject) } : {}),
        commitMessage: formatCommitMessage(customCommit.subject, customCommit.body),
      };
    }

    const policy = yield* resolveStylePolicy(input.executeGit, input.cwd, input.settings);

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

// Preserve command evidence when selectHistory drops oversized items; test verdicts are at the tail.
function limitCommandOutput(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "command_execution" || item.output === undefined) return item;
  if (item.output.length <= PR_THREAD_COMMAND_OUTPUT_CHARS) return item;
  return { ...item, output: `[truncated]\n${item.output.slice(-PR_THREAD_COMMAND_OUTPUT_CHARS)}` };
}

const readThreadContext = Effect.fnUntraced(
  function* (threadId: ThreadId | undefined) {
    if (threadId === undefined) return undefined;
    const threads = yield* ProjectionStore.ProjectionStoreV2;
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

export const runChangeRequestStep = Effect.fn("runChangeRequestStep")(function* (input: {
  readonly settings: SourceControlTextGenerationSettings;
  readonly cwd: string;
  /** Used when `reads.refName` is null. */
  readonly fallbackRefName: string | null;
  readonly threadId?: ThreadId | undefined;
  readonly tempDir: string;
  readonly emit: GitActionProgressEmitter;
  readonly reads: ChangeRequestVcsReads;
  /** Git resolves this before reading status so provider failures retain precedence. */
  readonly provider?: SourceControlProvider.SourceControlProvider["Service"];
}): Effect.fn.Return<
  GitRunStackedActionResult["pr"],
  GitManagerServiceError,
  | SourceControlProviderRegistry.SourceControlProviderRegistry
  | TextGeneration.TextGeneration
  | ProviderRegistry.ProviderRegistry
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ProjectionStore.ProjectionStoreV2
> {
  const { cwd, emit, reads, settings } = input;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const provider = input.provider ?? (yield* providers.resolve({ cwd: reads.providerCwd }));
  const terms = getChangeRequestTerminologyForKind(provider.kind);
  const branch = reads.refName ?? input.fallbackRefName;
  if (!branch) {
    return yield* new GitManagerError({
      operation: "runPrStep",
      cwd,
      detail: "Cannot create a pull request from detached HEAD.",
    });
  }
  if (!reads.hasUpstream) {
    return yield* new GitManagerError({
      operation: "runPrStep",
      cwd,
      detail: "Current branch has not been pushed. Push before creating a PR.",
    });
  }

  const headContext = yield* resolveBranchHeadContext(
    (configCwd, key) =>
      reads.readConfigValue(configCwd, key).pipe(Effect.orElseSucceed(() => null)),
    reads.executeGit,
    cwd,
    { branch, upstreamRef: reads.upstreamRef },
  );

  const existing = yield* findOpenPr(reads.providerCwd, headContext);
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
    reads,
    cwd,
    branch,
    reads.upstreamRef,
    headContext,
  );
  yield* emit({
    kind: "phase_started",
    phase: "pr",
    label: `Generating ${terms.shortLabel} content...`,
  });
  const baseRangeRef = yield* resolveBaseRangeRef(reads, cwd, baseRef);
  const rangeContext = yield* reads.readRangeContext(cwd, baseRangeRef);
  const policy = yield* resolveStylePolicy(reads.executeGit, cwd, settings);
  const changeRequestTemplate =
    settings.style.followChangeRequestTemplates && provider.readChangeRequestTemplate
      ? Option.getOrUndefined(
          yield* provider.readChangeRequestTemplate({
            cwd: reads.providerCwd,
            treeish: baseRangeRef,
          }),
        )
      : undefined;
  const threadContext = yield* readThreadContext(input.threadId);

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

  const uuid = yield* crypto.randomUUIDv4().pipe(
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
  const bodyFile = path.join(input.tempDir, `t3code-pr-body-${process.pid}-${uuid}.md`);
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
      cwd: reads.providerCwd,
      baseRefName: baseBranch,
      headSelector: headContext.preferredHeadSelector,
      title: generated.title,
      bodyFile,
    })
    .pipe(Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.ignore)));

  const created = yield* findOpenPr(reads.providerCwd, headContext);
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

export const readProjectSettings = Effect.fnUntraced(function* (input: {
  readonly cwd: string;
  readonly threadId?: ThreadId | undefined;
  readonly projectId?: ProjectId | undefined;
}) {
  const serverSettingsService = yield* ServerSettings.ServerSettingsService;
  const settings = yield* serverSettingsService.getSettings;
  if (!hasProjectSettingsOverrides(settings)) {
    return { settings, projectId: input.projectId ?? null };
  }
  // Source-control helpers also run without orchestration in the CLI and focused tests.
  const threads = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
  const projects = yield* Effect.serviceOption(ProjectStore.ProjectStoreV2);
  let projectId = input.projectId ?? null;
  if (input.projectId === undefined) {
    if (input.threadId !== undefined && Option.isSome(threads)) {
      projectId = yield* threads.value.getThreadShell(input.threadId).pipe(
        Effect.map((thread) => thread?.projectId ?? null),
        Effect.orElseSucceed(() => null),
      );
    } else if (input.threadId === undefined && Option.isSome(projects)) {
      projectId = yield* projects.value.findActiveByWorkspaceRoot(input.cwd).pipe(
        Effect.map((project) => Option.getOrNull(project)?.projectId ?? null),
        Effect.orElseSucceed(() => null),
      );
    }
  }
  return { settings: resolveProjectSettings(settings, projectId).settings, projectId };
});

/**
 * Environment settings with the acting project's overrides applied, resolved to the writer model
 * and style both the commit and the change-request phases generate with.
 */
export const resolveTextGenerationSettings = Effect.fn("resolveTextGenerationSettings")(
  function* (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly threadId?: ThreadId | undefined;
    readonly projectId?: ProjectId | undefined;
  }): Effect.fn.Return<
    SourceControlTextGenerationSettings,
    GitManagerError,
    ServerSettings.ServerSettingsService | ProviderRegistry.ProviderRegistry
  > {
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

    return yield* Effect.gen(function* () {
      const { settings: projectSettings, projectId } = yield* readProjectSettings(input);

      if (projectSettings.sourceControlWriterModelSelection === null) {
        return {
          modelSelection: projectSettings.textGenerationModelSelection,
          style: projectSettings.sourceControlWritingStyle,
        };
      }
      const providers = yield* providerRegistry.getProviders;
      return {
        modelSelection: ServerSettings.resolveSourceControlWriterModelSelection(
          projectSettings,
          providers,
          projectId,
        ),
        style: projectSettings.sourceControlWritingStyle,
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation: input.operation,
            cwd: input.cwd,
            detail: "Failed to get server settings.",
            cause,
          }),
      ),
    );
  },
);
