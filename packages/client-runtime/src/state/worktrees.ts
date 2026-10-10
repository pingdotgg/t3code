import {
  WS_METHODS,
  type VcsListWorktreesResult,
  type VcsPruneWorktreesResult,
  type WorktreeInfo,
  type WorktreePruneBlocker,
  type WorktreePruneSkip,
  type WorktreeThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { vcsCommandScheduler, worktreeCommandConcurrency } from "./vcsCommandScheduler.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createWorktreeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:worktrees",
      tag: WS_METHODS.vcsListWorktrees,
      staleTimeMs: 15_000,
    }),
    changes: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:vcs:worktrees:changes",
      tag: WS_METHODS.subscribeWorktreeInventory,
    }),
    prune: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:worktrees:prune",
      tag: WS_METHODS.vcsPruneWorktrees,
      scheduler: vcsCommandScheduler,
      concurrency: worktreeCommandConcurrency,
    }),
  };
}

/**
 * Decides whether the inventory list must be read again. The list carries the
 * revision it was read at and the change stream carries the latest one, so a
 * change that lands between the two requests, during a read, while the view
 * was closed, or across a server restart all show up as a difference.
 *
 * Returns the key of the read to start, which the caller stores and passes
 * back as `lastRefreshKey`, or null. One read per distinct pair of revisions
 * means a failing read cannot loop, and nothing is decided while a read is in
 * flight: its result may already carry the latest revision.
 */
export function worktreeInventoryRefreshKey(input: {
  readonly listedRevision: number | undefined;
  readonly streamRevision: number | undefined;
  readonly isPending: boolean;
  readonly lastRefreshKey: string | null;
}): string | null {
  const { listedRevision, streamRevision } = input;
  if (input.isPending || listedRevision === undefined || streamRevision === undefined) return null;
  if (listedRevision === streamRevision) return null;
  const key = `${listedRevision}:${streamRevision}`;
  return key === input.lastRefreshKey ? null : key;
}

/** Worktrees the server confirmed removed since the list at `revision` was read. */
export interface ConfirmedWorktreeRemovals {
  readonly revision: number | undefined;
  readonly paths: ReadonlySet<string>;
}

export const NO_CONFIRMED_WORKTREE_REMOVALS: ConfirmedWorktreeRemovals = {
  revision: undefined,
  paths: new Set(),
};

/** Records a removal confirmed against the list read at `revision`. */
export function confirmWorktreeRemoval(
  current: ConfirmedWorktreeRemovals,
  revision: number | undefined,
  path: string,
): ConfirmedWorktreeRemovals {
  return {
    revision,
    paths: new Set(current.revision === revision ? [...current.paths, path] : [path]),
  };
}

/**
 * The rows to show: the last inventory read minus worktrees confirmed removed
 * since. Rows the server kept stay. A newer read replaces both, so a worktree
 * revived at the same path shows up again with that read.
 */
export function visibleWorktrees(
  inventory: VcsListWorktreesResult | null,
  removals: ConfirmedWorktreeRemovals,
): ReadonlyArray<WorktreeInfo> {
  if (inventory === null) return [];
  return removals.revision !== inventory.revision || removals.paths.size === 0
    ? inventory.worktrees
    : inventory.worktrees.filter((worktree) => !removals.paths.has(worktree.path));
}

export interface WorktreeProjectGroup {
  readonly projectId: WorktreeInfo["projectId"];
  readonly projectTitle: string;
  /** Every project that shares this repository, the primary one first. */
  readonly projectTitles: ReadonlyArray<string>;
  readonly workspaceRoot: string;
  /** Removable worktrees first. */
  readonly worktrees: ReadonlyArray<WorktreeInfo>;
  readonly removableCount: number;
}

