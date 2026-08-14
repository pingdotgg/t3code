import {
  ArchiveIcon,
  ArrowUpDownIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudIcon,
  FolderIcon,
  FolderPlusIcon,
  GitPullRequestIcon,
  Globe2Icon,
  MoreHorizontalIcon,
  PinIcon,
  SettingsIcon,
  SquarePenIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import {
  prStatusIndicator,
  ThreadBrowserOpenStatus,
  ThreadStatusLabel,
} from "./ThreadStatusIndicators";
import { ThreadDetailsTooltip } from "./SidebarV2ThreadTooltip";
import { ProjectFavicon } from "./ProjectFavicon";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { autoAnimate } from "@formkit/auto-animate";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  memo,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  type ContextMenuItem,
  type DesktopUpdateState,
  type OrchestrationThreadActivity,
  ProjectId,
  type ScopedThreadRef,
  type SidebarProjectGroupingMode,
  type ThreadEnvMode,
  ThreadId,
} from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import {
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
} from "@t3tools/contracts/settings";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { isElectron } from "../env";
import { isTerminalFocused } from "../lib/terminalFocus";
import { cn, isMacPlatform, newCommandId, newDraftId, newThreadId } from "../lib/utils";
import { TITLEBAR_ROW_CLASS, TITLEBAR_TRAFFIC_LIGHT_INSET_CLASS } from "../lib/titlebar";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsForProjectRefs,
  selectSidebarThreadsAcrossEnvironments,
  selectThreadByRef,
  useStore,
} from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadDiscoveredPorts } from "../portDiscoveryState";
import { createThreadExpandedOverridesSelector, useUiStateStore } from "../uiStateStore";
import { isPendingTurnActive, usePendingTurnStore } from "../pendingTurnStore";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useModelPickerOpen } from "../modelPickerOpenState";
import { useShortcutModifierState } from "../shortcutModifierState";
import { openPullRequestLink } from "../lib/openPullRequestLink";
import { readLocalApi } from "../localApi";
import {
  composerDraftHasUserContent,
  DraftId,
  type DraftSessionState,
  type DraftThreadEnvMode,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { isThreadActivelyWorking } from "../session-logic";

import { useThreadActions } from "../hooks/useThreadActions";
import {
  buildThreadRouteParams,
  clearAgentRunRouteSearch,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { ProjectGroupingDialog, ProjectRenameDialog } from "./sidebar/ProjectDialogs";
import { PROJECT_GROUPING_MODE_LABELS } from "./sidebar/projectGroupingLabels";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useCommandPaletteStore } from "../commandPaletteStore";
import {
  resolveAdjacentThreadId,
  isContextMenuPointerDown,
  resolveFilteredSidebarProjects,
  resolveProjectExpanded,
  resolveSidebarThreadRowStatus,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarDraftPreview,
  shouldRenderSidebarDraft,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  useThreadJumpHintVisibility,
  ThreadStatusPill,
} from "./Sidebar.logic";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { SidebarTopActions } from "./SidebarTopActions";
import { readEnvironmentApi } from "../environmentApi";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "../rpc/serverState";
import {
  derivePhysicalProjectKey,
  deriveProjectGroupingOverrideKey,
  getProjectOrderKey,
} from "../logicalProject";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import type { SidebarThreadSummary } from "../types";
import { openDiscoveredPort } from "./preview/openDiscoveredPort";
import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import {
  agentRunDismissKey,
  deriveSidebarThreadsWithAgentRuns,
  buildSidebarThreadRows,
  selectVisibleSidebarThreads,
  selectVisibleThreadRows,
  type SidebarThreadRowView,
} from "../sidebarThreadTree";
import { compactSidebarTimeLabel } from "./SidebarV2.logic";
import { SidebarHoverThreadPrewarmer } from "./SidebarThreadPrewarmer";
const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 80,
  easing: "ease-out",
} as const;
const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();

/**
 * Sidebar popup menus must match sidebar row typography. `MenuItem`'s defaults
 * include `sm:` variants, which tailwind-merge cannot strip with unprefixed
 * utilities, so the breakpoint size has to be restated. Icons carry an explicit
 * size for the same reason: it stops the default `:not([class*='size-'])` rule
 * from matching at all, rather than relying on specificity ties.
 */
const SIDEBAR_MENU_ITEM_CLASS =
  "min-h-7 gap-2 text-[length:var(--app-sidebar-font-size)] sm:min-h-7 sm:text-[length:var(--app-sidebar-font-size)]";
const SIDEBAR_MENU_ICON_CLASS = "size-3.5";

/** Root threads mounted per project before the tail sentinel grows the window. */
const SIDEBAR_THREAD_WINDOW_SIZE = 30;

/**
 * Zero-height tail marker that grows the thread window once it scrolls near the
 * viewport. Remounted on every growth so a sentinel that is still visible keeps
 * filling the list.
 */
