import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { GitCommandError, type GitCommandFailureReason, type ReviewDiffFileStat, type VcsRef } from "@t3tools/contracts";
import { compactTraceAttributes } from "@t3tools/shared/observability";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as GitVcsDriver from "../GitVcsDriver.ts";
import { parseRemoteRefWithRemoteNames } from "../../git/remoteRefs.ts";
export const DEFAULT_TIMEOUT_MS = 30_000;

export const branchBaseConfigKey = (branch: string) => `branch.${branch}.t3-merge-base`;

export const legacyBranchBaseConfigKey = (branch: string) => `branch.${branch}.gh-merge-base`;

export const gitProcesses = Semaphore.makeUnsafe(8);

export const WORKTREE_REMOVE_TIMEOUT_MS = Duration.toMillis(Duration.minutes(5));

export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

export const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

export const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 49_000;

export const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;

export const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;

export const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;

export const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;

export const REVIEW_METADATA_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const REVIEW_UNTRACKED_MAX_FILES = 5_000;

export const REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;

export const REVIEW_BRANCH_COMMIT_LIMIT = 100;

export const REVIEW_BRANCH_SUBJECT_LIMIT = 300;

export const REVIEW_BRANCH_COMMIT_MAX_OUTPUT_BYTES = 128 * 1024;

export const PATCH_RENDER_PREFIX_ARGS = ["--src-prefix=a/", "--dst-prefix=b/"] as const;

export const REVIEW_DIFF_ARGS = [
"-c",
"diff.suppressBlankEmpty=false",
"diff",
"--find-renames",
"--no-color",
"--no-ext-diff",
"--no-textconv",
"--submodule=short",
...PATCH_RENDER_PREFIX_ARGS,
];

export const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);

export const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);

export const STATUS_UPSTREAM_FETCH_TIMEOUT = Duration.minutes(5);

export const STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN = Duration.seconds(30);

export const STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN = Duration.minutes(15);

export const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;

export const REPOSITORY_PATHS_CACHE_CAPACITY = 2_048;

export const REPOSITORY_PATHS_CACHE_TTL = Duration.minutes(10);

export const REPOSITORY_PATHS_REFRESH_COALESCE_TTL = Duration.seconds(5);

export const NON_REPOSITORY_PATHS_CACHE_TTL = Duration.seconds(1);

export const LIST_REFS_SNAPSHOT_CACHE_CAPACITY = 64;

export const LIST_REFS_SNAPSHOT_CACHE_TTL = Duration.minutes(2);

export const LIST_REFS_REFRESH_COALESCE_TTL = Duration.seconds(5);

export const LIST_REFS_REFRESH_FAILURE_COOLDOWN = Duration.seconds(30);

export const STATUS_DEFAULT_BRANCH_CACHE_TTL = Duration.minutes(5);

export const STATUS_ORIGIN_EXISTS_CACHE_TTL = Duration.minutes(5);

