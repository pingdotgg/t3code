import type { VcsRef } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDownIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";

import { gitBranchesQueryOptions, gitQueryKeys, invalidateGitQueries } from "../lib/gitReactQuery";
import { readNativeApi } from "../nativeApi";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  EnvMode,
  getCurrentVcsRefNames,
  resolveBranchToolbarState,
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
import { toastManager } from "./ui/toast";

interface BranchToolbarBranchSelectorProps {
  activeProjectCwd: string;
  activeThreadBranch: string | null;
  activeWorktreePath: string | null;
  branchCwd: string | null;
  effectiveEnvMode: EnvMode;
  envLocked: boolean;
  onSetThreadBranch: (branch: string | null, worktreePath: string | null) => void;
  onComposerFocusRequest?: () => void;
}

function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function getBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  displayValue: string | null;
  backend: "git" | "jj";
}): string {
  const { activeWorktreePath, effectiveEnvMode, displayValue, backend } = input;
  const refLabel = backend === "jj" ? "base bookmark" : "branch";
  if (!displayValue) {
    return `Select ${refLabel}`;
  }
  if (backend === "git" && effectiveEnvMode === "worktree" && !activeWorktreePath) {
    return `From ${displayValue}`;
  }
  return displayValue;
}

export function BranchToolbarBranchSelector({
  activeProjectCwd,
  activeThreadBranch,
  activeWorktreePath,
  branchCwd,
  effectiveEnvMode,
  envLocked,
  onSetThreadBranch,
  onComposerFocusRequest,
}: BranchToolbarBranchSelectorProps) {
  const queryClient = useQueryClient();
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");

  const branchesQuery = useQuery(gitBranchesQueryOptions(branchCwd));
  const branches = useMemo(
    () => dedupeRemoteBranchesWithLocalMatches(branchesQuery.data?.refs ?? []),
    [branchesQuery.data?.refs],
  );
  const backend = branchesQuery.data?.backend ?? "git";
  const capabilities = branchesQuery.data?.capabilities;
  const currentRefNames = useMemo(
    () => getCurrentVcsRefNames({ backend, refs: branches }),
    [backend, branches],
  );
  const currentGitBranch = backend === "git" ? (currentRefNames[0] ?? null) : null;
  const canonicalToolbarState = resolveBranchToolbarState({
    backend,
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentRefNames,
  });
  const branchNames = useMemo(() => branches.map((branch) => branch.name), [branches]);
  const branchByName = useMemo(
    () => new Map(branches.map((branch) => [branch.name, branch] as const)),
    [branches],
  );
  const trimmedBranchQuery = branchQuery.trim();
  const normalizedBranchQuery = trimmedBranchQuery.toLowerCase();
  const canCreateBranch =
    effectiveEnvMode === "local" &&
    trimmedBranchQuery.length > 0 &&
    !!capabilities?.supportsCreateRef;
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
  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    canonicalToolbarState.displayValue,
    (_currentBranch: string | null, optimisticBranch: string | null) => optimisticBranch,
  );
  const [isBranchActionPending, startBranchActionTransition] = useTransition();

  const runBranchAction = (action: () => Promise<void>) => {
    startBranchActionTransition(async () => {
      await action().catch(() => undefined);
      await invalidateGitQueries(queryClient).catch(() => undefined);
    });
  };

  const selectBranch = (branch: VcsRef) => {
    const api = readNativeApi();
    if (!api || !branchCwd || isBranchActionPending) return;

    // In new-worktree mode, selecting a branch sets the base branch.
    if (effectiveEnvMode === "worktree" && !envLocked && !activeWorktreePath) {
      onSetThreadBranch(branch.name, null);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    // If the branch already lives in a worktree, point the thread there.
    if (branch.workspacePath) {
      const isMainWorktree = branch.workspacePath === activeProjectCwd;
      onSetThreadBranch(branch.name, isMainWorktree ? null : branch.workspacePath);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    if (backend === "jj") {
      onSetThreadBranch(branch.name, null);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    if (!capabilities?.supportsCheckoutRef) {
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectedBranchName = branch.kind === "remoteBranch" || branch.kind === "remoteBookmark"
      ? deriveLocalBranchNameFromRemoteRef(branch.name)
      : branch.name;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      setOptimisticBranch(selectedBranchName);
      try {
        await api.vcs.checkoutRef({ cwd: branchCwd, refName: branch.name, refKind: branch.kind });
        await invalidateGitQueries(queryClient);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to checkout branch.",
          description: toBranchActionErrorMessage(error),
        });
        return;
      }

      let nextBranchName = selectedBranchName;
      if (branch.kind === "remoteBranch" || branch.kind === "remoteBookmark") {
        const status = await api.vcs.status({ cwd: branchCwd }).catch(() => null);
        if (status?.refName) {
          nextBranchName = status.refName;
        }
      }

      setOptimisticBranch(nextBranchName);
      onSetThreadBranch(nextBranchName, activeWorktreePath);
    });
  };

  const createBranch = (rawName: string) => {
    const name = rawName.trim();
    const api = readNativeApi();
    if (!api || !branchCwd || !name || isBranchActionPending) return;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      setOptimisticBranch(name);

      try {
        await api.vcs.createRef({
          cwd: branchCwd,
          refName: name,
          refKind: backend === "jj" ? "bookmark" : "branch",
        });
        try {
          await api.vcs.checkoutRef({
            cwd: branchCwd,
            refName: name,
            refKind: backend === "jj" ? "bookmark" : "branch",
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: `Failed to checkout ${backend === "jj" ? "bookmark" : "branch"}.`,
            description: toBranchActionErrorMessage(error),
          });
          return;
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Failed to create ${backend === "jj" ? "bookmark" : "branch"}.`,
          description: toBranchActionErrorMessage(error),
        });
        return;
      }

      setOptimisticBranch(name);
      onSetThreadBranch(name, activeWorktreePath);
      setBranchQuery("");
    });
  };

  useEffect(() => {
    if (
      backend !== "git" ||
      effectiveEnvMode !== "worktree" ||
      activeWorktreePath ||
      activeThreadBranch ||
      !currentGitBranch
    ) {
      return;
    }
    onSetThreadBranch(currentGitBranch, null);
  }, [
    activeThreadBranch,
    activeWorktreePath,
    backend,
    currentGitBranch,
    effectiveEnvMode,
    onSetThreadBranch,
  ]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsBranchMenuOpen(open);
      if (!open) {
        setBranchQuery("");
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: gitQueryKeys.branches(branchCwd),
      });
    },
    [branchCwd, queryClient],
  );

  const branchListScrollElementRef = useRef<HTMLDivElement | null>(null);
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
      branchListScrollElementRef.current =
        (element?.parentElement as HTMLDivElement | null) ?? null;
      if (element) {
        branchListVirtualizer.measure();
      }
    },
    [branchListVirtualizer],
  );

  useEffect(() => {
    if (!isBranchMenuOpen) return;
    queueMicrotask(() => {
      branchListVirtualizer.measure();
    });
  }, [branchListVirtualizer, filteredBranchPickerItems.length, isBranchMenuOpen]);

  const triggerLabel = getBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    displayValue: resolvedActiveBranch,
    backend,
  });

  return (
    <Combobox
      items={branchPickerItems}
      filteredItems={filteredBranchPickerItems}
      autoHighlight
      virtualized
      onItemHighlighted={(_value, eventDetails) => {
        if (!isBranchMenuOpen || eventDetails.index < 0) return;
        branchListVirtualizer.scrollToIndex(eventDetails.index, { align: "auto" });
      }}
      onOpenChange={handleOpenChange}
      open={isBranchMenuOpen}
      value={backend === "git" ? resolvedActiveBranch : canonicalToolbarState.selectedValue}
    >
      <ComboboxTrigger
        render={<Button variant="ghost" size="xs" />}
        className="text-muted-foreground/70 hover:text-foreground/80"
        disabled={branchesQuery.isLoading || isBranchActionPending}
      >
        <span className="max-w-[240px] truncate">{triggerLabel}</span>
        <ChevronDownIcon />
      </ComboboxTrigger>
      <ComboboxPopup align="end" side="top" className="w-64">
        <div className="border-b p-1">
          <ComboboxInput
            className="[&_input]:font-sans rounded-md"
            inputClassName="ring-0"
            placeholder={`Search ${backend === "jj" ? "base bookmarks" : "branches"}...`}
            showTrigger={false}
            size="sm"
            value={branchQuery}
            onChange={(event) => setBranchQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>
          {`No ${backend === "jj" ? "base bookmarks" : "branches"} found.`}
        </ComboboxEmpty>

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
                    <span className="truncate">
                      {`Create new ${backend === "jj" ? "bookmark" : "branch"} "${trimmedBranchQuery}"`}
                    </span>
                  </ComboboxItem>
                );
              }

              const branch = branchByName.get(itemValue);
              if (!branch) return null;

              const hasSecondaryWorktree =
                branch.workspacePath && branch.workspacePath !== activeProjectCwd;
              const badge = branch.current
                ? "current"
                : hasSecondaryWorktree
                  ? "workspace"
                  : branch.kind === "remoteBranch" || branch.kind === "remoteBookmark"
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
                      <span className="shrink-0 text-[10px] text-muted-foreground/45">{badge}</span>
                    )}
                  </div>
                </ComboboxItem>
              );
            })}
          </div>
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