const SidebarThreadWindowSentinel = memo(function SidebarThreadWindowSentinel({
  onReveal,
}: {
  onReveal: () => void;
}) {
  const [sentinel, setSentinel] = useState<HTMLLIElement | null>(null);

  useEffect(() => {
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onReveal();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [onReveal, sentinel]);

  return (
    <SidebarMenuSubItem
      ref={setSentinel}
      aria-hidden
      className="h-2 w-full"
      data-thread-selection-safe
    />
  );
});
const EMPTY_THREAD_ACTIVITIES: readonly OrchestrationThreadActivity[] = [];
type ContextMenuPosition = { x: number; y: number };

function resolveContextMenuPosition(event: React.MouseEvent): ContextMenuPosition | undefined {
  if (window.desktopBridge) {
    return undefined;
  }

  return {
    x: event.clientX,
    y: event.clientY,
  };
}

function formatProjectMemberActionLabel(
  member: SidebarProjectGroupMember,
  groupedProjectCount: number,
): string {
  if (groupedProjectCount <= 1) {
    return member.name;
  }

  return member.environmentLabel ? `${member.environmentLabel} — ${member.cwd}` : member.cwd;
}

function buildThreadJumpLabelMap(input: {
  keybindings: ReturnType<typeof useServerKeybindings>;
  platform: string;
  terminalOpen: boolean;
  threadJumpCommandByKey: ReadonlyMap<
    string,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >;
}): ReadonlyMap<string, string> {
  if (input.threadJumpCommandByKey.size === 0) {
    return EMPTY_THREAD_JUMP_LABELS;
  }

  const shortcutLabelOptions = {
    platform: input.platform,
    context: {
      terminalFocus: false,
      terminalOpen: input.terminalOpen,
    },
  } as const;
  const mapping = new Map<string, string>();
  for (const [threadKey, command] of input.threadJumpCommandByKey) {
    const label = shortcutLabelForCommand(input.keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(threadKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_THREAD_JUMP_LABELS;
}

interface SidebarThreadRowProps {
  thread: SidebarThreadSummary;
  threadStatus: ThreadStatusPill | null;
  isRemoteThread: boolean;
  threadEnvironmentLabel: string | null;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  childCount: number;
  projectCwd: string | null;
  threadProjectCwd: string | null;
  threadProjectName: string | null;
  orderedProjectThreadKeys: readonly string[];
  isActive: boolean;
  jumpLabel: string | null;
  appSettingsConfirmThreadArchive: boolean;
  isPinned: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedProjectThreadKeys: readonly string[],
  ) => void;
  handleParentThreadSelected: (threadKey: string, hasChildren: boolean) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  handleMultiSelectContextMenu: (position?: ContextMenuPosition) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position?: ContextMenuPosition,
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
  dismissAgentRun: (parentThreadId: ThreadId, taskId: string) => void;
  setThreadPinned: (projectKey: string, threadKey: string, pinned: boolean) => void;
  toggleThreadExpanded: (threadKey: string, isExpanded: boolean) => void;
  openPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
  projectKey: string;
  sortable?: {
    attributes: ReturnType<typeof useSortable>["attributes"];
    isDragging: boolean;
    isOver: boolean;
    listeners: ReturnType<typeof useSortable>["listeners"];
    setNodeRef: ReturnType<typeof useSortable>["setNodeRef"];
    style: React.CSSProperties;
  };
}

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    orderedProjectThreadKeys,
    isActive,
    jumpLabel,
    appSettingsConfirmThreadArchive,
    isPinned,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    handleThreadClick,
    handleParentThreadSelected,
    navigateToThread,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    setThreadPinned,
    toggleThreadExpanded,
    openPrLink,
    projectKey,
    sortable,
    thread,
    threadStatus,
    isRemoteThread,
    threadEnvironmentLabel,
    threadProjectCwd,
    threadProjectName,
    dismissAgentRun,
  } = props;
  const navigate = useNavigate();
  const virtualAgentRun = thread.virtualAgentRun;
  const threadRef = scopeThreadRef(
    thread.environmentId,
    virtualAgentRun?.parentThreadId ?? thread.id,
  );
  const threadKey = scopedThreadKey(threadRef);
  const pendingTurnKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const pendingTurn = usePendingTurnStore(
    (state) => state.pendingByThreadKey[pendingTurnKey] ?? null,
  );
  const effectiveThreadStatus = resolveSidebarThreadRowStatus({
    threadStatus,
    hasPendingTurn: isPendingTurnActive(pendingTurn, thread),
  });
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const discoveredPorts = useThreadDiscoveredPorts({
    environmentId: thread.environmentId,
    threadId: virtualAgentRun?.parentThreadId ?? thread.id,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const isHighlighted = isActive || isSelected;
  const projectName =
    threadProjectName ?? (props.projectCwd ? formatWorktreePathForDisplay(props.projectCwd) : null);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).runningTerminalIds,
  );
  const prStatus = prStatusIndicator(thread.pullRequest);
  const handleOpenDiscoveredPort = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const port = discoveredPorts[0];
      if (!port) return;
      event.preventDefault();
      event.stopPropagation();
      navigateToThread(threadRef);
      void (async () => {
        const result = await openDiscoveredPort({ threadRef, port, openPreview });
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open preview",
            description:
              error instanceof Error ? error.message : "The preview could not be opened.",
          }),
        );
      })();
    },
    [discoveredPorts, navigateToThread, openPreview, threadRef],
  );
  const isThreadRunning =
    effectiveThreadStatus?.label === "Working" ||
    virtualAgentRun?.status === "running" ||
    isThreadActivelyWorking(thread.latestTurn, thread.session);
  const isConfirmingArchive = confirmingArchiveThreadKey === threadKey && !isThreadRunning;
  const threadTimeClassName = isHighlighted
    ? "text-foreground/72 dark:text-foreground/82"
    : "text-muted-foreground/50";
  const clearConfirmingArchive = useCallback(() => {
    setConfirmingArchiveThreadKey((current) => (current === threadKey ? null : current));
  }, [setConfirmingArchiveThreadKey, threadKey]);
  const handleMouseLeave = useCallback(() => {
    clearConfirmingArchive();
  }, [clearConfirmingArchive]);
  const handleBlurCapture = useCallback(
    (event: React.FocusEvent<HTMLLIElement>) => {
      const currentTarget = event.currentTarget;
      requestAnimationFrame(() => {
        if (currentTarget.contains(document.activeElement)) {
          return;
        }
        clearConfirmingArchive();
      });
    },
    [clearConfirmingArchive],
  );
  const handleRowClick = useCallback(
    (event: React.MouseEvent) => {
      if (virtualAgentRun) {
        event.preventDefault();
        clearSelection();
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
          search: (previous) => ({ ...previous, agent: virtualAgentRun.taskId }),
        });
        return;
      }
      const isMac = isMacPlatform(navigator.platform);
      const isModKey = isMac ? event.metaKey : event.ctrlKey;

      if (event.shiftKey && !isModKey) {
        event.preventDefault();
        event.stopPropagation();
        setThreadPinned(projectKey, threadKey, !isPinned);
        return;
      }

      handleParentThreadSelected(threadKey, props.hasChildren);
      handleThreadClick(event, threadRef, orderedProjectThreadKeys);
    },
    [
      handleThreadClick,
      handleParentThreadSelected,
      clearSelection,
      isPinned,
      navigate,
      orderedProjectThreadKeys,
      projectKey,
      setThreadPinned,
      threadKey,
      threadRef,
      virtualAgentRun,
    ],
  );
  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // The row surface hosts its own controls (actions menu, expand chevron,
      // port button); only activate the row when it is the keyboard target.
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (virtualAgentRun) {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
          search: (previous) => ({ ...previous, agent: virtualAgentRun.taskId }),
        });
        return;
      }
      navigateToThread(threadRef);
    },
    [navigate, navigateToThread, threadRef, virtualAgentRun],
  );
  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      if (virtualAgentRun) {
        if (virtualAgentRun.status === "running") return;
        const api = readLocalApi();
        if (!api) return;
        void api.contextMenu
          .show([{ id: "archive", label: "Archive" }], resolveContextMenuPosition(event))
          .then((clicked) => {
            if (clicked === "archive") {
              dismissAgentRun(virtualAgentRun.parentThreadId, virtualAgentRun.taskId);
            }
          });
        return;
      }
      const selectedThreadKeys = useThreadSelectionStore.getState().selectedThreadKeys;
      if (selectedThreadKeys.has(threadKey)) {
        void handleMultiSelectContextMenu(resolveContextMenuPosition(event));
        return;
      }

      if (selectedThreadKeys.size > 0) {
        clearSelection();
      }
      void handleThreadContextMenu(threadRef, resolveContextMenuPosition(event));
    },
    [
      clearSelection,
      dismissAgentRun,
      handleMultiSelectContextMenu,
      handleThreadContextMenu,
      threadKey,
      threadRef,
      virtualAgentRun,
    ],
  );
  const handleRenameInputRef = useCallback(
    (element: HTMLInputElement | null) => {
      if (element && renamingInputRef.current !== element) {
        renamingInputRef.current = element;
        element.focus();
        element.select();
      }
    },
    [renamingInputRef],
  );
  const handleRenameInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setRenamingTitle(event.target.value);
    },
    [setRenamingTitle],
  );
  const handleRenameInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        void commitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        cancelRename();
      }
    },
    [cancelRename, commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef],
  );
  const handleRenameInputBlur = useCallback(() => {
    if (!renamingCommittedRef.current) {
      void commitRename(threadRef, renamingTitle, thread.title);
    }
  }, [commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef]);
  const handleRenameInputClick = useCallback((event: React.MouseEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);
  const handleConfirmArchiveRef = useCallback(
    (element: HTMLButtonElement | null) => {
      if (element) {
        confirmArchiveButtonRefs.current.set(threadKey, element);
      } else {
        confirmArchiveButtonRefs.current.delete(threadKey);
      }
    },
    [confirmArchiveButtonRefs, threadKey],
  );
  // Typed on HTMLElement so the same guard can sit on a wrapper as well as a
  // button. Only stops propagation: preventing default here would suppress the
  // press handling the wrapped control still needs.
  const stopPropagationOnPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    event.stopPropagation();
  }, []);
  const handleConfirmArchiveClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      clearConfirmingArchive();
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, clearConfirmingArchive, threadRef],
  );
  const handleArchiveSelected = useCallback(() => {
    if (appSettingsConfirmThreadArchive) {
      setConfirmingArchiveThreadKey(threadKey);
      requestAnimationFrame(() => {
        confirmArchiveButtonRefs.current.get(threadKey)?.focus();
      });
      return;
    }
    void attemptArchiveThread(threadRef);
  }, [
    appSettingsConfirmThreadArchive,
    attemptArchiveThread,
    confirmArchiveButtonRefs,
    setConfirmingArchiveThreadKey,
    threadKey,
    threadRef,
  ]);
  const handleDismissAgentRunSelected = useCallback(() => {
    if (!virtualAgentRun || virtualAgentRun.status === "running") return;
    dismissAgentRun(virtualAgentRun.parentThreadId, virtualAgentRun.taskId);
  }, [dismissAgentRun, virtualAgentRun]);
  const handleTogglePinnedSelected = useCallback(() => {
    setThreadPinned(projectKey, threadKey, !isPinned);
  }, [isPinned, projectKey, setThreadPinned, threadKey]);
  const handleOpenPrSelected = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (prStatus) {
        openPrLink(event, prStatus.url);
      }
    },
    [openPrLink, prStatus],
  );
  // The row surface is a role="button"; without this the menu trigger's click
  // would bubble up and open the thread behind the menu.
  const stopPropagationOnClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
  }, []);
  const handleToggleThreadExpandedClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      toggleThreadExpanded(threadKey, props.isExpanded);
    },
    [props.isExpanded, threadKey, toggleThreadExpanded],
  );
  const rowButtonRender = useMemo(() => <div role="button" tabIndex={0} />, []);
  const threadIndent = props.depth > 0 ? `${(props.depth * 18) / 11}em` : undefined;
  const canArchive = virtualAgentRun ? virtualAgentRun.status !== "running" : !isThreadRunning;

  // A running agent run can neither be pinned, opened as a PR, nor archived, so
  // its trigger would open an empty popup.
  const hasOverflowActions = !virtualAgentRun || prStatus !== null || canArchive;

  // One overflow control replaces the per-row pin/archive icon cluster; the
  // right-click menu still carries the long tail (rename, copy, delete).
  const overflowMenu = !hasOverflowActions ? null : (
    <Menu>
      <MenuTrigger
        aria-label={`Actions for ${thread.title}`}
        data-thread-selection-safe
        data-testid={`thread-actions-${thread.id}`}
        className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 outline-hidden transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={stopPropagationOnClick}
      >
        <MoreHorizontalIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-40">
        {virtualAgentRun ? null : (
          <MenuItem className={SIDEBAR_MENU_ITEM_CLASS} onClick={handleTogglePinnedSelected}>
            <PinIcon className={`${SIDEBAR_MENU_ICON_CLASS}${isPinned ? " fill-current" : ""}`} />
            {isPinned ? "Unpin" : "Pin"}
          </MenuItem>
        )}
        {prStatus ? (
          <MenuItem className={SIDEBAR_MENU_ITEM_CLASS} onClick={handleOpenPrSelected}>
            <GitPullRequestIcon className={SIDEBAR_MENU_ICON_CLASS} />
            Open pull request #{prStatus.number}
          </MenuItem>
        ) : null}
        {canArchive ? (
          <MenuItem
            className={SIDEBAR_MENU_ITEM_CLASS}
            data-testid={`thread-archive-${thread.id}`}
            onClick={virtualAgentRun ? handleDismissAgentRunSelected : handleArchiveSelected}
          >
            <ArchiveIcon className={SIDEBAR_MENU_ICON_CLASS} />
            {virtualAgentRun ? "Archive run" : "Archive"}
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );

  return (
    <SidebarMenuSubItem
      ref={sortable?.setNodeRef}
      style={sortable?.style}
      className={`w-full [contain-intrinsic-size:auto_1.75rem] [content-visibility:auto] ${
        sortable?.isDragging ? "z-20 opacity-80" : ""
      } ${sortable?.isOver && !sortable.isDragging ? "rounded-md ring-1 ring-primary/40" : ""}`}
      data-thread-item
      data-thread-prewarm-key={threadKey}
      onMouseLeave={handleMouseLeave}
      onBlurCapture={handleBlurCapture}
      {...sortable?.attributes}
      {...sortable?.listeners}
    >
      <SidebarMenuSubButton
        render={rowButtonRender}
        size="sm"
        isActive={isActive}
        data-testid={`thread-row-${thread.id}`}
        className={`${resolveThreadRowClassName({
          isActive,
          isSelected,
        })} relative isolate h-[var(--app-sidebar-legacy-row-height)] px-[var(--app-sidebar-legacy-row-padding-x)]`}
        onClick={handleRowClick}
        onKeyDown={handleRowKeyDown}
        onContextMenu={handleRowContextMenu}
      >
        <span
          className="flex min-w-0 flex-1 items-center gap-[var(--app-sidebar-row-inline-gap)] text-left leading-tight"
          style={threadIndent ? { paddingLeft: threadIndent } : undefined}
        >
          {/* Every row reserves the same leading slot so titles share one left
              edge whether or not the thread currently has a status. */}
          {effectiveThreadStatus ? (
            <ThreadStatusLabel status={effectiveThreadStatus} compact />
          ) : (
            <span aria-hidden="true" className="size-3.5 shrink-0" />
          )}
          {renamingThreadKey === threadKey ? (
            <input
              ref={handleRenameInputRef}
              aria-label={`Rename ${thread.title}`}
              className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 outline-none"
              style={{ fontSize: "var(--app-sidebar-font-size)" }}
              value={renamingTitle}
              onChange={handleRenameInputChange}
              onKeyDown={handleRenameInputKeyDown}
              onBlur={handleRenameInputBlur}
              onClick={handleRenameInputClick}
            />
          ) : (
            // Title + optional PR share one flex-1 slot so the #N mark sits
            // immediately after the truncated title instead of drifting to the
            // trailing icon cluster.
            <span className="flex min-w-0 flex-1 items-center gap-[var(--app-sidebar-row-line-gap)]">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      className="min-w-0 truncate font-medium text-foreground/90"
                      style={{ fontSize: "var(--app-sidebar-font-size)" }}
                      data-testid={`thread-title-${thread.id}`}
                    >
                      {thread.title}
                    </span>
                  }
                />
                {/* Project, worktree, PR and last-active moved off the row and
                    into this tooltip — the row keeps title and status only. */}
                <ThreadDetailsTooltip
                  environmentLabel={isRemoteThread ? (threadEnvironmentLabel ?? "Remote") : null}
                  projectCwd={threadProjectCwd ?? props.projectCwd ?? null}
                  projectName={projectName ?? "Unknown project"}
                  providerEntry={null}
                  terminalProcessCount={runningTerminalIds.length}
                  thread={thread}
                />
              </Tooltip>
              {prStatus ? (
                <>
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-muted-foreground/55"
                    style={{ fontSize: "var(--app-sidebar-font-size)" }}
                  >
                    ·
                  </span>
                  <button
                    type="button"
                    data-thread-selection-safe
                    data-testid={`thread-pr-link-${thread.id}`}
                    aria-label={prStatus.tooltip}
                    title={prStatus.tooltip}
                    className={cn(
                      "shrink-0 cursor-pointer font-mono tabular-nums outline-hidden transition-colors hover:underline focus-visible:ring-1 focus-visible:ring-ring",
                      prStatus.colorClass,
                    )}
                    style={{ fontSize: "var(--app-sidebar-font-size)" }}
                    // Pinned rows put dnd-kit listeners on the parent <li>; without
                    // this guard a slight move while clicking starts a drag.
                    onPointerDown={stopPropagationOnPointerDown}
                    onClick={handleOpenPrSelected}
                  >
                    #{prStatus.number}
                  </button>
                </>
              ) : null}
            </span>
          )}
          {discoveredPorts.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    data-thread-selection-safe
                    aria-label={`Open localhost:${discoveredPorts[0]?.port ?? ""}`}
                    className="inline-flex cursor-pointer items-center justify-center text-emerald-600 outline-hidden focus-visible:ring-1 focus-visible:ring-ring dark:text-emerald-400"
                    onClick={handleOpenDiscoveredPort}
                  />
                }
              >
                <Globe2Icon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                Open localhost:{discoveredPorts[0]?.port}
                {discoveredPorts.length > 1 ? ` (+${discoveredPorts.length - 1})` : ""}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <ThreadBrowserOpenStatus environmentId={thread.environmentId} threadId={thread.id} />
          {props.hasChildren ? (
            <button
              type="button"
              data-thread-selection-safe
              aria-expanded={props.isExpanded}
              aria-label={`${props.isExpanded ? "Collapse" : "Expand"} ${thread.title}`}
              title={`${props.isExpanded ? "Collapse" : "Expand"} ${props.childCount} nested chat${
                props.childCount === 1 ? "" : "s"
              }`}
              // Collapsed rows keep the chevron out of the resting composition
              // but never out of the layout, so revealing it cannot shift the
              // title. Expanded rows always show it: it is the only marker of
              // that state.
              className={`inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/60 transition-colors transition-opacity duration-150 hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${
                props.isExpanded
                  ? ""
                  : "opacity-0 group-focus-within/menu-sub-item:opacity-100 group-hover/menu-sub-item:opacity-100 max-sm:opacity-100"
              }`}
              onPointerDown={stopPropagationOnPointerDown}
              onClick={handleToggleThreadExpandedClick}
            >
              <ChevronRightIcon
                className={`size-3 transition-transform duration-150 ${
                  props.isExpanded ? "rotate-90" : ""
                }`}
              />
            </button>
          ) : null}
        </span>
        {/* One right-hand slot on a single row. The time is always legible —
            that is what makes the list scannable at rest — and the actions
            reserve their space permanently (`opacity-0`, not conditional
            rendering) so revealing them on hover cannot reflow the row.
            Opacity rather than `invisible`/`hidden`: the trigger has to stay
            focusable for keyboard users. */}
        <span className="ml-auto flex h-5 shrink-0 items-center gap-1">
          {isConfirmingArchive ? (
            <button
              ref={handleConfirmArchiveRef}
              type="button"
              data-thread-selection-safe
              data-testid={`thread-archive-confirm-${thread.id}`}
              aria-label={`Confirm archive ${thread.title}`}
              className="inline-flex h-5 cursor-pointer items-center rounded-full bg-destructive/12 px-2 text-[length:var(--app-sidebar-font-size)] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40"
              onPointerDown={stopPropagationOnPointerDown}
              onClick={handleConfirmArchiveClick}
            >
              Confirm
            </button>
          ) : (
            <>
              {jumpLabel ? (
                <span
                  className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/90 px-1.5 text-[length:var(--app-sidebar-meta-font-size)] font-medium tracking-tight text-foreground shadow-sm"
                  title={jumpLabel}
                >
                  {jumpLabel}
                </span>
              ) : null}
              {isPinned ? <PinIcon className="size-3 fill-current text-primary" /> : null}
              <span
                className={threadTimeClassName}
                style={{ fontSize: "var(--app-sidebar-meta-font-size)" }}
              >
                {compactSidebarTimeLabel(
                  formatRelativeTimeLabel(
                    thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                  ),
                )}
              </span>
              {overflowMenu ? (
                <span
                  // Pinned rows spread dnd-kit's drag listeners on the parent
                  // <li>, so an unguarded pointer-down here starts a drag on
                  // the slightest movement instead of opening the menu. The
                  // guard sits on the wrapper rather than the trigger because
                  // Base UI's MenuTrigger opens on pointer-down itself.
                  className="flex items-center opacity-0 transition-opacity duration-150 group-focus-within/menu-sub-item:opacity-100 group-hover/menu-sub-item:opacity-100 max-sm:opacity-100"
                  onPointerDown={stopPropagationOnPointerDown}
                >
                  {overflowMenu}
                </span>
              ) : null}
            </>
          )}
        </span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
});