export const STATUS_UPSTREAM_REFRESH_ENV = Object.freeze({
GCM_INTERACTIVE: "never",
GIT_ASKPASS: "",
GIT_TERMINAL_PROMPT: "0",
SSH_ASKPASS: "",
SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);

export const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;

export const GIT_LIST_BRANCHES_DEFAULT_LIMIT = 100;

export const NON_REPOSITORY_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitStatusDetails>({
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
});

export const NON_REPOSITORY_REMOTE_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitRemoteStatusDetails>({
isRepo: false,
defaultBranch: null,
isDefaultBranch: false,
branch: null,
upstreamRef: null,
hasUpstream: false,
aheadCount: 0,
behindCount: 0,
aheadOfDefaultCount: 0,
});

export type TraceTailState = {
processedChars: number;
remainder: string;
};

export class StatusRemoteRefreshCacheKey extends Data.Class<{
gitCommonDir: string;
remoteName: string;
}> {}

export function statusUpstreamRefreshFailureCooldown(consecutiveFailures: number): Duration.Duration {
const exponent = Math.max(0, consecutiveFailures - 1);
const cooldownMs =
  Duration.toMillis(STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN) * Math.pow(2, exponent);
return Duration.min(Duration.millis(cooldownMs), STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN);
}

export class GitRefsSnapshotCacheKey extends Data.Class<{
gitCommonDir: string;
epoch: number;
}> {}

export class GitRefsRefreshCacheKey extends Data.Class<{
gitCommonDir: string;
generation: number;
}> {}

export interface GitRepositoryPaths {
readonly gitCommonDir: string;
readonly worktreeRoot: string | null;
readonly isAtRepositoryRoot: boolean | undefined;
readonly currentBranch: string | null;
}

export interface GitRefsSnapshot {
readonly localBranches: ReadonlyArray<VcsRef>;
readonly remoteBranches: ReadonlyArray<VcsRef>;
readonly hasPrimaryRemote: boolean;
}

export interface ExecuteGitOptions {
stdin?: string | undefined;
timeoutMs?: number | null | undefined;
forceKillAfterMs?: number | undefined;
allowNonZeroExit?: boolean | undefined;
fallbackErrorDetail?: string | undefined;
env?: NodeJS.ProcessEnv | undefined;
maxOutputBytes?: number | undefined;
appendTruncationMarker?: boolean | undefined;
progress?: GitVcsDriver.ExecuteGitProgress | undefined;
writesSharedConfig?: boolean | undefined;
}

export function parseBranchAb(value: string): { ahead: number; behind: number } {
const match = value.match(/^\+(\d+)\s+-(\d+)$/);
if (!match) return { ahead: 0, behind: 0 };
return {
  ahead: Number(match[1] ?? "0"),
  behind: Number(match[2] ?? "0"),
};
}

export function parseReviewNumstat(stdout: string): ReviewDiffFileStat[] {
const fields = stdout.split("\0");
const files: ReviewDiffFileStat[] = [];
for (let index = 0; index < fields.length; index++) {
  const field = fields[index]!;
  const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(field);
  if (!match) continue;
  const previousPath = match[3] === "" ? fields[++index]! : null;
  const path = previousPath !== null ? fields[++index]! : match[3]!;
  files.push({
    path,
    previousPath,
    additions: match[1] === "-" ? 0 : Number(match[1]),
    deletions: match[2] === "-" ? 0 : Number(match[2]),
  });
}
return files;
}

export const PORCELAIN_V2_FIELDS_BEFORE_PATH: Record<string, number> = {
"1": 8,
"2": 9,
u: 10,
"?": 1,
"!": 1,
};

export function parsePorcelainPath(record: string): string | null {
const fieldsBeforePath = PORCELAIN_V2_FIELDS_BEFORE_PATH[record[0] ?? ""];
if (fieldsBeforePath === undefined) return null;
const filePath = record.split(" ").slice(fieldsBeforePath).join(" ");
return filePath.length > 0 ? filePath : null;
}

export function filterBranchesForListQuery(
refs: ReadonlyArray<VcsRef>,
query?: string,
): ReadonlyArray<VcsRef> {
if (!query) {
  return refs;
}

const normalizedQuery = query.toLowerCase();
return refs.filter((refName) => refName.name.toLowerCase().includes(normalizedQuery));
}

export function paginateBranches(input: {
refs: ReadonlyArray<VcsRef>;
cursor?: number | undefined;
limit?: number | undefined;
}): {
refs: ReadonlyArray<VcsRef>;
nextCursor: number | null;
totalCount: number;
} {
const cursor = input.cursor ?? 0;
const limit = input.limit ?? GIT_LIST_BRANCHES_DEFAULT_LIMIT;
const totalCount = input.refs.length;
const refs = input.refs.slice(cursor, cursor + limit);
const nextCursor = cursor + refs.length < totalCount ? cursor + refs.length : null;

return {
  refs,
  nextCursor,
  totalCount,
};
}

export function parseWorktreeBranchPaths(stdout: string): ReadonlyMap<string, string> {
const worktreePaths = new Map<string, string>();
let currentPath: string | null = null;
let currentBranch: string | null = null;
let currentPrunable = false;

const flush = () => {
  if (currentPath !== null && currentBranch !== null && !currentPrunable) {
    worktreePaths.set(currentBranch, currentPath);
  }
  currentPath = null;
  currentBranch = null;
  currentPrunable = false;
};

for (const field of stdout.split("\0")) {
  if (field === "") {
    flush();
  } else if (field.startsWith("worktree ")) {
    currentPath = field.slice("worktree ".length);
  } else if (field.startsWith("branch refs/heads/")) {
    currentBranch = field.slice("branch refs/heads/".length);
  } else if (field === "prunable" || field.startsWith("prunable ")) {
    currentPrunable = true;
  }
}
flush();

return worktreePaths;
}

export function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
const parts = input.split("\0");
if (parts.length === 0) return [];

if (truncated && parts[parts.length - 1]?.length) {
  parts.pop();
}

return parts.filter((value) => value.length > 0);
}

