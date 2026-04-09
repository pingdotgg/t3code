import {
  ArchiveIcon,
  ArrowUpDownIcon,
  ChevronRightIcon,
  CloudIcon,
  FolderIcon,
  GitPullRequestIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { ProjectFavicon } from "./ProjectFavicon";
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
  DEFAULT_MODEL_BY_PROVIDER,
  type DesktopUpdateState,
  type EnvironmentId,
  ProjectId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadEnvMode,
  ThreadId,
  type GitStatusResult,
} from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime";
import { Link, useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import {
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
} from "@t3tools/contracts/settings";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { isElectron } from "../env";
import { APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isLinuxPlatform, isMacPlatform, newCommandId, newProjectId } from "../lib/utils";
import {
  selectProjectByRef,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsForProjectRef,
  selectSidebarThreadsForProjectRefs,
  selectSidebarThreadsAcrossEnvironments,
  selectThreadByRef,
  useStore,
} from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHints,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useGitStatus } from "../lib/gitStatusState";
import { readLocalApi } from "../localApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";

import { useThreadActions } from "../hooks/useThreadActions";
import {
  buildThreadRouteParams,
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { toastManager } from "./ui/toast";
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
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
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
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import {
  resolveAdjacentThreadId,
  isContextMenuPointerDown,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
  useThreadJumpHintVisibility,
  ThreadStatusPill,
} from "./Sidebar.logic";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { readEnvironmentApi } from "../environmentApi";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "../rpc/serverState";
import { deriveLogicalProjectKey } from "../logicalProject";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import type { Project, SidebarThreadSummary } from "../types";
const THREAD_PREVIEW_LIMIT = 6;
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

function threadJumpLabelMapsEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left === right) {
    return true;
  }
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
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

type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

type SidebarProjectSnapshot = Project & {
  projectKey: string;
  environmentPresence: EnvironmentPresence;
  memberProjectRefs: readonly ScopedProjectRef[];
  /** Labels for remote environments this project lives in. */
  remoteEnvironmentLabels: readonly string[];
};
interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

type ThreadPr = GitStatusResult["pr"];

function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <span
        title={status.label}
        className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
      >
        <span
          className={`size-[9px] rounded-full ${status.dotClass} ${
            status.pulse ? "animate-pulse" : ""
          }`}
        />
        <span className="sr-only">{status.label}</span>
      </span>
    );
  }

  return (
    <span
      title={status.label}
      className={`inline-flex items-center gap-1 text-[10px] ${status.colorClass}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
          status.pulse ? "animate-pulse" : ""
        }`}
      />
      <span className="hidden md:inline">{status.label}</span>
    </span>
  );
}

function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

function resolveThreadPr(
  threadBranch: string | null,
  gitStatus: GitStatusResult | null,
): ThreadPr | null {
  if (threadBranch === null || gitStatus === null || gitStatus.branch !== threadBranch) {
    return null;
  }

  return gitStatus.pr ?? null;
}