interface SidebarProjectThreadListProps {
  projectKey: string;
  orderedProjectThreadKeys: readonly string[];
  pinnedThreadKeys: readonly string[];
  renderedThreadRows: readonly SidebarThreadRowView[];
  draftRows: readonly SidebarDraftRowData[];
  memberProjectByScopedKey: ReadonlyMap<string, SidebarProjectGroupMember>;
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
  projectCwd: string;
  primaryEnvironmentId: SidebarThreadSummary["environmentId"] | null;
  activeRouteThreadKey: string | null;
  routeDraftId: string | null;
  navigateToDraft: (draftId: DraftId) => void;
  clearDraftThread: (draftId: DraftId) => void;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedProjectThreadKeys: readonly string[],
  ) => void;
  handleParentThreadSelected: (threadKey: string, hasChildren: boolean) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  handleMultiSelectContextMenu: (position?: ContextMenuPosition) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position?: ContextMenuPosition,
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
  dismissAgentRun: (parentThreadId: ThreadId, taskId: string) => void;
  setThreadPinned: (projectKey: string, threadKey: string, pinned: boolean) => void;
  toggleThreadExpanded: (threadKey: string, isExpanded: boolean) => void;
  reorderPinnedThreads: (
    projectKey: string,
    draggedThreadKey: string,
    targetThreadKey: string,
  ) => void;
  openPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
  /**
   * Threads are indented to sit under their project header. With the header
   * hidden there is nothing to nest beneath, so the indent is dropped.
   */
  indented: boolean;
}

const SidebarProjectThreadList = memo(function SidebarProjectThreadList(
  props: SidebarProjectThreadListProps,
) {
  if (!props.shouldShowThreadPanel) {
    return null;
  }

  return <VisibleSidebarProjectThreadList {...props} />;
});

const VisibleSidebarProjectThreadList = memo(function VisibleSidebarProjectThreadList(
  props: SidebarProjectThreadListProps,
) {
  const {
    projectKey,
    indented,
    orderedProjectThreadKeys,
    pinnedThreadKeys,
    renderedThreadRows,
    draftRows,
    memberProjectByScopedKey,
    showEmptyThreadState,
    projectCwd,
    primaryEnvironmentId,
    activeRouteThreadKey,
    threadJumpLabelByKey,
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    handleThreadClick,
    handleParentThreadSelected,
    navigateToThread,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    dismissAgentRun,
    setThreadPinned,
    toggleThreadExpanded,
    reorderPinnedThreads,
    openPrLink,
  } = props;
  const activeAgentId = useLocation({
    select: (location) => {
      const search = location.search as Record<string, unknown>;
      return typeof search.agent === "string" ? search.agent : null;
    },
  });
  const pinnedThreadKeySet = useMemo(() => new Set(pinnedThreadKeys), [pinnedThreadKeys]);
  // `content-visibility` defers paint but not element creation, hooks, or store
  // subscriptions, so long projects still mount their whole history. Grow the
  // window as the tail scrolls into view instead: no extra click tier, but the
  // mounted row count stays proportional to what the user has actually reached.
  const [rootLimit, setRootLimit] = useState(SIDEBAR_THREAD_WINDOW_SIZE);
  const revealMoreThreadRows = useCallback(() => {
    setRootLimit((limit) => limit + SIDEBAR_THREAD_WINDOW_SIZE);
  }, []);
  const { rows: windowedThreadRows, hasOverflow: hasWindowedThreadOverflow } = useMemo(
    () =>
      selectVisibleThreadRows({
        rowViews: renderedThreadRows,
        rootLimit,
        requiredThreadKey: activeRouteThreadKey,
      }),
    [activeRouteThreadKey, renderedThreadRows, rootLimit],
  );
  const sortablePinnedThreadKeys = useMemo(
    () =>
      windowedThreadRows
        .filter((row) => row.depth === 0)
        .map((row) => row.threadKey)
        .filter((threadKey) => pinnedThreadKeySet.has(threadKey)),
    [pinnedThreadKeySet, windowedThreadRows],
  );

  const renderThreadRow = useCallback(
    (row: SidebarThreadRowView) => {
      const { thread, threadKey } = row;
      const threadProjectKey = scopedProjectKey(
        scopeProjectRef(thread.environmentId, thread.projectId),
      );
      const virtualAgentRun = thread.virtualAgentRun;
      const threadProject = memberProjectByScopedKey.get(threadProjectKey);
      const routeThreadKey = virtualAgentRun
        ? scopedThreadKey(scopeThreadRef(thread.environmentId, virtualAgentRun.parentThreadId))
        : threadKey;
      const rowProps: SidebarThreadRowProps = {
        thread,
        threadStatus: row.status,
        isRemoteThread:
          primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId,
        threadEnvironmentLabel: threadProject?.environmentLabel ?? null,
        depth: row.depth,
        hasChildren: row.hasChildren,
        isExpanded: row.isExpanded,
        childCount: row.childCount,
        projectCwd,
        threadProjectCwd: threadProject?.cwd ?? null,
        threadProjectName: threadProject?.name ?? null,
        orderedProjectThreadKeys,
        isActive:
          activeRouteThreadKey === routeThreadKey &&
          (virtualAgentRun ? activeAgentId === virtualAgentRun.taskId : !activeAgentId),
        jumpLabel: threadJumpLabelByKey.get(threadKey) ?? null,
        appSettingsConfirmThreadArchive,
        isPinned: row.depth === 0 && pinnedThreadKeySet.has(threadKey),
        renamingThreadKey,
        renamingTitle,
        setRenamingTitle,
        renamingInputRef,
        renamingCommittedRef,
        confirmingArchiveThreadKey,
        setConfirmingArchiveThreadKey,
        confirmArchiveButtonRefs,
        handleThreadClick,
        handleParentThreadSelected,
        navigateToThread,
        handleMultiSelectContextMenu,
        handleThreadContextMenu,
        clearSelection,
        commitRename,
        cancelRename,
        attemptArchiveThread,
        dismissAgentRun,
        setThreadPinned,
        toggleThreadExpanded,
        openPrLink,
        projectKey,
      };

      if (row.depth !== 0 || !pinnedThreadKeySet.has(threadKey)) {
        return <SidebarThreadRow key={threadKey} {...rowProps} />;
      }

      return <SortablePinnedThreadRow key={threadKey} threadKey={threadKey} {...rowProps} />;
    },
    [
      activeRouteThreadKey,
      activeAgentId,
      appSettingsConfirmThreadArchive,
      attemptArchiveThread,
      dismissAgentRun,
      cancelRename,
      clearSelection,
      commitRename,
      confirmArchiveButtonRefs,
      confirmingArchiveThreadKey,
      handleMultiSelectContextMenu,
      handleThreadClick,
      handleParentThreadSelected,
      handleThreadContextMenu,
      memberProjectByScopedKey,
      navigateToThread,
      openPrLink,
      orderedProjectThreadKeys,
      pinnedThreadKeySet,
      primaryEnvironmentId,
      projectCwd,
      projectKey,
      renamingCommittedRef,
      renamingInputRef,
      renamingThreadKey,
      renamingTitle,
      setConfirmingArchiveThreadKey,
      setRenamingTitle,
      setThreadPinned,
      toggleThreadExpanded,
      threadJumpLabelByKey,
    ],
  );

  const content = (
    <SidebarMenuSub
      className={`my-0 mx-0 w-full translate-x-0 gap-0.5 overflow-hidden border-l-0 py-0 ${
        // Half a project-chevron slot of indent: enough to read threads as
        // nested under the project, without pushing titles into the middle of
        // the sidebar the way a full icon-width inset did.
        indented ? "ps-3 pe-0" : "px-0"
      }`}
      style={{ animation: "none", transition: "none" }}
    >
      {draftRows.map((row) => (
        <SidebarDraftRow
          key={row.draftId}
          row={row}
          isActive={row.draftId === props.routeDraftId}
          onNavigate={props.navigateToDraft}
          onDiscard={props.clearDraftThread}
        />
      ))}
      {showEmptyThreadState && draftRows.length === 0 ? (
        <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
          <div
            data-thread-selection-safe
            className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[length:var(--app-sidebar-font-size)] text-muted-foreground/60"
          >
            <span>No threads yet</span>
          </div>
        </SidebarMenuSubItem>
      ) : null}
      {windowedThreadRows.map(renderThreadRow)}
      {hasWindowedThreadOverflow ? (
        <SidebarThreadWindowSentinel
          key={windowedThreadRows.length}
          onReveal={revealMoreThreadRows}
        />
      ) : null}
    </SidebarMenuSub>
  );

  if (sortablePinnedThreadKeys.length === 0) {
    return content;
  }

  return (
    <PinnedThreadDragContext
      projectKey={projectKey}
      sortablePinnedThreadKeys={sortablePinnedThreadKeys}
      reorderPinnedThreads={reorderPinnedThreads}
    >
      {content}
    </PinnedThreadDragContext>
  );
});

const PinnedThreadDragContext = memo(function PinnedThreadDragContext({
  children,
  projectKey,
  reorderPinnedThreads,
  sortablePinnedThreadKeys,
}: {
  children: React.ReactNode;
  projectKey: string;
  reorderPinnedThreads: (
    projectKey: string,
    draggedThreadKey: string,
    targetThreadKey: string,
  ) => void;
  sortablePinnedThreadKeys: readonly string[];
}) {
  const pinnedThreadDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const pinnedThreadCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);
  const handlePinnedThreadDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      reorderPinnedThreads(projectKey, String(active.id), String(over.id));
    },
    [projectKey, reorderPinnedThreads],
  );

  return (
    <DndContext
      sensors={pinnedThreadDnDSensors}
      collisionDetection={pinnedThreadCollisionDetection}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragEnd={handlePinnedThreadDragEnd}
    >
      <SortableContext items={[...sortablePinnedThreadKeys]} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
});

/**
 * Creates a thread in a project, seeded from the active thread's branch and
 * worktree. Grouped projects prompt for which member to use.
 *
 * Shared by the per-project header and the filtered sidebar's compose button so
 * the two entry points cannot drift apart.
 */
function useProjectThreadCreator(
  handleNewThread: ReturnType<typeof useNewThreadHandler>["handleNewThread"],
): (project: SidebarProjectSnapshot, event: React.MouseEvent<HTMLButtonElement>) => void {
  const defaultThreadEnvMode = useSettings<ThreadEnvMode>(
    (settings) => settings.defaultThreadEnvMode,
  );
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();

  const createThreadForProjectMember = useCallback(
    (member: SidebarProjectGroupMember) => {
      const currentRouteParams =
        router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const currentRouteTarget = resolveThreadRouteTarget(currentRouteParams);
      const currentActiveThread =
        currentRouteTarget?.kind === "server"
          ? (selectThreadByRef(useStore.getState(), currentRouteTarget.threadRef) ?? null)
          : null;
      const draftStore = useComposerDraftStore.getState();
      const currentActiveDraftThread =
        currentRouteTarget?.kind === "server"
          ? (draftStore.getDraftThread(currentRouteTarget.threadRef) ?? null)
          : currentRouteTarget?.kind === "draft"
            ? (draftStore.getDraftSession(currentRouteTarget.draftId) ?? null)
            : null;
      const seedContext = resolveSidebarNewThreadSeedContext({
        projectId: member.id,
        defaultEnvMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: defaultThreadEnvMode,
        }),
        activeThread:
          currentActiveThread && currentActiveThread.projectId === member.id
            ? {
                projectId: currentActiveThread.projectId,
                branch: currentActiveThread.branch,
                worktreePath: currentActiveThread.worktreePath,
              }
            : null,
        activeDraftThread:
          currentActiveDraftThread && currentActiveDraftThread.projectId === member.id
            ? {
                projectId: currentActiveDraftThread.projectId,
                branch: currentActiveDraftThread.branch,
                worktreePath: currentActiveDraftThread.worktreePath,
                envMode: currentActiveDraftThread.envMode,
              }
            : null,
      });
      if (isMobile) {
        setOpenMobile(false);
      }
      void handleNewThread(scopeProjectRef(member.environmentId, member.id), {
        ...(seedContext.branch !== undefined ? { branch: seedContext.branch } : {}),
        ...(seedContext.worktreePath !== undefined
          ? { worktreePath: seedContext.worktreePath }
          : {}),
        envMode: seedContext.envMode,
      });
    },
    [defaultThreadEnvMode, handleNewThread, isMobile, router, setOpenMobile],
  );

  return useCallback(
    (project: SidebarProjectSnapshot, event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      if (project.memberProjects.length === 1) {
        createThreadForProjectMember(project.memberProjects[0]!);
        return;
      }

      void (async () => {
        const api = readLocalApi();
        if (!api) {
          return;
        }
        const clicked = await api.contextMenu.show(
          project.memberProjects.map((member) => ({
            id: member.physicalProjectKey,
            label: formatProjectMemberActionLabel(member, project.groupedProjectCount),
          })),
          resolveContextMenuPosition(event),
        );
        if (!clicked) {
          return;
        }
        const targetMember = project.memberProjects.find(
          (member) => member.physicalProjectKey === clicked,
        );
        if (!targetMember) {
          return;
        }
        createThreadForProjectMember(targetMember);
      })();
    },
    [createThreadForProjectMember],
  );
}

