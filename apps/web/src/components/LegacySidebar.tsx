import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import { Spinner } from "~/components/ui/spinner";
import {
  ArchiveIcon,
  ArrowUpDownIcon,
  ChevronRightIcon,
  FolderPlusIcon,
  Globe2Icon,
  SearchIcon,
  SquarePenIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  ChangeRequestStatusIcon,
  prStatusIndicator,
  PrStatusTooltipContent,
  ThreadTerminalStatusButton,
  ThreadStatusLabel,
  ThreadWorktreeIndicator,
  useLinkedThreadPullRequest,
} from "./ThreadStatusIndicators";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ProjectFavicon } from "./ProjectFavicon";
import { useAtomValue } from "@effect/atom-react";
import { autoAnimate } from "@formkit/auto-animate";
import React, { useEffect, useEffectEvent, memo, useRef, useState } from "react";
import { cn } from "~/lib/utils";
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
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  type ContextMenuItem,
  type EnvironmentId,
  ProjectId,
  type ScopedThreadRef,
  type ResolvedKeybindingsConfig,
  type SidebarProjectGroupingMode,
  resolveEnvironmentMachineKind,
  ThreadId,
} from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
  type SidebarProjectSortOrder,
  type SidebarThreadPreviewCount,
  type SidebarThreadSortOrder,
} from "@t3tools/contracts/settings";
import { isDesktopLocalConnectionTarget, isWslConnectionTarget } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import { isElectron } from "../env";
import { useStableCallback } from "../hooks/useStableCallback";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { releaseProjectDraftUploads } from "../lib/composerDraftUploads";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isMacPlatform } from "../lib/utils";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import {
  readThreadShell,
  useProjects,
  useThreadShells,
  useThreadShellsForProjectRefs,
  waitForProjectRemoval,
} from "../state/entities";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { useThreadDiscoveredPorts } from "../portDiscoveryState";
import { openDiscoveredPort } from "./preview/openDiscoveredPort";
import { useAtomCommand } from "../state/use-atom-command";
import {
  ORCHESTRATION_OPERATE_DENIED_MESSAGE,
  useOrchestrationCommand,
} from "../state/use-orchestration-command";
import { previewEnvironment } from "../state/preview";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import {
  legacyProjectCwdPreferenceKey,
  resolveProjectExpanded,
  useUiStateStore,
} from "../uiStateStore";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { useShortcutModifierState } from "../shortcutModifierState";
import { ensureLocalApi, readLocalApi } from "../localApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useDesktopUpdateState } from "../state/desktopUpdate";

import { useThreadActions } from "../hooks/useThreadActions";
import { projectEnvironment } from "../state/projects";
import { threadEnvironment, useEnvironmentThread } from "../state/threads";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { buildThreadRouteParams, resolveActiveThreadRouteRef } from "../threadRoutes";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { RelativeTime } from "./RelativeTime";
import { Kbd } from "./ui/kbd";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "./desktopUpdate.toast";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "./ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "./ui/sidebar";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../threadSelectionStore";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import {
  archiveSelectedThreadEntries,
  buildMultiSelectThreadContextMenuItems,
  deleteSelectedThreadEntries,
  getSidebarThreadIdsToPrewarm,
  resolveAdjacentThreadId,
  isContextMenuPointerDown,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  resolveProjectStatusIndicator,
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  useSidebarRowSubscriptionLease,
  useThreadJumpHintVisibility,
  ThreadStatusPill,
} from "./Sidebar.logic";
import { sortThreads } from "../lib/threadSort";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { CommandDialogTrigger } from "./ui/command";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { primaryServerKeybindingsAtom } from "../state/server";
import {
  derivePhysicalProjectKey,
  deriveProjectGroupingOverrideKey,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import type { SidebarThreadSummary } from "../types";
import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
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
  duration: 180,
  easing: "ease-out",
} as const;
const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();
const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};
const SIDEBAR_ICON_ACTION_BUTTON_CLASS =
  "inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-0.75 text-icon-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

