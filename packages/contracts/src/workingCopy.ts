/**
 * Working-copy (source-control panel) contract.
 *
 * fork: f4 — a **new** module rather than an extension of `git.ts`.
 * `VcsStatusResult` is subscribed per visible sidebar thread row and is a
 * numstat *summary*; the panel needs `status --porcelain=v1 -uall -z` (status
 * letter, area, rename source, unmerged detection). Overloading one struct
 * would make every thread row pay for porcelain parsing on every local
 * refresh, so this is a second, opt-in read with its own RPCs.
 *
 * Every export is prefixed `WorkingCopy*` because `contracts/src/index.ts` is
 * `export *` over its modules.
 *
 * Nothing here may assume a web surface: no row heights, no panel widths, no
 * storage keys. Mobile reuses this contract verbatim.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
// fork: f4 AI commit message — reuses the existing text-generation failure
// rather than minting a second one. `git.ts` itself is NOT modified.
import { TextGenerationError } from "./git.ts";
import { VcsError } from "./vcs.ts";

/** Anything that reaches git as positional argv must look like an object name. */
const HASH_ISH_PATTERN = /^[0-9a-f]{4,40}$/i;

export const WorkingCopyCommitHash = TrimmedNonEmptyString.check(
  Schema.isPattern(HASH_ISH_PATTERN),
);
export type WorkingCopyCommitHash = typeof WorkingCopyCommitHash.Type;

/** Which of the three display buckets a change belongs to. */
export const WorkingCopyArea = Schema.Literals(["staged", "unstaged", "conflicted"]);
export type WorkingCopyArea = typeof WorkingCopyArea.Type;

/**
 * What happened to the path. Untracked files ride `area: "unstaged"` with
 * `change: "untracked"`.
 *
 * Keep this union small and stable: prefer mapping an exotic porcelain letter
 * onto `modified` over growing it.
 */
export const WorkingCopyChange = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "typechange",
  "unmerged",
]);
export type WorkingCopyChange = typeof WorkingCopyChange.Type;

/** An in-progress sequencer operation, derived from the git-dir markers. */
export const WorkingCopyOperation = Schema.Literals(["merge", "rebase", "cherry-pick", "revert"]);
export type WorkingCopyOperation = typeof WorkingCopyOperation.Type;

export const WorkingCopyResetMode = Schema.Literals(["soft", "mixed", "hard"]);
export type WorkingCopyResetMode = typeof WorkingCopyResetMode.Type;

export const WorkingCopyConflictSide = Schema.Literals(["ours", "theirs"]);
export type WorkingCopyConflictSide = typeof WorkingCopyConflictSide.Type;

export const WorkingCopyFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  area: WorkingCopyArea,
  change: WorkingCopyChange,
  /** Rename/copy source. */
  oldPath: Schema.optional(TrimmedNonEmptyString),
  insertions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
});
export type WorkingCopyFile = typeof WorkingCopyFile.Type;

export const WorkingCopyStatusResult = Schema.Struct({
  isRepo: Schema.Boolean,
  /** Short branch name, or `null` on an unborn or detached HEAD. */
  refName: Schema.NullOr(TrimmedNonEmptyString),
  detached: Schema.Boolean,
  /** Absent — not zero — when the upstream is `[gone]` or unset. */
  ahead: Schema.optional(NonNegativeInt),
  behind: Schema.optional(NonNegativeInt),
  hasUpstream: Schema.Boolean,
  files: Schema.Array(WorkingCopyFile),
  operationInProgress: Schema.NullOr(WorkingCopyOperation),
});
export type WorkingCopyStatusResult = typeof WorkingCopyStatusResult.Type;

export const WorkingCopyLogEntry = Schema.Struct({
  hash: TrimmedNonEmptyString,
  shortHash: TrimmedNonEmptyString,
  /** `--allow-empty-message` exists, so this is not constrained to non-empty. */
  subject: Schema.String,
  authorName: Schema.String,
  authorEmail: Schema.String,
  /** ISO 8601 author date (`%aI`). */
  authoredAt: IsoDateTime,
  parents: Schema.Array(TrimmedNonEmptyString),
});
export type WorkingCopyLogEntry = typeof WorkingCopyLogEntry.Type;

