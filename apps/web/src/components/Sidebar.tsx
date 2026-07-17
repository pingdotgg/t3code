import {
  ArchiveIcon,
  ArrowUpDownIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  CircleXIcon,
  CloudIcon,
  ContainerIcon,
  FolderPlusIcon,
  Globe2Icon,
  InboxIcon,
  LoaderIcon,
  MessageSquareWarningIcon,
  PauseIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  ChangeRequestStatusIcon,
  prStatusIndicator,
  resolveThreadPr,
  terminalStatusFromRunningIds,
  ThreadWorktreeIndicator,
} from "./ThreadStatusIndicators";
import { ProjectFavicon } from "./ProjectFavicon";
import { useAtomValue } from "@effect/atom-react";
import { autoAnimate } from "@formkit/auto-animate";
import React, { useCallback, useEffect, memo, useMemo, useRef, useState } from "react";
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
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ScopedThreadRef,
  type ResolvedKeybindingsConfig,
  type SidebarProjectGroupingMode,
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
import { Link, useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import {
  MAX_SIDEBAR_OLDER_AFTER_DAYS,
  MIN_SIDEBAR_OLDER_AFTER_DAYS,
  type SidebarOlderAfterDays,
  type SidebarProjectSortOrder,
  type SidebarThreadLayout,
  type SidebarThreadPreviewCount,
  type SidebarThreadSortOrder,
} from "@t3tools/contracts/settings";
import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import { isElectron } from "../env";
import { APP_STAGE_LABEL } from "../branding";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isMacPlatform } from "../lib/utils";
import {
  readThreadShell,
  useProject,
  useProjects,
  useServerConfigs,
  useThreadShells,
  useThreadShellsForProjectRefs,
} from "../state/entities";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { useThreadDiscoveredPorts } from "../portDiscoveryState";
import { openDiscoveredPort } from "./preview/openDiscoveredPort";
import { useAtomCommand } from "../state/use-atom-command";
import { previewEnvironment } from "../state/preview";
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
import { readLocalApi } from "../localApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useDesktopUpdateState } from "../state/desktopUpdate";

import { useThreadActions } from "../hooks/useThreadActions";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { threadEnvironment, useEnvironmentThread } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import {
  buildThreadRouteParams,
  resolveThreadRouteRef,
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
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
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
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenuButton,
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import {
  getSidebarThreadIdsToPrewarm,
  resolveAdjacentThreadId,
  isContextMenuPointerDown,
  isTrailingDoubleClick,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarStageBadgeLabel,
  resolveThreadStatusPill,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  useThreadJumpHintVisibility,
  ThreadStatusPill,
} from "./Sidebar.logic";
import { sortThreads } from "../lib/threadSort";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  useOpenAddProjectCommandPalette,
  useOpenNewThreadProjectCommandPalette,
} from "../commandPaletteContext";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { CommandDialogTrigger } from "./ui/command";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { primaryServerConfigAtom, primaryServerKeybindingsAtom } from "../state/server";
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
import { SidebarProviderUpdatePill } from "./sidebar/SidebarProviderUpdatePill";
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
  "inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-[calc(--spacing(1)-1px)] text-muted-foreground/60 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring";
const SIDEBAR_UNGROUPED_ACTIVE_ORDER = -10;

type SidebarThreadSection = "needs" | "failed" | "completed" | "working" | "recent" | "older";
type SidebarProjectRailStatus = "failed" | "needs" | "completed" | "working";
type SidebarFocusSectionCounts = Record<"needs" | "failed" | "completed" | "working", number>;

type SidebarThreadVisualSignal =
  | "approval"
  | "input"
  | "plan"
  | "failed"
  | "completed"
  | "working"
  | "connecting"
  | "interrupted"
  | "inactive";

function getSidebarThreadVisualSignal(
  thread: SidebarThreadSummary,
  status: ThreadStatusPill | null,
): SidebarThreadVisualSignal {
  if (status?.label === "Pending Approval") return "approval";
  if (status?.label === "Awaiting Input") return "input";
  if (status?.label === "Plan Ready") return "plan";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "failed";
  if (status?.label === "Completed") return "completed";
  if (status?.label === "Connecting") return "connecting";
  if (status?.label === "Working") return "working";
  if (thread.session?.status === "interrupted" || thread.latestTurn?.state === "interrupted") {
    return "interrupted";
  }
  return "inactive";
}

function sidebarThreadSignalLabel(signal: SidebarThreadVisualSignal): string {
  switch (signal) {
    case "approval":
      return "Approval needed";
    case "input":
      return "Waiting for you";
    case "plan":
      return "Plan ready";
    case "failed":
      return "Failed";
    case "completed":
      return "Completed";
    case "working":
      return "Working";
    case "connecting":
      return "Connecting";
    case "interrupted":
      return "Interrupted";
    case "inactive":
      return "Inactive";
  }
}

function sidebarThreadSignalClass(signal: SidebarThreadVisualSignal): string {
  switch (signal) {
    case "approval":
      return "bg-amber-500 text-amber-950";
    case "input":
      return "bg-indigo-500 text-white";
    case "plan":
      return "bg-violet-500/15 text-violet-600 dark:text-violet-300";
    case "failed":
      return "bg-red-500/15 text-red-600 dark:text-red-300";
    case "completed":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "working":
    case "connecting":
      return "bg-sky-500/15 text-sky-600 dark:text-sky-300";
    case "interrupted":
      return "bg-muted text-muted-foreground";
    case "inactive":
      return "bg-muted text-muted-foreground/65";
  }
}

function SidebarThreadSignalIcon({ signal }: { signal: SidebarThreadVisualSignal }) {
  switch (signal) {
    case "approval":
    case "input":
      return <MessageSquareWarningIcon className="size-3" />;
    case "plan":
      return <SquarePenIcon className="size-3" />;
    case "failed":
      return <CircleXIcon className="size-3" />;
    case "completed":
      return <CheckIcon className="size-3" />;
    case "working":
    case "connecting":
      return <LoaderIcon className="size-3 animate-status-pulse" />;
    case "interrupted":
      return <PauseIcon className="size-3" />;
    case "inactive":
      return <CircleIcon className="size-2 fill-current" />;
  }
}

function getSidebarThreadSection(input: {
  thread: SidebarThreadSummary;
  status: ThreadStatusPill | null;
  foldOlder: boolean;
  olderAfterDays: number;
}): SidebarThreadSection {
  const { foldOlder, olderAfterDays, status, thread } = input;
  if (
    status?.label === "Pending Approval" ||
    status?.label === "Awaiting Input" ||
    status?.label === "Plan Ready"
  )
    return "needs";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "failed";
  if (status?.label === "Completed") return "completed";
  if (status?.label === "Working" || status?.label === "Connecting") return "working";
  const activityAt = thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
  if (
    foldOlder &&
    thread.latestTurn?.state !== "interrupted" &&
    Date.now() - Date.parse(activityAt) >= olderAfterDays * 86_400_000
  )
    return "older";
  return "recent";
}

function sidebarFocusSectionOrder(section: SidebarThreadSection): number {
  switch (section) {
    case "needs":
      return 10;
    case "failed":
      return 30;
    case "completed":
      return 50;
    case "working":
      return 70;
    case "recent":
      return 90;
    case "older":
      return 110;
  }
}

function isSidebarFocusGroupedSection(section: SidebarThreadSection): boolean {
  return section !== "recent" && section !== "older";
}

