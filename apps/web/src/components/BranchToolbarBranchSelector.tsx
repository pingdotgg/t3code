import { ComposerContextLabel } from "./ComposerContextLabel";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import { useRightPanelStore } from "../rightPanelStore";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ContextMenuItem, EnvironmentId, VcsRef, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useMemo,
  useOptimistic,
  useState,
  useTransition,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { readLocalApi } from "../localApi";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { usePaginatedBranches } from "../state/queries";
import { useProject, useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { cn } from "../lib/utils";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_POPUP_CLASS,
  THREAD_DETAILS_PANEL_SELECT_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { ThreadDetailsPrRows } from "./chat/ThreadDetailsPrRows";
import { parsePullRequestReference } from "../pullRequestReference";
import { getSourceControlPresentation } from "../sourceControlPresentation";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  deriveLocalBranchNameFromRemoteRef,
  resolveBranchTriggerLabel,
  resolveBranchToolbarPrBranch,
  resolveBranchSelectionTarget,
  resolveBranchToolbarValue,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  sanitizeNewRefName,
  shouldIncludeBranchPickerItem,
} from "./BranchToolbar.logic";
import {
  ThreadPullRequestBadgeControl,
  prStatusIndicator,
  resolveThreadPullRequestBadge,
  useLinkedThreadPullRequest,
} from "./ThreadStatusIndicators";
import { Button } from "./ui/button";
import { ComboboxItem, ComboboxTrigger } from "./ui/combobox";
import { BranchPicker, BranchPickerRefItem } from "./BranchPicker";
import { stackedThreadToast, toastManager } from "./ui/toast";

export interface BranchToolbarBranchSelectorHandle {
  open: () => void;
}

interface BranchToolbarBranchSelectorProps {
  forceNewWorktree?: boolean;
  ref?: Ref<BranchToolbarBranchSelectorHandle>;
  className?: string;
  displayMode?: "toolbar" | "panel";
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  envLocked: boolean;
  effectiveEnvModeOverride?: "local" | "worktree";
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (refName: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

export function BranchToolbarBranchSelector({
  forceNewWorktree = false,
  ref,
  className,
  displayMode = "toolbar",
  environmentId,
  threadId,
  draftId,
  envLocked,
  effectiveEnvModeOverride,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  startFromOrigin,
  onStartFromOriginChange,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarBranchSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, "thread session stop");
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread metadata update",
  );
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, {
    reportFailure: false,
  });
  const createRefMutation = useAtomCommand(vcsEnvironment.createRef, {
    reportFailure: false,
  });
  // ---------------------------------------------------------------------------
  // Thread / project state (pushed down from parent to colocate with mutation)
  // ---------------------------------------------------------------------------
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const serverThread = useThreadShell(threadRef);
  const serverSession = serverThread?.runtime ?? null;
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProject = useProject(activeProjectRef);

  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch =
    activeThreadBranchOverride !== undefined
      ? activeThreadBranchOverride
      : (serverThread?.branch ?? draftThread?.branch ?? null);
  const activeWorktreePath = forceNewWorktree
    ? null
    : (serverThread?.worktreePath ?? draftThread?.worktreePath ?? null);
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const branchCwd = activeWorktreePath ?? activeProjectCwd;
  const hasServerThread = serverThread !== null;
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
    (branch: string | null, worktreePath: string | null, automatic = false) => {
      if (!activeThreadId || !activeProject) return;
      if (serverSession && worktreePath !== activeWorktreePath) {
        void stopThreadSession({
          environmentId,
          input: { threadId: activeThreadId },
        });
      }
      if (hasServerThread) {
        void updateThreadMetadata({
          environmentId,
          input: {
            threadId: activeThreadId,
            branch,
            worktreePath,
          },
        });
      }
      if (hasServerThread) {
        onActiveThreadBranchOverrideChange?.(branch);
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
        environmentSelection: automatic ? (draftThread?.environmentSelection ?? "auto") : "manual",
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
      setDraftThreadContext,
      draftId,
      threadRef,
      environmentId,
      effectiveEnvMode,
      draftThread?.environmentSelection,
      stopThreadSession,
      updateThreadMetadata,
    ],
  );

  // ---------------------------------------------------------------------------
  // Git ref queries
  // ---------------------------------------------------------------------------
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const deferredBranchQuery = useDeferredValue(branchQuery);

