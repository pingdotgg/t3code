import type {
  EnvironmentId,
  EnvironmentMachineKind,
  VcsRef,
  ProjectId,
  WorktreeSubmodules,
} from "@t3tools/contracts";
import type { ThreadStructureRuntime } from "@t3tools/client-runtime/state/shell";
import * as Schema from "effect/Schema";
import { sanitizeNewRefName } from "@t3tools/shared/git";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { deriveCanInterruptRunningThread } from "../session-logic";
export { deriveLocalBranchNameFromRemoteRef, sanitizeNewRefName } from "@t3tools/shared/git";

export interface EnvironmentOption {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  label: string;
  isPrimary: boolean;
  machine: EnvironmentMachineKind;
}

/** "Add to another machine" stays muted until hovered: easy to find, quieter than the machines. */
export const ADD_TO_MACHINE_LABEL_CLASS =
  "flex min-w-0 items-center gap-1.5 opacity-55 in-data-highlighted:opacity-100 in-data-popup-open:opacity-100";

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

export function shouldShowEnvironmentIndicator(input: {
  activeEnvironment: Pick<EnvironmentOption, "isPrimary"> | null;
  canPickEnvironment: boolean;
}): boolean {
  if (input.canPickEnvironment) return true;
  return input.activeEnvironment !== null && !input.activeEnvironment.isPrimary;
}

export function shouldShowComposerContextStrip(input: {
  isDraftHeroState: boolean;
  persistInActiveThreads: boolean;
  hasActiveProject: boolean;
  isGitRepo: boolean;
  showEnvironmentIndicator: boolean;
}): boolean {
  // A new thread always shows the strip, since it names the permissions the first send uses.
  return (
    input.hasActiveProject &&
    (input.isDraftHeroState ||
      (input.persistInActiveThreads && (input.isGitRepo || input.showEnvironmentIndicator)))
  );
}

// Hysteresis prevents labels and icons from flapping at the width boundary.
const CONTEXT_STRIP_COMPACT_EXPAND_HYSTERESIS_PX = 16;

export type ContextStripCompaction = "none" | "labels" | "branch";

export function readContextStripCompaction(value: string | undefined): ContextStripCompaction {
  return value === "labels" || value === "branch" ? value : "none";
}

export function resolveContextStripCompaction(input: {
  current: ContextStripCompaction;
  neededWidth: number;
  labelsNeededWidth: number;
  availableWidth: number;
}): ContextStripCompaction {
  const fits = (width: number, expanding: boolean) =>
    width <= input.availableWidth - (expanding ? CONTEXT_STRIP_COMPACT_EXPAND_HYSTERESIS_PX : 0);
  if (fits(input.neededWidth, input.current !== "none")) return "none";
  if (fits(input.labelsNeededWidth, input.current === "branch")) return "labels";
  return "branch";
}

export function resolveEnvModeLabel(mode: EnvMode): string {
  return mode === "worktree" ? "New worktree" : "Current checkout";
}

export const WORKTREE_SUBMODULES_LABELS: Record<WorktreeSubmodules, string> = {
  recursive: "Recursive",
  "top-level": "Top level only",
  none: "Skip",
};

export function resolveCurrentWorkspaceLabel(activeWorktreePath: string | null): string {
  return activeWorktreePath ? "Current worktree" : resolveEnvModeLabel("local");
}

export function resolveLockedWorkspaceLabel(
  activeWorktreePath: string | null,
  effectiveEnvMode: EnvMode,
): string {
  if (activeWorktreePath) return activeWorktreePath.split(/[\\/]/).findLast(Boolean) ?? "Worktree";
  return effectiveEnvMode === "worktree" ? resolveEnvModeLabel("worktree") : "Local checkout";
}

export interface PreviousWorktreeSeed {
  branch: string | null;
  worktreePath: string;
  /** When a thread last touched the worktree, for the picker's "2h ago". */
  updatedAt: string;
}

export function resolvePreviousWorktreeSeed(input: {
  threads: ReadonlyArray<{
    branch: string | null;
    worktreePath: string | null;
    updatedAt: string;
    archivedAt?: string | null;
  }>;
  currentWorktreePath: string | null;
}): PreviousWorktreeSeed | null {
  let latest: {
    branch: string | null;
    worktreePath: string;
    updatedAt: number;
    updatedAtIso: string;
  } | null = null;
  for (const thread of input.threads) {
    if (
      !thread.worktreePath ||
      thread.worktreePath === input.currentWorktreePath ||
      (thread.archivedAt ?? null) !== null
    ) {
      continue;
    }
    const updatedAt = toSortableTimestamp(thread.updatedAt);
    if (updatedAt === null) {
      continue;
    }
    if (latest === null || updatedAt > latest.updatedAt) {
      latest = {
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        updatedAt,
        updatedAtIso: thread.updatedAt,
      };
    }
  }
  return latest === null
    ? null
    : { branch: latest.branch, worktreePath: latest.worktreePath, updatedAt: latest.updatedAtIso };
}

export function resolvePreviousWorktreeLabel(seed: PreviousWorktreeSeed): string {
  return seed.branch ? `Previous worktree (${seed.branch})` : "Previous worktree";
}

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
  preparingWorktree?: boolean;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode, preparingWorktree } = input;
  if (!hasServerThread) {
    if (activeWorktreePath) {
      return "local";
    }
    return draftThreadEnvMode === "worktree" ? "worktree" : "local";
  }
  return activeWorktreePath || preparingWorktree ? "worktree" : "local";
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