function SidebarThreadDetailPrewarmer({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  return null;
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
  projectCwd: string | null;
  projectDisplayName: string;
  showProject: boolean;
  focusOrder?: number;
  orderedProjectThreadKeys: readonly string[];
  isActive: boolean;
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
  navigateToThread: (threadRef: ScopedThreadRef) => void;
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
  openPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
}

export const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    orderedProjectThreadKeys,
    isActive,
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
    thread,
    projectDisplayName,
    showProject,
    focusOrder,
  } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
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
  const isRemoteThread =
    primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = environment?.label ?? null;
  // A desktop-local secondary backend (e.g. the WSL backend) shows up as a
  // bearer environment whose connection id is prefixed "local:". It runs on the
  // user's own machine, so the cloud icon is misleading — label it "Local" and
  // suppress the cloud icon (the project header already shows a container icon
  // for desktop-local projects, see sidebarProjectGrouping).
  const isDesktopLocalThread =
    environment !== null && isDesktopLocalConnectionTarget(environment.entry.target);
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvLabel ?? (isDesktopLocalThread ? "Local" : "Remote"))
    : null;
  // For grouped projects, the thread may belong to a different environment
  // than the representative project.  Look up the thread's own project cwd
  // so git status (and thus PR detection) queries the correct path.
  const threadProject = useProject(
    useMemo(
      () => scopeProjectRef(thread.environmentId, thread.projectId),
      [thread.environmentId, thread.projectId],
    ),
  );
  const threadProjectCwd = threadProject?.workspaceRoot ?? null;
  const gitCwd = thread.worktreePath ?? threadProjectCwd ?? props.projectCwd;
  const gitStatus = useEnvironmentQuery(
    thread.branch != null && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const isHighlighted = isActive || isSelected;
  const handleOpenDiscoveredPort = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const port = discoveredPorts[0];
      if (!port) return;
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
            description:
              error instanceof Error ? error.message : "The preview could not be opened.",
          }),
        );
      })();
    },
    [discoveredPorts, navigateToThread, openPreview, threadRef],
  );
  const isThreadRunning =
    thread.session?.status === "running" && thread.session.activeTurnId != null;
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });
  const visualSignal = getSidebarThreadVisualSignal(thread, threadStatus);
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const isConfirmingArchive = confirmingArchiveThreadKey === threadKey && !isThreadRunning;
  const threadMetaClassName = isConfirmingArchive
    ? "font-mono text-[9px] tabular-nums opacity-0"
    : !isThreadRunning
      ? "font-mono text-[9px] tabular-nums transition-opacity group-hover/thread:opacity-0 group-focus-within/thread:opacity-0"
      : "font-mono text-[9px] tabular-nums";
  const clearConfirmingArchive = useCallback(() => {
    setConfirmingArchiveThreadKey((current) => (current === threadKey ? null : current));
  }, [setConfirmingArchiveThreadKey, threadKey]);
  const handleMouseLeave = useCallback(() => {
    clearConfirmingArchive();
  }, [clearConfirmingArchive]);
  const handleBlurCapture = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
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
      handleThreadClick(event, threadRef, orderedProjectThreadKeys);
    },
    [handleThreadClick, orderedProjectThreadKeys, threadRef],
  );
  const handleRowDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      // Already renaming this row: a double-click on the row chrome (outside the
      // input) must not restart and discard the in-progress edit.
      if (renamingThreadKey === threadKey) return;
      // On mobile the first tap navigates and closes the sidebar sheet, so the
      // inline rename can't be shown. Renaming there stays on the context menu.
      if (isMobile) return;
      // cmd/ctrl/shift double-clicks are multi-select intent, not rename.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      // Ignore double-clicks bubbling from nested controls (PR status, port,
      // archive buttons) — only the row body should enter inline rename.
      if ((event.target as HTMLElement).closest("button, a")) return;
      event.preventDefault();
      startThreadRename(threadKey, thread.title);
    },
    [isMobile, renamingThreadKey, startThreadRename, threadKey, thread.title],
  );
  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      navigateToThread(threadRef);
    },
    [navigateToThread, threadRef],
  );
  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent) => {
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
    },
    [clearSelection, handleMultiSelectContextMenu, handleThreadContextMenu, isSelected, threadRef],
  );
  const handlePrClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!prStatus) return;
      openPrLink(event, prStatus.url);
    },
    [openPrLink, prStatus],
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
  // Keep clicks/double-clicks inside the rename input from bubbling to the row.
  // Without stopping `dblclick`, double-clicking to select a word would re-fire
  // the row's rename handler and reset the in-progress edit back to the title.
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
  const stopPropagationOnPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    },
    [],
  );
  const handleConfirmArchiveClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      clearConfirmingArchive();
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, clearConfirmingArchive, threadRef],
  );
  const handleStartArchiveConfirmation = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setConfirmingArchiveThreadKey(threadKey);
      requestAnimationFrame(() => {
        confirmArchiveButtonRefs.current.get(threadKey)?.focus();
      });
    },
    [confirmArchiveButtonRefs, setConfirmingArchiveThreadKey, threadKey],
  );
  const handleArchiveImmediateClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, threadRef],
  );
  return (
    <div
      role="button"
      tabIndex={0}
      style={focusOrder === undefined ? undefined : { order: focusOrder }}
      data-thread-item
      data-testid={`thread-row-${thread.id}`}
      onMouseLeave={handleMouseLeave}
      onBlurCapture={handleBlurCapture}
      onClick={handleRowClick}
      onDoubleClick={handleRowDoubleClick}
      onKeyDown={handleRowKeyDown}
      onContextMenu={handleRowContextMenu}
      className={`group/thread relative flex min-w-0 gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${showProject ? "mx-1.5 w-[calc(100%-0.75rem)]" : "w-full"} ${
        isHighlighted
          ? "bg-accent text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-accent/65 hover:text-foreground"
      }`}
    >
      <span
        className={`flex size-5 shrink-0 self-center items-center justify-center rounded-md ${sidebarThreadSignalClass(visualSignal)}`}
      >
        <SidebarThreadSignalIcon signal={visualSignal} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          {renamingThreadKey === threadKey ? (
            <input
              ref={handleRenameInputRef}
              className="h-5 min-w-0 flex-1 cursor-text rounded border border-ring bg-transparent px-1 text-xs outline-none"
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
                    className="min-w-0 flex-1 cursor-default truncate text-xs font-medium leading-4"
                    data-testid={`thread-title-${thread.id}`}
                  >
                    {thread.title}
                  </span>
                }
              />
              <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
                {thread.title}
              </TooltipPopup>
            </Tooltip>
          )}
          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground/45">
            {prStatus ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={prStatus.tooltip}
                      className={`${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                      onClick={handlePrClick}
                    />
                  }
                >
                  <ChangeRequestStatusIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
              </Tooltip>
            ) : null}
            <ThreadWorktreeIndicator thread={thread} />
            {terminalStatus ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      role="img"
                      aria-label={terminalStatus.label}
                      className={terminalStatus.colorClass}
                    />
                  }
                >
                  <TerminalIcon
                    className={`size-3 ${terminalStatus.pulse ? "animate-status-pulse" : ""}`}
                  />
                </TooltipTrigger>
                <TooltipPopup side="top">{terminalStatus.label}</TooltipPopup>
              </Tooltip>
            ) : null}
            {discoveredPorts.length > 0 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`Open localhost:${discoveredPorts[0]?.port ?? ""}`}
                      className="cursor-pointer text-emerald-500 outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
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
            {isRemoteThread && !isDesktopLocalThread ? (
              <Tooltip>
                <TooltipTrigger
                  render={<span role="img" aria-label={threadEnvironmentLabel ?? "Remote"} />}
                >
                  <CloudIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
              </Tooltip>
            ) : null}
            <span className={threadMetaClassName}>
              {jumpLabel
                ? jumpLabel
                : formatRelativeTimeLabel(
                    thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                  )}
            </span>
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[10px] leading-3.5">
          {showProject ? (
            <>
              <span className="max-w-24 truncate text-muted-foreground/55">
                {projectDisplayName}
              </span>
              <span className="text-muted-foreground/30">·</span>
            </>
          ) : null}
          <span
            className={`min-w-0 truncate whitespace-nowrap ${visualSignal === "inactive" ? "text-muted-foreground/45" : "text-foreground/60"}`}
          >
            {sidebarThreadSignalLabel(visualSignal)}
          </span>
        </span>
      </span>
      {!isThreadRunning ? (
        isConfirmingArchive ? (
          <button
            ref={handleConfirmArchiveRef}
            type="button"
            data-thread-selection-safe
            data-testid={`thread-archive-confirm-${thread.id}`}
            aria-label={`Confirm archive ${thread.title}`}
            className="absolute top-1/2 right-1.5 z-10 h-6 -translate-y-1/2 rounded-md bg-destructive/12 px-2 text-[9px] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/40"
            onPointerDown={stopPropagationOnPointerDown}
            onClick={handleConfirmArchiveClick}
          >
            Confirm
          </button>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-thread-selection-safe
                  data-testid={`thread-archive-${thread.id}`}
                  aria-label={`Archive ${thread.title}`}
                  className="absolute top-1/2 right-1.5 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md bg-accent text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/thread:opacity-100 group-focus-within/thread:opacity-100"
                  onPointerDown={stopPropagationOnPointerDown}
                  onClick={
                    appSettingsConfirmThreadArchive
                      ? handleStartArchiveConfirmation
                      : handleArchiveImmediateClick
                  }
                >
                  <ArchiveIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup side="top">Archive</TooltipPopup>
          </Tooltip>
        )
      ) : null}
      {isActive ? (
        <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-foreground/65" />
      ) : null}
    </div>
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
  projectCwd: string;
  activeRouteThreadKey: string | null;
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
  navigateToThread: (threadRef: ScopedThreadRef) => void;
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
  openPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
  foldOlderThreads: boolean;
  olderAfterDays: SidebarOlderAfterDays;
  threadLayout: SidebarThreadLayout;
  threadStatusByKey: ReadonlyMap<string, ThreadStatusPill | null>;
  projectDisplayNameByThreadKey: ReadonlyMap<string, string>;
  projectDisplayName: string;
  showProject: boolean;
}

const SidebarProjectThreadList = memo(function SidebarProjectThreadList(
  props: SidebarProjectThreadListProps,
) {
  const {
    orderedProjectThreadKeys,
    renderedThreads,
    showEmptyThreadState,
    shouldShowThreadPanel,
    projectCwd,
    activeRouteThreadKey,
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
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    openPrLink,
    foldOlderThreads,
    olderAfterDays,
    threadLayout,
    threadStatusByKey,
    projectDisplayNameByThreadKey,
    projectDisplayName,
    showProject,
  } = props;
  const renderThread = (thread: SidebarThreadSummary) => {
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const section = getSidebarThreadSection({
      thread,
      status: threadStatusByKey.get(threadKey) ?? null,
      foldOlder: foldOlderThreads,
      olderAfterDays,
    });
    const focusOrder =
      activeRouteThreadKey === threadKey && !isSidebarFocusGroupedSection(section)
        ? SIDEBAR_UNGROUPED_ACTIVE_ORDER
        : sidebarFocusSectionOrder(section);
    return (
      <SidebarThreadRow
        key={threadKey}
        thread={thread}
        projectCwd={projectCwd}
        projectDisplayName={projectDisplayNameByThreadKey.get(threadKey) ?? projectDisplayName}
        showProject={showProject}
        {...(showProject ? { focusOrder } : {})}
        orderedProjectThreadKeys={orderedProjectThreadKeys}
        isActive={activeRouteThreadKey === threadKey}
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
        handleMultiSelectContextMenu={handleMultiSelectContextMenu}
        handleThreadContextMenu={handleThreadContextMenu}
        clearSelection={clearSelection}
        commitRename={commitRename}
        cancelRename={cancelRename}
        attemptArchiveThread={attemptArchiveThread}
        openPrLink={openPrLink}
      />
    );
  };
  const sectionEntries = (
    [
      ["needs", "Needs you"],
      ["failed", "Failed"],
      ["completed", "Completed"],
      ["working", "Working"],
      ["recent", "Recent"],
    ] as const
  ).map(([key, label]) => ({
    key,
    label,
    threads: renderedThreads.filter((thread) => {
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      return (
        getSidebarThreadSection({
          thread,
          status: threadStatusByKey.get(threadKey) ?? null,
          foldOlder: foldOlderThreads,
          olderAfterDays,
        }) === key
      );
    }),
  }));
  const olderThreads = renderedThreads.filter((thread) => {
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    return (
      getSidebarThreadSection({
        thread,
        status: threadStatusByKey.get(threadKey) ?? null,
        foldOlder: foldOlderThreads,
        olderAfterDays,
      }) === "older"
    );
  });

  if (!shouldShowThreadPanel) return null;

  if (showProject) {
    const focusThreads = renderedThreads.filter((thread) => {
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      if (threadKey === activeRouteThreadKey) return true;
      const section = getSidebarThreadSection({
        thread,
        status: threadStatusByKey.get(threadKey) ?? null,
        foldOlder: false,
        olderAfterDays,
      });
      return isSidebarFocusGroupedSection(section);
    });
    return (
      <div ref={attachThreadListAutoAnimateRef} className="contents">
        {focusThreads.map(renderThread)}
      </div>
    );
  }

  const visibleSections =
    threadLayout === "ungrouped"
      ? [
          {
            key: "threads",
            label: "Threads",
            threads: renderedThreads.filter((thread) => !olderThreads.includes(thread)),
          },
        ]
      : sectionEntries;

  return (
    <div
      ref={attachThreadListAutoAnimateRef}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2"
    >
      {showEmptyThreadState ? (
        <div className="px-3 py-5 text-center text-xs text-muted-foreground/45">No threads yet</div>
      ) : null}
      {visibleSections.map((section) =>
        section.threads.length > 0 ? (
          <section key={section.key} className="px-1.5 pb-2">
            <div className="flex h-7 items-center px-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/45">
              <span>{section.label}</span>
              <span className="ml-auto font-mono tracking-normal">{section.threads.length}</span>
            </div>
            <div className="space-y-0.5">{section.threads.map(renderThread)}</div>
          </section>
        ) : null,
      )}
      {foldOlderThreads && olderThreads.length > 0 ? (
        <details
          className="group mx-2 mb-2 border-t border-border/60 pt-1"
          open={olderThreads.length === renderedThreads.length}
        >
          <summary className="flex h-8 cursor-pointer list-none items-center gap-1.5 px-1 text-[10px] text-muted-foreground/45 transition-colors hover:text-muted-foreground">
            <ChevronRightIcon className="size-3 transition-transform group-open:rotate-90" />
            Older
            <span className="ml-auto font-mono">{olderThreads.length}</span>
          </summary>
          <div className="space-y-0.5 pb-1">{olderThreads.map(renderThread)}</div>
        </details>
      ) : null}
    </div>
  );
});

interface SidebarProjectItemProps {
  project: SidebarProjectSnapshot;
  isThreadListExpanded: boolean;
  activeRouteThreadKey: string | null;
  newThreadShortcutLabel: string | null;
  handleNewThread: ReturnType<typeof useNewThreadHandler>;
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
  dragInProgressRef: React.RefObject<boolean>;
  suppressProjectClickAfterDragRef: React.RefObject<boolean>;
  suppressProjectClickForContextMenuRef: React.RefObject<boolean>;
  isManualProjectSorting: boolean;
  dragHandleProps: SortableProjectHandleProps | null;
  navigatorMode?: "focus" | "project" | "rail";
  railSelected?: boolean;
  railStatus?: SidebarProjectRailStatus | null;
  onRailSelect?: () => void;
}

const SidebarProjectItem = memo(function SidebarProjectItem(props: SidebarProjectItemProps) {
  const {
    project,
    isThreadListExpanded,
    activeRouteThreadKey,
    newThreadShortcutLabel,
    handleNewThread,
    archiveThread,
    deleteThread,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandThreadListForProject,
    collapseThreadListForProject,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    isManualProjectSorting,
    dragHandleProps,
    navigatorMode,
    railSelected,
    railStatus,
    onRailSelect,
  } = props;
  const openNewThreadProjectPicker = useOpenNewThreadProjectCommandPalette();
  const threadSortOrder = useClientSettings<SidebarThreadSortOrder>(
    (settings) => settings.sidebarThreadSortOrder,
  );
  const threadLayout = useClientSettings<SidebarThreadLayout>(
    (settings) => settings.sidebarThreadLayout,
  );
  const foldOlderThreads = useClientSettings<boolean>(
    (settings) => settings.sidebarFoldOlderThreads,
  );
  const olderAfterDays = useClientSettings<SidebarOlderAfterDays>(
    (settings) => settings.sidebarOlderAfterDays,
  );
  const appSettingsConfirmThreadDelete = useClientSettings<boolean>(
    (settings) => settings.confirmThreadDelete,
  );
  const appSettingsConfirmThreadArchive = useClientSettings<boolean>(
    (settings) => settings.confirmThreadArchive,
  );
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const serverConfigs = useServerConfigs();
  const deleteProject = useAtomCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const updateProject = useAtomCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const updateSettings = useUpdateClientSettings();
  const sidebarThreadPreviewCount = useClientSettings<SidebarThreadPreviewCount>(
    (settings) => settings.sidebarThreadPreviewCount,
  );
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
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
  const sidebarThreads = useThreadShellsForProjectRefs(project.memberProjectRefs);
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
  // Keep a ref so callbacks can read the latest map without appearing in
  // dependency arrays (avoids invalidating every thread-row memo on each
  // thread-list change).
  const sidebarThreadByKeyRef = useRef(sidebarThreadByKey);
  sidebarThreadByKeyRef.current = sidebarThreadByKey;
  const projectThreads = sidebarThreads;
  const projectPreferenceKeys = useMemo(() => projectExpansionPreferenceKeys(project), [project]);
  const storedProjectExpanded = useUiStateStore((state) =>
    resolveProjectExpanded(state.projectExpandedById, projectPreferenceKeys),
  );
  const projectExpanded = navigatorMode ? true : storedProjectExpanded;
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
  const projectDisplayNameByThreadKey = useMemo(
    () =>
      new Map(
        projectThreads.map((thread) => {
          const member = memberProjectByScopedKey.get(
            scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
          );
          return [
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
            member?.title ?? project.displayName,
          ] as const;
        }),
      ),
    [memberProjectByScopedKey, project.displayName, projectThreads],
  );

  const { projectStatus, threadStatusByKey, visibleProjectThreads, orderedProjectThreadKeys } =
    useMemo(() => {
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
          thread: {
            ...thread,
            ...(lastVisitedAt !== null && lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
          },
        });
      };
      const allVisibleProjectThreads = sortThreads(
        projectThreads.filter((thread) => thread.archivedAt === null),
        threadSortOrder,
      );
      const threadStatusByKey = new Map(
        allVisibleProjectThreads.map(
          (thread) =>
            [
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
              resolveProjectThreadStatus(thread),
            ] as const,
        ),
      );
      const visibleProjectThreads =
        navigatorMode === "focus"
          ? allVisibleProjectThreads.filter((thread) => {
              const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
              if (threadKey === activeRouteThreadKey) return true;
              const status = threadStatusByKey.get(threadKey);
              return (
                status !== null ||
                thread.session?.status === "error" ||
                thread.latestTurn?.state === "error"
              );
            })
          : allVisibleProjectThreads;
      const projectStatus = resolveProjectStatusIndicator([...threadStatusByKey.values()]);
      return {
        orderedProjectThreadKeys: visibleProjectThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
        projectStatus,
        threadStatusByKey,
        visibleProjectThreads,
      };
    }, [
      activeRouteThreadKey,
      navigatorMode,
      projectThreads,
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

  const {
    hasOverflowingThreads,
    hiddenThreadStatus,
    renderedThreads,
    showEmptyThreadState,
    shouldShowThreadPanel,
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
        thread: {
          ...thread,
          ...(lastVisitedAt !== null && lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
        },
      });
    };
    const hasOverflowingThreads =
      !navigatorMode && visibleProjectThreads.length > sidebarThreadPreviewCount;
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
        hiddenThreads.map((thread) => resolveProjectThreadStatus(thread)),
      ),
      renderedThreads,
      showEmptyThreadState: projectExpanded && visibleProjectThreads.length === 0,
      shouldShowThreadPanel: projectExpanded || pinnedCollapsedThread !== null,
    };
  }, [
    isThreadListExpanded,
    pinnedCollapsedThread,
    projectExpanded,
    projectThreads,
    sidebarThreadPreviewCount,
    threadLastVisitedAts,
    visibleProjectThreads,
    navigatorMode,
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
      if (useThreadSelectionStore.getState().hasSelection()) {
        clearSelection();
      }
      setProjectExpanded(projectPreferenceKeys, !projectExpanded);
    },
    [
      clearSelection,
      dragInProgressRef,
      projectExpanded,
      projectPreferenceKeys,
      setProjectExpanded,
      suppressProjectClickAfterDragRef,
      suppressProjectClickForContextMenuRef,
    ],
  );

  const handleProjectButtonKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      setProjectExpanded(projectPreferenceKeys, !projectExpanded);
    },
    [dragInProgressRef, projectExpanded, projectPreferenceKeys, setProjectExpanded],
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
    setProjectRenameTitle(member.title);
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
    async (member: SidebarProjectGroupMember, options: { force?: boolean } = {}) => {
      const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
      const result = await deleteProject({
        environmentId: member.environmentId,
        input: {
          projectId: member.id,
          ...(options.force === true ? { force: true } : {}),
        },
      });
      if (result._tag === "Failure") {
        return result;
      }
      const draftStore = useComposerDraftStore.getState();
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(memberProjectRef);
      if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(memberProjectRef);
      return result;
    },
    [deleteProject],
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

                  const latestProjectThreads = Array.from(
                    sidebarThreadByKeyRef.current.values(),
                  ).filter(
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
                          "This permanently clears conversation history for those threads.",
                          "This removes only this project entry.",
                          "This action cannot be undone.",
                        ].join("\n")
                      : [
                          `Remove project "${member.title}"?`,
                          `Path: ${member.workspaceRoot}`,
                          ...(member.environmentLabel
                            ? [`Environment: ${member.environmentLabel}`]
                            : []),
                          "This removes only this project entry.",
                        ].join("\n"),
                  );
                  if (!confirmed) {
                    return;
                  }

                  const result = await removeProject(member, { force: true });
                  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                    const error = squashAtomCommandFailure(result);
                    toastManager.add(
                      stackedThreadToast({
                        type: "error",
                        title: `Failed to remove "${member.title}"`,
                        description:
                          error instanceof Error
                            ? error.message
                            : "Unknown error removing project.",
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
        "This removes only this project entry.",
      ].join("\n");
      const confirmed = await api.dialogs.confirm(message);
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

        const clicked = await api.contextMenu.show(
          [
            buildTargetedItem("rename", "Rename"),
            buildTargetedItem("grouping", "Group into..."),
            buildTargetedItem("copy-path", "Copy Path"),
            buildTargetedItem("delete", "Remove", {
              destructive: true,
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
  const handleRailSelect = useCallback(() => {
    if (suppressProjectClickForContextMenuRef.current) {
      suppressProjectClickForContextMenuRef.current = false;
      return;
    }
    onRailSelect?.();
  }, [onRailSelect, suppressProjectClickForContextMenuRef]);

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
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
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
    async (position: { x: number; y: number }) => {
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
        const result = await deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
          deletedThreadKeys,
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to delete threads",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
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

  const createThreadForProjectMember = useCallback(
    (member: SidebarProjectGroupMember) => {
      const currentRouteParams =
        router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const currentRouteTarget = resolveThreadRouteTarget(currentRouteParams);
      const currentActiveThread =
        currentRouteTarget?.kind === "server"
          ? readThreadShell(currentRouteTarget.threadRef)
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
          defaultEnvMode:
            serverConfigs.get(member.environmentId)?.settings.defaultThreadEnvMode ??
            DEFAULT_SERVER_SETTINGS.defaultThreadEnvMode,
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
                startFromOrigin: currentActiveDraftThread.startFromOrigin,
              }
            : null,
      });
      if (isMobile) {
        setOpenMobile(false);
      }
      void (async () => {
        const result = await settlePromise(() =>
          handleNewThread(scopeProjectRef(member.environmentId, member.id), {
            ...(seedContext.branch !== undefined ? { branch: seedContext.branch } : {}),
            ...(seedContext.worktreePath !== undefined
              ? { worktreePath: seedContext.worktreePath }
              : {}),
            envMode: seedContext.envMode,
            ...(seedContext.startFromOrigin !== undefined
              ? { startFromOrigin: seedContext.startFromOrigin }
              : {}),
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
      })();
    },
    [handleNewThread, isMobile, router, serverConfigs, setOpenMobile],
  );

  const handleCreateThreadClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      if (project.memberProjects.length === 1) {
        createThreadForProjectMember(project.memberProjects[0]!);
        return;
      }

      openNewThreadProjectPicker([project], createThreadForProjectMember);
    },
    [createThreadForProjectMember, openNewThreadProjectPicker, project],
  );

  const attemptArchiveThread = useCallback(
    async (threadRef: ScopedThreadRef) => {
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
    },
    [archiveThread],
  );

  const cancelRename = useCallback(() => {
    setRenamingThreadKey(null);
    renamingInputRef.current = null;
  }, []);

  const startThreadRename = useCallback((threadKey: string, title: string) => {
    setRenamingThreadKey(threadKey);
    setRenamingTitle(title);
    renamingCommittedRef.current = false;
  }, []);

  const commitRename = useCallback(
    async (threadRef: ScopedThreadRef, newTitle: string, originalTitle: string) => {
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
    },
    [updateThreadMetadata],
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
  }, [closeProjectRenameDialog, projectRenameTarget, projectRenameTitle, updateProject]);

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

  const handleThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKey = scopedThreadKey(threadRef);
      const thread = sidebarThreadByKeyRef.current.get(threadKey) ?? null;
      if (!thread) return;
      const threadProject = memberProjectByScopedKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      const threadWorkspacePath =
        thread.worktreePath ?? threadProject?.workspaceRoot ?? project.workspaceRoot ?? null;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "delete", label: "Delete", destructive: true, icon: "trash" },
        ],
        position,
      );

      if (clicked === "rename") {
        startThreadRename(threadKey, thread.title);
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
    [
      appSettingsConfirmThreadDelete,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      markThreadUnread,
      memberProjectByScopedKey,
      project.workspaceRoot,
      startThreadRename,
    ],
  );

  return (
    <>
      {navigatorMode === "rail" ? (
        <ProjectRailTile
          project={project}
          selected={railSelected ?? false}
          status={railStatus ?? null}
          manual={isManualProjectSorting}
          onSelect={handleRailSelect}
          onContextMenu={handleProjectButtonContextMenu}
        />
      ) : (
        <>
          {navigatorMode === "project" ? (
            <div className="border-b border-border/60 p-2">
              <button
                type="button"
                className="flex h-10 w-full min-w-0 items-center gap-2 rounded-lg bg-foreground px-2.5 text-left text-background shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={handleCreateThreadClick}
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-background/15">
                  <PlusIcon className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">New thread</span>
                <span className="max-w-28 truncate font-mono text-[9px] text-background/55">
                  in {project.displayName}
                </span>
              </button>
            </div>
          ) : navigatorMode === "focus" ? null : (
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
                      <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
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
                <ProjectFavicon environmentId={project.environmentId} cwd={project.workspaceRoot} />
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate text-xs font-medium text-foreground/90">
                    {project.displayName}
                  </span>
                  {project.groupedProjectCount > 1 ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground/60">
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
                          project.allRemoteMembersAreDesktopLocal
                            ? "Local sandbox project"
                            : "Remote project"
                        }
                        className="pointer-events-none absolute top-1 right-1.5 inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/60 transition-opacity duration-150 max-sm:right-7 group-hover/project-header:opacity-0 group-focus-within/project-header:opacity-0 max-sm:group-hover/project-header:opacity-100 max-sm:group-focus-within/project-header:opacity-100"
                      />
                    }
                  >
                    {project.allRemoteMembersAreDesktopLocal ? (
                      <ContainerIcon className="size-3" />
                    ) : (
                      <CloudIcon className="size-3" />
                    )}
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
          )}

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
            projectCwd={project.workspaceRoot}
            activeRouteThreadKey={activeRouteThreadKey}
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
            handleMultiSelectContextMenu={handleMultiSelectContextMenu}
            handleThreadContextMenu={handleThreadContextMenu}
            clearSelection={clearSelection}
            commitRename={commitRename}
            cancelRename={cancelRename}
            attemptArchiveThread={attemptArchiveThread}
            openPrLink={openPrLink}
            expandThreadListForProject={expandThreadListForProject}
            collapseThreadListForProject={collapseThreadListForProject}
            foldOlderThreads={foldOlderThreads}
            olderAfterDays={olderAfterDays}
            threadLayout={threadLayout}
            threadStatusByKey={threadStatusByKey}
            projectDisplayNameByThreadKey={projectDisplayNameByThreadKey}
            projectDisplayName={project.displayName}
            showProject={navigatorMode === "focus"}
          />
        </>
      )}

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
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Project title</span>
              <Input
                aria-label="Project title"
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
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectRenameDialog}>
              Cancel
            </Button>
            <Button onClick={() => void submitProjectRename()}>Save</Button>
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
          <DialogPanel className="space-y-4">
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

function LocalSecondaryStatus() {
  const { environments } = useEnvironments();
  // The desktop reports which local secondary backends (e.g. the WSL backend)
  // exist; the hook polls because the bridge has no change event. A backend that
  // is still cold-booting has no httpBaseUrl yet and isn't in the catalog, so we
  // surface "Connecting" straight from the bootstrap list and clear it once the
  // matching environment reports a connected phase.
  const secondaries = useDesktopLocalBootstraps();

  // Connected desktop-local environments keyed by their backend URL so we can
  // match a bootstrap (which only knows the URL) to its connection phase.
  const localEnvByUrl = useMemo(() => {
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
  }, [environments]);

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
    <SidebarGroup className="px-2 pt-2 pb-0">
      {connecting.length > 0 ? (
        <Alert
          variant="default"
          className="rounded-2xl border-border/40 bg-accent/40 text-muted-foreground"
        >
          <LoaderIcon className="animate-spin" />
          <AlertTitle className="text-xs font-medium text-foreground">
            Connecting {connecting.join(", ")}
          </AlertTitle>
        </Alert>
      ) : null}
      {failed.length > 0 ? (
        <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
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
  foldOlderThreads,
  olderAfterDays,
  projectSortOrder,
  threadLayout,
  threadSortOrder,
  projectGroupingMode,
  onFoldOlderThreadsChange,
  onOlderAfterDaysChange,
  onProjectSortOrderChange,
  onThreadLayoutChange,
  onThreadSortOrderChange,
  onProjectGroupingModeChange,
}: {
  foldOlderThreads: boolean;
  olderAfterDays: SidebarOlderAfterDays;
  projectSortOrder: SidebarProjectSortOrder;
  threadLayout: SidebarThreadLayout;
  threadSortOrder: SidebarThreadSortOrder;
  projectGroupingMode: SidebarProjectGroupingMode;
  onFoldOlderThreadsChange: (fold: boolean) => void;
  onOlderAfterDaysChange: (days: SidebarOlderAfterDays) => void;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadLayoutChange: (layout: SidebarThreadLayout) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  onProjectGroupingModeChange: (mode: SidebarProjectGroupingMode) => void;
}) {
  const handleOlderAfterDaysChange = useCallback(
    (nextValue: number | null) => {
      if (nextValue === null) {
        return;
      }

      const clampedValue = Math.min(
        MAX_SIDEBAR_OLDER_AFTER_DAYS,
        Math.max(MIN_SIDEBAR_OLDER_AFTER_DAYS, nextValue),
      ) as SidebarOlderAfterDays;
      if (clampedValue !== olderAfterDays) {
        onOlderAfterDaysChange(clampedValue);
      }
    },
    [olderAfterDays, onOlderAfterDaysChange],
  );

  return (
    <Menu>
      <MenuTrigger
        aria-label="Sidebar options"
        className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground/55 transition-colors hover:bg-accent hover:text-foreground"
      >
        <ArrowUpDownIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="start" side="right" className="min-w-56">
        <MenuGroup>
          <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Sort projects</div>
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
          <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
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
          <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
            Thread layout
          </div>
          <MenuRadioGroup
            value={threadLayout}
            onValueChange={(value) => onThreadLayoutChange(value as SidebarThreadLayout)}
          >
            <MenuRadioItem value="grouped">Grouped</MenuRadioItem>
            <MenuRadioItem value="ungrouped">Ungrouped</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <MenuCheckboxItem checked={foldOlderThreads} onCheckedChange={onFoldOlderThreadsChange}>
            Fold inactive threads
          </MenuCheckboxItem>
          {foldOlderThreads ? (
            <div className="flex items-center justify-between gap-3 px-2 py-1">
              <span className="text-xs text-muted-foreground">Older than</span>
              <NumberField
                aria-label="Fold threads older than days"
                className="w-24 gap-0"
                max={MAX_SIDEBAR_OLDER_AFTER_DAYS}
                min={MIN_SIDEBAR_OLDER_AFTER_DAYS}
                onValueChange={handleOlderAfterDaysChange}
                size="sm"
                value={olderAfterDays}
              >
                <NumberFieldGroup className="h-7">
                  <NumberFieldDecrement className="px-1.5" />
                  <NumberFieldInput
                    className="w-8 px-0 text-center text-xs"
                    inputMode="numeric"
                    onKeyDownCapture={(event) => {
                      event.stopPropagation();
                    }}
                  />
                  <NumberFieldIncrement className="px-1.5" />
                </NumberFieldGroup>
              </NumberField>
              <span className="text-xs text-muted-foreground">days</span>
            </div>
          ) : null}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Group projects</div>
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
              <MenuRadioItem key={value} value={value}>
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function ProjectRailTile({
  project,
  selected,
  status,
  manual,
  onSelect,
  onContextMenu,
}: {
  project: SidebarProjectSnapshot;
  selected: boolean;
  status: SidebarProjectRailStatus | null;
  manual: boolean;
  onSelect: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition } =
    useSortable({ id: project.projectKey, disabled: !manual });
  const projectMonogram =
    project.displayName
      .split(/[\s/_.-]+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "•";
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <button
              ref={setActivatorNodeRef}
              type="button"
              aria-label={project.displayName}
              onClick={onSelect}
              onContextMenu={onContextMenu}
              className={`relative mx-auto flex size-9 items-center justify-center rounded-lg transition-colors hover:bg-accent/70 ${manual ? "cursor-grab active:cursor-grabbing" : ""} ${selected ? "bg-accent text-foreground shadow-sm ring-1 ring-foreground/30 ring-offset-1 ring-offset-sidebar" : "bg-muted/35 text-muted-foreground/55"}`}
              {...(manual ? attributes : {})}
              {...(manual ? listeners : {})}
            />
          }
        >
          <ProjectFavicon
            environmentId={project.environmentId}
            cwd={project.workspaceRoot}
            className="size-full rounded-lg object-cover"
            fallback={
              <span className="font-mono text-[10px] font-semibold tracking-tight">
                {projectMonogram}
              </span>
            }
          />
          {status && status !== "working" ? (
            <span
              className={`absolute -right-1 -top-1 size-2.5 rounded-full ring-2 ring-inset ring-sidebar ${status === "failed" ? "bg-red-500" : status === "completed" ? "bg-emerald-500" : "bg-amber-500"}`}
            />
          ) : null}
          {selected ? (
            <span className="absolute -left-1.5 h-4 w-0.5 rounded-full bg-foreground/70" />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="right" align="start" className="whitespace-normal">
          <div className="min-w-48 max-w-72 py-0.5">
            <div className="font-medium">{project.displayName}</div>
            {project.memberProjects.length > 1 ? (
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                {project.memberProjects.length} projects in this group
              </div>
            ) : null}
            <div className="mt-2 space-y-1.5">
              {project.memberProjects.map((member) => (
                <div key={member.physicalProjectKey} className="flex min-w-0 items-start gap-2">
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                    {member.environmentId !== project.environmentId ? (
                      project.allRemoteMembersAreDesktopLocal ? (
                        <ContainerIcon className="size-3" />
                      ) : (
                        <CloudIcon className="size-3" />
                      )
                    ) : project.environmentPresence === "remote-only" &&
                      project.allRemoteMembersAreDesktopLocal ? (
                      <ContainerIcon className="size-3" />
                    ) : (
                      <CircleIcon className="size-2 fill-current" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[11px]">
                      {member.environmentLabel ?? "Local"}
                      {project.memberProjects.length > 1 ? ` — ${member.title}` : ""}
                    </span>
                    <span className="block truncate font-mono text-[9px] text-muted-foreground">
                      {member.workspaceRoot}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  return isElectron ? (
    <SidebarHeader className="@container/sidebar-header drag-region h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center border-b border-border/70 px-3 py-0 md:px-0">
      <SidebarTrigger className="md:hidden" />
      <SidebarBrand />
    </SidebarHeader>
  ) : (
    <SidebarHeader className="@container/sidebar-header h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center border-b border-border/70 px-3 py-0 md:px-0">
      <SidebarTrigger className="md:hidden" />
      <SidebarBrand />
    </SidebarHeader>
  );
});

export function SidebarBrand() {
  const stageLabel = useSidebarStageLabel();

  return (
    <Link
      aria-label="Go to threads"
      className="sidebar-brand ml-[var(--workspace-titlebar-content-left)] h-7 w-fit min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded-md text-foreground outline-hidden ring-ring focus-visible:ring-2"
      to="/"
    >
      <T3Wordmark />
      <span className="truncate text-sm font-medium tracking-tight text-muted-foreground">
        Code
      </span>
      <span className="sidebar-brand-stage shrink-0 items-center whitespace-nowrap rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
        {stageLabel}
      </span>
    </Link>
  );
}

function useSidebarStageLabel() {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;

  return resolveSidebarStageBadgeLabel({
    primaryServerVersion,
    fallbackStageLabel: APP_STAGE_LABEL,
  });
}

function T3Wordmark() {
  return (
    <svg
      aria-label="T3"
      className="h-2.5 w-auto shrink-0 text-foreground"
      viewBox="15.5309 37 94.3941 56.96"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
        fill="currentColor"
      />
    </svg>
  );
}

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
    <SidebarFooter className="border-t border-border/60 p-2">
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      <button
        type="button"
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={handleSettingsClick}
      >
        <SettingsIcon className="size-3.5" />
        Settings
      </button>
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
  threadLayout: SidebarThreadLayout;
  threadSortOrder: SidebarThreadSortOrder;
  foldOlderThreads: boolean;
  olderAfterDays: SidebarOlderAfterDays;
  projectGroupingMode: SidebarProjectGroupingMode;
  updateSettings: ReturnType<typeof useUpdateClientSettings>;
  isManualProjectSorting: boolean;
  projectDnDSensors: ReturnType<typeof useSensors>;
  projectCollisionDetection: CollisionDetection;
  handleProjectDragStart: (event: DragStartEvent) => void;
  handleProjectDragEnd: (event: DragEndEvent) => void;
  handleProjectDragCancel: (event: DragCancelEvent) => void;
  handleNewThread: ReturnType<typeof useNewThreadHandler>;
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  sortedProjects: readonly SidebarProjectSnapshot[];
  projectStatusByKey: ReadonlyMap<string, SidebarProjectRailStatus>;
  expandedThreadListsByProject: ReadonlySet<string>;
  activeRouteProjectKey: string | null;
  routeThreadKey: string | null;
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
  focusCount: number;
  focusSectionCounts: SidebarFocusSectionCounts;
}

const SidebarProjectsContent = memo(function SidebarProjectsContent(
  props: SidebarProjectsContentProps,
) {
  const openAddProject = useOpenAddProjectCommandPalette();
  const openNewThreadProjectPicker = useOpenNewThreadProjectCommandPalette();
  const {
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    handleDesktopUpdateButtonClick,
    projectSortOrder,
    threadLayout,
    threadSortOrder,
    foldOlderThreads,
    olderAfterDays,
    projectGroupingMode,
    updateSettings,
    isManualProjectSorting,
    projectDnDSensors,
    projectCollisionDetection,
    handleProjectDragStart,
    handleProjectDragEnd,
    handleProjectDragCancel,
    handleNewThread,
    archiveThread,
    deleteThread,
    sortedProjects,
    projectStatusByKey,
    activeRouteProjectKey,
    routeThreadKey,
    newThreadShortcutLabel,
    commandPaletteShortcutLabel,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandThreadListForProject,
    collapseThreadListForProject,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    projectsLength,
    focusCount,
    focusSectionCounts,
  } = props;

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
  const handleThreadLayoutChange = useCallback(
    (layout: SidebarThreadLayout) => updateSettings({ sidebarThreadLayout: layout }),
    [updateSettings],
  );
  const handleFoldOlderThreadsChange = useCallback(
    (fold: boolean) => updateSettings({ sidebarFoldOlderThreads: fold }),
    [updateSettings],
  );
  const handleOlderAfterDaysChange = useCallback(
    (days: SidebarOlderAfterDays) => updateSettings({ sidebarOlderAfterDays: days }),
    [updateSettings],
  );
  const handleProjectGroupingModeChange = useCallback(
    (groupingMode: SidebarProjectGroupingMode) => {
      updateSettings({ sidebarProjectGroupingMode: groupingMode });
    },
    [updateSettings],
  );
  const [navigatorSelection, setNavigatorSelection] = useState<string>(
    () => activeRouteProjectKey ?? "focus",
  );
  useEffect(() => {
    if (activeRouteProjectKey) setNavigatorSelection(activeRouteProjectKey);
  }, [activeRouteProjectKey]);
  const selectedProject = sortedProjects.find(
    (project) => project.projectKey === navigatorSelection,
  );
  const handleFocusNewThreadClick = useCallback(() => {
    openNewThreadProjectPicker(sortedProjects);
  }, [openNewThreadProjectPicker, sortedProjects]);
  const renderProjectPanel = (project: SidebarProjectSnapshot, mode: "focus" | "project") => (
    <SidebarProjectItem
      key={project.projectKey}
      project={project}
      navigatorMode={mode}
      isThreadListExpanded
      activeRouteThreadKey={activeRouteProjectKey === project.projectKey ? routeThreadKey : null}
      newThreadShortcutLabel={newThreadShortcutLabel}
      handleNewThread={handleNewThread}
      archiveThread={archiveThread}
      deleteThread={deleteThread}
      threadJumpLabelByKey={threadJumpLabelByKey}
      attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
      expandThreadListForProject={expandThreadListForProject}
      collapseThreadListForProject={collapseThreadListForProject}
      dragInProgressRef={dragInProgressRef}
      suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
      suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
      isManualProjectSorting={false}
      dragHandleProps={null}
    />
  );
  const renderProjectRailItem = (project: SidebarProjectSnapshot) => (
    <SidebarProjectItem
      key={project.projectKey}
      project={project}
      navigatorMode="rail"
      railSelected={navigatorSelection === project.projectKey}
      railStatus={projectStatusByKey.get(project.projectKey) ?? null}
      onRailSelect={() => setNavigatorSelection(project.projectKey)}
      isThreadListExpanded
      activeRouteThreadKey={activeRouteProjectKey === project.projectKey ? routeThreadKey : null}
      newThreadShortcutLabel={newThreadShortcutLabel}
      handleNewThread={handleNewThread}
      archiveThread={archiveThread}
      deleteThread={deleteThread}
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
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex gap-1.5 border-b border-border/60 p-2">
        <CommandDialogTrigger
          render={
            <button
              type="button"
              className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md bg-muted/50 px-2 text-[11px] text-muted-foreground/55"
              data-testid="command-palette-trigger"
            />
          }
        >
          <SearchIcon className="size-3.5" />
          <span className="truncate">Find anything</span>
          {commandPaletteShortcutLabel ? (
            <span className="ml-auto font-mono text-[9px] opacity-60">
              {commandPaletteShortcutLabel}
            </span>
          ) : null}
        </CommandDialogTrigger>
        <ProjectSortMenu
          foldOlderThreads={foldOlderThreads}
          olderAfterDays={olderAfterDays}
          projectSortOrder={projectSortOrder}
          threadLayout={threadLayout}
          threadSortOrder={threadSortOrder}
          projectGroupingMode={projectGroupingMode}
          onFoldOlderThreadsChange={handleFoldOlderThreadsChange}
          onOlderAfterDaysChange={handleOlderAfterDaysChange}
          onProjectSortOrderChange={handleProjectSortOrderChange}
          onThreadLayoutChange={handleThreadLayoutChange}
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
                className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground/55 transition-colors hover:bg-accent hover:text-foreground"
                onClick={openAddProject}
              />
            }
          >
            <FolderPlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Add project</TooltipPopup>
        </Tooltip>
      </div>
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
      <LocalSecondaryStatus />
      <div className="grid h-full min-h-0 flex-1 grid-cols-[3.25rem_minmax(0,1fr)] overflow-hidden">
        <nav className="flex h-full min-h-0 flex-col items-center overflow-hidden border-r border-border/70 bg-muted/20 px-1.5 py-2">
          <button
            type="button"
            aria-label="Focus"
            onClick={() => setNavigatorSelection("focus")}
            className={`relative flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors ${navigatorSelection === "focus" ? "bg-foreground text-background shadow-sm" : "text-muted-foreground/60 hover:bg-accent hover:text-foreground"}`}
          >
            <InboxIcon className="size-4" />
            {focusCount > 0 ? (
              <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-amber-500 font-mono text-[8px] font-semibold text-amber-950 ring-2 ring-sidebar">
                {focusCount > 9 ? "9+" : focusCount}
              </span>
            ) : null}
          </button>
          <div className="my-2 h-px w-6 bg-border/70" />
          <div className="min-h-0 w-[calc(100%+1rem)] flex-1 self-start space-y-1 overflow-y-auto overflow-x-hidden overscroll-contain pb-1 pr-4 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <DndContext
              sensors={projectDnDSensors}
              collisionDetection={projectCollisionDetection}
              modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
              onDragStart={handleProjectDragStart}
              onDragEnd={handleProjectDragEnd}
              onDragCancel={handleProjectDragCancel}
            >
              <SortableContext
                items={sortedProjects.map((project) => project.projectKey)}
                strategy={verticalListSortingStrategy}
              >
                {sortedProjects.map(renderProjectRailItem)}
              </SortableContext>
            </DndContext>
          </div>
          <Link
            to="/settings/archived"
            aria-label="Archived threads"
            className="mt-2 flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground/55 transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArchiveIcon className="size-4" />
          </Link>
        </nav>
        <div className="min-h-0 min-w-0 overflow-hidden">
          {selectedProject ? (
            <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
              {renderProjectPanel(selectedProject, "project")}
            </div>
          ) : (
            <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
              <div className="border-b border-border/60 p-2">
                <button
                  type="button"
                  onClick={handleFocusNewThreadClick}
                  className="flex h-10 w-full min-w-0 items-center gap-2 rounded-lg bg-foreground px-2.5 text-left text-background shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-background/15">
                    <PlusIcon className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold">New thread</span>
                  <span className="max-w-24 truncate font-mono text-[9px] text-background/55">
                    Choose project
                  </span>
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-2 pt-1">
                {(
                  Object.entries({
                    needs: "Action required",
                    failed: "Failed",
                    completed: "Completed",
                    working: "In progress",
                  }) as Array<[keyof SidebarFocusSectionCounts, string]>
                ).map(([section, label], index) =>
                  focusSectionCounts[section] > 0 ? (
                    <div
                      key={section}
                      className="flex h-7 shrink-0 items-center px-[0.875rem] text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/45"
                      style={{ order: index * 20 }}
                    >
                      <span>{label}</span>
                      <span className="ml-auto font-mono tracking-normal">
                        {focusSectionCounts[section]}
                      </span>
                    </div>
                  ) : null,
                )}
                {sortedProjects
                  .filter(
                    (project) =>
                      project.projectKey === activeRouteProjectKey ||
                      projectStatusByKey.has(project.projectKey),
                  )
                  .map((project) => renderProjectPanel(project, "focus"))}
              </div>
            </div>
          )}
          {projectsLength === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground/60">
              No projects yet
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});

export default function Sidebar() {
  const projects = useProjects();
  const sidebarThreads = useThreadShells();
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const threadLastVisitedAtById = useUiStateStore((store) => store.threadLastVisitedAtById);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isOnSettings = pathname.startsWith("/settings");
  const sidebarThreadSortOrder = useClientSettings((s) => s.sidebarThreadSortOrder);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const sidebarProjectGroupingMode = useClientSettings((s) => s.sidebarProjectGroupingMode);
  const sidebarThreadLayout = useClientSettings((s) => s.sidebarThreadLayout);
  const sidebarFoldOlderThreads = useClientSettings((s) => s.sidebarFoldOlderThreads);
  const sidebarOlderAfterDays = useClientSettings((s) => s.sidebarOlderAfterDays);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const sidebarThreadPreviewCount = useClientSettings((s) => s.sidebarThreadPreviewCount);
  const updateSettings = useUpdateClientSettings();
  const handleNewThread = useNewThreadHandler();
  const { archiveThread, deleteThread } = useThreadActions();
  const { isMobile, setOpenMobile } = useSidebar();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
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
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const platform = navigator.platform;
  const shortcutModifiers = useShortcutModifierState();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const desktopLocalEnvironmentIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => isDesktopLocalConnectionTarget(environment.entry.target))
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  }, [projectOrder, projects]);

  // Build a mapping from physical project key → logical project key for
  // cross-environment grouping.  Projects that share a repositoryIdentity
  // canonicalKey are treated as one logical project in the sidebar.
  const physicalToLogicalKey = useMemo(() => {
    return buildPhysicalToLogicalProjectKeyMap({
      projects: orderedProjects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
    });
  }, [orderedProjects, projectGroupingSettings, primaryEnvironmentId]);
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
      resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      isDesktopLocalEnvironment: (environmentId) => desktopLocalEnvironmentIds.has(environmentId),
    });
  }, [
    environmentLabelById,
    desktopLocalEnvironmentIds,
    orderedProjects,
    projectGroupingSettings,
    primaryEnvironmentId,
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
  const projectStatusByKey = useMemo(() => {
    const statuses = new Map<string, SidebarProjectRailStatus>();
    for (const [projectKey, threads] of threadsByProjectKey) {
      if (
        threads.some(
          (thread) => thread.session?.status === "error" || thread.latestTurn?.state === "error",
        )
      ) {
        statuses.set(projectKey, "failed");
        continue;
      }
      const threadStatuses = threads.map((thread) =>
        resolveThreadStatusPill({
          thread: {
            ...thread,
            lastVisitedAt:
              threadLastVisitedAtById[
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
              ],
          },
        }),
      );
      if (
        threadStatuses.some(
          (status) =>
            status?.label === "Pending Approval" ||
            status?.label === "Awaiting Input" ||
            status?.label === "Plan Ready",
        )
      ) {
        statuses.set(projectKey, "needs");
      } else if (threadStatuses.some((status) => status?.label === "Completed")) {
        statuses.set(projectKey, "completed");
      } else if (
        threadStatuses.some(
          (status) => status?.label === "Working" || status?.label === "Connecting",
        )
      ) {
        statuses.set(projectKey, "working");
      }
    }
    return statuses;
  }, [threadLastVisitedAtById, threadsByProjectKey]);
  const focusSectionCounts = useMemo<SidebarFocusSectionCounts>(() => {
    const counts: SidebarFocusSectionCounts = { needs: 0, failed: 0, completed: 0, working: 0 };
    for (const thread of sidebarThreads) {
      if (thread.archivedAt !== null) continue;
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const status = resolveThreadStatusPill({
        thread: { ...thread, lastVisitedAt: threadLastVisitedAtById[threadKey] },
      });
      const section = getSidebarThreadSection({
        thread,
        status,
        foldOlder: false,
        olderAfterDays: sidebarOlderAfterDays,
      });
      if (
        section === "needs" ||
        section === "failed" ||
        section === "completed" ||
        section === "working"
      ) {
        counts[section] += 1;
      }
    }
    return counts;
  }, [sidebarOlderAfterDays, sidebarThreads, threadLastVisitedAtById]);
  const focusCount = focusSectionCounts.needs + focusSectionCounts.failed;
  const getCurrentSidebarShortcutContext = useCallback(
    () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeTerminalOpen,
      modelPickerOpen: isModelPickerOpen(),
    }),
    [routeTerminalOpen],
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
      });
    },
    [clearSelection, isMobile, navigate, setOpenMobile, setSelectionAnchor],
  );

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
      const activeProject = sidebarProjects.find((project) => project.projectKey === active.id);
      const overProject = sidebarProjects.find((project) => project.projectKey === over.id);
      if (!activeProject || !overProject) return;
      const activeMemberKeys = activeProject.memberProjects.map(
        (member) => member.physicalProjectKey,
      );
      const overMemberKeys = overProject.memberProjects.map((member) => member.physicalProjectKey);
      reorderProjects(orderedProjects.map(getProjectOrderKey), activeMemberKeys, overMemberKeys);
    },
    [orderedProjects, sidebarProjectSortOrder, reorderProjects, sidebarProjects],
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

  const animatedThreadListsRef = useRef(new WeakSet<HTMLElement>());
  const attachThreadListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedThreadListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedThreadListsRef.current.add(node);
  }, []);

  const visibleThreads = useMemo(
    () => sidebarThreads.filter((thread) => thread.archivedAt === null),
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
  const isManualProjectSorting = sidebarProjectSortOrder === "manual";
  const visibleSidebarThreadKeys = useMemo(
    () =>
      sortedProjects.flatMap((project) => {
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
                  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
                  activeThreadKey,
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
      }),
    [
      sidebarThreadSortOrder,
      sidebarThreadPreviewCount,
      expandedThreadListsByProject,
      projectExpandedById,
      routeThreadKey,
      sortedProjects,
      threadsByProjectKey,
    ],
  );
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
  const sidebarShortcutContext = {
    terminalFocus: false,
    terminalOpen: routeTerminalOpen,
    modelPickerOpen: isModelPickerOpen(),
  };
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
  const prewarmedSidebarThreadKeys = useMemo(
    () => getSidebarThreadIdsToPrewarm(visibleSidebarThreadKeys),
    [visibleSidebarThreadKeys],
  );
  const prewarmedSidebarThreadRefs = useMemo(
    () =>
      prewarmedSidebarThreadKeys.flatMap((threadKey) => {
        const ref = parseScopedThreadKey(threadKey);
        return ref ? [ref] : [];
      }),
    [prewarmedSidebarThreadKeys],
  );

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

  const expandThreadListForProject = useCallback((projectKey: string) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectKey)) return current;
      const next = new Set(current);
      next.add(projectKey);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectKey: string) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectKey)) return current;
      const next = new Set(current);
      next.delete(projectKey);
      return next;
    });
  }, []);

  return (
    <>
      {prewarmedSidebarThreadRefs.map((threadRef) => (
        <SidebarThreadDetailPrewarmer key={scopedThreadKey(threadRef)} threadRef={threadRef} />
      ))}
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
            threadLayout={sidebarThreadLayout}
            threadSortOrder={sidebarThreadSortOrder}
            foldOlderThreads={sidebarFoldOlderThreads}
            olderAfterDays={sidebarOlderAfterDays}
            projectGroupingMode={sidebarProjectGroupingMode}
            updateSettings={updateSettings}
            isManualProjectSorting={isManualProjectSorting}
            projectDnDSensors={projectDnDSensors}
            projectCollisionDetection={projectCollisionDetection}
            handleProjectDragStart={handleProjectDragStart}
            handleProjectDragEnd={handleProjectDragEnd}
            handleProjectDragCancel={handleProjectDragCancel}
            handleNewThread={handleNewThread}
            archiveThread={archiveThread}
            deleteThread={deleteThread}
            sortedProjects={sortedProjects}
            projectStatusByKey={projectStatusByKey}
            expandedThreadListsByProject={expandedThreadListsByProject}
            activeRouteProjectKey={activeRouteProjectKey}
            routeThreadKey={routeThreadKey}
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
            projectsLength={projects.length}
            focusCount={focusCount}
            focusSectionCounts={focusSectionCounts}
          />

          <SidebarChromeFooter />
        </>
      )}
    </>
  );
}