export function groupWorktreesByProject(
  worktrees: ReadonlyArray<WorktreeInfo>,
): ReadonlyArray<WorktreeProjectGroup> {
  const byProject = new Map<WorktreeInfo["projectId"], WorktreeInfo[]>();
  for (const worktree of worktrees) {
    const group = byProject.get(worktree.projectId);
    if (group === undefined) byProject.set(worktree.projectId, [worktree]);
    else group.push(worktree);
  }
  return [...byProject.values()]
    .flatMap((group): WorktreeProjectGroup[] => {
      const [first] = group;
      if (first === undefined) return [];
      return [
        {
          projectId: first.projectId,
          projectTitle: first.projectTitle,
          projectTitles: first.projects.map((project) => project.projectTitle),
          workspaceRoot: first.workspaceRoot,
          worktrees: [...group].sort((a, b) => Number(b.safeToPrune) - Number(a.safeToPrune)),
          removableCount: group.filter((worktree) => worktree.safeToPrune).length,
        },
      ];
    })
    .sort(
      (a, b) =>
        a.projectTitle.localeCompare(b.projectTitle) ||
        a.workspaceRoot.localeCompare(b.workspaceRoot),
    );
}

/** "8, 3 removable" */
export function worktreeGroupSummary(group: WorktreeProjectGroup): string {
  return `${group.worktrees.length}, ${group.removableCount} removable`;
}

/** The branch, or for a detached checkout its short commit, which tells two apart. */
export function worktreeBranchLabel(worktree: WorktreeInfo): string {
  if (worktree.branch !== null) return worktree.branch;
  return worktree.headShortSha === null
    ? "Detached HEAD"
    : `Detached HEAD ${worktree.headShortSha}`;
}

/** Thread shown for a worktree: an open one first, then settled, then whatever is left. */
export function primaryLinkedThread(worktree: WorktreeInfo): {
  readonly thread: WorktreeThreadRef | null;
  readonly otherCount: number;
} {
  const linked = worktree.threads.filter((thread) => thread.status !== "deleted");
  const thread =
    linked.find((candidate) => candidate.status === "active") ??
    linked.find((candidate) => candidate.status === "settled") ??
    linked[0] ??
    null;
  return { thread, otherCount: thread === null ? 0 : linked.length - 1 };
}

/** "now", "40m", "3h", "12d", "2mo", "1y" */
export function formatWorktreeAge(iso: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return days < 365 ? `${months}mo` : `${Math.floor(days / 365)}y`;
}

const IN_USE_BLOCKERS: ReadonlySet<WorktreePruneBlocker> = new Set([
  "running",
  "session",
  "terminal",
]);

function workBlockerLabel(worktree: WorktreeInfo, blocker: WorktreePruneBlocker): string | null {
  switch (blocker) {
    case "dirty":
      return worktree.dirtyFileCount ? `${worktree.dirtyFileCount} changed` : "Local changes";
    case "unpushed": {
      // Against its upstream a branch is unpushed. Without one, or detached,
      // the count is against the default branch instead.
      const againstUpstream = worktree.branch !== null && worktree.aheadOfUpstreamCount !== null;
      const count = againstUpstream ? worktree.aheadOfUpstreamCount : worktree.aheadOfDefaultCount;
      const label = againstUpstream ? "unpushed" : "unmerged";
      return count ? `${count} ${label}` : label === "unpushed" ? "Unpushed" : "Unmerged";
    }
    case "submodules":
      return "Submodules";
    case "status_unavailable":
      return "Status unknown";
    case "unrestorable_thread":
      return "Linked thread";
    default:
      return null;
  }
}

// Git refuses this removal unless forced, which T3 Code never does for it.
const SUBMODULES_MESSAGE =
  "It has submodule repositories. Preserve their work and remove this checkout manually.";

const BLOCKER_DETAIL: Record<WorktreePruneBlocker, string> = {
  running: "A turn is running or queued here.",
  session: "A provider session is using this checkout.",
  terminal: "A terminal is open here.",
  open_thread: "A linked thread is not settled or archived.",
  dirty: "It has uncommitted changes.",
  submodules: SUBMODULES_MESSAGE,
  unpushed: "It has commits that are not pushed or merged.",
  unrestorable_thread: "A linked thread could not get this checkout back after removal.",
  status_unavailable: "Git status could not be read.",
};

export interface WorktreeStateLabel {
  /** "In use", "Open thread", "4 changed, 2 unpushed" */
  readonly text: string;
  /** Unsaved or unreadable work warns; a checkout that is merely in use does not. */
  readonly tone: "neutral" | "warning";
  /** Every reason, one sentence each, for a tooltip or a detail line. */
  readonly detail: string;
}