export function splitNullSeparatedGitStdoutPaths(
result: Pick<GitVcsDriver.ExecuteGitResult, "stdout" | "stdoutTruncated">,
): string[] {
return splitNullSeparatedPaths(result.stdout, result.stdoutTruncated);
}

export const refuseOptionLikeRefName = (operation: string, cwd: string, refName: string | undefined) =>
refName !== undefined && refName !== "-" && refName.startsWith("-")
  ? Effect.fail(
      new GitCommandError({
        operation,
        command: "git",
        cwd,
        detail: "Ref names cannot start with '-'.",
      }),
    )
  : Effect.void;

export function sanitizeRemoteName(value: string): string {
const sanitized = value
  .trim()
  .replace(/[^A-Za-z0-9._-]+/g, "-")
  .replace(/^-+|-+$/g, "");
return sanitized.length > 0 ? sanitized : "fork";
}

export function parseRemoteFetchUrls(stdout: string): Map<string, string> {
const remotes = new Map<string, string>();
for (const line of stdout.split("\n")) {
  const trimmed = line.trim();
  if (trimmed.length === 0) continue;
  // Partial clones append the promisor filter, e.g. `(fetch) [blob:none]`.
  const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)(?:\s+\[[^\]]+\])?$/.exec(trimmed);
  if (!match) continue;
  const [, remoteName = "", remoteUrl = "", direction = ""] = match;
  if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
    continue;
  }
  remotes.set(remoteName, remoteUrl);
}
return remotes;
}

export function parseUpstreamRefWithRemoteNames(
upstreamRef: string,
remoteNames: ReadonlyArray<string>,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
const parsed = parseRemoteRefWithRemoteNames(upstreamRef, remoteNames);
if (!parsed) {
  return null;
}

return {
  upstreamRef,
  remoteName: parsed.remoteName,
  branchName: parsed.branchName,
};
}

export function parseUpstreamRefByFirstSeparator(
upstreamRef: string,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
const separatorIndex = upstreamRef.indexOf("/");
if (separatorIndex <= 0 || separatorIndex === upstreamRef.length - 1) {
  return null;
}

const remoteName = upstreamRef.slice(0, separatorIndex).trim();
const branchName = upstreamRef.slice(separatorIndex + 1).trim();
if (remoteName.length === 0 || branchName.length === 0) {
  return null;
}

return {
  upstreamRef,
  remoteName,
  branchName,
};
}

export function parseTrackingBranchByUpstreamRef(stdout: string, upstreamRef: string): string | null {
for (const line of stdout.split("\n")) {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) {
    continue;
  }
  const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
  const branchName = branchNameRaw?.trim() ?? "";
  const candidateUpstreamRef = upstreamBranchRaw.trim();
  if (branchName.length === 0 || candidateUpstreamRef.length === 0) {
    continue;
  }
  if (candidateUpstreamRef === upstreamRef) {
    return branchName;
  }
}

return null;
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null {
const separatorIndex = branchName.indexOf("/");
if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
  return null;
}
const localBranch = branchName.slice(separatorIndex + 1).trim();
return localBranch.length > 0 ? localBranch : null;
}

export function gitCommandContext(
input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
) {
return {
  operation: input.operation,
  command: "git",
  cwd: input.cwd,
  argumentCount: input.args.length,
} as const;
}