/** `hasMore` is answered by asking git for `limit + 1`, never guessed. */
export const WorkingCopyLogPage = Schema.Struct({
  entries: Schema.Array(WorkingCopyLogEntry),
  hasMore: Schema.Boolean,
});
export type WorkingCopyLogPage = typeof WorkingCopyLogPage.Type;

export const WorkingCopyCommitFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  change: WorkingCopyChange,
  oldPath: Schema.optional(TrimmedNonEmptyString),
  insertions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
});
export type WorkingCopyCommitFile = typeof WorkingCopyCommitFile.Type;

export const WorkingCopyRefKind = Schema.Literals(["head", "branch", "remote", "tag"]);
export type WorkingCopyRefKind = typeof WorkingCopyRefKind.Type;

export const WorkingCopyCommitRef = Schema.Struct({
  name: TrimmedNonEmptyString,
  kind: WorkingCopyRefKind,
});
export type WorkingCopyCommitRef = typeof WorkingCopyCommitRef.Type;

export const WorkingCopyCommitDetail = Schema.Struct({
  hash: TrimmedNonEmptyString,
  shortHash: TrimmedNonEmptyString,
  subject: Schema.String,
  body: Schema.String,
  authorName: Schema.String,
  authorEmail: Schema.String,
  authoredAt: IsoDateTime,
  parents: Schema.Array(TrimmedNonEmptyString),
  files: Schema.Array(WorkingCopyCommitFile),
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
  refs: Schema.Array(WorkingCopyCommitRef),
});
export type WorkingCopyCommitDetail = typeof WorkingCopyCommitDetail.Type;

export const WorkingCopyStashEntry = Schema.Struct({
  index: NonNegativeInt,
  /** `stash@{n}` — the only handle apply/pop/drop accept. */
  ref: TrimmedNonEmptyString,
  /**
   * fork: f4 — the stash commit's object name. `stash@{n}` is POSITIONAL and
   * every push/drop renumbers the stack, so a handle held across time (the
   * discard undo toast lives for 10s) must be this, not `ref`.
   * `restoreDiscardBackup` accepts either and re-resolves the index from this.
   */
  commit: Schema.optional(TrimmedNonEmptyString),
  label: Schema.String,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  /** True when the entry is one of the panel's own discard backups. */
  isDiscardBackup: Schema.Boolean,
});
export type WorkingCopyStashEntry = typeof WorkingCopyStashEntry.Type;

/**
 * The undo ladder's load-bearing field: `recoverable: false` means the discard
 * could not be backed by a pathspec stash (git < 2.13), so the client must
 * confirm first and offer no undo, permanently, for that repo.
 */
export const WorkingCopyDiscardResult = Schema.Struct({
  recoverable: Schema.Boolean,
  backupRef: Schema.optional(TrimmedNonEmptyString),
  discardedPaths: Schema.Array(TrimmedNonEmptyString),
  /**
   * fork: f4 — the preflight answer. `true` means **nothing was touched**: the
   * server found it could not take a backup and refused the destructive path
   * because the input did not carry `confirmedDestructive`. The client shows the
   * irrecoverable-discard confirm and retries with the flag set. This is what
   * makes the ladder's "discard on old git → confirm, no undo offered" rung
   * reachable on the FIRST discard rather than only after one has been lost.
   */
  requiresConfirmation: Schema.optional(Schema.Boolean),
});
export type WorkingCopyDiscardResult = typeof WorkingCopyDiscardResult.Type;

/**
 * A partially applied batch still reports what landed, so a multi-chunk stage
 * failing on chunk 3 does not read as "nothing happened".
 */
export const WorkingCopyBatchResult = Schema.Struct({
  staged: NonNegativeInt,
  failed: Schema.optional(
    Schema.Struct({
      paths: Schema.Array(TrimmedNonEmptyString),
      detail: Schema.String,
    }),
  ),
});
export type WorkingCopyBatchResult = typeof WorkingCopyBatchResult.Type;