/**
 * What keeps a worktree from being removed, or null when it can be. The most
 * pressing class wins the short text: in use, then unsaved work, then an open
 * thread. `detail` still names every reason.
 */
export function worktreeStateLabel(worktree: WorktreeInfo): WorktreeStateLabel | null {
  if (worktree.safeToPrune) return null;
  const blockers = worktree.pruneBlockers;
  const detail = blockers.map((blocker) => BLOCKER_DETAIL[blocker]).join(" ");
  if (blockers.some((blocker) => IN_USE_BLOCKERS.has(blocker))) {
    return { text: "In use", tone: "neutral", detail };
  }
  const work = blockers.flatMap((blocker) => workBlockerLabel(worktree, blocker) ?? []);
  if (work.length > 0) {
    return {
      text: work.join(", "),
      tone: blockers.every(
        (blocker) => blocker === "unrestorable_thread" || blocker === "open_thread",
      )
        ? "neutral"
        : "warning",
      detail,
    };
  }
  return { text: "Open thread", tone: "neutral", detail };
}

/** "2 ignored" for a removable worktree whose removal also deletes ignored files. */
export function worktreeIgnoredNote(worktree: WorktreeInfo): string | null {
  return worktree.ignoredFileCount ? `${worktree.ignoredFileCount} ignored` : null;
}

export interface WorktreeRemovalConfirmation {
  readonly title: string;
  readonly message: string;
  /** Ignored paths the removal deletes; listed under the message when not empty. */
  readonly ignoredFiles: ReadonlyArray<string>;
  /** Ignored paths beyond the listed sample. */
  readonly ignoredMoreCount: number;
  /** Send `allowIgnoredFiles` only when the confirmation disclosed them. */
  readonly allowIgnoredFiles: boolean;
}

export function worktreeRemovalConfirmation(worktree: WorktreeInfo): WorktreeRemovalConfirmation {
  const ignoredCount = worktree.ignoredFileCount ?? 0;
  const kept =
    worktree.branch === null
      ? "The commit and checkpoints stay."
      : "The branch and checkpoints stay.";
  return {
    title: `Remove ${worktreeBranchLabel(worktree)}?`,
    message: ignoredCount > 0 ? `${kept} These ignored files are deleted:` : kept,
    ignoredFiles: worktree.ignoredFiles,
    ignoredMoreCount: Math.max(0, ignoredCount - worktree.ignoredFiles.length),
    allowIgnoredFiles: ignoredCount > 0,
  };
}

const SKIP_MESSAGE: Record<WorktreePruneSkip["reason"], string> = {
  running: "A turn is running or queued in it.",
  session: "A provider session is still using it.",
  terminal: "A terminal is open in it.",
  open_thread: "A linked thread is still open.",
  dirty: "It has uncommitted changes.",
  submodules: SUBMODULES_MESSAGE,
  unpushed: "It has commits that are not pushed or merged.",
  unrestorable_thread: "A linked thread could not get this checkout back.",
  status_unavailable: "Its Git status could not be read.",
  ignored_files: "It holds ignored files. Remove it from Settings to review them.",
  protected_path: "It is not a managed worktree.",
  unknown_worktree: "Git no longer registers it for this project.",
  changed: "It changed while it was being checked.",
  policy_changed: "The cleanup rule no longer applies.",
  remove_failed: "Git could not remove it.",
};

/** Why a removal request kept a worktree, as one sentence for a toast or alert. */
function worktreeSkipMessage(skip: Pick<WorktreePruneSkip, "reason" | "detail">): string {
  return skip.reason === "remove_failed" && skip.detail ? skip.detail : SKIP_MESSAGE[skip.reason];
}

/** The outcome of a request for a single worktree. */
export function worktreeRemovalOutcome(
  result: VcsPruneWorktreesResult,
): { readonly removed: true } | { readonly removed: false; readonly message: string } {
  if (result.removed.length > 0) return { removed: true };
  const [skip] = result.skipped;
  return {
    removed: false,
    message: skip === undefined ? "The worktree was kept." : worktreeSkipMessage(skip),
  };
}
