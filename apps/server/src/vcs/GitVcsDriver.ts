import * as NodeBuffer from "node:buffer";

import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import {
  GitCommandError,
  VcsCheckpointStorageError,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  type VcsSetPushRemoteInput,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsError,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type ReviewBranchCommitsInput,
  type ReviewBranchCommitsResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type VcsInitInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type VcsStatusInput,
  type VcsStatusResult,
  type WorktreeSubmodules,
} from "@t3tools/contracts";
import { isMissingExecutable } from "@t3tools/source-control-core/server/discovery";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import {
  makeGitVcsDriverCore,
  PATCH_RENDER_PREFIX_ARGS,
  splitNullSeparatedGitStdoutPaths,
} from "./GitVcsDriverCore.ts";
import * as CheckoutCloner from "./CheckoutCloner.ts";
import * as CheckpointCaptureIndex from "./checkpointCaptureIndex.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

export interface ExecuteGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number | null;
  readonly maxOutputBytes?: number;
  readonly appendTruncationMarker?: boolean;
  /** With appendTruncationMarker, line callbacks continue beyond the buffer cap for progress-only consumers. */
  readonly keepLineCallbacksAfterTruncation?: boolean;
  readonly progress?: ExecuteGitProgress;
  /** Writes .git/config, which every worktree shares and Git locks without waiting. */
  readonly writesSharedConfig?: boolean;
  /** A push: the one command `RepositoryHooks` "approved-push" lets run the repository's hooks. */
  readonly pushes?: boolean;
}