export const WorkingCopyCommitResult = Schema.Struct({
  hash: TrimmedNonEmptyString,
  shortHash: TrimmedNonEmptyString,
  filesChanged: NonNegativeInt,
});
export type WorkingCopyCommitResult = typeof WorkingCopyCommitResult.Type;

export const WorkingCopyDiffResult = Schema.Struct({
  patch: Schema.String,
  truncated: Schema.Boolean,
});
export type WorkingCopyDiffResult = typeof WorkingCopyDiffResult.Type;

export const WorkingCopyFileContentResult = Schema.Struct({
  content: Schema.String,
  exists: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type WorkingCopyFileContentResult = typeof WorkingCopyFileContentResult.Type;

export const WorkingCopyLastCommitMessageResult = Schema.Struct({
  message: Schema.NullOr(Schema.String),
});
export type WorkingCopyLastCommitMessageResult = typeof WorkingCopyLastCommitMessageResult.Type;

/**
 * fork: f4 AI commit message — what the ✨ button drops into the composer.
 *
 * `subject` and `body` are carried separately because the composer splits its
 * draft on the first blank line; `message` is the already-joined form so a
 * caller that only wants "the text" cannot re-derive the join wrongly.
 */
export const WorkingCopyGeneratedCommitMessage = Schema.Struct({
  subject: Schema.String,
  /** May be empty — a one-line commit is a legitimate answer. */
  body: Schema.String,
  /** `subject`, or `subject` + blank line + `body`. */
  message: Schema.String,
});
export type WorkingCopyGeneratedCommitMessage = typeof WorkingCopyGeneratedCommitMessage.Type;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Every method carries a `cwd`, and every `cwd` is checked against the open
 * project roots and thread worktrees server-side before any git runs. That
 * guard is the security boundary of the whole feature.
 */
const WorkingCopyCwd = TrimmedNonEmptyString;
const WorkingCopyPath = TrimmedNonEmptyString;

export const WorkingCopyStatusInput = Schema.Struct({ cwd: WorkingCopyCwd });
export type WorkingCopyStatusInput = typeof WorkingCopyStatusInput.Type;

export const WorkingCopyDiffInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  path: WorkingCopyPath,
  /** Read the index side (`diff --cached`) rather than the worktree side. */
  staged: Schema.Boolean,
  /** Rename source, so git emits a rename header instead of a whole-file add. */
  oldPath: Schema.optional(WorkingCopyPath),
});
export type WorkingCopyDiffInput = typeof WorkingCopyDiffInput.Type;

export const WorkingCopyFileAtRefInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  /** A hash-ish revision, or `":"` for the index. */
  rev: TrimmedNonEmptyString,
  path: WorkingCopyPath,
});
export type WorkingCopyFileAtRefInput = typeof WorkingCopyFileAtRefInput.Type;

export const WorkingCopyPathsInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  /**
   * Empty means "everything" — `add -A` for stage, `reset HEAD` for unstage.
   * The composer's "commit all" rung relies on it: it stages the whole worktree
   * before committing rather than enumerating paths the status read may already
   * have raced. A caller that means "nothing" must not call at all.
   */
  paths: Schema.Array(WorkingCopyPath),
});
export type WorkingCopyPathsInput = typeof WorkingCopyPathsInput.Type;

export const WorkingCopyApplyPatchInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  patch: Schema.String,
  /** stage hunk = `cached`; unstage hunk = `cached` + `reverse`; discard hunk = `reverse`. */
  cached: Schema.optional(Schema.Boolean),
  reverse: Schema.optional(Schema.Boolean),
});
export type WorkingCopyApplyPatchInput = typeof WorkingCopyApplyPatchInput.Type;

export const WorkingCopyDiscardPathsInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  /** Empty means "everything" — the discard-all rung. */
  paths: Schema.Array(WorkingCopyPath),
  label: Schema.optional(Schema.String),
  /**
   * fork: f4 — "I know this cannot be backed up, do it anyway". Absent (the
   * default, and what every older client sends) makes the server REFUSE the
   * destructive fallback and answer `requiresConfirmation` instead, so no
   * unbackable discard can happen without the user having seen the dialog.
   */
  confirmedDestructive: Schema.optional(Schema.Boolean),
});
export type WorkingCopyDiscardPathsInput = typeof WorkingCopyDiscardPathsInput.Type;

