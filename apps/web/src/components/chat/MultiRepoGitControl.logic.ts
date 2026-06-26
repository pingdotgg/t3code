import type { GitStackedAction, VcsStatusResult } from "@t3tools/contracts";

import { requiresDefaultBranchConfirmation, resolveQuickAction } from "../GitActionsControl.logic";

/** Rolled-up status across every repo root of a multi-repo workspace. */
export interface MultiRepoAggregate {
  /** Number of repos in the group. */
  readonly repoCount: number;
  /** Repos with uncommitted changes or commits to sync (ahead/behind). */
  readonly pendingRepos: number;
  /** Total changed working-tree files across all repos. */
  readonly changedFiles: number;
  /** Total commits ahead of upstream across all repos. */
  readonly ahead: number;
  /** Total commits behind upstream across all repos. */
  readonly behind: number;
}

/** A repo "needs attention" when it has local changes or is out of sync. */
export function isRepoPending(data: VcsStatusResult | null): boolean {
  if (!data) return false;
  return data.hasWorkingTreeChanges || data.aheadCount > 0 || data.behindCount > 0;
}

export function aggregateRepoStatuses(
  statuses: ReadonlyArray<VcsStatusResult | null>,
): MultiRepoAggregate {
  let pendingRepos = 0;
  let changedFiles = 0;
  let ahead = 0;
  let behind = 0;
  for (const data of statuses) {
    if (!data) continue;
    if (data.hasWorkingTreeChanges) changedFiles += data.workingTree.files.length;
    ahead += data.aheadCount;
    behind += data.behindCount;
    if (isRepoPending(data)) pendingRepos += 1;
  }
  return { repoCount: statuses.length, pendingRepos, changedFiles, ahead, behind };
}

/**
 * Short per-row status summary, e.g. "3 changes · ↑1", "↓2", "PR open", "Clean".
 * `isLoading` is the status atom's pending flag (initial fetch in flight).
 */
export function summarizeRepoStatus(data: VcsStatusResult | null, isLoading: boolean): string {
  if (!data) return isLoading ? "Checking…" : "Unavailable";
  const parts: string[] = [];
  if (data.hasWorkingTreeChanges) {
    const n = data.workingTree.files.length;
    parts.push(`${n} ${n === 1 ? "change" : "changes"}`);
  }
  if (data.aheadCount > 0) parts.push(`↑${data.aheadCount}`);
  if (data.behindCount > 0) parts.push(`↓${data.behindCount}`);
  if (parts.length > 0) return parts.join(" · ");
  if (data.pr?.state === "open") return "PR open";
  return "Clean";
}

/* ─── "Sync all" planning ────────────────────────────────────────────── */

export interface SyncAllGroupInput {
  readonly repoRoot: string;
  readonly displayName: string;
  readonly data: VcsStatusResult | null;
}

/** A single repo's batch step: run a stacked action, or pull. */
export type SyncAllStep =
  | {
      readonly kind: "run_action";
      readonly repoRoot: string;
      readonly displayName: string;
      readonly action: GitStackedAction;
      readonly isDefaultRef: boolean;
    }
  | { readonly kind: "pull"; readonly repoRoot: string; readonly displayName: string };

/** A pending repo that "Sync all" cannot auto-handle (needs an interactive step). */
export interface SyncAllSkip {
  readonly repoRoot: string;
  readonly displayName: string;
  readonly reason: string;
}

export interface SyncAllPlan {
  /** Repos with an action the batch can run unattended, in group order. */
  readonly steps: ReadonlyArray<SyncAllStep>;
  /** Pending repos requiring a manual step (publishing, etc.). */
  readonly skipped: ReadonlyArray<SyncAllSkip>;
  /** Display names whose action would commit/push directly to their default branch. */
  readonly defaultBranchRepos: ReadonlyArray<string>;
}

/**
 * Resolve each repo's primary action (via the same {@link resolveQuickAction} the
 * per-row buttons use) into a runnable batch plan. Repos that are up to date are
 * silently omitted; pending repos needing an interactive step are surfaced as
 * `skipped` so the UI can explain why they were left out.
 */
export function planSyncAll(groups: ReadonlyArray<SyncAllGroupInput>): SyncAllPlan {
  const steps: SyncAllStep[] = [];
  const skipped: SyncAllSkip[] = [];
  const defaultBranchRepos: string[] = [];

  for (const { repoRoot, displayName, data } of groups) {
    const quick = resolveQuickAction(
      data,
      false,
      data?.isDefaultRef ?? false,
      data?.hasPrimaryRemote ?? true,
    );

    // Disabled actions are no-ops (clean repo) — but a *pending* repo that still
    // can't act needs manual attention (e.g. diverged from upstream → rebase).
    if (quick.disabled) {
      if (isRepoPending(data)) {
        skipped.push({ repoRoot, displayName, reason: quick.hint ?? "Needs manual attention" });
      }
      continue;
    }

    if (quick.kind === "run_pull") {
      steps.push({ kind: "pull", repoRoot, displayName });
      continue;
    }

    if (quick.kind === "run_action" && quick.action) {
      const isDefaultRef = data?.isDefaultRef ?? false;
      steps.push({ kind: "run_action", repoRoot, displayName, action: quick.action, isDefaultRef });
      if (requiresDefaultBranchConfirmation(quick.action, isDefaultRef)) {
        defaultBranchRepos.push(displayName);
      }
      continue;
    }

    // open_pr / open_publish — can't run unattended. Only worth noting when the
    // repo actually has work to sync (a clean "View PR" repo isn't pending).
    if (isRepoPending(data)) {
      skipped.push({
        repoRoot,
        displayName,
        reason: quick.kind === "open_publish" ? "Needs publishing setup" : "Opens existing request",
      });
    }
  }

  return { steps, skipped, defaultBranchRepos };
}
