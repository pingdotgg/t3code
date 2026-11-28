import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { contextMenuSourceOf } from "../contextMenuSource";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { changeRequestTermKind } from "./pullRequest/changeRequestTerm";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type ContextMenuItem,
  type EnvironmentId,
  type ProjectId,
  type PullRequestListEntry,
  type VcsRef,
  type ThreadId,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { ChevronDownIcon, ExternalLinkIcon, GitBranchIcon } from "lucide-react";
import type { MessageResolver } from "../i18n/messages";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { readLocalApi } from "../localApi";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { usePaginatedBranches } from "../state/queries";
import { useProjectClone } from "../state/projectClones";
import { readThreadShell, useProject, useQuietThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "../state/threads";
import { pullRequestEnvironment } from "../state/pullRequests";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { cn } from "../lib/utils";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./chat/threadDetailsPanelStyles";
import { ThreadDetailsThreadPrRows } from "./chat/ThreadDetailsPrRows";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import { ThreadDetailsIssueRows } from "./chat/ThreadDetailsIssueRows";
import { parsePullRequestReference } from "@t3tools/client-runtime/pull-request-link-input";
import { getSourceControlPresentation } from "../sourceControlPresentation";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  type BranchHold,
  deriveLocalBranchNameFromRemoteRef,
  isBranchHoldCurrent,
  isWorktreeChangeBlocked,
  groupLabelsForPickerItems,
  orderRefNamesByGroup,
  resolveBranchTriggerLabel,
  resolveBranchToolbarPrBranch,
  resolveBranchSelectionTarget,
  resolveBranchToolbarValue,
  resolveConfirmedSelectedRef,
  resolveDefaultWorktreeBaseBranch,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  sanitizeNewRefName,
  shouldIncludeBranchPickerItem,
  toBranchActionErrorMessage,
} from "./BranchToolbar.logic";
import { resolveDisplayedThreadPr } from "./ThreadStatusIndicators";

import { ComboboxItem, ComboboxTrigger } from "./ui/combobox";
import { ComposerControl } from "./chat/ComposerControl";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Skeleton } from "./ui/skeleton";
import { BranchPicker, BranchPickerGroupLabel, BranchPickerRefItem } from "./BranchPicker";
import { stackedThreadToast, toastManager } from "./ui/toast";

export interface BranchToolbarBranchSelectorHandle {
  open: () => void;
}

interface BranchToolbarBranchSelectorProps {
  forceNewWorktree?: boolean;
  ref?: Ref<BranchToolbarBranchSelectorHandle>;
  className?: string;
  displayMode?: "toolbar" | "panel";
  /** Composer only: one chip for the branch and workspace mode. */
  renderWorkspaceMenu?: (branch: {
    label: string;
    disabled: boolean;
    open: boolean;
    focusSearch: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
    onContextMenu: (event: ReactMouseEvent) => void;
  }) => ReactNode;
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
  /** Panel only: renders the PR rows here instead of under the branch row; null holds them. */
  prRowsContainer?: HTMLElement | null;
}

function portalTo(container: HTMLElement | undefined, node: ReactElement) {
  return container ? createPortal(node, container) : node;
}

const WORKTREE_CHANGE_BLOCKED_MESSAGE = msg("Stop the current turn to switch worktrees.");

// Both branch pickers for a draft share the latest selection.
const latestDraftPicks = new Map<DraftId, { token: symbol; stop: () => void }>();

// Picker checkouts by environment and checkout: null while in flight, then the branch it landed
// on. Shared because a draft thread mounts two selectors on one checkout, and the switch's own
// settle reloads refs for both.
const pickerCheckouts = new Map<string, string | null>();
const pickerCheckoutKey = (environmentId: string, cwd: string) => `${environmentId}\u0000${cwd}`;

