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
  mergeGitStatusParts,
  resolveAutoFeatureBranchName,
  sanitizeBranchFragment,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/git";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
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
import { extractBranchNameFromRemoteRef } from "./remoteRefs.ts";
import { detachStackFrame } from "./detachStackFrame.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { GitManagerServiceError } from "@t3tools/contracts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import type { ChangeRequest } from "@t3tools/contracts";

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

export interface SourceControlTextGenerationSettings {
  readonly modelSelection: ModelSelection;
  readonly style: SourceControlWritingStyleSettings;
}

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
    /** refresh queries the host; freshGitState rereads only git state and is required before persisting. */
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

export const COMMIT_TIMEOUT_MS = 10 * 60_000;
export const MAX_PROGRESS_TEXT_LENGTH = 500;
export const SHORT_SHA_LENGTH = 7;
export const TOAST_DESCRIPTION_MAX = 72;
export const STATUS_RESULT_CACHE_TTL = Duration.seconds(1);
export const STATUS_RESULT_CACHE_CAPACITY = 2_048;
export const PR_LOOKUP_CACHE_TTL = Duration.seconds(60);
export const PR_LOOKUP_NO_OPEN_PR_CACHE_TTL = Duration.minutes(5);
export const PR_LOOKUP_FAILURE_BASE_TTL = Duration.seconds(20);
export const PR_LOOKUP_FAILURE_MAX_TTL = Duration.minutes(15);
export const PR_LOOKUP_CACHE_CAPACITY = 2_048;
export const PR_LOOKUP_GIT_STATE_TTL = Duration.minutes(5);
export const SETTLED_PR_LOOKUP_RECHECK_INTERVAL = Duration.minutes(15);
export const PR_THREAD_CONTEXT_BYTES = 16_000;
export const PR_THREAD_COMMAND_OUTPUT_CHARS = 2_000;
export const isSourceControlProviderError = Schema.is(SourceControlProviderError);

/**
 * Throttled lookups fail fast, so a flat failure TTL would retry faster than a healthy
 * lookup refreshes. Backing off per branch keeps a 429 from becoming sustained pressure.
 */
export function prLookupFailureTtl(consecutiveFailures: number): Duration.Duration {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const backoffMs = Duration.toMillis(PR_LOOKUP_FAILURE_BASE_TTL) * Math.pow(2, exponent);
  return Duration.min(Duration.millis(backoffMs), PR_LOOKUP_FAILURE_MAX_TTL);
}
export type StripProgressContext<T> = T extends any ? Omit<T, "actionId" | "cwd" | "action"> : never;
export type GitActionProgressPayload = StripProgressContext<GitActionProgressEvent>;
export type GitActionProgressEmitter = (event: GitActionProgressPayload) => Effect.Effect<void, never>;

export function isNotGitRepositoryError(error: GitCommandError): boolean {
  return error.message.toLowerCase().includes("not a git repository");
}

export interface OpenPrInfo {
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

export const pullRequestUpdatedAtDescOrder: Order.Order<PullRequestInfo> = Order.mapInput(
  Order.flip(Option.makeOrder(DateTime.Order)),
  (pullRequest) => pullRequest.updatedAt,
);

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
  const repositoryUrl = sourceControlDefinitions.parseChangeRequestUrl(value)?.link.repositoryUrl;
  return repositoryUrl === undefined
    ? null
    : sourceControlDefinitions.repositoryKeyFromRemote(repositoryUrl);
}

