import type { EnvironmentId, VcsRef, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
export {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
} from "@t3tools/shared/git";

export interface EnvironmentOption {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  label: string;
  isPrimary: boolean;
}

export const EnvMode = Schema.Literals(["local", "worktree"]);
export type EnvMode = typeof EnvMode.Type;

const GENERIC_LOCAL_ENVIRONMENT_LABELS = new Set(["local", "local environment"]);

function normalizeDisplayLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function resolveEnvironmentOptionLabel(input: {
  isPrimary: boolean;
  environmentId: EnvironmentId;
  runtimeLabel?: string | null;
  savedLabel?: string | null;
}): string {
  const runtimeLabel = normalizeDisplayLabel(input.runtimeLabel);
  const savedLabel = normalizeDisplayLabel(input.savedLabel);

  if (input.isPrimary) {
    const preferredLocalLabel = [runtimeLabel, savedLabel].find((label) => {
      if (!label) return false;
      return !GENERIC_LOCAL_ENVIRONMENT_LABELS.has(label.toLowerCase());
    });
    return preferredLocalLabel ?? "This device";
  }

  return runtimeLabel ?? savedLabel ?? input.environmentId;
}

export function resolveEnvModeLabel(mode: EnvMode): string {
  return mode === "worktree" ? "New worktree" : "Current checkout";
}

export function resolveCurrentWorkspaceLabel(activeWorktreePath: string | null): string {
  return activeWorktreePath ? "Current worktree" : resolveEnvModeLabel("local");
}

/**
 * Provenance of a worktree thread's pinned base, derived from the
 * `worktree.base-pinned` activity the server records during bootstrap.
 */
export interface WorktreePinnedBase {
  readonly baseRefName: string;
  readonly baseCommitSha: string | null;
  readonly baseProvenance: "fresh" | "stale" | "local";
}

export function derivePinnedWorktreeBase(
  activities: ReadonlyArray<{ kind: string; payload: unknown }>,
): WorktreePinnedBase | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== "worktree.base-pinned") continue;
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    if (!payload) return null;
    const baseRefName = typeof payload.baseRefName === "string" ? payload.baseRefName : null;
    if (!baseRefName) return null;
    const baseCommitSha = typeof payload.baseCommitSha === "string" ? payload.baseCommitSha : null;
    const baseProvenance =
      payload.baseProvenance === "fresh" ||
      payload.baseProvenance === "stale" ||
      payload.baseProvenance === "local"
        ? payload.baseProvenance
        : "local";
    return { baseRefName, baseCommitSha, baseProvenance };
  }
  return null;
}

/**
 * Locked (post-send) workspace label. Once the base pin is known the promise
 * becomes a fact: "Worktree · a1b2c3f" instead of just "Worktree".
 */
export function resolveLockedWorkspaceLabel(
  activeWorktreePath: string | null,
  pinnedBase?: WorktreePinnedBase | null,
): string {
  if (!activeWorktreePath) {
    return "Local checkout";
  }
  const shortSha = pinnedBase?.baseCommitSha?.slice(0, 7);
  return shortSha ? `Worktree · ${shortSha}` : "Worktree";
}

export function resolvePinnedBaseTitle(pinnedBase: WorktreePinnedBase | null): string | null {
  if (!pinnedBase?.baseCommitSha) {
    return null;
  }
  const shortSha = pinnedBase.baseCommitSha.slice(0, 7);
  return pinnedBase.baseProvenance === "stale"
    ? `Pinned at ${shortSha} from ${pinnedBase.baseRefName} (remote was unreachable — last-known commit)`
    : pinnedBase.baseProvenance === "fresh"
      ? `Pinned at ${shortSha} from latest ${pinnedBase.baseRefName}`
      : `Pinned at ${shortSha} from local ${pinnedBase.baseRefName}`;
}

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode } = input;
  if (!hasServerThread) {
    if (activeWorktreePath) {
      return "local";
    }
    return draftThreadEnvMode === "worktree" ? "worktree" : "local";
  }
  return activeWorktreePath ? "worktree" : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

export function resolveBranchToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): string | null {
  const { envMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (envMode === "worktree" && !activeWorktreePath) {
    return activeThreadBranch ?? currentGitBranch;
  }
  return currentGitBranch ?? activeThreadBranch;
}

export function resolveBranchSelectionTarget(input: {
  activeProjectCwd: string;
  activeWorktreePath: string | null;
  refName: Pick<VcsRef, "isDefault" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, refName } = input;

  if (refName.worktreePath) {
    return {
      checkoutCwd: refName.worktreePath,
      nextWorktreePath: refName.worktreePath === activeProjectCwd ? null : refName.worktreePath,
      reuseExistingWorktree: true,
    };
  }

  const nextWorktreePath =
    activeWorktreePath !== null && refName.isDefault ? null : activeWorktreePath;

  return {
    checkoutCwd: nextWorktreePath ?? activeProjectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
  };
}

export function shouldIncludeBranchPickerItem(input: {
  itemValue: string;
  normalizedQuery: string;
  createBranchItemValue: string | null;
  checkoutPullRequestItemValue: string | null;
}): boolean {
  const { itemValue, normalizedQuery, createBranchItemValue, checkoutPullRequestItemValue } = input;

  if (normalizedQuery.length === 0) {
    return true;
  }

  if (createBranchItemValue && itemValue === createBranchItemValue) {
    return true;
  }

  if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
    return true;
  }

  return itemValue.toLowerCase().includes(normalizedQuery);
}