function SidebarThreadDetailPrewarmer({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  return null;
}

function clampSidebarThreadPreviewCount(value: number): SidebarThreadPreviewCount {
  return Math.min(
    MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
    Math.max(MIN_SIDEBAR_THREAD_PREVIEW_COUNT, value),
  ) as SidebarThreadPreviewCount;
}

function formatProjectMemberActionLabel(
  member: SidebarProjectGroupMember,
  groupedProjectCount: number,
): string {
  if (groupedProjectCount <= 1) {
    return member.title;
  }

  return member.environmentLabel
    ? `${member.environmentLabel} — ${member.workspaceRoot}`
    : member.workspaceRoot;
}

function projectExpansionPreferenceKeys(project: SidebarProjectSnapshot): string[] {
  return [
    project.projectKey,
    ...project.memberProjects.map((member) => member.physicalProjectKey),
    ...project.memberProjects.map((member) => legacyProjectCwdPreferenceKey(member.workspaceRoot)),
  ];
}

function projectGroupingModeDescription(mode: SidebarProjectGroupingMode): string {
  switch (mode) {
    case "repository":
      return "Projects from the same repository share one sidebar row.";
    case "repository_path":
      return "Projects group only when both the repository and repo-relative path match.";
    case "separate":
      return "Every project path gets its own sidebar row.";
  }
}

function buildThreadJumpLabelMap(input: {
  keybindings: ResolvedKeybindingsConfig;
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
  orderedProjectThreadKeys: readonly string[];
  isActive: boolean;
  openPullRequestsInRightPanel: boolean;
  jumpLabel: string | null;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  startThreadRename: (threadKey: string, title: string) => void;
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
  navigateToThread: (threadRef: ScopedThreadRef) => Promise<void>;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
  openPrLink: (
    event: React.MouseEvent<HTMLElement>,
    prUrl: string,
    threadRef?: ScopedThreadRef,
  ) => boolean;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}

function checkTaskPermission(environmentId: EnvironmentId): boolean {
  if (readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return true;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Action unavailable",
      description: ORCHESTRATION_OPERATE_DENIED_MESSAGE,
    }),
  );
  return false;
}

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    orderedProjectThreadKeys,
    isActive,
    openPullRequestsInRightPanel,
    jumpLabel,
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    startThreadRename,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    handleThreadClick,
    navigateToThread,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    openPrLink,
    onFileDropThreads,
    thread,
  } = props;
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const canOperatePreview = useEnvironmentScope(thread.environmentId, AuthPreviewOperateScope);
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(isActive);
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const isMobile = useIsMobile();
  const discoveredPorts = useThreadDiscoveredPorts({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const environment = useEnvironment(thread.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread = thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = environment?.label ?? null;
  const remoteMachine = resolveEnvironmentMachineKind(environment?.serverConfig ?? null);
  const isDesktopLocalThread =
    environment !== null && isDesktopLocalConnectionTarget(environment.entry.target);
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvLabel ?? (isDesktopLocalThread ? "Local" : "Remote"))
    : null;
  const isThreadRunning = !threadRuntimeCanArchive(thread.runtime);
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });
  const linkedPullRequestStatus = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    leaseLiveStatus,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const pr = linkedPullRequestStatus?.pr ?? null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  // Every hook runs above this line: the handlers below key on this ref, and the
  // compiler can only cache it once no hook call follows its plain uses.
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const fileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: setIsFileDragOver,
    addFiles: (files) => {
      onFileDropThreads(threadRef, files);
    },
    addFolders: () => {},
  });
  const isHighlighted = isActive || isSelected;
  const handleOpenDiscoveredPort = (event: React.MouseEvent<HTMLButtonElement>) => {
    const port = discoveredPorts[0];
    if (!port || !canOperatePreview) return;
    event.preventDefault();
    event.stopPropagation();
    navigateToThread(threadRef);
    void (async () => {
      const result = await openDiscoveredPort({ threadRef, port, openPreview });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open preview",
          description: error instanceof Error ? error.message : "The preview could not be opened.",
        }),
      );
    })();
  };
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
    : null;
  const prStatus = prStatusIndicator(pr, linkedPullRequestStatus?.sourceControlProvider);
  const isConfirmingArchive =
    canOperateThread && confirmingArchiveThreadKey === threadKey && !isThreadRunning;
  const threadMetaClassName = isConfirmingArchive
    ? "pointer-events-none opacity-0"
    : canOperateThread && !isThreadRunning
      ? "pointer-events-none transition-opacity duration-150 max-sm:pr-6 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
      : "pointer-events-none";
  const clearConfirmingArchive = () => {
    setConfirmingArchiveThreadKey((current) => (current === threadKey ? null : current));
  };
  const handleMouseLeave = () => {
    clearConfirmingArchive();
  };
  const handleBlurCapture = (event: React.FocusEvent<HTMLLIElement>) => {
    const currentTarget = event.currentTarget;
    requestAnimationFrame(() => {
      if (currentTarget.contains(document.activeElement)) {
        return;
      }
      clearConfirmingArchive();
    });
  };
  const handleRowClick = (event: React.MouseEvent) => {
    handleThreadClick(event, threadRef, orderedProjectThreadKeys);
  };
  const handleRowDoubleClick = (event: React.MouseEvent) => {
    if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) return;
    if (renamingThreadKey === threadKey) return;
    // On mobile the first tap navigates and closes the sidebar sheet, so the
    // inline rename can't be shown. Renaming there stays on the context menu.
    if (isMobile) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest("button, a")) return;
    event.preventDefault();
    startThreadRename(threadKey, thread.title);
  };
  const handleRowKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    navigateToThread(threadRef);
  };
  const handleRowContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const hasSelection = useThreadSelectionStore.getState().hasSelection();
    if (hasSelection && isSelected) {
      void (async () => {
        const result = await settlePromise(() =>
          handleMultiSelectContextMenu({
            x: event.clientX,
            y: event.clientY,
          }),
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Thread action failed",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
      return;
    }

    if (hasSelection) {
      clearSelection();
    }
    void (async () => {
      const result = await settlePromise(() =>
        handleThreadContextMenu(threadRef, {
          x: event.clientX,
          y: event.clientY,
        }),
      );
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Thread action failed",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const handlePrClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const url = prStatus?.url ?? currentLinkedPr?.url;
    if (!url) return;
    const openedInRightPanel = openPrLink(
      event,
      url,
      openPullRequestsInRightPanel ? threadRef : undefined,
    );
    if (openedInRightPanel && openPullRequestsInRightPanel && !isActive) {
      navigateToThread(threadRef);
    }
  };
  const handleRenameInputRef = (element: HTMLInputElement | null) => {
    if (element && renamingInputRef.current !== element) {
      renamingInputRef.current = element;
      element.focus();
      element.select();
    }
  };
  const handleRenameInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setRenamingTitle(event.target.value);
  };
  const handleRenameInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
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
  };
  const handleRenameInputBlur = () => {
    if (!renamingCommittedRef.current) {
      void commitRename(threadRef, renamingTitle, thread.title);
    }
  };
  // Without stopping `dblclick`, double-clicking to select a word would re-fire
  // the row's rename handler and reset the in-progress edit back to the title.
  const handleRenameInputClick = (event: React.MouseEvent<HTMLInputElement>) => {
    event.stopPropagation();
  };
  const handleConfirmArchiveRef = (element: HTMLButtonElement | null) => {
    if (element) {
      confirmArchiveButtonRefs.current.set(threadKey, element);
    } else {
      confirmArchiveButtonRefs.current.delete(threadKey);
    }
  };
  const stopPropagationOnPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  const handleConfirmArchiveClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    clearConfirmingArchive();
    void attemptArchiveThread(threadRef);
  };
  const handleStartArchiveConfirmation = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!checkTaskPermission(thread.environmentId)) return;
    setConfirmingArchiveThreadKey(threadKey);
    requestAnimationFrame(() => {
      confirmArchiveButtonRefs.current.get(threadKey)?.focus();
    });
  };
  const handleArchiveImmediateClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void attemptArchiveThread(threadRef);
  };

  return (
    <SidebarMenuSubItem
      ref={rowRef}
      className="w-full"
      data-thread-item
      {...fileDropHandlers}
      onMouseLeave={handleMouseLeave}
      onBlurCapture={handleBlurCapture}
    >
      <div
        role="button"
        tabIndex={0}
        data-active={isActive}
        data-slot="sidebar-menu-sub-button"
        data-sidebar="menu-sub-button"
        data-size="sm"
        data-testid={`thread-row-${thread.id}`}
        className={cn(
          "relative isolate flex h-8 w-full min-w-0 cursor-pointer select-none items-center gap-2 overflow-hidden rounded-md px-2 text-left text-xs outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring group-data-[collapsible=icon]:hidden [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-muted-foreground",
          isActive
            ? "bg-sidebar-row-active font-medium text-sidebar-foreground hover:bg-sidebar-row-active"
            : isSelected
              ? "bg-sidebar-row-selected text-sidebar-foreground hover:bg-sidebar-row-active"
              : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          isFileDragOver && "ring-1 ring-inset ring-primary/70",
        )}
        onClick={handleRowClick}
        onDoubleClick={handleRowDoubleClick}
        onKeyDown={handleRowKeyDown}
        onContextMenu={handleRowContextMenu}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {prStatus && pr && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <a
                    href={prStatus.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={prStatus.tooltip}
                    className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={handlePrClick}
                  >
                    <ChangeRequestStatusIcon
                      state={pr.state}
                      isDraft={pr.isDraft}
                      className="size-3"
                    />
                  </a>
                }
              />
              <TooltipPopup side="top">
                <PrStatusTooltipContent status={prStatus} />
              </TooltipPopup>
            </Tooltip>
          )}
          {!pr && currentLinkedPr ? (
            <a
              href={currentLinkedPr.url}
              target="_blank"
              rel="noopener noreferrer"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={handlePrClick}
              className="text-muted-foreground"
              aria-label={`PR #${currentLinkedPr.number}, status pending`}
            >
              <PullRequestGlyph.pullRequest className="size-3" />
            </a>
          ) : null}
          {threadStatus && <ThreadStatusLabel status={threadStatus} />}
          {canOperateThread && renamingThreadKey === threadKey ? (
            <input
              ref={handleRenameInputRef}
              className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-sm outline-none"
              value={renamingTitle}
              onChange={handleRenameInputChange}
              onKeyDown={handleRenameInputKeyDown}
              onBlur={handleRenameInputBlur}
              onClick={handleRenameInputClick}
              onDoubleClick={handleRenameInputClick}
            />
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className="min-w-0 flex-1 truncate text-sm"
                    data-testid={`thread-title-${thread.id}`}
                  >
                    {thread.title}
                  </span>
                }
              />
              <TooltipPopup side="top">{thread.title}</TooltipPopup>
            </Tooltip>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {canOperatePreview && discoveredPorts.length > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Open localhost:${discoveredPorts[0]?.port ?? ""}`}
                    className="inline-flex cursor-pointer items-center justify-center text-success-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
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
          )}
          <ThreadWorktreeIndicator thread={thread} />
          <ThreadTerminalStatusButton
            threadRef={threadRef}
            terminalIds={runningTerminalIds}
            onThreadActivate={navigateToThread}
          />
          <div
            className={`flex min-w-12 justify-end ${
              isRemoteThread ? "max-sm:min-w-24" : "max-sm:min-w-20"
            }`}
          >
            {isConfirmingArchive ? (
              <button
                ref={handleConfirmArchiveRef}
                type="button"
                data-thread-selection-safe
                data-testid={`thread-archive-confirm-${thread.id}`}
                aria-label={`Confirm archive ${thread.title}`}
                className="absolute top-1/2 right-1 inline-flex h-5 -translate-y-1/2 cursor-pointer items-center rounded-md bg-destructive/12 px-2 text-3xs font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-destructive/40"
                onPointerDown={stopPropagationOnPointerDown}
                onClick={handleConfirmArchiveClick}
              >
                Confirm
              </button>
            ) : canOperateThread && !isThreadRunning ? (
              appSettingsConfirmThreadArchive ? (
                <div className="pointer-events-none absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                  <button
                    type="button"
                    data-thread-selection-safe
                    data-testid={`thread-archive-${thread.id}`}
                    aria-label={`Archive ${thread.title}`}
                    className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                    onPointerDown={stopPropagationOnPointerDown}
                    onClick={handleStartArchiveConfirmation}
                  >
                    <ArchiveIcon className="size-3.5" />
                  </button>
                </div>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div className="pointer-events-none absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={`thread-archive-${thread.id}`}
                          aria-label={`Archive ${thread.title}`}
                          className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                          onPointerDown={stopPropagationOnPointerDown}
                          onClick={handleArchiveImmediateClick}
                        >
                          <ArchiveIcon className="size-3.5" />
                        </button>
                      </div>
                    }
                  />
                  <TooltipPopup side="top">Archive</TooltipPopup>
                </Tooltip>
              )
            ) : null}
            <span className={threadMetaClassName}>
              <span className="inline-flex items-center gap-1">
                {isRemoteThread && !isDesktopLocalThread && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          aria-label={threadEnvironmentLabel ?? "Remote"}
                          className="inline-flex items-center justify-center"
                        />
                      }
                    >
                      <EnvironmentMachineIcon
                        kind={remoteMachine}
                        className="size-3 text-muted-foreground/40"
                      />
                    </TooltipTrigger>
                    <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
                  </Tooltip>
                )}
                {jumpLabel ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          aria-label={jumpLabel}
                          className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/90 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
                        />
                      }
                    >
                      {jumpLabel}
                    </TooltipTrigger>
                    <TooltipPopup side="top">{jumpLabel}</TooltipPopup>
                  </Tooltip>
                ) : (
                  <span
                    className={`text-3xs tabular-nums ${
                      isHighlighted ? "text-foreground" : "text-secondary-label"
                    }`}
                  >
                    <RelativeTime
                      timestamp={thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt}
                    />
                  </span>
                )}
              </span>
            </span>
          </div>
        </div>
      </div>
    </SidebarMenuSubItem>
  );
});

interface SidebarProjectThreadListProps {
  projectKey: string;
  projectExpanded: boolean;
  hasOverflowingThreads: boolean;
  hiddenThreadStatus: ThreadStatusPill | null;
  orderedProjectThreadKeys: readonly string[];
  renderedThreads: readonly SidebarThreadSummary[];
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
  isThreadListExpanded: boolean;
  activeRouteThreadKey: string | null;
  openPullRequestsInRightPanel: boolean;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  startThreadRename: (threadKey: string, title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedProjectThreadKeys: readonly string[],
  ) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => Promise<void>;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
  openPrLink: (
    event: React.MouseEvent<HTMLElement>,
    prUrl: string,
    threadRef?: ScopedThreadRef,
  ) => boolean;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
}

const SidebarProjectThreadList = memo(function SidebarProjectThreadList(
  props: SidebarProjectThreadListProps,
) {
  const {
    projectKey,
    projectExpanded,
    hasOverflowingThreads,
    hiddenThreadStatus,
    orderedProjectThreadKeys,
    renderedThreads,
    showEmptyThreadState,
    shouldShowThreadPanel,
    isThreadListExpanded,
    activeRouteThreadKey,
    openPullRequestsInRightPanel,
    threadJumpLabelByKey,
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    startThreadRename,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    attachThreadListAutoAnimateRef,
    handleThreadClick,
    navigateToThread,
    onFileDropThreads,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    openPrLink,
    expandThreadListForProject,
    collapseThreadListForProject,
  } = props;
  const showMoreButtonRender = <button type="button" />;
  const showLessButtonRender = <button type="button" />;

  return (
    <SidebarMenuSub
      ref={attachThreadListAutoAnimateRef}
      className="mx-0.5 my-0 w-full translate-x-0 overflow-hidden empty:hidden sm:mx-1"
    >
      {shouldShowThreadPanel && showEmptyThreadState ? (
        <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
          <div
            data-thread-selection-safe
            className="flex h-8 w-full translate-x-0 items-center px-2 text-left text-xs text-sidebar-muted-foreground/75"
          >
            <span>No threads yet</span>
          </div>
        </SidebarMenuSubItem>
      ) : null}
      {shouldShowThreadPanel &&
        renderedThreads.map((thread) => {
          const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          return (
            <SidebarThreadRow
              key={threadKey}
              thread={thread}
              orderedProjectThreadKeys={orderedProjectThreadKeys}
              isActive={activeRouteThreadKey === threadKey}
              openPullRequestsInRightPanel={openPullRequestsInRightPanel}
              jumpLabel={threadJumpLabelByKey.get(threadKey) ?? null}
              appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
              renamingThreadKey={renamingThreadKey}
              renamingTitle={renamingTitle}
              setRenamingTitle={setRenamingTitle}
              startThreadRename={startThreadRename}
              renamingInputRef={renamingInputRef}
              renamingCommittedRef={renamingCommittedRef}
              confirmingArchiveThreadKey={confirmingArchiveThreadKey}
              setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
              confirmArchiveButtonRefs={confirmArchiveButtonRefs}
              handleThreadClick={handleThreadClick}
              navigateToThread={navigateToThread}
              onFileDropThreads={onFileDropThreads}
              handleMultiSelectContextMenu={handleMultiSelectContextMenu}
              handleThreadContextMenu={handleThreadContextMenu}
              clearSelection={clearSelection}
              commitRename={commitRename}
              cancelRename={cancelRename}
              attemptArchiveThread={attemptArchiveThread}
              openPrLink={openPrLink}
            />
          );
        })}

      {projectExpanded && hasOverflowingThreads && !isThreadListExpanded && (
        <SidebarMenuSubItem className="w-full">
          <SidebarMenuSubButton
            render={showMoreButtonRender}
            data-thread-selection-safe
            size="sm"
            onClick={() => {
              expandThreadListForProject(projectKey);
            }}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {hiddenThreadStatus && <ThreadStatusLabel status={hiddenThreadStatus} compact />}
              <span>Show more</span>
            </span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      )}
      {projectExpanded && hasOverflowingThreads && isThreadListExpanded && (
        <SidebarMenuSubItem className="w-full">
          <SidebarMenuSubButton
            render={showLessButtonRender}
            data-thread-selection-safe
            size="sm"
            onClick={() => {
              collapseThreadListForProject(projectKey);
            }}
          >
            <span>Show less</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      )}
    </SidebarMenuSub>
  );
});

interface SidebarProjectItemProps {
  project: SidebarProjectSnapshot;
  isThreadListExpanded: boolean;
  activeRouteThreadKey: string | null;
  openPullRequestsInRightPanel: boolean;
  newThreadShortcutLabel: string | null;
  handleNewThread: ReturnType<typeof useNewThreadHandler>;
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  markThreadUnread: ReturnType<typeof useThreadActions>["markThreadUnread"];
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
  dragInProgressRef: React.RefObject<boolean>;
  suppressProjectClickAfterDragRef: React.RefObject<boolean>;
  suppressProjectClickForContextMenuRef: React.RefObject<boolean>;
  isManualProjectSorting: boolean;
  dragHandleProps: SortableProjectHandleProps | null;
}

function resolveProjectThreadStatus(
  thread: SidebarThreadSummary,
  lastVisitedAtByThreadKey: ReadonlyMap<string, string | undefined>,
) {
  const lastVisitedAt = lastVisitedAtByThreadKey.get(
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );
  return resolveThreadStatusPill({
    thread: {
      ...thread,
      ...(lastVisitedAt !== null && lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
    },
  });
}

// Thread derivations for one project row. Built in their own hooks so they reach
// SidebarProjectItem frozen: inline, its later calls made the compiler fuse the
// ordered keys with the route-dependent panel, handing every row a new array.
function useProjectThreads(project: SidebarProjectSnapshot) {
  const threadSortOrder = useClientSettings<SidebarThreadSortOrder>(
    (settings) => settings.sidebarThreadSortOrder,
  );
  const sidebarThreads = useThreadShellsForProjectRefs(project.memberProjectRefs);
  const threadLastVisitedAts = useUiStateStore(
    useShallow((state) =>
      sidebarThreads.map(
        (thread) =>
          state.threadLastVisitedAtById[
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
          ] ?? null,
      ),
    ),
  );
  const sidebarThreadByKey = new Map(
    sidebarThreads.map(
      (thread) =>
        [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
    ),
  );
  const memberProjectByScopedKey = new Map(
    project.memberProjects.map((member) => [
      scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
      member,
    ]),
  );
  const memberThreadCountByPhysicalKey = new Map<string, number>(
    project.memberProjects.map((member) => [member.physicalProjectKey, 0] as const),
  );
  for (const thread of sidebarThreads) {
    const member = memberProjectByScopedKey.get(
      scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
    );
    if (!member) {
      continue;
    }
    memberThreadCountByPhysicalKey.set(
      member.physicalProjectKey,
      (memberThreadCountByPhysicalKey.get(member.physicalProjectKey) ?? 0) + 1,
    );
  }
  const lastVisitedAtByThreadKey = new Map(
    sidebarThreads.map((thread, index) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      resolveThreadLastVisitedAt(thread.lastVisitedAt, threadLastVisitedAts[index] ?? undefined),
    ]),
  );
  const visibleProjectThreads = sortThreads(
    sidebarThreads.filter((thread) => thread.archivedAt === null),
    threadSortOrder,
  );
  const projectStatus = resolveProjectStatusIndicator(
    visibleProjectThreads.map((thread) =>
      resolveProjectThreadStatus(thread, lastVisitedAtByThreadKey),
    ),
  );
  const orderedProjectThreadKeys = visibleProjectThreads.map((thread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );
  return {
    sidebarThreads,
    sidebarThreadByKey,
    memberProjectByScopedKey,
    memberThreadCountByPhysicalKey,
    lastVisitedAtByThreadKey,
    visibleProjectThreads,
    projectStatus,
    orderedProjectThreadKeys,
  };
}

function useProjectThreadPanel(input: {
  visibleProjectThreads: readonly SidebarThreadSummary[];
  lastVisitedAtByThreadKey: ReadonlyMap<string, string | undefined>;
  activeRouteThreadKey: string | null;
  projectExpanded: boolean;
  isThreadListExpanded: boolean;
}) {
  const {
    visibleProjectThreads,
    lastVisitedAtByThreadKey,
    activeRouteThreadKey,
    projectExpanded,
    isThreadListExpanded,
  } = input;
  const sidebarThreadPreviewCount = useClientSettings<SidebarThreadPreviewCount>(
    (settings) => settings.sidebarThreadPreviewCount,
  );
  const activeThreadKey = activeRouteThreadKey ?? undefined;
  const pinnedCollapsedThread =
    !activeThreadKey || projectExpanded
      ? null
      : (visibleProjectThreads.find(
          (thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === activeThreadKey,
        ) ?? null);
  const hasOverflowingThreads = visibleProjectThreads.length > sidebarThreadPreviewCount;
  const previewThreads =
    isThreadListExpanded || !hasOverflowingThreads
      ? visibleProjectThreads
      : visibleProjectThreads.slice(0, sidebarThreadPreviewCount);
  const visibleThreadKeys = new Set(
    [...previewThreads, ...(pinnedCollapsedThread ? [pinnedCollapsedThread] : [])].map((thread) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    ),
  );
  const renderedThreads = pinnedCollapsedThread
    ? [pinnedCollapsedThread]
    : visibleProjectThreads.filter((thread) =>
        visibleThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
      );
  const hiddenThreads = visibleProjectThreads.filter(
    (thread) =>
      !visibleThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  return {
    hasOverflowingThreads,
    hiddenThreadStatus: resolveProjectStatusIndicator(
      hiddenThreads.map((thread) => resolveProjectThreadStatus(thread, lastVisitedAtByThreadKey)),
    ),
    renderedThreads,
    showEmptyThreadState: projectExpanded && visibleProjectThreads.length === 0,
    shouldShowThreadPanel: projectExpanded || pinnedCollapsedThread !== null,
  };
}

const SidebarProjectItem = memo(function SidebarProjectItem(props: SidebarProjectItemProps) {
  const {
    project,
    isThreadListExpanded,
    activeRouteThreadKey,
    openPullRequestsInRightPanel,
    newThreadShortcutLabel,
    handleNewThread,
    archiveThread,
    deleteThread,
    markThreadUnread,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandThreadListForProject,
    collapseThreadListForProject,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    isManualProjectSorting,
    dragHandleProps,
  } = props;
  const environmentMachine = project.allRemoteMembersAreWsl
    ? "linux"
    : project.allRemoteMembersAreDesktopLocal
      ? "laptop"
      : "cloud";
  const appSettingsConfirmThreadDelete = useClientSettings<boolean>(
    (settings) => settings.confirmThreadDelete,
  );
  const appSettingsConfirmThreadArchive = useClientSettings<boolean>(
    (settings) => settings.confirmThreadArchive,
  );
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const updateSettings = useUpdateClientSettings();
  const router = useRouter();
  const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
  const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
  const { isMobile, setOpenMobile } = useSidebar();
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
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
  const openPrLink = useOpenPrLink();
  const {
    sidebarThreads,
    sidebarThreadByKey,
    memberProjectByScopedKey,
    memberThreadCountByPhysicalKey,
    projectStatus,
    visibleProjectThreads,
    orderedProjectThreadKeys,
    lastVisitedAtByThreadKey,
  } = useProjectThreads(project);
  // The "Delete anyway" toast action runs after the toast delay, so it must see
  // the thread list as of the click, not as of the first prompt.
  const readSidebarThreadByKey = useStableCallback(() => sidebarThreadByKey);
  const projectPreferenceKeys = projectExpansionPreferenceKeys(project);
  const projectExpanded = useUiStateStore((state) =>
    resolveProjectExpanded(state.projectExpandedById, projectPreferenceKeys),
  );
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [confirmingArchiveThreadKey, setConfirmingArchiveThreadKey] = useState<string | null>(null);
  const [projectRenameTarget, setProjectRenameTarget] = useState<SidebarProjectGroupMember | null>(
    null,
  );
  const [projectRenameTitle, setProjectRenameTitle] = useState("");
  const canRenameProject = useEnvironmentScope(
    projectRenameTarget?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const [projectGroupingTarget, setProjectGroupingTarget] =
    useState<SidebarProjectGroupMember | null>(null);
  const [projectGroupingSelection, setProjectGroupingSelection] = useState<
    SidebarProjectGroupingMode | "inherit"
  >("inherit");
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const {
    hasOverflowingThreads,
    hiddenThreadStatus,
    renderedThreads,
    showEmptyThreadState,
    shouldShowThreadPanel,
  } = useProjectThreadPanel({
    visibleProjectThreads,
    lastVisitedAtByThreadKey,
    activeRouteThreadKey,
    projectExpanded,
    isThreadListExpanded,
  });

  const handleProjectButtonClick = (event: React.MouseEvent<HTMLButtonElement>) => {
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
    if (useThreadSelectionStore.getState().hasSelection()) {
      clearSelection();
    }
    setProjectExpanded(projectPreferenceKeys, !projectExpanded);
  };

  const handleProjectButtonKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (dragInProgressRef.current) {
      return;
    }
    setProjectExpanded(projectPreferenceKeys, !projectExpanded);
  };

  const handleProjectButtonPointerDownCapture = (event: React.PointerEvent<HTMLButtonElement>) => {
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
  };

  const openProjectRenameDialog = (member: SidebarProjectGroupMember) => {
    if (!checkTaskPermission(member.environmentId)) return;
    setProjectRenameTarget(member);
    setProjectRenameTitle(member.title);
  };

  const openProjectGroupingDialog = (member: SidebarProjectGroupMember) => {
    const overrideKey = deriveProjectGroupingOverrideKey(member);
    setProjectGroupingTarget(member);
    setProjectGroupingSelection(
      projectGroupingSettings.sidebarProjectGroupingOverrides?.[overrideKey] ?? "inherit",
    );
  };

  const removeProject = async (member: SidebarProjectGroupMember) => {
    const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
    const result = await deleteProject({
      environmentId: member.environmentId,
      input: {
        projectId: member.id,
        force: true,
      },
    });
    if (result._tag === "Failure") {
      return result;
    }
    await waitForProjectRemoval(memberProjectRef);
    const draftStore = useComposerDraftStore.getState();
    releaseProjectDraftUploads(
      memberProjectRef,
      sidebarThreads
        .filter(
          (thread) =>
            thread.environmentId === member.environmentId && thread.projectId === member.id,
        )
        .map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
    );
    const projectDraftThread = draftStore.getDraftThreadByProjectRef(memberProjectRef);
    if (projectDraftThread) {
      draftStore.clearDraftThread(projectDraftThread.draftId);
    }
    draftStore.clearProjectDraftThreadId(memberProjectRef);
    return result;
  };

  const handleRemoveProject = async (member: SidebarProjectGroupMember) => {
    if (!checkTaskPermission(member.environmentId)) return;
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
                if (!checkTaskPermission(member.environmentId)) return;

                const latestProjectThreads = Array.from(readSidebarThreadByKey().values()).filter(
                  (thread) =>
                    thread.environmentId === memberProjectRef.environmentId &&
                    thread.projectId === memberProjectRef.projectId,
                );
                const confirmed = await api.dialogs.confirm(
                  latestProjectThreads.length > 0
                    ? [
                        `Remove project "${member.title}" and delete its ${latestProjectThreads.length} thread${
                          latestProjectThreads.length === 1 ? "" : "s"
                        }?`,
                        `Path: ${member.workspaceRoot}`,
                        ...(member.environmentLabel
                          ? [`Environment: ${member.environmentLabel}`]
                          : []),
                        "This permanently clears conversation history for those threads and any archived threads.",
                        "This removes only this project entry.",
                        "This action cannot be undone.",
                      ].join("\n")
                    : [
                        `Remove project "${member.title}"?`,
                        `Path: ${member.workspaceRoot}`,
                        ...(member.environmentLabel
                          ? [`Environment: ${member.environmentLabel}`]
                          : []),
                        "This permanently clears any archived conversation history.",
                        "This removes only this project entry.",
                      ].join("\n"),
                  { variant: "destructive" },
                );
                if (!confirmed) {
                  return;
                }

                const result = await removeProject(member);
                if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                  const error = squashAtomCommandFailure(result);
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: `Failed to remove "${member.title}"`,
                      description:
                        error instanceof Error ? error.message : "Unknown error removing project.",
                    }),
                  );
                }
              })().catch((error) => {
                const message =
                  error instanceof Error ? error.message : "Unknown error removing project.";
                console.error("Failed to remove project", {
                  projectId: member.id,
                  environmentId: member.environmentId,
                  ...safeErrorLogAttributes(error),
                });
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: `Failed to remove "${member.title}"`,
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
      `Remove project "${member.title}"?`,
      `Path: ${member.workspaceRoot}`,
      ...(member.environmentLabel ? [`Environment: ${member.environmentLabel}`] : []),
      "This permanently clears any archived conversation history.",
      "This removes only this project entry.",
    ].join("\n");
    const confirmed = await api.dialogs.confirm(message, { variant: "destructive" });
    if (!confirmed) {
      return;
    }

    const result = await removeProject(member);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message = error instanceof Error ? error.message : "Unknown error removing project.";
      console.error("Failed to remove project", {
        projectId: member.id,
        environmentId: member.environmentId,
        ...safeErrorLogAttributes(error),
      });
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to remove "${member.title}"`,
          description: message,
        }),
      );
    }
  };

  const handleProjectButtonContextMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
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
              copyPathToClipboard(member.workspaceRoot, { path: member.workspaceRoot });
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
            ...(action === "delete" ? { icon: "trash" } : {}),
          };
        }

        return {
          id: `${action}:submenu`,
          label,
          ...(action === "delete" ? { icon: "trash" } : {}),
          children: project.memberProjects.map((member) =>
            makeLeaf(action, member, {
              ...(options?.destructive ? { destructive: true } : {}),
              ...(options?.isDisabled?.(member) ? { disabled: true } : {}),
            }),
          ),
        };
      };

      actionHandlers.set("project-settings", () => {
        if (isMobile) setOpenMobile(false);
        void router.navigate({
          to: "/projects/$projectKey",
          params: { projectKey: project.projectKey },
        });
      });

      const clicked = await api.contextMenu.show(
        [
          buildTargetedItem("rename", "Rename", {
            isDisabled: (member) =>
              !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
          }),
          buildTargetedItem("grouping", "Group into..."),
          buildTargetedItem("copy-path", "Copy Path"),
          { id: "project-settings", label: "Project settings", icon: "settings" },
          buildTargetedItem("delete", "Remove", {
            destructive: true,
            isDisabled: (member) =>
              !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
          }),
        ],
        {
          x: event.clientX,
          y: event.clientY,
        },
      );

      if (!clicked) {
        return;
      }

      await actionHandlers.get(clicked)?.();
    })();
  };

  const navigateToThread = (threadRef: ScopedThreadRef) => {
    if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
      clearSelection();
    }
    setSelectionAnchor(scopedThreadKey(threadRef));
    if (isMobile) {
      setOpenMobile(false);
    }
    return router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };
  const handleThreadFileDrop = async (threadRef: ScopedThreadRef, files: File[]) => {
    const dropId = queuePendingFileDrop({ threadRef, files });
    const targetPathname = router.buildLocation({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    }).pathname;
    if (targetPathname === router.state.location.pathname) return;
    try {
      await navigateToThread(threadRef);
      if (targetPathname !== router.state.location.pathname) {
        clearPendingFileDrop(dropId);
      }
    } catch {
      clearPendingFileDrop(dropId);
    }
  };

  const handleThreadClick = (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedProjectThreadKeys: readonly string[],
  ) => {
    if (isSidebarNestedLinkClick(event.target)) return;
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

    // Ignore the trailing click of a plain double-click so it doesn't navigate
    // while a double-click is starting an inline rename. Placed after the
    // modifier branches so cmd/shift selection still processes every click.
    if (isTrailingDoubleClick(event.detail)) {
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
    });
  };

  const handleMultiSelectContextMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
    if (threadKeys.length === 0) return;
    const count = threadKeys.length;
    const selectedThreadEntries = threadKeys.flatMap((threadKey) => {
      const threadRef = parseScopedThreadKey(threadKey);
      const thread = threadRef ? readThreadShell(threadRef) : null;
      return threadRef && thread ? [{ threadKey, threadRef, thread }] : [];
    });
    const hasRunningThread = selectedThreadEntries.some(
      ({ thread }) => !threadRuntimeCanArchive(thread.runtime),
    );
    const canOperateSelection = selectedThreadEntries.every(({ threadRef }) =>
      readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
    );

    const clicked = await api.contextMenu.show(
      buildMultiSelectThreadContextMenuItems({ count, hasRunningThread }).map((item) =>
        item.id === "archive" || item.id === "delete"
          ? { ...item, disabled: item.disabled || !canOperateSelection }
          : item,
      ),
      position,
    );

    if (clicked === "mark-unread") {
      for (const { threadRef } of selectedThreadEntries) {
        markThreadUnread(threadRef);
      }
      clearSelection();
      return;
    }

    if (
      (clicked === "archive" || clicked === "delete") &&
      !selectedThreadEntries.every(({ threadRef }) => checkTaskPermission(threadRef.environmentId))
    ) {
      return;
    }

    if (clicked === "archive") {
      if (appSettingsConfirmThreadArchive) {
        const confirmed = await api.dialogs.confirm(
          `Archive ${count} thread${count === 1 ? "" : "s"}?`,
        );
        if (!confirmed) return;
      }
      if (
        !selectedThreadEntries.every(({ threadRef }) =>
          checkTaskPermission(threadRef.environmentId),
        )
      ) {
        return;
      }

      const archiveOutcome = await archiveSelectedThreadEntries({
        entries: selectedThreadEntries,
        archive: ({ threadRef }, onArchived) => archiveThread(threadRef, { onArchived }),
      });
      for (const failure of archiveOutcome.followupFailures) {
        if (isAtomCommandInterrupted(failure)) continue;
        const error = squashAtomCommandFailure(failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Thread archived, but navigation failed",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      if (archiveOutcome.mutationFailure) {
        removeFromSelection(archiveOutcome.archivedThreadKeys);
        if (!isAtomCommandInterrupted(archiveOutcome.mutationFailure)) {
          const error = squashAtomCommandFailure(archiveOutcome.mutationFailure);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to archive threads",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      removeFromSelection(threadKeys);
      return;
    }

    if (clicked !== "delete") return;

    if (appSettingsConfirmThreadDelete) {
      const confirmed = await api.dialogs.confirm(
        [
          `Delete ${count} thread${count === 1 ? "" : "s"}?`,
          "This permanently clears conversation history for these threads.",
        ].join("\n"),
        { variant: "destructive" },
      );
      if (!confirmed) return;
    }
    if (
      !selectedThreadEntries.every(({ threadRef }) => checkTaskPermission(threadRef.environmentId))
    ) {
      return;
    }

    const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
      entries: selectedThreadEntries,
      delete: ({ threadRef }, deletedThreadKeys) => deleteThread(threadRef, { deletedThreadKeys }),
    });
    if (firstFailure !== null) {
      const firstError = squashAtomCommandFailure(firstFailure);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to delete threads",
          description: firstError instanceof Error ? firstError.message : "An error occurred.",
        }),
      );
    }
    removeFromSelection(
      getThreadKeysToDeselectAfterDelete(threadKeys, deletedThreadKeys, (threadKey) => {
        const threadRef = parseScopedThreadKey(threadKey);
        return threadRef !== null && readThreadShell(threadRef) !== null;
      }),
    );
  };

  const createThreadForProjectMember = (member: SidebarProjectGroupMember) => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void (async () => {
      const result = await settlePromise(() =>
        handleNewThread(scopeProjectRef(member.environmentId, member.id)),
      );
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not create thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleCreateThreadClick = (event: React.MouseEvent<HTMLButtonElement>) => {
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
      const clickedResult = await settlePromise(() =>
        api.contextMenu.show(
          project.memberProjects.map((member) => ({
            id: member.physicalProjectKey,
            label: formatProjectMemberActionLabel(member, project.groupedProjectCount),
          })),
          {
            x: event.clientX,
            y: event.clientY,
          },
        ),
      );
      if (clickedResult._tag === "Failure") {
        const error = squashAtomCommandFailure(clickedResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not choose environment",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      const clicked = clickedResult.value;
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
  };

  const attemptArchiveThread = async (threadRef: ScopedThreadRef) => {
    if (!checkTaskPermission(threadRef.environmentId)) return;
    const result = await archiveThread(threadRef);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to archive thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };

  const cancelRename = () => {
    setRenamingThreadKey(null);
    renamingInputRef.current = null;
  };

  const startThreadRename = (threadKey: string, title: string) => {
    const threadRef = parseScopedThreadKey(threadKey);
    if (!threadRef || !checkTaskPermission(threadRef.environmentId)) return;
    setRenamingThreadKey(threadKey);
    setRenamingTitle(title);
    renamingCommittedRef.current = false;
  };

  const commitRename = async (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => {
    const threadKey = scopedThreadKey(threadRef);
    const finishRename = () => {
      setRenamingThreadKey((current) => {
        if (current !== threadKey) return current;
        renamingInputRef.current = null;
        return null;
      });
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
    const result = await updateThreadMetadata({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        title: trimmed,
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
    finishRename();
  };

  const closeProjectRenameDialog = () => {
    setProjectRenameTarget(null);
    setProjectRenameTitle("");
  };

  const submitProjectRename = async () => {
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

    if (trimmed === projectRenameTarget.title) {
      closeProjectRenameDialog();
      return;
    }

    const result = await updateProject({
      environmentId: projectRenameTarget.environmentId,
      input: {
        projectId: projectRenameTarget.id,
        title: trimmed,
      },
    });
    if (result._tag === "Success") {
      closeProjectRenameDialog();
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };

  const closeProjectGroupingDialog = () => {
    setProjectGroupingTarget(null);
    setProjectGroupingSelection("inherit");
  };

  const saveProjectGroupingPreference = () => {
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
  };

  // Every thread row receives this, so it keeps one identity while the thread
  // list changes instead of re-rendering all of them.
  const handleThreadContextMenu = useStableCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKey = scopedThreadKey(threadRef);
      const thread = sidebarThreadByKey.get(threadKey) ?? null;
      if (!thread) return;
      const threadProject = memberProjectByScopedKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      const threadWorkspacePath =
        thread.worktreePath ?? threadProject?.workspaceRoot ?? project.workspaceRoot ?? null;
      const canOperateThread = readEnvironmentScope(
        thread.environmentId,
        AuthOrchestrationOperateScope,
      );
      const clicked = await api.contextMenu.show(
        [
          ...(thread.branch
            ? [{ id: "new-thread-on-branch", label: `New thread on ${thread.branch}` }]
            : []),
          { id: "rename", label: "Rename thread", disabled: !canOperateThread },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "project-settings", label: "Project settings" },
          {
            id: "delete",
            label: "Delete",
            destructive: true,
            icon: "trash",
            disabled: !canOperateThread,
          },
        ],
        position,
      );

      if (clicked === "project-settings") {
        if (isMobile) setOpenMobile(false);
        void router.navigate({
          to: "/projects/$projectKey",
          params: { projectKey: project.projectKey },
        });
        return;
      }

      if (clicked === "new-thread-on-branch") {
        const result = await settlePromise(() =>
          handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId), {
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            envMode: thread.worktreePath ? "worktree" : "local",
            startFromOrigin: false,
          }),
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "rename") {
        startThreadRename(threadKey, thread.title);
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadRef);
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
      if (clicked !== "delete") return;
      if (!checkTaskPermission(threadRef.environmentId)) return;
      if (appSettingsConfirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
          { variant: "destructive" },
        );
        if (!confirmed) {
          return;
        }
      }
      if (!checkTaskPermission(threadRef.environmentId)) return;
      const result = await deleteThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
  );

  return (
    <>
      <div className="group/project-header relative">
        <SidebarMenuButton
          ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
          className={isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : undefined}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
          onPointerDownCapture={handleProjectButtonPointerDownCapture}
          onClick={handleProjectButtonClick}
          onKeyDown={handleProjectButtonKeyDown}
          onContextMenu={handleProjectButtonContextMenu}
        >
          {!projectExpanded && projectStatus ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-label={projectStatus.label}
                    className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
                  />
                }
              >
                <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                  <span
                    className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                      projectStatus.pulse ? "animate-status-pulse" : ""
                    }`}
                  />
                </span>
                <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-icon-muted opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
              </TooltipTrigger>
              <TooltipPopup side="top">{projectStatus.label}</TooltipPopup>
            </Tooltip>
          ) : (
            <ChevronRightIcon
              className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                projectExpanded ? "rotate-90" : ""
              }`}
            />
          )}
          <span className="flex shrink-0">
            <ProjectFavicon project={project} />
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm font-medium text-sidebar-foreground/90">
              {project.displayName}
            </span>
            {project.groupedProjectCount > 1 ? (
              <span className="shrink-0 text-secondary-label text-3xs">
                {project.groupedProjectCount} projects
              </span>
            ) : null}
          </span>
          <span aria-hidden className="w-4 shrink-0 max-sm:w-10" />
        </SidebarMenuButton>

        {project.environmentPresence === "remote-only" && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  aria-label={
                    project.allRemoteMembersAreDesktopLocal
                      ? "Local sandbox project"
                      : "Remote project"
                  }
                  className="pointer-events-none absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-icon-muted transition-opacity duration-150 max-sm:right-7 group-hover/project-header:opacity-0 group-focus-within/project-header:opacity-0 max-sm:group-hover/project-header:opacity-100 max-sm:group-focus-within/project-header:opacity-100"
                />
              }
            >
              <EnvironmentMachineIcon kind={environmentMachine} className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {project.allRemoteMembersAreDesktopLocal
                ? `Local sandbox: ${project.remoteEnvironmentLabels.join(", ")}`
                : `Remote environment: ${project.remoteEnvironmentLabels.join(", ")}`}
            </TooltipPopup>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="pointer-events-none absolute top-[calc(50%+1px)] right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100">
                <button
                  type="button"
                  aria-label={`Create new thread in ${project.displayName}`}
                  data-testid="new-thread-button"
                  className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
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

      <SidebarProjectThreadList
        projectKey={project.projectKey}
        projectExpanded={projectExpanded}
        hasOverflowingThreads={hasOverflowingThreads}
        hiddenThreadStatus={hiddenThreadStatus}
        orderedProjectThreadKeys={orderedProjectThreadKeys}
        renderedThreads={renderedThreads}
        showEmptyThreadState={showEmptyThreadState}
        shouldShowThreadPanel={shouldShowThreadPanel}
        isThreadListExpanded={isThreadListExpanded}
        activeRouteThreadKey={activeRouteThreadKey}
        openPullRequestsInRightPanel={openPullRequestsInRightPanel}
        threadJumpLabelByKey={threadJumpLabelByKey}
        appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
        renamingThreadKey={renamingThreadKey}
        renamingTitle={renamingTitle}
        setRenamingTitle={setRenamingTitle}
        startThreadRename={startThreadRename}
        renamingInputRef={renamingInputRef}
        renamingCommittedRef={renamingCommittedRef}
        confirmingArchiveThreadKey={confirmingArchiveThreadKey}
        setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
        confirmArchiveButtonRefs={confirmArchiveButtonRefs}
        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
        handleThreadClick={handleThreadClick}
        navigateToThread={navigateToThread}
        onFileDropThreads={handleThreadFileDrop}
        handleMultiSelectContextMenu={handleMultiSelectContextMenu}
        handleThreadContextMenu={handleThreadContextMenu}
        clearSelection={clearSelection}
        commitRename={commitRename}
        cancelRename={cancelRename}
        attemptArchiveThread={attemptArchiveThread}
        openPrLink={openPrLink}
        expandThreadListForProject={expandThreadListForProject}
        collapseThreadListForProject={collapseThreadListForProject}
      />

      <Dialog
        open={projectRenameTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectRenameDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>
              {projectRenameTarget
                ? `Update the title for ${projectRenameTarget.workspaceRoot}.`
                : "Update the project title."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Project title</span>
              <Input
                aria-label="Project title"
                disabled={!canRenameProject}
                value={projectRenameTitle}
                onChange={(event) => setProjectRenameTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitProjectRename();
                  }
                }}
              />
            </div>
            {projectRenameTarget?.environmentLabel ? (
              <p className="text-xs text-muted-foreground">
                Environment: {projectRenameTarget.environmentLabel}
              </p>
            ) : null}
            {!canRenameProject ? (
              <p className="text-xs text-muted-foreground">
                This connection cannot change projects.
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectRenameDialog}>
              Cancel
            </Button>
            <Button disabled={!canRenameProject} onClick={() => void submitProjectRename()}>
              Save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={projectGroupingTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectGroupingDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Project grouping</DialogTitle>
            <DialogDescription>
              {projectGroupingTarget
                ? `Choose how ${projectGroupingTarget.workspaceRoot} should be grouped in the sidebar.`
                : "Choose how this project should be grouped in the sidebar."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Grouping rule</span>
              <Select
                value={projectGroupingSelection}
                onValueChange={(value) => {
                  if (
                    value === "inherit" ||
                    value === "repository" ||
                    value === "repository_path" ||
                    value === "separate"
                  ) {
                    setProjectGroupingSelection(value);
                  }
                }}
              >
                <SelectTrigger className="w-full" aria-label="Project grouping rule">
                  <SelectValue>
                    {projectGroupingSelection === "inherit"
                      ? `Use global default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                      : PROJECT_GROUPING_MODE_LABELS[projectGroupingSelection]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="inherit">
                    Use global default
                  </SelectItem>
                  <SelectItem hideIndicator value="repository">
                    {PROJECT_GROUPING_MODE_LABELS.repository}
                  </SelectItem>
                  <SelectItem hideIndicator value="repository_path">
                    {PROJECT_GROUPING_MODE_LABELS.repository_path}
                  </SelectItem>
                  <SelectItem hideIndicator value="separate">
                    {PROJECT_GROUPING_MODE_LABELS.separate}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              {projectGroupingSelection === "inherit"
                ? projectGroupingModeDescription(projectGroupingSettings.sidebarProjectGroupingMode)
                : projectGroupingModeDescription(projectGroupingSelection)}
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectGroupingDialog}>
              Cancel
            </Button>
            <Button onClick={saveProjectGroupingPreference}>Save</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});

const SidebarProjectListRow = memo(function SidebarProjectListRow(props: SidebarProjectItemProps) {
  return (
    <SidebarMenuItem>
      <SidebarProjectItem {...props} />
    </SidebarMenuItem>
  );
});

function LocalSecondaryStatus() {
  const { environments } = useEnvironments();
  // The desktop reports which local secondary backends (e.g. the WSL backend)
  // exist; the hook polls because the bridge has no change event.
  const secondaries = useDesktopLocalBootstraps();

  const localEnvByUrl = (() => {
    const map = new Map<string, { phase: string; error: string | null }>();
    for (const environment of environments) {
      if (
        isDesktopLocalConnectionTarget(environment.entry.target) &&
        environment.displayUrl !== null
      ) {
        map.set(environment.displayUrl, {
          phase: environment.connection.phase,
          error: environment.connection.error,
        });
      }
    }
    return map;
  })();

  const connecting: string[] = [];
  const failed: Array<{ label: string; error: string | null }> = [];
  for (const bootstrap of secondaries) {
    const env =
      bootstrap.httpBaseUrl !== null ? localEnvByUrl.get(bootstrap.httpBaseUrl) : undefined;
    if (env?.phase === "connected") {
      continue;
    }
    if (env?.phase === "error") {
      failed.push({ label: bootstrap.label, error: env.error });
      continue;
    }
    connecting.push(bootstrap.label);
  }

  if (connecting.length === 0 && failed.length === 0) {
    return null;
  }

  return (
    <SidebarGroup>
      {connecting.length > 0 ? (
        <Alert variant="sidebar">
          <Spinner />
          <AlertTitle>Connecting {connecting.join(", ")}</AlertTitle>
        </Alert>
      ) : null}
      {failed.length > 0 ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>Couldn't connect {failed.map((entry) => entry.label).join(", ")}</AlertTitle>
          <AlertDescription>
            {failed
              .map((entry) => entry.error)
              .filter(Boolean)
              .join("; ") || "The backend didn't respond."}
          </AlertDescription>
        </Alert>
      ) : null}
    </SidebarGroup>
  );
}

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  threadPreviewCount,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
  onThreadPreviewCountChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  threadPreviewCount: SidebarThreadPreviewCount;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  onThreadPreviewCountChange: (count: SidebarThreadPreviewCount) => void;
}) {
  const handleThreadPreviewCountChange = (nextValue: number | null) => {
    if (nextValue === null) {
      return;
    }

    const clampedValue = clampSidebarThreadPreviewCount(nextValue);
    if (clampedValue !== threadPreviewCount) {
      onThreadPreviewCountChange(clampedValue);
    }
  };

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost-muted" aria-label="Sidebar options" />}
            />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sidebar options</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
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
                <MenuRadioItem key={value} value={value}>
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 sm:text-xs font-medium text-muted-foreground">
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
              <MenuRadioItem key={value} value={value}>
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 text-muted-foreground sm:text-xs font-medium">
            Visible threads
          </div>
          <div className="px-2 py-1">
            <NumberField
              aria-label="Visible thread count"
              className="w-28"
              max={MAX_SIDEBAR_THREAD_PREVIEW_COUNT}
              min={MIN_SIDEBAR_THREAD_PREVIEW_COUNT}
              onValueChange={handleThreadPreviewCountChange}
              size="sm"
              step={1}
              value={threadPreviewCount}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement
                  aria-label="Decrease visible thread count"
                  className="[&_svg]:size-3.5"
                />
                <NumberFieldInput
                  aria-label="Visible thread count"
                  inputMode="numeric"
                  onKeyDownCapture={(event) => {
                    event.stopPropagation();
                  }}
                />
                <NumberFieldIncrement
                  aria-label="Increase visible thread count"
                  className="[&_svg]:size-3.5"
                />
              </NumberFieldGroup>
            </NumberField>
          </div>
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
      } ${isOver && !isDragging ? "ring-1 ring-inset ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

interface SidebarProjectsContentProps {
  showArm64IntelBuildWarning: boolean;
  arm64IntelBuildWarningDescription: string | null;
  desktopUpdateButtonAction: "download" | "install" | "none";
  desktopUpdateButtonDisabled: boolean;
  desktopUpdateActionPending: boolean;
  handleDesktopUpdateButtonClick: () => void;
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  threadPreviewCount: SidebarThreadPreviewCount;
  updateSettings: ReturnType<typeof useUpdateClientSettings>;
  openAddProject: () => void;
  isManualProjectSorting: boolean;
  projectDnDSensors: ReturnType<typeof useSensors>;
  projectCollisionDetection: CollisionDetection;
  handleProjectDragStart: (event: DragStartEvent) => void;
  handleProjectDragEnd: (event: DragEndEvent) => void;
  handleProjectDragCancel: (event: DragCancelEvent) => void;
  handleNewThread: ReturnType<typeof useNewThreadHandler>;
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  markThreadUnread: ReturnType<typeof useThreadActions>["markThreadUnread"];
  sortedProjects: readonly SidebarProjectSnapshot[];
  sortedProjectKeys: string[];
  expandedThreadListsByProject: ReadonlySet<string>;
  activeRouteProjectKey: string | null;
  routeThreadKey: string | null;
  openPullRequestsInRightPanel: boolean;
  newThreadShortcutLabel: string | null;
  commandPaletteShortcutLabel: string | null;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
  dragInProgressRef: React.RefObject<boolean>;
  suppressProjectClickAfterDragRef: React.RefObject<boolean>;
  suppressProjectClickForContextMenuRef: React.RefObject<boolean>;
  attachProjectListAutoAnimateRef: (node: HTMLElement | null) => void;
  projectsLength: number;
}

const SidebarProjectsContent = memo(function SidebarProjectsContent(
  props: SidebarProjectsContentProps,
) {
  const {
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    desktopUpdateActionPending,
    handleDesktopUpdateButtonClick,
    projectSortOrder,
    threadSortOrder,
    threadPreviewCount,
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
    deleteThread,
    markThreadUnread,
    sortedProjects,
    sortedProjectKeys,
    expandedThreadListsByProject,
    activeRouteProjectKey,
    routeThreadKey,
    openPullRequestsInRightPanel,
    newThreadShortcutLabel,
    commandPaletteShortcutLabel,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandThreadListForProject,
    collapseThreadListForProject,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    attachProjectListAutoAnimateRef,
    projectsLength,
  } = props;

  const handleProjectSortOrderChange = (sortOrder: SidebarProjectSortOrder) => {
    updateSettings({ sidebarProjectSortOrder: sortOrder });
  };
  const handleThreadSortOrderChange = (sortOrder: SidebarThreadSortOrder) => {
    updateSettings({ sidebarThreadSortOrder: sortOrder });
  };
  const handleThreadPreviewCountChange = (count: SidebarThreadPreviewCount) => {
    updateSettings({ sidebarThreadPreviewCount: count });
  };

  return (
    <SidebarContent
      fixedHeader={
        <SidebarGroup className="z-[1]">
          <SidebarMenu>
            <SidebarMenuItem>
              <CommandDialogTrigger
                render={<SidebarMenuButton data-testid="command-palette-trigger" />}
              >
                <SearchIcon />
                <span className="flex-1 truncate">Search</span>
                {commandPaletteShortcutLabel ? <Kbd>{commandPaletteShortcutLabel}</Kbd> : null}
              </CommandDialogTrigger>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      }
    >
      {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
        <SidebarGroup>
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>Intel build on Apple Silicon</AlertTitle>
            <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
            {desktopUpdateButtonAction !== "none" ? (
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={desktopUpdateButtonDisabled || desktopUpdateActionPending}
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
      <LocalSecondaryStatus />
      <SidebarGroup>
        <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
          <span className="text-xs font-medium text-sidebar-muted-foreground/80">Projects</span>
          <div className="flex items-center gap-1">
            <ProjectSortMenu
              projectSortOrder={projectSortOrder}
              threadSortOrder={threadSortOrder}
              threadPreviewCount={threadPreviewCount}
              onProjectSortOrderChange={handleProjectSortOrderChange}
              onThreadSortOrderChange={handleThreadSortOrderChange}
              onThreadPreviewCountChange={handleThreadPreviewCountChange}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Add project"
                    data-testid="sidebar-add-project-trigger"
                    onClick={openAddProject}
                  />
                }
              >
                <FolderPlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="right">Add project</TooltipPopup>
            </Tooltip>
          </div>
        </div>

        {isManualProjectSorting ? (
          <DndContext
            sensors={projectDnDSensors}
            collisionDetection={projectCollisionDetection}
            modifiers={PROJECT_DND_MODIFIERS}
            onDragStart={handleProjectDragStart}
            onDragEnd={handleProjectDragEnd}
            onDragCancel={handleProjectDragCancel}
          >
            <SidebarMenu>
              <SortableContext items={sortedProjectKeys} strategy={verticalListSortingStrategy}>
                {sortedProjects.map((project) => (
                  <SortableProjectItem key={project.projectKey} projectId={project.projectKey}>
                    {(dragHandleProps) => (
                      <SidebarProjectItem
                        project={project}
                        isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                        activeRouteThreadKey={
                          activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                        }
                        openPullRequestsInRightPanel={openPullRequestsInRightPanel}
                        newThreadShortcutLabel={newThreadShortcutLabel}
                        handleNewThread={handleNewThread}
                        archiveThread={archiveThread}
                        deleteThread={deleteThread}
                        markThreadUnread={markThreadUnread}
                        threadJumpLabelByKey={threadJumpLabelByKey}
                        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                        expandThreadListForProject={expandThreadListForProject}
                        collapseThreadListForProject={collapseThreadListForProject}
                        dragInProgressRef={dragInProgressRef}
                        suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                        suppressProjectClickForContextMenuRef={
                          suppressProjectClickForContextMenuRef
                        }
                        isManualProjectSorting={isManualProjectSorting}
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
                isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                activeRouteThreadKey={
                  activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                }
                openPullRequestsInRightPanel={openPullRequestsInRightPanel}
                newThreadShortcutLabel={newThreadShortcutLabel}
                handleNewThread={handleNewThread}
                archiveThread={archiveThread}
                deleteThread={deleteThread}
                markThreadUnread={markThreadUnread}
                threadJumpLabelByKey={threadJumpLabelByKey}
                attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                expandThreadListForProject={expandThreadListForProject}
                collapseThreadListForProject={collapseThreadListForProject}
                dragInProgressRef={dragInProgressRef}
                suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
                isManualProjectSorting={isManualProjectSorting}
                dragHandleProps={null}
              />
            ))}
          </SidebarMenu>
        )}

        {projectsLength === 0 && (
          <div className="px-2 pt-4 text-center text-secondary-label text-xs">No projects yet</div>
        )}
      </SidebarGroup>
    </SidebarContent>
  );
});

const PROJECT_POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } };
const PROJECT_DND_MODIFIERS = [restrictToVerticalAxis, restrictToFirstScrollableAncestor];

const projectCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) {
    return pointerCollisions;
  }

  return closestCorners(args);
};

function openAddProjectCommandPalette() {
  openCommandPalette({ open: "add-project" });
}

// Project and thread derivations live in their own hooks so they reach
// LegacySidebar frozen and cached on their real inputs; inline, its later hook
// calls made the compiler recompute them, and the props of every row with them.
function useLegacySidebarProjects() {
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const desktopLocalEnvironmentIds = new Set(
    environments
      .filter((environment) => isDesktopLocalConnectionTarget(environment.entry.target))
      .map((environment) => environment.environmentId),
  );
  const wslEnvironmentIds = new Set(
    environments
      .filter((environment) => isWslConnectionTarget(environment.entry.target))
      .map((environment) => environment.environmentId),
  );
  const orderedProjects = orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const physicalToLogicalKey = buildPhysicalToLogicalProjectKeyMap({
    projects: orderedProjects,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
  });
  const projectPhysicalKeyByScopedRef = new Map(
    orderedProjects.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      derivePhysicalProjectKey(project),
    ]),
  );
  const sidebarProjects: SidebarProjectSnapshot[] = buildSidebarProjectSnapshots({
    projects: orderedProjects,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
    isDesktopLocalEnvironment: (environmentId) => desktopLocalEnvironmentIds.has(environmentId),
    isWslEnvironment: (environmentId) => wslEnvironmentIds.has(environmentId),
  });
  return {
    projectsLength: projects.length,
    orderedProjects,
    physicalToLogicalKey,
    projectPhysicalKeyByScopedRef,
    sidebarProjects,
  };
}

// Kept apart from useLegacySidebarProjects so a thread change re-sorts the
// projects without rebuilding their snapshots, which every project row keys on.
function useSortedLegacySidebarProjects(input: {
  sidebarProjects: readonly SidebarProjectSnapshot[];
  physicalToLogicalKey: ReadonlyMap<string, string>;
  projectPhysicalKeyByScopedRef: ReadonlyMap<string, string>;
  sidebarProjectSortOrder: SidebarProjectSortOrder;
}) {
  const {
    sidebarProjects,
    physicalToLogicalKey,
    projectPhysicalKeyByScopedRef,
    sidebarProjectSortOrder,
  } = input;
  const sidebarThreads = useThreadShells();
  const sidebarProjectByKey = new Map(
    sidebarProjects.map((project) => [project.projectKey, project] as const),
  );
  const sortableProjects = sidebarProjects.map((project) => ({
    ...project,
    id: project.projectKey,
  }));
  const sortableThreads = sidebarThreads
    .filter((thread) => thread.archivedAt === null)
    .map((thread) => {
      const physicalKey =
        projectPhysicalKeyByScopedRef.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      return {
        ...thread,
        projectId: (physicalToLogicalKey.get(physicalKey) ?? physicalKey) as ProjectId,
      };
    });
  const sortedProjects = sortProjectsForSidebar(
    sortableProjects,
    sortableThreads,
    sidebarProjectSortOrder,
  ).flatMap((project) => {
    const resolvedProject = sidebarProjectByKey.get(project.id);
    return resolvedProject ? [resolvedProject] : [];
  });
  return {
    sortedProjects,
    sortedProjectKeys: sortedProjects.map((project) => project.projectKey),
  };
}

function useLegacySidebarThreads(input: {
  sortedProjects: readonly SidebarProjectSnapshot[];
  physicalToLogicalKey: ReadonlyMap<string, string>;
  projectPhysicalKeyByScopedRef: ReadonlyMap<string, string>;
  routeThreadKey: string | null;
  sidebarThreadSortOrder: SidebarThreadSortOrder;
  sidebarThreadPreviewCount: number;
  expandedThreadListsByProject: ReadonlySet<string>;
}) {
  const {
    sortedProjects,
    physicalToLogicalKey,
    projectPhysicalKeyByScopedRef,
    routeThreadKey,
    sidebarThreadSortOrder,
    sidebarThreadPreviewCount,
    expandedThreadListsByProject,
  } = input;
  const sidebarThreads = useThreadShells();
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const sidebarThreadByKey = new Map(
    sidebarThreads.map(
      (thread) =>
        [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
    ),
  );
  const logicalProjectKeyForThread = (thread: SidebarThreadSummary) => {
    const physicalKey =
      projectPhysicalKeyByScopedRef.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    return physicalToLogicalKey.get(physicalKey) ?? physicalKey;
  };
  const activeRouteThread = routeThreadKey ? sidebarThreadByKey.get(routeThreadKey) : undefined;
  const activeRouteProjectKey = activeRouteThread
    ? logicalProjectKeyForThread(activeRouteThread)
    : null;
  const threadsByProjectKey = new Map<string, SidebarThreadSummary[]>();
  for (const thread of sidebarThreads) {
    const logicalKey = logicalProjectKeyForThread(thread);
    const existing = threadsByProjectKey.get(logicalKey);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectKey.set(logicalKey, [thread]);
    }
  }
  const visibleSidebarThreadKeys = sortedProjects.flatMap((project) => {
    const projectThreads = sortThreads(
      (threadsByProjectKey.get(project.projectKey) ?? []).filter(
        (thread) => thread.archivedAt === null,
      ),
      sidebarThreadSortOrder,
    );
    const projectExpanded = resolveProjectExpanded(
      projectExpandedById,
      projectExpansionPreferenceKeys(project),
    );
    const activeThreadKey = routeThreadKey ?? undefined;
    const pinnedCollapsedThread =
      !projectExpanded && activeThreadKey
        ? (projectThreads.find(
            (thread) =>
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === activeThreadKey,
          ) ?? null)
        : null;
    const shouldShowThreadPanel = projectExpanded || pinnedCollapsedThread !== null;
    if (!shouldShowThreadPanel) {
      return [];
    }
    const isThreadListExpanded = expandedThreadListsByProject.has(project.projectKey);
    const hasOverflowingThreads = projectThreads.length > sidebarThreadPreviewCount;
    const previewThreads =
      isThreadListExpanded || !hasOverflowingThreads
        ? projectThreads
        : projectThreads.slice(0, sidebarThreadPreviewCount);
    const renderedThreads = pinnedCollapsedThread ? [pinnedCollapsedThread] : previewThreads;
    return renderedThreads.map((thread) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    );
  });
  const threadJumpCommandByKey = new Map<
    string,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >();
  for (const [visibleThreadIndex, threadKey] of visibleSidebarThreadKeys.entries()) {
    const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
    if (!jumpCommand) {
      break;
    }
    threadJumpCommandByKey.set(threadKey, jumpCommand);
  }
  const prewarmedSidebarThreadRefs = getSidebarThreadIdsToPrewarm(visibleSidebarThreadKeys).flatMap(
    (threadKey) => {
      const ref = parseScopedThreadKey(threadKey);
      return ref ? [ref] : [];
    },
  );
  return {
    sidebarThreadByKey,
    activeRouteProjectKey,
    visibleSidebarThreadKeys,
    threadJumpCommandByKey,
    threadJumpThreadKeys: [...threadJumpCommandByKey.keys()],
    prewarmedSidebarThreadRefs,
  };
}

export default function LegacySidebar() {
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const navigate = useNavigate();
  const sidebarThreadSortOrder = useClientSettings((s) => s.sidebarThreadSortOrder);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const sidebarThreadPreviewCount = useClientSettings((s) => s.sidebarThreadPreviewCount);
  const updateSettings = useUpdateClientSettings();
  const handleNewThread = useNewThreadHandler();
  const { archiveThread, deleteThread, markThreadUnread } = useThreadActions();
  const { isMobile, setOpenMobile } = useSidebar();
  const routeTarget = useThreadRouteTarget();
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraftThread);
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const desktopUpdateState = useDesktopUpdateState();
  const [desktopUpdateActionPending, setDesktopUpdateActionPending] = useState(false);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const platform = navigator.platform;
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const {
    projectsLength,
    orderedProjects,
    physicalToLogicalKey,
    projectPhysicalKeyByScopedRef,
    sidebarProjects,
  } = useLegacySidebarProjects();
  const { sortedProjects, sortedProjectKeys } = useSortedLegacySidebarProjects({
    sidebarProjects,
    physicalToLogicalKey,
    projectPhysicalKeyByScopedRef,
    sidebarProjectSortOrder,
  });
  const {
    sidebarThreadByKey,
    activeRouteProjectKey,
    visibleSidebarThreadKeys,
    threadJumpCommandByKey,
    threadJumpThreadKeys,
    prewarmedSidebarThreadRefs,
  } = useLegacySidebarThreads({
    sortedProjects,
    physicalToLogicalKey,
    projectPhysicalKeyByScopedRef,
    routeThreadKey,
    sidebarThreadSortOrder,
    sidebarThreadPreviewCount,
    expandedThreadListsByProject,
  });
  const newThreadShortcutLabelOptions = {
    platform,
    context: {
      terminalFocus: false,
      terminalOpen: false,
    },
  };
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", newThreadShortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", newThreadShortcutLabelOptions);

  const navigateToThread = (threadRef: ScopedThreadRef) => {
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
    });
  };

  const projectDnDSensors = useSensors(useSensor(PointerSensor, PROJECT_POINTER_SENSOR_OPTIONS));

  // DndContext keeps these across a drag, so they keep one identity and read the
  // latest projects when called.
  const handleProjectDragEnd = useStableCallback((event: DragEndEvent) => {
    if (sidebarProjectSortOrder !== "manual") {
      dragInProgressRef.current = false;
      return;
    }
    dragInProgressRef.current = false;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeProject = sidebarProjects.find((project) => project.projectKey === active.id);
    const overProject = sidebarProjects.find((project) => project.projectKey === over.id);
    if (!activeProject || !overProject) return;
    const activeMemberKeys = activeProject.memberProjects.map(
      (member) => member.physicalProjectKey,
    );
    const overMemberKeys = overProject.memberProjects.map((member) => member.physicalProjectKey);
    reorderProjects(orderedProjects.map(getProjectOrderKey), activeMemberKeys, overMemberKeys);
  });

  const handleProjectDragStart = useStableCallback((_event: DragStartEvent) => {
    if (sidebarProjectSortOrder !== "manual") {
      return;
    }
    dragInProgressRef.current = true;
    suppressProjectClickAfterDragRef.current = true;
  });

  const handleProjectDragCancel = (_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  };

  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());
  const attachProjectListAutoAnimateRef = (node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  };

  const animatedThreadListsRef = useRef(new WeakSet<HTMLElement>());
  const attachThreadListAutoAnimateRef = (node: HTMLElement | null) => {
    if (!node || animatedThreadListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedThreadListsRef.current.add(node);
  };

  const isManualProjectSorting = sidebarProjectSortOrder === "manual";
  // Built before the modifier-dependent shortcut context so the compiler gives it
  // its own cache; every project row keys on this map.
  const threadJumpLabelByKey = buildThreadJumpLabelMap({
    keybindings,
    platform,
    terminalOpen: routeTerminalOpen,
    threadJumpCommandByKey,
  });
  const sidebarShortcutContext = {
    terminalFocus: terminalFocused,
    terminalOpen: routeTerminalOpen,
    modelPickerOpen: isModelPickerOpen(),
  };
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

  const onWindowKeyDown = useEffectEvent((event: globalThis.KeyboardEvent) => {
    const shortcutContext = {
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeTerminalOpen,
      modelPickerOpen: isModelPickerOpen(),
    };

    if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
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
  });
  useEffect(() => {
    const handleWindowKeyDown = (event: globalThis.KeyboardEvent) => onWindowKeyDown(event);
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, []);

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (!useThreadSelectionStore.getState().hasSelection()) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection]);

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
  const commandPaletteShortcutLabel = isMobile
    ? null
    : shortcutLabelForCommand(keybindings, "commandPalette.toggle", newThreadShortcutLabelOptions);
  const handleDesktopUpdateButtonClick = async () => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (
      desktopUpdateButtonDisabled ||
      desktopUpdateButtonAction === "none" ||
      desktopUpdateActionPending
    ) {
      return;
    }

    setDesktopUpdateActionPending(true);

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            showDesktopUpdateDownloadedToast(bridge, result.state);
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
        })
        .finally(() => setDesktopUpdateActionPending(false));
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
        );
      } catch (error) {
        setDesktopUpdateActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return;
      }
      if (!confirmed) {
        setDesktopUpdateActionPending(false);
        return;
      }
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
        })
        .finally(() => setDesktopUpdateActionPending(false));
    }
  };

  const expandThreadListForProject = (projectKey: string) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectKey)) return current;
      const next = new Set(current);
      next.add(projectKey);
      return next;
    });
  };

  const collapseThreadListForProject = (projectKey: string) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectKey)) return current;
      const next = new Set(current);
      next.delete(projectKey);
      return next;
    });
  };

  return (
    <>
      {prewarmedSidebarThreadRefs.map((threadRef) => (
        <SidebarThreadDetailPrewarmer key={scopedThreadKey(threadRef)} threadRef={threadRef} />
      ))}
      <SidebarChromeHeader isElectron={isElectron} />

      <SidebarProjectsContent
        showArm64IntelBuildWarning={showArm64IntelBuildWarning}
        arm64IntelBuildWarningDescription={arm64IntelBuildWarningDescription}
        desktopUpdateButtonAction={desktopUpdateButtonAction}
        desktopUpdateButtonDisabled={desktopUpdateButtonDisabled}
        desktopUpdateActionPending={desktopUpdateActionPending}
        handleDesktopUpdateButtonClick={handleDesktopUpdateButtonClick}
        projectSortOrder={sidebarProjectSortOrder}
        threadSortOrder={sidebarThreadSortOrder}
        threadPreviewCount={sidebarThreadPreviewCount}
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
        deleteThread={deleteThread}
        markThreadUnread={markThreadUnread}
        sortedProjects={sortedProjects}
        sortedProjectKeys={sortedProjectKeys}
        expandedThreadListsByProject={expandedThreadListsByProject}
        activeRouteProjectKey={activeRouteProjectKey}
        routeThreadKey={routeThreadKey}
        openPullRequestsInRightPanel={routeThreadRef !== null}
        newThreadShortcutLabel={newThreadShortcutLabel}
        commandPaletteShortcutLabel={commandPaletteShortcutLabel}
        threadJumpLabelByKey={visibleThreadJumpLabelByKey}
        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
        expandThreadListForProject={expandThreadListForProject}
        collapseThreadListForProject={collapseThreadListForProject}
        dragInProgressRef={dragInProgressRef}
        suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
        suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
        attachProjectListAutoAnimateRef={attachProjectListAutoAnimateRef}
        projectsLength={projectsLength}
      />
      <SidebarChromeFooter />
    </>
  );
}
