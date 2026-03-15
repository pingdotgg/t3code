import type { GitWorktreeBranchNaming } from "@t3tools/contracts";
import { DEFAULT_WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";

export type DraftWorktreeBranchNamingMode = GitWorktreeBranchNaming["mode"];

export interface DraftWorktreeBranchNamingState {
  mode: DraftWorktreeBranchNamingMode;
  prefix: string;
  branchName: string;
}

export const DEFAULT_DRAFT_WORKTREE_BRANCH_NAMING_STATE: DraftWorktreeBranchNamingState =
  Object.freeze({
    mode: "auto",
    prefix: "",
    branchName: "",
  });

export function normalizeDraftWorktreeBranchNaming(value: unknown): DraftWorktreeBranchNamingState {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_DRAFT_WORKTREE_BRANCH_NAMING_STATE };
  }

  const candidate = value as Record<string, unknown>;
  const mode = candidate.mode;

  return {
    mode: mode === "prefix" || mode === "full" ? mode : "auto",
    prefix: typeof candidate.prefix === "string" ? candidate.prefix : "",
    branchName: typeof candidate.branchName === "string" ? candidate.branchName : "",
  };
}

export function resolveDraftWorktreeBranchNamingValidationError(
  state: DraftWorktreeBranchNamingState | null | undefined,
): string | null {
  if (!state) {
    return null;
  }

  if (state.mode === "prefix" && state.prefix.trim().length === 0) {
    return "Enter a prefix before sending in New worktree mode.";
  }

  if (state.mode === "full" && state.branchName.trim().length === 0) {
    return "Enter a full branch name before sending in New worktree mode.";
  }

  return null;
}

export function resolveWorktreeBranchNamingForThreadCreate(
  state: DraftWorktreeBranchNamingState | null | undefined,
): GitWorktreeBranchNaming {
  if (!state || state.mode === "auto") {
    return { mode: "auto" };
  }

  if (state.mode === "prefix") {
    const prefix = state.prefix.trim();
    return prefix.length > 0 ? { mode: "prefix", prefix } : { mode: "auto" };
  }

  const branchName = state.branchName.trim();
  return branchName.length > 0 ? { mode: "full", branchName } : { mode: "auto" };
}

export function updateDraftWorktreeBranchNamingMode(
  state: DraftWorktreeBranchNamingState | null | undefined,
  mode: DraftWorktreeBranchNamingMode,
): DraftWorktreeBranchNamingState {
  const nextState = state ? { ...state } : { ...DEFAULT_DRAFT_WORKTREE_BRANCH_NAMING_STATE };

  if (mode === "prefix" && nextState.prefix.trim().length === 0) {
    nextState.prefix = DEFAULT_WORKTREE_BRANCH_PREFIX;
  }

  nextState.mode = mode;
  return nextState;
}