  const branchStatusQuery = useEnvironmentQuery(
    branchCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: branchCwd },
        }),
  );
  const trimmedBranchQuery = branchQuery.trim();
  const deferredTrimmedBranchQuery = deferredBranchQuery.trim();
  // The server filters refs by substring, so it has to be given the sanitized
  // name as well: querying the raw "new branch" drops an existing new-branch
  // from the response entirely, which would defeat the collision check below.
  // Ref names cannot contain an ASCII space, so sanitizing loses no matches.
  const branchRefQuery = sanitizeNewRefName(deferredTrimmedBranchQuery);
  const branchRefState = usePaginatedBranches({
    environmentId,
    cwd: branchCwd,
    query: branchRefQuery,
  });
  const refs = branchRefState.refs;
  const hasNextPage =
    branchRefState.data?.nextCursor !== null && branchRefState.data?.nextCursor !== undefined;
  const isFetchingNextPage = branchRefState.isFetchingNextPage;
  const isInitialBranchesLoadPending = branchRefState.isPending && branchRefState.data === null;
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
  // The ref is created under its sanitized name, so the collision check has to
  // use that name too. Matching on the raw query would offer to create a ref
  // that already exists whenever sanitizing changes the name.
  const newRefName = sanitizeNewRefName(trimmedBranchQuery);
  const hasExactBranchMatch = branchByName.has(newRefName);
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
  const listedActiveBranch =
    resolvedActiveBranch === null ? null : (branchByName.get(resolvedActiveBranch) ?? null);
  const activeBranchRefQuery = useEnvironmentQuery(
    branchCwd !== null && resolvedActiveBranch !== null
      ? vcsEnvironment.listRefs({
          environmentId,
          input: {
            cwd: branchCwd,
            query: resolvedActiveBranch,
            limit: 10,
          },
        })
      : null,
  );
  const queriedActiveBranch = activeBranchRefQuery.data?.refs.find(
    (refName) => refName.name === resolvedActiveBranch,
  );
  const resolvedActiveBranchIsRemote =
    listedActiveBranch !== null
      ? listedActiveBranch.isRemote === true
      : queriedActiveBranch
        ? queriedActiveBranch.isRemote === true
        : null;
  const [isBranchActionPending, startBranchActionTransition] = useTransition();
  const totalBranchCount = branchRefState.data?.totalCount ?? 0;
  const branchStatusText = isInitialBranchesLoadPending
    ? "Loading refs..."
    : isFetchingNextPage
      ? "Loading more refs..."
      : hasNextPage
        ? `Showing ${refs.length} of ${totalBranchCount} refs`
        : null;

  // ---------------------------------------------------------------------------
  // Branch actions
  // ---------------------------------------------------------------------------
  const copyBranchName = useCallback((branchName: string) => {
    void writeTextToClipboard(branchName, "branch name").then(
      (didCopy) => {
        if (!didCopy) return;
        toastManager.add({
          type: "success",
          title: "Branch name copied",
          description: branchName,
        });
      },
      (error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy branch name",
            description: toBranchActionErrorMessage(error),
          }),
        );
      },
    );
  }, []);

  const handleBranchContextMenu = useCallback(
    (event: ReactMouseEvent, branchName: string | null) => {
      if (!branchName) return;
      const api = readLocalApi();
      if (!api) return;
      event.preventDefault();
      event.stopPropagation();
      const items: ContextMenuItem<"copy-branch-name">[] = [
        { id: "copy-branch-name", label: "Copy branch name", icon: "copy" },
      ];
      void api.contextMenu.show(items, { x: event.clientX, y: event.clientY }).then((action) => {
        if (action === "copy-branch-name") copyBranchName(branchName);
      });
    },
    [copyBranchName],
  );

  const runBranchAction = (action: () => Promise<void>) => {
    startBranchActionTransition(async () => {
      await action();
      branchRefState.refresh();
      branchStatusQuery.refresh();
    });
  };

  const selectBranch = (refName: VcsRef) => {
    if (!branchCwd || !activeProjectCwd || isBranchActionPending) return;

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
      const checkoutResult = await switchRef({
        environmentId,
        input: {
          cwd: selectionTarget.checkoutCwd,
          refName: refName.name,
        },
      });
      if (checkoutResult._tag === "Success") {
        const nextBranchName = refName.isRemote
          ? (checkoutResult.value.refName ?? selectedBranchName)
          : selectedBranchName;
        setOptimisticBranch(nextBranchName);
        setThreadBranch(nextBranchName, selectionTarget.nextWorktreePath);
        return;
      }
      setOptimisticBranch(previousBranch);
      if (!isAtomCommandInterrupted(checkoutResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch ref.",
            description: toBranchActionErrorMessage(squashAtomCommandFailure(checkoutResult)),
          }),
        );
      }
    });
  };

  const createRef = (rawName: string) => {
    const name = sanitizeNewRefName(rawName);
    if (!branchCwd || !name || isBranchActionPending) return;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      const previousBranch = resolvedActiveBranch;
      setOptimisticBranch(name);
      const createBranchResult = await createRefMutation({
        environmentId,
        input: {
          cwd: branchCwd,
          refName: name,
          switchRef: true,
        },
      });
      if (createBranchResult._tag === "Success") {
        setOptimisticBranch(createBranchResult.value.refName);
        setThreadBranch(createBranchResult.value.refName, activeWorktreePath);
        return;
      }
      setOptimisticBranch(previousBranch);
      if (!isAtomCommandInterrupted(createBranchResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to create and switch ref.",
            description: toBranchActionErrorMessage(squashAtomCommandFailure(createBranchResult)),
          }),
        );
      }
    });
  };

  // Default the worktree base to the repo default branch (origin/HEAD), only
  // falling back to the checked-out branch when no default is known.
  const defaultBranchName = useMemo(
    () => refs.find((refName) => refName.isDefault)?.name ?? null,
    [refs],
  );
  const worktreeBaseBranchCandidate = isInitialBranchesLoadPending
    ? null
    : (defaultBranchName ?? currentGitBranch);

  useEffect(() => {
    if (
      effectiveEnvMode !== "worktree" ||
      activeWorktreePath ||
      activeThreadBranch ||
      !worktreeBaseBranchCandidate
    ) {
      return;
    }
    setThreadBranch(worktreeBaseBranchCandidate, null, true);
  }, [
    activeThreadBranch,
    activeWorktreePath,
    effectiveEnvMode,
    setThreadBranch,
    worktreeBaseBranchCandidate,
  ]);

  // ---------------------------------------------------------------------------
  // Combobox / list plumbing
  // ---------------------------------------------------------------------------
  const handleOpenChange = useCallback((open: boolean) => {
    setIsBranchMenuOpen(open);
    if (!open) {
      setBranchQuery("");
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      open: () => {
        if (isInitialBranchesLoadPending || isBranchActionPending) return;
        handleOpenChange(true);
      },
    }),
    [handleOpenChange, isBranchActionPending, isInitialBranchesLoadPending],
  );

  const triggerLabel = resolveBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
    resolvedActiveBranchIsRemote,
    startFromOrigin,
  });

  // Branch status is the fallback when this thread has no linked pull requests.
  const branchPrBranch = resolveBranchToolbarPrBranch({
    activeThreadBranch,
    resolvedActiveBranch,
  });
  const branchPr =
    branchPrBranch !== null && branchStatusQuery.data?.refName === branchPrBranch
      ? (branchStatusQuery.data.pr ?? null)
      : null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(environmentId);
  const linkedStatus = useLinkedThreadPullRequest(
    environmentId,
    serverThread?.linkedPullRequest,
    true,
    serverThread?.pullRequests,
    serverThread?.branchPullRequest,
  );
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(serverThread?.pullRequests ?? [])
    : null;
  const prBadge = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(serverThread?.pullRequests)
    : null;
  const displayedPr = linkedStatus?.pr ?? (currentLinkedPr === null ? branchPr : null);
  const displayedPrStatus = prStatusIndicator(
    displayedPr,
    linkedStatus?.sourceControlProvider ?? branchStatusQuery.data?.sourceControlProvider,
  );
  const prNumber = currentLinkedPr?.number ?? displayedPr?.number;
  const prUrl = currentLinkedPr?.url ?? displayedPr?.url;
  const openPrLink = useOpenPrLink(threadRef);
  const panelPrLabel =
    prNumber === undefined
      ? ""
      : `#${prNumber}${displayedPr?.title.trim() ? `: ${displayedPr.title}` : ""}`;

  function renderPickerItem(itemValue: string, index: number) {
    if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          className="pe-2"
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
          className="pe-1.5"
          onClick={() => createRef(trimmedBranchQuery)}
        >
          <span className="truncate">Create new ref &quot;{newRefName}&quot;</span>
        </ComboboxItem>
      );
    }

    const refName = branchByName.get(itemValue);
    if (!refName) return null;

    return (
      <BranchPickerRefItem
        branch={refName}
        projectCwd={activeProjectCwd}
        index={index}
        onClick={() => selectBranch(refName)}
        onContextMenu={(event) => handleBranchContextMenu(event, itemValue)}
      />
    );
  }

  return (
    <BranchPicker
      items={branchPickerItems}
      filteredItems={filteredBranchPickerItems}
      open={isBranchMenuOpen}
      onOpenChange={handleOpenChange}
      value={resolvedActiveBranch}
      query={branchQuery}
      resultsQuery={deferredTrimmedBranchQuery}
      onQueryChange={setBranchQuery}
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      onLoadNext={branchRefState.loadNext}
      statusText={branchStatusText}
      renderItem={renderPickerItem}
      getItemType={(item) =>
        item === checkoutPullRequestItemValue
          ? "checkout-pull-request"
          : item === createBranchItemValue
            ? "create-branch"
            : "branch"
      }
      originControl={
        isSelectingWorktreeBase
          ? { checked: startFromOrigin, onCheckedChange: onStartFromOriginChange }
          : undefined
      }
      popupProps={{
        align: displayMode === "panel" ? "start" : "end",
        side: displayMode === "panel" ? "bottom" : "top",
        className: cn(
          "flex flex-col",
          displayMode === "panel" ? THREAD_DETAILS_PANEL_ROW_POPUP_CLASS : "w-80",
        ),
        ...(displayMode === "toolbar" ? composerFloatingLayerProps : {}),
      }}
    >
      <div
        className={cn(
          "flex min-w-0",
          displayMode === "panel" ? "w-full flex-col items-stretch" : "items-center gap-1",
          className,
        )}
      >
        {displayMode !== "panel" ? (
          <ThreadPullRequestBadgeControl
            variant="ghost"
            badge={prBadge}
            pullRequests={serverThread?.pullRequests ?? []}
            number={prNumber}
            url={prUrl}
            status={displayedPrStatus}
            onOpenStack={() => useRightPanelStore.getState().open(threadRef, "pull-requests")}
            onOpenPullRequest={(event, targetUrl = prUrl) => {
              if (targetUrl) openPrLink(event, targetUrl);
            }}
          />
        ) : null}
        <span
          className="flex min-w-0"
          onContextMenu={(event) => handleBranchContextMenu(event, resolvedActiveBranch)}
        >
          <ComboboxTrigger
            render={<Button variant="ghost" size={displayMode === "panel" ? "sm" : "xs"} />}
            className={cn(
              "min-w-0 max-w-full font-normal text-muted-foreground/70 text-xs! hover:text-foreground/80 active:scale-100",
              displayMode === "panel" && THREAD_DETAILS_PANEL_SELECT_ROW_CLASS,
            )}
            disabled={isInitialBranchesLoadPending || isBranchActionPending}
          >
            <GitBranchIcon
              className={cn(
                "size-3 shrink-0 opacity-70",
                displayMode === "panel" && THREAD_DETAILS_PANEL_ICON_CLASS,
              )}
            />
            <ComposerContextLabel displayMode={displayMode}>{triggerLabel}</ComposerContextLabel>
            {displayMode === "panel" ? (
              <span data-slot="select-icon">
                <ChevronDownIcon className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
              </span>
            ) : (
              <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
            )}
          </ComboboxTrigger>
        </span>
        {displayMode === "panel" && prNumber !== undefined && prUrl !== undefined ? (
          <ThreadDetailsPrRows
            links={serverThread?.pullRequests ?? []}
            currentLink={currentLinkedPr}
            onOpenLink={openPrLink}
            environmentId={environmentId}
            pr={displayedPr}
            number={prNumber}
            reference={currentLinkedPr}
            status={displayedPrStatus}
            project={activeProject}
            label={panelPrLabel}
            openAriaLabel={prUrl ?? "Open pull request"}
            onOpen={(event) => openPrLink(event, prUrl)}
            onActed={() => branchStatusQuery.refresh()}
          />
        ) : null}
      </div>
    </BranchPicker>
  );
}
