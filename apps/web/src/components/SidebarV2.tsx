import { autoAnimate } from "@formkit/auto-animate";
import { useAtomValue } from "@effect/atom-react";
import {
  canSettle,
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, SidebarProjectGroupingMode } from "@t3tools/contracts";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ClockIcon,
  CopyIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  Globe2Icon,
  EllipsisIcon,
  MessageSquareIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SquarePenIcon,
  TerminalIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useParams, useRouter } from "@tanstack/react-router";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useShortcutModifierState } from "../shortcutModifierState";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isMacPlatform } from "~/lib/utils";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { readLocalApi } from "../localApi";
import {
  deriveProjectGroupingOverrideKey,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { openCommandPalette } from "../commandPaletteBus";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useNowMinute } from "../hooks/useNowMinute";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { useRunningTerminalsForThreads } from "../state/terminalSessions";
import { useDiscoveredPortsForThreads } from "../portDiscoveryState";
import { previewEnvironment } from "../state/preview";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../state/server";
import { vcsEnvironment } from "../state/vcs";
import { threadEnvironment } from "../state/threads";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { formatRelativeTimeLabel, parseTimestampDate } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { cn } from "~/lib/utils";
import {
  formatWorkingDurationLabel,
  firstValidTimestampMs,
  hasUnseenCompletion,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  resolveAdjacentThreadId,
  resolveSettledTimestamp,
  resolveSidebarV2Status,
  shouldNavigateAfterProjectRemoval,
  sortLogicalProjectsForSidebar,
} from "./Sidebar.logic";
import { resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import { openDiscoveredPort } from "./preview/openDiscoveredPort";
import {
  buildSidebarWorktreeGroups,
  pickWorktreeGroupRepresentative,
  pickWorktreeGroupTimeLabelThread,
  resolveWorktreeGroupLiveStatus,
  sidebarThreadKey,
  type SidebarThreadClassification,
  type SidebarWorktreeGroup,
} from "./SidebarV2.logic";
import {
  prStatusIndicator,
  resolveThreadPr,
  settledPrHoverColorClass,
} from "./ThreadStatusIndicators";
import {
  resolveSnoozePresets,
  snoozeWakeDescription,
  snoozeWakeLabel,
  type SnoozePreset,
} from "./Sidebar.snooze";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "./chat/providerIconUtils";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../providerInstances";
import { primaryServerProvidersAtom } from "../state/server";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { CommandDialogTrigger } from "./ui/command";
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
import { Kbd } from "./ui/kbd";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { SidebarContent, SidebarGroup, SidebarMenuButton, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { useComposerDraftStore } from "../composerDraftStore";

// Settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more.
const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;
const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};

function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function threadTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  return compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

// Settled rows read "how long ago did this wrap up", matching their sort
// key: both go through resolveSettledTimestamp so label and order can't
// disagree.
function settledTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = resolveSettledTimestamp(thread);
  return timestamp === null ? "" : compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

// Floats at the row's right edge, vertically centered, while the jump
// modifier is held. An overlay pill instead of an inline slot: the hint
// must neither displace the status/time label (holding ⌘ used to blank
// out "Working") nor shift any layout when it appears. pointer-events-none
// so it never swallows clicks meant for the settle/un-settle buttons it
// can overlap.
function JumpHintBadge(props: { label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
    >
      {props.label}
    </span>
  );
}

// Self-ticking so only this span re-renders each second, not the whole row.
function WorkingDuration(props: { startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Number.isNaN(startedMs)) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(id);
  }, [startedMs]);
  if (Number.isNaN(startedMs)) return null;
  return (
    <span className="font-mono tabular-nums">
      {formatWorkingDurationLabel(Date.now() - startedMs)}
    </span>
  );
}

function SidebarV2ThreadTooltip({
  thread,
  projectTitle,
  projectCwd,
  environmentLabel,
  driverKind,
  modelInstanceId,
  modelLabel,
  branchMismatch,
}: {
  thread: SidebarThreadSummary;
  projectTitle: string | null;
  projectCwd: string | null;
  environmentLabel: string | null;
  driverKind: ProviderInstanceEntry["driverKind"] | null;
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
}) {
  return (
    <TooltipPopup
      side="right"
      align="start"
      sideOffset={4}
      variant="glass"
      className="max-w-80 text-left whitespace-normal"
    >
      <div className="flex min-w-0 max-w-80 flex-col gap-2 px-0.5 py-1.5">
        <div className="min-w-0 truncate text-xs leading-none font-medium text-foreground">
          {thread.title}
        </div>
        <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
          {projectTitle ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProjectFavicon
                environmentId={thread.environmentId}
                cwd={projectCwd ?? ""}
                className="size-3 shrink-0 stroke-muted-foreground"
              />
              <div className="min-w-0 truncate text-foreground/75">{projectTitle}</div>
            </div>
          ) : null}
          {environmentLabel ? (
            <div className="flex min-w-0 items-center gap-2">
              <ServerIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
            </div>
          ) : null}
          {thread.branch ? (
            <div className="flex min-w-0 items-center gap-2">
              <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">{thread.branch}</div>
            </div>
          ) : null}
          {branchMismatch ? (
            <div className="flex min-w-0 items-start gap-2 text-warning">
              <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
              <div className="min-w-0 flex-1 wrap-break-word leading-5">
                You're currently checked out on another branch.
              </div>
            </div>
          ) : null}
          {driverKind ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProviderInstanceIcon
                driverKind={driverKind}
                displayName={thread.session?.providerName ?? modelInstanceId}
                iconClassName="size-3 shrink-0 grayscale opacity-60"
              />
              <div className="min-w-0 truncate text-foreground/75">{modelLabel}</div>
            </div>
          ) : null}
          {thread.session?.lastError ? (
            <div className="flex min-w-0 items-center gap-2 text-red-600 dark:text-red-400">
              <CircleAlertIcon className="size-3 shrink-0 stroke-current" />
              <div className="min-w-0 truncate">Error occurred</div>
            </div>
          ) : null}
        </div>
      </div>
    </TooltipPopup>
  );
}

/**
 * Hover entry point for snooze: a clock button opening the preset menu.
 * Controlled by the row (which also uses the open state to pin its hover
 * actions while the menu is up).
 */
function SnoozePopoverButton(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (preset: SnoozePreset) => void;
}) {
  const { open, onOpenChange, onSnooze } = props;
  // Presets resolve at open time so "In 1 hour" is relative to the click,
  // not to when the row mounted.
  const presets = useMemo(() => (open ? resolveSnoozePresets(new Date()) : []), [open]);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Snooze thread"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
          />
        }
      >
        <ClockIcon className="size-3" />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-56" viewportClassName="p-1">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenChange(false);
              onSnooze(preset);
            }}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 hover:bg-accent hover:text-foreground"
          >
            <span className="flex-1">{preset.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
              {preset.whenLabel}
            </span>
          </button>
        ))}
      </PopoverPopup>
    </Popover>
  );
}

