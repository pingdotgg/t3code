/**
 * fork: f4 — pure argv builders for every working-copy git invocation.
 *
 * Everything runs through `VcsDriver.execute`, which spawns without a shell,
 * so a commit message, branch name, path or hash can never be interpreted as
 * shell syntax. What *can* still go wrong is a value reaching git as a
 * **positional** argument and being read as an option or a revision
 * expression, so anything positional is validated here first.
 */
import * as Effect from "effect/Effect";

import {
  WorkingCopyInvalidRevisionError,
  type WorkingCopyOperation,
  type WorkingCopyResetMode,
} from "@t3tools/contracts";

/** Field/record separators, so a `|` or a newline in a subject cannot corrupt alignment. */
export const LOG_FIELD_SEPARATOR = "\x1f";
export const LOG_RECORD_SEPARATOR = "\x1e";

export const LOG_FORMAT = `--format=%H${LOG_FIELD_SEPARATOR}%h${LOG_FIELD_SEPARATOR}%s${LOG_FIELD_SEPARATOR}%an${LOG_FIELD_SEPARATOR}%ae${LOG_FIELD_SEPARATOR}%aI${LOG_FIELD_SEPARATOR}%P${LOG_RECORD_SEPARATOR}`;

export const COMMIT_DETAIL_FORMAT = `--format=%H${LOG_FIELD_SEPARATOR}%h${LOG_FIELD_SEPARATOR}%s${LOG_FIELD_SEPARATOR}%an${LOG_FIELD_SEPARATOR}%ae${LOG_FIELD_SEPARATOR}%aI${LOG_FIELD_SEPARATOR}%P${LOG_FIELD_SEPARATOR}%b${LOG_RECORD_SEPARATOR}`;

export const STASH_LIST_FORMAT = `--format=%gd${LOG_FIELD_SEPARATOR}%H${LOG_FIELD_SEPARATOR}%gs${LOG_FIELD_SEPARATOR}%aI${LOG_RECORD_SEPARATOR}`;

export const DEFAULT_LOG_LIMIT = 50;
export const MAX_LOG_LIMIT = 5_000;

const HASH_ISH = /^[0-9a-f]{4,40}$/i;
const STASH_REF = /^stash@\{\d+\}$/;
/**
 * fork: f4 — control characters, DEL, space and the punctuation
 * `git check-ref-format` refuses. Written as a named constant so the escape
 * soup lives in one place.
 */
// oxlint-disable-next-line no-control-regex -- refusing control characters is the point.
const REF_NAME_BANNED = /[\u0000-\u0020\u007f~^:?*[\\]/;

export function isHashIsh(value: string): boolean {
  return HASH_ISH.test(value);
}

export function isStashRef(value: string): boolean {
  return STASH_REF.test(value);
}

/** Guard for a revision that reaches git as positional argv. */
export const requireHashIsh = Effect.fn("workingCopy.requireHashIsh")(function* (
  operation: string,
  rev: string,
) {
  if (!isHashIsh(rev)) {
    return yield* new WorkingCopyInvalidRevisionError({ operation, rev });
  }
  return rev;
});

/** Guard for a `stash@{n}` handle, which is also positional argv. */
export const requireStashRef = Effect.fn("workingCopy.requireStashRef")(function* (
  operation: string,
  ref: string,
) {
  if (!isStashRef(ref)) {
    return yield* new WorkingCopyInvalidRevisionError({ operation, rev: ref });
  }
  return ref;
});

/**
 * fork: f4 — `git check-ref-format`'s rules, applied to a tag name before it
 * reaches `git tag <name> <hash>` as positional argv.
 *
 * The leading `-` is the security-relevant one: without this guard a client
 * could send `name: "-d"` (delete a tag) or `name: "-F/etc/passwd"` (read an
 * arbitrary file into the tag message, a containment bypass for reads). The
 * rest of the rules are here because a name git would reject anyway deserves
 * "invalid tag name", not a raw git usage error in a toast.
 */
export function isValidRefName(name: string): boolean {
  if (name.length === 0 || name.length > 255) {
    return false;
  }
  // Option injection: anything git could read as a flag.
  if (name.startsWith("-")) {
    return false;
  }
  if (REF_NAME_BANNED.test(name)) {
    return false;
  }
  if (name.includes("..") || name.includes("@{")) {
    return false;
  }
  if (name === "@" || name.endsWith(".") || name.endsWith(".lock")) {
    return false;
  }
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
    return false;
  }
  // No path component may start with a dot or end in `.lock`.
  return name
    .split("/")
    .every(
      (component) =>
        component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"),
    );
}

