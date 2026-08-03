/**
 * Pure decisions for the source-control (working copy) panel.
 *
 * Everything here is surface-neutral: no DOM, no React, no row heights, no
 * storage keys. Mobile reuses this file verbatim when the panel lands there,
 * which is why the commit-draft key, the history search staleness rule and the
 * liveness/poll decision live here rather than inside the web components.
 *
 * fork: f4 source-control panel
 */
import type { WorkingCopyLogEntry } from "@t3tools/contracts";

// ─── Commit message ─────────────────────────────────────────────────────────

/** Soft limit — past this the counter warns but nothing is blocked. */
export const COMMIT_SUBJECT_SOFT_LIMIT = 50;
/** Hard limit — past this the field takes a destructive ring. Still not blocked. */
export const COMMIT_SUBJECT_HARD_LIMIT = 72;

export type CommitSubjectLengthState = "ok" | "soft" | "hard";

export function commitSubjectLengthState(subject: string): CommitSubjectLengthState {
  if (subject.length > COMMIT_SUBJECT_HARD_LIMIT) {
    return "hard";
  }
  if (subject.length > COMMIT_SUBJECT_SOFT_LIMIT) {
    return "soft";
  }
  return "ok";
}

export interface CommitMessageParts {
  readonly subject: string;
  readonly body: string;
}

/**
 * The draft is stored as ONE string and split on the first blank line, exactly
 * like `git log` reads it back. Storing two fields would let a paste of a full
 * message land entirely in the subject.
 */
export function splitCommitMessage(message: string): CommitMessageParts {
  const normalized = message.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  if (separator === -1) {
    const firstNewline = normalized.indexOf("\n");
    if (firstNewline === -1) {
      return { subject: normalized, body: "" };
    }
    return {
      subject: normalized.slice(0, firstNewline),
      body: normalized.slice(firstNewline + 1),
    };
  }
  return {
    subject: normalized.slice(0, separator),
    body: normalized.slice(separator + 2),
  };
}

export function joinCommitMessage(parts: CommitMessageParts): string {
  return parts.body.trim().length === 0
    ? parts.subject
    : `${parts.subject}\n\n${parts.body.replace(/^\n+/, "")}`;
}

/**
 * The draft is keyed by **cwd**, never by thread. 2code keys it per project for
 * exactly one reason: committing repository A's message into repository B is
 * unrecoverable, and per-thread keying additionally loses the draft on every
 * thread switch inside the same worktree.
 */
export function commitDraftKey(cwd: string): string {
  return cwd;
}

// ─── The primary commit action ──────────────────────────────────────────────

export type CommitPrimaryAction = "commit" | "commit-all" | "amend" | "push";

export interface CommitPrimaryActionInput {
  readonly amend: boolean;
  readonly stagedCount: number;
  readonly dirtyCount: number;
  readonly ahead: number;
}

/**
 * One button that morphs and never disappears — a button that vanishes when the
 * tree goes clean makes the composer jump under the cursor.
 */
export function commitPrimaryAction(input: CommitPrimaryActionInput): CommitPrimaryAction {
  if (input.amend) {
    return "amend";
  }
  if (input.stagedCount > 0) {
    return "commit";
  }
  if (input.dirtyCount > 0) {
    return "commit-all";
  }
  return input.ahead > 0 ? "push" : "commit";
}

export function commitPrimaryActionLabel(action: CommitPrimaryAction, ahead: number): string {
  switch (action) {
    case "amend":
      return "Amend";
    case "commit":
      return "Commit";
    case "commit-all":
      return "Commit all";
    case "push":
      return ahead > 0 ? `Push ${ahead}` : "Push";
  }
}

/**
 * Amend can commit with a clean tree; everything else needs either staged files
 * or something to stage. Push needs commits to push.
 */
export function isCommitPrimaryActionEnabled(
  action: CommitPrimaryAction,
  input: CommitPrimaryActionInput & { readonly hasMessage: boolean },
): boolean {
  switch (action) {
    case "amend":
      return true;
    case "commit":
      return input.hasMessage && input.stagedCount > 0;
    case "commit-all":
      return input.hasMessage && input.dirtyCount > 0;
    case "push":
      return input.ahead > 0;
  }
}

/**
 * fork: f4 F-03 — the amend prefill is a TRANSITION, not an invariant.
 *
 * The composer's effect listed `message` as a dependency and had no edge guard,
 * so "amend is on and the draft is empty" was re-asserted on every render: the
 * box refilled itself the instant it went empty and could not be edited down or
 * cleared while Amend was ticked.
 *
 * `prefilledFor` is the last message this composer already filled in for the
 * current amend session; `null` means the prefill has not fired since amend was
 * last switched on.
 */
