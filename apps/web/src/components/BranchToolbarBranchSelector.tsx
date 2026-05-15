import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import type {
  EnvironmentApi,
  EnvironmentId,
  ThreadId,
  VcsRef,
  VcsStashInfoResult,
} from "@t3tools/contracts";
import { type QueryClient, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ChevronDownIcon } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { readEnvironmentApi } from "../environmentApi";
import {
  gitBranchSearchInfiniteQueryOptions,
  gitQueryKeys,
  invalidateGitQueries,
} from "../lib/gitReactQuery";
import { useGitStatus } from "../lib/gitStatusState";
import { newCommandId } from "../lib/utils";
import { cn } from "../lib/utils";
import { parsePullRequestReference } from "../pullRequestReference";
import { getSourceControlPresentation } from "../sourceControlPresentation";
import { useStore } from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import {
  deriveLocalBranchNameFromRemoteRef,
  resolveBranchSelectionTarget,
  resolveBranchToolbarValue,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  shouldIncludeBranchPickerItem,
} from "./BranchToolbar.logic";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxTrigger,
} from "./ui/combobox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { stackedThreadToast, toastManager } from "./ui/toast";

interface BranchToolbarBranchSelectorProps {
  className?: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  envLocked: boolean;
  effectiveEnvModeOverride?: "local" | "worktree";
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (refName: string | null) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

type StashDiscardDialogState = {
  cwd: string;
  error: string | null;
  info: VcsStashInfoResult | null;
  loading: boolean;
};

function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

// Matches the server-side message produced by `GitCheckoutDirtyWorktreeError`.
// Files are emitted one per line prefixed with "  - ", so we can parse them
// unambiguously even when a path contains a comma.
const DIRTY_WORKTREE_ERROR_PATTERN = /Uncommitted changes block checkout to ([^:\n]+):\n([\s\S]+)/;

function readDirtyWorktreeDetails(
  error: unknown,
): { branch: string; conflictingFiles: string[] } | null {
  if (!error || typeof error !== "object" || !("dirtyWorktree" in error)) {
    return null;
  }

  const dirtyWorktree = (error as { dirtyWorktree?: unknown }).dirtyWorktree;
  if (!dirtyWorktree || typeof dirtyWorktree !== "object") {
    return null;
  }

  const branch =
    "branch" in dirtyWorktree ? (dirtyWorktree as { branch?: unknown }).branch : undefined;
  const conflictingFiles =
    "conflictingFiles" in dirtyWorktree
      ? (dirtyWorktree as { conflictingFiles?: unknown }).conflictingFiles
      : undefined;
  if (typeof branch !== "string" || !Array.isArray(conflictingFiles)) {
    return null;
  }
  if (!conflictingFiles.every((file) => typeof file === "string")) {
    return null;
  }

  return {
    branch,
    conflictingFiles: [...conflictingFiles],
  };
}

function parseDirtyWorktreeError(error: unknown): { branch: string; files: string[] } | null {
  // Structured field is authoritative — preserves exact file paths regardless
  // of whether they contain delimiters used by the human-readable message.
  const dirtyWorktree = readDirtyWorktreeDetails(error);
  if (dirtyWorktree) {
    return {
      branch: dirtyWorktree.branch,
      files: dirtyWorktree.conflictingFiles,
    };
  }

  const detail =
    error &&
    typeof error === "object" &&
    "detail" in error &&
    typeof (error as { detail?: unknown }).detail === "string"
      ? (error as { detail: string }).detail
      : error instanceof Error
        ? error.message
        : String(error);
  const match = DIRTY_WORKTREE_ERROR_PATTERN.exec(detail);
  if (!match?.[1] || !match[2]) return null;
  const files = match[2]
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter((line) => line.length > 0);
  if (files.length === 0) return null;
  return {
    branch: match[1].trim(),
    files,
  };
}

const STASH_CONFLICT_PATTERN = /Stash could not be applied|Stash applied with merge conflicts/;

function isStashConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return STASH_CONFLICT_PATTERN.test(message);
}

const UNRESOLVED_INDEX_PATTERN = /you need to resolve your current index/;

function isUnresolvedIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return UNRESOLVED_INDEX_PATTERN.test(message);
}

