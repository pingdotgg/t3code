import type { EnvironmentId, VcsRef, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { canonicalizeWorktreePath, formatWorktreePathForDisplay } from "../worktreeCleanup";
export {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
} from "@t3tools/shared/git";

/**
 * An existing git worktree that a thread can be started in. Derived from the
 * branch ref list (each ref carries its `worktreePath` from `git worktree
 * list`), so it surfaces worktrees created by t3code AND by other tools
 * (JetBrains/git/etc.) as long as the worktree has a checked-out branch.
 */
/** Prefix used to encode an existing-worktree choice as a Select/Menu value. */
export const EXISTING_WORKTREE_VALUE_PREFIX = "existing-worktree:";

export interface ExistingWorktreeOption {
  /** The branch checked out in the worktree (used to bind the thread). */
  branch: string;
  /** Absolute worktree path (used as the thread's cwd). */
  worktreePath: string;
  /** Short label — the worktree's folder name (e.g. `t3code-4e609bb8`). */
  folderName: string;
}

/**
 * Collect the existing worktrees a thread could be started in, from the branch
 * refs. Excludes the project's main checkout and the currently-active worktree
 * (those are already covered by the "Current checkout" option). Deduped by
 * worktree path and sorted by folder name.
 */
export function deriveExistingWorktreeOptions(input: {
  refs: ReadonlyArray<Pick<VcsRef, "name" | "worktreePath">>;
  activeProjectCwd: string | null;
  activeWorktreePath: string | null;
}): ExistingWorktreeOption[] {
  const { refs, activeProjectCwd, activeWorktreePath } = input;
  // Compare on a canonical form (separators/trailing slash normalized) so a
  // worktree spelled differently by `git worktree list` and client state is
  // still excluded/deduped instead of leaking into the list.
  const canonicalProjectCwd = canonicalizeWorktreePath(activeProjectCwd);
  const canonicalActiveWorktree = canonicalizeWorktreePath(activeWorktreePath);
  const byPath = new Map<string, ExistingWorktreeOption>();
  for (const ref of refs) {
    const worktreePath = ref.worktreePath;
    if (!worktreePath) continue;
    const canonical = canonicalizeWorktreePath(worktreePath);
    if (!canonical) continue;
    if (canonical === canonicalProjectCwd) continue;
    if (canonical === canonicalActiveWorktree) continue;
    if (byPath.has(canonical)) continue;
    byPath.set(canonical, {
      branch: ref.name,
      worktreePath,
      folderName: formatWorktreePathForDisplay(worktreePath),
    });
  }
  return [...byPath.values()].sort((a, b) => a.folderName.localeCompare(b.folderName));
}

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
  if (!activeWorktreePath) return resolveEnvModeLabel("local");
  return `Current worktree · ${formatWorktreePathForDisplay(activeWorktreePath)}`;
}

export function resolveLockedWorkspaceLabel(activeWorktreePath: string | null): string {
  if (!activeWorktreePath) return "Local checkout";
  return `Worktree · ${formatWorktreePathForDisplay(activeWorktreePath)}`;
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