export const GIT_FAILURE_REASON_PATTERNS: ReadonlyArray<readonly [RegExp, GitCommandFailureReason]> = [
[/would clobber existing tag/i, "tag_would_be_clobbered"],
[/is already (?:used by worktree at|checked out at)/i, "branch_checked_out_in_worktree"],
[/a branch named .+ already exists/i, "branch_already_exists"],
// The same prefix also reports permission errors, which retrying cannot fix.
[/could not lock config file .+: File exists/i, "config_locked"],
[
  /(?:authentication failed|could not read Username|could not read Password|permission denied \([a-z-]+(?:,[a-z-]+)*\)|permission denied, please try again)/i,
  "authentication_failed",
],
[/host key verification failed/i, "host_key_unverified"],
[
  /(?:could not read from remote repository|does not appear to be a git repository|repository .+ not found)/i,
  "remote_unreachable",
],
// Unquoted already-exists errors also describe ref/tag collisions; require quoted paths.
[/fatal: '[^']+' already exists|destination path .+ already exists/i, "path_already_exists"],
// Ambiguous revision/path and pathspec failures can name files, so omit them.
// Anchor to a diagnostic line to avoid matching quoted paths in other errors.
[
  /^fatal: (?:invalid reference: |not a valid object name|needed a single revision|bad revision |'.+' is not a commit and a branch '.+' cannot be created from it)/im,
  "ref_not_found",
],
// `[remote rejected]` is only printed for a push. The remote's explanation
// follows in parentheses; it is server text, so it is never quoted.
[/^[ \t]*![ \t]+\[remote rejected\]/im, "push_rejected_by_remote"],
// A fetch into a diverged local branch prints the same `[rejected]` line, but
// only a push goes on to report "failed to push some refs".
[
  /^[ \t]*![ \t]+\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)[\s\S]*^error: failed to push some refs/im,
  "push_rejected_non_fast_forward",
],
];

export const GIT_FAILURE_REASON_DETAILS: Partial<Record<GitCommandFailureReason, string>> = {
push_rejected_by_remote:
  "The remote rejected the push. Push this branch from a terminal to see the server's message.",
push_rejected_non_fast_forward:
  "The remote has commits this branch doesn't have. Pull or rebase, then push again.",
config_locked:
  "Another Git process kept the repository's config locked. Wait for it to finish, then retry.",
};

export function gitFailureDetail(reason: GitCommandFailureReason | null): string {
return (
  (reason === null ? undefined : GIT_FAILURE_REASON_DETAILS[reason]) ??
  "Git command exited with a non-zero status."
);
}

export const GIT_NOT_A_COMMIT_PATTERN = /^error: .+(?:, not a commit|expected commit type)/im;

export const GIT_DIAGNOSTIC_LINE_PATTERN = /^(?:fatal|error):|^!\s|^\s+!\s/;