// The picker's list keys on these arrays, so they stay cached across the
// queries and transitions the selector calls after computing them.
function buildBranchPickerItems({
  refs,
  pullRequests,
  projectId,
  newRefName,
  createBranchItemValue,
  checkoutPullRequestItemValue,
  normalizedQuery,
  changeRequestGroupLabel,
  resolve,
}: {
  refs: ReadonlyArray<VcsRef>;
  pullRequests: ReadonlyArray<PullRequestListEntry> | undefined;
  projectId: ProjectId | null;
  newRefName: string;
  createBranchItemValue: string | null;
  checkoutPullRequestItemValue: string | null;
  normalizedQuery: string;
  changeRequestGroupLabel: string;
  resolve: MessageResolver;
}) {
  const branchByName = new Map(refs.map((refName) => [refName.name, refName] as const));
  const openPullRequests = (pullRequests ?? [])
    .filter((entry) => entry.projectId === projectId)
    .slice(0, 5);
  const pullRequestByItemValue = new Map<string, PullRequestListEntry>(
    openPullRequests.map((entry) => [`__pull_request__:${entry.number}`, entry] as const),
  );
  const branchPickerItems = [
    ...(checkoutPullRequestItemValue ? [checkoutPullRequestItemValue] : []),
    ...orderRefNamesByGroup(refs),
    ...pullRequestByItemValue.keys(),
    ...(createBranchItemValue && !branchByName.has(newRefName) ? [createBranchItemValue] : []),
  ];
  const filteredBranchPickerItems =
    normalizedQuery.length === 0
      ? branchPickerItems
      : branchPickerItems.filter((itemValue) => {
          const pullRequest = pullRequestByItemValue.get(itemValue);
          if (pullRequest) {
            return (
              pullRequest.title.toLowerCase().includes(normalizedQuery) ||
              pullRequest.headBranch.toLowerCase().includes(normalizedQuery) ||
              `#${pullRequest.number}`.includes(normalizedQuery)
            );
          }
          return shouldIncludeBranchPickerItem({
            itemValue,
            normalizedQuery,
            createBranchItemValue,
            checkoutPullRequestItemValue,
          });
        });
  const pickerGroupLabels = groupLabelsForPickerItems(filteredBranchPickerItems, (itemValue) => {
    if (pullRequestByItemValue.has(itemValue)) return changeRequestGroupLabel;
    const ref = branchByName.get(itemValue);
    if (!ref) return null;
    return ref.isRemote
      ? resolve(msg("Remote", { $context: "branch picker group, remote branches" }))
      : resolve(msg("Local", { $context: "branch picker group, local branches" }));
  });
  return {
    branchByName,
    pullRequestByItemValue,
    branchPickerItems,
    filteredBranchPickerItems,
    pickerGroupLabels,
  };
}