/** Guard for a tag name, which reaches git as positional argv. */
export const requireRefName = Effect.fn("workingCopy.requireRefName")(function* (
  operation: string,
  name: string,
) {
  if (!isValidRefName(name)) {
    return yield* new WorkingCopyInvalidRevisionError({ operation, rev: name });
  }
  return name;
});

export function clampLogLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LOG_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LOG_LIMIT, Math.trunc(limit)));
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function statusArgs(): ReadonlyArray<string> {
  return ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-uall", "-z"];
}

export function absoluteGitDirArgs(): ReadonlyArray<string> {
  return ["rev-parse", "--absolute-git-dir"];
}

export function repositoryRootArgs(): ReadonlyArray<string> {
  return ["rev-parse", "--show-toplevel"];
}

export function currentBranchArgs(): ReadonlyArray<string> {
  return ["symbolic-ref", "--quiet", "--short", "HEAD"];
}

export function upstreamArgs(): ReadonlyArray<string> {
  return ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"];
}

export function aheadBehindArgs(): ReadonlyArray<string> {
  return ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"];
}

export function shortHeadArgs(): ReadonlyArray<string> {
  return ["rev-parse", "--short", "HEAD"];
}

export function headHashArgs(): ReadonlyArray<string> {
  return ["rev-parse", "HEAD"];
}

export function numstatArgs(staged: boolean): ReadonlyArray<string> {
  return staged ? ["diff", "--cached", "-M", "--numstat", "-z"] : ["diff", "-M", "--numstat", "-z"];
}