export const SSH_TRANSPORT_REFUSAL_PATTERN =
/Permission denied \((?:publickey|password|keyboard-interactive)|Permission denied, please try again|Host key verification failed/i;

export function classifyGitFailure(stderr: string): GitCommandFailureReason | null {
const diagnostics = stderr
  .split(/\r?\n/)
  .filter(
    (line) =>
      GIT_DIAGNOSTIC_LINE_PATTERN.test(line) ||
      (!/^remote:/.test(line) && SSH_TRANSPORT_REFUSAL_PATTERN.test(line)),
  )
  .join("\n");
if (diagnostics.length === 0) return null;
if (isNonRepositoryGitStderr(diagnostics)) return "not_a_repository";
for (const [pattern, reason] of GIT_FAILURE_REASON_PATTERNS) {
  if (!pattern.test(diagnostics)) continue;
  if (reason === "ref_not_found" && GIT_NOT_A_COMMIT_PATTERN.test(diagnostics)) continue;
  return reason;
}
return null;
}

export function branchNameFromHeadRef(value: string): string | null {
const ref = value.trim();
return ref.startsWith("refs/heads/") && ref.length > "refs/heads/".length
  ? ref.slice("refs/heads/".length)
  : null;
}

export function parseDefaultBranchFromRemoteHeadRef(value: string, remoteName: string): string | null {
const trimmed = value.trim();
const prefix = `refs/remotes/${remoteName}/`;
if (!trimmed.startsWith(prefix)) {
  return null;
}
const refName = trimmed.slice(prefix.length).trim();
return refName.length > 0 ? refName : null;
}

export function isMissingGitCwdError(error: GitCommandError): boolean {
if (!(error.cause instanceof PlatformError.PlatformError)) {
  return false;
}

const reason = error.cause.reason;
if (reason._tag === "NotFound") {
  return reason.pathOrDescriptor === error.cwd;
}

return (
  reason._tag === "BadResource" &&
  reason.pathOrDescriptor === error.cwd &&
  typeof reason.cause === "object" &&
  reason.cause !== null &&
  "code" in reason.cause &&
  reason.cause.code === "ENOTDIR"
);
}

export function isNonRepositoryGitStderr(stderr: string): boolean {
return stderr.toLowerCase().includes("not a git repository");
}

export function isUnbornHeadStderr(stderr: string): boolean {
const normalized = stderr.toLowerCase();
return (
  normalized.includes("bad revision 'head'") ||
  (normalized.includes("unknown revision") && normalized.includes("path not in the working tree"))
);
}

export function isMissingWorktreeStderr(stderr: string): boolean {
const normalized = stderr.toLowerCase();
return (
  normalized.includes("is not a working tree") ||
  normalized.includes("cannot remove working tree")
);
}

export function fetchFailureDetail(stderr: string): string | undefined {
const lines = stderr.split(/\r?\n/).map((line) => line.trim());
if (
  lines.some((line) =>
    /^(?:fatal: (?:Authentication failed|could not read (?:Username|Password))\b|\S+: Permission denied \(publickey)/i.test(
      line,
    ),
  )
) {
  return "Git could not authenticate with the remote. Check Git credentials or SSH access on the server, then retry.";
}
if (
  lines.some((line) =>
    /^(?:(?:fatal: |ssh: )?Could not resolve host(?:name)?\b|fatal: unable to access .+: (?:Could not resolve host|Failed to connect)\b|ssh: connect to host \S+ port \d+: (?:Connection timed out|Connection refused|Network is unreachable)\b)/i.test(
      line,
    ),
  )
) {
  return "Git could not reach the remote. Check the server's network connection and remote host, then retry.";
}
if (
  lines.some((line) =>
    /^(?:remote: Repository not found\.?$|fatal: repository .+ not found$|fatal: .+ does not appear to be a git repository$)/i.test(
      line,
    ),
  )
) {
  return "Git could not access the remote repository. Check the remote URL and repository permissions on the server.";
}
if (isRefLockFailure(stderr)) {
  return "Git could not update a local reference. Another Git operation or a stale lock may be blocking the fetch; check the repository on the server, then retry.";
}
return undefined;
}

export function isRefLockFailure(stderr: string): boolean {
return stderr
  .split(/\r?\n/)
  .some((line) =>
    /^(?:(?:error|fatal): cannot lock ref\b|fatal: Unable to create ['"].+\.lock['"]:|error: fetching ref \S+ failed: (?:incorrect old value provided|reference already exists)$)/i.test(
      line.trim(),
    ),
  );
}

export interface Trace2Monitor {
readonly env: NodeJS.ProcessEnv;
readonly flush: Effect.Effect<void, never>;
}

export const nowUnixNano = DateTime.now.pipe(
Effect.map((now) => BigInt(DateTime.toEpochMillis(now)) * 1_000_000n),
);

export const addCurrentSpanEvent =
/* This helper annotates the existing operation span. */
Effect.fnUntraced(
  function* (name: string, attributes: Record<string, unknown>) {
    const span = yield* Effect.currentSpan;
    const timestamp = yield* nowUnixNano;
    yield* Effect.sync(() => {
      span.event(name, timestamp, compactTraceAttributes(attributes));
    });
  },
  Effect.catchTags({
    NoSuchElementError: () => Effect.void,
  }),
);

export function trace2ChildKey(record: Record<string, unknown>): string | null {
const childId = record.child_id;
if (typeof childId === "number" || typeof childId === "string") {
  return typeof record.sid === "string" ? `${record.sid}\n${childId}` : String(childId);
}
const hookName = record.hook_name;
return typeof hookName === "string" && hookName.trim().length > 0 ? hookName.trim() : null;
}

export const Trace2Record = Schema.Record(Schema.String, Schema.Unknown);

export const decodeTrace2Record = decodeJsonResult(Trace2Record);