export function shouldPrefillAmendMessage(input: {
  readonly amend: boolean;
  readonly message: string;
  readonly lastCommitMessage: string | null;
  readonly prefilledFor: string | null;
}): boolean {
  if (!input.amend) return false;
  if (input.lastCommitMessage === null || input.lastCommitMessage.length === 0) return false;
  // Fill once per amend session — a second pass would undo the user's edits.
  if (input.prefilledFor === input.lastCommitMessage) return false;
  // Never overwrite text the user already has in the box.
  return input.message.trim().length === 0;
}

/**
 * fork: f4 F-07 — "Commit & push" has its OWN predicate.
 *
 * The overflow menu item and ⌘⇧↩ both reach `onCommitAndPush` without ever
 * consulting the primary button's `enabled`, so with an empty message and
 * nothing staged they used to stage the entire working tree and *then* have the
 * server reject the empty message: a disabled-looking action with a real,
 * unwanted side effect.
 */
export function isCommitAndPushEnabled(
  input: CommitPrimaryActionInput & { readonly hasMessage: boolean; readonly busy: boolean },
): boolean {
  if (input.busy || !input.hasMessage) {
    return false;
  }
  return input.stagedCount > 0 || input.dirtyCount > 0;
}

/**
 * fork: f4 F-07 — "Amend last commit" only needs a commit to amend and a free
 * `commit` busy key. It deliberately does NOT require a message: `git commit
 * --amend` with an empty message keeps the existing one.
 */
export function isAmendCommitEnabled(input: {
  readonly busy: boolean;
  readonly hasLastCommit: boolean;
}): boolean {
  return !input.busy && input.hasLastCommit;
}

// ─── AI commit message (the ✨ button) ──────────────────────────────────────

export interface CommitMessageGenerationInput {
  /** No cwd, no repository, nothing to describe. */
  readonly hasScope: boolean;
  readonly stagedCount: number;
  readonly amend: boolean;
  /** A generation is already in flight for this repository. */
  readonly generating: boolean;
  /** Any panel mutation is in flight (staging, committing, discarding…). */
  readonly busy: boolean;
  /**
   * `false` only when the client can *prove* no usable text-generation model
   * is configured. `null` means "not known yet" (the server config has not
   * arrived) and must not disable the button — the server answers definitively.
   */
  readonly modelConfigured: boolean | null;
}

export type CommitMessageGenerationDisabledReason =
  | "no-scope"
  | "generating"
  | "busy"
  | "nothing-staged"
  | "no-model";

export interface CommitMessageGenerationState {
  readonly enabled: boolean;
  readonly reason: CommitMessageGenerationDisabledReason | null;
}

/**
 * Order matters: the *most actionable* reason wins. "Stage something" is the
 * one the user can fix in one click, so it outranks "no model configured",
 * which is a settings trip.
 *
 * Amend is the one mode that does not require a staged file: `git commit
 * --amend` with an empty index still rewrites HEAD, and the server describes
 * `HEAD~1..index` for it.
 */
export function commitMessageGenerationState(
  input: CommitMessageGenerationInput,
): CommitMessageGenerationState {
  const disabled = (
    reason: CommitMessageGenerationDisabledReason,
  ): CommitMessageGenerationState => ({
    enabled: false,
    reason,
  });
  if (!input.hasScope) {
    return disabled("no-scope");
  }
  if (input.generating) {
    return disabled("generating");
  }
  if (input.busy) {
    return disabled("busy");
  }
  if (!input.amend && input.stagedCount === 0) {
    return disabled("nothing-staged");
  }
  if (input.modelConfigured === false) {
    return disabled("no-model");
  }
  return { enabled: true, reason: null };
}

export function commitMessageGenerationLabel(state: CommitMessageGenerationState): string {
  switch (state.reason) {
    case null:
      return "Generate a commit message";
    case "no-scope":
      return "Open a repository first";
    case "generating":
      return "Generating…";
    case "busy":
      return "Wait for the current action to finish";
    case "nothing-staged":
      return "Stage some changes first";
    case "no-model":
      return "Set a text generation model in Settings";
  }
}

export type CommitMessageGenerationApply = "fill" | "confirm" | "discard";

/**
 * What to do with a generated message when it lands.
 *
 * - the draft is empty → **fill** it,
 * - the draft is untouched since the press → **fill** it (this is the amend
 *   prefill case: the user asked for a rewrite of exactly that text),
 * - the draft changed mid-flight → **discard** the result. The user typed over
 *   it while the model was thinking; replacing their words with the model's is
 *   the one genuinely destructive outcome here, and 2code chose the same.
 * - the draft was non-empty and unchanged, but the user did not author it in
 *   this flight → **confirm** before overwriting.
 */
export function commitMessageGenerationApply(input: {
  readonly draftAtPress: string;
  readonly draftNow: string;
}): CommitMessageGenerationApply {
  if (input.draftNow !== input.draftAtPress) {
    return "discard";
  }
  return input.draftNow.trim().length === 0 ? "fill" : "confirm";
}

