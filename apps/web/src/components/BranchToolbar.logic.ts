import type { EnvironmentId, VcsRef, ProjectId } from "@t3tools/contracts";
import { Schema } from "effect";
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

export function resolveLockedWorkspaceLabel(activeWorktreePath: string | null): string {
  return activeWorktreePath ? "Worktree" : "Local checkout";
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

export function resolveLocalCheckoutBranchMismatch(input: {
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): { threadBranch: string; currentBranch: string } | null {
  const { effectiveEnvMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (effectiveEnvMode !== "local" || activeWorktreePath !== null) {
    return null;
  }
  if (!activeThreadBranch || !currentGitBranch || activeThreadBranch === currentGitBranch) {
    return null;
  }
  return { threadBranch: activeThreadBranch, currentBranch: currentGitBranch };
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