interface SidebarProjectItemProps {
  project: SidebarProjectSnapshot;
  primaryEnvironmentId: SidebarThreadSummary["environmentId"] | null;
  activeRouteThreadKey: string | null;
  routeDraftId: string | null;
  navigateToDraft: (draftId: DraftId) => void;
  draftRows: readonly SidebarDraftRowData[];
  newThreadShortcutLabel: string | null;
  handleNewThread: ReturnType<typeof useNewThreadHandler>["handleNewThread"];
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  decoupleThread: ReturnType<typeof useThreadActions>["decoupleThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  handleParentThreadSelected: (threadKey: string, hasChildren: boolean) => void;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  dragInProgressRef: React.RefObject<boolean>;
  suppressProjectClickAfterDragRef: React.RefObject<boolean>;
  suppressProjectClickForContextMenuRef: React.RefObject<boolean>;
  isManualProjectSorting: boolean;
  dragHandleProps: SortableProjectHandleProps | null;
  /**
   * Set when the sidebar is filtered to this single project: the header would
   * just repeat the project already named in the filter menu, so it is dropped
   * and its threads render flush instead of nested.
   */
  hideProjectHeader: boolean;
}

const SidebarProjectItem = memo(function SidebarProjectItem(props: SidebarProjectItemProps) {
  const {
    project,
    primaryEnvironmentId,
    hideProjectHeader,
    activeRouteThreadKey,
    routeDraftId,
    navigateToDraft,
    draftRows,
    newThreadShortcutLabel,
    handleNewThread,
    archiveThread,
    decoupleThread,
    deleteThread,
    handleParentThreadSelected,
    threadJumpLabelByKey,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    isManualProjectSorting,
    dragHandleProps,
  } = props;
  const threadSortOrder = useSettings<SidebarThreadSortOrder>(
    (settings) => settings.sidebarThreadSortOrder,
  );
  const appSettingsConfirmThreadDelete = useSettings<boolean>(
    (settings) => settings.confirmThreadDelete,
  );
  const appSettingsConfirmThreadArchive = useSettings<boolean>(
    (settings) => settings.confirmThreadArchive,
  );
  const projectGroupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));
  const { updateSettings } = useUpdateSettings();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const pinnedThreadKeys = useUiStateStore(
    useShallow((state) => state.pinnedThreadKeysByProjectId[project.projectKey] ?? []),
  );
  const setThreadPinned = useUiStateStore((state) => state.setThreadPinned);
  const setThreadExpanded = useUiStateStore((state) => state.setThreadExpanded);
  const reorderPinnedThreads = useUiStateStore((state) => state.reorderPinnedThreads);
  const toggleProject = useUiStateStore((state) => state.toggleProject);
  const toggleThreadSelection = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const removeFromSelection = useThreadSelectionStore((state) => state.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const sidebarThreads = useStore(
    useShallow(
      useMemo(
        () => (state: import("../store").AppState) =>
          selectSidebarThreadsForProjectRefs(state, project.memberProjectRefs),
        [project.memberProjectRefs],
      ),
    ),
  );
  const sidebarThreadByKey = useMemo(
    () =>
      new Map(
        sidebarThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [sidebarThreads],
  );
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  // Keep a ref so callbacks can read the latest map without appearing in
  // dependency arrays (avoids invalidating every thread-row memo on each
  // thread-list change).
  const sidebarThreadByKeyRef = useRef(sidebarThreadByKey);
  useLayoutEffect(() => {
    sidebarThreadByKeyRef.current = sidebarThreadByKey;
  }, [sidebarThreadByKey]);
  const sidebarThreadActivities = useStore(
    useShallow(
      useMemo(
        () => (state: import("../store").AppState) =>
          sidebarThreads.map(
            (thread) =>
              selectThreadByRef(state, scopeThreadRef(thread.environmentId, thread.id))
                ?.activities ?? EMPTY_THREAD_ACTIVITIES,
          ),
        [sidebarThreads],
      ),
    ),
  );
  const dismissedAgentRunKeys = useUiStateStore((state) => state.dismissedAgentRunKeys);
  const setAgentRunDismissed = useUiStateStore((state) => state.setAgentRunDismissed);
  const projectThreads = useMemo(
    () =>
      deriveSidebarThreadsWithAgentRuns({
        threads: sidebarThreads,
        threadActivities: sidebarThreadActivities,
        dismissedAgentRunKeys,
      }),
    [dismissedAgentRunKeys, sidebarThreadActivities, sidebarThreads],
  );
  const storedProjectExpanded = useUiStateStore(
    (state) => state.projectExpandedById[project.projectKey] ?? true,
  );
  const projectExpanded = resolveProjectExpanded({
    storedExpanded: storedProjectExpanded,
    hasHeader: !hideProjectHeader,
  });
  const threadLastVisitedAts = useUiStateStore(
    useShallow((state) =>
      projectThreads.map(
        (thread) =>
          state.threadLastVisitedAtById[
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
          ] ?? null,
      ),
    ),
  );
  const threadExpandedOverrides = useUiStateStore(
    useMemo(
      () =>
        createThreadExpandedOverridesSelector(
          projectThreads.map((thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          ),
        ),
      [projectThreads],
    ),
  );
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [confirmingArchiveThreadKey, setConfirmingArchiveThreadKey] = useState<string | null>(null);
  const [projectRenameTarget, setProjectRenameTarget] = useState<SidebarProjectGroupMember | null>(
    null,
  );
  const [projectRenameTitle, setProjectRenameTitle] = useState("");
  const [projectGroupingTarget, setProjectGroupingTarget] =
    useState<SidebarProjectGroupMember | null>(null);
  const [projectGroupingSelection, setProjectGroupingSelection] = useState<
    SidebarProjectGroupingMode | "inherit"
  >("inherit");
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const memberProjectByScopedKey = useMemo(
    () =>
      new Map(
        project.memberProjects.map((member) => [
          scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
          member,
        ]),
      ),
    [project.memberProjects],
  );
  const memberThreadCountByPhysicalKey = useMemo(() => {
    const counts = new Map<string, number>(
      project.memberProjects.map((member) => [member.physicalProjectKey, 0] as const),
    );
    for (const thread of projectThreads) {
      const member = memberProjectByScopedKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      if (!member) {
        continue;
      }
      counts.set(member.physicalProjectKey, (counts.get(member.physicalProjectKey) ?? 0) + 1);
    }
    return counts;
  }, [memberProjectByScopedKey, project.memberProjects, projectThreads]);

  const {
    projectStatus,
    visibleProjectThreads,
    visibleProjectThreadRows,
    threadStatusByKey,
    orderedProjectThreadKeys,
  } = useMemo(() => {
    const lastVisitedAtByThreadKey = new Map(
      projectThreads.map((thread, index) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        threadLastVisitedAts[index] ?? null,
      ]),
    );
    const resolveProjectThreadStatus = (thread: SidebarThreadSummary) => {
      const lastVisitedAt = lastVisitedAtByThreadKey.get(
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      );
      return resolveThreadStatusPill({
        thread,
        lastVisitedAt,
      });
    };
    const visibleProjectThreads = selectVisibleSidebarThreads(projectThreads);
    const threadRows = buildSidebarThreadRows({
      threads: visibleProjectThreads,
      pinnedThreadKeys,
      activeThreadKey: activeRouteThreadKey ?? undefined,
      expandedOverrideByThreadKey: threadExpandedOverrides,
      sortOrder: threadSortOrder,
      resolveThreadStatus: resolveProjectThreadStatus,
    });
    return {
      orderedProjectThreadKeys: threadRows.orderedThreadKeys,
      projectStatus: threadRows.projectStatus,
      visibleProjectThreads,
      visibleProjectThreadRows: threadRows.rowViews,
      threadStatusByKey: threadRows.statusByThreadKey,
    };
  }, [
    activeRouteThreadKey,
    threadExpandedOverrides,
    pinnedThreadKeys,
    projectThreads,
    threadExpandedOverrides,
    threadLastVisitedAts,
    threadSortOrder,
  ]);

  const pinnedCollapsedThread = useMemo(() => {
    const activeThreadKey = activeRouteThreadKey ?? undefined;
    if (!activeThreadKey || projectExpanded) {
      return null;
    }
    return (
      visibleProjectThreads.find(
        (thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === activeThreadKey,
      ) ?? null
    );
  }, [activeRouteThreadKey, projectExpanded, visibleProjectThreads]);

  // The project header is the only collapse tier: once it is open every thread
  // of that project is listed, so nothing hides behind a second "show more".
  const { renderedThreadRows, visibleDraftRows, showEmptyThreadState, shouldShowThreadPanel } =
    useMemo(() => {
      const pinnedCollapsedThreadKey = pinnedCollapsedThread
        ? scopedThreadKey(
            scopeThreadRef(pinnedCollapsedThread.environmentId, pinnedCollapsedThread.id),
          )
        : null;
      const renderedThreadRows =
        pinnedCollapsedThread && pinnedCollapsedThreadKey
          ? [
              {
                thread: pinnedCollapsedThread,
                threadKey: pinnedCollapsedThreadKey,
                depth: 0,
                hasChildren: false,
                isExpanded: false,
                childCount: 0,
                status: threadStatusByKey.get(pinnedCollapsedThreadKey) ?? null,
                rolledUpStatus: threadStatusByKey.get(pinnedCollapsedThreadKey) ?? null,
              } satisfies SidebarThreadRowView,
            ]
          : [...visibleProjectThreadRows];
      const activeDraftRow = routeDraftId
        ? draftRows.find((row) => row.draftId === routeDraftId)
        : undefined;
      const visibleDraftRows = projectExpanded ? draftRows : activeDraftRow ? [activeDraftRow] : [];
      return {
        renderedThreadRows,
        visibleDraftRows,
        showEmptyThreadState:
          projectExpanded && visibleProjectThreads.length === 0 && draftRows.length === 0,
        shouldShowThreadPanel:
          projectExpanded || pinnedCollapsedThread !== null || activeDraftRow !== undefined,
      };
    }, [
      draftRows,
      pinnedCollapsedThread,
      projectExpanded,
      routeDraftId,
      threadStatusByKey,
      visibleProjectThreads,
      visibleProjectThreadRows,
    ]);

  const handleProjectButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (suppressProjectClickForContextMenuRef.current) {
        suppressProjectClickForContextMenuRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      React.startTransition(() => {
        toggleProject(project.projectKey);
      });
    },
    [
      clearSelection,
      dragInProgressRef,
      project.projectKey,
      suppressProjectClickAfterDragRef,
      suppressProjectClickForContextMenuRef,
      toggleProject,
    ],
  );

  const handleProjectButtonKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      React.startTransition(() => {
        toggleProject(project.projectKey);
      });
    },
    [dragInProgressRef, project.projectKey, toggleProject],
  );

  const handleProjectButtonPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      suppressProjectClickForContextMenuRef.current = false;
      if (
        isContextMenuPointerDown({
          button: event.button,
          ctrlKey: event.ctrlKey,
          isMac: isMacPlatform(navigator.platform),
        })
      ) {
        event.stopPropagation();
      }

