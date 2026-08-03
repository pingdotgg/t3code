/**
 * Presentation decisions for the source-control panel that are worth pinning
 * with a test but are not worth mounting a component for.
 *
 * fork: f4 source-control panel
 */
import type { WorkingCopyFile, WorkingCopyOperation } from "@t3tools/contracts";

import type { ChangesGroup } from "~/lib/sourceControl/changesRows";
import type { HistoryWidth } from "~/lib/sourceControl/historyRows";

// ─── Status letters ─────────────────────────────────────────────────────────

/**
 * The single-letter badge on a row. Untracked renders as `U` rather than `?`
 * because `?` reads as "unknown state" next to a real porcelain letter.
 */
export function changeLetter(change: WorkingCopyFile["change"]): string {
  switch (change) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "untracked":
      return "U";
    case "typechange":
      return "T";
    case "unmerged":
      return "!";
  }
}

export function changeLabel(change: WorkingCopyFile["change"]): string {
  switch (change) {
    case "added":
      return "Added";
    case "modified":
      return "Modified";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    case "untracked":
      return "Untracked";
    case "typechange":
      return "Type changed";
    case "unmerged":
      return "Conflicted";
  }
}

/** `src/lib/thing.ts` → `{ name: "thing.ts", dir: "src/lib" }`. */
export function splitDisplayPath(path: string): { readonly name: string; readonly dir: string } {
  const index = path.lastIndexOf("/");
  return index === -1
    ? { name: path, dir: "" }
    : { name: path.slice(index + 1), dir: path.slice(0, index) };
}

// ─── Group headers ──────────────────────────────────────────────────────────

/** Filtering hides rows; the header must still say how many exist. */
export function groupHeaderCountLabel(total: number, visible: number): string {
  return visible === total ? `${total}` : `${visible} of ${total}`;
}

export function groupIsCollapsible(group: ChangesGroup): boolean {
  // Conflicts are never collapsible: hiding a blocked merge behind a chevron is
  // how people end up committing a half-resolved tree.
  return group !== "conflicted";
}

// ─── Continue / abort copy for an in-progress operation ─────────────────────

export interface OperationGuidance {
  readonly title: string;
  /** Enabled only at zero conflicts. */
  readonly continueLabel: string;
  /**
   * True only for `merge`. Rebase/cherry-pick/revert continuation is left to
   * the terminal on purpose — driving `rebase --continue` through a
   * non-interactive subprocess is a reliable source of stuck states.
   */
  readonly canContinueInPanel: boolean;
  readonly terminalHint: string | null;
}

export function operationGuidance(operation: WorkingCopyOperation): OperationGuidance {
  if (operation === "merge") {
    return {
      title: "Merge in progress",
      continueLabel: "Commit merge",
      canContinueInPanel: true,
      terminalHint: null,
    };
  }
  const label =
    operation === "rebase" ? "Rebase" : operation === "cherry-pick" ? "Cherry-pick" : "Revert";
  return {
    title: `${label} in progress`,
    continueLabel: "Continue",
    canContinueInPanel: false,
    terminalHint: `Conflicts resolved — stage them, then run \`git ${operation} --continue\` in the terminal.`,
  };
}

// ─── Responsive history rows ────────────────────────────────────────────────

/**
 * Bucketed off the timeline element, not the window: the panel can be a narrow
 * right dock inside a wide window, and vice versa on a sheet.
 */
export function historyWidthBucket(width: number): HistoryWidth {
  if (width < 300) return "xs";
  if (width < 380) return "sm";
  if (width < 460) return "md";
  if (width < 540) return "lg";
  return "xl";
}

export interface HistoryRowElements {
  readonly twoLine: boolean;
  readonly shortHash: boolean;
  readonly authorName: boolean;
  readonly diffstat: boolean;
  readonly refBadges: number;
}

/**
 * `twoLine` MUST agree with `historyCommitRowHeight`'s own `width !== "xs"`
 * rule: the height comes from there, and a row that draws one line into a
 * two-line box (or the reverse) is the silent-drift failure the declared
 * heights exist to prevent.
 */
