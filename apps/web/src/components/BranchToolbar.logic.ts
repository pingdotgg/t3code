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

export interface ExistingWorktreeOption {
  readonly branch: string;
  readonly path: string;
  readonly label: string;
  readonly isProjectCheckout: boolean;
}

export interface WorkspaceOptions {
  readonly mainCheckout: ExistingWorktreeOption | null;
  readonly existingWorktrees: readonly ExistingWorktreeOption[];
}

export function normalizeWorkspacePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
}

function looksLikeWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:\//.test(path);
}

function workspacePathKey(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  // Paths may come from a remote Windows environment even when the UI runs on
  // another OS, so detect Windows paths by shape rather than process.platform.
  return looksLikeWindowsPath(normalized) ? normalized.toLowerCase() : normalized;
}

export function workspacePathsEqual(left: string, right: string): boolean {
  return workspacePathKey(left) === workspacePathKey(right);
}

export function resolveWorkspaceSelection(input: {
  readonly effectiveEnvMode: EnvMode;
  readonly activeWorktreePath: string | null;
  readonly mainCheckout: ExistingWorktreeOption | null;
  readonly existingWorktrees: readonly ExistingWorktreeOption[];
}): {
  readonly isMainCheckout: boolean;
  readonly selectedExistingWorktree: ExistingWorktreeOption | undefined;
  readonly value: string;
  readonly label: string;
} {
  const { effectiveEnvMode, activeWorktreePath, mainCheckout, existingWorktrees } = input;
  const isMainCheckout = activeWorktreePath
    ? mainCheckout !== null && workspacePathsEqual(mainCheckout.path, activeWorktreePath)
    : effectiveEnvMode === "local" && mainCheckout === null;
  const selectedExistingWorktree = activeWorktreePath
    ? existingWorktrees.find((worktree) => workspacePathsEqual(worktree.path, activeWorktreePath))
    : effectiveEnvMode === "local"
      ? existingWorktrees.find((worktree) => worktree.isProjectCheckout)
      : undefined;
  const value = isMainCheckout
    ? mainCheckout
      ? `main:${mainCheckout.path}`
      : "local"
    : selectedExistingWorktree
      ? `existing:${selectedExistingWorktree.path}`
      : effectiveEnvMode;
  const label = isMainCheckout
    ? "Main checkout"
    : selectedExistingWorktree
      ? selectedExistingWorktree.label
      : effectiveEnvMode === "worktree"
        ? resolveEnvModeLabel("worktree")
        : "Main checkout";

  return { isMainCheckout, selectedExistingWorktree, value, label };
}

export function deriveWorkspaceOptions(
  refs: readonly VcsRef[],
  projectWorkspaceRoot: string,
  mainCheckoutPath?: string | null,
): WorkspaceOptions {
  const worktreeOptions = refs.flatMap((ref): ExistingWorktreeOption[] => {
    const worktreePath = ref.worktreePath?.trim();
    if (!worktreePath) return [];
    return [
      {
        branch: ref.name,
        path: worktreePath,
        label: ref.name,
        isProjectCheckout: workspacePathsEqual(worktreePath, projectWorkspaceRoot),
      },
    ];
  });
  const explicitMainCheckoutPath = mainCheckoutPath?.trim() || null;
  const mainCheckoutRef = explicitMainCheckoutPath
    ? refs.find(
        (ref) =>
          ref.worktreePath !== null &&
          workspacePathsEqual(ref.worktreePath, explicitMainCheckoutPath),
      )
    : refs.find(
        (ref) =>
          ref.isDefault &&
          ref.worktreePath !== null &&
          !workspacePathsEqual(ref.worktreePath, projectWorkspaceRoot),
      );
  const resolvedMainCheckoutPath =
    explicitMainCheckoutPath ?? mainCheckoutRef?.worktreePath ?? null;
  const mainCheckout =
    resolvedMainCheckoutPath !== null &&
    !workspacePathsEqual(resolvedMainCheckoutPath, projectWorkspaceRoot)
      ? (worktreeOptions.find((option) =>
          workspacePathsEqual(option.path, resolvedMainCheckoutPath),
        ) ?? {
          branch: mainCheckoutRef?.name ?? "HEAD",
          label: mainCheckoutRef?.name ?? "Main checkout",
          path: resolvedMainCheckoutPath,
          isProjectCheckout: false,
        })
      : null;
  const seenPaths = new Set(mainCheckout ? [workspacePathKey(mainCheckout.path)] : []);
  const existingWorktrees = worktreeOptions.filter((option) => {
    if (mainCheckout === null && option.isProjectCheckout) return false;
    const pathKey = workspacePathKey(option.path);
    if (seenPaths.has(pathKey)) return false;
    seenPaths.add(pathKey);
    return true;
  });
  return { mainCheckout, existingWorktrees };
}

export function resolveMainCheckoutTarget(
  refs: readonly VcsRef[],
  projectWorkspaceRoot: string,
  mainCheckoutPath?: string | null,
): { readonly branch: string; readonly path: string | null } | null {
  const options = deriveWorkspaceOptions(refs, projectWorkspaceRoot, mainCheckoutPath);
  if (options.mainCheckout) {
    return { branch: options.mainCheckout.branch, path: options.mainCheckout.path };
  }

  const projectCheckoutRef = refs.find(
    (ref) =>
      !ref.isRemote &&
      ref.worktreePath !== null &&
      workspacePathsEqual(ref.worktreePath, projectWorkspaceRoot),
  );
  const currentRef = refs.find((ref) => !ref.isRemote && ref.current);
  const defaultRef = refs.find((ref) => !ref.isRemote && ref.isDefault);
  const branch = projectCheckoutRef?.name ?? currentRef?.name ?? defaultRef?.name;
  return branch ? { branch, path: null } : null;
}

export function withActiveWorkspaceFallback(
  options: WorkspaceOptions,
  input: {
    readonly activeWorktreePath: string | null;
    readonly activeBranch: string | null;
    readonly projectWorkspaceRoot: string;
  },
): WorkspaceOptions {
  const activePath = input.activeWorktreePath?.trim();
  if (
    !activePath ||
    (options.mainCheckout !== null && workspacePathsEqual(options.mainCheckout.path, activePath)) ||
    options.existingWorktrees.some((worktree) => workspacePathsEqual(worktree.path, activePath))
  ) {
    return options;
  }

  const fallback: ExistingWorktreeOption = {
    branch: input.activeBranch?.trim() || "Current worktree",
    path: activePath,
    label:
      input.activeBranch?.trim() ||
      normalizeWorkspacePath(activePath).split("/").at(-1) ||
      "Current worktree",
    isProjectCheckout: workspacePathsEqual(activePath, input.projectWorkspaceRoot),
  };
  return { ...options, existingWorktrees: [...options.existingWorktrees, fallback] };
}

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
  return mode === "worktree" ? "New worktree" : "Main checkout";
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
