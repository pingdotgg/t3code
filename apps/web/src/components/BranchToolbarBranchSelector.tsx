import type { GitBranch } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDownIcon } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  gitBranchesQueryOptions,
  gitQueryKeys,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "../lib/gitReactQuery";
import { readNativeApi } from "../nativeApi";
import { parsePullRequestReference } from "../pullRequestReference";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  EnvMode,
  resolveBranchSelectionTarget,
  resolveBranchToolbarValue,
  shouldIncludeBranchPickerItem,
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
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function getBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  resolvedActiveBranch: string | null;
}): string {
  const { activeWorktreePath, effectiveEnvMode, resolvedActiveBranch } = input;
  if (!resolvedActiveBranch) {
    return "Select branch";
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath) {
    return `From ${resolvedActiveBranch}`;
  }
  return resolvedActiveBranch;
}

export function BranchToolbarBranchSelector({
  activeProjectCwd,
  activeThreadBranch,
  activeWorktreePath,
  branchCwd,
  effectiveEnvMode,
  envLocked,
  onSetThreadBranch,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarBranchSelectorProps) {
  const queryClient = useQueryClient();
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const deferredBranchQuery = useDeferredValue(branchQuery);

  const branchesQuery = useQuery(gitBranchesQueryOptions(branchCwd));
  const branchStatusQuery = useQuery(gitStatusQueryOptions(branchCwd));
  const branches = useMemo(
    () => dedupeRemoteBranchesWithLocalMatches(branchesQuery.data?.branches ?? []),
    [branchesQuery.data?.branches],
  );
  const currentGitBranch =
    branchStatusQuery.data?.branch ?? branches.find((branch) => branch.current)?.name ?? null;
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
  const deferredTrimmedBranchQuery = deferredBranchQuery.trim();
  const normalizedDeferredBranchQuery = deferredTrimmedBranchQuery.toLowerCase();
  const prReference = parsePullRequestReference(trimmedBranchQuery);
  const isSelectingWorktreeBase =
    effectiveEnvMode === "worktree" && !envLocked && !activeWorktreePath;
  const checkoutPullRequestItemValue =
    prReference && onCheckoutPullRequestRequest ? `__checkout_pull_request__:${prReference}` : null;
  const canCreateBranch = !isSelectingWorktreeBase && trimmedBranchQuery.length > 0;
  const hasExactBranchMatch = branchByName.has(trimmedBranchQuery);
  const createBranchItemValue = canCreateBranch
    ? `__create_new_branch__:${trimmedBranchQuery}`
    : null;
  const branchPickerItems = useMemo(() => {
    const items = [...branchNames];
    if (createBranchItemValue && !hasExactBranchMatch) {
      items.push(createBranchItemValue);
    }
    if (checkoutPullRequestItemValue) {
      items.unshift(checkoutPullRequestItemValue);
    }
    return items;
  }, [branchNames, checkoutPullRequestItemValue, createBranchItemValue, hasExactBranchMatch]);
  const filteredBranchPickerItems = useMemo(
    () =>
      normalizedDeferredBranchQuery.length === 0
        ? branchPickerItems
        : branchPickerItems.filter((itemValue) =>
            shouldIncludeBranchPickerItem({
              itemValue,
              normalizedQuery: normalizedDeferredBranchQuery,
              createBranchItemValue,
              checkoutPullRequestItemValue,
            }),
          ),
    [
      branchPickerItems,
      checkoutPullRequestItemValue,
      createBranchItemValue,
      normalizedDeferredBranchQuery,
    ],
  );
  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    canonicalActiveBranch,
    (_currentBranch: string | null, optimisticBranch: string | null) => optimisticBranch,
  );
  const [isBranchActionPending, startBranchActionTransition] = useTransition();
  const shouldVirtualizeBranchList = filteredBranchPickerItems.length > 40;

  const runBranchAction = (action: () => Promise<void>) => {
    startBranchActionTransition(async () => {
      await action().catch(() => undefined);
      await invalidateGitQueries(queryClient).catch(() => undefined);
    });
  };

  const selectBranch = (branch: GitBranch) => {
    const api = readNativeApi();
    if (!api || !branchCwd || isBranchActionPending) return;

    // In new-worktree mode, selecting a branch sets the base branch.
    if (isSelectingWorktreeBase) {
      onSetThreadBranch(branch.name, null);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectionTarget = resolveBranchSelectionTarget({
      activeProjectCwd,
      activeWorktreePath,
      branch,
    });

    // If the branch already lives in a worktree, point the thread there.
    if (selectionTarget.reuseExistingWorktree) {
      onSetThreadBranch(branch.name, selectionTarget.nextWorktreePath);
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
        await api.git.checkout({ cwd: selectionTarget.checkoutCwd, branch: branch.name });
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
      if (branch.isRemote) {
        const status = await api.git.status({ cwd: branchCwd }).catch(() => null);
        if (status?.branch) {
          nextBranchName = status.branch;
        }
      }

      setOptimisticBranch(nextBranchName);
      onSetThreadBranch(nextBranchName, selectionTarget.nextWorktreePath);
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
        await api.git.createBranch({ cwd: branchCwd, branch: name });
        try {
          await api.git.checkout({ cwd: branchCwd, branch: name });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to checkout branch.",
            description: toBranchActionErrorMessage(error),
          });
          return;
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to create branch.",
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
    estimateSize: (index) =>
      filteredBranchPickerItems[index] === checkoutPullRequestItemValue ? 44 : 28,
    getScrollElement: () => branchListScrollElementRef.current,
    overscan: 12,
    enabled: isBranchMenuOpen && shouldVirtualizeBranchList,
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
    if (!isBranchMenuOpen || !shouldVirtualizeBranchList) return;
    queueMicrotask(() => {
      branchListVirtualizer.measure();
    });
  }, [
    branchListVirtualizer,
    filteredBranchPickerItems.length,
    isBranchMenuOpen,
    shouldVirtualizeBranchList,
  ]);

  const triggerLabel = getBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
  });

  function renderPickerItem(itemValue: string, index: number, style?: CSSProperties) {
    if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          style={style}
          onClick={() => {
            if (!prReference || !onCheckoutPullRequestRequest) {
              return;
            }
            setIsBranchMenuOpen(false);
            setBranchQuery("");
            onComposerFocusRequest?.();
            onCheckoutPullRequestRequest(prReference);
          }}
        >
          <div className="flex min-w-0 flex-col items-start py-1">
            <span className="truncate font-medium">Checkout Pull Request</span>
            <span className="truncate text-muted-foreground text-xs">{prReference}</span>
          </div>
        </ComboboxItem>
      );
    }
    if (createBranchItemValue && itemValue === createBranchItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          style={style}
          onClick={() => createBranch(trimmedBranchQuery)}
        >
          <span className="truncate">Create new branch "{trimmedBranchQuery}"</span>
        </ComboboxItem>
      );
    }

    const branch = branchByName.get(itemValue);
    if (!branch) return null;

    const hasSecondaryWorktree = branch.worktreePath && branch.worktreePath !== activeProjectCwd;
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
        index={index}
        value={itemValue}
        style={style}
        onClick={() => selectBranch(branch)}
      >
        <div className="flex w-full items-center justify-between gap-2">
          <span className="truncate">{itemValue}</span>
          {badge && <span className="shrink-0 text-[10px] text-muted-foreground/45">{badge}</span>}
        </div>
      </ComboboxItem>
    );
  }

  return (
    <Combobox
      items={branchPickerItems}
      filteredItems={filteredBranchPickerItems}
      autoHighlight
      virtualized={shouldVirtualizeBranchList}
      onItemHighlighted={(_value, eventDetails) => {
        if (!isBranchMenuOpen || eventDetails.index < 0) return;
        branchListVirtualizer.scrollToIndex(eventDetails.index, { align: "auto" });
      }}
      onOpenChange={handleOpenChange}
      open={isBranchMenuOpen}
      value={resolvedActiveBranch}
    >
      <ComboboxTrigger
        render={<Button variant="ghost" size="xs" />}
        className="text-muted-foreground/70 hover:text-foreground/80"
        disabled={(branchesQuery.isLoading && branches.length === 0) || isBranchActionPending}
      >
        <span className="max-w-[240px] truncate">{triggerLabel}</span>
        <ChevronDownIcon />
      </ComboboxTrigger>
      <ComboboxPopup align="end" side="top" className="w-80">
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
          {shouldVirtualizeBranchList ? (
            <div
              className="relative"
              style={{
                height: `${branchListVirtualizer.getTotalSize()}px`,
              }}
            >
              {virtualBranchRows.map((virtualRow) => {
                const itemValue = filteredBranchPickerItems[virtualRow.index];
                if (!itemValue) return null;
                return renderPickerItem(itemValue, virtualRow.index, {
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                });
              })}
            </div>
          ) : (
            filteredBranchPickerItems.map((itemValue, index) => renderPickerItem(itemValue, index))
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