function formatDirtyWorktreeDescription(files: string[]): string {
  const basenames = files.map((f) => f.split("/").pop() ?? f);
  if (basenames.length <= 3) {
    return `${basenames.join(", ")} ${basenames.length === 1 ? "has" : "have"} uncommitted changes. Commit or stash before switching.`;
  }
  return `${basenames.slice(0, 2).join(", ")} and ${basenames.length - 2} other file${basenames.length - 2 === 1 ? "" : "s"} have uncommitted changes. Commit or stash before switching.`;
}

function handleCheckoutError(
  error: unknown,
  ctx: {
    api: EnvironmentApi;
    environmentId: EnvironmentId;
    cwd: string;
    branch: string;
    queryClient: QueryClient;
    onSuccess: () => void;
    fallbackTitle: string;
    runBranchAction: (action: () => Promise<void>) => boolean;
    onRequestDiscardStash: (input: { cwd: string }) => void;
  },
): void {
  const dirtyWorktree = parseDirtyWorktreeError(error);
  if (dirtyWorktree) {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Uncommitted changes block checkout.",
        description: formatDirtyWorktreeDescription(dirtyWorktree.files),
        actionProps: {
          children: "Stash & Switch",
          onClick: () => {
            const accepted = ctx.runBranchAction(async () => {
              try {
                await ctx.api.vcs.stashAndSwitch({ cwd: ctx.cwd, refName: ctx.branch });
                await invalidateGitQueries(ctx.queryClient, {
                  environmentId: ctx.environmentId,
                  cwd: ctx.cwd,
                });
                ctx.onSuccess();
              } catch (stashError) {
                if (isStashConflictError(stashError)) {
                  await invalidateGitQueries(ctx.queryClient, {
                    environmentId: ctx.environmentId,
                    cwd: ctx.cwd,
                  });
                  ctx.onSuccess();
                  toastManager.add(
                    stackedThreadToast({
                      type: "warning",
                      title: "Stash could not be applied.",
                      description:
                        "Your stashed changes could not be applied to this branch. They are saved in the stash.",
                      actionProps: {
                        children: "Discard stash",
                        onClick: () => {
                          ctx.onRequestDiscardStash({ cwd: ctx.cwd });
                        },
                      },
                    }),
                  );
                } else if (parseDirtyWorktreeError(stashError)) {
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: "Cannot switch branches.",
                      description:
                        "Some conflicting files are not covered by git stash (e.g., files in .gitignore). Remove or move them manually before switching.",
                    }),
                  );
                } else {
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: "Failed to stash and switch.",
                      description: toBranchActionErrorMessage(stashError),
                    }),
                  );
                }
              }
            });
            if (!accepted) {
              toastManager.add(
                stackedThreadToast({
                  type: "warning",
                  title: "Branch action already running.",
                  description: "Wait for the current branch action to finish, then try again.",
                }),
              );
            }
          },
        },
      }),
    );
    return;
  }
  if (isUnresolvedIndexError(error)) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unresolved conflicts in the repository.",
        description: toBranchActionErrorMessage(error),
      }),
    );
    return;
  }
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: ctx.fallbackTitle,
      description: toBranchActionErrorMessage(error),
    }),
  );
}

function getBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: "local" | "worktree";
  resolvedActiveBranch: string | null;
}): string {
  const { activeWorktreePath, effectiveEnvMode, resolvedActiveBranch } = input;
  if (!resolvedActiveBranch) {
    return "Select ref";
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath) {
    return `From ${resolvedActiveBranch}`;
  }
  return resolvedActiveBranch;
}

