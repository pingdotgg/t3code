import type { GitBranch, ThreadId } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { newCommandId } from "../lib/orchestrationIds";
import {
  gitBranchesQueryOptions,
  gitCheckoutMutationOptions,
  gitCreateBranchAndCheckoutMutationOptions,
} from "../lib/gitReactQuery";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { deriveSyncedLocalBranch } from "./BranchToolbar.logic";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import { ChevronDownIcon } from "lucide-react";

interface BranchToolbarProps {
  threadId: ThreadId;
  envMode: "local" | "worktree";
  onEnvModeChange: (mode: "local" | "worktree") => void;
  envLocked: boolean;
  onComposerFocusRequest?: () => void;
}

export default function BranchToolbar({
  threadId,
  envMode,
  onEnvModeChange,
  envLocked,
  onComposerFocusRequest,
}: BranchToolbarProps) {
  const { state, dispatch } = useStore();
  const queryClient = useQueryClient();

  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");

  const activeThread = state.threads.find((thread) => thread.id === threadId);
  const activeProject = state.projects.find((project) => project.id === activeThread?.projectId);
  const activeThreadId = activeThread?.id;
  const activeThreadBranch = activeThread?.branch ?? null;
  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const branchCwd = activeWorktreePath ?? activeProject?.cwd ?? null;

  // ── Queries ───────────────────────────────────────────────────────────

  const branchesQuery = useQuery(gitBranchesQueryOptions(branchCwd));

  const branches = branchesQuery.data?.branches ?? [];
  const branchNames = branches.map((branch) => branch.name);
  const branchByName = new Map(branches.map((branch) => [branch.name, branch]));
  const trimmedBranchQuery = branchQuery.trim();
  const canCreateBranch = envMode === "local" && trimmedBranchQuery.length > 0;
  const hasExactBranchMatch = branchByName.has(trimmedBranchQuery);
  const createBranchItemValue = canCreateBranch
    ? `__create_new_branch__:${trimmedBranchQuery}`
    : null;
  const branchPickerItems =
    createBranchItemValue && !hasExactBranchMatch
      ? [...branchNames, createBranchItemValue]
      : branchNames;
  // ── Mutations ─────────────────────────────────────────────────────────

  const checkoutMutation = useMutation(
    gitCheckoutMutationOptions({ cwd: branchCwd, queryClient }),
  );

  const createBranchMutation = useMutation(
    gitCreateBranchAndCheckoutMutationOptions({ cwd: branchCwd, queryClient }),
  );

  // ── Effects ───────────────────────────────────────────────────────────

  // Keep thread branch synced to git current branch for local threads.
  const queryBranches = branchesQuery.data?.branches;
  useEffect(() => {
    const syncedBranch = deriveSyncedLocalBranch({
      activeThreadId,
      activeWorktreePath,
      envMode,
      activeThreadBranch,
      queryBranches,
    });
    if (!activeThreadId || !syncedBranch) return;
    const api = readNativeApi();

    if (api) {
      void api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: activeThreadId,
        branch: syncedBranch,
        worktreePath: null,
      });
    }
    dispatch({
      type: "SET_THREAD_BRANCH",
      threadId: activeThreadId,
      branch: syncedBranch,
      worktreePath: null,
    });
  }, [
    activeThreadId,
    activeWorktreePath,
    activeThreadBranch,
    queryBranches,
    envMode,
    dispatch,
  ]);

  useEffect(() => {
    if (isBranchMenuOpen) return;
    setBranchQuery("");
  }, [isBranchMenuOpen]);

  // ── Helpers ───────────────────────────────────────────────────────────

  const setThreadError = (error: string | null) => {
    if (!activeThreadId) return;
    dispatch({ type: "SET_ERROR", threadId: activeThreadId, error });
  };

  const setThreadBranch = (branch: string | null, worktreePath: string | null) => {
    if (!activeThreadId) return;
    const api = readNativeApi();
    // If the effective cwd is about to change, stop the running session so the
    // next message creates a new one with the correct cwd.
    const sessionId = activeThread?.session?.sessionId;
    if (sessionId && worktreePath !== activeWorktreePath && api) {
      void api.orchestration
        .dispatchCommand({
          type: "thread.session.stop",
          commandId: newCommandId(),
          threadId: activeThreadId,
          createdAt: new Date().toISOString(),
        })
        .catch(() => undefined);
    }
    if (api) {
      void api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: activeThreadId,
        branch,
        worktreePath,
      });
    }
    dispatch({ type: "SET_THREAD_BRANCH", threadId: activeThreadId, branch, worktreePath });
  };

  const selectBranch = (branch: GitBranch) => {
    const api = readNativeApi();
    if (!api || !activeThreadId || !branchCwd) return;

    // For new worktree mode, selecting a branch picks the base branch.
    if (envMode === "worktree" && !envLocked && !activeWorktreePath) {
      setThreadError(null);
      setThreadBranch(branch.name, null);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    // If the branch already lives in a worktree, redirect there instead of
    // trying to checkout (which git would reject with "already used by worktree").
    if (branch.worktreePath) {
      const isMainWorktree = branch.worktreePath === activeProject?.cwd;
      setThreadError(null);
      // Main worktree → switch back to local (project cwd, worktreePath=null).
      // Secondary worktree → point the thread at that worktree path.
      setThreadBranch(branch.name, isMainWorktree ? null : branch.worktreePath);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    checkoutMutation.mutate(branch.name, {
      onSuccess: () => {
        setThreadError(null);
        setThreadBranch(branch.name, activeWorktreePath);
        setIsBranchMenuOpen(false);
        onComposerFocusRequest?.();
      },
      onError: (error) => {
        setThreadError(error instanceof Error ? error.message : "Failed to checkout branch.");
        setIsBranchMenuOpen(true);
      },
    });
  };

  const createBranch = (rawName: string) => {
    const name = rawName.trim();
    const api = readNativeApi();
    if (!api || !activeThreadId || !branchCwd || !name || createBranchMutation.isPending) return;
    createBranchMutation.mutate(name, {
      onSuccess: () => {
        setThreadError(null);
        setThreadBranch(name, activeWorktreePath);
        setBranchQuery("");
        setIsBranchMenuOpen(false);
        onComposerFocusRequest?.();
      },
      onError: (error) => {
        setThreadError(error instanceof Error ? error.message : "Failed to create branch.");
      },
    });
  };

  if (!activeThread || !activeProject) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 pb-3 pt-1">
      <div className="flex items-center gap-2">
        {envLocked || activeWorktreePath ? (
          <span className="border border-transparent px-[calc(--spacing(2)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
            {activeWorktreePath ? "Worktree" : "Local"}
          </span>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="text-muted-foreground/70 hover:text-foreground/80"
            size="xs"
            onClick={() => onEnvModeChange(envMode === "local" ? "worktree" : "local")}
          >
            {envMode === "worktree" ? "New worktree" : "Local"}
          </Button>
        )}
      </div>

      <Combobox
        items={branchPickerItems}
        autoHighlight
        onOpenChange={(open) => setIsBranchMenuOpen(open)}
        open={isBranchMenuOpen}
        value={activeThread.branch}
      >
        <ComboboxTrigger
          render={<Button variant="ghost" size="xs" />}
          className="text-muted-foreground/70 hover:text-foreground/80"
          disabled={branchesQuery.isLoading}
        >
          <span className="max-w-[240px] truncate">
            {activeThread.branch
              ? envMode === "worktree" && !activeWorktreePath
                ? `From ${activeThread.branch}`
                : activeThread.branch
              : "Select branch"}
          </span>
          <ChevronDownIcon />
        </ComboboxTrigger>
        <ComboboxPopup align="end" side="top" className="w-64">
          <div className="border-b p-1">
            <ComboboxInput
              className="[&_input]:font-sans rounded-md"
              inputClassName="ring-0"
              placeholder="Search branches..."
              showTrigger={false}
              size="sm"
              value={branchQuery}
              onChange={(event) => setBranchQuery(event.target.value)}
            />
          </div>
          <ComboboxEmpty>No branches found.</ComboboxEmpty>

          <ComboboxList className="max-h-56">
            {(itemValue) => {
              if (createBranchItemValue && itemValue === createBranchItemValue) {
                return (
                  <ComboboxItem
                    hideIndicator
                    key={itemValue}
                    value={itemValue}
                    onClick={() => createBranch(trimmedBranchQuery)}
                  >
                    <span className="truncate">Create new branch "{trimmedBranchQuery}"</span>
                  </ComboboxItem>
                );
              }

              const branch = branchByName.get(itemValue);
              if (!branch) return null;

              const hasSecondaryWorktree =
                branch.worktreePath && branch.worktreePath !== activeProject.cwd;
              return (
                <ComboboxItem
                  hideIndicator
                  key={itemValue}
                  value={itemValue}
                  className={
                    itemValue === activeThread.branch ? "bg-accent text-foreground" : undefined
                  }
                  onClick={() => selectBranch(branch)}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="truncate">{itemValue}</span>
                    {(branch.current || branch.isDefault || hasSecondaryWorktree) && (
                      <span className="shrink-0 text-[10px] text-muted-foreground/45">
                        {branch.current ? "current" : hasSecondaryWorktree ? "worktree" : "default"}
                      </span>
                    )}
                  </div>
                </ComboboxItem>
              );
            }}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}