// ─── History search (hybrid: instant client filter + debounced server read) ──

export const HISTORY_SEARCH_DEBOUNCE_MS = 250;
export const HISTORY_SEARCH_SERVER_LIMIT = 200;

export interface HistoryFilter {
  readonly query: string;
  readonly author: string;
}

/**
 * A stale server answer must never be shown. Every server response is tagged
 * with the filter it was issued for; the panel drops any response whose key no
 * longer matches the live filter.
 */
export function historyFilterKey(filter: HistoryFilter): string {
  return `${filter.query.trim().toLowerCase()}${filter.author.trim().toLowerCase()}`;
}

export function isHistoryFilterActive(filter: HistoryFilter): boolean {
  return filter.query.trim().length > 0 || filter.author.trim().length > 0;
}

const HASH_ISH = /^[0-9a-f]{4,40}$/i;

/** A bare hash-looking query also earns a direct `rev` lookup on the server. */
export function isHashIshQuery(query: string): boolean {
  return HASH_ISH.test(query.trim());
}

export function matchesHistoryFilter(entry: WorkingCopyLogEntry, filter: HistoryFilter): boolean {
  const query = filter.query.trim().toLowerCase();
  const author = filter.author.trim().toLowerCase();
  if (author.length > 0) {
    const haystack = `${entry.authorName} ${entry.authorEmail}`.toLowerCase();
    if (!haystack.includes(author)) {
      return false;
    }
  }
  if (query.length === 0) {
    return true;
  }
  return (
    entry.subject.toLowerCase().includes(query) ||
    entry.hash.toLowerCase().startsWith(query) ||
    entry.shortHash.toLowerCase().startsWith(query) ||
    entry.authorName.toLowerCase().includes(query)
  );
}

/**
 * The instant local filter and the server answer are one list: deduped by hash,
 * newest first. The server can legitimately return commits that were never
 * paged in locally, and the local list can legitimately hold commits newer than
 * the (limited) server page.
 */
export function mergeHistorySearchResults(
  loaded: ReadonlyArray<WorkingCopyLogEntry>,
  serverResults: ReadonlyArray<WorkingCopyLogEntry>,
  filter: HistoryFilter,
): ReadonlyArray<WorkingCopyLogEntry> {
  const byHash = new Map<string, WorkingCopyLogEntry>();
  for (const entry of loaded) {
    if (matchesHistoryFilter(entry, filter)) {
      byHash.set(entry.hash, entry);
    }
  }
  for (const entry of serverResults) {
    if (!byHash.has(entry.hash)) {
      byHash.set(entry.hash, entry);
    }
  }
  return [...byHash.values()].sort((left, right) => {
    const delta = Date.parse(right.authoredAt) - Date.parse(left.authoredAt);
    return delta !== 0 ? delta : left.hash.localeCompare(right.hash);
  });
}

/** Authors present in the loaded page, with counts, for the author filter. */
export function historyAuthorFacets(
  entries: ReadonlyArray<WorkingCopyLogEntry>,
): ReadonlyArray<{ readonly name: string; readonly count: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.authorName, (counts.get(entry.authorName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

// ─── Liveness ───────────────────────────────────────────────────────────────

/**
 * There is no `subscribeWorkingCopy` (see `build-log-f4-server.md` deviation 1).
 * Liveness is: re-read on the existing `subscribeVcsStatus` push, re-read after
 * every mutation, and a slow visible-only poll as the floor. The poll exists so
 * an agent committing in a terminal is eventually reflected even if the push
 * were to be missed; it must never run while the panel is hidden.
 */
export const WORKING_COPY_POLL_INTERVAL_MS = 15_000;

export interface WorkingCopyPollInput {
  readonly visible: boolean;
  readonly hasCwd: boolean;
  /** True while a mutation is in flight — polling then would fight the write. */
  readonly busy: boolean;
  /**
   * The last answer's `isRepo`, or `null` before the first answer. A cwd that
   * is not a repository cannot become one without a mutation the panel would
   * see, so re-asking every 15s is pure waste.
   */
  readonly isRepo?: boolean | null | undefined;
}

export function shouldPollWorkingCopy(input: WorkingCopyPollInput): boolean {
  return input.visible && input.hasCwd && !input.busy && input.isRepo !== false;
}

/**
 * Repeated status-read failures surface a dismissible inline banner. One
 * failure is noise (a rebase moving `index.lock` under the read); two in a row
 * is a real problem the user should see.
 */
export const WORKING_COPY_ERROR_BANNER_STREAK = 2;

export function shouldShowStatusErrorBanner(input: {
  readonly consecutiveFailures: number;
  readonly dismissed: boolean;
}): boolean {
  return !input.dismissed && input.consecutiveFailures >= WORKING_COPY_ERROR_BANNER_STREAK;
}

export function nextStatusFailureStreak(current: number, failed: boolean): number {
  return failed ? current + 1 : 0;
}