export function versionArgs(): ReadonlyArray<string> {
  return ["--version"];
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

export function stageArgs(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return ["--literal-pathspecs", "add", "-A", "--", ...paths];
}

/**
 * `reset -q HEAD -- <paths>` needs a HEAD. On an unborn branch the equivalent
 * is dropping the paths from the index outright.
 */
export function unstageArgs(
  paths: ReadonlyArray<string>,
  options: { readonly hasHead: boolean },
): ReadonlyArray<string> {
  return options.hasHead
    ? ["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...paths]
    : ["--literal-pathspecs", "rm", "-q", "--cached", "-r", "--", ...paths];
}

export function applyPatchArgs(options: {
  readonly cached?: boolean | undefined;
  readonly reverse?: boolean | undefined;
}): ReadonlyArray<string> {
  return [
    "apply",
    "--whitespace=nowarn",
    "--recount",
    ...(options.cached === true ? ["--cached"] : []),
    ...(options.reverse === true ? ["--reverse"] : []),
    "-",
  ];
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export function diffArgs(options: {
  readonly staged: boolean;
  readonly path: string;
  readonly oldPath?: string | undefined;
}): ReadonlyArray<string> {
  return [
    "--literal-pathspecs",
    "diff",
    ...(options.staged ? ["--cached"] : []),
    "-M",
    "--",
    ...(options.oldPath !== undefined ? [options.oldPath] : []),
    options.path,
  ];
}

/** Exits non-zero when the path is not in the index — i.e. untracked. */
export function isTrackedArgs(path: string): ReadonlyArray<string> {
  return ["--literal-pathspecs", "ls-files", "--error-unmatch", "-z", "--", path];
}

/** Untracked files have no diff target; git exits 1 and the patch is on stdout. */
export function untrackedDiffArgs(path: string): ReadonlyArray<string> {
  return ["--literal-pathspecs", "diff", "--no-index", "--", "/dev/null", path];
}

export function fileAtRefArgs(rev: string, path: string): ReadonlyArray<string> {
  return ["show", rev === ":" ? `:${path}` : `${rev}:${path}`];
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

/**
 * The message travels over **stdin**. Never `-m`: `runStackedAction`'s commit
 * path resets the index and re-adds `-A` before committing, so the panel needs
 * its own commit that stages nothing at all.
 */
export function commitStagedArgs(): ReadonlyArray<string> {
  return ["commit", "-F", "-"];
}

export function amendCommitArgs(options: { readonly hasMessage: boolean }): ReadonlyArray<string> {
  return options.hasMessage ? ["commit", "--amend", "-F", "-"] : ["commit", "--amend", "--no-edit"];
}

export function undoLastCommitArgs(): ReadonlyArray<string> {
  return ["reset", "--soft", "HEAD~1"];
}

export function lastCommitMessageArgs(): ReadonlyArray<string> {
  return ["log", "-1", "--format=%B"];
}

export function headCommitSummaryArgs(): ReadonlyArray<string> {
  return ["log", "-1", `--format=%H${LOG_FIELD_SEPARATOR}%h`];
}

export function commitFileCountArgs(hash: string): ReadonlyArray<string> {
  return ["show", "--first-parent", "--name-only", "-z", "--format=", hash];
}

// ---------------------------------------------------------------------------
// AI commit message context
// ---------------------------------------------------------------------------

/**
 * fork: f4 AI commit message — git's fixed empty-tree object name.
 *
 * Amending a root commit has no `HEAD^` to diff against; diffing the index
 * against the empty tree is what "everything this commit contains" means there.
 */
export const EMPTY_TREE_OBJECT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The **staged** name-status summary. `base` is only ever supplied for an
 * amend, where the commit being rewritten is `HEAD`'s parent, so the change the
 * model must describe is `base..index`, not `HEAD..index`.
 *
 * There is deliberately no `add` anywhere near this: the panel's whole premise
 * is a hand-built index (see `WorkingCopyCommit.ts`).
 */
export function stagedSummaryArgs(base?: string): ReadonlyArray<string> {
  return ["diff", "--cached", "--name-status", "-M", ...(base !== undefined ? [base] : [])];
}

export function stagedPatchArgs(base?: string): ReadonlyArray<string> {
  return [
    "diff",
    "--no-ext-diff",
    "--cached",
    "--patch",
    "--minimal",
    "-M",
    ...(base !== undefined ? [base] : []),
  ];
}

/**
 * Exits non-zero (quietly) when HEAD has no parent — an unborn or root commit.
 *
 * `~1` here is the FIRST parent on purpose, unlike `logArgs` where it is banned:
 * amending a merge rewrites it against the side it was merged into, which is
 * exactly what `git commit --amend` itself does.
 */
export function headParentArgs(): ReadonlyArray<string> {
  return ["rev-parse", "--verify", "--quiet", "HEAD~1"];
}

/** Style examples for the `repo_conventions` writing style. */
export function recentCommitSubjectsArgs(limit: number): ReadonlyArray<string> {
  return ["log", `-n`, String(Math.max(1, Math.trunc(limit))), "--no-merges", "--pretty=format:%s"];
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

export interface LogArgsInput {
  readonly limit: number;
  /** Cursor. Paging continues **below** this hash. */
  readonly before?: string | undefined;
  readonly rev?: string | undefined;
  readonly grep?: string | undefined;
  readonly author?: string | undefined;
  readonly paths?: ReadonlyArray<string> | undefined;
}

/**
 * Cursor paging uses `--skip=1 <hash>` and **never** `<hash>~1`: `~1` follows
 * the first parent, which silently drops the second-parent side of a merge.
 *
 * `hasMore` is answered by asking for `limit + 1` rows and trimming.
 */
export function logArgs(input: LogArgsInput): ReadonlyArray<string> {
  const hasTextFilter = input.grep !== undefined || input.author !== undefined;
  const positional =
    input.before !== undefined
      ? ["--skip=1", input.before]
      : input.rev !== undefined
        ? [input.rev]
        : [];
  return [
    "--literal-pathspecs",
    "log",
    `--max-count=${input.limit + 1}`,
    LOG_FORMAT,
    // Fixed strings so a query like `fix(` is not an invalid regex.
    ...(hasTextFilter ? ["--fixed-strings", "--regexp-ignore-case"] : []),
    ...(input.grep !== undefined ? [`--grep=${input.grep}`] : []),
    ...(input.author !== undefined ? [`--author=${input.author}`] : []),
    ...positional,
    ...(input.paths !== undefined && input.paths.length > 0 ? ["--", ...input.paths] : []),
  ];
}

// ---------------------------------------------------------------------------
// Commit detail
// ---------------------------------------------------------------------------

/** `--first-parent` so a merge commit shows a meaningful file list, not nothing. */
export function commitDetailArgs(hash: string): ReadonlyArray<string> {
  return ["show", "--no-patch", "--first-parent", COMMIT_DETAIL_FORMAT, hash];
}

export function commitNameStatusArgs(hash: string): ReadonlyArray<string> {
  return ["show", "--first-parent", "-M", "--name-status", "-z", "--format=", hash];
}

export function commitNumstatArgs(hash: string): ReadonlyArray<string> {
  return ["show", "--first-parent", "-M", "--numstat", "-z", "--format=", hash];
}

/** Annotated tags key by the commit they dereference to, hence `%(*objectname)`. */
export function commitRefsArgs(): ReadonlyArray<string> {
  return [
    "for-each-ref",
    `--format=%(objectname)${LOG_FIELD_SEPARATOR}%(*objectname)${LOG_FIELD_SEPARATOR}%(refname:short)${LOG_FIELD_SEPARATOR}%(refname)`,
  ];
}

export function commitFileDiffArgs(options: {
  readonly hash: string;
  readonly path: string;
  readonly oldPath?: string | undefined;
}): ReadonlyArray<string> {
  return [
    "--literal-pathspecs",
    "show",
    "--first-parent",
    "-M",
    "--format=",
    options.hash,
    "--",
    ...(options.oldPath !== undefined ? [options.oldPath] : []),
    options.path,
  ];
}

// ---------------------------------------------------------------------------
// Stash & discard backups
// ---------------------------------------------------------------------------

export function stashListArgs(): ReadonlyArray<string> {
  return ["stash", "list", STASH_LIST_FORMAT];
}

/**
 * The one place `--literal-pathspecs` must **not** be used. `git stash` builds
 * its own pathspecs with magic internally (that is how `--include-untracked`
 * finds untracked files), and the global flag disables that magic, silently
 * leaving untracked files behind. Per-pathspec `:(literal)` magic gives the
 * same protection for our paths without breaking git's own.
 */
export function stashPushArgs(options: {
  readonly message?: string | undefined;
  readonly includeUntracked: boolean;
  readonly paths?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<string> {
  return [
    "stash",
    "push",
    ...(options.includeUntracked ? ["--include-untracked"] : []),
    ...(options.message !== undefined ? ["-m", options.message] : []),
    ...(options.paths !== undefined && options.paths.length > 0
      ? ["--", ...options.paths.map((path) => `:(literal)${path}`)]
      : []),
  ];
}

export function stashApplyArgs(ref: string): ReadonlyArray<string> {
  return ["stash", "apply", ref];
}

export function stashPopArgs(ref: string): ReadonlyArray<string> {
  return ["stash", "pop", ref];
}

export function stashDropArgs(ref: string): ReadonlyArray<string> {
  return ["stash", "drop", ref];
}

// ---------------------------------------------------------------------------
// Discard
// ---------------------------------------------------------------------------

export function checkoutPathsArgs(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return ["--literal-pathspecs", "checkout", "-q", "--", ...paths];
}

export function cleanPathsArgs(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return ["--literal-pathspecs", "clean", "-fdq", "--", ...paths];
}

export function resetIndexArgs(): ReadonlyArray<string> {
  return ["reset", "-q", "HEAD"];
}

/**
 * fork: f4 — the per-path half of `resetIndexArgs`. Discard means "back to
 * HEAD", so the destructive fallback resets the index before restoring the
 * worktree; without it `checkout -- <paths>` would restore from the index and
 * silently keep a file's staged half.
 */
export function resetPathsArgs(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return ["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...paths];
}

export function checkoutAllArgs(): ReadonlyArray<string> {
  return ["checkout", "-q", "--", "."];
}

export function cleanAllArgs(): ReadonlyArray<string> {
  return ["clean", "-fdq"];
}

// ---------------------------------------------------------------------------
// Conflicts & history mutations
// ---------------------------------------------------------------------------

export function checkoutConflictSideArgs(
  side: "ours" | "theirs",
  path: string,
): ReadonlyArray<string> {
  return ["--literal-pathspecs", "checkout", `--${side}`, "--", path];
}

export function markResolvedArgs(path: string): ReadonlyArray<string> {
  return ["--literal-pathspecs", "add", "--", path];
}

export function abortOperationArgs(operation: WorkingCopyOperation): ReadonlyArray<string> {
  switch (operation) {
    case "merge":
      return ["merge", "--abort"];
    case "rebase":
      return ["rebase", "--abort"];
    case "cherry-pick":
      return ["cherry-pick", "--abort"];
    case "revert":
      return ["revert", "--abort"];
  }
}

export function cherryPickArgs(hash: string): ReadonlyArray<string> {
  return ["cherry-pick", hash];
}

export function revertCommitArgs(options: {
  readonly hash: string;
  readonly mainline?: number | undefined;
}): ReadonlyArray<string> {
  return [
    "revert",
    "--no-edit",
    ...(options.mainline !== undefined ? ["-m", String(options.mainline)] : []),
    options.hash,
  ];
}

export function checkoutCommitArgs(hash: string): ReadonlyArray<string> {
  return ["checkout", "--detach", hash];
}

export function resetToCommitArgs(hash: string, mode: WorkingCopyResetMode): ReadonlyArray<string> {
  return ["reset", `--${mode}`, hash];
}

export function tagCommitArgs(options: {
  readonly hash: string;
  readonly name: string;
  readonly message?: string | undefined;
}): ReadonlyArray<string> {
  return options.message !== undefined
    ? ["tag", "-a", options.name, "-m", options.message, options.hash]
    : ["tag", options.name, options.hash];
}