export interface BranchHold {
  readonly branch: string | null;
  readonly environmentId: EnvironmentId;
  /**
   * Each checkout the thread can show before it catches up, with the branch its status reported
   * before the switch. A move from a worktree to the project root lists both.
   */
  readonly checkouts: ReadonlyArray<{ readonly cwd: string; readonly replaces: string | null }>;
}

/**
 * A finished checkout's branch stays on screen until status reports any change, because the status
 * stream and the RPC reply are not ordered and showing status first would flip back to the old branch.
 */
export function isBranchHoldCurrent(
  hold: BranchHold,
  current: {
    readonly canonicalBranch: string | null;
    readonly environmentId: EnvironmentId;
    readonly cwd: string | null;
  },
): boolean {
  return (
    hold.environmentId === current.environmentId &&
    hold.checkouts.some(
      (checkout) => checkout.cwd === current.cwd && checkout.replaces === current.canonicalBranch,
    )
  );
}

/**
 * The base a New worktree thread gets without the user picking one. Only a listed ref qualifies:
 * during a clone the status names an unborn HEAD that no ref backs.
 */
export function resolveDefaultWorktreeBaseBranch(
  refs: ReadonlyArray<Pick<VcsRef, "name" | "isDefault" | "current">>,
): string | null {
  return (refs.find((ref) => ref.isDefault) ?? refs.find((ref) => ref.current))?.name ?? null;
}

export function resolveBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  resolvedActiveBranch: string | null;
  resolvedActiveBranchIsRemote: boolean | null;
  startFromOrigin: boolean;
}): string {
  const {
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
    resolvedActiveBranchIsRemote,
    startFromOrigin,
  } = input;
  if (!resolvedActiveBranch) {
    return "Select ref";
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath) {
    // Only the server can determine a local branch's configured remote.
    return startFromOrigin && resolvedActiveBranchIsRemote === false
      ? `From ${resolvedActiveBranch} (remote)`
      : `From ${resolvedActiveBranch}`;
  }
  return resolvedActiveBranch;
}

export function resolveBranchToolbarPrBranch(input: {
  activeThreadBranch: string | null;
  resolvedActiveBranch: string | null;
}): string | null {
  return input.activeThreadBranch === input.resolvedActiveBranch ? input.activeThreadBranch : null;
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
  activeProjectCheckoutRoot?: string | undefined;
  activeWorktreePath: string | null;
  refName: Pick<VcsRef, "isDefault" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
  staysInActiveCheckout: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, refName } = input;

  if (refName.worktreePath) {
    // Until the project's checkout root loads, a checkout containing the project counts as its own.
    const isProjectCheckout =
      input.activeProjectCheckoutRoot === undefined
        ? workspaceRelativeFilePath(activeProjectCwd, refName.worktreePath) !== null
        : workspaceRelativeFilePath(input.activeProjectCheckoutRoot, refName.worktreePath) === ".";
    const nextWorktreePath = isProjectCheckout ? null : refName.worktreePath;
    return {
      checkoutCwd: refName.worktreePath,
      nextWorktreePath,
      reuseExistingWorktree: true,
      // Listed refs can predate a checkout made outside the picker, so only Git can confirm this one.
      staysInActiveCheckout: nextWorktreePath === activeWorktreePath,
    };
  }

  const nextWorktreePath =
    activeWorktreePath !== null && refName.isDefault ? null : activeWorktreePath;

  return {
    checkoutCwd: nextWorktreePath ?? activeProjectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
    staysInActiveCheckout: nextWorktreePath === activeWorktreePath,
  };
}

export function isWorktreeChangeBlocked(input: {
  runtime: ThreadStructureRuntime | null;
  currentWorktreePath: string | null;
  nextWorktreePath: string | null;
}): boolean {
  return (
    input.nextWorktreePath !== input.currentWorktreePath &&
    deriveCanInterruptRunningThread(true, input.runtime)
  );
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

  const lowerItemValue = itemValue.toLowerCase();
  if (lowerItemValue.includes(normalizedQuery)) {
    return true;
  }

  const sanitizedQuery = sanitizeNewRefName(normalizedQuery);
  return (
    sanitizedQuery.length > 0 &&
    sanitizedQuery !== normalizedQuery &&
    lowerItemValue.includes(sanitizedQuery)
  );
}

/** Ref names for the picker: local branches first, then remote refs, each in server order. */
export function orderRefNamesByGroup(refs: ReadonlyArray<VcsRef>): string[] {
  return [
    ...refs.filter((ref) => !ref.isRemote).map((ref) => ref.name),
    ...refs.filter((ref) => ref.isRemote).map((ref) => ref.name),
  ];
}

/**
 * The section label each group's first visible row carries, keyed by item value. Items whose
 * group is null (create, checkout-by-reference) get no label and do not start a group.
 */
export function groupLabelsForPickerItems(
  items: ReadonlyArray<string>,
  groupOf: (item: string) => string | null,
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  let previousGroup: string | null = null;
  for (const item of items) {
    const group = groupOf(item);
    if (group !== null && group !== previousGroup) labels.set(item, group);
    previousGroup = group;
  }
  return labels;
}