// Slim shelf row: one row per parked WORKTREE (snoozed or settled group).
// `thread` is the group's representative member (route thread when it's a
// member); lifecycle actions act on the whole group via the parent.
const SidebarV2Row = memo(function SidebarV2Row(props: {
  thread: SidebarThreadSummary;
  variantAction: "unsettle" | "unsnooze";
  // False on environments whose server predates thread.settle/unsettle:
  // the lifecycle affordances hide entirely rather than fail on click.
  settlementSupported: boolean;
  // Same contract for thread.snooze/unsnooze.
  snoozeSupported: boolean;
  // Compact wake countdown ("2h") for rows in the snoozed shelf.
  snoozeWakeLabelText: string | null;
  // When a snooze ended (timer or early wake); drives the Woke pill until
  // the user visits the thread.
  wokeAt: string | null;
  isActive: boolean;
  jumpLabel: string | null;
  currentEnvironmentId: string | null;
  environmentLabel: string | null;
  projectCwd: string | null;
  projectTitle: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  // Every member thread key in the row's worktree group: the row owns the
  // group's single VCS subscription, and the partition needs the PR state
  // under each member's key for effectiveSettled.
  changeRequestThreadKeys: ReadonlyArray<string>;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  onUnsnooze: (threadRef: ScopedThreadRef) => void;
  onChangeRequestState: (threadKey: string, state: "open" | "closed" | "merged" | null) => void;
}) {
  const {
    isRenaming,
    onChangeRequestState,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onRenameTitleChange,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onUnsettle,
    onUnsnooze,
    renamingTitle,
    thread,
    variantAction,
  } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const openPrLink = useOpenPrLink();

  // Same semantics as v1 (never-visited counts as read): flipping the beta
  // flag must not light up every historical thread as unread.
  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarV2Status(thread);
  // A woken thread reappears at its original position (the sort is
  // deliberately static), so the pill has to carry the weight. Snoozing is
  // an explicit act, so unlike Done, a never-visited woke thread still
  // shows the pill; visiting clears it. An unparseable visit timestamp
  // counts as never-visited — corrupt local data must not eat the wake
  // signal.
  const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
  const wokeAtDate = props.wokeAt === null ? null : parseTimestampDate(props.wokeAt);
  const isWoke = wokeAtDate !== null && (lastVisitedDate === null || lastVisitedDate < wokeAtDate);
  // In-flight rows (working, or waiting on approval/input) fade as a whole:
  // there is nothing for the user to do yet, so prominence is reserved for
  // rows that need a human — done (unread), read-but-unsettled, failed, and
  // freshly woken. The status label keeps its hue, so waiting rows stay
  // findable. In-flight rows recede the same as read-ready ones (inbox-zero:
  // working threads aren't your problem yet) — only the colored status label
  // stands out.
  const isInFlight = status === "working" || status === "approval" || status === "input";
  const shouldRecede =
    (status === "ready" || isInFlight) && !isUnread && !isWoke && !props.isActive && !isSelected;

  const gitCwd = thread.worktreePath ?? props.projectCwd;
  const gitStatus = useEnvironmentQuery(
    (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: gitStatus.data?.refName ?? null,
  });
  const pr = resolveThreadPr({
    threadBranch: thread.branch,
    gitStatus: gitStatus.data,
  });
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
  const settledPrHoverClass = pr ? settledPrHoverColorClass(pr.state) : undefined;
  // Report the PR state up: the parent partitions rows with effectiveSettled,
  // and a merged/closed PR auto-settles a thread — data only rows have. The
  // worktree's PR state applies to every member thread of the group.
  const prState = pr?.state ?? null;
  const { changeRequestThreadKeys } = props;
  useEffect(() => {
    for (const memberKey of changeRequestThreadKeys) {
      onChangeRequestState(memberKey, prState);
    }
  }, [changeRequestThreadKeys, onChangeRequestState, prState]);

  const modelInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const driverKind = providerEntry?.driverKind ?? null;
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;

  const detailsTooltip = (
    <SidebarV2ThreadTooltip
      thread={thread}
      projectTitle={props.projectTitle}
      projectCwd={props.projectCwd}
      environmentLabel={props.environmentLabel}
      driverKind={driverKind}
      modelInstanceId={modelInstanceId}
      modelLabel={modelLabel}
      branchMismatch={branchMismatch}
    />
  );

  const handleClick = useCallback(
    (event: ReactMouseEvent) => {
      onThreadClick(event, threadRef);
    },
    [onThreadClick, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, threadRef],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onThreadActivate(threadRef);
    },
    [onThreadActivate, threadRef],
  );
  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (isRenaming || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if ((event.target as HTMLElement).closest("button, a, input")) return;
      event.preventDefault();
      onStartRename(threadRef, thread.title);
    },
    [isRenaming, onStartRename, thread.title, threadRef],
  );
  const renameCommittedRef = useRef(false);
  useEffect(() => {
    if (isRenaming) renameCommittedRef.current = false;
  }, [isRenaming]);
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCommitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCancelRename();
      }
    },
    [onCancelRename, onCommitRename, renamingTitle, thread.title, threadRef],
  );
  const handleRenameBlur = useCallback(() => {
    if (!renameCommittedRef.current) {
      onCommitRename(threadRef, renamingTitle, thread.title);
    }
  }, [onCommitRename, renamingTitle, thread.title, threadRef]);
  const handleUnsettleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnsettle(threadRef);
    },
    [onUnsettle, threadRef],
  );
  const handleUnsnoozeClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnsnooze(threadRef);
    },
    [onUnsnooze, threadRef],
  );
  const handlePrClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (pr?.url) openPrLink(event, pr.url);
    },
    [openPrLink, pr],
  );

  // All Sidebar V2 rows share one surface model. Live threads used to look
  // like elevated cards while settled threads were plain rows, leaving neither
  // a useful hierarchy nor a reliable hover cue. Status now lives in the row
  // content; surface is reserved for interaction (hover, multi-select, route).
  const rowSurfaceClassName = cn(
    "group/v2-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none",
    props.isActive
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : isSelected
        ? "bg-sidebar-row-selected text-sidebar-foreground"
        : shouldRecede
          ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
    isInFlight &&
      !props.isActive &&
      !isSelected &&
      "opacity-70 transition-opacity hover:opacity-100",
  );

  const title = isRenaming ? (
    <input
      autoFocus
      value={renamingTitle}
      aria-label="Thread title"
      onChange={(event) => onRenameTitleChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleRenameKeyDown}
      onBlur={handleRenameBlur}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
    />
  ) : (
    <span
      className={cn(
        "min-w-0 flex-1 text-sm",
        shouldRecede ? "font-normal" : "font-medium",
        "truncate group-hover/v2-row:text-foreground",
        props.isActive || isWoke
          ? "text-foreground"
          : isUnread
            ? "text-muted-foreground"
            : "text-muted-foreground/70",
      )}
    >
      {thread.title}
    </span>
  );

  const prBadge =
    prStatus && pr ? (
      <button
        type="button"
        onClick={handlePrClick}
        className={cn(
          "shrink-0 font-mono text-xs hover:underline",
          variantAction === "unsettle"
            ? props.isActive
              ? "text-muted-foreground/70"
              : cn("text-muted-foreground/35 transition-colors", settledPrHoverClass)
            : prStatus.colorClass,
        )}
        aria-label={prStatus.tooltip}
      >
        #{pr.number}
      </button>
    ) : null;

  return (
    <li
        data-thread-item
        className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_34px]"
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                role="button"
                tabIndex={0}
                data-testid="sidebar-v2-row-slim"
                className={cn(rowSurfaceClassName, "flex h-9 items-center gap-2.5 px-2.5")}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onKeyDown={handleKeyDown}
                onContextMenu={handleContextMenu}
              />
            }
          >
            {/* Settled history recedes: dimmed favicon at rest, restored on
              hover so the tail stays scannable when you're hunting. */}
            <span
              className={cn(
                "shrink-0 transition-opacity",
                !props.isActive &&
                  "opacity-40 grayscale group-hover/v2-row:opacity-100 group-hover/v2-row:grayscale-0",
              )}
            >
              <ProjectFavicon
                environmentId={thread.environmentId}
                cwd={props.projectCwd ?? ""}
                className="size-4"
                fallbackIcon={MessageSquareIcon}
              />
            </span>
            {title}
            {/* The PR badge stays outside the hover-fading slot: it must
              remain visible AND clickable while the row is hovered. Only
              the time/jump label yields to the settle affordance. */}
            {prBadge}
            <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end">
              <span className="inline-flex justify-end tabular-nums text-muted-foreground/55 transition-opacity group-hover/v2-row:opacity-0">
                {variantAction === "unsnooze" && props.snoozeWakeLabelText !== null ? (
                  // Snoozed rows show when they come BACK, not when they were
                  // last touched — the return ticket is the row's whole story.
                  <span className="text-xs text-blue-600 tabular-nums dark:text-blue-400">
                    {props.snoozeWakeLabelText}
                  </span>
                ) : isWoke ? (
                  // A wake can land straight in the settled tail (e.g. PR
                  // merged while snoozed); the signal must survive the trip.
                  <span
                    role="status"
                    aria-label="Woke from snooze"
                    className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300"
                  >
                    <AlarmClockIcon aria-hidden className="size-3" />
                    Woke
                  </span>
                ) : (
                  <span className="text-xs">
                    {variantAction === "unsettle"
                      ? settledTimeLabel(thread)
                      : threadTimeLabel(thread)}
                  </span>
                )}
              </span>
              {variantAction === "unsnooze" ? (
                !props.snoozeSupported ? null : (
                  <button
                    type="button"
                    aria-label="Wake thread now"
                    onClick={handleUnsnoozeClick}
                    className="absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/v2-row:opacity-100"
                  >
                    <AlarmClockOffIcon className="size-3" />
                  </button>
                )
              ) : !props.settlementSupported ? null : (
                <button
                  type="button"
                  aria-label="Un-settle thread"
                  onClick={handleUnsettleClick}
                  className="absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/v2-row:opacity-100"
                >
                  <Undo2Icon className="mb-px size-3.5" />
                </button>
              )}
            </span>
            {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
          </TooltipTrigger>
          {detailsTooltip}
        </Tooltip>
      </li>
  );
});


function latestTurnDiff(
  thread: SidebarThreadSummary,
): { insertions: number; deletions: number } | null {
  // Shells don't carry checkpoint summaries; diff stats render only when the
  // shell projection grows them. Kept as a seam so the row layout is ready.
  void thread;
  return null;
}

// One clickable line inside a worktree card: the thread's summary text is
// the navigation target, with the thread's own status signal and provider
// logo trailing it (threads in one worktree can run different providers).
const SidebarV2CardThreadRow = memo(function SidebarV2CardThreadRow(props: {
  thread: SidebarThreadSummary;
  isActive: boolean;
  wokeAt: string | null;
  jumpLabel: string | null;
  projectTitle: string | null;
  projectCwd: string | null;
  environmentLabel: string | null;
  branchMismatch: { threadBranch: string; currentBranch: string } | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  isRenaming: boolean;
  renamingTitle: string;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
}) {
  const {
    isRenaming,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onRenameTitleChange,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    renamingTitle,
    thread,
  } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));

  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarV2Status(thread);
  const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
  const wokeAtDate = props.wokeAt === null ? null : parseTimestampDate(props.wokeAt);
  const isWoke = wokeAtDate !== null && (lastVisitedDate === null || lastVisitedDate < wokeAtDate);
  const rowRecedes =
    (status === "ready" || status === "working" || status === "approval" || status === "input") &&
    !isUnread &&
    !isWoke &&
    !props.isActive &&
    !isSelected;

  const modelInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const driverKind = providerEntry?.driverKind ?? null;
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;

  const handleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.stopPropagation();
      onThreadClick(event, threadRef);
    },
    [onThreadClick, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, threadRef],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      onThreadActivate(threadRef);
    },
    [onThreadActivate, threadRef],
  );
  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.stopPropagation();
      if (isRenaming || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if ((event.target as HTMLElement).closest("button, a, input")) return;
      event.preventDefault();
      onStartRename(threadRef, thread.title);
    },
    [isRenaming, onStartRename, thread.title, threadRef],
  );
  const renameCommittedRef = useRef(false);
  useEffect(() => {
    if (isRenaming) renameCommittedRef.current = false;
  }, [isRenaming]);
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCommitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCancelRename();
      }
    },
    [onCancelRename, onCommitRename, renamingTitle, thread.title, threadRef],
  );
  const handleRenameBlur = useCallback(() => {
    if (!renameCommittedRef.current) {
      onCommitRename(threadRef, renamingTitle, thread.title);
    }
  }, [onCommitRename, renamingTitle, thread.title, threadRef]);

  // Per-thread signal, most-urgent first — the card's top row carries the
  // aggregate, this glyph says which member it's about.
  const statusGlyph =
    status === "approval" ? (
      <span
        role="status"
        aria-label="Pending approval"
        className="size-1.5 shrink-0 rounded-full bg-amber-500"
      />
    ) : status === "input" ? (
      <span
        role="status"
        aria-label="Awaiting input"
        className="size-1.5 shrink-0 rounded-full bg-indigo-500"
      />
    ) : status === "working" ? (
      <CircleDashedIcon
        role="status"
        aria-label="Working"
        className="size-3 shrink-0 animate-status-pulse text-sky-600 motion-reduce:animate-none dark:text-sky-400"
      />
    ) : status === "failed" ? (
      <CircleAlertIcon
        role="status"
        aria-label="Failed"
        className="size-3 shrink-0 text-red-600 dark:text-red-400"
      />
    ) : isWoke ? (
      <AlarmClockIcon
        role="status"
        aria-label="Woke from snooze"
        className="size-3 shrink-0 text-amber-700 dark:text-amber-300"
      />
    ) : isUnread ? (
      <span
        role="status"
        aria-label="Done, unread"
        className="size-1.5 shrink-0 rounded-full bg-emerald-500"
      />
    ) : null;

  const title = isRenaming ? (
    <input
      autoFocus
      value={renamingTitle}
      aria-label="Thread title"
      onChange={(event) => onRenameTitleChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleRenameKeyDown}
      onBlur={handleRenameBlur}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
    />
  ) : (
    <span
      className={cn(
        "min-w-0 flex-1 truncate text-sm",
        isUnread || isWoke || props.isActive
          ? "font-medium text-foreground"
          : status === "failed"
            ? "font-medium text-foreground/95"
            : rowRecedes
              ? "font-normal text-muted-foreground/80 group-hover/v2-thread:text-foreground"
              : "font-medium text-foreground/90",
      )}
    >
      {thread.title}
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="button"
            tabIndex={0}
            data-testid="sidebar-v2-card-thread"
            className={cn(
              "group/v2-thread relative -mx-1 flex h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded-[5px] px-1 text-left outline-none select-none",
              isSelected
                ? "bg-sidebar-row-selected"
                : props.isActive
                  ? "bg-sidebar-row-hover"
                  : "hover:bg-sidebar-row-hover",
            )}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleKeyDown}
            onContextMenu={handleContextMenu}
          />
        }
      >
        {title}
        {statusGlyph}
        {driverKind ? (
          <span className="inline-flex shrink-0 items-center opacity-60">
            <ProviderInstanceIcon
              driverKind={driverKind}
              displayName={thread.session?.providerName ?? modelInstanceId}
              iconClassName="size-3.5"
            />
          </span>
        ) : null}
        {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
      </TooltipTrigger>
      <SidebarV2ThreadTooltip
        thread={thread}
        projectTitle={props.projectTitle}
        projectCwd={props.projectCwd}
        environmentLabel={props.environmentLabel}
        driverKind={driverKind}
        modelInstanceId={modelInstanceId}
        modelLabel={modelLabel}
        branchMismatch={props.branchMismatch}
      />
    </Tooltip>
  );
});