export function BranchToolbarBranchSelector({
  className,
  environmentId,
  threadId,
  draftId,
  envLocked,
  effectiveEnvModeOverride,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarBranchSelectorProps) {
  // ---------------------------------------------------------------------------
  // Thread / project state (pushed down from parent to colocate with mutation)
  // ---------------------------------------------------------------------------
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const serverThreadSelector = useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]);
  const serverThread = useStore(serverThreadSelector);
  const serverSession = serverThread?.session ?? null;
  const setThreadBranchAction = useStore((store) => store.setThreadBranch);
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProjectSelector = useMemo(
    () => createProjectSelectorByRef(activeProjectRef),
    [activeProjectRef],
  );
  const activeProject = useStore(activeProjectSelector);

  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch =
    activeThreadBranchOverride !== undefined
      ? activeThreadBranchOverride
      : (serverThread?.branch ?? draftThread?.branch ?? null);
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeProjectCwd = activeProject?.cwd ?? null;
  const branchCwd = activeWorktreePath ?? activeProjectCwd;
  const hasServerThread = serverThread !== undefined;
  const effectiveEnvMode =
    effectiveEnvModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread,
      draftThreadEnvMode: draftThread?.envMode,
    });

  // ---------------------------------------------------------------------------
  // Thread branch mutation (colocated — only this component calls it)
  // ---------------------------------------------------------------------------
  const setThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      if (!activeThreadId || !activeProject) return;
      const api = readEnvironmentApi(environmentId);
      if (serverSession && worktreePath !== activeWorktreePath && api) {
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
        onActiveThreadBranchOverrideChange?.(branch);
        setThreadBranchAction(threadRef, branch, worktreePath);
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(draftId ?? threadRef, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
        projectRef: scopeProjectRef(environmentId, activeProject.id),
      });
    },
    [
      activeThreadId,
      activeProject,
      serverSession,
      activeWorktreePath,
      hasServerThread,
      onActiveThreadBranchOverrideChange,
      setThreadBranchAction,
      setDraftThreadContext,
      draftId,
      threadRef,
      environmentId,
      effectiveEnvMode,
    ],
  );

  // ---------------------------------------------------------------------------
  // Git ref queries
  // ---------------------------------------------------------------------------
  const queryClient = useQueryClient();
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [stashDiscardDialog, setStashDiscardDialog] = useState<StashDiscardDialogState | null>(
    null,
  );
  const [isDroppingStash, setIsDroppingStash] = useState(false);
  const deferredBranchQuery = useDeferredValue(branchQuery);

  const branchStatusQuery = useGitStatus({ environmentId, cwd: branchCwd });
  const trimmedBranchQuery = branchQuery.trim();
  const deferredTrimmedBranchQuery = deferredBranchQuery.trim();

  useEffect(() => {
    if (!branchCwd) return;
    void queryClient.prefetchInfiniteQuery(
      gitBranchSearchInfiniteQueryOptions({ environmentId, cwd: branchCwd, query: "" }),
    );
  }, [branchCwd, environmentId, queryClient]);

  const {
    data: branchesSearchData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending: isBranchesSearchPending,
  } = useInfiniteQuery(
    gitBranchSearchInfiniteQueryOptions({
      environmentId,
      cwd: branchCwd,
      query: deferredTrimmedBranchQuery,
    }),
  );
  const refs = useMemo(
    () => branchesSearchData?.pages.flatMap((page) => page.refs) ?? [],
    [branchesSearchData?.pages],
  );
  const currentGitBranch =
    branchStatusQuery.data?.refName ?? refs.find((refName) => refName.current)?.name ?? null;
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(branchStatusQuery.data?.sourceControlProvider),
    [branchStatusQuery.data?.sourceControlProvider],
  );
  const SourceControlIcon = sourceControlPresentation.Icon;
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });
  const branchNames = useMemo(() => refs.map((refName) => refName.name), [refs]);
  const branchByName = useMemo(
    () => new Map(refs.map((refName) => [refName.name, refName] as const)),
    [refs],
  );
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
  const [resolvedActiveBranch, setOptimisticBranch] = useState(canonicalActiveBranch);
  const [isBranchActionPending, setIsBranchActionPending] = useState(false);
  const isBranchActionPendingRef = useRef(false);
  // Preserve the optimistic value while a branch action is in flight. A mid-
  // flight git status refresh can briefly report the pre-checkout branch, and
  // syncing that back into `resolvedActiveBranch` would cause the trigger to
  // flicker from the target branch → old branch → target branch. Only adopt
  // the canonical value once the action settles (mimics useOptimistic/
  // useTransition semantics).
  useEffect(() => {
    if (isBranchActionPending) return;
    setOptimisticBranch(canonicalActiveBranch);
  }, [canonicalActiveBranch, isBranchActionPending]);
  const shouldVirtualizeBranchList = filteredBranchPickerItems.length > 40;
  const totalBranchCount = branchesSearchData?.pages[0]?.totalCount ?? 0;
  const branchStatusText = isBranchesSearchPending
    ? "Loading refs..."
    : isFetchingNextPage
      ? "Loading more refs..."
      : hasNextPage
        ? `Showing ${refs.length} of ${totalBranchCount} refs`
        : null;

  // ---------------------------------------------------------------------------
  // Branch actions
  // ---------------------------------------------------------------------------
  const runBranchAction = useCallback(
    (action: () => Promise<void>): boolean => {
      if (isBranchActionPendingRef.current) {
        return false;
      }

      isBranchActionPendingRef.current = true;
      setIsBranchActionPending(true);

      void (async () => {
        try {
          await action().catch(() => undefined);
          await queryClient
            .invalidateQueries({ queryKey: gitQueryKeys.refs(environmentId, branchCwd) })
            .catch(() => undefined);
        } finally {
          isBranchActionPendingRef.current = false;
          setIsBranchActionPending(false);
        }
      })();
      return true;
    },
    [branchCwd, environmentId, queryClient],
  );

  const openStashDiscardDialog = useCallback(
    (input: { cwd: string }) => {
      const api = readEnvironmentApi(environmentId);
      setStashDiscardDialog({
        cwd: input.cwd,
        error: api ? null : "Environment API is unavailable.",
        info: null,
        loading: Boolean(api),
      });
      if (!api) return;

      void api.vcs.stashInfo({ cwd: input.cwd }).then(
        (info) => {
          setStashDiscardDialog((current) =>
            current?.cwd === input.cwd
              ? { ...current, error: null, info, loading: false }
              : current,
          );
        },
        (error) => {
          setStashDiscardDialog((current) =>
            current?.cwd === input.cwd
              ? {
                  ...current,
                  error: toBranchActionErrorMessage(error),
                  info: null,
                  loading: false,
                }
              : current,
          );
        },
      );
    },
    [environmentId],
  );

  const discardStashFromDialog = useCallback(() => {
    const dialog = stashDiscardDialog;
    const api = readEnvironmentApi(environmentId);
    if (!dialog || !api || isDroppingStash || isBranchActionPending) return;

    runBranchAction(async () => {
      setIsDroppingStash(true);
      try {
        await api.vcs.stashDrop({ cwd: dialog.cwd });
        setStashDiscardDialog(null);
      } catch (dropError) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to drop stash.",
            description: toBranchActionErrorMessage(dropError),
          }),
        );
      } finally {
        setIsDroppingStash(false);
      }
    });
  }, [environmentId, isBranchActionPending, isDroppingStash, runBranchAction, stashDiscardDialog]);

  const selectBranch = (refName: VcsRef) => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !branchCwd || !activeProjectCwd || isBranchActionPending) return;

    if (isSelectingWorktreeBase) {
      setThreadBranch(refName.name, null);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectionTarget = resolveBranchSelectionTarget({
      activeProjectCwd,
      activeWorktreePath,
      refName,
    });

    if (selectionTarget.reuseExistingWorktree) {
      setThreadBranch(refName.name, selectionTarget.nextWorktreePath);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectedBranchName = refName.isRemote
      ? deriveLocalBranchNameFromRemoteRef(refName.name)
      : refName.name;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      const previousBranch = resolvedActiveBranch;
      setOptimisticBranch(selectedBranchName);
      try {
        const checkoutResult = await api.vcs.switchRef({
          cwd: selectionTarget.checkoutCwd,
          refName: refName.name,
        });
        const nextBranchName = refName.isRemote
          ? (checkoutResult.refName ?? selectedBranchName)
          : selectedBranchName;
        setOptimisticBranch(nextBranchName);
        setThreadBranch(nextBranchName, selectionTarget.nextWorktreePath);
      } catch (error) {
        setOptimisticBranch(previousBranch);
        handleCheckoutError(error, {
          api,
          environmentId,
          cwd: selectionTarget.checkoutCwd,
          branch: refName.name,
          queryClient,
          onSuccess: () => {
            setOptimisticBranch(selectedBranchName);
            setThreadBranch(selectedBranchName, selectionTarget.nextWorktreePath);
          },
          fallbackTitle: "Failed to checkout branch.",
          runBranchAction,
          onRequestDiscardStash: openStashDiscardDialog,
        });
      }
    });
  };

  const createRef = (rawName: string) => {
    const name = rawName.trim();
    const api = readEnvironmentApi(environmentId);
    if (!api || !branchCwd || !name || isBranchActionPending) return;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      const previousBranch = resolvedActiveBranch;
      setOptimisticBranch(name);
      try {
        const createBranchResult = await api.vcs.createRef({
          cwd: branchCwd,
          refName: name,
          switchRef: true,
        });
        setOptimisticBranch(createBranchResult.refName);
        setThreadBranch(createBranchResult.refName, activeWorktreePath);
      } catch (error) {
        setOptimisticBranch(previousBranch);
        handleCheckoutError(error, {
          api,
          environmentId,
          cwd: branchCwd,
          branch: name,
          queryClient,
          onSuccess: () => {
            setOptimisticBranch(name);
            setThreadBranch(name, activeWorktreePath);
          },
          fallbackTitle: "Failed to create and checkout branch.",
          runBranchAction,
          onRequestDiscardStash: openStashDiscardDialog,
        });
      }
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
    setThreadBranch(currentGitBranch, null);
  }, [activeThreadBranch, activeWorktreePath, currentGitBranch, effectiveEnvMode, setThreadBranch]);

  // ---------------------------------------------------------------------------
  // Combobox / list plumbing
  // ---------------------------------------------------------------------------
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsBranchMenuOpen(open);
      if (!open) {
        setBranchQuery("");
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: gitQueryKeys.refs(environmentId, branchCwd),
      });
    },
    [branchCwd, environmentId, queryClient],
  );

  const branchListScrollElementRef = useRef<HTMLDivElement | null>(null);
  const maybeFetchNextBranchPage = useCallback(() => {
    if (!isBranchMenuOpen || !hasNextPage || isFetchingNextPage) {
      return;
    }

    const scrollElement = branchListScrollElementRef.current;
    if (!scrollElement) {
      return;
    }

    const distanceFromBottom =
      scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
    if (distanceFromBottom > 96) {
      return;
    }

    void fetchNextPage().catch(() => undefined);
  }, [fetchNextPage, hasNextPage, isBranchMenuOpen, isFetchingNextPage]);
  const branchListRef = useRef<LegendListRef | null>(null);
  const setBranchListRef = useCallback((element: HTMLDivElement | null) => {
    branchListScrollElementRef.current = (element?.parentElement as HTMLDivElement | null) ?? null;
  }, []);

  useEffect(() => {
    if (!isBranchMenuOpen) {
      return;
    }

    if (shouldVirtualizeBranchList) {
      branchListRef.current?.scrollToOffset?.({ offset: 0, animated: false });
    } else {
      branchListScrollElementRef.current?.scrollTo({ top: 0 });
    }
  }, [deferredTrimmedBranchQuery, isBranchMenuOpen, shouldVirtualizeBranchList]);

  useEffect(() => {
    const scrollElement = branchListScrollElementRef.current;
    if (!scrollElement || !isBranchMenuOpen) {
      return;
    }

    const handleScroll = () => {
      maybeFetchNextBranchPage();
    };

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [isBranchMenuOpen, maybeFetchNextBranchPage]);

  useEffect(() => {
    if (shouldVirtualizeBranchList) return;
    maybeFetchNextBranchPage();
  }, [refs.length, maybeFetchNextBranchPage, shouldVirtualizeBranchList]);

  const triggerLabel = getBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
  });

  function renderPickerItem(itemValue: string, index: number) {
    if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
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
          <div className="flex min-w-0 items-center gap-2 py-1">
            <SourceControlIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col items-start">
              <span className="truncate font-medium">
                Checkout {sourceControlPresentation.terminology.singular}
              </span>
              <span className="truncate text-muted-foreground text-xs">{prReference}</span>
            </span>
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
          onClick={() => createRef(trimmedBranchQuery)}
        >
          <span className="truncate">Create new ref &quot;{trimmedBranchQuery}&quot;</span>
        </ComboboxItem>
      );
    }

    const refName = branchByName.get(itemValue);
    if (!refName) return null;

    const hasSecondaryWorktree =
      refName.worktreePath && activeProjectCwd && refName.worktreePath !== activeProjectCwd;
    const badge = refName.current
      ? "current"
      : hasSecondaryWorktree
        ? "worktree"
        : refName.isRemote
          ? "remote"
          : refName.isDefault
            ? "default"
            : null;
    return (
      <ComboboxItem
        hideIndicator
        key={itemValue}
        index={index}
        value={itemValue}
        onClick={() => selectBranch(refName)}
      >
        <div className="flex w-full items-center justify-between gap-2">
          <span className="truncate">{itemValue}</span>
          {badge && <span className="shrink-0 text-[10px] text-muted-foreground/45">{badge}</span>}
        </div>
      </ComboboxItem>
    );
  }

  return (
    <>
      <Combobox
        items={branchPickerItems}
        filteredItems={filteredBranchPickerItems}
        autoHighlight
        virtualized={shouldVirtualizeBranchList}
        onItemHighlighted={(_value, eventDetails) => {
          if (!isBranchMenuOpen || eventDetails.index < 0 || eventDetails.reason !== "keyboard") {
            return;
          }
          branchListRef.current?.scrollIndexIntoView?.({
            index: eventDetails.index,
            animated: false,
          });
        }}
        onOpenChange={handleOpenChange}
        open={isBranchMenuOpen}
        value={resolvedActiveBranch}
      >
        <ComboboxTrigger
          render={<Button variant="ghost" size="xs" />}
          className={cn("min-w-0 text-muted-foreground/70 hover:text-foreground/80", className)}
          disabled={(isBranchesSearchPending && refs.length === 0) || isBranchActionPending}
        >
          <span className="min-w-0 max-w-[240px] truncate">{triggerLabel}</span>
          <ChevronDownIcon className="shrink-0" />
        </ComboboxTrigger>
        <ComboboxPopup align="end" side="top" className="w-80">
          <div className="border-b p-1">
            <ComboboxInput
              className="[&_input]:font-sans rounded-md"
              inputClassName="ring-0"
              placeholder="Search refs..."
              showTrigger={false}
              size="sm"
              value={branchQuery}
              onChange={(event) => setBranchQuery(event.target.value)}
            />
          </div>
          <ComboboxEmpty>No refs found.</ComboboxEmpty>

          {shouldVirtualizeBranchList ? (
            <ComboboxListVirtualized>
              <LegendList<string>
                ref={branchListRef}
                data={filteredBranchPickerItems}
                keyExtractor={(item) => item}
                renderItem={({ item, index }) => renderPickerItem(item, index)}
                estimatedItemSize={28}
                drawDistance={336}
                onEndReached={() => {
                  if (hasNextPage && !isFetchingNextPage) {
                    void fetchNextPage().catch(() => undefined);
                  }
                }}
                style={{ maxHeight: "14rem" }}
              />
            </ComboboxListVirtualized>
          ) : (
            <ComboboxList ref={setBranchListRef} className="max-h-56">
              {filteredBranchPickerItems.map((itemValue, index) =>
                renderPickerItem(itemValue, index),
              )}
            </ComboboxList>
          )}
          {branchStatusText ? <ComboboxStatus>{branchStatusText}</ComboboxStatus> : null}
        </ComboboxPopup>
      </Combobox>
      <Dialog
        open={stashDiscardDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setStashDiscardDialog(null);
            setIsDroppingStash(false);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Discard saved stash?</DialogTitle>
            <DialogDescription>
              This will permanently drop the stash entry that preserved your uncommitted changes.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {stashDiscardDialog?.loading ? (
              <p className="text-muted-foreground text-sm">Loading stash details...</p>
            ) : stashDiscardDialog?.error ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm">
                {stashDiscardDialog.error}
              </p>
            ) : stashDiscardDialog?.info ? (
              <>
                <div className="grid gap-2 rounded-lg border bg-muted/60 p-3 text-sm">
                  <div className="flex min-w-0 gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">Branch</span>
                    <span className="min-w-0 truncate font-medium">
                      {stashDiscardDialog.info.branch ?? currentGitBranch ?? "Detached HEAD"}
                    </span>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">Worktree</span>
                    <span className="min-w-0 truncate font-mono text-xs">
                      {stashDiscardDialog.info.cwd}
                    </span>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">Stash</span>
                    <span className="min-w-0 truncate font-mono text-xs">
                      {stashDiscardDialog.info.stashRef}
                    </span>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">Name</span>
                    <span className="min-w-0 truncate">{stashDiscardDialog.info.message}</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="font-medium text-sm">
                    Changed files ({stashDiscardDialog.info.files.length})
                  </p>
                  {stashDiscardDialog.info.files.length > 0 ? (
                    <ul className="max-h-48 overflow-auto rounded-lg border bg-muted/40 py-1">
                      {stashDiscardDialog.info.files.map((file) => (
                        <li
                          className="truncate px-3 py-1 font-mono text-muted-foreground text-xs"
                          key={file}
                          title={file}
                        >
                          {file}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-lg border px-3 py-2 text-muted-foreground text-sm">
                      Git did not report changed file names for this stash.
                    </p>
                  )}
                </div>
              </>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => {
                setStashDiscardDialog(null);
                setIsDroppingStash(false);
              }}
            >
              Keep stash
            </Button>
            <Button
              variant="destructive"
              type="button"
              disabled={!stashDiscardDialog?.info || isDroppingStash}
              onClick={discardStashFromDialog}
            >
              {isDroppingStash ? "Discarding..." : "Discard stash"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