      suppressProjectClickAfterDragRef.current = false;
    },
    [suppressProjectClickAfterDragRef, suppressProjectClickForContextMenuRef],
  );

  const openProjectRenameDialog = useCallback((member: SidebarProjectGroupMember) => {
    setProjectRenameTarget(member);
    setProjectRenameTitle(member.name);
  }, []);

  const openProjectGroupingDialog = useCallback(
    (member: SidebarProjectGroupMember) => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      setProjectGroupingTarget(member);
      setProjectGroupingSelection(
        projectGroupingSettings.sidebarProjectGroupingOverrides?.[overrideKey] ?? "inherit",
      );
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides],
  );

  const removeProject = useCallback(
    async (member: SidebarProjectGroupMember, options: { force?: boolean } = {}): Promise<void> => {
      const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
      const projectApi = readEnvironmentApi(member.environmentId);
      if (!projectApi) {
        throw new Error("Project API unavailable.");
      }

      await projectApi.orchestration.dispatchCommand({
        type: "project.delete",
        commandId: newCommandId(),
        projectId: member.id,
        ...(options.force === true ? { force: true } : {}),
      });
      useComposerDraftStore.getState().clearProjectDraftThreadId(memberProjectRef);
    },
    [],
  );

  const handleRemoveProject = useCallback(
    async (member: SidebarProjectGroupMember) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }

      const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
      const memberThreadCount = memberThreadCountByPhysicalKey.get(member.physicalProjectKey) ?? 0;
      if (memberThreadCount > 0) {
        const warningToastId = toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Project is not empty",
            description: "Delete all threads in this project before removing it.",
            actionVariant: "destructive",
            actionProps: {
              children: "Delete anyway",
              onClick: () => {
                void (async () => {
                  toastManager.close(warningToastId);
                  await new Promise<void>((resolve) => {
                    window.setTimeout(resolve, 180);
                  });

                  const latestProjectThreads = selectSidebarThreadsForProjectRefs(
                    useStore.getState(),
                    [memberProjectRef],
                  );
                  const confirmed = await api.dialogs.confirm(
                    latestProjectThreads.length > 0
                      ? [
                          `Remove project "${member.name}" and delete its ${latestProjectThreads.length} thread${
                            latestProjectThreads.length === 1 ? "" : "s"
                          }?`,
                          `Path: ${member.cwd}`,
                          ...(member.environmentLabel
                            ? [`Environment: ${member.environmentLabel}`]
                            : []),
                          "This permanently clears conversation history for those threads.",
                          "This removes only this project entry.",
                          "This action cannot be undone.",
                        ].join("\n")
                      : [
                          `Remove project "${member.name}"?`,
                          `Path: ${member.cwd}`,
                          ...(member.environmentLabel
                            ? [`Environment: ${member.environmentLabel}`]
                            : []),
                          "This removes only this project entry.",
                        ].join("\n"),
                  );
                  if (!confirmed) {
                    return;
                  }

                  await removeProject(member, { force: true });
                })().catch((error) => {
                  const message =
                    error instanceof Error ? error.message : "Unknown error removing project.";
                  console.error("Failed to remove project", {
                    projectId: member.id,
                    environmentId: member.environmentId,
                    error,
                  });
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: `Failed to remove "${member.name}"`,
                      description: message,
                    }),
                  );
                });
              },
            },
          }),
        );
        return;
      }

      const message = [
        `Remove project "${member.name}"?`,
        `Path: ${member.cwd}`,
        ...(member.environmentLabel ? [`Environment: ${member.environmentLabel}`] : []),
        "This removes only this project entry.",
      ].join("\n");
      const confirmed = await api.dialogs.confirm(message);
      if (!confirmed) {
        return;
      }

      try {
        await removeProject(member);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing project.";
        console.error("Failed to remove project", {
          projectId: member.id,
          environmentId: member.environmentId,
          error,
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to remove "${member.name}"`,
            description: message,
          }),
        );
      }
    },
    [memberThreadCountByPhysicalKey, removeProject],
  );

  const handleProjectButtonContextMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      suppressProjectClickForContextMenuRef.current = true;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;

        const actionHandlers = new Map<string, () => Promise<void> | void>();
        const makeLeaf = (
          action: "rename" | "grouping" | "copy-path" | "delete",
          member: SidebarProjectGroupMember,
          options?: {
            destructive?: boolean;
            disabled?: boolean;
          },
        ): ContextMenuItem<string> => {
          const id = `${action}:${member.physicalProjectKey}`;
          actionHandlers.set(id, () => {
            switch (action) {
              case "rename":
                openProjectRenameDialog(member);
                return;
              case "grouping":
                openProjectGroupingDialog(member);
                return;
              case "copy-path":
                copyPathToClipboard(member.cwd, { path: member.cwd });
                return;
              case "delete":
                return handleRemoveProject(member);
            }
          });

          return {
            id,
            label: formatProjectMemberActionLabel(member, project.groupedProjectCount),
            ...(options?.destructive ? { destructive: true } : {}),
            ...(options?.disabled ? { disabled: true } : {}),
          };
        };

        const buildTargetedItem = (
          action: "rename" | "grouping" | "copy-path" | "delete",
          label: string,
          options?: {
            destructive?: boolean;
            isDisabled?: (member: SidebarProjectGroupMember) => boolean;
          },
        ): ContextMenuItem<string> => {
          if (project.memberProjects.length === 1) {
            const singleMember = project.memberProjects[0]!;
            return {
              ...makeLeaf(action, singleMember, {
                ...(options?.destructive ? { destructive: true } : {}),
                ...(options?.isDisabled?.(singleMember) ? { disabled: true } : {}),
              }),
              label,
            };
          }

          return {
            id: `${action}:submenu`,
            label,
            children: project.memberProjects.map((member) =>
              makeLeaf(action, member, {
                ...(options?.destructive ? { destructive: true } : {}),
                ...(options?.isDisabled?.(member) ? { disabled: true } : {}),
              }),
            ),
          };
        };

        const clicked = await api.contextMenu.show(
          [
            buildTargetedItem("rename", "Rename project"),
            buildTargetedItem("grouping", "Project grouping…"),
            buildTargetedItem("copy-path", "Copy Project Path"),
            buildTargetedItem("delete", "Remove project", {
              destructive: true,
            }),
          ],
          resolveContextMenuPosition(event),
        );

        if (!clicked) {
          return;
        }

        await actionHandlers.get(clicked)?.();
      })();
    },
    [
      copyPathToClipboard,
      handleRemoveProject,
      openProjectGroupingDialog,
      openProjectRenameDialog,
      project.groupedProjectCount,
      project.memberProjects,
      suppressProjectClickForContextMenuRef,
    ],
  );

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: clearAgentRunRouteSearch,
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );
  const toggleThreadExpanded = useCallback(
    (threadKey: string, isExpanded: boolean) => {
      setThreadExpanded(threadKey, !isExpanded);
    },
    [setThreadExpanded],
  );

  const handleThreadClick = useCallback(
    (
      event: React.MouseEvent,
      threadRef: ScopedThreadRef,
      orderedProjectThreadKeys: readonly string[],
    ) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;
      const threadKey = scopedThreadKey(threadRef);
      const currentSelectionCount = useThreadSelectionStore.getState().selectedThreadKeys.size;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadKey, orderedProjectThreadKeys);
        return;
      }

      if (currentSelectionCount > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadKey);
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: clearAgentRunRouteSearch,
      });
    },
    [
      clearSelection,
      isMobile,
      rangeSelectTo,
      router,
      setOpenMobile,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position?: ContextMenuPosition) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = sidebarThreadByKeyRef.current.get(threadKey);
          markThreadUnread(threadKey, thread?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }

      if (clicked !== "delete") return;

      if (appSettingsConfirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} thread${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const deletedThreadKeys = new Set(threadKeys);
      for (const threadKey of threadKeys) {
        const thread = sidebarThreadByKeyRef.current.get(threadKey);
        if (!thread) continue;
        await deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
          deletedThreadKeys,
        });
      }
      removeFromSelection(threadKeys);
    },
    [
      appSettingsConfirmThreadDelete,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
    ],
  );

  const createThreadForProject = useProjectThreadCreator(handleNewThread);
  const handleCreateThreadClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      createThreadForProject(project, event);
    },
    [createThreadForProject, project],
  );

  const attemptArchiveThread = useCallback(
    async (threadRef: ScopedThreadRef) => {
      try {
        await archiveThread(threadRef);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to archive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [archiveThread],
  );

  const dismissAgentRun = useCallback(
    (parentThreadId: ThreadId, taskId: string) => {
      setAgentRunDismissed(agentRunDismissKey(parentThreadId, taskId), true);
    },
    [setAgentRunDismissed],
  );

  const cancelRename = useCallback(() => {
    setRenamingThreadKey(null);
    renamingInputRef.current = null;
  }, []);

  const commitRename = useCallback(
    async (threadRef: ScopedThreadRef, newTitle: string, originalTitle: string) => {
      const threadKey = scopedThreadKey(threadRef);
      const finishRename = () => {
        if (renamingThreadKey === threadKey) {
          renamingInputRef.current = null;
          setRenamingThreadKey(null);
        }
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Thread title cannot be empty",
        });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: threadRef.threadId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      finishRename();
    },
    [renamingThreadKey],
  );

  const closeProjectRenameDialog = useCallback(() => {
    setProjectRenameTarget(null);
    setProjectRenameTitle("");
  }, []);

  const submitProjectRename = useCallback(async () => {
    if (!projectRenameTarget) {
      return;
    }

    const trimmed = projectRenameTitle.trim();
    if (trimmed.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Project title cannot be empty",
      });
      return;
    }

    if (trimmed === projectRenameTarget.name) {
      closeProjectRenameDialog();
      return;
    }

    const api = readEnvironmentApi(projectRenameTarget.environmentId);
    if (!api) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename project",
          description: "Project API unavailable.",
        }),
      );
      return;
    }

    try {
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: projectRenameTarget.id,
        title: trimmed,
      });
      closeProjectRenameDialog();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [closeProjectRenameDialog, projectRenameTarget, projectRenameTitle]);

  const closeProjectGroupingDialog = useCallback(() => {
    setProjectGroupingTarget(null);
    setProjectGroupingSelection("inherit");
  }, []);

  const saveProjectGroupingPreference = useCallback(() => {
    if (!projectGroupingTarget) {
      return;
    }

    const overrideKey = deriveProjectGroupingOverrideKey(projectGroupingTarget);
    const nextOverrides = {
      ...projectGroupingSettings.sidebarProjectGroupingOverrides,
    };
    if (projectGroupingSelection === "inherit") {
      delete nextOverrides[overrideKey];
    } else {
      nextOverrides[overrideKey] = projectGroupingSelection;
    }
    updateSettings({
      sidebarProjectGroupingOverrides: nextOverrides,
    });
    closeProjectGroupingDialog();
  }, [
    closeProjectGroupingDialog,
    projectGroupingSelection,
    projectGroupingSettings.sidebarProjectGroupingOverrides,
    projectGroupingTarget,
    updateSettings,
  ]);

  const createSubchatForThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      const sourceThread = selectThreadByRef(useStore.getState(), threadRef);
      if (!sourceThread) {
        return;
      }
      const draftStore = useComposerDraftStore.getState();
      const draftId = newDraftId();
      const envMode: DraftThreadEnvMode = sourceThread.worktreePath ? "worktree" : "local";
      draftStore.createDetachedDraftSession(
        scopeProjectRef(sourceThread.environmentId, sourceThread.projectId),
        draftId,
        {
          threadId: newThreadId(),
          parentThreadId: sourceThread.id,
          branch: sourceThread.branch,
          worktreePath: sourceThread.worktreePath,
          envMode,
        },
      );
      draftStore.applyStickyState(draftId);
      draftStore.setModelSelection(draftId, sourceThread.modelSelection);
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({ to: "/draft/$draftId", params: { draftId } });
    },
    [isMobile, router, setOpenMobile],
  );

  const handleThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position?: ContextMenuPosition) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKey = scopedThreadKey(threadRef);
      const thread = sidebarThreadByKeyRef.current.get(threadKey) ?? null;
      if (!thread) return;
      const threadProject = memberProjectByScopedKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      const threadWorkspacePath = thread.worktreePath ?? threadProject?.cwd ?? project.cwd ?? null;
      const clicked = await api.contextMenu.show(
        [
          { id: "new-subchat", label: "New subchat" },
          ...(thread.parentThreadId === null ? [] : [{ id: "decouple", label: "Decouple chat" }]),
          { id: "rename", label: "Rename thread" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          ...(isThreadActivelyWorking(thread.latestTurn, thread.session)
            ? []
            : [{ id: "archive", label: "Archive" }]),
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "new-subchat") {
        createSubchatForThread(threadRef);
        return;
      }

      if (clicked === "decouple") {
        try {
          await decoupleThread(threadRef);
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to decouple chat",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "rename") {
        setRenamingThreadKey(threadKey);
        setRenamingTitle(thread.title);
        renamingCommittedRef.current = false;
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadKey, thread.latestTurn?.completedAt);
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Path unavailable",
              description: "This thread does not have a workspace path to copy.",
            }),
          );
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(thread.id, { threadId: thread.id });
        return;
      }
      if (clicked === "archive") {
        await attemptArchiveThread(threadRef);
        return;
      }
      if (clicked !== "delete") return;
      if (appSettingsConfirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }
      await deleteThread(threadRef);
    },
    [
      appSettingsConfirmThreadDelete,
      attemptArchiveThread,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      createSubchatForThread,
      decoupleThread,
      deleteThread,
      markThreadUnread,
      memberProjectByScopedKey,
      project.cwd,
    ],
  );

  return (
    <>
      {hideProjectHeader ? null : (
        <div className="group/project-header relative">
          <SidebarMenuButton
            ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
            size="sm"
            className={`gap-2 px-2 py-1.5 pr-8 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground max-sm:pr-14 ${
              isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
            }`}
            {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
            {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
            onPointerDownCapture={handleProjectButtonPointerDownCapture}
            onClick={handleProjectButtonClick}
            onKeyDown={handleProjectButtonKeyDown}
            onContextMenu={handleProjectButtonContextMenu}
          >
            {!projectExpanded && projectStatus && !projectStatus.pulse ? (
              <span
                aria-hidden="true"
                title={projectStatus.label}
                className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
              >
                <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                  <span
                    className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                      projectStatus.pulse ? "animate-status-pulse" : ""
                    }`}
                  />
                </span>
                <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
              </span>
            ) : (
              <ChevronRightIcon
                className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                  projectExpanded ? "rotate-90" : ""
                }`}
              />
            )}
            <ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span
                className={`truncate font-medium ${
                  !projectExpanded && projectStatus?.pulse
                    ? "project-title-shimmer"
                    : "text-foreground/90"
                }`}
                title={!projectExpanded && projectStatus?.pulse ? projectStatus.label : undefined}
                style={{ fontSize: "var(--app-sidebar-font-size)" }}
              >
                {project.displayName}
              </span>
              {project.groupedProjectCount > 1 ? (
                <span className="shrink-0 text-[length:var(--app-sidebar-font-size)] text-muted-foreground/60">
                  {project.groupedProjectCount} projects
                </span>
              ) : null}
            </span>
          </SidebarMenuButton>
          {/* Environment badge – visible by default, crossfades with the
            "new thread" button on hover using the same pointer-events +
            opacity pattern as the thread row archive/timestamp swap. */}
          {project.environmentPresence === "remote-only" && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-label={
                      project.environmentPresence === "remote-only"
                        ? "Remote project"
                        : "Available in multiple environments"
                    }
                    className="pointer-events-none absolute top-1 right-1.5 inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/60 transition-opacity duration-150 max-sm:right-7 group-hover/project-header:opacity-0 group-focus-within/project-header:opacity-0 max-sm:group-hover/project-header:opacity-100 max-sm:group-focus-within/project-header:opacity-100"
                  />
                }
              >
                <CloudIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                Remote environment: {project.remoteEnvironmentLabels.join(", ")}
              </TooltipPopup>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <div className="pointer-events-none absolute top-1 right-1.5 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100">
                  <button
                    type="button"
                    aria-label={`Create new thread in ${project.displayName}`}
                    data-testid="new-thread-button"
                    className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={handleCreateThreadClick}
                  >
                    <SquarePenIcon className="size-3.5" />
                  </button>
                </div>
              }
            />
            <TooltipPopup side="top">
              {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
            </TooltipPopup>
          </Tooltip>
        </div>
      )}

      <SidebarProjectThreadList
        projectKey={project.projectKey}
        indented={!hideProjectHeader}
        orderedProjectThreadKeys={orderedProjectThreadKeys}
        pinnedThreadKeys={pinnedThreadKeys}
        renderedThreadRows={renderedThreadRows}
        draftRows={visibleDraftRows}
        memberProjectByScopedKey={memberProjectByScopedKey}
        showEmptyThreadState={showEmptyThreadState}
        shouldShowThreadPanel={shouldShowThreadPanel}
        projectCwd={project.cwd}
        primaryEnvironmentId={primaryEnvironmentId}
        activeRouteThreadKey={activeRouteThreadKey}
        routeDraftId={routeDraftId}
        navigateToDraft={navigateToDraft}
        clearDraftThread={clearDraftThread}
        threadJumpLabelByKey={threadJumpLabelByKey}
        appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
        renamingThreadKey={renamingThreadKey}
        renamingTitle={renamingTitle}
        setRenamingTitle={setRenamingTitle}
        renamingInputRef={renamingInputRef}
        renamingCommittedRef={renamingCommittedRef}
        confirmingArchiveThreadKey={confirmingArchiveThreadKey}
        setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
        confirmArchiveButtonRefs={confirmArchiveButtonRefs}
        handleThreadClick={handleThreadClick}
        handleParentThreadSelected={handleParentThreadSelected}
        navigateToThread={navigateToThread}
        handleMultiSelectContextMenu={handleMultiSelectContextMenu}
        handleThreadContextMenu={handleThreadContextMenu}
        clearSelection={clearSelection}
        commitRename={commitRename}
        cancelRename={cancelRename}
        attemptArchiveThread={attemptArchiveThread}
        dismissAgentRun={dismissAgentRun}
        setThreadPinned={setThreadPinned}
        toggleThreadExpanded={toggleThreadExpanded}
        reorderPinnedThreads={reorderPinnedThreads}
        openPrLink={openPullRequestLink}
      />

      <ProjectRenameDialog
        target={projectRenameTarget}
        title={projectRenameTitle}
        onTitleChange={setProjectRenameTitle}
        onClose={closeProjectRenameDialog}
        onSubmit={() => void submitProjectRename()}
      />

      <ProjectGroupingDialog
        target={projectGroupingTarget}
        selection={projectGroupingSelection}
        onSelectionChange={setProjectGroupingSelection}
        globalGroupingMode={projectGroupingSettings.sidebarProjectGroupingMode}
        onClose={closeProjectGroupingDialog}
        onSave={saveProjectGroupingPreference}
      />
    </>
  );
});

const SidebarProjectListRow = memo(function SidebarProjectListRow(props: SidebarProjectItemProps) {
  return (
    <SidebarMenuItem className="rounded-md">
      <SidebarProjectItem {...props} />
    </SidebarMenuItem>
  );
});

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

const ALL_PROJECTS_FILTER_LABEL = "All projects";
// Radio values are physical project keys; a leading NUL cannot collide with one.
const ALL_PROJECTS_FILTER_VALUE = "\u0000all-projects";

const ProjectFilterMenu = memo(function ProjectFilterMenu({
  projects,
  activeProject,
  onFilterChange,
}: {
  projects: readonly SidebarProjectSnapshot[];
  activeProject: SidebarProjectSnapshot | null;
  onFilterChange: (physicalProjectKey: string | null) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        aria-label="Filter threads by project"
        data-testid="sidebar-project-filter-trigger"
        className="flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 font-medium text-[length:var(--app-sidebar-meta-font-size)] text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
      >
        <FolderIcon className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">
          {activeProject?.displayName ?? ALL_PROJECTS_FILTER_LABEL}
        </span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="min-w-56">
        <MenuRadioGroup
          value={
            activeProject ? derivePhysicalProjectKey(activeProject) : ALL_PROJECTS_FILTER_VALUE
          }
          onValueChange={(value) => {
            onFilterChange(value === ALL_PROJECTS_FILTER_VALUE ? null : (value as string));
          }}
        >
          <MenuRadioItem
            className="min-h-7 py-1 text-[length:var(--app-sidebar-font-size)]"
            value={ALL_PROJECTS_FILTER_VALUE}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <FolderIcon className="size-3.5 shrink-0" />
              <span className="truncate">{ALL_PROJECTS_FILTER_LABEL}</span>
            </span>
          </MenuRadioItem>
          {projects.map((project) => (
            <MenuRadioItem
              className="min-h-7 py-1 text-[length:var(--app-sidebar-font-size)]"
              key={project.projectKey}
              value={derivePhysicalProjectKey(project)}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <ProjectFavicon
                  className="size-3.5"
                  cwd={project.cwd}
                  environmentId={project.environmentId}
                />
                <span className="truncate">{project.displayName}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});

function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  projectGroupingMode,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
  onProjectGroupingModeChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  projectGroupingMode: SidebarProjectGroupingMode;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  onProjectGroupingModeChange: (mode: SidebarProjectGroupingMode) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground" />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sort projects</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 font-medium text-[length:var(--app-sidebar-font-size)] text-muted-foreground">
            Sort projects
          </div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(
              ([value, label]) => (
                <MenuRadioItem
                  key={value}
                  value={value}
                  className="min-h-7 py-1 text-[length:var(--app-sidebar-font-size)]"
                >
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 font-medium text-[length:var(--app-sidebar-font-size)] text-muted-foreground">
            Sort threads
          </div>
          <MenuRadioGroup
            value={threadSortOrder}
            onValueChange={(value) => {
              onThreadSortOrderChange(value as SidebarThreadSortOrder);
            }}
          >
            {(
              Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
            ).map(([value, label]) => (
              <MenuRadioItem
                key={value}
                value={value}
                className="min-h-7 py-1 text-[length:var(--app-sidebar-font-size)]"
              >
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 font-medium text-[length:var(--app-sidebar-font-size)] text-muted-foreground">
            Group projects
          </div>
          <MenuRadioGroup
            value={projectGroupingMode}
            onValueChange={(value) => {
              if (value === "repository" || value === "repository_path" || value === "separate") {
                onProjectGroupingModeChange(value);
              }
            }}
          >
            {(
              Object.entries(PROJECT_GROUPING_MODE_LABELS) as Array<
                [SidebarProjectGroupingMode, string]
              >
            ).map(([value, label]) => (
              <MenuRadioItem
                key={value}
                value={value}
                className="min-h-7 py-1 text-[length:var(--app-sidebar-font-size)]"
              >
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function SortableProjectItem({
  projectId,
  disabled = false,
  children,
}: {
  projectId: string;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

function SortablePinnedThreadRow({
  threadKey,
  ...props
}: SidebarThreadRowProps & {
  threadKey: string;
}) {
  const { setNodeRef, transform, transition, isDragging, isOver, attributes, listeners } =
    useSortable({ id: threadKey });
  return (
    <SidebarThreadRow
      {...props}
      sortable={{
        attributes,
        isDragging,
        isOver,
        listeners,
        setNodeRef,
        style: {
          ...props.sortable?.style,
          transform: CSS.Translate.toString(transform),
          transition,
        },
      }}
    />
  );
}

const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const router = useRouter();
  const historyIndex = useLocation({ select: (location) => location.state.__TSR_index });
  const canGoBack = router.history.canGoBack();
  const canGoForward = historyIndex < router.history.length - 1;
  const wordmark = (
    <div className="flex w-full items-center gap-1">
      {/* Primary collapse control lives beside the traffic lights, matching the
          window chrome it belongs to; the content header only re-exposes it
          once the sidebar is collapsed and this one is gone. */}
      <SidebarTrigger className="no-drag size-6 shrink-0" />
      <div
        aria-label="Chat navigation history"
        className="ml-auto flex items-center gap-0.5"
        role="group"
      >
        <button
          type="button"
          aria-label="Back to previous chat"
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/65 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
          disabled={!canGoBack}
          onClick={() => router.history.back()}
          title="Back to previous chat"
        >
          <span aria-hidden="true">&lt;</span>
        </button>
        <button
          type="button"
          aria-label="Forward to next chat"
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/65 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
          disabled={!canGoForward}
          onClick={() => router.history.forward()}
          title="Forward to next chat"
        >
          <span aria-hidden="true">&gt;</span>
        </button>
      </div>
    </div>
  );

  return isElectron ? (
    <SidebarHeader
      className={cn(
        "drag-region flex-row items-center gap-2 py-0 pr-2",
        TITLEBAR_TRAFFIC_LIGHT_INSET_CLASS,
        TITLEBAR_ROW_CLASS,
      )}
    >
      {wordmark}
    </SidebarHeader>
  ) : (
    <SidebarHeader className="gap-2 px-2 py-0 md:hidden">{wordmark}</SidebarHeader>
  );
});

const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarFooter className="p-2">
      <SidebarUpdatePill />
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="gap-2 px-2 py-1.5 text-[length:var(--app-sidebar-font-size)] text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            onClick={handleSettingsClick}
          >
            <SettingsIcon className="size-3.5" />
            <span>Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
});

interface SidebarProjectsContentProps {
  showArm64IntelBuildWarning: boolean;
  arm64IntelBuildWarningDescription: string | null;
  desktopUpdateButtonAction: "download" | "install" | "none";
  desktopUpdateButtonDisabled: boolean;
  handleDesktopUpdateButtonClick: () => void;
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  projectGroupingMode: SidebarProjectGroupingMode;
  updateSettings: ReturnType<typeof useUpdateSettings>["updateSettings"];
  openAddProject: () => void;
  isManualProjectSorting: boolean;
  projectDnDSensors: ReturnType<typeof useSensors>;
  projectCollisionDetection: CollisionDetection;
  handleProjectDragStart: (event: DragStartEvent) => void;
  handleProjectDragEnd: (event: DragEndEvent) => void;
  handleProjectDragCancel: (event: DragCancelEvent) => void;
  handleNewThread: ReturnType<typeof useNewThreadHandler>["handleNewThread"];
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  decoupleThread: ReturnType<typeof useThreadActions>["decoupleThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  handleParentThreadSelected: (threadKey: string, hasChildren: boolean) => void;
  primaryEnvironmentId: SidebarThreadSummary["environmentId"] | null;
  sortedProjects: readonly SidebarProjectSnapshot[];
  allProjects: readonly SidebarProjectSnapshot[];
  activeFilterProject: SidebarProjectSnapshot | null;
  setProjectFilter: (physicalProjectKey: string | null) => void;
  activeRouteProjectKey: string | null;
  routeThreadKey: string | null;
  routeDraftId: string | null;
  navigateToDraft: (draftId: DraftId) => void;
  newThreadShortcutLabel: string | null;
  commandPaletteShortcutLabel: string | null;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  dragInProgressRef: React.RefObject<boolean>;
  suppressProjectClickAfterDragRef: React.RefObject<boolean>;
  suppressProjectClickForContextMenuRef: React.RefObject<boolean>;
  attachProjectListAutoAnimateRef: (node: HTMLElement | null) => void;
  projectsLength: number;
}

interface SidebarDraftRowData {
  draftId: DraftId;
  session: DraftSessionState;
  draftPrompt: string | null;
  draftAttachmentCount: number;
}

const EMPTY_SIDEBAR_DRAFT_ROWS: readonly SidebarDraftRowData[] = [];

const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  row: SidebarDraftRowData;
  isActive: boolean;
  onNavigate: (draftId: DraftId) => void;
  onDiscard: (draftId: DraftId) => void;
}) {
  const { draftId } = props.row;
  const draftThreadRef = scopeThreadRef(
    props.row.session.environmentId,
    props.row.session.threadId,
  );
  const draftThreadKey = scopedThreadKey(draftThreadRef);
  const hasPendingTurn = usePendingTurnStore((state) =>
    Boolean(state.pendingByThreadKey[draftThreadKey]),
  );
  const optimisticMessage = usePendingTurnStore(
    (state) => state.optimisticMessagesByThreadKey[draftThreadKey]?.at(-1) ?? null,
  );
  const preview = resolveSidebarDraftPreview({
    draftPrompt: props.row.draftPrompt,
    draftAttachmentCount: props.row.draftAttachmentCount,
    optimisticMessage,
  });
  const isPromoting = props.row.session.promotedTo != null;

  return (
    <SidebarMenuSubItem className="w-full">
      <div
        data-testid="sidebar-draft-row"
        className={`${resolveThreadRowClassName({
          isActive: props.isActive,
          isSelected: false,
        })} group/draft relative isolate flex h-7 w-full items-center rounded-md px-1.5`}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 p-0 text-left leading-tight outline-none"
          onClick={() => props.onNavigate(draftId)}
        >
          <span aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[length:var(--app-sidebar-font-size)] text-foreground/90">
            {preview}
          </span>
          <span
            className={`shrink-0 ${
              hasPendingTurn || isPromoting
                ? "font-medium text-sky-600 dark:text-sky-400"
                : "text-muted-foreground/50"
            }`}
            style={{ fontSize: "var(--app-sidebar-meta-font-size)" }}
          >
            {hasPendingTurn || isPromoting ? "Working" : "Draft"}
          </span>
        </button>
        <button
          type="button"
          aria-label="Discard draft"
          title="Discard draft"
          className="pointer-events-none mr-1 rounded-sm p-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/draft:pointer-events-auto group-hover/draft:opacity-100"
          onClick={() => props.onDiscard(draftId)}
        >
          <XIcon className="size-3" />
        </button>
      </div>
    </SidebarMenuSubItem>
  );
});

const SidebarProjectsContent = memo(function SidebarProjectsContent(
  props: SidebarProjectsContentProps,
) {
  const {
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    handleDesktopUpdateButtonClick,
    projectSortOrder,
    threadSortOrder,
    projectGroupingMode,
    updateSettings,
    openAddProject,
    isManualProjectSorting,
    projectDnDSensors,
    projectCollisionDetection,
    handleProjectDragStart,
    handleProjectDragEnd,
    handleProjectDragCancel,
    handleNewThread,
    archiveThread,
    decoupleThread,
    deleteThread,
    handleParentThreadSelected,
    primaryEnvironmentId,
    sortedProjects,
    allProjects,
    activeFilterProject,
    setProjectFilter,
    activeRouteProjectKey,
    routeThreadKey,
    routeDraftId,
    navigateToDraft,
    newThreadShortcutLabel,
    commandPaletteShortcutLabel,
    threadJumpLabelByKey,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    attachProjectListAutoAnimateRef,
    projectsLength,
  } = props;
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore((store) => store.draftsByThreadKey);
  const publishedThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const draftRowsByProjectKey = useMemo(() => {
    const projectKeyByMemberRef = new Map(
      allProjects.flatMap((project) =>
        project.memberProjectRefs.map((projectRef) => [
          scopedProjectKey(projectRef),
          project.projectKey,
        ]),
      ),
    );
    const serverThreadKeys = new Set(
      publishedThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    );
    const grouped = new Map<string, SidebarDraftRowData[]>();
    for (const [draftKey, session] of Object.entries(draftThreadsByThreadKey)) {
      const projectKey = projectKeyByMemberRef.get(
        scopedProjectKey(scopeProjectRef(session.environmentId, session.projectId)),
      );
      if (!projectKey) continue;
      const composer = draftsByThreadKey[draftKey];
      if (
        !shouldRenderSidebarDraft({
          hasUserContent: composerDraftHasUserContent(composer),
          isPromoting: session.promotedTo != null,
          serverThreadPublished: session.promotedTo
            ? serverThreadKeys.has(scopedThreadKey(session.promotedTo))
            : false,
        })
      ) {
        continue;
      }
      const attachmentIds = new Set([
        ...(composer?.images.map((attachment) => attachment.id) ?? []),
        ...(composer?.persistedAttachments.map((attachment) => attachment.id) ?? []),
        ...(composer?.previewAnnotations.map((annotation) => annotation.id) ?? []),
      ]);
      const rows = grouped.get(projectKey) ?? [];
      rows.push({
        draftId: DraftId.make(draftKey),
        session,
        draftPrompt: composer?.prompt ?? null,
        draftAttachmentCount: attachmentIds.size + (composer?.terminalContexts.length ?? 0),
      });
      grouped.set(projectKey, rows);
    }
    for (const rows of grouped.values()) {
      rows.sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
    }
    return grouped;
  }, [allProjects, draftsByThreadKey, draftThreadsByThreadKey, publishedThreads]);
  const handleProjectSortOrderChange = useCallback(
    (sortOrder: SidebarProjectSortOrder) => {
      updateSettings({ sidebarProjectSortOrder: sortOrder });
    },
    [updateSettings],
  );
  const handleThreadSortOrderChange = useCallback(
    (sortOrder: SidebarThreadSortOrder) => {
      updateSettings({ sidebarThreadSortOrder: sortOrder });
    },
    [updateSettings],
  );
  const handleProjectGroupingModeChange = useCallback(
    (groupingMode: SidebarProjectGroupingMode) => {
      updateSettings({ sidebarProjectGroupingMode: groupingMode });
    },
    [updateSettings],
  );
  // Filtering to one project already names it in the filter menu, so its own
  // header row would be redundant.
  const hideProjectHeader = activeFilterProject !== null;
  // That hidden header also carried the project's compose button, so the filter
  // row hosts it while a filter is active.
  const createThreadForProject = useProjectThreadCreator(handleNewThread);
  const handleFilteredCreateThreadClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!activeFilterProject) {
        return;
      }
      createThreadForProject(activeFilterProject, event);
    },
    [activeFilterProject, createThreadForProject],
  );
  return (
    <SidebarContent className="gap-0">
      <SidebarTopActions commandPaletteShortcutLabel={commandPaletteShortcutLabel} />
      {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
        <SidebarGroup className="px-2 pt-2 pb-0">
          <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
            <TriangleAlertIcon />
            <AlertTitle>Intel build on Apple Silicon</AlertTitle>
            <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
            {desktopUpdateButtonAction !== "none" ? (
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={desktopUpdateButtonDisabled}
                  onClick={handleDesktopUpdateButtonClick}
                >
                  {desktopUpdateButtonAction === "download"
                    ? "Download ARM build"
                    : "Install ARM build"}
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        </SidebarGroup>
      ) : null}
      <SidebarGroup className="p-2">
        <div className="mb-1 flex items-center justify-between gap-1">
          <ProjectFilterMenu
            activeProject={activeFilterProject}
            onFilterChange={setProjectFilter}
            projects={allProjects}
          />
          <div className="flex shrink-0 items-center gap-1">
            <ProjectSortMenu
              projectSortOrder={projectSortOrder}
              threadSortOrder={threadSortOrder}
              projectGroupingMode={projectGroupingMode}
              onProjectSortOrderChange={handleProjectSortOrderChange}
              onThreadSortOrderChange={handleThreadSortOrderChange}
              onProjectGroupingModeChange={handleProjectGroupingModeChange}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Add project"
                    data-testid="sidebar-add-project-trigger"
                    className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                    onClick={openAddProject}
                  />
                }
              >
                <FolderPlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="right">Add project</TooltipPopup>
            </Tooltip>
            {activeFilterProject ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`Create new thread in ${activeFilterProject.displayName}`}
                      data-testid="sidebar-filtered-new-thread-button"
                      className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                      onClick={handleFilteredCreateThreadClick}
                    />
                  }
                >
                  <SquarePenIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="right">
                  {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </div>

        {isManualProjectSorting ? (
          <DndContext
            sensors={projectDnDSensors}
            collisionDetection={projectCollisionDetection}
            modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
            onDragStart={handleProjectDragStart}
            onDragEnd={handleProjectDragEnd}
            onDragCancel={handleProjectDragCancel}
          >
            <SidebarMenu>
              <SortableContext
                items={sortedProjects.map((project) => project.projectKey)}
                strategy={verticalListSortingStrategy}
              >
                {sortedProjects.map((project) => (
                  <SortableProjectItem key={project.projectKey} projectId={project.projectKey}>
                    {(dragHandleProps) => (
                      <SidebarProjectItem
                        project={project}
                        primaryEnvironmentId={primaryEnvironmentId}
                        activeRouteThreadKey={
                          activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                        }
                        routeDraftId={routeDraftId}
                        navigateToDraft={navigateToDraft}
                        draftRows={
                          draftRowsByProjectKey.get(project.projectKey) ?? EMPTY_SIDEBAR_DRAFT_ROWS
                        }
                        newThreadShortcutLabel={newThreadShortcutLabel}
                        handleNewThread={handleNewThread}
                        archiveThread={archiveThread}
                        decoupleThread={decoupleThread}
                        deleteThread={deleteThread}
                        handleParentThreadSelected={handleParentThreadSelected}
                        threadJumpLabelByKey={threadJumpLabelByKey}
                        dragInProgressRef={dragInProgressRef}
                        suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                        suppressProjectClickForContextMenuRef={
                          suppressProjectClickForContextMenuRef
                        }
                        isManualProjectSorting={isManualProjectSorting}
                        hideProjectHeader={hideProjectHeader}
                        dragHandleProps={dragHandleProps}
                      />
                    )}
                  </SortableProjectItem>
                ))}
              </SortableContext>
            </SidebarMenu>
          </DndContext>
        ) : (
          <SidebarMenu ref={attachProjectListAutoAnimateRef}>
            {sortedProjects.map((project) => (
              <SidebarProjectListRow
                key={project.projectKey}
                project={project}
                primaryEnvironmentId={primaryEnvironmentId}
                activeRouteThreadKey={
                  activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                }
                routeDraftId={routeDraftId}
                navigateToDraft={navigateToDraft}
                draftRows={
                  draftRowsByProjectKey.get(project.projectKey) ?? EMPTY_SIDEBAR_DRAFT_ROWS
                }
                newThreadShortcutLabel={newThreadShortcutLabel}
                handleNewThread={handleNewThread}
                archiveThread={archiveThread}
                decoupleThread={decoupleThread}
                deleteThread={deleteThread}
                handleParentThreadSelected={handleParentThreadSelected}
                threadJumpLabelByKey={threadJumpLabelByKey}
                dragInProgressRef={dragInProgressRef}
                suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
                isManualProjectSorting={isManualProjectSorting}
                hideProjectHeader={hideProjectHeader}
                dragHandleProps={null}
              />
            ))}
          </SidebarMenu>
        )}

        {projectsLength === 0 && (
          <div className="px-2 pt-4 text-center text-[length:var(--app-sidebar-font-size)] text-muted-foreground/60">
            No projects yet
          </div>
        )}
      </SidebarGroup>
    </SidebarContent>
  );
});

export default function Sidebar() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const sidebarThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const sidebarThreadLastVisitedAts = useUiStateStore(
    useShallow((state) =>
      sidebarThreads.map(
        (thread) =>
          state.threadLastVisitedAtById[
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
          ] ?? null,
      ),
    ),
  );
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const pinnedThreadKeysByProjectId = useUiStateStore((store) => store.pinnedThreadKeysByProjectId);
  const threadExpandedById = useUiStateStore((store) => store.threadExpandedById);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const sidebarProjectFilterKey = useUiStateStore((store) => store.sidebarProjectFilterKey);
  const setSidebarProjectFilter = useUiStateStore((store) => store.setSidebarProjectFilter);
  const selectedParentThreadKeyRef = useRef<string | null>(null);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isOnSettings = pathname.startsWith("/settings");
  const sidebarThreadSortOrder = useSettings((s) => s.sidebarThreadSortOrder);
  const sidebarProjectSortOrder = useSettings((s) => s.sidebarProjectSortOrder);
  const sidebarProjectGroupingMode = useSettings((s) => s.sidebarProjectGroupingMode);
  const projectGroupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));
  const { updateSettings } = useUpdateSettings();
  const { handleNewThread } = useNewThreadHandler();
  const { archiveThread, decoupleThread, deleteThread } = useThreadActions();
  const { isMobile, setOpenMobile } = useSidebar();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeTerminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const keybindings = useServerKeybindings();
  const openAddProjectCommandPalette = useCommandPaletteStore((store) => store.openAddProject);
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const platform = navigator.platform;
  const shortcutModifiers = useShortcutModifierState();
  const modelPickerOpen = useModelPickerOpen();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
    });
  }, [projectOrder, projects]);

  // Build a mapping from physical project key → logical project key for
  // cross-environment grouping.  Projects that share a repositoryIdentity
  // canonicalKey are treated as one logical project in the sidebar.
  const physicalToLogicalKey = useMemo(() => {
    return buildPhysicalToLogicalProjectKeyMap({
      projects: orderedProjects,
      settings: projectGroupingSettings,
    });
  }, [orderedProjects, projectGroupingSettings]);
  const projectPhysicalKeyByScopedRef = useMemo(
    () =>
      new Map(
        orderedProjects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          derivePhysicalProjectKey(project),
        ]),
      ),
    [orderedProjects],
  );

  const sidebarProjects = useMemo<SidebarProjectSnapshot[]>(() => {
    return buildSidebarProjectSnapshots({
      projects: orderedProjects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => {
        const rt = savedEnvironmentRuntimeById[environmentId];
        const saved = savedEnvironmentRegistry[environmentId];
        return rt?.descriptor?.label ?? saved?.label ?? null;
      },
    });
  }, [
    orderedProjects,
    projectGroupingSettings,
    primaryEnvironmentId,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
  ]);

  const sidebarProjectByKey = useMemo(
    () => new Map(sidebarProjects.map((project) => [project.projectKey, project] as const)),
    [sidebarProjects],
  );
  const sidebarThreadByKey = useMemo(
    () =>
      new Map(
        sidebarThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [sidebarThreads],
  );
  // Resolve the active route's project key to a logical key so it matches the
  // sidebar's grouped project entries.
  const activeRouteProjectKey = useMemo(() => {
    if (!routeThreadKey) {
      return null;
    }
    const activeThread = sidebarThreadByKey.get(routeThreadKey);
    if (!activeThread) return null;
    const physicalKey =
      projectPhysicalKeyByScopedRef.get(
        scopedProjectKey(scopeProjectRef(activeThread.environmentId, activeThread.projectId)),
      ) ?? scopedProjectKey(scopeProjectRef(activeThread.environmentId, activeThread.projectId));
    return physicalToLogicalKey.get(physicalKey) ?? physicalKey;
  }, [routeThreadKey, sidebarThreadByKey, physicalToLogicalKey, projectPhysicalKeyByScopedRef]);

  // Group threads by logical project key so all threads from grouped projects
  // are displayed together.
  const threadsByProjectKey = useMemo(() => {
    const next = new Map<string, SidebarThreadSummary[]>();
    for (const thread of sidebarThreads) {
      const physicalKey =
        projectPhysicalKeyByScopedRef.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      const logicalKey = physicalToLogicalKey.get(physicalKey) ?? physicalKey;
      const existing = next.get(logicalKey);
      if (existing) {
        existing.push(thread);
      } else {
        next.set(logicalKey, [thread]);
      }
    }
    return next;
  }, [sidebarThreads, physicalToLogicalKey, projectPhysicalKeyByScopedRef]);
  const getCurrentSidebarShortcutContext = useCallback(
    () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeThreadRef
        ? selectThreadTerminalState(
            useTerminalStateStore.getState().terminalStateByThreadKey,
            routeThreadRef,
          ).terminalOpen
        : false,
      modelPickerOpen,
    }),
    [modelPickerOpen, routeThreadRef],
  );
  const newThreadShortcutLabelOptions = useMemo(
    () => ({
      platform,
      context: {
        terminalFocus: false,
        terminalOpen: false,
      },
    }),
    [platform],
  );
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", newThreadShortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", newThreadShortcutLabelOptions);

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: clearAgentRunRouteSearch,
      });
    },
    [clearSelection, isMobile, navigate, setOpenMobile, setSelectionAnchor],
  );
  const navigateToDraft = useCallback(
    (draftId: DraftId) => {
      if (isMobile) setOpenMobile(false);
      void navigate({ to: "/draft/$draftId", params: { draftId } });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleParentThreadSelected = useCallback((threadKey: string, hasChildren: boolean) => {
    const previousThreadKey = selectedParentThreadKeyRef.current;
    const nextThreadKey = hasChildren ? threadKey : null;
    if (previousThreadKey && previousThreadKey !== nextThreadKey) {
      useUiStateStore.getState().setThreadExpanded(previousThreadKey, false);
    }
    if (nextThreadKey) {
      useUiStateStore.getState().setThreadExpanded(nextThreadKey, true);
    }
    selectedParentThreadKeyRef.current = nextThreadKey;
  }, []);

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (sidebarProjectSortOrder !== "manual") {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = sidebarProjectByKey.get(String(active.id));
      const overProject = sidebarProjectByKey.get(String(over.id));
      if (!activeProject || !overProject) return;
      const activeMemberKeys = activeProject.memberProjects.map(
        (member) => member.physicalProjectKey,
      );
      const overMemberKeys = overProject.memberProjects.map((member) => member.physicalProjectKey);
      reorderProjects(activeMemberKeys, overMemberKeys);
    },
    [sidebarProjectSortOrder, reorderProjects, sidebarProjectByKey],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [sidebarProjectSortOrder],
  );

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());
  const attachProjectListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  }, []);

  const visibleThreads = useMemo(
    () => selectVisibleSidebarThreads(sidebarThreads),
    [sidebarThreads],
  );
  const sortedProjects = useMemo(() => {
    const sortableProjects = sidebarProjects.map((project) => ({
      ...project,
      id: project.projectKey,
    }));
    const sortableThreads = visibleThreads.map((thread) => {
      const physicalKey =
        projectPhysicalKeyByScopedRef.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      return {
        ...thread,
        projectId: (physicalToLogicalKey.get(physicalKey) ?? physicalKey) as ProjectId,
      };
    });
    return sortProjectsForSidebar(
      sortableProjects,
      sortableThreads,
      sidebarProjectSortOrder,
    ).flatMap((project) => {
      const resolvedProject = sidebarProjectByKey.get(project.id);
      return resolvedProject ? [resolvedProject] : [];
    });
  }, [
    sidebarProjectSortOrder,
    physicalToLogicalKey,
    projectPhysicalKeyByScopedRef,
    sidebarProjectByKey,
    sidebarProjects,
    visibleThreads,
  ]);
  // Filtering at the source keeps everything derived from the project list —
  // rendered rows, ⌘-jump labels and thread traversal — in agreement about
  // which threads are on screen.
  const { projects: visibleProjects, activeProject: activeFilterProject } = useMemo(
    () =>
      resolveFilteredSidebarProjects({
        projects: sortedProjects,
        filterKey: sidebarProjectFilterKey,
      }),
    [sidebarProjectFilterKey, sortedProjects],
  );
  const isManualProjectSorting = sidebarProjectSortOrder === "manual";
  const threadExpandedOverrideMap = useMemo(
    () =>
      new Map(
        Object.entries(threadExpandedById).filter(([, expanded]) => typeof expanded === "boolean"),
      ),
    [threadExpandedById],
  );
  const visibleSidebarThreadKeys = useMemo(() => {
    const lastVisitedAtByThreadKey = new Map(
      sidebarThreads.map((thread, index) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        sidebarThreadLastVisitedAts[index] ?? null,
      ]),
    );
    return visibleProjects.flatMap((project) => {
      // Match SidebarProjectItem: a filtered single-project list has no header
      // disclosure, so force expansion for jump labels and prev/next too.
      const projectExpanded = resolveProjectExpanded({
        storedExpanded: projectExpandedById[project.projectKey] ?? true,
        hasHeader: activeFilterProject === null,
      });
      const activeThreadKey = routeThreadKey ?? undefined;
      const projectThreads = selectVisibleSidebarThreads(
        threadsByProjectKey.get(project.projectKey) ?? [],
      );
      const pinnedCollapsedThreadKey =
        !projectExpanded && activeThreadKey
          ? (projectThreads
              .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
              .find((threadKey) => threadKey === activeThreadKey) ?? null)
          : null;
      if (!projectExpanded && pinnedCollapsedThreadKey === null) {
        return [];
      }
      if (pinnedCollapsedThreadKey) {
        return [pinnedCollapsedThreadKey];
      }
      const { rowViews } = buildSidebarThreadRows({
        threads: projectThreads,
        pinnedThreadKeys: pinnedThreadKeysByProjectId[project.projectKey] ?? [],
        activeThreadKey,
        expandedOverrideByThreadKey: threadExpandedOverrideMap,
        sortOrder: sidebarThreadSortOrder,
        resolveThreadStatus: (thread) =>
          resolveThreadStatusPill({
            thread,
            lastVisitedAt:
              lastVisitedAtByThreadKey.get(
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
              ) ?? null,
          }),
      });
      return rowViews.map((row) => row.threadKey);
    });
  }, [
    activeFilterProject,
    threadExpandedOverrideMap,
    pinnedThreadKeysByProjectId,
    projectExpandedById,
    routeThreadKey,
    sidebarThreadLastVisitedAts,
    sidebarThreads,
    sidebarThreadSortOrder,
    visibleProjects,
    threadsByProjectKey,
  ]);
  const threadJumpCommandByKey = useMemo(() => {
    const mapping = new Map<string, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadKey] of visibleSidebarThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadKey, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadKeys]);
  const threadJumpThreadKeys = useMemo(
    () => [...threadJumpCommandByKey.keys()],
    [threadJumpCommandByKey],
  );
  const sidebarShortcutContext = useMemo(
    () => ({
      terminalFocus: false,
      terminalOpen: routeTerminalOpen,
      modelPickerOpen,
    }),
    [modelPickerOpen, routeTerminalOpen],
  );
  const threadJumpLabelByKey = useMemo(
    () =>
      buildThreadJumpLabelMap({
        keybindings,
        platform,
        terminalOpen: sidebarShortcutContext.terminalOpen,
        threadJumpCommandByKey,
      }),
    [keybindings, platform, sidebarShortcutContext.terminalOpen, threadJumpCommandByKey],
  );
  const shouldShowThreadJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform,
      context: sidebarShortcutContext,
    },
  );
  const visibleThreadJumpLabelByKey = showThreadJumpHints
    ? threadJumpLabelByKey
    : EMPTY_THREAD_JUMP_LABELS;
  const orderedSidebarThreadKeys = visibleSidebarThreadKeys;

  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowThreadJumpHintsNow);
  }, [shouldShowThreadJumpHintsNow, updateThreadJumpHintsVisibility]);

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      const shortcutContext = getCurrentSidebarShortcutContext();

      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: shortcutContext,
      });
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        const targetThreadKey = resolveAdjacentThreadId({
          threadIds: orderedSidebarThreadKeys,
          currentThreadId: routeThreadKey,
          direction: traversalDirection,
        });
        if (!targetThreadKey) {
          return;
        }
        const targetThread = sidebarThreadByKey.get(targetThreadKey);
        if (!targetThread) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetThreadKey = threadJumpThreadKeys[jumpIndex];
      if (!targetThreadKey) {
        return;
      }
      const targetThread = sidebarThreadByKey.get(targetThreadKey);
      if (!targetThread) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
    };

    window.addEventListener("keydown", onWindowKeyDown);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    getCurrentSidebarShortcutContext,
    keybindings,
    navigateToThread,
    orderedSidebarThreadKeys,
    platform,
    routeThreadKey,
    sidebarThreadByKey,
    threadJumpThreadKeys,
  ]);

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const commandPaletteShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "commandPalette.toggle",
    newThreadShortcutLabelOptions,
  );
  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start update download",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  return (
    <>
      <SidebarHoverThreadPrewarmer />
      <SidebarChromeHeader isElectron={isElectron} />

      {isOnSettings ? (
        <SettingsSidebarNav pathname={pathname} />
      ) : (
        <>
          <SidebarProjectsContent
            showArm64IntelBuildWarning={showArm64IntelBuildWarning}
            arm64IntelBuildWarningDescription={arm64IntelBuildWarningDescription}
            desktopUpdateButtonAction={desktopUpdateButtonAction}
            desktopUpdateButtonDisabled={desktopUpdateButtonDisabled}
            handleDesktopUpdateButtonClick={handleDesktopUpdateButtonClick}
            projectSortOrder={sidebarProjectSortOrder}
            threadSortOrder={sidebarThreadSortOrder}
            projectGroupingMode={sidebarProjectGroupingMode}
            updateSettings={updateSettings}
            openAddProject={openAddProjectCommandPalette}
            isManualProjectSorting={isManualProjectSorting}
            projectDnDSensors={projectDnDSensors}
            projectCollisionDetection={projectCollisionDetection}
            handleProjectDragStart={handleProjectDragStart}
            handleProjectDragEnd={handleProjectDragEnd}
            handleProjectDragCancel={handleProjectDragCancel}
            handleNewThread={handleNewThread}
            archiveThread={archiveThread}
            decoupleThread={decoupleThread}
            deleteThread={deleteThread}
            handleParentThreadSelected={handleParentThreadSelected}
            primaryEnvironmentId={primaryEnvironmentId}
            sortedProjects={visibleProjects}
            allProjects={sortedProjects}
            activeFilterProject={activeFilterProject}
            setProjectFilter={setSidebarProjectFilter}
            activeRouteProjectKey={activeRouteProjectKey}
            routeThreadKey={routeThreadKey}
            routeDraftId={routeDraftId}
            navigateToDraft={navigateToDraft}
            newThreadShortcutLabel={newThreadShortcutLabel}
            commandPaletteShortcutLabel={commandPaletteShortcutLabel}
            threadJumpLabelByKey={visibleThreadJumpLabelByKey}
            dragInProgressRef={dragInProgressRef}
            suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
            suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
            attachProjectListAutoAnimateRef={attachProjectListAutoAnimateRef}
            projectsLength={projects.length}
          />

          <SidebarSeparator />
          <SidebarChromeFooter />
        </>
      )}
    </>
  );
}
