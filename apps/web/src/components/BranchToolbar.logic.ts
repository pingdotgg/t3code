import type { EnvironmentId, GitBranch, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime";
import { Schema } from "effect";
export {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
} from "@t3tools/shared/git";

export interface EnvironmentOption {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
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
    return preferredLocalLabel ?? `Primary environment ${input.environmentId.slice(0, 8)}`;
  }

  return runtimeLabel ?? savedLabel ?? input.environmentId;
}

export function resolveEnvModeLabel(mode: EnvMode): string {
  return mode === "worktree" ? "New worktree" : "Current checkout";
}

/**
 * Whether a thread worktree path is the project checkout itself (an explicit
 * "Current checkout" thread) rather than an isolated worktree. Paths are
 * compared textually after light normalization: the server stores the exact
 * string the client sent for explicit checkouts, so a mismatch here degrades
 * to the previous treat-as-worktree behavior instead of misreporting.
 */
export function isProjectCheckoutPath(
  worktreePath: string | null | undefined,
  projectCwd: string | null | undefined,
): boolean {
  if (!worktreePath || !projectCwd) {
    return false;
  }
  const normalize = (value: string) => value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = normalize(worktreePath);
  const normalizedCwd = normalize(projectCwd);
  return normalizedPath.length > 0 && normalizedPath === normalizedCwd;
}

/**
 * Single owner of the server-first project rule: a live server thread decides
 * the project; otherwise the composer draft does. Shared by BranchToolbar and
 * the ChatView terminal drawer so the active project cannot drift between the
 * toolbar, the terminal cwd, and the thread view.
 */
export function resolveActiveProjectRef(
  serverThread: { environmentId: EnvironmentId; projectId: ProjectId } | undefined,
  draftThread: { environmentId: EnvironmentId; projectId: ProjectId } | null,
): ScopedProjectRef | null {
  if (serverThread) {
    return scopeProjectRef(serverThread.environmentId, serverThread.projectId);
  }
  if (draftThread) {
    return scopeProjectRef(draftThread.environmentId, draftThread.projectId);
  }
  return null;
}

export function resolveCurrentWorkspaceLabel(
  activeWorktreePath: string | null,
  projectCwd?: string | null,
): string {
  if (activeWorktreePath && !isProjectCheckoutPath(activeWorktreePath, projectCwd ?? null)) {
    return "Current worktree";
  }
  return resolveEnvModeLabel("local");
}

export function resolveLockedWorkspaceLabel(
  activeWorktreePath: string | null,
  projectCwd?: string | null,
): string {
  if (activeWorktreePath && !isProjectCheckoutPath(activeWorktreePath, projectCwd ?? null)) {
    return "Worktree";
  }
  return "Local checkout";
}

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
  projectCwd?: string | null;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode, projectCwd } = input;
  if (isProjectCheckoutPath(activeWorktreePath, projectCwd ?? null)) {
    return "local";
  }
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
  branch: Pick<GitBranch, "isDefault" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, branch } = input;

  if (branch.worktreePath) {
    return {
      checkoutCwd: branch.worktreePath,
      nextWorktreePath: branch.worktreePath === activeProjectCwd ? null : branch.worktreePath,
      reuseExistingWorktree: true,
    };
  }

  const nextWorktreePath =
    activeWorktreePath !== null && branch.isDefault ? null : activeWorktreePath;

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