export function historyRowElements(width: HistoryWidth): HistoryRowElements {
  switch (width) {
    case "xs":
      return { twoLine: false, shortHash: false, authorName: false, diffstat: false, refBadges: 0 };
    case "sm":
      return { twoLine: true, shortHash: true, authorName: false, diffstat: false, refBadges: 1 };
    case "md":
      return { twoLine: true, shortHash: true, authorName: true, diffstat: false, refBadges: 1 };
    case "lg":
      return { twoLine: true, shortHash: true, authorName: true, diffstat: true, refBadges: 1 };
    case "xl":
      return { twoLine: true, shortHash: true, authorName: true, diffstat: true, refBadges: 2 };
  }
}

// ─── Staging selections ─────────────────────────────────────────────────────

/**
 * fork: f4 — the wire spelling of "stage/unstage everything".
 * `WorkingCopyPathsInput` documents an empty `paths` array as "everything", and
 * the server runs one pathless `add -A` / `reset HEAD` for it. Named so the
 * commit-all rung cannot be mistaken for an accidental no-op call and "fixed"
 * into one.
 */
export const STAGE_ALL_PATHS: ReadonlyArray<string> = [];

/**
 * A per-path stage/unstage press with nothing selected means "nothing", NOT
 * "everything" — the callers guard on this so an empty selection can never be
 * promoted into a whole-worktree mutation.
 */
export function isEmptyPathSelection(paths: ReadonlyArray<string>): boolean {
  return paths.length === 0;
}

// ─── Busy keys ──────────────────────────────────────────────────────────────

/**
 * One key per (action, scope) pair. A re-entrant press on a key already in
 * flight is a no-op rather than a second RPC — double-firing `discard` would
 * produce two backup stashes and a confusing pair of undo toasts.
 */
export function actionBusyKey(action: string, scope?: string): string {
  return scope === undefined ? action : `${action}:${scope}`;
}

/**
 * The separator for a multi-path busy scope. `\0` cannot occur in a git path,
 * so two different selections can never collide on one key. Written as an
 * escape rather than the raw byte so the source stays text.
 */
export const BUSY_KEY_SEPARATOR = "\0";

/** Busy actions whose scope is a path list the changes list can highlight. */
const PATH_SCOPED_BUSY_ACTIONS: ReadonlySet<string> = new Set([
  "stage",
  "unstage",
  "discard",
  "resolve",
]);

const EMPTY_BUSY_PATHS: ReadonlySet<string> = new Set<string>();

/**
 * fork: f4 — project the busy KEY set onto the paths those actions touch, so
 * `ChangesList` can show per-row spinners. `stage:*` (the commit-all rung) and
 * the unscoped keys carry no paths and contribute nothing.
 */
export function busyPathsFromKeys(busy: ReadonlySet<string>): ReadonlySet<string> {
  if (busy.size === 0) {
    return EMPTY_BUSY_PATHS;
  }
  const paths = new Set<string>();
  for (const key of busy) {
    const separator = key.indexOf(":");
    if (separator === -1) continue;
    if (!PATH_SCOPED_BUSY_ACTIONS.has(key.slice(0, separator))) continue;
    const scope = key.slice(separator + 1);
    if (scope === "*") continue;
    for (const path of scope.split(BUSY_KEY_SEPARATOR)) {
      if (path.length > 0) paths.add(path);
    }
  }
  return paths.size === 0 ? EMPTY_BUSY_PATHS : paths;
}

export function withBusyKey(
  busy: ReadonlySet<string>,
  key: string,
  active: boolean,
): ReadonlySet<string> {
  if (active === busy.has(key)) {
    return busy;
  }
  const next = new Set(busy);
  if (active) next.add(key);
  else next.delete(key);
  return next;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Mutation errors surface the FULL stderr. The server deliberately keeps it
 * untruncated on `VcsProcessExitError.detail`; truncating here would throw away
 * the one thing that makes a git failure actionable.
 */
export function describeWorkingCopyError(error: unknown): string {
  if (error === null || error === undefined) {
    return "The git command failed.";
  }
  if (typeof error === "string") {
    return error.trim().length > 0 ? error : "The git command failed.";
  }
  if (typeof error === "object") {
    const record = error as { readonly detail?: unknown; readonly message?: unknown };
    if (typeof record.detail === "string" && record.detail.trim().length > 0) {
      return record.detail;
    }
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      return record.message;
    }
  }
  return "The git command failed.";
}

/** A containment denial is the one failure a retry can never fix. */
export function isCwdDeniedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly _tag?: unknown })._tag === "WorkingCopyCwdDeniedError"
  );
}