// A worktree's card: repository identity, activity indicators and lifecycle
// actions live at the card (worktree) level; each member thread renders as
// its own clickable row inside.
const SidebarV2WorktreeCard = memo(function SidebarV2WorktreeCard(props: {
  groupKey: string;
  threads: ReadonlyArray<SidebarThreadSummary>;
  memberKeys: ReadonlyArray<string>;
  // Route thread key when it belongs to this worktree, else null.
  activeThreadKey: string | null;
  settlementSupported: boolean;
  snoozeSupported: boolean;
  snoozeNow: string;
  currentEnvironmentId: string | null;
  environmentLabel: string | null;
  projectCwd: string | null;
  projectTitle: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  // Null while jump hints are hidden so the common case keeps memo identity.
  jumpLabelByKey: ReadonlyMap<string, string> | null;
  renamingThreadKey: string | null;
  renamingTitle: string;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
  onSnooze: (threadRef: ScopedThreadRef, preset: SnoozePreset) => void;
  onChangeRequestState: (threadKey: string, state: "open" | "closed" | "merged" | null) => void;
}) {
  const {
    memberKeys,
    onChangeRequestState,
    onContextMenu,
    onSettle,
    onSnooze,
    onThreadActivate,
    onThreadClick,
    threads,
  } = props;
  const newest = threads[threads.length - 1]!;
  const newestRef = useMemo(
    () => scopeThreadRef(newest.environmentId, newest.id),
    [newest.environmentId, newest.id],
  );
  const activeMember =
    props.activeThreadKey === null
      ? null
      : (threads.find(
          (thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
            props.activeThreadKey,
        ) ?? null);
  const isActiveCard = activeMember !== null;
  const environmentId = newest.environmentId;
  const threadIds = useMemo(() => threads.map((thread) => thread.id), [threads]);

  // Worktree-level activity: any member thread's terminal with a running
  // subprocess, and any dev server discovered on a member's terminal. These
  // sit inline with the repository row because terminals and dev servers
  // belong to the checkout, not to an individual thread.
  const runningTerminals = useRunningTerminalsForThreads({ environmentId, threadIds });
  const discoveredPorts = useDiscoveredPortsForThreads({ environmentId, threadIds });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const handleOpenDiscoveredPort = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      const port = discoveredPorts[0];
      if (!port) return;
      event.preventDefault();
      event.stopPropagation();
      const targetRef =
        activeMember === null
          ? newestRef
          : scopeThreadRef(activeMember.environmentId, activeMember.id);
      onThreadActivate(targetRef);
      void (async () => {
        const result = await openDiscoveredPort({ threadRef: targetRef, port, openPreview });
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
    [activeMember, discoveredPorts, newestRef, onThreadActivate, openPreview],
  );

  const anySelected = useThreadSelectionStore((state) =>
    memberKeys.some((key) => state.selectedThreadKeys.has(key)),
  );
  // One subscription for all members' visited stamps: a joined signature
  // keeps the selector referentially stable while letting the card derive
  // per-member unread/woke without a hook per member.
  const visitedSignature = useUiStateStore((state) =>
    memberKeys.map((key) => state.threadLastVisitedAtById[key] ?? "").join(" "),
  );
  const { anyUnread, anyWoke, wokeAtByKey } = useMemo(() => {
    const visited = visitedSignature.split(" ");
    let anyUnread = false;
    let anyWoke = false;
    const wokeAtByKey = new Map<string, string | null>();
    threads.forEach((thread, index) => {
      const lastVisitedAt = visited[index] === "" ? undefined : visited[index];
      if (hasUnseenCompletion({ ...thread, lastVisitedAt })) anyUnread = true;
      const wokeAt = threadWokeAt(thread, { now: props.snoozeNow });
      wokeAtByKey.set(memberKeys[index]!, wokeAt);
      if (wokeAt !== null) {
        const lastVisitedDate = lastVisitedAt == null ? null : parseTimestampDate(lastVisitedAt);
        const wokeDate = parseTimestampDate(wokeAt);
        if (wokeDate !== null && (lastVisitedDate === null || lastVisitedDate < wokeDate)) {
          anyWoke = true;
        }
      }
    });
    return { anyUnread, anyWoke, wokeAtByKey };
  }, [memberKeys, props.snoozeNow, threads, visitedSignature]);

  const liveStatus = resolveWorktreeGroupLiveStatus(threads);
  const isInFlight = liveStatus !== null && liveStatus.kind !== "failed";
  const shouldRecede =
    (liveStatus === null || isInFlight) && !anyUnread && !anyWoke && !isActiveCard && !anySelected;
  const topStatus =
    liveStatus?.kind === "working"
      ? {
          label: "Working",
          icon: "working" as const,
          className:
            "animate-sidebar-working-text text-sky-600 motion-reduce:animate-none dark:text-sky-400",
        }
      : liveStatus?.kind === "approval"
        ? { label: "Approval", icon: null, className: "text-amber-700 dark:text-amber-300" }
        : liveStatus?.kind === "input"
          ? { label: "Input", icon: null, className: "text-indigo-600 dark:text-indigo-300" }
          : liveStatus?.kind === "failed"
            ? { label: "Failed", icon: null, className: "text-red-700 dark:text-red-300" }
            : anyWoke
              ? {
                  label: "Woke",
                  icon: "woke" as const,
                  className: "text-amber-700 dark:text-amber-300",
                }
              : anyUnread
                ? {
                    label: "Done",
                    icon: "done" as const,
                    className: "text-emerald-700 dark:text-emerald-300",
                  }
                : null;

  // The worktree's VCS state is card-level: one status subscription per
  // checkout, PR state fanned out to every member key for the partition.
  const worktreePath = threads.find((thread) => thread.worktreePath !== null)?.worktreePath ?? null;
  const gitCwd = worktreePath ?? props.projectCwd;
  const gitStatus = useEnvironmentQuery(
    (newest.branch != null || worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: worktreePath === null ? "local" : "worktree",
    activeWorktreePath: worktreePath,
    activeThreadBranch: newest.branch,
    currentGitBranch: gitStatus.data?.refName ?? null,
  });
  const pr = resolveThreadPr({
    threadBranch: newest.branch,
    gitStatus: gitStatus.data,
    hasDedicatedWorktree: worktreePath !== null,
  });
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
  const prState = pr?.state ?? null;
  useEffect(() => {
    for (const memberKey of memberKeys) {
      onChangeRequestState(memberKey, prState);
    }
  }, [memberKeys, onChangeRequestState, prState]);
  const openPrLink = useOpenPrLink();
  const handlePrClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.stopPropagation();
      if (pr?.url) openPrLink(event, pr.url);
    },
    [openPrLink, pr],
  );

  const handleCardClick = useCallback(
    (event: ReactMouseEvent) => {
      if (isTrailingDoubleClick(event.detail)) return;
      onThreadClick(event, newestRef);
    },
    [newestRef, onThreadClick],
  );
  const handleCardContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(newestRef, { x: event.clientX, y: event.clientY });
    },
    [newestRef, onContextMenu],
  );
  const handleCardKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onThreadActivate(newestRef);
    },
    [newestRef, onThreadActivate],
  );
  const handleSettleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onSettle(newestRef);
    },
    [newestRef, onSettle],
  );
  const handleSnoozePreset = useCallback(
    (preset: SnoozePreset) => {
      onSnooze(newestRef, preset);
    },
    [newestRef, onSnooze],
  );
  // While the snooze popover is open the pointer leaves the card, which
  // would fade the hover actions out from under the open menu; pin them.
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  // Snooze acts on the whole worktree, so it's offered only when every
  // member can take it — a half-applied snooze would leave the card in
  // place and read as a failed click.
  const snoozeNowIso = new Date().toISOString();
  const showSnoozeButton =
    props.snoozeSupported && threads.every((thread) => canSnooze(thread, { now: snoozeNowIso }));
  const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton;
  useEffect(() => {
    if (!showSnoozeButton) setSnoozeMenuOpen(false);
  }, [showSnoozeButton]);

  const isRemote =
    props.currentEnvironmentId !== null && environmentId !== props.currentEnvironmentId;
  const diff = latestTurnDiff(newest);
  const timeLabelThread = pickWorktreeGroupTimeLabelThread(threads);

  const cardSurfaceClassName = cn(
    "group/v2-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none",
    isActiveCard
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : anySelected
        ? "bg-sidebar-row-selected text-sidebar-foreground"
        : shouldRecede
          ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
    isInFlight && !isActiveCard && !anySelected && "opacity-70 transition-opacity hover:opacity-100",
  );

  return (
    <li
      data-thread-item
      className="list-none py-0.5 [content-visibility:auto]"
      style={{ containIntrinsicSize: `auto ${96 + (threads.length - 1) * 24}px` }}
    >
      <div
        role="button"
        tabIndex={0}
        data-testid="sidebar-v2-row-card"
        data-worktree-key={props.groupKey}
        className={cardSurfaceClassName}
        onClick={handleCardClick}
        onKeyDown={handleCardKeyDown}
        onContextMenu={handleCardContextMenu}
      >
        <div className="relative z-10 px-2.5 py-2">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <ProjectFavicon
              environmentId={environmentId}
              cwd={props.projectCwd ?? ""}
              className="size-4 shrink-0"
            />
            {props.projectTitle ? (
              <span
                className={cn(
                  "min-w-0 truncate text-xs text-muted-foreground/85",
                  shouldRecede ? "font-normal" : "font-medium",
                )}
              >
                {props.projectTitle}
              </span>
            ) : null}
            {runningTerminals.length > 0 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      role="img"
                      aria-label="Terminal process running"
                      data-testid="sidebar-v2-worktree-terminal-indicator"
                      className="inline-flex shrink-0 items-center justify-center text-teal-600 dark:text-teal-300/90"
                    />
                  }
                >
                  <TerminalIcon className="size-3 animate-status-pulse" />
                </TooltipTrigger>
                <TooltipPopup side="top">Terminal process running</TooltipPopup>
              </Tooltip>
            ) : null}
            {discoveredPorts.length > 0 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`Open localhost:${discoveredPorts[0]?.port ?? ""}`}
                      data-testid="sidebar-v2-worktree-devserver-indicator"
                      className="inline-flex shrink-0 cursor-pointer items-center justify-center text-emerald-600 outline-hidden focus-visible:ring-1 focus-visible:ring-ring dark:text-emerald-400"
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
            <span className="relative ml-auto flex h-5 min-w-8 shrink-0 items-center justify-end pl-1 text-xs">
              <span
                className={cn(
                  "tabular-nums text-muted-foreground/65 transition-opacity group-hover/v2-row:opacity-0",
                  snoozeMenuOpen && "opacity-0",
                )}
              >
                {topStatus ? (
                  <span
                    className={cn("inline-flex items-center gap-1 font-medium", topStatus.className)}
                  >
                    {topStatus.icon === "working" ? (
                      <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
                    ) : topStatus.icon === "done" ? (
                      <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
                    ) : topStatus.icon === "woke" ? (
                      <AlarmClockIcon aria-hidden className="size-4 shrink-0" />
                    ) : null}
                    {/* The label alone is the live region: a role="status"
                        wrapper around the ticking duration would make
                        screen readers announce every second. */}
                    <span role="status">{topStatus.label}</span>
                    {liveStatus?.kind === "working" ? (
                      <span aria-hidden>
                        <WorkingDuration startedAt={liveStatus.workingStartedAt} />
                      </span>
                    ) : null}
                  </span>
                ) : (
                  threadTimeLabel(timeLabelThread)
                )}
              </span>
              {props.settlementSupported || showSnoozeButton ? (
                <span
                  className={cn(
                    "absolute inset-y-0 right-0 flex items-stretch gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/v2-row:opacity-100",
                    snoozeMenuOpen && "opacity-100",
                  )}
                >
                  {showSnoozeButton ? (
                    <SnoozePopoverButton
                      open={snoozeMenuOpen}
                      onOpenChange={setSnoozeMenuOpen}
                      onSnooze={handleSnoozePreset}
                    />
                  ) : null}
                  {props.settlementSupported ? (
                    <button
                      type="button"
                      aria-label="Settle worktree"
                      onClick={handleSettleClick}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <CheckIcon className="size-3" />
                      Settle
                    </button>
                  ) : null}
                </span>
              ) : null}
            </span>
          </div>
          <div className="mt-1 flex flex-col gap-px">
            {threads.map((thread, index) => {
              const memberKey = memberKeys[index]!;
              return (
                <SidebarV2CardThreadRow
                  key={memberKey}
                  thread={thread}
                  isActive={props.activeThreadKey === memberKey}
                  wokeAt={wokeAtByKey.get(memberKey) ?? null}
                  jumpLabel={props.jumpLabelByKey?.get(memberKey) ?? null}
                  projectTitle={props.projectTitle}
                  projectCwd={props.projectCwd}
                  environmentLabel={props.environmentLabel}
                  branchMismatch={branchMismatch}
                  providerEntryByInstanceId={props.providerEntryByInstanceId}
                  isRenaming={props.renamingThreadKey === memberKey}
                  renamingTitle={props.renamingThreadKey === memberKey ? props.renamingTitle : ""}
                  onThreadClick={onThreadClick}
                  onThreadActivate={onThreadActivate}
                  onStartRename={props.onStartRename}
                  onRenameTitleChange={props.onRenameTitleChange}
                  onCommitRename={props.onCommitRename}
                  onCancelRename={props.onCancelRename}
                  onContextMenu={onContextMenu}
                />
              );
            })}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/75">
            {newest.branch ? (
              <span className="min-w-0 flex-1 truncate whitespace-nowrap">{newest.branch}</span>
            ) : (
              <span className="flex-1" />
            )}
            {prStatus && pr ? (
              <button
                type="button"
                onClick={handlePrClick}
                className={cn("shrink-0 font-mono text-xs hover:underline", prStatus.colorClass)}
                aria-label={prStatus.tooltip}
              >
                #{pr.number}
              </button>
            ) : null}
            {diff ? (
              <span className="shrink-0 font-mono">
                <span className="text-emerald-600 dark:text-emerald-400">+{diff.insertions}</span>{" "}
                <span className="text-red-600 dark:text-red-400">−{diff.deletions}</span>
              </span>
            ) : null}
            {isRemote ? (
              <span
                aria-hidden
                className="pointer-events-none ml-auto inline-flex shrink-0 items-center text-sidebar-muted-foreground/70"
              >
                <ServerIcon aria-hidden className="size-3.5" />
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
});