interface SidebarThreadRowProps {
  thread: SidebarThreadSummary;
  projectCwd: string | null;
  orderedProjectThreadKeys: readonly string[];
  isActive: boolean;
  jumpLabel: string | null;
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

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    orderedProjectThreadKeys,
    isActive,
    jumpLabel,
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
    navigateToThread,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    openPrLink,
    thread,
  } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const hasSelection = useThreadSelectionStore((state) => state.selectedThreadKeys.size > 0);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).runningTerminalIds,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread =
    primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = useSavedEnvironmentRuntimeStore(
    (s) => s.byId[thread.environmentId]?.descriptor?.label ?? null,
  );
  const remoteEnvSavedLabel = useSavedEnvironmentRegistryStore(
    (s) => s.byId[thread.environmentId]?.label ?? null,
  );
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvLabel ?? remoteEnvSavedLabel ?? "Remote")
    : null;
  // For grouped projects, the thread may belong to a different environment
  // than the representative project.  Look up the thread's own project cwd
  // so git status (and thus PR detection) queries the correct path.
  const threadProjectCwd = useStore(
    useMemo(
      () => (state: import("../store").AppState) =>
        selectProjectByRef(state, scopeProjectRef(thread.environmentId, thread.projectId))?.cwd ??
        null,
      [thread.environmentId, thread.projectId],
    ),
  );
  const gitCwd = thread.worktreePath ?? threadProjectCwd ?? props.projectCwd;
  const gitStatus = useGitStatus({
    environmentId: thread.environmentId,
    cwd: thread.branch != null ? gitCwd : null,
  });
  const isHighlighted = isActive || isSelected;
  const isThreadRunning =
    thread.session?.status === "running" && thread.session.activeTurnId != null;
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const isConfirmingArchive = confirmingArchiveThreadKey === threadKey && !isThreadRunning;
  const threadMetaClassName = isConfirmingArchive
    ? "pointer-events-none opacity-0"
    : !isThreadRunning
      ? "pointer-events-none transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
      : "pointer-events-none";
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
      handleThreadClick(event, threadRef, orderedProjectThreadKeys);
    },
    [handleThreadClick, orderedProjectThreadKeys, threadRef],
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
      if (hasSelection && isSelected) {
        void handleMultiSelectContextMenu({
          x: event.clientX,
          y: event.clientY,
        });
        return;
      }

      if (hasSelection) {
        clearSelection();
      }
      void handleThreadContextMenu(threadRef, {
        x: event.clientX,
        y: event.clientY,
      });
    },
    [
      clearSelection,
      handleMultiSelectContextMenu,
      handleThreadContextMenu,
      hasSelection,
      isSelected,
      threadRef,
    ],
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
  const rowButtonRender = useMemo(() => <div role="button" tabIndex={0} />, []);

  return (
    <SidebarMenuSubItem
      className="w-full"
      data-thread-item
      onMouseLeave={handleMouseLeave}
      onBlurCapture={handleBlurCapture}
    >
      <SidebarMenuSubButton
        render={rowButtonRender}
        size="sm"
        isActive={isActive}
        data-testid={`thread-row-${thread.id}`}
        className={`${resolveThreadRowClassName({
          isActive,
          isSelected,
        })} relative isolate`}
        onClick={handleRowClick}
        onKeyDown={handleRowKeyDown}
        onContextMenu={handleRowContextMenu}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {prStatus && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={prStatus.tooltip}
                    className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                    onClick={handlePrClick}
                  >
                    <GitPullRequestIcon className="size-3" />
                  </button>
                }
              />
              <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
            </Tooltip>
          )}
          {threadStatus && <ThreadStatusLabel status={threadStatus} />}
          {renamingThreadKey === threadKey ? (
            <input
              ref={handleRenameInputRef}
              className="min-w-0 flex-1 truncate text-xs bg-transparent outline-none border border-ring rounded px-0.5"
              value={renamingTitle}
              onChange={handleRenameInputChange}
              onKeyDown={handleRenameInputKeyDown}
              onBlur={handleRenameInputBlur}
              onClick={handleRenameInputClick}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs">{thread.title}</span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {terminalStatus && (
            <span
              role="img"
              aria-label={terminalStatus.label}
              title={terminalStatus.label}
              className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
            >
              <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} />
            </span>
          )}
          <div className="flex min-w-12 justify-end">
            {isConfirmingArchive ? (
              <button
                ref={handleConfirmArchiveRef}
                type="button"
                data-thread-selection-safe
                data-testid={`thread-archive-confirm-${thread.id}`}
                aria-label={`Confirm archive ${thread.title}`}
                className="absolute top-1/2 right-1 inline-flex h-5 -translate-y-1/2 cursor-pointer items-center rounded-full bg-destructive/12 px-2 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40"
                onPointerDown={stopPropagationOnPointerDown}
                onClick={handleConfirmArchiveClick}
              >
                Confirm
              </button>
            ) : !isThreadRunning ? (
              appSettingsConfirmThreadArchive ? (
                <div className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                  <button
                    type="button"
                    data-thread-selection-safe
                    data-testid={`thread-archive-${thread.id}`}
                    aria-label={`Archive ${thread.title}`}
                    className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
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
                      <div className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={`thread-archive-${thread.id}`}
                          aria-label={`Archive ${thread.title}`}
                          className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
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
                {isRemoteThread && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          aria-label={threadEnvironmentLabel ?? "Remote"}
                          className="inline-flex items-center justify-center"
                        />
                      }
                    >
                      <CloudIcon className="size-3 text-muted-foreground/40" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
                  </Tooltip>
                )}
                {jumpLabel ? (
                  <span
                    className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/90 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
                    title={jumpLabel}
                  >
                    {jumpLabel}
                  </span>
                ) : (
                  <span
                    className={`text-[10px] ${
                      isHighlighted
                        ? "text-foreground/72 dark:text-foreground/82"
                        : "text-muted-foreground/40"
                    }`}
                  >
                    {formatRelativeTimeLabel(thread.updatedAt ?? thread.createdAt)}
                  </span>
                )}
              </span>
            </span>
          </div>
        </div>
      </SidebarMenuSubButton>
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
  projectCwd: string;
  activeRouteThreadKey: string | null;
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
    projectCwd,
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
    expandThreadListForProject,
    collapseThreadListForProject,
  } = props;
  const showMoreButtonRender = useMemo(() => <button type="button" />, []);
  const showLessButtonRender = useMemo(() => <button type="button" />, []);

  return (
    <SidebarMenuSub
      ref={attachThreadListAutoAnimateRef}
      className="mx-1 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1.5 py-0"
    >
      {shouldShowThreadPanel && showEmptyThreadState ? (
        <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
          <div
            data-thread-selection-safe
            className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60"
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
              projectCwd={projectCwd}
              orderedProjectThreadKeys={orderedProjectThreadKeys}
              isActive={activeRouteThreadKey === threadKey}
              jumpLabel={threadJumpLabelByKey.get(threadKey) ?? null}
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
        })}

      {projectExpanded && hasOverflowingThreads && !isThreadListExpanded && (
        <SidebarMenuSubItem className="w-full">
          <SidebarMenuSubButton
            render={showMoreButtonRender}
            data-thread-selection-safe
            size="sm"
            className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
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
            className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
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
  newThreadShortcutLabel: string | null;
  handleNewThread: ReturnType<typeof useNewThreadHandler>["handleNewThread"];
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
  const defaultThreadEnvMode = useSettings<ThreadEnvMode>(
    (settings) => settings.defaultThreadEnvMode,
  );
  const router = useRouter();
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const toggleProject = useUiStateStore((state) => state.toggleProject);
  const toggleThreadSelection = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const removeFromSelection = useThreadSelectionStore((state) => state.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const selectedThreadCount = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const clearComposerDraftForThread = useComposerDraftStore((state) => state.clearDraftThread);
  const getDraftThreadByProjectRef = useComposerDraftStore(
    (state) => state.getDraftThreadByProjectRef,
  );
  const clearProjectDraftThreadId = useComposerDraftStore(
    (state) => state.clearProjectDraftThreadId,
  );
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
      toastManager.add({
        type: "error",
        title: "Failed to copy thread ID",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
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
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const openPrLink = useCallback((event: React.MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);
  const sidebarThreads = useStore(
    useShallow(
      useMemo(
        () => (state: import("../store").AppState) =>
          selectSidebarThreadsForProjectRef(
            state,
            scopeProjectRef(project.environmentId, project.id),
          ),
        [project.environmentId, project.id],
      ),
    ),
  );
  // For grouped projects that span multiple environments, also fetch
  // threads from the other member project refs.
  const otherMemberRefs = useMemo(
    () =>
      project.memberProjectRefs.filter(
        (ref) => ref.environmentId !== project.environmentId || ref.projectId !== project.id,
      ),
    [project.memberProjectRefs, project.environmentId, project.id],
  );
  const otherMemberThreads = useStore(
    useShallow(
      useMemo(
        () =>
          otherMemberRefs.length === 0
            ? () => [] as SidebarThreadSummary[]
            : (state: import("../store").AppState) =>
                selectSidebarThreadsForProjectRefs(state, otherMemberRefs),
        [otherMemberRefs],
      ),
    ),
  );
  const allSidebarThreads = useMemo(
    () =>
      otherMemberThreads.length === 0 ? sidebarThreads : [...sidebarThreads, ...otherMemberThreads],
    [sidebarThreads, otherMemberThreads],
  );
  const sidebarThreadByKey = useMemo(
    () =>
      new Map(
        allSidebarThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [allSidebarThreads],
  );
  // All threads from the representative + other member environments are
  // already fetched into allSidebarThreads, so we can use them directly.
  const projectThreads = allSidebarThreads;
  const projectExpanded = useUiStateStore(
    (state) => state.projectExpandedById[project.projectKey] ?? true,
  );
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
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const { projectStatus, visibleProjectThreads, orderedProjectThreadKeys } = useMemo(() => {
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
    const visibleProjectThreads = sortThreadsForSidebar(
      projectThreads.filter((thread) => thread.archivedAt === null),
      threadSortOrder,
    );
    const projectStatus = resolveProjectStatusIndicator(
      visibleProjectThreads.map((thread) => resolveProjectThreadStatus(thread)),
    );
    return {
      orderedProjectThreadKeys: visibleProjectThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
      projectStatus,
      visibleProjectThreads,
    };
  }, [projectThreads, threadLastVisitedAts, threadSortOrder]);

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
    const hasOverflowingThreads = visibleProjectThreads.length > THREAD_PREVIEW_LIMIT;
    const previewThreads =
      isThreadListExpanded || !hasOverflowingThreads
        ? visibleProjectThreads
        : visibleProjectThreads.slice(0, THREAD_PREVIEW_LIMIT);
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
    threadLastVisitedAts,
    visibleProjectThreads,
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
      if (selectedThreadCount > 0) {
        clearSelection();
      }
      toggleProject(project.projectKey);
    },
    [
      clearSelection,
      dragInProgressRef,
      project.projectKey,
      selectedThreadCount,
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
      toggleProject(project.projectKey);
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

  const handleProjectButtonContextMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      suppressProjectClickForContextMenuRef.current = true;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;

        const clicked = await api.contextMenu.show(
          [
            { id: "copy-path", label: "Copy Project Path" },
            { id: "delete", label: "Remove project", destructive: true },
          ],
          {
            x: event.clientX,
            y: event.clientY,
          },
        );
        if (clicked === "copy-path") {
          copyPathToClipboard(project.cwd, { path: project.cwd });
          return;
        }
        if (clicked !== "delete") return;

        if (projectThreads.length > 0) {
          toastManager.add({
            type: "warning",
            title: "Project is not empty",
            description: "Delete all threads in this project before removing it.",
          });
          return;
        }

        const confirmed = await api.dialogs.confirm(`Remove project "${project.name}"?`);
        if (!confirmed) return;

        try {
          const projectDraftThread = getDraftThreadByProjectRef(
            scopeProjectRef(project.environmentId, project.id),
          );
          if (projectDraftThread) {
            clearComposerDraftForThread(projectDraftThread.draftId);
          }
          clearProjectDraftThreadId(scopeProjectRef(project.environmentId, project.id));
          const projectApi = readEnvironmentApi(project.environmentId);
          if (!projectApi) {
            throw new Error("Project API unavailable.");
          }
          await projectApi.orchestration.dispatchCommand({
            type: "project.delete",
            commandId: newCommandId(),
            projectId: project.id,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error removing project.";
          console.error("Failed to remove project", { projectId: project.id, error });
          toastManager.add({
            type: "error",
            title: `Failed to remove "${project.name}"`,
            description: message,
          });
        }
      })();
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadId,
      copyPathToClipboard,
      getDraftThreadByProjectRef,
      project.cwd,
      project.environmentId,
      project.id,
      project.name,
      projectThreads.length,
      suppressProjectClickForContextMenuRef,
    ],
  );

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, router, setSelectionAnchor],
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
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, rangeSelectTo, router, setSelectionAnchor, toggleThreadSelection],
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
          const thread = sidebarThreadByKey.get(threadKey);
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
        const thread = sidebarThreadByKey.get(threadKey);
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
      sidebarThreadByKey,
    ],
  );

  const handleCreateThreadClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
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
        projectId: project.id,
        defaultEnvMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: defaultThreadEnvMode,
        }),
        activeThread:
          currentActiveThread && currentActiveThread.projectId === project.id
            ? {
                projectId: currentActiveThread.projectId,
                branch: currentActiveThread.branch,
                worktreePath: currentActiveThread.worktreePath,
              }
            : null,
        activeDraftThread:
          currentActiveDraftThread && currentActiveDraftThread.projectId === project.id
            ? {
                projectId: currentActiveDraftThread.projectId,
                branch: currentActiveDraftThread.branch,
                worktreePath: currentActiveDraftThread.worktreePath,
                envMode: currentActiveDraftThread.envMode,
              }
            : null,
      });
      void handleNewThread(scopeProjectRef(project.environmentId, project.id), {
        ...(seedContext.branch !== undefined ? { branch: seedContext.branch } : {}),
        ...(seedContext.worktreePath !== undefined
          ? { worktreePath: seedContext.worktreePath }
          : {}),
        envMode: seedContext.envMode,
      });
    },
    [defaultThreadEnvMode, handleNewThread, project.environmentId, project.id, router],
  );

  const attemptArchiveThread = useCallback(
    async (threadRef: ScopedThreadRef) => {
      try {
        await archiveThread(threadRef);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to archive thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [archiveThread],
  );

  const cancelRename = useCallback(() => {
    setRenamingThreadKey(null);
    renamingInputRef.current = null;
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
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  const handleThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKey = scopedThreadKey(threadRef);
      const thread =
        projectThreads.find(
          (projectThread) =>
            projectThread.environmentId === threadRef.environmentId &&
            projectThread.id === threadRef.threadId,
        ) ?? null;
      if (!thread) return;
      const threadWorkspacePath = thread.worktreePath ?? project.cwd ?? null;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

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
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path to copy.",
          });
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
      await deleteThread(threadRef);
    },
    [
      appSettingsConfirmThreadDelete,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      markThreadUnread,
      project.cwd,
      projectThreads,
    ],
  );

  return (
    <>
      <div className="group/project-header relative">
        <SidebarMenuButton
          ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
          size="sm"
          className={`gap-2 px-2 py-1.5 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground ${
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
            <span
              aria-hidden="true"
              title={projectStatus.label}
              className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
            >
              <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                <span
                  className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                    projectStatus.pulse ? "animate-pulse" : ""
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
          <span className="flex-1 truncate text-xs font-medium text-foreground/90">
            {project.name}
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
                  className="pointer-events-none absolute top-1 right-1.5 inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/50 transition-opacity duration-150 group-hover/project-header:opacity-0 group-focus-within/project-header:opacity-0"
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
              <div className="pointer-events-none absolute top-1 right-1.5 opacity-0 transition-opacity duration-150 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100">
                <button
                  type="button"
                  aria-label={`Create new thread in ${project.name}`}
                  data-testid="new-thread-button"
                  className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
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
        projectCwd={project.cwd}
        activeRouteThreadKey={activeRouteThreadKey}
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

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
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
                <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
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
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
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

const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const wordmark = (
    <div className="flex items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label="Go to threads"
              className="ml-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md outline-hidden ring-ring transition-colors hover:text-foreground focus-visible:ring-2"
              to="/"
            >
              <T3Wordmark />
              <span className="truncate text-sm font-medium tracking-tight text-muted-foreground">
                Code
              </span>
              <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
                {APP_STAGE_LABEL}
              </span>
            </Link>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
    </div>
  );

  return isElectron ? (
    <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px]">
      {wordmark}
    </SidebarHeader>
  ) : (
    <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">{wordmark}</SidebarHeader>
  );
});

const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const handleSettingsClick = useCallback(() => {
    void navigate({ to: "/settings" });
  }, [navigate]);

  return (
    <SidebarFooter className="p-2">
      <SidebarUpdatePill />
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            onClick={handleSettingsClick}
          >
            <SettingsIcon className="size-3.5" />
            <span className="text-xs">Settings</span>
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
  updateSettings: ReturnType<typeof useUpdateSettings>["updateSettings"];
  shouldShowProjectPathEntry: boolean;
  handleStartAddProject: () => void;
  isElectron: boolean;
  isPickingFolder: boolean;
  isAddingProject: boolean;
  handlePickFolder: () => Promise<void>;
  addProjectInputRef: React.RefObject<HTMLInputElement | null>;
  addProjectError: string | null;
  newCwd: string;
  setNewCwd: React.Dispatch<React.SetStateAction<string>>;
  setAddProjectError: React.Dispatch<React.SetStateAction<string | null>>;
  handleAddProject: () => void;
  setAddingProject: React.Dispatch<React.SetStateAction<boolean>>;
  canAddProject: boolean;
  isManualProjectSorting: boolean;
  projectDnDSensors: ReturnType<typeof useSensors>;
  projectCollisionDetection: CollisionDetection;
  handleProjectDragStart: (event: DragStartEvent) => void;
  handleProjectDragEnd: (event: DragEndEvent) => void;
  handleProjectDragCancel: (event: DragCancelEvent) => void;
  handleNewThread: ReturnType<typeof useNewThreadHandler>["handleNewThread"];
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  sortedProjects: readonly SidebarProjectSnapshot[];
  expandedThreadListsByProject: ReadonlySet<string>;
  activeRouteProjectKey: string | null;
  routeThreadKey: string | null;
  newThreadShortcutLabel: string | null;
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
    handleDesktopUpdateButtonClick,
    projectSortOrder,
    threadSortOrder,
    updateSettings,
    shouldShowProjectPathEntry,
    handleStartAddProject,
    isElectron,
    isPickingFolder,
    isAddingProject,
    handlePickFolder,
    addProjectInputRef,
    addProjectError,
    newCwd,
    setNewCwd,
    setAddProjectError,
    handleAddProject,
    setAddingProject,
    canAddProject,
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
    expandedThreadListsByProject,
    activeRouteProjectKey,
    routeThreadKey,
    newThreadShortcutLabel,
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
  const handleAddProjectInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setNewCwd(event.target.value);
      setAddProjectError(null);
    },
    [setAddProjectError, setNewCwd],
  );
  const handleAddProjectInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") handleAddProject();
      if (event.key === "Escape") {
        setAddingProject(false);
        setAddProjectError(null);
      }
    },
    [handleAddProject, setAddProjectError, setAddingProject],
  );
  const handleBrowseForFolderClick = useCallback(() => {
    void handlePickFolder();
  }, [handlePickFolder]);

  return (
    <SidebarContent className="gap-0">
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
      <SidebarGroup className="px-2 py-2">
        <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
            Projects
          </span>
          <div className="flex items-center gap-1">
            <ProjectSortMenu
              projectSortOrder={projectSortOrder}
              threadSortOrder={threadSortOrder}
              onProjectSortOrderChange={handleProjectSortOrderChange}
              onThreadSortOrderChange={handleThreadSortOrderChange}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
                    aria-pressed={shouldShowProjectPathEntry}
                    className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                    onClick={handleStartAddProject}
                  />
                }
              >
                <PlusIcon
                  className={`size-3.5 transition-transform duration-150 ${
                    shouldShowProjectPathEntry ? "rotate-45" : "rotate-0"
                  }`}
                />
              </TooltipTrigger>
              <TooltipPopup side="right">
                {shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
              </TooltipPopup>
            </Tooltip>
          </div>
        </div>
        {shouldShowProjectPathEntry && (
          <div className="mb-2 px-1">
            {isElectron && (
              <button
                type="button"
                className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-xs text-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleBrowseForFolderClick}
                disabled={isPickingFolder || isAddingProject}
              >
                <FolderIcon className="size-3.5" />
                {isPickingFolder ? "Picking folder..." : "Browse for folder"}
              </button>
            )}
            <div className="flex gap-1.5">
              <input
                ref={addProjectInputRef}
                className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
                  addProjectError
                    ? "border-red-500/70 focus:border-red-500"
                    : "border-border focus:border-ring"
                }`}
                placeholder="/path/to/project"
                value={newCwd}
                onChange={handleAddProjectInputChange}
                onKeyDown={handleAddProjectInputKeyDown}
                autoFocus
              />
              <button
                type="button"
                className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
                onClick={handleAddProject}
                disabled={!canAddProject}
              >
                {isAddingProject ? "Adding..." : "Add"}
              </button>
            </div>
            {addProjectError && (
              <p className="mt-1 px-0.5 text-[11px] leading-tight text-red-400">
                {addProjectError}
              </p>
            )}
          </div>
        )}

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
                        isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                        activeRouteThreadKey={
                          activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                        }
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
            ))}
          </SidebarMenu>
        )}

        {projectsLength === 0 && !shouldShowProjectPathEntry && (
          <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
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
  const activeEnvironmentId = useStore((store) => store.activeEnvironmentId);
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isOnSettings = pathname.startsWith("/settings");
  const sidebarThreadSortOrder = useSettings((s) => s.sidebarThreadSortOrder);
  const sidebarProjectSortOrder = useSettings((s) => s.sidebarProjectSortOrder);
  const defaultThreadEnvMode = useSettings((s) => s.defaultThreadEnvMode);
  const { updateSettings } = useUpdateSettings();
  const { handleNewThread } = useNewThreadHandler();
  const { archiveThread, deleteThread } = useThreadActions();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const keybindings = useServerKeybindings();
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const selectedThreadCount = useThreadSelectionStore((s) => s.selectedThreadKeys.size);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const isLinuxDesktop = isElectron && isLinuxPlatform(navigator.platform);
  const platform = navigator.platform;
  const shouldBrowseForProjectImmediately = isElectron && !isLinuxDesktop;
  const shouldShowProjectPathEntry = addingProject && !shouldBrowseForProjectImmediately;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: (project) => scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
    });
  }, [projectOrder, projects]);

  // Build a mapping from physical project key → logical project key for
  // cross-environment grouping.  Projects that share a repositoryIdentity
  // canonicalKey are treated as one logical project in the sidebar.
  const physicalToLogicalKey = useMemo(() => {
    const mapping = new Map<string, string>();
    for (const project of orderedProjects) {
      const physicalKey = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
      mapping.set(physicalKey, deriveLogicalProjectKey(project));
    }
    return mapping;
  }, [orderedProjects]);

  const sidebarProjects = useMemo<SidebarProjectSnapshot[]>(() => {
    // Group projects by logical key while preserving insertion order from
    // orderedProjects.
    const groupedMembers = new Map<string, Project[]>();
    for (const project of orderedProjects) {
      const logicalKey = deriveLogicalProjectKey(project);
      const existing = groupedMembers.get(logicalKey);
      if (existing) {
        existing.push(project);
      } else {
        groupedMembers.set(logicalKey, [project]);
      }
    }

    const result: SidebarProjectSnapshot[] = [];
    const seen = new Set<string>();
    for (const project of orderedProjects) {
      const logicalKey = deriveLogicalProjectKey(project);
      if (seen.has(logicalKey)) continue;
      seen.add(logicalKey);

      const members = groupedMembers.get(logicalKey)!;
      // Prefer the primary environment's project as the representative.
      const representative: Project | undefined =
        (primaryEnvironmentId
          ? members.find((p) => p.environmentId === primaryEnvironmentId)
          : undefined) ?? members[0];
      if (!representative) continue;
      const hasLocal =
        primaryEnvironmentId !== null &&
        members.some((p) => p.environmentId === primaryEnvironmentId);
      const hasRemote =
        primaryEnvironmentId !== null
          ? members.some((p) => p.environmentId !== primaryEnvironmentId)
          : false;

      const refs = members.map((p) => scopeProjectRef(p.environmentId, p.id));
      const remoteLabels = members
        .filter((p) => primaryEnvironmentId !== null && p.environmentId !== primaryEnvironmentId)
        .map((p) => {
          const rt = savedEnvironmentRuntimeById[p.environmentId];
          const saved = savedEnvironmentRegistry[p.environmentId];
          return rt?.descriptor?.label ?? saved?.label ?? p.environmentId;
        });
      const snapshot: SidebarProjectSnapshot = {
        id: representative.id,
        environmentId: representative.environmentId,
        name: representative.name,
        cwd: representative.cwd,
        repositoryIdentity: representative.repositoryIdentity ?? null,
        defaultModelSelection: representative.defaultModelSelection,
        createdAt: representative.createdAt,
        updatedAt: representative.updatedAt,
        scripts: representative.scripts,
        projectKey: logicalKey,
        environmentPresence:
          hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
        memberProjectRefs: refs,
        remoteEnvironmentLabels: remoteLabels,
      };
      result.push(snapshot);
    }
    return result;
  }, [
    orderedProjects,
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
    const physicalKey = scopedProjectKey(
      scopeProjectRef(activeThread.environmentId, activeThread.projectId),
    );
    return physicalToLogicalKey.get(physicalKey) ?? physicalKey;
  }, [routeThreadKey, sidebarThreadByKey, physicalToLogicalKey]);

  // Group threads by logical project key so all threads from grouped projects
  // are displayed together.
  const threadsByProjectKey = useMemo(() => {
    const next = new Map<string, SidebarThreadSummary[]>();
    for (const thread of sidebarThreads) {
      const physicalKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      const logicalKey = physicalToLogicalKey.get(physicalKey) ?? physicalKey;
      const existing = next.get(logicalKey);
      if (existing) {
        existing.push(thread);
      } else {
        next.set(logicalKey, [thread]);
      }
    }
    return next;
  }, [sidebarThreads, physicalToLogicalKey]);
  const getCurrentSidebarShortcutContext = useCallback(
    () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeThreadRef
        ? selectThreadTerminalState(
            useTerminalStateStore.getState().terminalStateByThreadKey,
            routeThreadRef,
          ).terminalOpen
        : false,
    }),
    [routeThreadRef],
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
  const focusMostRecentThreadForProject = useCallback(
    (projectRef: { environmentId: EnvironmentId; projectId: ProjectId }) => {
      const physicalKey = scopedProjectKey(
        scopeProjectRef(projectRef.environmentId, projectRef.projectId),
      );
      const logicalKey = physicalToLogicalKey.get(physicalKey) ?? physicalKey;
      const latestThread = sortThreadsForSidebar(
        (threadsByProjectKey.get(logicalKey) ?? []).filter((thread) => thread.archivedAt === null),
        sidebarThreadSortOrder,
      )[0];
      if (!latestThread) return;

      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(latestThread.environmentId, latestThread.id)),
      });
    },
    [sidebarThreadSortOrder, navigate, threadsByProjectKey, physicalToLogicalKey],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = activeEnvironmentId ? readEnvironmentApi(activeEnvironmentId) : undefined;
      if (!api) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setAddingProject(false);
      };

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        focusMostRecentThreadForProject({
          environmentId: existing.environmentId,
          projectId: existing.id,
        });
        finishAddingProject();
        return;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          createdAt,
        });
        if (activeEnvironmentId !== null) {
          await handleNewThread(scopeProjectRef(activeEnvironmentId, projectId), {
            envMode: defaultThreadEnvMode,
          }).catch(() => undefined);
        }
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        if (shouldBrowseForProjectImmediately) {
          toastManager.add({
            type: "error",
            title: "Failed to add project",
            description,
          });
        } else {
          setAddProjectError(description);
        }
        return;
      }
      finishAddingProject();
    },
    [
      focusMostRecentThreadForProject,
      activeEnvironmentId,
      handleNewThread,
      isAddingProject,
      projects,
      shouldBrowseForProjectImmediately,
      defaultThreadEnvMode,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

  const handlePickFolder = async () => {
    const api = readLocalApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the current thread selection unchanged.
    }
    if (pickedPath) {
      await addProjectFromPath(pickedPath);
    } else if (!shouldBrowseForProjectImmediately) {
      addProjectInputRef.current?.focus();
    }
    setIsPickingFolder(false);
  };

  const handleStartAddProject = () => {
    setAddProjectError(null);
    if (shouldBrowseForProjectImmediately) {
      void handlePickFolder();
      return;
    }
    setAddingProject((prev) => !prev);
  };

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, navigate, setSelectionAnchor],
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
      reorderProjects(activeProject.projectKey, overProject.projectKey);
    },
    [sidebarProjectSortOrder, reorderProjects, sidebarProjects],
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
      const physicalKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
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
    sidebarProjectByKey,
    sidebarProjects,
    visibleThreads,
  ]);
  const isManualProjectSorting = sidebarProjectSortOrder === "manual";
  const visibleSidebarThreadKeys = useMemo(
    () =>
      sortedProjects.flatMap((project) => {
        const projectThreads = sortThreadsForSidebar(
          (threadsByProjectKey.get(project.projectKey) ?? []).filter(
            (thread) => thread.archivedAt === null,
          ),
          sidebarThreadSortOrder,
        );
        const projectExpanded = projectExpandedById[project.projectKey] ?? true;
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
        const hasOverflowingThreads = projectThreads.length > THREAD_PREVIEW_LIMIT;
        const previewThreads =
          isThreadListExpanded || !hasOverflowingThreads
            ? projectThreads
            : projectThreads.slice(0, THREAD_PREVIEW_LIMIT);
        const renderedThreads = pinnedCollapsedThread ? [pinnedCollapsedThread] : previewThreads;
        return renderedThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        );
      }),
    [
      sidebarThreadSortOrder,
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
  const [threadJumpLabelByKey, setThreadJumpLabelByKey] =
    useState<ReadonlyMap<string, string>>(EMPTY_THREAD_JUMP_LABELS);
  const threadJumpLabelsRef = useRef<ReadonlyMap<string, string>>(EMPTY_THREAD_JUMP_LABELS);
  threadJumpLabelsRef.current = threadJumpLabelByKey;
  const showThreadJumpHintsRef = useRef(showThreadJumpHints);
  showThreadJumpHintsRef.current = showThreadJumpHints;
  const visibleThreadJumpLabelByKey = showThreadJumpHints
    ? threadJumpLabelByKey
    : EMPTY_THREAD_JUMP_LABELS;
  const orderedSidebarThreadKeys = visibleSidebarThreadKeys;

  useEffect(() => {
    const clearThreadJumpHints = () => {
      setThreadJumpLabelByKey((current) =>
        current === EMPTY_THREAD_JUMP_LABELS ? current : EMPTY_THREAD_JUMP_LABELS,
      );
      updateThreadJumpHintsVisibility(false);
    };
    const shouldIgnoreThreadJumpHintUpdate = (event: globalThis.KeyboardEvent) =>
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key !== "Meta" &&
      event.key !== "Control" &&
      event.key !== "Alt" &&
      event.key !== "Shift" &&
      !showThreadJumpHintsRef.current &&
      threadJumpLabelsRef.current === EMPTY_THREAD_JUMP_LABELS;

    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (shouldIgnoreThreadJumpHintUpdate(event)) {
        return;
      }
      const shortcutContext = getCurrentSidebarShortcutContext();
      const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
        platform,
        context: shortcutContext,
      });
      if (!shouldShowHints) {
        if (
          showThreadJumpHintsRef.current ||
          threadJumpLabelsRef.current !== EMPTY_THREAD_JUMP_LABELS
        ) {
          clearThreadJumpHints();
        }
      } else {
        setThreadJumpLabelByKey((current) => {
          const nextLabelMap = buildThreadJumpLabelMap({
            keybindings,
            platform,
            terminalOpen: shortcutContext.terminalOpen,
            threadJumpCommandByKey,
          });
          return threadJumpLabelMapsEqual(current, nextLabelMap) ? current : nextLabelMap;
        });
        updateThreadJumpHintsVisibility(true);
      }

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

    const onWindowKeyUp = (event: globalThis.KeyboardEvent) => {
      if (shouldIgnoreThreadJumpHintUpdate(event)) {
        return;
      }
      const shortcutContext = getCurrentSidebarShortcutContext();
      const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
        platform,
        context: shortcutContext,
      });
      if (!shouldShowHints) {
        clearThreadJumpHints();
        return;
      }
      setThreadJumpLabelByKey((current) => {
        const nextLabelMap = buildThreadJumpLabelMap({
          keybindings,
          platform,
          terminalOpen: shortcutContext.terminalOpen,
          threadJumpCommandByKey,
        });
        return threadJumpLabelMapsEqual(current, nextLabelMap) ? current : nextLabelMap;
      });
      updateThreadJumpHintsVisibility(true);
    };

    const onWindowBlur = () => {
      clearThreadJumpHints();
    };

    window.addEventListener("keydown", onWindowKeyDown);
    window.addEventListener("keyup", onWindowKeyUp);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
      window.removeEventListener("keyup", onWindowKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [
    getCurrentSidebarShortcutContext,
    keybindings,
    navigateToThread,
    orderedSidebarThreadKeys,
    platform,
    routeThreadKey,
    sidebarThreadByKey,
    threadJumpCommandByKey,
    threadJumpThreadKeys,
    updateThreadJumpHintsVisibility,
  ]);

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadCount === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection, selectedThreadCount]);

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
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
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
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
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
            updateSettings={updateSettings}
            shouldShowProjectPathEntry={shouldShowProjectPathEntry}
            handleStartAddProject={handleStartAddProject}
            isElectron={isElectron}
            isPickingFolder={isPickingFolder}
            isAddingProject={isAddingProject}
            handlePickFolder={handlePickFolder}
            addProjectInputRef={addProjectInputRef}
            addProjectError={addProjectError}
            newCwd={newCwd}
            setNewCwd={setNewCwd}
            setAddProjectError={setAddProjectError}
            handleAddProject={handleAddProject}
            setAddingProject={setAddingProject}
            canAddProject={canAddProject}
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
            expandedThreadListsByProject={expandedThreadListsByProject}
            activeRouteProjectKey={activeRouteProjectKey}
            routeThreadKey={routeThreadKey}
            newThreadShortcutLabel={newThreadShortcutLabel}
            threadJumpLabelByKey={visibleThreadJumpLabelByKey}
            attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
            expandThreadListForProject={expandThreadListForProject}
            collapseThreadListForProject={collapseThreadListForProject}
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
