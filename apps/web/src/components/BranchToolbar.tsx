import type { GitBranch, ThreadId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from "react";

import { newCommandId } from "../lib/utils";
import { gitBranchesQueryOptions, invalidateGitQueries } from "../lib/gitReactQuery";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  resolveBranchToolbarValue,
} from "./BranchToolbar.logic";
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
import { toastManager } from "./ui/toast";

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
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const setThreadBranchAction = useStore((store) => store.setThreadBranch);
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const queryClient = useQueryClient();

  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const branchListScrollElementRef = useRef<HTMLDivElement | null>(null);

  const serverThread = threads.find((thread) => thread.id === threadId);
  const activeProjectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch = serverThread?.branch ?? draftThread?.branch ?? null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const branchCwd = activeWorktreePath ?? activeProject?.cwd ?? null;
  const hasServerThread = serverThread !== undefined;
  const effectiveEnvMode: "local" | "worktree" =
    activeWorktreePath || (!hasServerThread && draftThread?.envMode === "worktree")
      ? "worktree"
      : envMode;

  // ── Queries ───────────────────────────────────────────────────────────

  const branchesQuery = useQuery(gitBranchesQueryOptions(branchCwd));

  const branches = useMemo(
    () => dedupeRemoteBranchesWithLocalMatches(branchesQuery.data?.branches ?? []),
    [branchesQuery.data?.branches],
  );
  const currentGitBranch = branches.find((branch) => branch.current)?.name ?? null;
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });
  const branchNames = useMemo(() => branches.map((branch) => branch.name), [branches]);
  const branchByName = useMemo(
    () => new Map(branches.map((branch) => [branch.name, branch] as const)),
    [branches],
  );
  const trimmedBranchQuery = branchQuery.trim();
  const normalizedBranchQuery = trimmedBranchQuery.toLowerCase();
  const canCreateBranch = effectiveEnvMode === "local" && trimmedBranchQuery.length > 0;
  const hasExactBranchMatch = branchByName.has(trimmedBranchQuery);
  const createBranchItemValue = canCreateBranch
    ? `__create_new_branch__:${trimmedBranchQuery}`
    : null;
  const branchPickerItems = useMemo(
    () =>
      createBranchItemValue && !hasExactBranchMatch
        ? [...branchNames, createBranchItemValue]
        : branchNames,
    [branchNames, createBranchItemValue, hasExactBranchMatch],
  );
  const filteredBranchPickerItems = useMemo(
    () =>
      normalizedBranchQuery.length === 0
        ? branchPickerItems
        : branchPickerItems.filter((itemValue) => {
            if (createBranchItemValue && itemValue === createBranchItemValue) return true;
            return itemValue.toLowerCase().includes(normalizedBranchQuery);
          }),
    [branchPickerItems, createBranchItemValue, normalizedBranchQuery],
  );

  // ── Helpers ───────────────────────────────────────────────────────────

  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    canonicalActiveBranch,
    (_currentBranch: string | null, optimisticBranch: string | null) => optimisticBranch,
  );
  const [isBranchActionPending, startBranchActionTransition] = useTransition();
  const runBranchAction = (action: () => Promise<void>) => {
    startBranchActionTransition(async () => {
      await action().catch(() => undefined);
      await invalidateGitQueries(queryClient).catch(() => undefined);
    });
  };

  const setThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      if (!activeThreadId) return;
      const api = readNativeApi();
      // If the effective cwd is about to change, stop the running session so the
      // next message creates a new one with the correct cwd.
      const sessionId = serverThread?.session?.sessionId;
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
      if (api && hasServerThread) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          branch,
          worktreePath,
        });
      }
      if (hasServerThread) {
        setThreadBranchAction(activeThreadId, branch, worktreePath);
        return;
      }
      setDraftThreadContext(threadId, {
        branch,
        worktreePath,
        envMode: effectiveEnvMode,
      });
    },
    [
      activeThreadId,
      serverThread?.session?.sessionId,
      activeWorktreePath,
      hasServerThread,
      setThreadBranchAction,
      setDraftThreadContext,
      threadId,
      effectiveEnvMode,
    ],
  );

  const branchListVirtualizer = useVirtualizer({
    count: filteredBranchPickerItems.length,
    estimateSize: () => 28,
    getScrollElement: () => branchListScrollElementRef.current,
    overscan: 12,
    enabled: isBranchMenuOpen,
    initialRect: {
      height: 224,
      width: 0,
    },
  });
  const virtualBranchRows = branchListVirtualizer.getVirtualItems();
  const setBranchListRef = useCallback(
    (element: HTMLDivElement | null) => {
      branchListScrollElementRef.current = (element?.parentElement as HTMLDivElement | null) ?? null;
      if (element) {
        branchListVirtualizer.measure();
      }
    },
    [branchListVirtualizer],
  );

  useEffect(() => {
    if (effectiveEnvMode !== "worktree" || activeWorktreePath || activeThreadBranch || !currentGitBranch) {
      return;
    }
    setThreadBranch(currentGitBranch, null);
  }, [activeThreadBranch, activeWorktreePath, currentGitBranch, effectiveEnvMode, setThreadBranch]);

  useEffect(() => {
    if (!isBranchMenuOpen) return;
    queueMicrotask(() => {
      branchListVirtualizer.measure();
    });
  }, [branchListVirtualizer, filteredBranchPickerItems.length, isBranchMenuOpen]);

  const selectBranch = (branch: GitBranch) => {
    const api = readNativeApi();
    if (!api || !activeThreadId || !branchCwd || isBranchActionPending) return;

    // For new worktree mode, selecting a branch picks the base branch.
    if (effectiveEnvMode === "worktree" && !envLocked && !activeWorktreePath) {
      setThreadBranch(branch.name, null);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    // If the branch already lives in a worktree, redirect there instead of
    // trying to checkout (which git would reject with "already used by worktree").
    if (branch.worktreePath) {
      const isMainWorktree = branch.worktreePath === activeProject?.cwd;
      // Main worktree → switch back to local (project cwd, worktreePath=null).
      // Secondary worktree → point the thread at that worktree path.
      setThreadBranch(branch.name, isMainWorktree ? null : branch.worktreePath);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectedBranchName = branch.isRemote
      ? deriveLocalBranchNameFromRemoteRef(branch.name)
      : branch.name;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      setOptimisticBranch(selectedBranchName);
      try {
        await api.git.checkout({ cwd: branchCwd, branch: branch.name });
        await invalidateGitQueries(queryClient);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to checkout branch.",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return;
      }

      let nextBranchName = selectedBranchName;
      if (branch.isRemote) {
        const status = await api.git.status({ cwd: branchCwd }).catch(() => null);
        if (status?.branch) {
          nextBranchName = status.branch;
        }
      }

      setOptimisticBranch(nextBranchName);
      setThreadBranch(nextBranchName, activeWorktreePath);
    });
  };

  const createBranch = (rawName: string) => {
    const name = rawName.trim();
    const api = readNativeApi();
    if (!api || !activeThreadId || !branchCwd || !name || isBranchActionPending) return;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      setOptimisticBranch(name);

      try {
        await api.git.createBranch({ cwd: branchCwd, branch: name });
        try {
          await api.git.checkout({ cwd: branchCwd, branch: name });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to checkout branch.",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
          return;
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to create branch.",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return;
      }

      setOptimisticBranch(name);
      setThreadBranch(name, activeWorktreePath);
      setBranchQuery("");
    });
  };

  if (!activeThreadId || !activeProject) return null;

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
            onClick={() => onEnvModeChange(effectiveEnvMode === "local" ? "worktree" : "local")}
          >
            {effectiveEnvMode === "worktree" ? "New worktree" : "Local"}
          </Button>
        )}
      </div>

      <Combobox
        items={branchPickerItems}
        filteredItems={filteredBranchPickerItems}
        autoHighlight
        virtualized
        onItemHighlighted={(_value, eventDetails) => {
          if (!isBranchMenuOpen || eventDetails.index < 0) return;
          branchListVirtualizer.scrollToIndex(eventDetails.index, { align: "auto" });
        }}
        onOpenChange={(open) => {
          setIsBranchMenuOpen(open);
          if (!open) setBranchQuery("");
        }}
        open={isBranchMenuOpen}
        value={resolvedActiveBranch}
      >
        <ComboboxTrigger
          render={<Button variant="ghost" size="xs" />}
          className="text-muted-foreground/70 hover:text-foreground/80"
          disabled={branchesQuery.isLoading || isBranchActionPending}
        >
          <span className="max-w-[240px] truncate">
            {resolvedActiveBranch
              ? effectiveEnvMode === "worktree" && !activeWorktreePath
                ? `From ${resolvedActiveBranch}`
                : resolvedActiveBranch
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

          <ComboboxList ref={setBranchListRef} className="max-h-56">
            <div
              className="relative"
              style={{
                height: `${branchListVirtualizer.getTotalSize()}px`,
              }}
            >
              {virtualBranchRows.map((virtualRow) => {
                const itemValue = filteredBranchPickerItems[virtualRow.index];
                if (!itemValue) return null;
                if (createBranchItemValue && itemValue === createBranchItemValue) {
                  return (
                    <ComboboxItem
                      hideIndicator
                      key={itemValue}
                      index={virtualRow.index}
                      value={itemValue}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
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
                const badge = branch.current
                  ? "current"
                  : hasSecondaryWorktree
                    ? "worktree"
                    : branch.isRemote
                      ? "remote"
                      : branch.isDefault
                        ? "default"
                        : null;
                return (
                  <ComboboxItem
                    hideIndicator
                    key={itemValue}
                    index={virtualRow.index}
                    value={itemValue}
                    className={
                      itemValue === resolvedActiveBranch ? "bg-accent text-foreground" : undefined
                    }
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    onClick={() => selectBranch(branch)}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="truncate">{itemValue}</span>
                      {badge && (
                        <span className="shrink-0 text-[10px] text-muted-foreground/45">
                          {badge}
                        </span>
                      )}
                    </div>
                  </ComboboxItem>
                );
              })}
            </div>
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}