export interface ExecuteGitResult {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export class GitNothingToCommitError extends Schema.TaggedError<GitNothingToCommitError>()(
  "GitNothingToCommitError",
  {
    operation: Schema.String,
    cwd: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Nothing to commit in ${this.operation} (${this.cwd}): ${this.detail}`;
  }
}

export interface GitStatusDetails {
  isRepo: boolean;
  sourceControlProvider?: VcsStatusResult["sourceControlProvider"];
  hasOriginRemote: boolean;
  remotes?: VcsStatusResult["remotes"];
  pushRemote?: VcsStatusResult["pushRemote"];
  pushRemoteChoices?: VcsStatusResult["pushRemoteChoices"];
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasWorkingTreeChanges: boolean;
  workingTree: VcsStatusResult["workingTree"];
  branchChanges?: VcsStatusResult["branchChanges"];
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitLocalStatusOptions {
  readonly includeDivergence?: boolean;
  readonly includeBranchChanges?: boolean;
}

export interface GitRemoteStatusDetails {
  isRepo: boolean;
  hasPrimaryRemote: boolean;
  defaultBranch: string | null;
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitPreparedCommitContext {
  stagedSummary: string;
  stagedPatch: string;
}

export interface ExecuteGitProgress {
  readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>;
  readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface CreateWorktreeProgress {
  /**
   * Runs uninterruptibly once the worktree exists; from then on the caller owns its cleanup.
   * For new-branch calls on Git supporting add --reason, cancellation before the claim removes what it made.
   */
  readonly onWorktreeClaimed?: (path: string) => Effect.Effect<void, never>;
  readonly onCheckoutProgress?: (input: {
    percent: number;
    completed: number;
    total: number;
  }) => Effect.Effect<void, never>;
  readonly onSubmodulesStarted?: () => Effect.Effect<void, never>;
  readonly onSubmodulesDisabled?: (input: {
    source: "settings" | "t3.json";
  }) => Effect.Effect<void, never>;
  readonly onSubmoduleLine?: (line: string) => Effect.Effect<void, never>;
  readonly onSubmodulesFinished?: (input: {
    ok: boolean;
    detail: string | null;
  }) => Effect.Effect<void, never>;
}

export interface CreateWorktreeOptions {
  readonly progress?: CreateWorktreeProgress;
  /** Null or omitted defers to the checkout's t3.json. */
  readonly submodules?: WorktreeSubmodules | null;
  readonly worktreesDirectory?: string;
  /** Clone the checkout from the macOS worktree checkout cache. */
  readonly fastCheckout?: boolean;
}

export interface GitCommitProgress {
  readonly onOutputLine?: (input: {
    stream: "stdout" | "stderr";
    text: string;
  }) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitOptions {
  readonly timeoutMs?: number;
  readonly progress?: GitCommitProgress;
  readonly stage?: {
    readonly filePaths?: readonly string[];
    /** The caller has not run `prepareCommitContext`, so an empty result must keep the index. */
    readonly unverified?: boolean;
  };
}

export interface GitDeleteLocalBranchInput {
  readonly cwd: string;
  readonly refName: string;
  readonly force?: boolean;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  /** Set when `upstreamBranch` is on a configured push remote instead of the tracked upstream. */
  pushRemote?: string | undefined;
  setUpstream?: boolean | undefined;
}

export interface GitPushTarget {
  remoteName: string;
  branchName: string;
  /** The tracked upstream is current, yet pushes go to this configured push remote. */
  viaPushRemote: boolean;
}

export interface GitRangeContext {
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

export interface GitRenameBranchInput {
  exactName?: boolean;
  cwd: string;
  oldBranch: string;
  newBranch: string;
}

export interface GitRenameBranchResult {
  branch: string;
}

export interface GitFetchRefInput {
  cwd: string;
  /** A ref on the primary remote, such as a host's change request head ref. */
  ref: string;
}

export interface GitResolveCommitInput {
  cwd: string;
  revision: string;
}

export interface GitResolveCommitResult {
  commitSha: string;
}

export interface GitRefreshCheckedOutBranchInput {
  cwd: string;
  targetCommit: string;
  /** Pre-fetch upstream commit; resetting away is safe only if HEAD stayed here. */
  resetWhenHeadCommit?: string | null | undefined;
}

export interface GitRefreshCheckedOutBranchResult {
  headCommit: string;
  moved: boolean;
  onTarget: boolean;
}

export interface GitEnsureRemoteInput {
  cwd: string;
  preferredName: string;
  url: string;
}

export interface GitFetchRemoteBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
}

export interface GitFetchRemoteTrackingBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitFetchRemoteInput {
  cwd: string;
  remoteName: string;
  refName?: string;
}

export interface GitRemoteExistsInput {
  cwd: string;
  remoteName: string;
}

export interface GitRemoteBranchExistsInput extends GitRemoteExistsInput {
  refName: string;
}

export interface GitResolveRemoteTrackingCommitInput {
  cwd: string;
  refName: string;
  fallbackRemoteName: string;
}

export interface GitResolveRemoteTrackingCommitResult {
  commitSha: string;
  remoteRefName: string;
}

export interface GitFetchWorktreeBaseCommitInput {
  cwd: string;
  refName: string;
}

export interface GitCreateBranchInput {
  readonly cwd: string;
  readonly branch: string;
  readonly startPoint: string;
}

export interface GitWriteConfigValueInput {
  readonly cwd: string;
  readonly key: string;
  readonly value: string;
}

export interface GitWorktreeBaseRemote {
  remoteName: string;
  branchName: string;
}

export interface GitSetBranchUpstreamInput {
  cwd: string;
  branch: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitRemoteStatusOptions {
  readonly refreshUpstream?: boolean;
  /** False skips the base-branch lookup and reports `aheadOfDefaultCount` as 0. */
  readonly includeAheadOfDefault?: boolean;
}

/**
 * Set by a one-time reader, such as the startup automatic pull, that has no later poll to see a
 * slow status fetch land. Its status read waits for a running fetch instead of using the last
 * fetched references after five seconds. The fetch keeps its own safety limit.
 */
export const AwaitStatusFetch = Context.Reference<boolean>("t3/vcs/AwaitStatusFetch", {
  defaultValue: () => false,
});

/**
 * The hooks Git would run for a push from a checkout, and a digest of what the named files hold.
 * What those files go on to run is not part of it.
 */
export interface PushHooks {
  /**
   * The files the digest covers: each hook file Git starts and, where that is the shim husky 9
   * and Vite+ install, the runner `h` beside it and the script of the hook's name one directory up.
   */
  readonly files: ReadonlyArray<string>;
  /** The hooks Git's configuration defines for a push (`hook.<name>.command`), which Git 2.54 runs too. */
  readonly commands: ReadonlyArray<{ readonly name: string; readonly command: string }>;
  /**
   * Changes when one of `files` is added, removed, moved or edited, or one of `commands` changes
   * or is started at another point of the push.
   */
  readonly digest: string;
}

/** A push was about to run hooks other than the ones approved; `hooks` is what would run now. */
export class PushHooksUnapprovedError extends Schema.TaggedError<PushHooksUnapprovedError>()(
  "PushHooksUnapprovedError",
  {
    files: Schema.Array(Schema.String),
    commands: Schema.Array(Schema.Struct({ name: Schema.String, command: Schema.String })),
    digest: Schema.String,
  },
) {
  override get message(): string {
    return "The repository's push hooks are not the ones that were approved.";
  }
}

/**
 * Which repository hooks Git runs for the calling work. "approved-push" runs them for the push
 * alone, while they are what `digest` was taken from (null: none approved): the driver reads them
 * again as its last step before starting that push and lets it start those and no other.
 * Everything else runs with hooks off: no hooks directory and no configured hook.
 */
export type RepositoryHooksPolicy =
  | { readonly _tag: "all" }
  | { readonly _tag: "none" }
  | { readonly _tag: "approved-push"; readonly digest: string | null };

export const RepositoryHooks = Context.Reference<RepositoryHooksPolicy>("t3/vcs/RepositoryHooks", {
  defaultValue: () => ({ _tag: "all" }),
});

/** Set by background discovery so its Git commands run in their own small lane, not the user's. */
export const BackgroundGitWork = Context.Reference<boolean>("t3/vcs/BackgroundGitWork", {
  defaultValue: () => false,
});

export class GitVcsDriver extends Context.Service<
  GitVcsDriver,
  {
    readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
    readonly status: (input: VcsStatusInput) => Effect.Effect<VcsStatusResult, GitCommandError>;
    readonly readCurrentBranch: (cwd: string) => Effect.Effect<string | null, GitCommandError>;
    readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly statusDetailsLocal: (
      cwd: string,
      options?: GitLocalStatusOptions,
    ) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly statusDetailsRemote: (
      cwd: string,
      options?: GitRemoteStatusOptions,
    ) => Effect.Effect<GitRemoteStatusDetails, GitCommandError>;
    /** Refs used by an explicit refresh and its branch-picker digest. */
    readonly readStatusRefreshRefs: (cwd: string) => Effect.Effect<string | null>;
    readonly readStatusPoll: (
      cwd: string,
      branch: string | null,
      refreshUpstream: boolean,
    ) => Effect.Effect<{
      readonly inputStamp: string;
      readonly inputStampAfterLookup: Effect.Effect<string | null>;
      readonly details: GitRemoteStatusDetails;
    } | null>;
    /** Branch-picker digest input, including worktree paths. */
    readonly readRefSnapshot: (cwd: string, refs?: string) => Effect.Effect<string | null>;
    readonly prepareCommitContext: (
      cwd: string,
      filePaths?: readonly string[],
      options?: { readonly includePatch?: boolean },
    ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;
    readonly commit: (
      cwd: string,
      subject: string,
      body: string,
      options?: GitCommitOptions,
    ) => Effect.Effect<{ commitSha: string }, GitCommandError | GitNothingToCommitError>;
    readonly pushCurrentBranch: (
      cwd: string,
      fallbackBranch: string | null,
      options?: { readonly remoteName?: string | null },
    ) => Effect.Effect<GitPushResult, GitCommandError>;
    /** The hooks a push from `cwd` would run now; null when it would run none. */
    readonly pushHooks: (cwd: string) => Effect.Effect<PushHooks | null, GitCommandError>;
    /** Where `pushCurrentBranch` would push the checked-out branch; null with no remote or when Git picks. */
    readonly resolvePushTarget: (
      cwd: string,
      current: {
        readonly branch: string;
        readonly hasUpstream: boolean;
        readonly remoteName?: string | undefined;
      },
    ) => Effect.Effect<GitPushTarget | null, GitCommandError>;
    readonly readRangeContext: (
      cwd: string,
      baseRef: string,
    ) => Effect.Effect<GitRangeContext, GitCommandError>;
    readonly getReviewBranchCommits: (
      input: ReviewBranchCommitsInput,
    ) => Effect.Effect<ReviewBranchCommitsResult, GitCommandError>;
    readonly getReviewDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, GitCommandError>;
    readonly getReviewDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, GitCommandError>;
    readonly readConfigValue: (
      cwd: string,
      key: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    /**
     * The branch, named as on the host, that T3 recorded `branch` was cut from. Null when none
     * was recorded.
     */
    readonly readBranchBase: (
      cwd: string,
      branch: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly resolveBranchName: (
      cwd: string,
      refName: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    /** Deletes the macOS worktree checkout cache in the background. */
    readonly clearWorktreeCheckoutCache: Effect.Effect<void>;
    /** Force-updates local `branch` to the primary remote's `ref`. */
    readonly fetchRefIntoBranch: (
      input: GitFetchRefInput & { readonly branch: string },
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchRefCommit: (
      input: GitFetchRefInput,
    ) => Effect.Effect<GitResolveCommitResult, GitCommandError>;
    readonly resolveCommit: (
      input: GitResolveCommitInput,
    ) => Effect.Effect<GitResolveCommitResult, GitCommandError>;
    readonly refreshCheckedOutBranch: (
      input: GitRefreshCheckedOutBranchInput,
    ) => Effect.Effect<GitRefreshCheckedOutBranchResult, GitCommandError>;
    readonly ensureRemote: (input: GitEnsureRemoteInput) => Effect.Effect<string, GitCommandError>;
    readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
    readonly resolveDefaultBranchName: (
      cwd: string,
      remoteName: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly fetchRemote: (input: GitFetchRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: GitRemoteExistsInput) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (
      input: GitRemoteBranchExistsInput,
    ) => Effect.Effect<boolean, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (
      input: GitResolveRemoteTrackingCommitInput,
    ) => Effect.Effect<GitResolveRemoteTrackingCommitResult, GitCommandError>;
    readonly resolveWorktreeBaseRemote: (
      input: GitFetchWorktreeBaseCommitInput,
    ) => Effect.Effect<GitWorktreeBaseRemote | null, GitCommandError>;
    /**
     * Fetches the configured upstream, explicit remote ref, or origin; null uses the local base.
     * A caller that already ran `resolveWorktreeBaseRemote` passes its result as `remote`.
     */
    readonly fetchWorktreeBaseCommit: (
      input: GitFetchWorktreeBaseCommitInput & { readonly remote?: GitWorktreeBaseRemote },
    ) => Effect.Effect<GitResolveRemoteTrackingCommitResult | null, GitCommandError>;
    readonly fetchRemoteBranch: (
      input: GitFetchRemoteBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchRemoteTrackingBranch: (
      input: GitFetchRemoteTrackingBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly setBranchUpstream: (
      input: GitSetBranchUpstreamInput,
    ) => Effect.Effect<void, GitCommandError>;
    /** Tracks the start point like `git branch` does. */
    readonly createBranch: (input: GitCreateBranchInput) => Effect.Effect<void, GitCommandError>;
    readonly writeConfigValue: (
      input: GitWriteConfigValueInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly listWorktreePaths: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly renameBranch: (
      input: GitRenameBranchInput,
    ) => Effect.Effect<GitRenameBranchResult, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly setPushRemote: (input: VcsSetPushRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly initRepo: (input: VcsInitInput) => Effect.Effect<void, GitCommandError>;
    /** Drops cached refs after something outside this driver changed them, such as a clone into `cwd`. */
    readonly invalidateRefs: (cwd: string) => Effect.Effect<void>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
  }
>()("t3/vcs/GitVcsDriver") {}

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const FLAGGED_INDEX_ENTRIES_MAX_BYTES = 1024 * 1024;
const CHECKPOINT_RECOVERY_MAX_CANDIDATES = 64;
const CHECKPOINT_RECOVERY_TIMEOUT = "5 seconds";
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
// Reflog subjects that only point a ref at an existing commit. Anything else counts as creating
// one, so an unknown subject keeps its commit attributed.
const REF_MOVE_REFLOG_SUBJECT =
  /^(?:$|(?:checkout|reset|branch|clone|fetch)\b|[^:]*\((?:start|finish|abort|reset)\): |(?:merge|pull|rebase|cherry-pick)\b[^()]*: fast-forward$)/i;

function parseCheckpointReflogEntry(line: string) {
  const [commit = "", selector = "", ...subject] = line.split(" ");
  return {
    commit,
    fetched: selector.startsWith("refs/remotes/"),
    subject: subject.join(" "),
  };
}

function isLocalReflogCreation(entry: ReturnType<typeof parseCheckpointReflogEntry>) {
  return !entry.fetched && !REF_MOVE_REFLOG_SUBJECT.test(entry.subject);
}

const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

const nowFreshness = Effect.fn("GitVcsDriver.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return {
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  };
});

function chunkPathsForGitCheckIgnore(relativePaths: ReadonlyArray<string>): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

function parseGitRemoteVerboseOutput(
  output: string,
): Map<string, { url?: string; pushUrl?: string }> {
  const remotes = new Map<string, { url?: string; pushUrl?: string }>();
  for (const line of output.split(/\r?\n/)) {
    // Git uses a tab before the URL and one space before the direction; both can occur in URLs.
    // Partial clones append the promisor filter, e.g. `(fetch) [blob:none]`.
    const match = /^(\S+)\t(.+) \((fetch|push)\)(?:\s+\[[^\]]+\])?$/.exec(line);
    if (!match) {
      continue;
    }

    const name = match[1];
    const url = match[2];
    const direction = match[3];
    if (!name || !url || !direction) {
      continue;
    }
    const remote = remotes.get(name) ?? {};
    if (direction === "fetch") {
      remote.url = url;
    } else {
      remote.pushUrl = url;
    }
    remotes.set(name, remote);
  }
  return remotes;
}

// Trace output and deprecation warnings can precede Git's own message, so check every line.
const hasStderrLine = (stderr: string, prefixes: ReadonlyArray<string>) =>
  stderr.split("\n").some((line) => prefixes.some((prefix) => line.startsWith(prefix)));

/** Operation of the error raised when Git cannot say whether a cwd is a work tree. */
export const WORK_TREE_PROBE_OPERATION = "GitVcsDriver.probeWorkTree";

const gitCommand = Effect.fn("GitVcsDriver.gitCommand")(
  (
    process: VcsProcess.VcsProcess["Service"],
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly stdin?: string;
      readonly onSpawn?: () => void;
      readonly env?: NodeJS.ProcessEnv;
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
      readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
      readonly appendTruncationMarker?: boolean;
    },
  ) =>
    process.run({
      operation,
      command: "git",
      args: ["-C", cwd, ...args],
      cwd,
      spawnCwd: globalThis.process.cwd(),
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options?.onSpawn !== undefined ? { onSpawn: options.onSpawn } : {}),
      ...(options?.env !== undefined ? { env: options.env } : {}),
      ...(options?.allowNonZeroExit !== undefined
        ? { allowNonZeroExit: options.allowNonZeroExit }
        : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options?.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
      ...(options?.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: options.appendTruncationMarker }
        : {}),
    }),
);

const HEAD_MOVES_SCAN_LIMIT = 512;
const HEAD_MARK_TRAILER = "T3-Head-Moved-At";
const HEAD_MARK_TRAILER_PATTERN = new RegExp(`^${HEAD_MARK_TRAILER}: (\\d+) (\\d+)$`, "m");

// Parses "git version 2.34.1" or "git version 2.45.1.windows.1".
const gitSupportsRemergeDiff = (versionOutput: string): boolean => {
  const match = /^git version (\d+)\.(\d+)/.exec(versionOutput);
  if (match === null) return false;
  const major = Number(match[1]);
  return major > 2 || (major === 2 && Number(match[2]) >= 36);
};

export const makeVcsDriverShape = Effect.fn("makeGitVcsDriverShape")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const random = yield* SecureRandom.SecureRandom;
  const hostPlatform = yield* HostProcess.Platform;
  // Returns stdout, or null when there is no work tree. A non-repository exits 128 like a broken
  // one, so only Git's message (pinned to the C locale) or a missing cwd tells them apart.
  const probeWorkTree = Effect.fn("GitVcsDriver.probeWorkTree")(function* (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    maxOutputBytes: number,
  ) {
    const result = yield* gitCommand(vcsProcess, operation, cwd, args, {
      env: { LC_ALL: "C" },
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes,
    }).pipe(Effect.catchIf(isMissingExecutable, () => Effect.succeed(null)));
    if (result === null) return null;
    if (result.exitCode === 0) return result.stdout;
    // Git before 2.38 answers "false" for a bare repo, then fails on --show-toplevel.
    // Match line prefixes only: a path inside a diagnostic may contain the same words.
    if (
      result.stdout.startsWith("false") ||
      hasStderrLine(result.stderr, [
        "fatal: not a git repository",
        "fatal: cannot use bare repository",
      ]) ||
      !(yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => true)))
    ) {
      return null;
    }
    return yield* new VcsProcessExitError({
      operation: WORK_TREE_PROBE_OPERATION,
      command: "git rev-parse",
      cwd,
      exitCode: result.exitCode,
      detail: result.stderr.trim() || "git rev-parse failed",
    });
  });

  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = (cwd) =>
    probeWorkTree(
      "GitVcsDriver.isInsideWorkTree",
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      4_096,
    ).pipe(Effect.map((stdout) => stdout?.trim() === "true"));

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    gitCommand(vcsProcess, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.onSpawn !== undefined ? { onSpawn: input.onSpawn } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
    });

  // --diff-merges=remerge needs Git 2.36.
  let remergeDiffSupported: boolean | undefined;
  const supportsRemergeDiff = Effect.fn("GitVcsDriver.supportsRemergeDiff")(function* (
    cwd: string,
  ) {
    if (remergeDiffSupported === undefined) {
      const version = yield* execute({
        operation: "GitVcsDriver.version",
        cwd,
        args: ["version"],
      }).pipe(Effect.option);
      if (Option.isNone(version)) return false;
      remergeDiffSupported = gitSupportsRemergeDiff(version.value.stdout);
    }
    return remergeDiffSupported;
  });

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "detectRepository",
  )(function* (cwd) {
    // One spawn answers all three; outside a work tree it exits non-zero or prints "false".
    const stdout = yield* probeWorkTree(
      "GitVcsDriver.detectRepository",
      cwd,
      ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--git-common-dir"],
      16_384,
    );
    if (stdout === null) return null;
    const lines = stdout.replace(/\n$/, "").split("\n");
    if (lines[0]?.trim() !== "true") return null;
    // A newline inside a path breaks the line framing; ask for each path on its own.
    if (lines.length !== 3) {
      const root = yield* gitCommand(vcsProcess, "GitVcsDriver.detectRepository", cwd, [
        "rev-parse",
        "--show-toplevel",
      ]);
      const gitCommonDir = yield* gitCommand(vcsProcess, "GitVcsDriver.detectRepository", cwd, [
        "rev-parse",
        "--git-common-dir",
      ]).pipe(Effect.orElseSucceed(() => null));
      return {
        kind: "git" as const,
        rootPath: root.stdout.replace(/\n$/, ""),
        metadataPath: gitCommonDir?.stdout.replace(/\n$/, "") || null,
        freshness: yield* nowFreshness(),
      };
    }

    return {
      kind: "git" as const,
      rootPath: lines[1]!,
      metadataPath: lines[2] || null,
      freshness: yield* nowFreshness(),
    };
  });

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.listWorkspaceFiles",
      cwd,
      [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      {
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.gen(function* () {
              const freshness = yield* nowFreshness();
              return {
                paths: splitNullSeparatedGitStdoutPaths(result),
                truncated: result.stdoutTruncated,
                freshness,
              };
            })
          : Effect.fail(
              new VcsProcessExitError({
                operation: "GitVcsDriver.listWorkspaceFiles",
                command: "git ls-files",
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || "git ls-files failed",
              }),
            ),
      ),
    );

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn("listRemotes")(
    function* (cwd) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.listRemotes",
        cwd,
        ["remote", "-v"],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
        },
      );

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.listRemotes",
          command: "git remote -v",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git remote -v failed",
        });
      }

      const parsed = parseGitRemoteVerboseOutput(result.stdout);
      const remotes = Array.from(parsed.entries()).flatMap(([name, remote]) => {
        if (!remote.url) {
          return [];
        }
        return [
          {
            name,
            url: remote.url,
            pushUrl: remote.pushUrl ? Option.some(remote.pushUrl) : Option.none(),
            isPrimary: name === "origin",
          },
        ];
      });

      return {
        remotes,
        freshness: yield* nowFreshness(),
      };
    },
  );

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) {
      return relativePaths;
    }

    const ignoredPaths = new Set<string>();
    // ./ avoids leading : pathspec magic; check-ignore rejects --literal-pathspecs.
    const chunks = chunkPathsForGitCheckIgnore(
      relativePaths.map((relativePath) => `./${relativePath}`),
    );

    for (const chunk of chunks) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.filterIgnoredPaths",
        cwd,
        [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
        {
          stdin: `${chunk.join("\0")}\0`,
          allowNonZeroExit: true,
          timeoutMs: 20_000,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      );

      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.filterIgnoredPaths",
          command: "git check-ignore",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git check-ignore failed",
        });
      }

      for (const ignoredPath of splitNullSeparatedGitStdoutPaths(result)) {
        ignoredPaths.add(ignoredPath.slice(2));
      }
    }

    if (ignoredPaths.size === 0) {
      return relativePaths;
    }

    return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
  });

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = (input) =>
    gitCommand(vcsProcess, "GitVcsDriver.initRepository", input.cwd, ["init"], {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    }).pipe(Effect.asVoid);

  const resolveHeadCommit = (cwd: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const hasHeadCommit = (cwd: string, env?: NodeJS.ProcessEnv) =>
    execute({
      operation: "GitVcsDriver.checkpoints.hasHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "HEAD"],
      allowNonZeroExit: true,
      ...(env !== undefined ? { env } : {}),
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveCheckpointCommit = (cwd: string, checkpointRef: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveCheckpointCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
      env: { LC_ALL: "C" },
      allowNonZeroExit: true,
    }).pipe(
      Effect.flatMap((result) => {
        // --quiet reports an absent ref as exit 1 with no error; an unreadable object also exits 1
        // but reports an error line.
        if (result.exitCode === 1 && !hasStderrLine(result.stderr, ["error:", "fatal:"])) {
          return Effect.succeed(null);
        }
        if (result.exitCode !== 0) {
          return Effect.fail(
            new VcsProcessExitError({
              operation: "GitVcsDriver.checkpoints.resolveCheckpointCommit",
              command: "git rev-parse",
              cwd,
              exitCode: result.exitCode,
              detail: result.stderr.trim() || "git rev-parse failed",
            }),
          );
        }
        const commit = result.stdout.trim();
        return Effect.succeed(commit.length > 0 ? commit : null);
      }),
    );

  // Git reports relative paths from the physical cwd, which can differ from a symlink.
  const resolveGitCommonDir = Effect.fn("GitVcsDriver.resolveGitCommonDir")(function* (
    cwd: string,
  ) {
    const result = yield* execute({
      operation: "GitVcsDriver.checkpoints.resolveGitCommonDir",
      cwd,
      args: ["rev-parse", "--git-common-dir"],
    });
    const gitCommonDir = result.stdout.replace(/\n$/, "");
    if (path.isAbsolute(gitCommonDir)) return gitCommonDir;
    const physicalCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    return path.resolve(physicalCwd, gitCommonDir);
  });

  // --verify prints HEAD after the paths; --quiet leaves only paths for an unborn HEAD.
  const resolveCaptureRepository = Effect.fn("GitVcsDriver.resolveCaptureRepository")(function* (
    cwd: string,
  ) {
    const result = yield* execute({
      operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
      cwd,
      args: [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--git-path",
        "index",
        "--show-toplevel",
        "--show-prefix",
        "--verify",
        "--quiet",
        "HEAD",
      ],
      allowNonZeroExit: true,
    });
    const headExists = result.exitCode === 0;
    const headChecked = headExists || result.exitCode === 1;
    const lines = result.stdout.split("\n");
    const [gitCommonDir = "", indexPath = "", topLevel = "", prefix = "", head = ""] = lines;
    if (headChecked && lines.length === (headExists ? 6 : 5) && lines.at(-1) === "") {
      return {
        gitCommonDir,
        indexPath,
        topLevel,
        prefix,
        headExists,
        head: headExists ? head : undefined,
      };
    }
    // Git before 2.31 echoes --path-format, and a path containing a newline spans lines.
    // Separate commands read the paths as before and report a failure the same way.
    const fallbackCommonDir = yield* resolveGitCommonDir(cwd);
    const prefixResult = yield* execute({
      operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
      cwd,
      args: ["rev-parse", "--show-prefix"],
    });
    return {
      gitCommonDir: fallbackCommonDir,
      indexPath: undefined,
      topLevel: undefined,
      prefix: prefixResult.stdout.replace(/\n$/, ""),
      headExists: headChecked ? headExists : yield* hasHeadCommit(cwd),
      head: undefined,
    };
  });

  // $displaypath is relative to cwd, so "../" marks submodules outside a nested workspace.
  const listSubmodules = Effect.fn("GitVcsDriver.listSubmodules")(function* (cwd: string) {
    const result = yield* execute({
      operation: "GitVcsDriver.checkpoints.listSubmodules",
      cwd,
      args: ["submodule", "foreach", "--quiet", 'printf "%s\\0" "$displaypath"'],
    });
    return result.stdout
      .split("\0")
      .filter((entry) => entry !== "" && !entry.startsWith("../"))
      .map((entry) => path.join(cwd, entry));
  });

  // Git defaults and macOS writeout-only can leave empty refs after crashes; flush before publication.
  // Set fsync first: Git 2.36 ignores unknown batch without resetting the method.
  // Batch fully flushes refs and equals fsync on macOS HFS+/APFS and Windows NTFS/ReFS.
  // Keep per-object fsync elsewhere; VcsProcess retries unsupported macOS full flushes with plain fsync.
  const durableWrite = [
    "-c",
    "core.fsync=objects,reference",
    "-c",
    "core.fsyncMethod=fsync",
    ...(hostPlatform === "darwin" || hostPlatform === "win32"
      ? ["-c", "core.fsyncMethod=batch"]
      : []),
  ] as const;

  // Checkpoints must handle existing paths beyond Windows MAX_PATH, even when
  // core.longpaths is disabled in the user's Git configuration.
  const longPaths = hostPlatform === "win32" ? ["-c", "core.longpaths=true"] : [];

  // Newest first: the commit each HEAD move landed on, when, and Git's reason for it.
  const readHeadMoves = (cwd: string) =>
    execute({
      operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
      cwd,
      args: [
        "-c",
        "log.showSignature=false",
        "log",
        "--walk-reflogs",
        "-n",
        String(HEAD_MOVES_SCAN_LIMIT),
        "--date=unix",
        "--format=%H %gd %gs",
        "HEAD",
        "--",
      ],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) =>
        result.exitCode !== 0
          ? []
          : result.stdout.split("\n").flatMap((line) => {
              const [, to, at, reason] = /^([0-9a-f]+) HEAD@\{(\d+)\} (.*)$/.exec(line) ?? [];
              return to === undefined || at === undefined || reason === undefined
                ? []
                : [{ to, at, reason }];
            }),
      ),
      Effect.orElseSucceed(() => []),
    );

  // A checkpoint taken after a branch switch has a second parent: the checkpoint before it with
  // the switch applied, which is where that turn started. Other ranges start at `from` itself.
  const resolveTurnStart = (input: VcsDriver.VcsListAuthoredPathsInput) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveTurnStart",
      cwd: input.cwd,
      args: [
        "-c",
        "log.showSignature=false",
        "log",
        "--no-walk=unsorted",
        "--format=%H %P",
        `${input.fromCheckpointRef}^{commit}`,
        `${input.toCheckpointRef}^2`,
      ],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result): string => {
        const [fromLine = "", startLine = ""] = result.stdout.trimEnd().split("\n");
        const [start = "", , startedFrom] = startLine.split(" ");
        return result.exitCode === 0 && startedFrom === fromLine.split(" ")[0]
          ? start
          : input.fromCheckpointRef;
      }),
    );

  // Nested checkouts have their own checkpoints; unexcluded, the outer one records them as gitlinks.
  const excludedPathspecs = (excludePaths: ReadonlyArray<string> | undefined) =>
    (excludePaths ?? []).map((relativePath) => `:(exclude,literal)${relativePath}`);

  const checkpointIdentity: NodeJS.ProcessEnv = {
    GIT_AUTHOR_NAME: "T3 Code",
    GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
    GIT_COMMITTER_NAME: "T3 Code",
    GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
  };

  // Index files known to hold no assume-unchanged or skip-worktree entry, by their stat. Setting
  // either flag rewrites the index, so a matching stat spares the scan that looks for them.
  const unflaggedIndexes = new Map<string, string>();

  // Status hides edits to assume-unchanged and skip-worktree entries; a capture reads them.
  const hasFlaggedIndexEntries = Effect.fn("GitVcsDriver.hasFlaggedIndexEntries")(function* (
    cwd: string,
  ) {
    // A linked worktree keeps its index elsewhere; it is scanned every time.
    const indexStat = yield* fileSystem.stat(path.join(cwd, ".git", "index")).pipe(
      Effect.map((info) =>
        Option.isSome(info.mtime) ? `${info.mtime.value.getTime()}:${info.size}` : null,
      ),
      Effect.orElseSucceed(() => null),
    );
    if (indexStat !== null && unflaggedIndexes.get(cwd) === indexStat) return false;
    let flagged = false;
    let recordStart = true;
    yield* vcsProcess.run({
      operation: "GitVcsDriver.checkpoints.resolveCleanHead",
      command: "git",
      cwd,
      args: ["ls-files", "-v", "-z"],
      maxOutputBytes: 1,
      outputMode: "truncate",
      // Only each record's leading tag matters; scan NUL-delimited records.
      onStdoutChunk: (chunk) => {
        let start = 0;
        while (start < chunk.length && !flagged) {
          if (recordStart) {
            const tag = chunk[start]!;
            flagged = (tag >= 97 && tag <= 122) || tag === 83;
          }
          const end = chunk.indexOf(0, start);
          recordStart = end !== -1;
          if (!recordStart) break;
          start = end + 1;
        }
      },
    });
    if (flagged) unflaggedIndexes.delete(cwd);
    else if (indexStat !== null) unflaggedIndexes.set(cwd, indexStat);
    return flagged;
  });
  const captureIndexes = CheckpointCaptureIndex.make(execute, fileSystem, path);

  type CaptureInput = VcsDriver.VcsCaptureCheckpointInput & { readonly rebuildIndex?: true };
  // Annotated: the body captures submodules through `checkpoints`, which closes the inference loop.
  const capture: {
    readonly once: (
      input: CaptureInput,
    ) => Effect.Effect<
      VcsDriver.VcsCheckpointRange | null,
      VcsError | CheckpointCaptureIndex.StaleCaptureIndex
    >;
  } = {
    once: Effect.fn("GitVcsDriver.checkpoints.captureCheckpoint")(function* (input: CaptureInput) {
      const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
      // git add rejects a pathspec naming an ignored folder, and skips that folder anyway.
      const exclusionPathspecs = excludedPathspecs(
        input.excludePaths === undefined || input.excludePaths.length === 0
          ? undefined
          : yield* filterIgnoredPaths(input.cwd, input.excludePaths),
      );
      // Scratch split-index writes can expire sharedindex files still used by the real index.
      const indexConfig = [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "sparse.expectFilesOutsideOfPatterns=false",
        "-c",
        "core.splitIndex=false",
        "-c",
        "splitIndex.sharedIndexExpire=never",
        // ignorestat marks entries update-index or add writes assume-unchanged, so a kept index
        // would hide later edits of them from add -A.
        "-c",
        "core.ignorestat=false",
      ];
      const { gitCommonDir, indexPath, topLevel, prefix, headExists, head } =
        yield* resolveCaptureRepository(input.cwd);
      // Read before the snapshot and pinned to the same HEAD: a switch that lands while files are
      // being staged then belongs to the next checkpoint instead of being applied to this one.
      const headMoves = head === undefined ? [] : yield* readHeadMoves(input.cwd);
      const lastMove = headMoves.at(0);
      // Moves share a second, so the mark also counts how many of that second it has seen.
      const headMark =
        lastMove !== undefined && lastMove.to === head
          ? `${lastMove.at} ${headMoves.filter((move) => move.at === lastMove.at).length}`
          : undefined;
      const indexId = yield* random.uuidV4();
      const tempIndexPath = path.join(gitCommonDir, `t3-checkpoint-index-${indexId}`);
      const hostEnv = yield* HostProcess.Environment;
      // VcsProcess clears inherited object selectors, so every other command uses this store.
      const sharedObjects = path.join(gitCommonDir, "objects");
      const quotedObjects = quoteGitPatchPath(sharedObjects);
      // Isolate bulk-checkin packs so cleanup cannot remove another Git writer's objects.
      const privateObjects = yield* Effect.acquireRelease(
        fileSystem
          .makeTempDirectory({ directory: sharedObjects, prefix: "tmp_objdir-t3-checkpoint-" })
          .pipe(
            Effect.mapError(
              (cause) =>
                new VcsCheckpointStorageError({
                  operation,
                  cwd: input.cwd,
                  stage: "isolate",
                  cause,
                }),
            ),
          ),
        (directory) =>
          fileSystem.remove(directory, { recursive: true, force: true }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not remove private checkpoint objects", {
                reason: cause.reason._tag,
              }),
            ),
          ),
      );
      // git-lfs's clean filter copies each file into <lfs.storage>/tmp while hashing it and strands
      // that copy when killed. Give it storage that is removed with the capture's private objects.
      const privateLfs = path.join(privateObjects, "lfs");
      const publishLfsObjects = Effect.gen(function* () {
        const source = path.join(privateLfs, "objects");
        const objects = (yield* fileSystem.readDirectory(source, { recursive: true }).pipe(
          // Absent when no file went through the filter; any other failure must stop publication.
          Effect.catchIf(
            (cause) => cause.reason._tag === "NotFound",
            () => Effect.succeed([]),
          ),
          Effect.mapError(
            (cause) =>
              new VcsCheckpointStorageError({
                operation,
                cwd: input.cwd,
                stage: "publish",
                cause,
              }),
          ),
        )).filter((entry) => /^[0-9a-f]{2}[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}$/.test(entry));
        if (objects.length === 0) return;
        const configured = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["config", "--null", "--get", "lfs.storage"],
          allowNonZeroExit: true,
        });
        // git-lfs reads config with -z and uses the value verbatim, spaces and tabs included.
        // It resolves a relative lfs.storage against the common Git directory.
        const configuredStorage = configured.stdout.split("\0", 1)[0] ?? "";
        const storage = path.resolve(gitCommonDir, configuredStorage || "lfs");
        yield* Effect.forEach(
          objects,
          (entry) =>
            Effect.gen(function* () {
              const from = path.join(source, entry);
              const to = path.join(storage, "objects", entry);
              if (yield* fileSystem.exists(to)) return;
              yield* fileSystem.makeDirectory(path.dirname(to), { recursive: true });
              // Identical oids are interchangeable, so losing a race to another writer is fine.
              // lfs.storage may be on another volume, where only a copy can move the object.
              const partial = `${to}.${indexId}`;
              yield* fileSystem.rename(from, to).pipe(
                Effect.catch((cause) =>
                  Effect.flatMap(fileSystem.exists(to), (exists) =>
                    exists
                      ? Effect.void
                      : fileSystem.copyFile(from, partial).pipe(
                          Effect.andThen(fileSystem.rename(partial, to)),
                          Effect.ensuring(
                            fileSystem.remove(partial, { force: true }).pipe(Effect.ignore),
                          ),
                          Effect.mapError(() => cause),
                        ),
                  ),
                ),
              );
            }),
          { concurrency: 16, discard: true },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new VcsCheckpointStorageError({ operation, cwd: input.cwd, stage: "publish", cause }),
          ),
        );
      });
      const commitEnv: NodeJS.ProcessEnv = {
        GIT_INDEX_FILE: tempIndexPath,
        GIT_OBJECT_DIRECTORY: privateObjects,
        // A filter must not publish refs that depend on our disposable store.
        GIT_QUARANTINE_PATH: privateObjects,
        // Git accepts C-quoted alternate paths, including path-list separators.
        GIT_ALTERNATE_OBJECT_DIRECTORIES: quotedObjects.startsWith('"')
          ? quotedObjects
          : `"${quotedObjects}"`,
        GIT_AUTHOR_NAME: "T3 Code",
        GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
        GIT_COMMITTER_NAME: "T3 Code",
        GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
        // Any command on the scratch index can run the clean filter, not just add.
        ...VcsProcess.gitConfigEnv(hostEnv, "lfs.storage", privateLfs, hostPlatform),
      };

      const keptIndexPath = `${tempIndexPath}.keep`;
      const cleanupTempIndex = Effect.forEach(
        [tempIndexPath, `${tempIndexPath}.lock`, keptIndexPath],
        (indexFile) => fileSystem.remove(indexFile, { force: true }).pipe(Effect.ignore),
        { discard: true },
      );

      const range = yield* Effect.gen(function* () {
        // One read for sparse checkout and the config deciding the blobs of unchanged files.
        const config = yield* execute({
          operation,
          cwd: input.cwd,
          args: [
            "config",
            "--null",
            "--get-regexp",
            "^(core\\.(sparsecheckout|autocrlf|eol|filemode|symlinks|ignorecase|precomposeunicode|checkstat|trustctime|ignorestat|attributesfile|checkroundtripencoding)|filter\\..*)$",
          ],
          allowNonZeroExit: true,
        });
        const sparseValue = CheckpointCaptureIndex.lastConfigValue(
          config.stdout,
          "core.sparsecheckout",
        );
        let sparseCheckout =
          sparseValue !== undefined && CheckpointCaptureIndex.gitBool(sparseValue);
        if (sparseCheckout) {
          const help = yield* execute({
            operation,
            cwd: input.cwd,
            args: ["add", "-h"],
            allowNonZeroExit: true,
          });
          sparseCheckout = /--(?:\[no-\])?sparse\b/.test(`${help.stdout}${help.stderr}`);
        }
        // The working-tree root is never ignored. Probe a subdirectory without the trailing slash
        // Git adds to ".", which a blank or whitespace-only ignore line matches as an empty pattern.
        const workspaceIgnored =
          prefix !== "" &&
          (yield* filterIgnoredPaths(input.cwd, [`../${prefix.slice(0, -1).split("/").at(-1)}`]))
            .length === 0;
        const captureIndex =
          head === undefined || topLevel === undefined || sparseCheckout || workspaceIgnored
            ? undefined
            : {
                location: captureIndexes.locate({
                  gitCommonDir,
                  checkpointRef: input.checkpointRef,
                  cwd: input.cwd,
                }),
                fingerprint: yield* captureIndexes.fingerprint({
                  cwd: input.cwd,
                  config: `${config.exitCode}\0${config.stdout}`,
                  gitCommonDir,
                  topLevel,
                  prefix,
                  hostEnv,
                }),
              };
        const previousTree =
          captureIndex === undefined || input.rebuildIndex === true
            ? undefined
            : yield* captureIndexes.claim({
                ...captureIndex,
                topLevel: topLevel!,
                prefix,
                excludePaths: input.excludePaths ?? [],
                head: head!,
                indexFile: tempIndexPath,
                env: commitEnv,
                indexConfig,
              });
        if (headExists && previousTree === undefined) {
          const reusedIndex = yield* Effect.gen(function* () {
            const userIndexPath =
              indexPath ??
              (yield* execute({
                operation,
                cwd: input.cwd,
                args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
              })).stdout.trim();
            const { mtime } = yield* fileSystem.stat(userIndexPath);
            if (Option.isNone(mtime)) return false;
            // Stay below the source timestamp even if Date rounded up, preserving Git's racy check.
            const indexTime = Math.floor((mtime.value.getTime() - 1) / 1000);
            if (indexTime <= 0) return false;
            yield* fileSystem.copyFile(userIndexPath, tempIndexPath);
            yield* execute({
              operation,
              cwd: input.cwd,
              args: [...indexConfig, "read-tree", "--reset", "HEAD"],
              env: commitEnv,
            });
            // read-tree can rewrite the index, so restore its racy timestamp afterward.
            yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
            // Manually flagged entries hide edits from add -A, so they are re-added below
            // with no stat cache. Every other entry keeps its stat data and is not rehashed.
            let fallback = false;
            let flaggedBytes = 0;
            let recordStart = true;
            let collect: "flagged" | "skipped" | undefined;
            let record: Uint8Array[] = [];
            const flagged: string[] = [];
            const skipped: string[] = [];
            yield* vcsProcess.run({
              operation,
              command: "git",
              cwd: input.cwd,
              args: [...indexConfig, "ls-files", "--full-name", "--sparse", "--stage", "-v", "-z"],
              env: commitEnv,
              maxOutputBytes: 4_096,
              outputMode: "truncate",
              // Only tags and flagged or skip-worktree records matter; scan NUL-delimited records.
              onStdoutChunk: (chunk) => {
                let start = 0;
                while (start < chunk.length && !fallback) {
                  const end = chunk.indexOf(0, start);
                  if (recordStart) {
                    const tag = chunk[start]!;
                    record = [];
                    // Sparse skip-worktree bits are expected; only in-cone ones are manual.
                    collect =
                      tag === 83 && sparseCheckout
                        ? "skipped"
                        : (tag >= 97 && tag <= 122) || tag === 83
                          ? "flagged"
                          : undefined;
                    // index-info cannot keep skip-worktree while dropping assume-unchanged.
                    if (tag === 115 && sparseCheckout) fallback = true;
                  }
                  if (collect !== undefined && !fallback) {
                    const piece = chunk.subarray(start, end === -1 ? undefined : end);
                    record.push(Buffer.from(piece));
                    if (
                      collect === "flagged" &&
                      (flaggedBytes += piece.length) > FLAGGED_INDEX_ENTRIES_MAX_BYTES
                    )
                      fallback = true;
                    if (end !== -1 && !fallback) {
                      const full = Buffer.concat(record);
                      record = [];
                      // Sparse directory entries stay collapsed.
                      if (collect === "flagged" || full.at(-1) !== 47) {
                        // Drop the "<tag> " prefix, leaving index-info's "<mode> <oid> <stage>\t<path>".
                        const entry = full.subarray(2);
                        if (!NodeBuffer.isUtf8(entry)) fallback = true;
                        else
                          (collect === "flagged" ? flagged : skipped).push(entry.toString("utf8"));
                      }
                    }
                  }
                  recordStart = end !== -1;
                  if (!recordStart) break;
                  start = end + 1;
                }
              },
            });
            if (fallback) return false;
            if (skipped.length > 0) {
              const paths = skipped.map((entry) => entry.slice(entry.indexOf("\t") + 1));
              const stdin = paths.join("\0") + "\0";
              // check-rules echoes a subset of its input, so the input size bounds its output.
              const rules = yield* execute({
                operation,
                cwd: input.cwd,
                args: [...indexConfig, "sparse-checkout", "check-rules", "-z"],
                stdin,
                env: commitEnv,
                maxOutputBytes: Buffer.byteLength(stdin),
                outputMode: "error",
              });
              const selected = new Set(rules.stdout.split("\0"));
              skipped.forEach((entry, index) => {
                if (selected.has(paths[index]!)) flagged.push(entry);
              });
            }
            if (flagged.length > 0) {
              // Flagged gitlinks keep the fresh-index behaviour rather than a guessed one.
              if (flagged.some((entry) => entry.startsWith("160000 "))) return false;
              yield* execute({
                operation,
                cwd: input.cwd,
                args: [...indexConfig, "update-index", "-z", "--index-info"],
                stdin: flagged.join("\0") + "\0",
                env: commitEnv,
              });
              yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
            }
            return true;
          }).pipe(Effect.orElseSucceed(() => false));
          if (!reusedIndex) {
            if (sparseCheckout) {
              const cone = yield* execute({
                operation,
                cwd: input.cwd,
                args: ["config", "--bool", "core.sparseCheckoutCone"],
                allowNonZeroExit: true,
              });
              // Rebuilding a non-cone index loses exclusions; do not publish false deletions.
              if (cone.stdout.trim() !== "true") {
                return yield* new VcsProcessExitError({
                  operation,
                  command: "git read-tree",
                  cwd: input.cwd,
                  exitCode: 1,
                  detail: "Cannot rebuild a checkpoint index for non-cone sparse checkout.",
                });
              }
            }
            yield* cleanupTempIndex;
            yield* execute({
              operation,
              cwd: input.cwd,
              args: sparseCheckout
                ? [...indexConfig, "-c", "index.sparse=true", "read-tree", "--reset", "HEAD"]
                : [...indexConfig, "read-tree", "HEAD"],
              env: commitEnv,
            });
          }
        }

        if (workspaceIgnored) {
          // HEAD omits staged-only paths. Seed just this workspace's additions, keeping
          // unrelated staged changes and the scratch index's sparse flags untouched.
          const additions = yield* execute({
            operation,
            cwd: input.cwd,
            args: [
              "-c",
              "core.quotePath=true",
              "diff",
              "--cached",
              "--raw",
              "--no-abbrev",
              "--no-renames",
              "--no-relative",
              "--ignore-submodules=none",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--ita-visible-in-index",
              "--diff-filter=A",
              "--",
              ".",
            ],
            maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
            outputMode: "error",
          });
          if (additions.stdout.length > 0) {
            // Git's quoted paths round-trip through index-info, including non-UTF-8 names.
            yield* execute({
              operation,
              cwd: input.cwd,
              args: [...indexConfig, "-c", "index.sparse=false", "update-index", "--index-info"],
              stdin: additions.stdout.replace(
                /^:000000 ([0-7]{6}) 0+ ([0-9a-f]+) A\t/gm,
                "$1 $2\t",
              ),
              env: commitEnv,
            });
          }
          const tracked = yield* execute({
            operation,
            cwd: input.cwd,
            args: [...indexConfig, "ls-files", "--cached", "-z", "--", "."],
            env: commitEnv,
            maxOutputBytes: 1,
            outputMode: "truncate",
          });
          if (tracked.stdout.length === 0) {
            return yield* new VcsUnsupportedOperationError({
              operation,
              kind: "git",
              detail: "The workspace directory is ignored by its Git repository.",
            });
          }
        }

        const stageFiles = (exclusions: ReadonlyArray<string>, ignoreErrors = false) =>
          execute({
            operation,
            cwd: input.cwd,
            args: [
              ...indexConfig,
              ...durableWrite,
              ...longPaths,
              // safecrlf=true refuses LF files under CRLF conversion; capture them as Git's default does.
              "-c",
              "core.safecrlf=false",
              "add",
              // Unreadable files keep their indexed version and unreadable new files are left out.
              ...(ignoreErrors ? ["--ignore-errors"] : []),
              ...(sparseCheckout ? ["--sparse"] : []),
              // add -A rejects ignored directories even when they contain tracked files.
              workspaceIgnored ? "-u" : "-A",
              "--",
              ".",
              ...exclusionPathspecs,
              ...exclusions,
            ],
            env: commitEnv,
          }).pipe(
            // With --ignore-errors, exit 1 only reports the files it skipped.
            Effect.catchIf(
              (error) =>
                ignoreErrors && error._tag === "VcsProcessExitError" && error.exitCode === 1,
              () => Effect.void,
            ),
          );
        yield* stageFiles([]).pipe(
          Effect.catchTags({
            VcsProcessExitError: (error) =>
              Effect.gen(function* () {
                // Recovery keeps indexed versions of unreadable files, which must be HEAD's.
                if (previousTree !== undefined) {
                  return yield* new CheckpointCaptureIndex.StaleCaptureIndex();
                }
                // Git cannot stage uncommitted embedded repos; scan for them only after staging fails.
                const untracked = yield* execute({
                  operation,
                  cwd: input.cwd,
                  args: [
                    ...longPaths,
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "-z",
                    "--",
                    ".",
                  ],
                  env: commitEnv,
                  maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
                });
                if (untracked.stdoutTruncated) return yield* error;
                const candidates = splitNullSeparatedGitStdoutPaths(untracked).filter((entry) =>
                  entry.endsWith("/"),
                );
                if (candidates.length > CHECKPOINT_RECOVERY_MAX_CANDIDATES) return yield* error;
                const nestedRepoEnv: NodeJS.ProcessEnv = {
                  ...hostEnv,
                  GIT_DIR: undefined,
                  GIT_WORK_TREE: undefined,
                  GIT_COMMON_DIR: undefined,
                  GIT_INDEX_FILE: undefined,
                  GIT_OBJECT_DIRECTORY: undefined,
                  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
                  GIT_QUARANTINE_PATH: undefined,
                };
                const exclusions: Array<string> = [];
                for (const entry of candidates) {
                  const nestedCwd = path.join(input.cwd, entry);
                  if (
                    (yield* fileSystem
                      .exists(path.join(nestedCwd, ".git"))
                      .pipe(Effect.mapError(() => error))) &&
                    !(yield* hasHeadCommit(nestedCwd, nestedRepoEnv))
                  ) {
                    exclusions.push(`:(exclude,literal)${entry}`);
                  }
                }
                return yield* stageFiles(exclusions, true);
              }).pipe(
                Effect.timeoutOrElse({
                  duration: CHECKPOINT_RECOVERY_TIMEOUT,
                  orElse: () => Effect.fail(error),
                }),
              ),
          }),
        );

        const writeTreeResult = yield* execute({
          operation,
          cwd: input.cwd,
          args: [...indexConfig, ...durableWrite, "write-tree"],
          env: commitEnv,
        });
        const treeOid = writeTreeResult.stdout.trim();
        if (treeOid.length === 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git write-tree",
            cwd: input.cwd,
            exitCode: 0,
            detail: "git write-tree returned an empty tree oid.",
          });
        }
        // Git converts a file whose stat is unchanged by the rules it was first hashed under.
        if (
          previousTree !== undefined &&
          (yield* captureIndexes.attributesChanged({
            cwd: input.cwd,
            previousTree,
            tree: treeOid,
            env: commitEnv,
          }))
        ) {
          return yield* new CheckpointCaptureIndex.StaleCaptureIndex();
        }
        // Hard-linked now: the branch-switch start below rewrites the scratch index.
        const keptIndex =
          captureIndex === undefined
            ? false
            : yield* fileSystem.link(tempIndexPath, keptIndexPath).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );

        // Read once: it is both where a branch switch is replayed from and the turn's range.
        const previousCheckpointRef = input.previousCheckpointRef;
        const previous =
          previousCheckpointRef === undefined
            ? null
            : yield* execute({
                operation,
                cwd: input.cwd,
                args: [
                  "-c",
                  "log.showSignature=false",
                  "log",
                  "--no-walk",
                  "--format=%H %T %ct %P%n%B",
                  `${previousCheckpointRef}^{commit}`,
                ],
                allowNonZeroExit: true,
              }).pipe(
                Effect.map((result) => {
                  if (result.exitCode !== 0) return null;
                  const [commit = "", tree = "", capturedAt = "", head = ""] = result.stdout
                    .slice(0, result.stdout.indexOf("\n"))
                    .split(" ");
                  return commit === "" || tree === ""
                    ? null
                    : { commit, tree, capturedAt, head, message: result.stdout };
                }),
                Effect.catch((cause) =>
                  Effect.logWarning("previous checkpoint lookup failed", {
                    cwd: input.cwd,
                    checkpointRef: previousCheckpointRef,
                    errorTag: cause._tag,
                  }).pipe(Effect.as(null)),
                ),
              );

        // Switching branches rewrites files the turn never wrote, and only HEAD's reflog tells a
        // switch from a reset. The trailer marks where that reflog stood for the next checkpoint.
        const turnStart =
          headMark === undefined || previous === null
            ? null
            : yield* Effect.gen(function* () {
                const { commit, tree, capturedAt, head: previousHead } = previous;
                const [, markedAt, markedCount] =
                  HEAD_MARK_TRAILER_PATTERN.exec(previous.message) ?? [];
                const oldestMarked = headMoves.findLastIndex((move) => move.at === markedAt);
                // -1 when the scan ended inside the marked second, so the count cannot be placed.
                const since =
                  oldestMarked === HEAD_MOVES_SCAN_LIMIT - 1
                    ? -1
                    : oldestMarked - Number(markedCount) + 1;
                if (headMoves[since]?.to !== previousHead) return null;
                const switches = headMoves
                  .slice(0, since)
                  .map((move, index) => ({ ...move, from: headMoves[index + 1]!.to }))
                  .filter(
                    (move) =>
                      move.reason.startsWith("checkout: moving from ") && move.from !== move.to,
                  )
                  .toReversed();
                const landedOn = switches.at(-1)?.to;
                if (landedOn === undefined) return null;

                yield* execute({
                  operation,
                  cwd: input.cwd,
                  args: [...indexConfig, "-c", "index.sparse=false", "read-tree", tree],
                  env: commitEnv,
                });
                for (const { from, to } of switches) {
                  const changes = yield* execute({
                    operation,
                    cwd: input.cwd,
                    args: [
                      "-c",
                      "core.quotePath=true",
                      "diff-tree",
                      "-r",
                      "--no-renames",
                      from,
                      to,
                    ],
                    maxOutputBytes: VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
                    outputMode: "error",
                  });
                  // A switch succeeds only where the files it replaces were unmodified, so each
                  // changed path takes the destination's version. Mode 000000 drops the path.
                  const entries = changes.stdout
                    .split("\n")
                    // A switch leaves a submodule's own checkout where it was.
                    .filter((line) => line !== "" && !/^:(?:160000 |[0-7]{6} 160000 )/.test(line))
                    .map((line) =>
                      line.replace(
                        /^:[0-7]{6} ([0-7]{6}) [0-9a-f]+ ([0-9a-f]+) [A-Z]\t/,
                        "$1 $2\t",
                      ),
                    );
                  if (entries.length === 0) continue;
                  yield* execute({
                    operation,
                    cwd: input.cwd,
                    args: [
                      ...indexConfig,
                      "-c",
                      "index.sparse=false",
                      "update-index",
                      "--index-info",
                    ],
                    stdin: `${entries.join("\n")}\n`,
                    env: commitEnv,
                  });
                }
                const startTree = (yield* execute({
                  operation,
                  cwd: input.cwd,
                  args: [...indexConfig, ...durableWrite, "write-tree"],
                  env: commitEnv,
                })).stdout.trim();
                if (startTree === "" || startTree === tree) return null;
                const startCommit = yield* execute({
                  operation,
                  cwd: input.cwd,
                  args: [
                    ...durableWrite,
                    "commit-tree",
                    startTree,
                    "-p",
                    landedOn,
                    "-p",
                    commit,
                    "-m",
                    `t3 checkpoint turn start ref=${input.checkpointRef}`,
                  ],
                  // listAuthoredPaths reads commits newer than the start as the turn's own.
                  env: { ...commitEnv, GIT_COMMITTER_DATE: `${capturedAt} +0000` },
                });
                const startOid = startCommit.stdout.trim();
                return startOid === "" ? null : { commit: startOid, tree: startTree, landedOn };
              }).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("checkpoint branch switch turn start failed", {
                    cwd: input.cwd,
                    checkpointRef: input.checkpointRef,
                    cause: String(cause),
                  }).pipe(Effect.as(null)),
                ),
              );

        const message = `t3 checkpoint ref=${input.checkpointRef}${
          headMark === undefined ? "" : `\n\n${HEAD_MARK_TRAILER}: ${headMark}`
        }`;
        // Git before 2.31 leaves `head` unread; a range names the parent the commit got.
        const parentHead =
          !headExists || head !== undefined
            ? (head ?? "")
            : previous === null
              ? ""
              : ((yield* resolveHeadCommit(input.cwd)) ?? "");
        // HEAD is the first parent so listAuthoredPaths can see how HEAD moved between checkpoints.
        const commitTreeResult = yield* execute({
          operation,
          cwd: input.cwd,
          args: [
            ...durableWrite,
            "commit-tree",
            treeOid,
            ...(headExists ? ["-p", parentHead || "HEAD"] : []),
            ...(turnStart === null ? [] : ["-p", turnStart.commit]),
            "-m",
            message,
          ],
          env: commitEnv,
        });
        const commitOid = commitTreeResult.stdout.trim();
        if (commitOid.length === 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git commit-tree",
            cwd: input.cwd,
            exitCode: 0,
            detail: "git commit-tree returned an empty commit oid.",
          });
        }

        yield* publishLfsObjects;
        // Git writers have exited; bound publication by fanout directory.
        yield* fileSystem.readDirectory(privateObjects).pipe(
          Effect.flatMap((directories) =>
            Effect.forEach(
              directories.filter(
                (directory) => directory === "pack" || /^[0-9a-f]{2}$/.test(directory),
              ),
              (directory) =>
                Effect.gen(function* () {
                  const source = path.join(privateObjects, directory);
                  const destination = path.join(sharedObjects, directory);
                  // Most fanouts already exist; avoid constructing an EEXIST error
                  // for each of them on every capture. mkdir still handles the race.
                  if (!(yield* fileSystem.exists(destination)))
                    yield* fileSystem.makeDirectory(destination).pipe(
                      Effect.andThen(
                        Effect.gen(function* () {
                          // Git has already applied core.sharedRepository to the source.
                          // chmod bypasses umask, but never changes a pre-existing bucket.
                          const { mode } = yield* fileSystem.stat(source);
                          yield* fileSystem.chmod(destination, mode & 0o7777);
                        }),
                      ),
                      Effect.catchIf(
                        (cause) => cause.reason._tag === "AlreadyExists",
                        () => Effect.void,
                      ),
                      Effect.uninterruptible,
                    );
                  const names = yield* fileSystem.readDirectory(source);
                  // Per-object spans would swamp the capture span for large workspaces.
                  const linkObject = Effect.fnUntraced(function* (name: string) {
                    const from = path.join(source, name);
                    const to = path.join(destination, name);
                    yield* fileSystem.link(from, to).pipe(
                      Effect.catchIf(
                        (cause) =>
                          cause.reason._tag === "PermissionDenied" ||
                          cause.reason._tag === "Unknown",
                        () =>
                          Effect.gen(function* () {
                            if (yield* fileSystem.exists(to)) return;
                            // Git also falls back to rename without hardlinks; identical object names are interchangeable.
                            yield* fileSystem.rename(from, to);
                          }),
                      ),
                      Effect.catchIf(
                        (cause) => cause.reason._tag === "AlreadyExists",
                        () => Effect.void,
                      ),
                    );
                  });
                  if (directory !== "pack") {
                    yield* Effect.forEach(
                      names.filter((name) => /^(?:[0-9a-f]{38}|[0-9a-f]{62})$/.test(name)),
                      linkObject,
                      { discard: true },
                    );
                    return;
                  }
                  const files = new Set(names);
                  for (const name of names) {
                    if (!/^pack-(?:[0-9a-f]{40}|[0-9a-f]{64})\.pack$/.test(name)) continue;
                    const base = name.slice(0, -5);
                    if (!files.has(`${base}.idx`)) continue;
                    // Link metadata before the pack so an I/O error cannot strand a
                    // large unindexed pack. Defer cancellation across this short group
                    // of links. Never roll back shared links: a concurrent writer may
                    // already depend on them. Ref publication still happens last.
                    yield* Effect.forEach(
                      [".keep", ".promisor", ".rev", ".idx", ".pack"]
                        .map((extension) => `${base}${extension}`)
                        .filter((file) => files.has(file)),
                      linkObject,
                      { discard: true },
                    ).pipe(Effect.uninterruptible);
                  }
                }),
              { concurrency: 16, discard: true },
            ),
          ),
          Effect.mapError(
            (cause) =>
              new VcsCheckpointStorageError({ operation, cwd: input.cwd, stage: "publish", cause }),
          ),
        );

        yield* execute({
          operation,
          cwd: input.cwd,
          args: [...durableWrite, "update-ref", input.checkpointRef, commitOid],
        });
        if (captureIndex !== undefined && keptIndex) {
          yield* captureIndexes.save({
            ...captureIndex,
            indexFile: keptIndexPath,
            tree: treeOid,
          });
        }
        if (previous === null) return null;
        // A turn start is committed at the previous checkpoint's time, after `landedOn`.
        return {
          from: turnStart?.commit ?? previous.commit,
          to: commitOid,
          fromCapturedAt: previous.capturedAt,
          startHead: turnStart?.landedOn ?? previous.head,
          endHead: parentHead,
          unchanged: treeOid === (turnStart?.tree ?? previous.tree),
        } satisfies VcsDriver.VcsCheckpointRange;
      }).pipe(Effect.ensuring(cleanupTempIndex));

      // The tree records only each submodule's HEAD, so submodules keep their own ref.
      const hasSubmodules =
        topLevel === undefined ||
        (yield* fileSystem
          .exists(path.join(topLevel, ".gitmodules"))
          .pipe(Effect.orElseSucceed(() => true)));
      if (!hasSubmodules) return range;
      // A submodule that cannot be captured drops its ref, so restore leaves it alone.
      yield* listSubmodules(input.cwd).pipe(
        Effect.flatMap((submodules) =>
          Effect.forEach(
            submodules,
            (cwd) =>
              checkpoints
                .captureCheckpoint({ cwd, checkpointRef: input.checkpointRef })
                .pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("submodule checkpoint capture failed", { cwd, cause }).pipe(
                      Effect.andThen(
                        checkpoints
                          .deleteCheckpointRefs({ cwd, checkpointRefs: [input.checkpointRef] })
                          .pipe(Effect.ignore),
                      ),
                    ),
                  ),
                ),
            { discard: true },
          ),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("submodule checkpoint capture failed", { cwd: input.cwd, cause }),
        ),
      );
      return range;
    }, Effect.scoped),
  };

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    // A kept index that turns out stale costs one more capture, rebuilt as before.
    captureCheckpoint: (input) =>
      capture.once(input).pipe(
        Effect.catchTags({
          StaleCaptureIndex: () => capture.once({ ...input, rebuildIndex: true }),
        }),
        // Without a kept index nothing can be stale.
        Effect.catchTags({ StaleCaptureIndex: (error) => Effect.die(error) }),
      ),

    resolveCleanHead: Effect.fn("GitVcsDriver.checkpoints.resolveCleanHead")(function* (cwd) {
      // One status reads both, so a moving HEAD cannot pair one commit with another's cleanliness.
      const status = yield* execute({
        operation: "GitVcsDriver.checkpoints.resolveCleanHead",
        cwd,
        args: [
          "-c",
          "core.fsmonitor=false",
          "status",
          "--porcelain=v2",
          "--branch",
          "--untracked-files=normal",
          "--ignore-submodules=none",
        ],
        // A status that refreshes the index would take the lock a user's Git command needs.
        env: { GIT_OPTIONAL_LOCKS: "0" },
        maxOutputBytes: 4_096,
        outputMode: "truncate",
      });
      if (status.stdoutTruncated) return null;
      const lines = status.stdout.split("\n").filter((line) => line.length > 0);
      if (lines.some((line) => !line.startsWith("# "))) return null;
      const head = lines.find((line) => line.startsWith("# branch.oid "))?.slice(13);
      if (head === undefined || !/^[0-9a-f]{40,64}$/.test(head)) return null;
      return (yield* hasFlaggedIndexEntries(cwd)) ? null : head;
    }),

    captureHeadCheckpoint: Effect.fn("GitVcsDriver.checkpoints.captureHeadCheckpoint")(
      function* (input) {
        const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
        // Where HEAD's reflog stood when the folder was seen: the next capture needs the mark to
        // tell a branch switch. Later moves in that same second count only if they end on `head`.
        const seenAt = input.seenAt;
        const headMoves = (yield* readHeadMoves(input.cwd)).filter(
          (move) => seenAt === undefined || Number(move.at) <= seenAt,
        );
        const lastMove = headMoves.at(0);
        const headMark =
          lastMove !== undefined && lastMove.to === input.head
            ? `${lastMove.at} ${headMoves.filter((move) => move.at === lastMove.at).length}`
            : undefined;
        const commit = yield* execute({
          operation,
          cwd: input.cwd,
          args: [
            ...durableWrite,
            "commit-tree",
            `${input.head}^{tree}`,
            "-p",
            input.head,
            "-m",
            `t3 checkpoint ref=${input.checkpointRef}${
              headMark === undefined ? "" : `\n\n${HEAD_MARK_TRAILER}: ${headMark}`
            }`,
          ],
          env:
            input.seenAt === undefined
              ? checkpointIdentity
              : { ...checkpointIdentity, GIT_COMMITTER_DATE: `@${input.seenAt} +0000` },
        });
        yield* execute({
          operation,
          cwd: input.cwd,
          args: [...durableWrite, "update-ref", input.checkpointRef, commit.stdout.trim()],
        });
      },
    ),

    hasCheckpointRef: (input) =>
      resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
        Effect.map((commit) => commit !== null),
      ),

    copyCheckpointRef: Effect.fn("GitVcsDriver.checkpoints.copyCheckpointRef")(function* (input) {
      const commit = yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef);
      if (commit === null || (yield* listSubmodules(input.cwd)).length > 0) return false;
      return yield* execute({
        operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
        cwd: input.cwd,
        // An empty old value creates the ref only if it is absent.
        args: [...durableWrite, "update-ref", input.toCheckpointRef, commit, ""],
      }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.flatMap(resolveCheckpointCommit(input.cwd, input.toCheckpointRef), (existing) =>
            existing === null ? Effect.fail(error) : Effect.succeed(true),
          ),
        ),
      );
    }),

    restoreCheckpoint: Effect.fn("GitVcsDriver.checkpoints.restoreCheckpoint")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.restoreCheckpoint";

      let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

      if (!commitOid && input.fallbackToHead === true) {
        commitOid = yield* resolveHeadCommit(input.cwd);
      }

      if (!commitOid) {
        return false;
      }
      // Folders with checkpoints of their own are another restore's to change.
      const scope = [".", ...excludedPathspecs(input.excludePaths)];

      const tracked = yield* execute({
        operation,
        cwd: input.cwd,
        args: ["ls-files", "--cached", `--with-tree=${commitOid}`, "-z", "--", ...scope],
      });
      const sparseConfig =
        tracked.stdout.length > 0
          ? yield* execute({
              operation,
              cwd: input.cwd,
              args: ["config", "--bool", "core.sparseCheckout"],
              allowNonZeroExit: true,
            })
          : null;
      const sparseCheckout = sparseConfig?.stdout.trim() === "true";
      // Restoring away the last tracked file can remove a nested workspace directory.
      const recreateWorkspace = fileSystem.makeDirectory(input.cwd, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProcessExitError({
              operation,
              command: "git restore",
              cwd: input.cwd,
              exitCode: 0,
              detail: `Could not recreate the checkpoint workspace: ${cause.message}`,
            }),
        ),
      );
      const resetIndex = Effect.gen(function* () {
        // On Windows clean can remove './' and exit 0.
        yield* recreateWorkspace;
        yield* execute({
          operation,
          cwd: input.cwd,
          args: [...longPaths, "reset", "--quiet", "--", ...scope],
        });
      });
      let mutationStarted = false;
      const onSpawn = () => {
        mutationStarted = true;
      };
      // Queued commands preserve user staging; spawned children stop before this scope resets it.
      yield* Effect.addFinalizer((exit) =>
        mutationStarted && Exit.hasInterrupts(exit) ? resetIndex.pipe(Effect.ignore) : Effect.void,
      );
      // An empty index and checkpoint have nothing for git restore's pathspec to match.
      if (tracked.stdout.length > 0) {
        const restore = [...longPaths, "restore", "--source", commitOid, "--worktree", "--staged"];
        // restore leaves skip-worktree paths alone. Outside a sparse checkout every such bit was
        // set by hand and capture recorded the file, so override them all.
        yield* execute({
          operation,
          cwd: input.cwd,
          args: [
            ...restore,
            ...(sparseCheckout ? [] : ["--ignore-skip-worktree-bits"]),
            "--",
            ...scope,
          ],
          onSpawn,
        });
        if (sparseCheckout) {
          // Sparse exclusions stay excluded; only skip-worktree paths the rules select are manual.
          const manual = yield* Effect.gen(function* () {
            const skipped: string[] = [];
            let recordStart = true;
            let keep = false;
            let record: Uint8Array[] = [];
            yield* vcsProcess.run({
              operation,
              command: "git",
              cwd: input.cwd,
              args: ["ls-files", "--full-name", "--sparse", "-v", "-z", "--", ...scope],
              maxOutputBytes: 4_096,
              outputMode: "truncate",
              // The index can be huge; keep only the "S "/"s " records of the NUL-delimited list.
              onStdoutChunk: (chunk) => {
                let start = 0;
                while (start < chunk.length) {
                  const end = chunk.indexOf(0, start);
                  if (recordStart) {
                    keep = chunk[start] === 83 || chunk[start] === 115;
                    record = [];
                  }
                  if (keep) {
                    record.push(Buffer.from(chunk.subarray(start, end === -1 ? undefined : end)));
                    if (end !== -1) {
                      const entry = Buffer.concat(record).subarray(2);
                      record = [];
                      // Sparse directory entries are exclusions; stdin cannot carry non-UTF-8.
                      if (entry.at(-1) !== 47 && NodeBuffer.isUtf8(entry))
                        skipped.push(entry.toString("utf8"));
                    }
                  }
                  recordStart = end !== -1;
                  if (!recordStart) break;
                  start = end + 1;
                }
              },
            });
            if (skipped.length === 0) return skipped;
            const stdin = skipped.join("\0") + "\0";
            // check-rules echoes a subset of its input, so the input size bounds its output.
            const rules = yield* execute({
              operation,
              cwd: input.cwd,
              args: ["sparse-checkout", "check-rules", "-z"],
              stdin,
              maxOutputBytes: Buffer.byteLength(stdin),
              outputMode: "error",
            });
            return rules.stdout.split("\0").filter((entry) => entry.length > 0);
          }).pipe(
            // A Git without ls-files --sparse or check-rules keeps the plain restore's result.
            Effect.orElseSucceed((): string[] => []),
          );
          if (manual.length > 0) {
            yield* execute({
              operation,
              cwd: input.cwd,
              args: [
                ...restore,
                "--ignore-skip-worktree-bits",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
              ],
              stdin: manual.map((entry) => `:(top,literal)${entry}\0`).join(""),
            });
          }
        }
      }
      yield* recreateWorkspace;
      const clean = execute({
        operation,
        cwd: input.cwd,
        args: [...longPaths, "clean", "-fd", "--", ...scope],
        env: { LC_ALL: "C" },
        allowNonZeroExit: true,
        onSpawn,
      });
      let cleaned = yield* clean;
      // Removing a new .gitignore exposes the files it hid; clean again until nothing is left.
      for (
        let pass = 1;
        pass < 4 && cleaned.exitCode === 0 && /^Removing /m.test(cleaned.stdout);
        pass++
      ) {
        yield* recreateWorkspace;
        cleaned = yield* clean;
      }
      if (cleaned.exitCode === 0 && /^Removing /m.test(cleaned.stdout)) {
        yield* recreateWorkspace;
        const remaining = yield* execute({
          operation,
          cwd: input.cwd,
          args: [...longPaths, "clean", "-dn", "--", ...scope],
          env: { LC_ALL: "C" },
        });
        if (/^Would remove /m.test(remaining.stdout)) {
          yield* resetIndex;
          return yield* new VcsProcessExitError({
            operation,
            command: "git clean",
            cwd: input.cwd,
            exitCode: 0,
            detail: "Could not clean the checkpoint workspace: untracked files remain.",
          });
        }
      }
      if (cleaned.exitCode !== 0) {
        // Git can remove every child, then fail trying to remove './' itself.
        const emptiedWorkspace =
          cleaned.exitCode === 1 &&
          /^warning: failed to remove \.\/: [^\n]+$/.test(cleaned.stderr.trim()) &&
          (yield* fileSystem.readDirectory(input.cwd).pipe(
            Effect.map((entries) => entries.length === 0),
            Effect.orElseSucceed(() => false),
          ));
        if (!emptiedWorkspace) {
          yield* resetIndex;
          return yield* new VcsProcessExitError({
            operation,
            command: "git clean",
            cwd: input.cwd,
            exitCode: cleaned.exitCode,
            detail: cleaned.stderr.trim() || "Could not clean the checkpoint workspace.",
          });
        }
      }
      yield* resetIndex;

      // A submodule without this ref was not captured, and restoring it to HEAD would lose edits.
      // The root is already restored, so a failing submodule must not hide that from the caller.
      yield* listSubmodules(input.cwd).pipe(
        Effect.flatMap((submodules) =>
          Effect.forEach(
            submodules,
            (cwd) =>
              checkpoints
                .restoreCheckpoint({
                  cwd,
                  checkpointRef: input.checkpointRef,
                  fallbackToHead: false,
                })
                .pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("submodule checkpoint restore failed", { cwd, cause }),
                  ),
                ),
            { discard: true },
          ),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("submodule checkpoint restore failed", { cwd: input.cwd, cause }),
        ),
      );

      return true;
    }, Effect.scoped),

    diffCheckpoints: Effect.fn("GitVcsDriver.checkpoints.diffCheckpoints")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.diffCheckpoints";
      if (input.filePaths?.length === 0) return "";
      yield* Effect.annotateCurrentSpan({
        "checkpoint.cwd": input.cwd,
        "checkpoint.from_ref": input.fromCheckpointRef,
        "checkpoint.to_ref": input.toCheckpointRef,
        "checkpoint.ignore_whitespace": input.ignoreWhitespace,
        "checkpoint.format": input.format ?? "patch",
        "checkpoint.fallback_from_to_head": input.fallbackFromToHead,
      });

      const diffExclusions = excludedPathspecs(input.excludePaths);
      let fromRevision = input.range?.from ?? (yield* resolveTurnStart(input));
      if (input.fallbackFromToHead === true && input.range === undefined) {
        const resolvedFromCommit = yield* resolveCheckpointCommit(
          input.cwd,
          input.fromCheckpointRef,
        );
        if (!resolvedFromCommit) {
          const headCommit = yield* resolveHeadCommit(input.cwd);
          if (!headCommit) {
            return yield* new VcsProcessExitError({
              operation,
              command: "git diff",
              cwd: input.cwd,
              exitCode: 1,
              detail: "Checkpoint ref is unavailable for diff operation.",
            });
          }
          fromRevision = headCommit;
        }
      }

      const result = yield* execute({
        operation,
        cwd: input.cwd,
        args: [
          // Not --no-relative, which Git before 2.28 rejects.
          "-c",
          "diff.relative=false",
          "-c",
          "diff.suppressBlankEmpty=false",
          "diff",
          ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--submodule=short",
          ...PATCH_RENDER_PREFIX_ARGS,
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          `${fromRevision}^{commit}`,
          `${input.range?.to ?? input.toCheckpointRef}^{commit}`,
          // Paths are repository-relative, while cwd can be a subdirectory.
          ...(input.filePaths
            ? ["--", ...input.filePaths.map((file) => `:(top,literal)${file}`), ...diffExclusions]
            : diffExclusions.length > 0
              ? ["--", ":(top)", ...diffExclusions]
              : []),
        ],
        allowNonZeroExit: true,
        maxOutputBytes: input.maxOutputBytes ?? VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: input.format === "numstat" ? "error" : "truncate",
      });

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "Checkpoint ref is unavailable for diff operation.",
        });
      }

      return result.stdout;
    }),

    listAuthoredPaths: Effect.fn("GitVcsDriver.checkpoints.listAuthoredPaths")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.listAuthoredPaths";
      const { turnStart, to, capturedAt, startHead, endHead } =
        input.range === undefined
          ? yield* Effect.gen(function* () {
              const turnStart = yield* resolveTurnStart(input);
              const heads = yield* execute({
                operation,
                cwd: input.cwd,
                args: [
                  "log",
                  "--no-walk=unsorted",
                  "--format=%ct %P",
                  `${turnStart}^{commit}`,
                  `${input.toCheckpointRef}^{commit}`,
                ],
              });
              const [fromLine = "", toLine = ""] = heads.stdout.trimEnd().split("\n");
              const [capturedAt = "", startHead = ""] = fromLine.split(" ");
              const [, endHead = ""] = toLine.split(" ");
              return { turnStart, to: input.toCheckpointRef, capturedAt, startHead, endHead };
            })
          : {
              turnStart: input.range.from,
              to: input.range.to,
              capturedAt: input.range.fromCapturedAt,
              startHead: input.range.startHead,
              endHead: input.range.endHead,
            };
      if (startHead === "" || endHead === "" || startHead === endHead) {
        return null;
      }

      const listLines = (args: ReadonlyArray<string>, stdin?: string, timeoutMs?: number) =>
        execute({
          operation,
          cwd: input.cwd,
          // log.showSignature prints verification text into the output.
          args: ["-c", "log.showSignature=false", ...args],
          ...(stdin === undefined ? {} : { stdin }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          maxOutputBytes: VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
          outputMode: "error",
        }).pipe(Effect.map((result) => result.stdout.split("\n").filter((line) => line !== "")));
      const listPaths = (args: ReadonlyArray<string>, stdin?: string) =>
        execute({
          operation,
          cwd: input.cwd,
          args: [
            "-c",
            "diff.relative=false",
            // log.showSignature prints verification text into the path list.
            "-c",
            "log.showSignature=false",
            ...args,
            "--name-only",
            "-z",
            "--no-renames",
            "--no-ext-diff",
          ],
          ...(stdin === undefined ? {} : { stdin }),
          maxOutputBytes: VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
          outputMode: "error",
        }).pipe(Effect.map((result) => result.stdout.split("\0")));

      // Refs under `namespace` that contain any of `commits`. Only the oldest commits of the set
      // are passed on, since a ref containing a descendant also contains its ancestors.
      const listRefsContaining = Effect.fn("GitVcsDriver.checkpoints.listRefsContaining")(
        function* (commits: ReadonlySet<string>, namespace: "refs/remotes" | "refs/heads") {
          const roots = (yield* listLines(
            ["rev-list", "--no-walk=unsorted", "--parents", "--stdin"],
            `${[...commits].join("\n")}\n`,
          )).flatMap((line) => {
            const [commit = "", ...parents] = line.split(" ");
            return parents.some((parent) => commits.has(parent)) ? [] : [commit];
          });
          const outputs = yield* Effect.forEach(Arr.chunksOf(roots, 256), (chunk) =>
            execute({
              operation,
              cwd: input.cwd,
              args: [
                "for-each-ref",
                "--format=%(refname)",
                ...chunk.flatMap((commit) => ["--contains", commit]),
                namespace,
              ],
              maxOutputBytes: VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
              outputMode: "error",
            }),
          );
          // A ref name that is not UTF-8 would not survive the round trip, so Git lists them.
          if (outputs.some((output) => output.stdoutInvalidUtf8)) {
            return {
              revisionArgs: [namespace === "refs/heads" ? "--branches" : "--remotes"],
              refs: [],
            };
          }
          const refs = outputs.flatMap((output) => output.stdout.split("\n"));
          return { revisionArgs: [], refs: [...new Set(refs.filter((ref) => ref !== ""))] };
        },
      );
      // With --walk-reflogs, --max-age compares each entry's own time; --since would guess at a
      // date and reads a timestamp before 1973 as now. Walking many reflogs at once slows down
      // quadratically with the refs passed: --all took 40 s in a repository with 29k refs.
      const walkReflogs = Effect.fn("GitVcsDriver.checkpoints.walkReflogs")(function* (
        revisionArgs: ReadonlyArray<string>,
        refs: ReadonlyArray<string>,
      ) {
        const lines = yield* listLines(
          [
            "log",
            "--walk-reflogs",
            ...revisionArgs,
            `--max-age=${capturedAt}`,
            "--format=%H %gD %gs",
            // A listed ref may be pruned before this walk reads it.
            "--ignore-missing",
            "--stdin",
          ],
          `${refs.join("\n")}\n`,
        );
        return lines.map(parseCheckpointReflogEntry);
      });

      // A commit is an import when a fetch delivered it since the previous checkpoint and no
      // reflog shows this repository creating it. Only refs containing a turn commit are read;
      // a remote-tracking ref force-moved off one after the fetch is missed, which keeps that
      // commit attributed to the turn.
      const listImportedCommits = Effect.fn("GitVcsDriver.checkpoints.listImportedCommits")(
        function* (candidates: ReadonlySet<string>) {
          const remote = yield* listRefsContaining(candidates, "refs/remotes");
          if (remote.revisionArgs.length === 0 && remote.refs.length === 0) {
            return new Set<string>();
          }
          // A push records commits this repository already had.
          const fetchedTips = new Set(
            (yield* walkReflogs(remote.revisionArgs, remote.refs))
              .filter((entry) => entry.fetched && entry.subject !== "update by push")
              .map((entry) => entry.commit),
          );
          if (fetchedTips.size === 0) return fetchedTips;
          const fetched = new Set(
            (yield* listLines(
              ["rev-list", `--max-age=${capturedAt}`, "--stdin"],
              `${[...fetchedTips, `^${startHead}`].join("\n")}\n`,
            )).filter((commit) => candidates.has(commit)),
          );
          if (fetched.size === 0) return fetched;
          // Fetching another branch can deliver a commit that was made here and pushed. Every
          // worktree's HEAD reflog is read, since a detached HEAD may have moved off the commit
          // it made; --all with refs/* excluded yields exactly those HEADs.
          const local = yield* listRefsContaining(fetched, "refs/heads");
          const createdHere = new Set(
            (yield* walkReflogs(["--exclude=refs/*", "--all", ...local.revisionArgs], local.refs))
              .filter(isLocalReflogCreation)
              .map((entry) => entry.commit),
          );
          return new Set([...fetched].filter((commit) => !createdHere.has(commit)));
        },
      );

      // Remerge diffs retain merge conflict fixes while excluding clean upstream changes.
      // Older Git gets dense combined diffs, which miss a conflict resolved to one side's
      // version, so it also keeps every path more than one parent changed since the merge base.
      const remerge = yield* supportsRemergeDiff(input.cwd);
      const listMergeSharedPaths = (args: ReadonlyArray<string>, stdin?: string) =>
        listLines(["rev-list", "--merges", "--parents", ...args], stdin).pipe(
          Effect.flatMap((merges) =>
            Effect.forEach(
              merges,
              Effect.fnUntraced(function* (merge) {
                const parents = merge.split(" ").slice(1);
                const [base] = yield* listLines(["merge-base", "--octopus", ...parents]).pipe(
                  // Unrelated histories have no merge base; the combined diff still applies.
                  Effect.orElseSucceed((): ReadonlyArray<string> => []),
                );
                if (base === undefined) return [];
                const changed = yield* Effect.forEach(
                  parents,
                  (parent) => listPaths(["diff", base, parent]),
                  { concurrency: "unbounded" },
                );
                const counts = new Map<string, number>();
                for (const path of changed.flatMap((paths) => [...new Set(paths)])) {
                  if (path === "") continue;
                  counts.set(path, (counts.get(path) ?? 0) + 1);
                }
                return [...counts].flatMap(([path, count]) => (count > 1 ? [path] : []));
              }),
              { concurrency: 4 },
            ),
          ),
          Effect.map((lists) => lists.flat()),
        );
      const listCommitPaths = (args: ReadonlyArray<string>, stdin?: string) =>
        remerge
          ? listPaths(["log", ...args, "--format=", "--diff-merges=remerge"], stdin)
          : Effect.all(
              [
                listPaths(["log", ...args, "--format=", "--cc"], stdin),
                listMergeSharedPaths(args, stdin),
              ],
              { concurrency: "unbounded" },
            ).pipe(Effect.map((lists) => lists.flat()));
      const [recentCommits, ...pathLists] = yield* Effect.all(
        [
          listLines(["rev-list", `--max-age=${capturedAt}`, `${startHead}..${endHead}`]),
          listPaths(["diff", startHead, `${turnStart}^{commit}`]),
          listPaths(["diff", endHead, `${to}^{commit}`]),
          listCommitPaths([`${endHead}..${startHead}`]),
        ],
        { concurrency: "unbounded" },
      );
      // Local creation evidence already overrides fetched history in the full scan.
      const unprovenCommits = new Set(recentCommits);
      if (recentCommits.length > 0 && recentCommits.length <= HEAD_MOVES_SCAN_LIMIT) {
        yield* listLines(
          [
            "log",
            "--walk-reflogs",
            `--max-count=${HEAD_MOVES_SCAN_LIMIT}`,
            "HEAD",
            `--since=@${capturedAt}`,
            "--format=%H %gD %gs",
          ],
          undefined,
          1_000,
        ).pipe(
          Effect.map((lines) => {
            for (const line of lines) {
              const entry = parseCheckpointReflogEntry(line);
              if (isLocalReflogCreation(entry)) unprovenCommits.delete(entry.commit);
            }
          }),
          Effect.catch((error) =>
            Effect.logDebug("local authorship probe failed; using full reflogs", {
              operation,
              errorTag: error._tag,
            }),
          ),
        );
      }
      // Without readable reflogs every recent commit stays attributed, as before.
      const importedCommits =
        unprovenCommits.size === 0
          ? new Set<string>()
          : yield* listImportedCommits(unprovenCommits).pipe(
              Effect.orElseSucceed(() => new Set<string>()),
            );
      const ownCommits = recentCommits.filter((commit) => !importedCommits.has(commit));
      const ownCommitPaths =
        ownCommits.length === 0
          ? []
          : yield* listCommitPaths(["--no-walk=unsorted", "--stdin"], `${ownCommits.join("\n")}\n`);
      return new Set([...pathLists.flat(), ...ownCommitPaths].filter((path) => path.length > 0));
    }),

    deleteCheckpointRefs: Effect.fn("GitVcsDriver.checkpoints.deleteCheckpointRefs")(
      function* (input) {
        yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            execute({
              operation: "GitVcsDriver.checkpoints.deleteCheckpointRefs",
              cwd: input.cwd,
              args: ["update-ref", "-d", checkpointRef],
              allowNonZeroExit: true,
            }),
          { discard: true },
        );
        const submodules = yield* listSubmodules(input.cwd).pipe(Effect.orElseSucceed(() => []));
        for (const cwd of submodules) {
          yield* checkpoints.deleteCheckpointRefs({ cwd, checkpointRefs: input.checkpointRefs });
        }
      },
    ),
  };

  return {
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  };
});

export const makeVcsDriver = Effect.gen(function* () {
  const driver = yield* makeVcsDriverShape();
  return VcsDriver.VcsDriver.of(driver);
});

export const make = Effect.gen(function* () {
  const git = yield* makeGitVcsDriverCore();
  return GitVcsDriver.of(git);
});

export const layerVcs = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver);
export const layer = Layer.effect(GitVcsDriver, make).pipe(Layer.provide(CheckoutCloner.layer));