export function BranchToolbarBranchSelector({
  forceNewWorktree = false,
  ref,
  className,
  displayMode = "toolbar",
  renderWorkspaceMenu,
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
  prRowsContainer,
}: BranchToolbarBranchSelectorProps) {
  const gt = useGT();
  const messages = useMessages();
  const composerFloatingLayerProps = useComposerMenuProps();
  const toolbarAnchorRef = useRef<HTMLDivElement>(null);
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, "thread session stop");
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread metadata update",
  );
  const updateEmptyThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, {
    reportFailure: false,
  });
  const readRefs = useAtomCommand(vcsEnvironment.readRefs, {
    reportFailure: false,
  });
  const refreshLocalStatusForPicker = useAtomCommand(vcsEnvironment.refreshLocalStatusForPicker, {
    reportFailure: false,
  });
  const createRefMutation = useAtomCommand(vcsEnvironment.createRef, {
    reportFailure: false,
  });
  const threadRef = scopeThreadRef(environmentId, threadId);
  const serverThread = useQuietThreadShell(threadRef);
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
    : serverThread
      ? serverThread.worktreePath
      : (draftThread?.worktreePath ?? null);
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const branchCwd = activeWorktreePath ?? activeProjectCwd;
  const hasServerThread = serverThread !== null;
  const canUpdateThreadBranch = !hasServerThread || canOperateThread;
  const canChangeThreadBranch = canWriteSourceControl && canUpdateThreadBranch;
  const effectiveEnvMode =
    effectiveEnvModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread,
      draftThreadEnvMode: draftThread?.envMode,
    });

  const readLatestThreadState = () =>
    readThreadShell(threadRef) ??
    serverThread ?? { runtime: null, worktreePath: activeWorktreePath };

  const setThreadBranch = (
    branch: string | null,
    worktreePath: string | null,
    automatic = false,
    onMetadataFailure?: () => void,
  ) => {
    if (
      !activeThreadId ||
      !activeProject ||
      (hasServerThread && !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
    )
      return false;
    const latest = readLatestThreadState();
    if (automatic && (latest.runtime || latest.worktreePath)) return false;
    if (
      isWorktreeChangeBlocked({
        runtime: latest.runtime,
        currentWorktreePath: latest.worktreePath,
        nextWorktreePath: worktreePath,
      })
    ) {
      toastManager.add(
        stackedThreadToast({ type: "warning", title: messages(WORKTREE_CHANGE_BLOCKED_MESSAGE) }),
      );
      return false;
    }
    if (latest.runtime && worktreePath !== latest.worktreePath) {
      void stopThreadSession({
        environmentId,
        input: { threadId: activeThreadId },
      });
    }
    if (hasServerThread) {
      void (automatic ? updateEmptyThreadMetadata : updateThreadMetadata)({
        environmentId,
        input: {
          threadId: activeThreadId,
          branch,
          worktreePath,
          ...(automatic ? { expectedEmpty: true } : {}),
        },
      }).then((result) => {
        if (result._tag !== "Success") onMetadataFailure?.();
      });
    }
    if (hasServerThread) {
      onActiveThreadBranchOverrideChange?.(branch);
      return true;
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
    return true;
  };

  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [focusBranchSearch, setFocusBranchSearch] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");

  const branchStatusQuery = useEnvironmentQuery(
    branchCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: branchCwd },
        }),
  );
  const projectStatusQuery = useEnvironmentQuery(
    activeProjectCwd === null
      ? null
      : vcsEnvironment.status({ environmentId, input: { cwd: activeProjectCwd } }),
  );
  const activeProjectCheckoutRoot = projectStatusQuery.data?.workingTree.rootPath;
  const trimmedBranchQuery = branchQuery.trim();
  const branchRefState = usePaginatedBranches(
    {
      environmentId,
      cwd: branchCwd,
      // Substring search needs sanitized names to detect new-branch collisions; refs cannot contain ASCII
      // spaces.
      query: sanitizeNewRefName(trimmedBranchQuery),
    },
    messages,
  );
  const refs = branchRefState.refs;
  const isWorktreeChangeBlockedForRef = (refName: VcsRef) =>
    activeProjectCwd !== null &&
    isWorktreeChangeBlocked({
      runtime: serverSession,
      currentWorktreePath: serverThread ? serverThread.worktreePath : activeWorktreePath,
      nextWorktreePath: isSelectingWorktreeBase
        ? null
        : resolveBranchSelectionTarget({
            activeProjectCwd,
            activeProjectCheckoutRoot,
            activeWorktreePath,
            refName,
          }).nextWorktreePath,
    });
  const hasNextPage =
    branchRefState.data?.nextCursor !== null && branchRefState.data?.nextCursor !== undefined;
  const isFetchingNextPage = branchRefState.isFetchingNextPage;
  const isInitialBranchesLoadPending = branchRefState.isPending && branchRefState.data === null;
  const currentGitBranch =
    branchStatusQuery.data?.refName ?? refs.find((refName) => refName.current)?.name ?? null;
  const sourceControlPresentation = getSourceControlPresentation(
    branchStatusQuery.data?.sourceControlProvider,
  );
  const SourceControlIcon = sourceControlPresentation.Icon;
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });
  const [branchHold, setBranchHold] = useState<BranchHold | null>(null);
  const branchHoldCurrent =
    branchHold !== null &&
    isBranchHoldCurrent(branchHold, {
      canonicalBranch: canonicalActiveBranch,
      environmentId,
      cwd: branchCwd,
    });
  if (branchHold !== null && !branchHoldCurrent) setBranchHold(null);
  const normalizedBranchQuery = trimmedBranchQuery.toLowerCase();
  const prReference = parsePullRequestReference(trimmedBranchQuery);
  const isSelectingWorktreeBase =
    effectiveEnvMode === "worktree" && !envLocked && !activeWorktreePath;
  const checkoutPullRequestItemValue =
    canChangeThreadBranch && prReference && onCheckoutPullRequestRequest
      ? `__checkout_pull_request__:${prReference}`
      : null;
  const canCreateBranch =
    canChangeThreadBranch && !isSelectingWorktreeBase && trimmedBranchQuery.length > 0;
  const newRefName = sanitizeNewRefName(trimmedBranchQuery);
  const createBranchItemValue = canCreateBranch
    ? `__create_new_branch__:${trimmedBranchQuery}`
    : null;
  // Open change requests in this project, newest first, to start the thread from one. Read only
  // while the picker is open; picking one runs the same prepare flow as a pasted reference.
  const pullRequestListQuery = useEnvironmentQuery(
    isBranchMenuOpen && canChangeThreadBranch && onCheckoutPullRequestRequest && activeProject
      ? pullRequestEnvironment.list({
          environmentId,
          input: { state: "open", projectId: activeProject.id, limit: 5 },
        })
      : null,
  );
  const {
    branchByName,
    pullRequestByItemValue,
    branchPickerItems,
    filteredBranchPickerItems,
    pickerGroupLabels,
  } = buildBranchPickerItems({
    refs,
    pullRequests: pullRequestListQuery.data?.entries,
    projectId: activeProject?.id ?? null,
    newRefName,
    createBranchItemValue,
    checkoutPullRequestItemValue,
    normalizedQuery: normalizedBranchQuery,
    changeRequestGroupLabel: gt(
      "{term, select, mr {Merge requests} cr {Change requests} other {Pull requests}}",
      { term: changeRequestTermKind(sourceControlPresentation.terminology) },
    ),
    resolve: messages,
  });
  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    branchHoldCurrent ? branchHold.branch : canonicalActiveBranch,
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
    ? gt("Loading refs...")
    : isFetchingNextPage
      ? gt("Loading more refs...")
      : hasNextPage
        ? gt(
            "{total, plural, one {Showing {shown} of {total} refs} other {Showing {shown} of {total} refs}}",
            { shown: refs.length, total: totalBranchCount },
          )
        : null;

  const copyBranchName = (branchName: string) => {
    void writeTextToClipboard(branchName, {
      target: "branch name",
      unavailableMessage: msg("Clipboard API is unavailable while copying branch name."),
      failureMessage: msg("Failed to copy branch name to the clipboard."),
    }).then(undefined, (error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Failed to copy branch name"),
          description: toBranchActionErrorMessage(error),
        }),
      );
    });
  };

  const handleBranchContextMenu = (event: ReactMouseEvent, branchName: string | null) => {
    if (!branchName) return;
    const api = readLocalApi();
    if (!api) return;
    event.preventDefault();
    event.stopPropagation();
    const items: ContextMenuItem<"copy-branch-name">[] = [
      { id: "copy-branch-name", label: gt("Copy branch name"), icon: "copy" },
    ];
    void api.contextMenu
      .show(items, { x: event.clientX, y: event.clientY }, contextMenuSourceOf(event))
      .then((action) => {
        if (action === "copy-branch-name") copyBranchName(branchName);
      });
  };

  const runBranchAction = (action: () => Promise<void>) => {
    if (
      !readEnvironmentScope(environmentId, AuthSourceControlWriteScope) ||
      (hasServerThread && !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Action unavailable"),
          description: gt("This connection cannot change the thread's branch."),
        }),
      );
      return;
    }
    startBranchActionTransition(async () => {
      await action();
      branchRefState.refresh();
    });
  };

  const latestSelectionRef = useRef<symbol | null>(null);
  const beginBranchPick = () => {
    const token = Symbol();
    latestSelectionRef.current = token;
    if (hasServerThread) return () => latestSelectionRef.current === token;
    const store = useComposerDraftStore.getState();
    const target = draftId ?? threadRef;
    const targetId = draftId ?? store.getDraftIdByRef(threadRef);
    if (!targetId) return () => latestSelectionRef.current === token;
    latestDraftPicks.get(targetId)?.stop();
    // Watches the draft for the pick's own lifetime, not the selector's: closing Thread Details
    // must not drop a checkout that lands later, but any workspace change in between must.
    let previous = store.getDraftThread(target);
    const stop = useComposerDraftStore.subscribe((state) => {
      const current = state.getDraftThread(target);
      if (
        current?.environmentId !== previous?.environmentId ||
        current?.projectId !== previous?.projectId ||
        current?.envMode !== previous?.envMode ||
        current?.worktreePath !== previous?.worktreePath ||
        current?.promotedTo !== previous?.promotedTo
      ) {
        stop();
        if (latestDraftPicks.get(targetId)?.token === token) latestDraftPicks.delete(targetId);
      }
      previous = current;
    });
    latestDraftPicks.set(targetId, { token, stop });
    return () => latestDraftPicks.get(targetId)?.token === token;
  };

  // The picker's list, and the server's coalesced ref listing, can predate a checkout an agent
  // ran itself. Only the claimed worktree's live HEAD confirms the claim; an unconfirmed one
  // falls back to a real checkout, which Git refuses if the branch is checked out elsewhere.
  const readSelectedRef = async (worktreePath: string, listedRef: VcsRef): Promise<VcsRef> => {
    const result = await readRefs({
      environmentId,
      input: { cwd: worktreePath, query: listedRef.name, refKind: "local", limit: 1 },
    });
    return resolveConfirmedSelectedRef(listedRef, result._tag === "Success" ? result.value : null);
  };

  const selectBranch = async (listedRef: VcsRef) => {
    if (!canUpdateThreadBranch || !branchCwd || !activeProjectCwd || isBranchActionPending) return;
    const isCurrentPick = beginBranchPick();

    let latest = readLatestThreadState();
    if (isSelectingWorktreeBase) {
      if (latest.worktreePath) return;
      setThreadBranch(listedRef.name, null);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    const refName = listedRef.worktreePath
      ? await readSelectedRef(listedRef.worktreePath, listedRef)
      : listedRef;
    // A later pick made while this one was confirming its worktree wins.
    if (!isCurrentPick()) return;
    latest = readLatestThreadState();
    const selectionTarget = resolveBranchSelectionTarget({
      activeProjectCwd,
      activeProjectCheckoutRoot,
      activeWorktreePath: latest.worktreePath,
      refName,
    });

    if (
      isWorktreeChangeBlocked({
        runtime: latest.runtime,
        currentWorktreePath: latest.worktreePath,
        nextWorktreePath: selectionTarget.nextWorktreePath,
      })
    )
      return;

    if (
      selectionTarget.reuseExistingWorktree &&
      !(selectionTarget.staysInActiveCheckout && canWriteSourceControl)
    ) {
      setThreadBranch(refName.name, selectionTarget.nextWorktreePath);
      return;
    }

    const selectedBranchName = refName.isRemote
      ? deriveLocalBranchNameFromRemoteRef(refName.name, refName.remoteName)
      : refName.name;

    runBranchAction(async () => {
      const previousBranch = resolvedActiveBranch;
      setOptimisticBranch(selectedBranchName);
      const checkoutKey = pickerCheckoutKey(environmentId, selectionTarget.checkoutCwd);
      pickerCheckouts.set(checkoutKey, null);
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
        pickerCheckouts.set(checkoutKey, nextBranchName);
        const movesCheckout = selectionTarget.checkoutCwd !== branchCwd;
        let hold: BranchHold | null = null;
        const applied =
          (hasServerThread || isCurrentPick()) &&
          setThreadBranch(
            nextBranchName,
            selectionTarget.nextWorktreePath,
            false,
            // A failed move leaves the thread in its old checkout, which never had the new branch.
            movesCheckout
              ? () => setBranchHold((current) => (current === hold ? null : current))
              : undefined,
          );
        if (applied) {
          hold = {
            branch: nextBranchName,
            environmentId,
            // The thread keeps its old checkout until the metadata update moves it to the new one.
            checkouts: [
              { cwd: branchCwd, replaces: canonicalActiveBranch },
              ...(movesCheckout
                ? [
                    {
                      cwd: selectionTarget.checkoutCwd,
                      replaces: projectStatusQuery.data?.refName ?? null,
                    },
                  ]
                : []),
            ],
          };
          setBranchHold(hold);
        }
        setOptimisticBranch(applied ? nextBranchName : previousBranch);
        return;
      }
      pickerCheckouts.delete(checkoutKey);
      setOptimisticBranch(previousBranch);
      if (!isAtomCommandInterrupted(checkoutResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Failed to switch ref."),
            description: toBranchActionErrorMessage(squashAtomCommandFailure(checkoutResult)),
          }),
        );
      }
    });
  };

  const createRef = (rawName: string) => {
    if (!canChangeThreadBranch) return;
    const name = sanitizeNewRefName(rawName);
    if (!branchCwd || !name || isBranchActionPending) return;
    const isCurrentPick = beginBranchPick();

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      const previousBranch = resolvedActiveBranch;
      setOptimisticBranch(name);
      const checkoutKey = pickerCheckoutKey(environmentId, branchCwd);
      pickerCheckouts.set(checkoutKey, null);
      const createBranchResult = await createRefMutation({
        environmentId,
        input: {
          cwd: branchCwd,
          refName: name,
          switchRef: true,
        },
      });
      if (createBranchResult._tag === "Success") {
        const nextBranchName = createBranchResult.value.refName;
        pickerCheckouts.set(checkoutKey, nextBranchName);
        const applied =
          (hasServerThread || isCurrentPick()) &&
          setThreadBranch(nextBranchName, activeWorktreePath);
        if (applied) {
          setBranchHold({
            branch: nextBranchName,
            environmentId,
            checkouts: [{ cwd: branchCwd, replaces: canonicalActiveBranch }],
          });
        }
        setOptimisticBranch(applied ? nextBranchName : previousBranch);
        return;
      }
      pickerCheckouts.delete(checkoutKey);
      setOptimisticBranch(previousBranch);
      if (!isAtomCommandInterrupted(createBranchResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Failed to create and switch ref."),
            description: toBranchActionErrorMessage(squashAtomCommandFailure(createBranchResult)),
          }),
        );
      }
    });
  };

  const worktreeBaseBranchCandidate = isInitialBranchesLoadPending
    ? null
    : resolveDefaultWorktreeBaseBranch(refs);

  const projectCloneDone = useProjectClone(activeProjectRef)?.phase === "done";
  const refreshStaleRefs = useEffectEvent(() => {
    if (branchCwd === null) return;
    void refreshLocalStatusForPicker({
      environmentId,
      input: { cwd: branchCwd },
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refs listed while the project was cloning are empty; reload them past the server's snapshot when the clone finishes
  useEffect(() => {
    if (projectCloneDone) refreshStaleRefs();
  }, [projectCloneDone]);
  // A checkout made outside T3 Code, such as a clone finishing, leaves refs listed before it.
  const statusBranch = branchStatusQuery.data?.refName ?? null;
  const refreshRefsMissingStatusBranch = useEffectEvent((branch: string | null) => {
    if (branch === null || branchCwd === null) return;
    // Kept until the checkout reports another branch, so every selector on it skips the refresh.
    const checkoutKey = pickerCheckoutKey(environmentId, branchCwd);
    if (pickerCheckouts.has(checkoutKey)) {
      const pickerBranch = pickerCheckouts.get(checkoutKey);
      if (pickerBranch === null || pickerBranch === branch) return;
      pickerCheckouts.delete(checkoutKey);
    }
    if (isInitialBranchesLoadPending) return;
    if (branchByName.get(branch)?.current !== true) refreshStaleRefs();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reloads refs from the server once per branch live status reports that they do not list as checked out
  useEffect(() => {
    refreshRefsMissingStatusBranch(statusBranch);
  }, [statusBranch]);

  // The server sets started threads' branches; defaulting here would detach the agent from its worktree.
  const threadStarted = serverSession !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes a default base branch to the server thread or draft once branches load for a new worktree thread
  useEffect(() => {
    if (
      threadStarted ||
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
    threadStarted,
    worktreeBaseBranchCandidate,
  ]);

  const handleOpenChange = (open: boolean) => {
    setIsBranchMenuOpen(open);
    if (open && !isBranchMenuOpen && branchCwd !== null) {
      void refreshLocalStatusForPicker({
        environmentId,
        input: { cwd: branchCwd },
      });
    }
    if (!open) {
      setFocusBranchSearch(false);
      setBranchQuery("");
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      open: () => {
        if (isInitialBranchesLoadPending || isBranchActionPending) return;
        setFocusBranchSearch(true);
        handleOpenChange(true);
      },
    }),
    [handleOpenChange, isBranchActionPending, isInitialBranchesLoadPending],
  );

  // Until git reports the ref, a placeholder holds the label's place so the
  // draft never flashes the "Select ref" prompt before its base ref, nor
  // "From main" before learning the base starts from origin/main.
  const isActiveBranchResolving =
    branchCwd !== null &&
    (resolvedActiveBranch === null
      ? isInitialBranchesLoadPending ||
        (branchStatusQuery.data === null && branchStatusQuery.error === null)
      : startFromOrigin &&
        effectiveEnvMode === "worktree" &&
        !activeWorktreePath &&
        resolvedActiveBranchIsRemote === null &&
        (isInitialBranchesLoadPending ||
          (activeBranchRefQuery.data === null && activeBranchRefQuery.error === null)));
  const triggerLabel = resolveBranchTriggerLabel(
    {
      activeWorktreePath,
      effectiveEnvMode,
      resolvedActiveBranch,
      resolvedActiveBranchIsRemote,
      startFromOrigin,
    },
    messages,
  );

  const branchPrBranch = resolveBranchToolbarPrBranch({
    activeThreadBranch,
    resolvedActiveBranch,
  });
  const branchPr = resolveDisplayedThreadPr({
    threadBranch: branchPrBranch,
    gitStatus: branchStatusQuery.data,
  });
  const openPrLink = useOpenPrLink(threadRef);
  const linkedIssues = serverThread?.issues ?? [];

  function selectPickerItem(itemValue: string) {
    if (isInitialBranchesLoadPending || isBranchActionPending) return;
    if (itemValue === checkoutPullRequestItemValue && prReference && onCheckoutPullRequestRequest) {
      beginBranchPick();
      handleOpenChange(false);
      onComposerFocusRequest?.();
      onCheckoutPullRequestRequest(prReference);
    } else if (
      canChangeThreadBranch &&
      pullRequestByItemValue.has(itemValue) &&
      onCheckoutPullRequestRequest
    ) {
      const pullRequest = pullRequestByItemValue.get(itemValue)!;
      handleOpenChange(false);
      onComposerFocusRequest?.();
      onCheckoutPullRequestRequest(pullRequest.url);
    } else if (itemValue === createBranchItemValue) {
      createRef(trimmedBranchQuery);
    } else {
      const refName = branchByName.get(itemValue);
      if (refName) void selectBranch(refName);
    }
  }

  function renderPickerItem(itemValue: string, index: number) {
    if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          onClick={() => selectPickerItem(itemValue)}
        >
          <div className="flex min-w-0 items-center gap-2 py-1">
            <SourceControlIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col items-start">
              <span className="truncate font-medium">
                {gt(
                  "Checkout {term, select, mr {merge request} cr {change request} other {pull request}}",
                  { term: changeRequestTermKind(sourceControlPresentation.terminology) },
                )}
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
          onClick={() => selectPickerItem(itemValue)}
        >
          <span className="truncate">
            <T>
              Create new ref &quot;<Var>{newRefName}</Var>&quot;
            </T>
          </span>
        </ComboboxItem>
      );
    }

    const pullRequest = pullRequestByItemValue.get(itemValue);
    if (pullRequest) {
      const groupLabel = pickerGroupLabels.get(itemValue);
      return (
        <div key={itemValue}>
          {groupLabel ? <BranchPickerGroupLabel>{groupLabel}</BranchPickerGroupLabel> : null}
          <ComboboxItem
            hideIndicator
            index={index}
            value={itemValue}
            onClick={() => selectPickerItem(itemValue)}
          >
            <div className="flex w-full min-w-0 items-center gap-2">
              <SourceControlIcon
                aria-hidden
                className="size-3.5 shrink-0 text-success-foreground"
              />
              <span className="min-w-0 flex-1 truncate">
                #{pullRequest.number} {pullRequest.title}
              </span>
              <span
                role="button"
                tabIndex={-1}
                aria-label={gt("Open #{number}", { number: pullRequest.number })}
                className="grid size-5 shrink-0 place-items-center rounded-row text-dim-foreground hover:text-foreground"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openPrLink(event, pullRequest.url);
                }}
              >
                <ExternalLinkIcon className="size-3.5" />
              </span>
            </div>
          </ComboboxItem>
        </div>
      );
    }

    const refName = branchByName.get(itemValue);
    if (!refName) return null;

    return (
      <BranchPickerRefItem
        branch={refName}
        projectCwd={activeProjectCwd}
        index={index}
        value={itemValue}
        selected={itemValue === resolvedActiveBranch}
        groupLabel={pickerGroupLabels.get(itemValue) ?? null}
        disabled={
          !canUpdateThreadBranch ||
          (!canWriteSourceControl &&
            !isSelectingWorktreeBase &&
            (!activeProjectCwd ||
              !resolveBranchSelectionTarget({
                activeProjectCwd,
                activeProjectCheckoutRoot,
                activeWorktreePath,
                refName,
              }).reuseExistingWorktree)) ||
          isWorktreeChangeBlockedForRef(refName)
        }
        onClick={() => selectPickerItem(itemValue)}
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
      onSelectItem={selectPickerItem}
      value={resolvedActiveBranch}
      query={branchQuery}
      onQueryChange={setBranchQuery}
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      onLoadNext={branchRefState.loadNext}
      statusText={branchStatusText}
      notice={
        refs.some((refName) => isWorktreeChangeBlockedForRef(refName))
          ? messages(WORKTREE_CHANGE_BLOCKED_MESSAGE)
          : null
      }
      renderItem={renderPickerItem}
      getItemType={(item) =>
        item === checkoutPullRequestItemValue
          ? "checkout-pull-request"
          : item === createBranchItemValue
            ? "create-branch"
            : pickerGroupLabels.has(item)
              ? "row-with-label"
              : "row"
      }
      originControl={
        isSelectingWorktreeBase
          ? { checked: startFromOrigin, onCheckedChange: onStartFromOriginChange }
          : undefined
      }
      renderPopup={
        displayMode === "toolbar" && renderWorkspaceMenu
          ? (children) =>
              renderWorkspaceMenu({
                label: isActiveBranchResolving ? gt("Loading ref…") : triggerLabel,
                disabled: isBranchActionPending,
                open: isBranchMenuOpen,
                focusSearch: focusBranchSearch,
                onOpenChange: handleOpenChange,
                children,
                onContextMenu: (event) => handleBranchContextMenu(event, resolvedActiveBranch),
              })
          : undefined
      }
      popupProps={{
        ...(displayMode === "toolbar"
          ? {
              anchor: () =>
                toolbarAnchorRef.current?.closest<HTMLElement>('[data-slot="composer-shell"]') ??
                toolbarAnchorRef.current,
            }
          : {}),
        align: "start",
        side: displayMode === "panel" ? "right" : "top",
        className: cn(
          "flex flex-col",
          displayMode === "panel" ? "w-(--anchor-width)" : "min-w-0 w-90",
        ),
        ...(displayMode === "toolbar" ? composerFloatingLayerProps : {}),
      }}
    >
      <div
        ref={toolbarAnchorRef}
        className={cn(
          displayMode === "toolbar" && renderWorkspaceMenu ? "hidden" : "flex min-w-0",
          displayMode === "panel" ? "w-full flex-col items-stretch" : "items-center gap-1",
          className,
        )}
      >
        <span
          className="flex min-w-0"
          onMouseDownCapture={(event) => {
            if (event.button !== 0 || event.ctrlKey) {
              event.stopPropagation();
            }
          }}
          onContextMenu={(event) => handleBranchContextMenu(event, resolvedActiveBranch)}
        >
          {displayMode === "toolbar" && renderWorkspaceMenu ? null : (
            <ComboboxTrigger
              render={
                displayMode === "panel" ? (
                  <ThreadDetailsControl part="row" />
                ) : (
                  <ComposerControl size="xs" />
                )
              }
              className="min-w-0 max-w-full active:scale-100"
              disabled={isInitialBranchesLoadPending || isBranchActionPending}
              // NVDA browse mode re-reads a combobox when its attributes change, not when its text does.
              aria-label={gt("Branch: {branch}", { branch: triggerLabel })}
            >
              <GitBranchIcon
                className={cn(
                  "size-3 shrink-0",
                  displayMode === "panel" && THREAD_DETAILS_PANEL_ICON_CLASS,
                )}
              />
              <ComposerContextLabel displayMode={displayMode} compact="truncate">
                {isActiveBranchResolving ? (
                  <Skeleton className="h-3 w-24" />
                ) : (
                  <MiddleTruncate
                    value={triggerLabel}
                    variant="cap-aligned"
                    className="w-full"
                    aria-hidden
                  />
                )}
              </ComposerContextLabel>
              {displayMode === "toolbar" ? (
                <ChevronDownIcon
                  aria-hidden
                  data-composer-chevron
                  className="size-2.5 shrink-0 text-muted-foreground"
                />
              ) : null}
            </ComboboxTrigger>
          )}
        </span>
        {displayMode === "panel" && prRowsContainer !== null
          ? portalTo(
              prRowsContainer,
              <>
                <ThreadDetailsThreadPrRows
                  threadRef={threadRef}
                  project={activeProject}
                  branchPr={branchPr}
                  branchSourceControlProvider={branchStatusQuery.data?.sourceControlProvider}
                  onActed={() => branchStatusQuery.refresh()}
                />
                <ThreadDetailsIssueRows links={linkedIssues} threadRef={threadRef} />
              </>,
            )
          : null}
      </div>
    </BranchPicker>
  );
}