export const WorkingCopyStashRefInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  ref: TrimmedNonEmptyString,
});
export type WorkingCopyStashRefInput = typeof WorkingCopyStashRefInput.Type;

export const WorkingCopyCwdInput = Schema.Struct({ cwd: WorkingCopyCwd });
export type WorkingCopyCwdInput = typeof WorkingCopyCwdInput.Type;

export const WorkingCopyCommitStagedInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  /** Travels to git over **stdin** (`commit -F -`), never argv. */
  message: Schema.String,
});
export type WorkingCopyCommitStagedInput = typeof WorkingCopyCommitStagedInput.Type;

export const WorkingCopyAmendCommitInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  /** Absent keeps the existing message (`--no-edit`). */
  message: Schema.optional(Schema.String),
});
export type WorkingCopyAmendCommitInput = typeof WorkingCopyAmendCommitInput.Type;

/**
 * fork: f4 AI commit message. There is no `paths` and no `message`: the panel
 * hand-builds the index, so the model describes exactly what is staged and
 * nothing else. The server never runs `add`.
 */
export const WorkingCopyGenerateCommitMessageInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  /**
   * Describe the *amended* commit — `HEAD`'s parent against the index — rather
   * than the index against `HEAD`. Without it, pressing ✨ while Amend is on
   * would describe only the changes added since the commit being rewritten.
   */
  amend: Schema.optional(Schema.Boolean),
});
export type WorkingCopyGenerateCommitMessageInput =
  typeof WorkingCopyGenerateCommitMessageInput.Type;

export const WorkingCopyLogInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  limit: Schema.optional(NonNegativeInt),
  /** Cursor: page continues *below* this hash via `--skip=1 <hash>`. */
  before: Schema.optional(WorkingCopyCommitHash),
  rev: Schema.optional(WorkingCopyCommitHash),
  grep: Schema.optional(Schema.String),
  author: Schema.optional(Schema.String),
  paths: Schema.optional(Schema.Array(WorkingCopyPath)),
});
export type WorkingCopyLogInput = typeof WorkingCopyLogInput.Type;

export const WorkingCopyCommitDetailInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  hash: WorkingCopyCommitHash,
});
export type WorkingCopyCommitDetailInput = typeof WorkingCopyCommitDetailInput.Type;

export const WorkingCopyCommitFileDiffInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  hash: WorkingCopyCommitHash,
  path: WorkingCopyPath,
  oldPath: Schema.optional(WorkingCopyPath),
});
export type WorkingCopyCommitFileDiffInput = typeof WorkingCopyCommitFileDiffInput.Type;

export const WorkingCopyStashPushInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  message: Schema.optional(Schema.String),
  includeUntracked: Schema.Boolean,
});
export type WorkingCopyStashPushInput = typeof WorkingCopyStashPushInput.Type;

export const WorkingCopyResolveConflictInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  path: WorkingCopyPath,
  /** Omitted means "mark resolved as-is" — just `add -- <path>`. */
  side: Schema.optional(WorkingCopyConflictSide),
});
export type WorkingCopyResolveConflictInput = typeof WorkingCopyResolveConflictInput.Type;

export const WorkingCopyAbortOperationInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  operation: WorkingCopyOperation,
});
export type WorkingCopyAbortOperationInput = typeof WorkingCopyAbortOperationInput.Type;

export const WorkingCopyCherryPickInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  hash: WorkingCopyCommitHash,
});
export type WorkingCopyCherryPickInput = typeof WorkingCopyCherryPickInput.Type;

export const WorkingCopyRevertCommitInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  hash: WorkingCopyCommitHash,
  /** Required to revert a merge commit. */
  mainline: Schema.optional(NonNegativeInt),
});
export type WorkingCopyRevertCommitInput = typeof WorkingCopyRevertCommitInput.Type;

export const WorkingCopyCheckoutCommitInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  hash: WorkingCopyCommitHash,
});
export type WorkingCopyCheckoutCommitInput = typeof WorkingCopyCheckoutCommitInput.Type;

export const WorkingCopyResetToCommitInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  hash: WorkingCopyCommitHash,
  mode: WorkingCopyResetMode,
});
export type WorkingCopyResetToCommitInput = typeof WorkingCopyResetToCommitInput.Type;

export const WorkingCopyTagCommitInput = Schema.Struct({
  cwd: WorkingCopyCwd,
  hash: WorkingCopyCommitHash,
  name: TrimmedNonEmptyString,
  message: Schema.optional(Schema.String),
});
export type WorkingCopyTagCommitInput = typeof WorkingCopyTagCommitInput.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The security boundary. A `cwd` outside every open project root and thread
 * worktree is **rejected**, never answered with a shaped empty — an RPC that
 * runs arbitrary git in an arbitrary directory is a sandbox escape, and a
 * plausible empty value reads as "this repo has nothing".
 */
export class WorkingCopyCwdDeniedError extends Schema.TaggedErrorClass<WorkingCopyCwdDeniedError>()(
  "WorkingCopyCwdDeniedError",
  {
    operation: Schema.String,
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return `Access denied in ${this.operation}: ${this.cwd} is outside every open project and thread worktree.`;
  }
}

/**
 * A revision that does not look like an object name never reaches git as
 * positional argv. Raised by the argv builders, not by git.
 */
export class WorkingCopyInvalidRevisionError extends Schema.TaggedErrorClass<WorkingCopyInvalidRevisionError>()(
  "WorkingCopyInvalidRevisionError",
  {
    operation: Schema.String,
    rev: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid revision in ${this.operation}: ${this.rev} is not an object name.`;
  }
}

/**
 * `index.lock` was still held after every retry. Distinct from a plain
 * non-zero exit so the client can say "another git process is running".
 */
export class WorkingCopyIndexLockedError extends Schema.TaggedErrorClass<WorkingCopyIndexLockedError>()(
  "WorkingCopyIndexLockedError",
  {
    operation: Schema.String,
    cwd: Schema.String,
    attempts: NonNegativeInt,
  },
) {
  override get message(): string {
    return `index.lock is still held in ${this.operation} after ${this.attempts} attempts (${this.cwd}). Another git process may be running.`;
  }
}

/**
 * fork: f4 AI commit message — the empty-index answer.
 *
 * Generating from the *unstaged* tree when nothing is staged would describe
 * changes the user is about to not commit, so this is a refusal rather than a
 * silent widening. It is a plain sentence in the UI, not a stderr dump, which
 * is why it carries no `detail`.
 */
export class WorkingCopyNothingStagedError extends Schema.TaggedErrorClass<WorkingCopyNothingStagedError>()(
  "WorkingCopyNothingStagedError",
  {
    operation: Schema.String,
    cwd: Schema.String,
    /** True when the caller asked about an amend, which changes the wording. */
    amend: Schema.Boolean,
  },
) {
  override get message(): string {
    return this.amend
      ? "Nothing to describe: the amended commit would be empty."
      : "Stage some changes first — the message is generated from the staged diff.";
  }
}

/**
 * Reuses the existing `VcsError` taxonomy — `VcsProcess` produces it for free —
 * and adds only the three failures the panel introduces.
 */
export const WorkingCopyError = Schema.Union([
  VcsError,
  WorkingCopyCwdDeniedError,
  WorkingCopyInvalidRevisionError,
  WorkingCopyIndexLockedError,
]);
export type WorkingCopyError = typeof WorkingCopyError.Type;

/**
 * fork: f4 AI commit message — `WorkingCopyError` plus the two failures only
 * generation can produce. Deliberately a *separate* union: widening
 * `WorkingCopyError` would change the decoded error type of all 28 existing
 * methods for one method's benefit.
 */
export const WorkingCopyCommitMessageError = Schema.Union([
  WorkingCopyError,
  WorkingCopyNothingStagedError,
  TextGenerationError,
]);
export type WorkingCopyCommitMessageError = typeof WorkingCopyCommitMessageError.Type;