export default function SidebarV2() {
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const threads = useThreadShells();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const autoSettleAfterDays = useClientSettings((s) => s.sidebarAutoSettleAfterDays);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { settleThread, unsettleThread, snoozeThread, unsnoozeThread, deleteThread } =
    useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const deleteProject = useAtomCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const updateProject = useAtomCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const updateSettings = useUpdateClientSettings();
  const { copyToClipboard: copyProjectPath } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: path,
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
  const [projectActionsTarget, setProjectActionsTarget] = useState<SidebarProjectSnapshot | null>(
    null,
  );
  const [projectScopeMenuOpen, setProjectScopeMenuOpen] = useState(false);
  const newThreadContext = useHandleNewThread();
  const openAddProjectCommandPalette = useCallback(
    () => openCommandPalette({ open: "add-project" }),
    [],
  );
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, routeDraftThread),
    [routeDraftThread, routeTarget],
  );
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeTargetRef = useRef(routeTarget);
  routeTargetRef.current = routeTarget;
  // Post-settle navigation validates against the CURRENT route, not the one
  // captured when the settle started: if the user navigated elsewhere while
  // the command was in flight, completing it must not yank them away.
  const routeThreadKeyRef = useRef(routeThreadKey);
  routeThreadKeyRef.current = routeThreadKey;

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  );
  const unsortedProjectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [
      environmentLabelById,
      orderedProjects,
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
      sidebarProjectSortOrder,
    ],
  );
  const projectGroups = useMemo(
    () => sortLogicalProjectsForSidebar(unsortedProjectGroups, threads, sidebarProjectSortOrder),
    [sidebarProjectSortOrder, threads, unsortedProjectGroups],
  );
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const providerEntryByInstanceId = useMemo(
    () =>
      new Map(
        deriveProviderInstanceEntries(serverProviders).map(
          (entry) => [entry.instanceId as string, entry] as const,
        ),
      ),
    [serverProviders],
  );
  const projectCwdByKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          `${project.environmentId}:${project.id}`,
          project.workspaceRoot,
        ]),
      ),
    [projects],
  );
  const projectDisplayNameByKey = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.memberProjects.map(
            (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
          ),
        ),
      ),
    [projectGroups],
  );

  // now is quantized to the minute so effectiveSettled memoization doesn't
  // churn on every render; auto-settle thresholds are day-granular anyway.
  const nowMinute = useNowMinute();
  // Snooze wake times are second-precise, so classifying with the quantized
  // minute would hold a woken thread on the shelf for up to a minute. The
  // tick is a plain counter bumped exactly at the next wake boundary (armed
  // below, after the partition knows the boundary); the partition reads a
  // fresh clock whenever it recomputes.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);

  // PR states stream in per-row (rows own the VCS subscriptions); a merged or
  // closed PR auto-settles its thread on the next partition.
  const [changeRequestStateByKey, setChangeRequestStateByKey] = useState<
    ReadonlyMap<string, "open" | "closed" | "merged">
  >(() => new Map());
  const handleChangeRequestState = useCallback(
    (threadKey: string, state: "open" | "closed" | "merged" | null) => {
      setChangeRequestStateByKey((current) => {
        if ((current.get(threadKey) ?? null) === state) return current;
        const next = new Map(current);
        if (state === null) {
          next.delete(threadKey);
        } else {
          next.set(threadKey, state);
        }
        return next;
      });
    },
    [],
  );

  // Project scope: one menu above the list. Scoping filters the list without
  // making the header width depend on the number or length of project names.
  const [projectScopeKey, setProjectScopeKey] = useState<string | null>(null);
  const scopedProjectGroup = useMemo(
    () =>
      projectScopeKey === null
        ? null
        : (projectGroups.find((project) => project.projectKey === projectScopeKey) ?? null),
    [projectGroups, projectScopeKey],
  );
  const scopedProjectKeys = useMemo(
    () =>
      scopedProjectGroup === null
        ? null
        : new Set(
            scopedProjectGroup.memberProjectRefs.map(
              (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
            ),
          ),
    [scopedProjectGroup],
  );
  useEffect(() => {
    if (projectScopeKey !== null && scopedProjectGroup === null) {
      setProjectScopeKey(null);
    }
  }, [projectScopeKey, scopedProjectGroup]);
  // Scope flips drop the selection: rows selected under the old scope may be
  // hidden now, and bulk actions must never count or touch invisible rows.
  useEffect(() => {
    clearSelection();
  }, [clearSelection, projectScopeKey]);

  const handleRemoveProjectMembers = useCallback(
    async (projectGroup: SidebarProjectSnapshot, members: readonly SidebarProjectGroupMember[]) => {
      const api = readLocalApi();
      if (!api) return;

      const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
      const projectThreads = threads.filter((thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
      );
      const isWholeGroup = members.length === projectGroup.memberProjects.length;
      const singleMember = members.length === 1 ? members[0]! : null;
      const targetLabel = singleMember?.title ?? projectGroup.displayName;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          projectThreads.length > 0
            ? [
                `Remove project "${targetLabel}" and delete its ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}?`,
                ...(singleMember
                  ? [
                      `Path: ${singleMember.workspaceRoot}`,
                      ...(singleMember.environmentLabel
                        ? [`Environment: ${singleMember.environmentLabel}`]
                        : []),
                    ]
                  : [`This removes ${members.length} grouped project entries.`]),
                "This permanently clears conversation history for those threads.",
                isWholeGroup
                  ? "This removes only the project entries, not the files on disk."
                  : "Other entries in this grouped project are unaffected.",
                "This action cannot be undone.",
              ].join("\n")
            : [
                `Remove project "${targetLabel}"?`,
                ...(singleMember
                  ? [
                      `Path: ${singleMember.workspaceRoot}`,
                      ...(singleMember.environmentLabel
                        ? [`Environment: ${singleMember.environmentLabel}`]
                        : []),
                    ]
                  : [`This removes ${members.length} grouped project entries.`]),
                isWholeGroup
                  ? "This removes only the project entries, not the files on disk."
                  : "Other entries in this grouped project are unaffected.",
              ].join("\n"),
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;

      const draftStore = useComposerDraftStore.getState();
      let shouldNavigate = false;
      for (const project of members) {
        const memberThreads = projectThreads.filter(
          (thread) =>
            thread.environmentId === project.environmentId && thread.projectId === project.id,
        );
        const projectRef = scopeProjectRef(project.environmentId, project.id);
        const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
        const memberRemovalNeedsNavigation = shouldNavigateAfterProjectRemoval({
          routeTarget: routeTargetRef.current,
          projectThreads: memberThreads,
          projectDraftId: projectDraftThread?.draftId ?? null,
        });

        const result = await deleteProject({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            ...(memberThreads.length > 0 ? { force: true } : {}),
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: `Failed to remove "${project.title}"`,
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          if (shouldNavigate) {
            void router.navigate({ to: "/" });
          }
          return;
        }

        shouldNavigate ||= memberRemovalNeedsNavigation;
        if (projectDraftThread) {
          draftStore.clearDraftThread(projectDraftThread.draftId);
        }
        draftStore.clearProjectDraftThreadId(projectRef);
      }

      if (shouldNavigate) {
        void router.navigate({ to: "/" });
      }
    },
    [deleteProject, router, threads],
  );

  const renameProjectMember = useCallback(
    async (member: SidebarProjectGroupMember, nextTitle: string) => {
      const title = nextTitle.trim();
      if (!title) {
        toastManager.add({ type: "warning", title: "Project title cannot be empty" });
        return;
      }
      if (title === member.title) return;
      const result = await updateProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, title },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename project",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [updateProject],
  );

  const updateProjectGroupingPreference = useCallback(
    (member: SidebarProjectGroupMember, selection: SidebarProjectGroupingMode | "inherit") => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      const nextOverrides = { ...projectGroupingSettings.sidebarProjectGroupingOverrides };
      if (selection === "inherit") {
        delete nextOverrides[overrideKey];
      } else {
        nextOverrides[overrideKey] = selection;
      }
      updateSettings({ sidebarProjectGroupingOverrides: nextOverrides });
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides, updateSettings],
  );

  const handleProjectActions = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, projectGroup: SidebarProjectSnapshot) => {
      event.preventDefault();
      event.stopPropagation();
      setProjectScopeMenuOpen(false);
      window.requestAnimationFrame(() => setProjectActionsTarget(projectGroup));
    },
    [],
  );

  // Settled threads stay in the live shell stream (settled ≠ archived), so
  // the partition works directly off live shells: no archived-snapshot
  // merging, no optimistic holds. Archived threads remain hidden here —
  // archive keeps its original "remove from sidebar" meaning.
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const { activeGroups, snoozedGroups, settledGroups, snoozedThreads, settledThreads, snoozeNow } =
    useMemo(() => {
      const now = `${nowMinute}:00.000Z`;
      // Snooze classification uses a REAL clock, not the quantized minute:
      // wake times are second-precise and a woken thread must not linger on
      // the shelf for the rest of the minute. snoozeWakeTick re-runs this
      // memo exactly at the next wake boundary.
      void snoozeWakeTick;
      const preciseNow = new Date().toISOString();
      const visible = threads.filter(
        (thread) =>
          thread.archivedAt === null &&
          (scopedProjectKeys === null ||
            scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
      );
      const classified: Array<{
        thread: EnvironmentThreadShell;
        classification: SidebarThreadClassification;
      }> = [];
      const snoozed: EnvironmentThreadShell[] = [];
      const settled: EnvironmentThreadShell[] = [];
      for (const thread of visible) {
        // Threads on servers without the settlement capability (old server,
        // or descriptor not loaded yet) never classify as settled: the user
        // could neither un-settle nor pin them, so auto-settling them would
        // strand rows in a tail with no working affordances.
        const supportsSettlement =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
          true;
        const supportsSnooze =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true;
        const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        const changeRequestState = changeRequestStateByKey.get(threadKey) ?? null;
        // Snooze outranks settled classification: an explicitly snoozed thread
        // belongs to the shelf even if it would also auto-settle (the shelf's
        // wake time is a stronger statement about when it matters again).
        if (supportsSnooze && effectiveSnoozed(thread, { now: preciseNow })) {
          snoozed.push(thread);
          classified.push({ thread, classification: "snoozed" });
        } else if (
          supportsSettlement &&
          effectiveSettled(thread, { now, autoSettleAfterDays, changeRequestState })
        ) {
          settled.push(thread);
          classified.push({ thread, classification: "settled" });
        } else {
          classified.push({ thread, classification: "active" });
        }
      }
      // Rows are WORKTREES: threads sharing a checkout collapse into one
      // card (any active member) or one shelf row (all parked).
      const groups = buildSidebarWorktreeGroups(classified);
      return {
        ...groups,
        // Soonest wake first: "what comes back next" is the shelf's question
        // (and entry 0 is the wake-timer boundary below).
        snoozedThreads: snoozed.toSorted(
          (left, right) =>
            firstValidTimestampMs(left.snoozedUntil ?? null) -
            firstValidTimestampMs(right.snoozedUntil ?? null),
        ),
        settledThreads: settled,
        snoozeNow: preciseNow,
      };
    }, [
      autoSettleAfterDays,
      changeRequestStateByKey,
      nowMinute,
      scopedProjectKeys,
      serverConfigs,
      snoozeWakeTick,
      threads,
    ]);

  // Arm a timeout for the earliest upcoming wake so the shelf empties the
  // moment a snooze expires instead of on the next minute tick. Sorted
  // soonest-first, so entry 0 is the boundary.
  useEffect(() => {
    const nextWakeAtMs =
      snoozedThreads.length > 0 && snoozedThreads[0]?.snoozedUntil != null
        ? Date.parse(snoozedThreads[0].snoozedUntil)
        : Number.NaN;
    if (Number.isNaN(nextWakeAtMs)) return;
    // setTimeout delays are signed 32-bit: anything larger overflows and
    // fires immediately, turning a far-future wake (event-condition snoozes
    // synced from elsewhere) into a tight re-arm loop. Clamped, the timer
    // just re-arms every ~24.8 days until the wake is in range.
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = window.setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [snoozedThreads]);

  // The settled tail renders in pages: history shouldn't dominate the
  // sidebar, and the common lookups are recent. Expansion resets when the
  // filter context changes so a scope/search flip never inherits a deep
  // page state.
  const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_TAIL_INITIAL_COUNT);
  const settledResetKey = projectScopeKey ?? "all";
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(SETTLED_TAIL_INITIAL_COUNT);
  }
  const groupContainsRouteThread = useCallback(
    (group: SidebarWorktreeGroup) =>
      routeThreadKey !== null && group.memberKeys.includes(routeThreadKey),
    [routeThreadKey],
  );
  const visibleSettledGroups = useMemo(() => {
    if (settledGroups.length <= settledVisibleCount) return settledGroups;
    const visible = settledGroups.slice(0, settledVisibleCount);
    // The open thread must never hide under "Show more": navigating into a
    // deep settled thread (search, deep link) pulls its worktree's row into
    // the visible tail so the highlight and the un-settle affordance stay
    // reachable.
    const routeGroup = settledGroups.slice(settledVisibleCount).find(groupContainsRouteThread);
    if (routeGroup !== undefined) visible.push(routeGroup);
    return visible;
  }, [groupContainsRouteThread, settledGroups, settledVisibleCount]);
  const hiddenSettledCount = settledGroups.length - visibleSettledGroups.length;
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + SETTLED_TAIL_PAGE_COUNT),
    [],
  );
  const [settledShelfExpanded, setSettledShelfExpanded] = useState(true);
  const toggleSettledShelf = useCallback(() => setSettledShelfExpanded((value) => !value), []);
  const renderedSettledGroups = useMemo(() => {
    if (settledShelfExpanded) return visibleSettledGroups;
    const routeGroup = visibleSettledGroups.find(groupContainsRouteThread);
    return routeGroup === undefined ? [] : [routeGroup];
  }, [groupContainsRouteThread, settledShelfExpanded, visibleSettledGroups]);

  // The snoozed shelf is collapsed by default: out of the way, never gone.
  // Collapsed rows don't render (and so don't participate in jump
  // shortcuts or multi-select), matching the settled tail's paging model.
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useState(false);
  const toggleSnoozedShelf = useCallback(() => setSnoozedShelfExpanded((value) => !value), []);
  const visibleSnoozedGroups = useMemo(() => {
    if (snoozedShelfExpanded) return snoozedGroups;
    // The open thread must never vanish behind the collapsed shelf: a
    // snoozed thread reached by route (deep link, open before snoozing
    // elsewhere) keeps its worktree's row — with highlight and wake
    // affordance — same exception the settled tail's "Show more" makes.
    const routeGroup = snoozedGroups.find(groupContainsRouteThread);
    return routeGroup === undefined ? [] : [routeGroup];
  }, [groupContainsRouteThread, snoozedShelfExpanded, snoozedGroups]);

  // Shelf rows stand in for their whole group; the representative prefers
  // the route thread so highlight and navigation stay honest.
  const snoozedRepThreads = useMemo(
    () => visibleSnoozedGroups.map((group) => pickWorktreeGroupRepresentative(group, routeThreadKey)),
    [routeThreadKey, visibleSnoozedGroups],
  );
  const settledRepThreads = useMemo(
    () => renderedSettledGroups.map((group) => pickWorktreeGroupRepresentative(group, routeThreadKey)),
    [renderedSettledGroups, routeThreadKey],
  );
  // The flat jump/selection spine: card members in visual order, then the
  // shelf representatives. Hidden group members are not navigable rows.
  const orderedThreads = useMemo(
    () => [
      ...activeGroups.flatMap((group) => group.threads),
      ...snoozedRepThreads,
      ...settledRepThreads,
    ],
    [activeGroups, snoozedRepThreads, settledRepThreads],
  );
  const orderedThreadKeys = useMemo(
    () =>
      orderedThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [orderedThreads],
  );
  // Rows call back into the click handler without carrying the ordered list as
  // a prop — a fresh array identity per shell update would defeat every row's
  // memoization. The ref keeps shift-range-select working against the list as
  // rendered at click time.
  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  orderedThreadKeysRef.current = orderedThreadKeys;
  const threadByKey = useMemo(
    () =>
      new Map(
        orderedThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [orderedThreads],
  );
  // Handlers read these through refs: depending on per-update Map/Set
  // identities would give every row a fresh callback prop on each shell
  // event and defeat row memoization during streaming.
  const threadByKeyRef = useRef(threadByKey);
  threadByKeyRef.current = threadByKey;
  // Every member key of every group (including members hidden behind a
  // collapsed shelf): lifecycle actions expand a clicked thread to its
  // whole worktree through this map.
  const groupByThreadKey = useMemo(() => {
    const map = new Map<string, SidebarWorktreeGroup>();
    for (const group of [...activeGroups, ...snoozedGroups, ...settledGroups]) {
      for (const memberKey of group.memberKeys) {
        map.set(memberKey, group);
      }
    }
    return map;
  }, [activeGroups, snoozedGroups, settledGroups]);
  const groupByThreadKeyRef = useRef(groupByThreadKey);
  groupByThreadKeyRef.current = groupByThreadKey;
  // handleNewThread is inherently unstable (depends on the projects list);
  // a ref keeps it out of attemptSettle's dependency array.
  const handleNewThreadRef = useRef(newThreadContext.handleNewThread);
  handleNewThreadRef.current = newThreadContext.handleNewThread;
  const settledThreadKeys = useMemo(
    () =>
      new Set(
        settledThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [settledThreads],
  );
  const settledThreadKeysRef = useRef(settledThreadKeys);
  settledThreadKeysRef.current = settledThreadKeys;
  const snoozedThreadKeys = useMemo(
    () =>
      new Set(
        snoozedThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [snoozedThreads],
  );
  const snoozedThreadKeysRef = useRef(snoozedThreadKeys);
  snoozedThreadKeysRef.current = snoozedThreadKeys;

  const jumpLabelByKey = useMemo(() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  }, [keybindings, orderedThreadKeys]);
  const [showJumpHints, setShowJumpHints] = useState(false);

  // Settled threads are live shells, so opening one is plain navigation:
  // history stays readable without un-settling, and sending a message or
  // starting a session un-settles server-side.
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

  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const startThreadRename = useCallback((threadRef: ScopedThreadRef, title: string) => {
    setRenamingThreadKey(scopedThreadKey(threadRef));
    setRenamingTitle(title);
  }, []);
  const cancelThreadRename = useCallback(() => setRenamingThreadKey(null), []);
  const commitThreadRename = useCallback(
    (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
      void (async () => {
        const trimmed = title.trim();
        setRenamingThreadKey(null);
        if (trimmed.length === 0) {
          toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
          return;
        }
        if (trimmed === originalTitle) return;
        const result = await updateThreadMetadata({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, title: trimmed },
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
      })();
    },
    [updateThreadMetadata],
  );

  const handleThreadClick = useCallback(
    (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const threadKey = scopedThreadKey(threadRef);
      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        rangeSelectTo(threadKey, orderedThreadKeysRef.current);
        return;
      }
      if (isTrailingDoubleClick(event.detail)) {
        return;
      }
      navigateToThread(threadRef);
    },
    [navigateToThread, rangeSelectTo, toggleThreadSelection],
  );

  // A settle per thread at a time: double clicks and repeated menu picks
  // must not dispatch a second settle that fails and toasts a false error.
  const settlingThreadKeysRef = useRef(new Set<string>());
  // Parking the thread you're looking at (settle or snooze) moves you
  // forward: the next remaining card (never a settled or snoozed row, never
  // one leaving in the same batch), or a fresh draft in this project when it
  // was the last active one. Callers snapshot the plan BEFORE the command
  // mutates the partition; background parks never navigate (null plan).
  const planForwardNavigation = useCallback(
    (threadKey: string, coParkingKeys?: ReadonlySet<string>): (() => void) | null => {
      if (routeThreadKeyRef.current !== threadKey) return null;
      const shell = threadByKeyRef.current.get(threadKey);
      const orderedKeys = orderedThreadKeysRef.current;
      const settledKeys = settledThreadKeysRef.current;
      const snoozedKeys = snoozedThreadKeysRef.current;
      const currentIndex = orderedKeys.indexOf(threadKey);
      const nextCardKey =
        currentIndex === -1
          ? null
          : ([...orderedKeys.slice(currentIndex + 1), ...orderedKeys.slice(0, currentIndex)].find(
              (key) => !settledKeys.has(key) && !snoozedKeys.has(key) && !coParkingKeys?.has(key),
            ) ?? null);
      const nextThread = nextCardKey ? threadByKeyRef.current.get(nextCardKey) : null;
      return nextThread
        ? () => navigateToThread(scopeThreadRef(nextThread.environmentId, nextThread.id))
        : shell
          ? () =>
              void handleNewThreadRef.current(scopeProjectRef(shell.environmentId, shell.projectId))
          : () => void router.navigate({ to: "/" });
    },
    [navigateToThread, router],
  );

  // Lifecycle actions act on the WORKTREE: a clicked thread expands to its
  // whole group (falling back to just itself when it isn't in any group,
  // e.g. a row that vanished mid-flight).
  const resolveWorktreeThreads = useCallback(
    (threadRef: ScopedThreadRef): ReadonlyArray<SidebarThreadSummary> => {
      const threadKey = scopedThreadKey(threadRef);
      const group = groupByThreadKeyRef.current.get(threadKey);
      if (group) return group.threads;
      const shell = threadByKeyRef.current.get(threadKey);
      return shell ? [shell] : [];
    },
    [],
  );
  const attemptSettleThreads = useCallback(
    (
      groupThreads: ReadonlyArray<SidebarThreadSummary>,
      opts: { coParkingKeys?: ReadonlySet<string> } = {},
    ) => {
      void (async () => {
        const now = new Date().toISOString();
        const pending = groupThreads.filter((thread) => {
          const threadKey = sidebarThreadKey(thread);
          return (
            !settlingThreadKeysRef.current.has(threadKey) &&
            !settledThreadKeysRef.current.has(threadKey) &&
            thread.settledOverride !== "settled"
          );
        });
        if (pending.length === 0) return;
        // Prefer members the server will accept; when none qualify, send
        // the first anyway so the user sees the server's reason.
        const settleable = pending.filter((thread) => canSettle(thread, { now }));
        const targets = settleable.length > 0 ? settleable : [pending[0]!];
        const targetKeys = targets.map(sidebarThreadKey);
        for (const key of targetKeys) settlingThreadKeysRef.current.add(key);
        try {
          // Forward navigation must skip everything leaving in this batch —
          // the whole worktree plus any co-parking selection.
          const allParkingKeys = new Set([
            ...(opts.coParkingKeys ?? []),
            ...groupThreads.map(sidebarThreadKey),
          ]);
          const routeKey = targetKeys.find((key) => key === routeThreadKeyRef.current) ?? null;
          const navigateAfterSettle =
            routeKey === null ? null : planForwardNavigation(routeKey, allParkingKeys);
          let routeSettled = false;
          for (const target of targets) {
            const result = await settleThread(scopeThreadRef(target.environmentId, target.id));
            if (result._tag === "Failure") {
              // Never navigate away from a thread that did not settle.
              if (!isAtomCommandInterrupted(result)) {
                const error = squashAtomCommandFailure(result);
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Failed to settle thread",
                    description: error instanceof Error ? error.message : "An error occurred.",
                  }),
                );
              }
            } else if (sidebarThreadKey(target) === routeKey) {
              routeSettled = true;
            }
          }
          // Only move forward if the user is still on the settled thread —
          // a navigation made during the await wins over ours.
          if (routeSettled && routeThreadKeyRef.current === routeKey) {
            navigateAfterSettle?.();
          }
        } finally {
          for (const key of targetKeys) settlingThreadKeysRef.current.delete(key);
        }
      })();
    },
    [planForwardNavigation, settleThread],
  );
  const attemptSettle = useCallback(
    (threadRef: ScopedThreadRef) => {
      attemptSettleThreads(resolveWorktreeThreads(threadRef));
    },
    [attemptSettleThreads, resolveWorktreeThreads],
  );
  const attemptUnsettleThreads = useCallback(
    (groupThreads: ReadonlyArray<SidebarThreadSummary>) => {
      void (async () => {
        // Un-settle every parked member; already-active members are no-ops
        // skipped client-side.
        const settledMembers = groupThreads.filter((thread) =>
          settledThreadKeysRef.current.has(sidebarThreadKey(thread)),
        );
        const targets = settledMembers.length > 0 ? settledMembers : groupThreads.slice(0, 1);
        for (const target of targets) {
          const result = await unsettleThread(scopeThreadRef(target.environmentId, target.id));
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to un-settle thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
        }
      })();
    },
    [unsettleThread],
  );
  const attemptUnsettle = useCallback(
    (threadRef: ScopedThreadRef) => {
      attemptUnsettleThreads(resolveWorktreeThreads(threadRef));
    },
    [attemptUnsettleThreads, resolveWorktreeThreads],
  );
  const attemptUnsnoozeRefs = useCallback(
    (threadRefs: ReadonlyArray<ScopedThreadRef>) => {
      void (async () => {
        for (const threadRef of threadRefs) {
          const result = await unsnoozeThread(threadRef);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to wake thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
        }
      })();
    },
    [unsnoozeThread],
  );
  const attemptUnsnooze = useCallback(
    (threadRef: ScopedThreadRef) => {
      const groupThreads = resolveWorktreeThreads(threadRef);
      const snoozedMembers = groupThreads.filter((thread) =>
        snoozedThreadKeysRef.current.has(sidebarThreadKey(thread)),
      );
      const targets = (snoozedMembers.length > 0 ? snoozedMembers : groupThreads).map((thread) =>
        scopeThreadRef(thread.environmentId, thread.id),
      );
      attemptUnsnoozeRefs(targets.length > 0 ? targets : [threadRef]);
    },
    [attemptUnsnoozeRefs, resolveWorktreeThreads],
  );
  // One snooze per thread at a time — same double-dispatch guard as settle.
  const snoozingThreadKeysRef = useRef(new Set<string>());
  const attemptSnoozeThreads = useCallback(
    (
      groupThreads: ReadonlyArray<SidebarThreadSummary>,
      preset: SnoozePreset,
      opts: { coParkingKeys?: ReadonlySet<string> } = {},
    ) => {
      void (async () => {
        const now = new Date().toISOString();
        const targets = groupThreads.filter((thread) => {
          const threadKey = sidebarThreadKey(thread);
          return (
            !snoozingThreadKeysRef.current.has(threadKey) &&
            !snoozedThreadKeysRef.current.has(threadKey) &&
            canSnooze(thread, { now })
          );
        });
        if (targets.length === 0) return;
        const targetKeys = targets.map(sidebarThreadKey);
        for (const key of targetKeys) snoozingThreadKeysRef.current.add(key);
        try {
          // Snoozing the open thread moves you forward, same as settle —
          // both park the worktree you're done with for now.
          const allParkingKeys = new Set([
            ...(opts.coParkingKeys ?? []),
            ...groupThreads.map(sidebarThreadKey),
          ]);
          const routeKey = targetKeys.find((key) => key === routeThreadKeyRef.current) ?? null;
          const navigateAfterSnooze =
            routeKey === null ? null : planForwardNavigation(routeKey, allParkingKeys);
          const snoozedRefs: ScopedThreadRef[] = [];
          let routeSnoozed = false;
          for (const target of targets) {
            const targetRef = scopeThreadRef(target.environmentId, target.id);
            const result = await snoozeThread(targetRef, preset.snoozedUntil);
            if (result._tag === "Failure") {
              // Never navigate away from a thread that did not snooze.
              if (!isAtomCommandInterrupted(result)) {
                const error = squashAtomCommandFailure(result);
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Failed to snooze thread",
                    description: error instanceof Error ? error.message : "An error occurred.",
                  }),
                );
              }
            } else {
              snoozedRefs.push(targetRef);
              if (sidebarThreadKey(target) === routeKey) routeSnoozed = true;
            }
          }
          if (snoozedRefs.length > 0) {
            // Snooze hides the worktree's card, so the toast is the only
            // confirmation — one per worktree, not per member — and the
            // Undo is the escape hatch for a mis-click.
            toastManager.add(
              stackedThreadToast({
                type: "success",
                title: `Snoozed until ${snoozeWakeDescription(preset.snoozedUntil, new Date())}`,
                timeout: 5_000,
                actionProps: {
                  children: "Undo",
                  onClick: () => attemptUnsnoozeRefs(snoozedRefs),
                },
              }),
            );
          }
          // Only move forward if the user is still on the snoozed thread —
          // a navigation made during the await wins over ours.
          if (routeSnoozed && routeThreadKeyRef.current === routeKey) {
            navigateAfterSnooze?.();
          }
        } finally {
          for (const key of targetKeys) snoozingThreadKeysRef.current.delete(key);
        }
      })();
    },
    [attemptUnsnoozeRefs, planForwardNavigation, snoozeThread],
  );
  const attemptSnooze = useCallback(
    (threadRef: ScopedThreadRef, preset: SnoozePreset) => {
      attemptSnoozeThreads(resolveWorktreeThreads(threadRef), preset);
    },
    [attemptSnoozeThreads, resolveWorktreeThreads],
  );

  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      // One exact actionable set: keys whose rows are actually rendered
      // right now. Selections can outlive their rows (settled-tail paging,
      // thread deletion elsewhere) and the menu labels must count only what
      // the actions will touch.
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys].filter(
        (threadKey) => threadByKeyRef.current.has(threadKey),
      );
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      // Lifecycle actions park WORKTREES: the selection expands to every
      // member of every selected thread's group before settling/snoozing.
      const expandedByKey = new Map<string, SidebarThreadSummary>();
      for (const threadKey of threadKeys) {
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) continue;
        const groupThreads = groupByThreadKeyRef.current.get(threadKey)?.threads ?? [thread];
        for (const member of groupThreads) {
          expandedByKey.set(sidebarThreadKey(member), member);
        }
      }
      const expandedThreads = [...expandedByKey.values()];
      // Snooze (N) is offered when every affected thread can actually take
      // it — a mixed batch with blocked-on-you work would half-apply.
      const selectionNow = new Date().toISOString();
      const canSnoozeSelection = expandedThreads.every(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true &&
          canSnooze(thread, { now: selectionNow }),
      );
      const snoozePresets = resolveSnoozePresets(new Date());
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            { id: "settle", label: `Settle (${count})` },
            ...(canSnoozeSelection
              ? [
                  {
                    id: "snooze",
                    label: `Snooze (${count})`,
                    children: snoozePresets.map((preset) => ({
                      id: `snooze:${preset.id}`,
                      label: `${preset.label} (${preset.whenLabel})`,
                    })),
                  },
                ]
              : []),
            { id: "mark-unread", label: `Mark unread (${count})` },
            { id: "delete", label: `Delete (${count})`, destructive: true },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure") return;
      if (clicked.value?.startsWith("snooze:")) {
        const preset = snoozePresets.find(
          (candidate) => `snooze:${candidate.id}` === clicked.value,
        );
        if (preset) {
          // One batch: post-snooze navigation skips everything leaving
          // together, and the whole batch gets a single Undo toast.
          attemptSnoozeThreads(expandedThreads, preset);
          clearSelection();
        }
        return;
      }
      if (clicked.value === "settle") {
        // One batch: post-settle navigation must skip threads settling in
        // this same batch — they are all leaving the card block together.
        // Already-settled members are skipped inside the handler.
        attemptSettleThreads(expandedThreads);
        clearSelection();
        return;
      }
      if (clicked.value === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          markThreadUnread(threadKey, thread?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }
      if (clicked.value !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} thread${count === 1 ? "" : "s"}?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n"),
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      // Grown as deletions actually land, never seeded with the whole batch:
      // orphaned-worktree detection must only discount threads that are
      // really gone, or the first delete would treat still-alive batch mates
      // as deleted and remove a worktree they still point at.
      const deletedThreadKeys = new Set<string>();
      for (const threadKey of threadKeys) {
        const thread = threadByKeyRef.current.get(threadKey);
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
        deletedThreadKeys.add(threadKey);
      }
      removeFromSelection(threadKeys);
    },
    [
      attemptSettleThreads,
      attemptSnoozeThreads,
      clearSelection,
      confirmThreadDelete,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      serverConfigs,
    ],
  );

  const handleThreadContextMenu = useCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadKey = scopedThreadKey(threadRef);
        const selectionState = useThreadSelectionStore.getState();
        if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey)) {
          await handleMultiSelectContextMenu(position);
          return;
        }
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) return;
        // Un-settle works on every settled row: for explicit settles it
        // clears the override, for auto-settled rows it pins the thread
        // active until real activity clears the pin. Environments without
        // the settlement capability get no lifecycle items at all.
        const supportsSettlement =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
          true;
        const supportsSnooze =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true;
        const isSettled = settledThreadKeysRef.current.has(threadKey);
        const isSnoozed = snoozedThreadKeysRef.current.has(threadKey);
        // Lifecycle items act on the thread's whole worktree; the labels
        // say so as soon as more than one thread shares it.
        const groupThreads = groupByThreadKeyRef.current.get(threadKey)?.threads ?? [thread];
        const isMultiThreadWorktree = groupThreads.length > 1;
        const settleLabel = isMultiThreadWorktree
          ? `Settle worktree (${groupThreads.length} threads)`
          : "Settle thread";
        const unsettleLabel = isMultiThreadWorktree ? "Un-settle worktree" : "Un-settle thread";
        const wakeLabel = isMultiThreadWorktree ? "Wake worktree" : "Wake thread";
        const menuNow = new Date().toISOString();
        // Presets resolve at menu-open time (same as the popover).
        const snoozePresets = resolveSnoozePresets(new Date());
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              ...(thread.branch
                ? [
                    {
                      id: "new-thread-on-branch",
                      label: `New thread on ${thread.branch}`,
                    },
                  ]
                : []),
              ...(supportsSettlement
                ? [
                    isSettled
                      ? { id: "unsettle", label: unsettleLabel }
                      : { id: "settle", label: settleLabel },
                  ]
                : []),
              ...(supportsSnooze
                ? [
                    isSnoozed
                      ? { id: "unsnooze", label: wakeLabel }
                      : {
                          id: "snooze",
                          label: isMultiThreadWorktree
                            ? `Snooze worktree (${groupThreads.length} threads)`
                            : "Snooze",
                          disabled: !groupThreads.every((member) =>
                            canSnooze(member, { now: menuNow }),
                          ),
                          children: snoozePresets.map((preset) => ({
                            id: `snooze:${preset.id}`,
                            label: `${preset.label} (${preset.whenLabel})`,
                          })),
                        },
                  ]
                : []),
              { id: "rename", label: "Rename thread" },
              { id: "mark-unread", label: "Mark unread" },
              { id: "delete", label: "Delete", destructive: true, icon: "trash" },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        if (clicked.value?.startsWith("snooze:")) {
          const preset = snoozePresets.find(
            (candidate) => `snooze:${candidate.id}` === clicked.value,
          );
          if (preset) attemptSnooze(threadRef, preset);
          return;
        }
        switch (clicked.value) {
          case "new-thread-on-branch": {
            // Explicit branch carry-over: reuse the thread's worktree when it
            // has one, otherwise its branch on the local checkout.
            const result = await settlePromise(() =>
              handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId), {
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
          case "settle":
            attemptSettle(threadRef);
            return;
          case "unsettle":
            attemptUnsettle(threadRef);
            return;
          case "unsnooze":
            attemptUnsnooze(threadRef);
            return;
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "mark-unread":
            markThreadUnread(threadKey, thread.latestTurn?.completedAt);
            return;
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
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
              return;
            }
            return;
          }
          default:
            return;
        }
      })();
    },
    [
      attemptSettle,
      attemptSnooze,
      attemptUnsettle,
      attemptUnsnooze,
      confirmThreadDelete,
      deleteThread,
      handleMultiSelectContextMenu,
      markThreadUnread,
      serverConfigs,
      startThreadRename,
    ],
  );

  // Thread jump (cmd+1..9) and prev/next traversal reuse the same commands as
  // v1 — the keybinding layer is shared, only the ordered list differs.
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const navigateToThreadKey = (targetThreadKey: string | null) => {
        if (!targetThreadKey) return false;
        const targetThread = threadByKey.get(targetThreadKey);
        if (!targetThread) return false;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return true;
      };
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeThreadKey,
            direction: traversalDirection,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    keybindings,
    navigateToThread,
    orderedThreadKeys,
    routeTerminalOpen,
    routeThreadKey,
    threadByKey,
  ]);

  // Same predicate as v1: hints show only while the held modifiers exactly
  // match a thread-jump binding. Adding Shift (screenshots) or Alt no
  // longer matches ⌘1..9, so the overlay hides for chords like ⌘⇧4.
  const shortcutModifiers = useShortcutModifierState();
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    { platform: navigator.platform },
  );
  useEffect(() => {
    setShowJumpHints(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow]);

  const attachListAutoAnimateRef = useCallback((node: HTMLUListElement | null) => {
    if (!node) return;
    autoAnimate(node, { duration: 150, easing: "ease-out" });
  }, []);

  // New thread defaults to the project you're in (active thread's project,
  // falling back to the top project) — same resolution the command palette
  // uses. The command palette already offers a "New thread in..." submenu
  // for multi-project setups.
  const handleNewThreadClick = useCallback(() => {
    // One project: nothing to pick, create immediately.
    if (projectGroups.length <= 1) {
      if (isMobile) setOpenMobile(false);
      void startNewThreadFromContext({
        activeDraftThread: newThreadContext.activeDraftThread,
        activeThread: newThreadContext.activeThread ?? undefined,
        defaultProjectRef: newThreadContext.defaultProjectRef,
        handleNewThread: newThreadContext.handleNewThread,
      });
      return;
    }
    if (isMobile) setOpenMobile(false);
    openCommandPalette({ open: "new-thread-in" });
  }, [isMobile, newThreadContext, projectGroups.length, setOpenMobile]);

  const commandPaletteShortcutLabel = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  // Same resolution as v1: prefer the local-thread binding, fall back to
  // chat.new, no platform gating — web users have working shortcuts too.
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal") ??
    shortcutLabelForCommand(keybindings, "chat.new");
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="gap-0"
        fixedHeader={
          <SidebarGroup className="gap-1 p-2">
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <CommandDialogTrigger
                  render={
                    <SidebarMenuButton
                      type="button"
                      aria-label="Search threads and commands"
                      className="focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                      data-testid="command-palette-trigger"
                    />
                  }
                >
                  <SearchIcon />
                  <div className="flex-1 truncate text-left">Search</div>
                  {commandPaletteShortcutLabel ? (
                    <Kbd className="mr-px h-4 min-w-0 rounded-sm bg-sidebar-control-surface px-1.5 text-[10px] text-sidebar-muted-foreground ring-1 ring-sidebar-border">
                      {commandPaletteShortcutLabel}
                    </Kbd>
                  ) : null}
                </CommandDialogTrigger>
              </div>
              <div className="shrink-0">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <SidebarMenuButton
                        size="icon"
                        type="button"
                        className="relative focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                        onClick={handleNewThreadClick}
                        disabled={projects.length === 0}
                        aria-label="New thread"
                      />
                    }
                  >
                    <SquarePenIcon />
                    <span
                      className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                      aria-hidden="true"
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="right">
                    {newThreadShortcutLabel
                      ? `New thread (${newThreadShortcutLabel})`
                      : "New thread"}
                  </TooltipPopup>
                </Tooltip>
              </div>
            </div>
            {projectGroups.length > 0 ? (
              <div className="flex items-center gap-1">
                <Menu open={projectScopeMenuOpen} onOpenChange={setProjectScopeMenuOpen}>
                  <MenuTrigger
                    render={
                      <SidebarMenuButton
                        aria-label="Filter threads by project"
                        className="min-w-0 flex-1 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                      />
                    }
                  >
                    {scopedProjectGroup ? (
                      <ProjectFavicon
                        environmentId={scopedProjectGroup.environmentId}
                        cwd={scopedProjectGroup.workspaceRoot}
                        className="size-4 shrink-0"
                      />
                    ) : (
                      <FolderIcon className="size-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {scopedProjectGroup?.displayName ?? "All projects"}
                    </span>
                    <ChevronDownIcon className="-mr-px size-4 shrink-0" />
                  </MenuTrigger>
                  <MenuPopup align="start" className="w-(--anchor-width)">
                    <MenuRadioGroup
                      value={projectScopeKey ?? "all"}
                      onValueChange={(value) =>
                        setProjectScopeKey(value === "all" ? null : (value as string))
                      }
                    >
                      <MenuRadioItem
                        value="all"
                        closeOnClick
                        className="h-8 min-h-8 px-1 py-0 text-sm font-medium [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
                      >
                        <FolderIcon className="size-4 shrink-0" />
                        <span className="min-w-0 truncate text-sm">All projects</span>
                      </MenuRadioItem>
                      {projectGroups.map((project) => {
                        const scopeKey = project.projectKey;
                        return (
                          <MenuRadioItem
                            key={scopeKey}
                            value={scopeKey}
                            closeOnClick
                            className="h-8 min-h-8 px-1 py-0 text-sm font-medium [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
                          >
                            <ProjectFavicon
                              environmentId={project.environmentId}
                              cwd={project.workspaceRoot}
                              className="size-4 shrink-0"
                            />
                            <span className="min-w-0 truncate text-sm">{project.displayName}</span>
                            <button
                              type="button"
                              aria-label={`Project actions for ${project.displayName}`}
                              title={`Project actions for ${project.displayName}`}
                              className="ml-auto inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/55 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                void handleProjectActions(event, project);
                              }}
                            >
                              <EllipsisIcon className="size-3.5" />
                            </button>
                          </MenuRadioItem>
                        );
                      })}
                    </MenuRadioGroup>
                  </MenuPopup>
                </Menu>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <SidebarMenuButton
                        size="icon"
                        className="relative shrink-0 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                        onClick={openAddProjectCommandPalette}
                        type="button"
                        aria-label="New project"
                      />
                    }
                  >
                    <FolderPlusIcon />
                    <span
                      className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                      aria-hidden="true"
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="right">New project</TooltipPopup>
                </Tooltip>
              </div>
            ) : null}
          </SidebarGroup>
        }
      >
        <SidebarGroup className="px-2 pb-1 pt-0">
          <TooltipProvider
            key="sidebar-thread-tooltips-150"
            delay={150}
            closeDelay={0}
            timeout={400}
          >
            <ul ref={attachListAutoAnimateRef} role="list" className="flex flex-col gap-px">
              {(() => {
                // Shelf rows collapse a whole WORKTREE to one slim line; the
                // representative thread carries title/branch/tooltip and the
                // lifecycle actions expand back to the group.
                const renderShelfRow = (
                  group: SidebarWorktreeGroup,
                  section: "snoozed" | "settled",
                  representative: EnvironmentThreadShell,
                ) => {
                  const threadKey = sidebarThreadKey(representative);
                  return (
                    <SidebarV2Row
                      // Keyed per form on purpose: when a worktree settles,
                      // the card fades out in place and the slim row fades
                      // in at its settled position instead of one element
                      // FLIP-sliding through every row in between (rows here
                      // are translucent, so a crossing row reads as text
                      // painted over text).
                      key={`${group.key}:slim`}
                      thread={representative}
                      // Snoozed rows wake; settled rows un-settle (explicit
                      // settles clear the override, auto-settled rows get
                      // pinned active) — both act on the whole worktree.
                      variantAction={section === "snoozed" ? "unsnooze" : "unsettle"}
                      settlementSupported={
                        serverConfigs.get(representative.environmentId)?.environment.capabilities
                          .threadSettlement === true
                      }
                      snoozeSupported={
                        serverConfigs.get(representative.environmentId)?.environment.capabilities
                          .threadSnooze === true
                      }
                      snoozeWakeLabelText={
                        section === "snoozed" && representative.snoozedUntil != null
                          ? snoozeWakeLabel(representative.snoozedUntil, new Date())
                          : null
                      }
                      // All sections: a woken thread can classify straight
                      // into the settled tail (PR merged while snoozed), and
                      // the wake signal must survive the trip. Still-snoozed
                      // rows resolve to null on their own.
                      wokeAt={threadWokeAt(representative, { now: snoozeNow })}
                      isActive={routeThreadKey === threadKey}
                      jumpLabel={showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
                      currentEnvironmentId={primaryEnvironmentId}
                      environmentLabel={
                        environmentLabelById.get(representative.environmentId) ?? null
                      }
                      projectCwd={
                        projectCwdByKey.get(
                          `${representative.environmentId}:${representative.projectId}`,
                        ) ?? null
                      }
                      projectTitle={
                        projectDisplayNameByKey.get(
                          `${representative.environmentId}:${representative.projectId}`,
                        ) ?? null
                      }
                      providerEntryByInstanceId={providerEntryByInstanceId}
                      changeRequestThreadKeys={group.memberKeys}
                      onThreadClick={handleThreadClick}
                      onThreadActivate={navigateToThread}
                      onStartRename={startThreadRename}
                      onRenameTitleChange={setRenamingTitle}
                      onCommitRename={commitThreadRename}
                      onCancelRename={cancelThreadRename}
                      isRenaming={renamingThreadKey === threadKey}
                      renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
                      onContextMenu={handleThreadContextMenu}
                      onUnsettle={attemptUnsettle}
                      onUnsnooze={attemptUnsnooze}
                      onChangeRequestState={handleChangeRequestState}
                    />
                  );
                };
                const items: ReactNode[] = activeGroups.map((group) => {
                  const newest = group.threads[group.threads.length - 1]!;
                  const projectLookupKey = `${newest.environmentId}:${newest.projectId}` as const;
                  const activeThreadKey =
                    routeThreadKey !== null && group.memberKeys.includes(routeThreadKey)
                      ? routeThreadKey
                      : null;
                  const renamingInGroup =
                    renamingThreadKey !== null && group.memberKeys.includes(renamingThreadKey)
                      ? renamingThreadKey
                      : null;
                  return (
                    <SidebarV2WorktreeCard
                      key={`${group.key}:card`}
                      groupKey={group.key}
                      threads={group.threads}
                      memberKeys={group.memberKeys}
                      activeThreadKey={activeThreadKey}
                      settlementSupported={
                        serverConfigs.get(newest.environmentId)?.environment.capabilities
                          .threadSettlement === true
                      }
                      snoozeSupported={
                        serverConfigs.get(newest.environmentId)?.environment.capabilities
                          .threadSnooze === true
                      }
                      snoozeNow={snoozeNow}
                      currentEnvironmentId={primaryEnvironmentId}
                      environmentLabel={environmentLabelById.get(newest.environmentId) ?? null}
                      projectCwd={projectCwdByKey.get(projectLookupKey) ?? null}
                      projectTitle={projectDisplayNameByKey.get(projectLookupKey) ?? null}
                      providerEntryByInstanceId={providerEntryByInstanceId}
                      jumpLabelByKey={showJumpHints ? jumpLabelByKey : null}
                      renamingThreadKey={renamingInGroup}
                      renamingTitle={renamingInGroup !== null ? renamingTitle : ""}
                      onThreadClick={handleThreadClick}
                      onThreadActivate={navigateToThread}
                      onStartRename={startThreadRename}
                      onRenameTitleChange={setRenamingTitle}
                      onCommitRename={commitThreadRename}
                      onCancelRename={cancelThreadRename}
                      onContextMenu={handleThreadContextMenu}
                      onSettle={attemptSettle}
                      onSnooze={attemptSnooze}
                      onChangeRequestState={handleChangeRequestState}
                    />
                  );
                });
                // Snoozed shelf: between the inbox and Settled — out of the
                // way, never gone. The header always renders while anything
                // is snoozed (the count is the whole footprint when
                // collapsed); rows only when expanded. Vanishes entirely at
                // count 0.
                if (snoozedGroups.length > 0) {
                  items.push(
                    <li key="snoozed-shelf-header" data-thread-selection-safe className="list-none">
                      <button
                        type="button"
                        onClick={toggleSnoozedShelf}
                        aria-expanded={snoozedShelfExpanded}
                        data-testid="sidebar-v2-snoozed-shelf-toggle"
                        className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
                      >
                        <span className="text-xs font-medium text-blue-600 dark:text-blue-400">
                          {snoozedShelfExpanded ? "Snoozed" : `Snoozed (${snoozedGroups.length})`}
                        </span>
                        <span className="h-px flex-1 bg-blue-500/20 dark:bg-blue-400/15" />
                        <ChevronDownIcon
                          aria-hidden
                          className={cn(
                            "size-3 text-blue-600 transition-transform dark:text-blue-400",
                            snoozedShelfExpanded && "rotate-180",
                          )}
                        />
                      </button>
                    </li>,
                  );
                  visibleSnoozedGroups.forEach((group, index) => {
                    items.push(renderShelfRow(group, "snoozed", snoozedRepThreads[index]!));
                  });
                }
                if (settledGroups.length > 0) {
                  items.push(
                    <li key="settled-shelf-header" data-thread-selection-safe className="list-none">
                      <button
                        type="button"
                        onClick={toggleSettledShelf}
                        aria-expanded={settledShelfExpanded}
                        data-testid="sidebar-v2-settled-shelf-toggle"
                        className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
                      >
                        <span className="text-xs font-medium text-muted-foreground/50">
                          {settledShelfExpanded ? "Settled" : `Settled (${settledGroups.length})`}
                        </span>
                        <span className="h-px flex-1 bg-sidebar-border/60" />
                        <ChevronDownIcon
                          aria-hidden
                          className={cn(
                            "size-3 text-muted-foreground/50 transition-transform",
                            settledShelfExpanded && "rotate-180",
                          )}
                        />
                      </button>
                    </li>,
                  );
                }
                renderedSettledGroups.forEach((group, index) => {
                  items.push(renderShelfRow(group, "settled", settledRepThreads[index]!));
                });
                return items;
              })()}
              {settledShelfExpanded && hiddenSettledCount > 0 ? (
                <li className="list-none">
                  <button
                    type="button"
                    onClick={showMoreSettled}
                    className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <PlusIcon aria-hidden className="size-4 shrink-0" />
                    Show {Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more
                  </button>
                </li>
              ) : null}
            </ul>
          </TooltipProvider>
          {activeGroups.length + snoozedGroups.length + settledGroups.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
              {projects.length === 0 ? (
                <>
                  <span>No projects yet</span>
                  <button
                    type="button"
                    onClick={openAddProjectCommandPalette}
                    className="inline-flex items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-[11px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <PlusIcon className="-mx-0.5 size-3" />
                    Add project
                  </button>
                </>
              ) : scopedProjectGroup ? (
                `No threads in ${scopedProjectGroup.displayName} yet`
              ) : (
                "No threads yet"
              )}
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <Dialog
        open={projectActionsTarget !== null}
        onOpenChange={(open) => {
          if (!open) setProjectActionsTarget(null);
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader className="gap-3 pb-1!">
            <DialogTitle className="text-balance">Project settings</DialogTitle>
            <DialogDescription className="sr-only">
              Manage project names, grouping rules, and environments.
            </DialogDescription>
            <div className="grid gap-1.5 text-base text-muted-foreground">
              {projectActionsTarget?.memberProjects.map((member) => (
                <div key={member.physicalProjectKey} className="flex min-w-0 items-center gap-3">
                  <span className="flex min-w-0 items-center gap-1">
                    <FolderIcon className="size-3.5 shrink-0 opacity-60" />
                    <span className="min-w-0 truncate font-mono">{member.workspaceRoot}</span>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="size-4 shrink-0 rounded-sm"
                      aria-label="Copy project path"
                      title="Copy project path"
                      onClick={() =>
                        copyProjectPath(member.workspaceRoot, { path: member.workspaceRoot })
                      }
                    >
                      <CopyIcon className="size-3.5" />
                    </Button>
                  </span>
                  <span className="flex min-w-0 shrink-0 items-center gap-1">
                    <ServerIcon className="size-3.5 shrink-0 opacity-60" />
                    <span className="min-w-0 truncate">
                      {member.environmentLabel ?? "Current environment"}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </DialogHeader>
          <DialogPanel className="p-0">
            <div className="divide-y divide-border/60">
              {projectActionsTarget?.memberProjects.map((member) => (
                <section
                  key={member.physicalProjectKey}
                  className="grid min-w-0 gap-5 px-6 pb-5 pt-2 sm:gap-4 sm:pb-4 sm:pt-2"
                >
                  <div className="grid gap-4 sm:grid-cols-2 sm:gap-3">
                    <label className="grid min-w-0 gap-1.5">
                      <span className="font-medium text-foreground">Project name</span>
                      <Input
                        key={`${member.physicalProjectKey}:${member.title}`}
                        aria-label={`Project name in ${member.environmentLabel ?? "current environment"}`}
                        defaultValue={member.title}
                        onBlur={(event) => {
                          void renameProjectMember(member, event.currentTarget.value);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </label>
                    <label className="grid min-w-0 gap-1.5">
                      <span className="font-medium text-foreground">Grouping rule</span>
                      <Select
                        value={
                          projectGroupingSettings.sidebarProjectGroupingOverrides?.[
                            deriveProjectGroupingOverrideKey(member)
                          ] ?? "inherit"
                        }
                        onValueChange={(value) => {
                          if (
                            value === "inherit" ||
                            value === "repository" ||
                            value === "repository_path" ||
                            value === "separate"
                          ) {
                            updateProjectGroupingPreference(member, value);
                          }
                        }}
                      >
                        <SelectTrigger
                          className="w-full sm:min-h-7.5"
                          aria-label={`Grouping rule for ${member.environmentLabel ?? "current environment"}`}
                        >
                          <SelectValue>
                            {(() => {
                              const selection =
                                projectGroupingSettings.sidebarProjectGroupingOverrides?.[
                                  deriveProjectGroupingOverrideKey(member)
                                ] ?? "inherit";
                              return selection === "inherit"
                                ? `Default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                                : PROJECT_GROUPING_MODE_LABELS[selection];
                            })()}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="start" alignItemWithTrigger={false}>
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
                    </label>
                  </div>
                  {projectActionsTarget.memberProjects.length > 1 ? (
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive-foreground hover:bg-destructive/8 hover:text-destructive-foreground"
                        onClick={() => {
                          const projectGroup = projectActionsTarget;
                          setProjectActionsTarget(null);
                          void handleRemoveProjectMembers(projectGroup, [member]);
                        }}
                      >
                        <Trash2Icon />
                        Remove project
                      </Button>
                    </div>
                  ) : null}
                </section>
              ))}
            </div>
            {projectActionsTarget && projectActionsTarget.memberProjects.length > 1 ? (
              <div className="flex flex-col gap-3 border-t border-border/60 bg-muted/32 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-base font-medium text-foreground sm:text-sm">
                    Remove this project everywhere
                  </p>
                  <p className="text-base text-pretty text-muted-foreground sm:text-sm">
                    Deletes all grouped entries and their conversation history.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  className="shrink-0"
                  onClick={() => {
                    const projectGroup = projectActionsTarget;
                    setProjectActionsTarget(null);
                    void handleRemoveProjectMembers(projectGroup, projectGroup.memberProjects);
                  }}
                >
                  <Trash2Icon />
                  Remove all entries
                </Button>
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter
            variant="bare"
            className={cn(
              projectActionsTarget?.memberProjects.length === 1 && "sm:justify-between",
            )}
          >
            {projectActionsTarget?.memberProjects.length === 1 ? (
              <Button
                variant="destructive-outline"
                onClick={() => {
                  const projectGroup = projectActionsTarget;
                  setProjectActionsTarget(null);
                  void handleRemoveProjectMembers(projectGroup, projectGroup.memberProjects);
                }}
              >
                <Trash2Icon />
                Remove project
              </Button>
            ) : null}
            <Button onClick={() => setProjectActionsTarget(null)}>Close</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <SidebarChromeFooter />
    </>
  );
}