/** Null when the host did not name the repository the head lives in. */
export function resolveHeadRepositoryNameWithOwner(pullRequest: PullRequestHeadRemoteInfo): string | null {
  return normalizeOptionalString(pullRequest.headRepositoryNameWithOwner);
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

export function parseRepositoryOwnerLogin(nameWithOwner: string | null): string | null {
  const trimmed = nameWithOwner?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  // The first segment only: a nested path's owner is its top-level group. The full path
  // distinguishes subgroups.
  const [ownerLogin] = trimmed.split("/");
  const normalizedOwnerLogin = ownerLogin?.trim() ?? "";
  return normalizedOwnerLogin.length > 0 ? normalizedOwnerLogin : null;
}

export function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeOptionalRepositoryNameWithOwner(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

export function normalizeOptionalOwnerLogin(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

export interface PullRequestHeadIdentity {
  readonly repositoryNameWithOwner: string | null;
  readonly ownerLogin: string | null;
}

export function resolveExpectedHeadIdentity(
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

export function resolvePullRequestHeadIdentity(pr: PullRequestInfo): PullRequestHeadIdentity {
  const repositoryNameWithOwner = normalizeOptionalRepositoryNameWithOwner(
    resolveHeadRepositoryNameWithOwner(pr),
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

export function limitContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

// Preserve command evidence when selectHistory drops oversized items; test verdicts are at the tail.
export function limitCommandOutput(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "command_execution" || item.output === undefined) return item;
  if (item.output.length <= PR_THREAD_COMMAND_OUTPUT_CHARS) return item;
  return { ...item, output: `[truncated]\n${item.output.slice(-PR_THREAD_COMMAND_OUTPUT_CHARS)}` };
}

export function shortenSha(sha: string | undefined): string | null {
  if (!sha) return null;
  return sha.slice(0, SHORT_SHA_LENGTH);
}

export function truncateText(
  value: string | undefined,
  maxLength = TOAST_DESCRIPTION_MAX,
): string | undefined {
  if (!value) return undefined;
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return "...".slice(0, maxLength);
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function withDescription(title: string, description: string | undefined) {
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

export function sanitizeCommitMessage(generated: {
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

export function sanitizeProgressText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length <= MAX_PROGRESS_TEXT_LENGTH) {
    return trimmed;
  }
  return trimmed.slice(0, MAX_PROGRESS_TEXT_LENGTH).trimEnd();
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

export function formatCommitMessage(subject: string, body: string): string {
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    return subject;
  }
  return `${subject}\n\n${trimmedBody}`;
}

export function parseCustomCommitMessage(raw: string): { subject: string; body: string } | null {
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

export function appendUnique(values: string[], next: string | null | undefined): void {
  const trimmed = next?.trim() ?? "";
  if (trimmed.length === 0 || values.includes(trimmed)) {
    return;
  }
  values.push(trimmed);
}

export function toStatusPr(pr: PullRequestInfo): {
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

export function shouldPreferSshRemote(url: string | null): boolean {
  if (!url) return false;
  return isSshRemoteUrl(url);
}

export function toPullRequestHeadRemoteInfo(pr: {
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

import { install0 } from "./gitManagerPart0.ts";
import { install1 } from "./gitManagerPart1.ts";
import { install2 } from "./gitManagerPart2.ts";
import { install3 } from "./gitManagerPart3.ts";
import { install4 } from "./gitManagerPart4.ts";

export type SuccessOf<F> = F extends (...args: never[]) => import("effect/Effect").Effect<infer A, infer _E, infer _R> ? A : never;

export const make = Effect.gen(function* () {
  const d0 = yield* install0({});
  const d1 = Object.assign(d0, yield* install1(d0));
  const d2 = Object.assign(d1, yield* install2(d1));
  const d3 = Object.assign(d2, yield* install3(d2));
  const d4 = Object.assign(d3, yield* install4(d3));
  return GitManager.of({
    createWorktree: d4.createWorktree,
    localStatus: d4.localStatus,
    remoteStatus: d4.remoteStatus,
    status: d4.status,
    branchPullRequest: d4.branchPullRequest,
    invalidateLocalStatus: d4.invalidateLocalStatus,
    invalidateRemoteStatus: d4.invalidateRemoteStatus,
    invalidateStatus: d4.invalidateStatus,
    resolvePullRequest: d4.resolvePullRequest,
    preparePullRequestThread: d4.preparePullRequestThread,
    runStackedAction: d4.runStackedAction,
    subscribePullRequestStateChanges: PubSub.subscribe(d4.pullRequestStateChanges).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
  });
});

export const layer = Layer.effect(GitManager, make);

