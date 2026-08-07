import { autoAnimate } from "@formkit/auto-animate";
import { useAtomValue } from "@effect/atom-react";
import {
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
  ArrowUpDownIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CopyIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  EllipsisIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SquarePenIcon,
  TerminalIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
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
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { cn } from "~/lib/utils";
import {
  buildBulkTitleRegenerationContextMenuItem,
  firstValidTimestampMs,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  resolveAdjacentThreadId,
  resolveSettledTimestamp,
  searchSidebarThreadsByTitle,
  shouldNavigateAfterProjectRemoval,
  sortLogicalProjectsForSidebar,
  sortSettledThreadsForSidebarV2,
} from "./Sidebar.logic";
import {
  classifyThreadForSidebarV3,
  sortAttentionThreadsForSidebarV3,
  sortThreadsForSidebarV3,
  type SidebarV3AttentionKind,
} from "./SidebarV3.logic";
import { resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import {
  prStatusIndicator,
  resolveThreadPr,
  settledPrHoverColorClass,
  terminalStatusFromRunningIds,
  type TerminalStatusIndicator,
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
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { stackedThreadToast, toastManager } from "./ui/toast";
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
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { SidebarContent, SidebarGroup, SidebarMenuButton, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
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

function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

function SidebarV3ThreadTooltip({
  thread,
  projectTitle,
  projectCwd,
  environmentLabel,
  driverKind,
  modelInstanceId,
  modelLabel,
  branchMismatch,
  terminalStatus,
  terminalProcessCount,
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
  terminalStatus: TerminalStatusIndicator | null;
  terminalProcessCount: number;
}) {
  return (
    <TooltipPopup
      side="right"
      align="start"
      sideOffset={4}
      variant="glass"
      className="max-w-80 text-left whitespace-normal [&_[data-slot=tooltip-viewport]]:p-0"
    >
      <div className="flex min-w-0 max-w-80 flex-col gap-2 p-[var(--floating-content-inset)]">
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
          {terminalStatus ? (
            <div className="flex min-w-0 items-center gap-2">
              <TerminalIcon
                aria-hidden
                className={cn("size-3 shrink-0", terminalStatus.colorClass)}
              />
              <div className="min-w-0 truncate text-foreground/75">
                {terminalProcessLabel(terminalProcessCount)}
              </div>
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

const SidebarV3Row = memo(function SidebarV3Row(props: {
  thread: SidebarThreadSummary;
  // Every v3 row is one compact line; the action varies by block: snoozed
  // rows wake, settled rows un-settle, live rows settle.
  variantAction: "settle" | "unsettle" | "unsnooze";
  // False on environments whose server predates thread.settle/unsettle:
  // the lifecycle affordances hide entirely rather than fail on click.
  settlementSupported: boolean;
  // Same contract for thread.snooze/unsnooze.
  snoozeSupported: boolean;
  // Renders the pin glyph. Pinned cards keep the full settle/snooze quick
  // actions: settling clears the pin server-side, and snoozing hides the
  // card until wake with the pin intact underneath. Pin/unpin themselves
  // live in the context menu only.
  isPinned: boolean;
  // Compact wake countdown ("2h") for rows in the snoozed shelf.
  snoozeWakeLabelText: string | null;
  // When a snooze ended (timer or early wake); drives the Woke pill until
  // the user visits the thread.
  wokeAt: string | null;
  isActive: boolean;
  jumpLabel: string | null;
  environmentLabel: string | null;
  projectCwd: string | null;
  projectTitle: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  // Settle and snooze themselves live in the context menu only; the row's
  // hover affordances are limited to un-settle (settled tail) and wake
  // (snoozed shelf).
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  onUnsnooze: (threadRef: ScopedThreadRef) => void;
  onAcknowledgeWoke: (threadRef: ScopedThreadRef, visitedAt: string) => void;
  onChangeRequestState: (threadKey: string, state: "open" | "closed" | "merged" | null) => void;
}) {
  const {
    isRenaming,
    onChangeRequestState,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onAcknowledgeWoke,
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
  const isRegeneratingTitle = thread.titleRegeneration != null;
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const openPrLink = useOpenPrLink();
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const terminalProcessCount = runningTerminalIds.length;

  // The SAME classifier the parent partitions with: row visuals (dot, right-
  // edge word) and section membership can never disagree. Never-visited
  // counts as read (flipping the beta must not light up history); a woken
  // thread shows its signal until visited, corrupt visit data included.
  const { status, isUnread, isWoke, attentionKind } = classifyThreadForSidebarV3(thread, {
    lastVisitedAt,
    wokeAt: props.wokeAt,
  });
  // In-flight rows fade as a whole: there is nothing for the user to do yet,
  // so prominence is reserved for rows that need a human. The colored dot
  // keeps them findable.
  const isInFlight =
    status === "working" || status === "monitoring" || status === "approval" || status === "input";
  const shouldRecede =
    (status === "ready" || isInFlight) && !isUnread && !isWoke && !props.isActive && !isSelected;
  // Parked rows (snoozed shelf, settled tail) stay calm: no attention word,
  // no attention dot — EXCEPT the woke signal, which must survive the trip
  // into either shelf (e.g. a PR merged while snoozed).
  const isParked = variantAction !== "settle";
  const effectiveAttentionKind = isParked && attentionKind !== "woke" ? null : attentionKind;
  // Status hues follow the system-wide convention set by sidebar v1/v2 and
  // the mobile Live Activity/widgets (amber approval, indigo input, sky
  // working) so a thread reads the same color everywhere it surfaces. In v3
  // the section header carries the coarse status, the dot carries it per
  // row, and only Needs-attention rows spell out a word at the right edge —
  // woke renders as its dismiss button instead of a passive word.
  const attentionWord =
    effectiveAttentionKind === "approval"
      ? { label: "Approval", className: "text-amber-700 dark:text-amber-300" }
      : effectiveAttentionKind === "input"
        ? { label: "Input", className: "text-indigo-600 dark:text-indigo-300" }
        : effectiveAttentionKind === "failed"
          ? { label: "Failed", className: "text-red-700 dark:text-red-300" }
          : effectiveAttentionKind === "done"
            ? { label: "Done", className: "text-emerald-700 dark:text-emerald-300" }
            : null;
  const statusDotClassName =
    effectiveAttentionKind === "approval" || effectiveAttentionKind === "woke"
      ? "bg-amber-500"
      : effectiveAttentionKind === "input"
        ? "bg-indigo-500"
        : effectiveAttentionKind === "failed"
          ? "bg-red-500"
          : effectiveAttentionKind === "done"
            ? "bg-emerald-500"
            : !isParked && status === "working"
              ? "animate-status-pulse bg-sky-500"
              : !isParked && status === "monitoring"
                ? "bg-sky-500/60"
                : variantAction === "unsnooze"
                  ? "bg-blue-400/70"
                  : variantAction === "unsettle"
                    ? "bg-muted-foreground/20"
                    : "bg-muted-foreground/30";

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
  // and a merged/closed PR auto-settles a thread — data only rows have.
  const prState = pr?.state ?? null;
  useEffect(() => {
    onChangeRequestState(threadKey, prState);
  }, [onChangeRequestState, prState, threadKey]);

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
    <SidebarV3ThreadTooltip
      thread={thread}
      projectTitle={props.projectTitle}
      projectCwd={props.projectCwd}
      environmentLabel={props.environmentLabel}
      driverKind={driverKind}
      modelInstanceId={modelInstanceId}
      modelLabel={modelLabel}
      branchMismatch={branchMismatch}
      terminalStatus={terminalStatus}
      terminalProcessCount={terminalProcessCount}
    />
  );

  const handleClick = useCallback(
    (event: ReactMouseEvent) => {
      onThreadClick(event, threadRef);
    },
    [onThreadClick, threadRef],
  );
  const handleAcknowledgeWokeClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (props.wokeAt === null) return;
      onAcknowledgeWoke(threadRef, props.wokeAt);
    },
    [onAcknowledgeWoke, props.wokeAt, threadRef],
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
    "group/v3-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none",
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
        "min-w-0 flex-1 truncate text-sm transition-opacity group-hover/v3-row:text-foreground motion-reduce:transition-none",
        shouldRecede ? "font-normal" : "font-medium",
        props.isActive || isWoke || isUnread || effectiveAttentionKind !== null
          ? "text-foreground"
          : isParked || shouldRecede
            ? "text-muted-foreground/70"
            : "text-foreground/90",
        isRegeneratingTitle && "opacity-[0.55]",
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
          // Sidebar chrome follows the interface font; tabular digits keep the
          // number from reflowing as PR states stream in.
          "shrink-0 text-xs tabular-nums hover:underline",
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
      className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_50px]"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              role="button"
              tabIndex={0}
              data-testid="sidebar-v3-row"
              aria-busy={isRegeneratingTitle || undefined}
              className={cn(rowSurfaceClassName, "flex h-12 items-center gap-2.5 px-2.5")}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          }
        >
          {/* The dot is the row's whole status vocabulary — the section
              header carries the words. */}
          <span
            aria-hidden
            data-testid={`sidebar-v3-status-dot-${thread.id}`}
            className={cn("size-2 shrink-0 rounded-full", statusDotClassName)}
          />
          {/* Two-line body: title row on top, the owning project small
              underneath so a busy list stays attributable at a glance. */}
          <span className="flex min-w-0 flex-1 flex-col justify-center gap-px">
            <span className="flex min-w-0 items-center gap-2">
              {title}
              {props.isPinned ? (
                <PinIcon
                  aria-label="Pinned"
                  role="img"
                  className="size-3 shrink-0 text-muted-foreground/65"
                />
              ) : null}
              {isRegeneratingTitle ? (
                <span role="status" className="sr-only">
                  Regenerating title
                </span>
              ) : null}
              {/* The PR badge stays outside the hover-fading slot: it must
              remain visible AND clickable while the row is hovered. Only
              the time/jump label yields to the settle affordance. */}
              {prBadge}
              <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end">
                <span
                  className={cn(
                    "inline-flex justify-end tabular-nums text-muted-foreground/55 transition-opacity",
                    // Only parked rows grow hover actions the label must
                    // yield to; live rows keep their time/status visible.
                    isParked && !isWoke && "group-hover/v3-row:opacity-0",
                  )}
                >
                  {variantAction === "unsnooze" && props.snoozeWakeLabelText !== null ? (
                    // Snoozed rows show when they come BACK, not when they were
                    // last touched — the return ticket is the row's whole story.
                    <span className="text-xs text-blue-600 tabular-nums dark:text-blue-400">
                      {props.snoozeWakeLabelText}
                    </span>
                  ) : isWoke ? (
                    // A wake can land straight in the settled tail (e.g. PR
                    // merged while snoozed); the signal must survive the trip.
                    <button
                      type="button"
                      aria-label="Dismiss Woke notification"
                      title="Dismiss Woke notification"
                      onClick={handleAcknowledgeWokeClick}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium text-amber-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-300"
                    >
                      <AlarmClockIcon aria-hidden className="size-3" />
                      <span role="status">Woke</span>
                    </button>
                  ) : attentionWord ? (
                    // Needs-attention rows spell the status out; every other
                    // row shows plain relative time.
                    <span className={cn("text-xs font-medium", attentionWord.className)}>
                      <span role="status">{attentionWord.label}</span>
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
                      className={cn(
                        "pointer-events-none absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/v3-row:pointer-events-auto group-hover/v3-row:opacity-100",
                        isWoke && "group-hover/v3-row:static",
                      )}
                    >
                      <AlarmClockOffIcon className="size-3" />
                    </button>
                  )
                ) : variantAction === "unsettle" ? (
                  !props.settlementSupported ? null : (
                    <button
                      type="button"
                      aria-label="Un-settle thread"
                      onClick={handleUnsettleClick}
                      className={cn(
                        "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/v3-row:pointer-events-auto group-hover/v3-row:opacity-100",
                        isWoke && "group-hover/v3-row:static",
                      )}
                    >
                      <Undo2Icon className="mb-px size-3.5" />
                    </button>
                  )
                ) : // Live rows have NO hover actions: settle and snooze live
                // in the context menu, so the time/status label owns the slot.
                null}
              </span>
            </span>
            {props.projectTitle || thread.worktreePath !== null || driverKind ? (
              <span
                className={cn(
                  "flex min-w-0 items-center gap-1.5 text-[11px] leading-tight",
                  props.isActive
                    ? "text-muted-foreground/80"
                    : "text-muted-foreground/55 group-hover/v3-row:text-muted-foreground/75",
                )}
              >
                {props.projectTitle ? (
                  <span className="min-w-0 flex-1 truncate">{props.projectTitle}</span>
                ) : (
                  <span className="min-w-0 flex-1" />
                )}
                {/* Worktree presence, not a folder icon: this is the one
                    piece of environment context worth a glance at rest. */}
                {thread.worktreePath !== null ? (
                  <FolderGit2Icon
                    aria-label="Worktree"
                    role="img"
                    className="size-3 shrink-0 opacity-70"
                  />
                ) : null}
                {driverKind ? (
                  <span className="flex min-w-0 shrink-0 items-center gap-1 opacity-80">
                    <ProviderInstanceIcon
                      driverKind={driverKind}
                      displayName={thread.session?.providerName ?? modelInstanceId}
                      iconClassName="size-3 shrink-0 grayscale"
                    />
                    <span className="max-w-20 truncate">{modelLabel}</span>
                  </span>
                ) : null}
              </span>
            ) : null}
          </span>
          {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
        </TooltipTrigger>
        {detailsTooltip}
      </Tooltip>
    </li>
  );
});

const SidebarV3SearchResultRow = memo(function SidebarV3SearchResultRow(props: {
  thread: SidebarThreadSummary;
  projectCwd: string | null;
  projectTitle: string | null;
  environmentLabel: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  onHighlight: () => void;
  onSelect: () => void;
}) {
  const { thread } = props;
  // Same details tooltip as the regular rows: a search hit is still a thread,
  // and the hover card is how you disambiguate identically-titled results.
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
  const modelInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const driverKind = providerEntry?.driverKind ?? null;
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  return (
    <li role="presentation" className="list-none">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              id={props.resultId}
              type="button"
              role="option"
              // aria-activedescendant options: focus stays on the search input,
              // which owns all keyboard interaction for the listbox.
              tabIndex={-1}
              aria-selected={props.isHighlighted}
              aria-current={props.isRouteActive ? "page" : undefined}
              aria-label={
                props.projectTitle ? `${thread.title}, ${props.projectTitle}` : thread.title
              }
              onMouseMove={props.onHighlight}
              onClick={props.onSelect}
              className={cn(
                "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none",
                props.isHighlighted || props.isRouteActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              )}
            />
          }
        >
          <ProjectFavicon
            environmentId={thread.environmentId}
            cwd={props.projectCwd ?? ""}
            className="size-4 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground/55 tabular-nums">
            {threadTimeLabel(thread)}
          </span>
        </TooltipTrigger>
        <SidebarV3ThreadTooltip
          thread={thread}
          projectTitle={props.projectTitle}
          projectCwd={props.projectCwd}
          environmentLabel={props.environmentLabel}
          driverKind={driverKind}
          modelInstanceId={modelInstanceId}
          modelLabel={modelLabel}
          branchMismatch={branchMismatch}
          terminalStatus={terminalStatus}
          terminalProcessCount={runningTerminalIds.length}
        />
      </Tooltip>
    </li>
  );
});

export default function SidebarV3() {
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const threads = useThreadShells();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const autoSettleAfterDays = useClientSettings((s) => s.sidebarAutoSettleAfterDays);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const sidebarV3Grouping = useClientSettings((s) => s.sidebarV3Grouping);
  const sidebarV3ThreadSortOrder = useClientSettings((s) => s.sidebarV3ThreadSortOrder);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    deleteThread,
  } = useThreadActions();
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
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
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
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({
        type: "success",
        title: "Branch copied",
        description: branch,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy branch",
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
  const markThreadVisited = useUiStateStore((s) => s.markThreadVisited);
  const acknowledgeWoke = useCallback(
    (threadRef: ScopedThreadRef, visitedAt: string) => {
      markThreadVisited(scopedThreadKey(threadRef), visitedAt);
    },
    [markThreadVisited],
  );
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
  const { pinnedThreads, activeThreads, snoozedThreads, settledThreads, snoozeNow } =
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
      const pinned: EnvironmentThreadShell[] = [];
      const active: EnvironmentThreadShell[] = [];
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
        // Snooze outranks everything, including a pin: "hide until Tuesday"
        // temporarily suspends "keep on top". The pin survives underneath —
        // pinned cards are creation-ordered, so on wake the thread reappears
        // at its original spot in the pinned block. (For unpinned threads
        // this is also the snooze-beats-auto-settle rule: the wake time is a
        // stronger statement about when the thread matters again.)
        if (supportsSnooze && effectiveSnoozed(thread, { now: preciseNow })) {
          snoozed.push(thread);
          // A pin otherwise overrides the lifecycle: pinned threads never
          // auto-settle out of sight. (The decider clears settled state on
          // pin and the pin on settle, so pin-vs-settled conflicts only
          // arise from stale or raced writes.)
        } else if (thread.pinnedAt != null) {
          pinned.push(thread);
        } else if (
          supportsSettlement &&
          effectiveSettled(thread, { now, autoSettleAfterDays, changeRequestState })
        ) {
          settled.push(thread);
        } else {
          active.push(thread);
        }
      }
      return {
        // Pinned and live threads share the menu's sort; a pin freezes
        // prominence, it does not introduce a new ordering scheme.
        pinnedThreads: sortThreadsForSidebarV3(pinned, sidebarV3ThreadSortOrder),
        activeThreads: sortThreadsForSidebarV3(active, sidebarV3ThreadSortOrder),
        // Soonest wake first: "what comes back next" is the shelf's question.
        snoozedThreads: snoozed.toSorted(
          (left, right) =>
            firstValidTimestampMs(left.snoozedUntil ?? null) -
            firstValidTimestampMs(right.snoozedUntil ?? null),
        ),
        settledThreads: sortSettledThreadsForSidebarV2(settled),
        snoozeNow: preciseNow,
      };
    }, [
      autoSettleAfterDays,
      changeRequestStateByKey,
      nowMinute,
      scopedProjectKeys,
      serverConfigs,
      sidebarV3ThreadSortOrder,
      snoozeWakeTick,
      threads,
    ]);

  // Live-list subdivision into the v3 status sections, classified with the
  // SAME helper the rows render with so membership and visuals cannot
  // disagree. Threads move between sections on status change — that is the
  // feature; within a section the chosen sort keeps things calm.
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const { attentionThreads, workingThreads, readyThreads } = useMemo(() => {
    if (sidebarV3Grouping !== "status") {
      return {
        attentionThreads: [] as EnvironmentThreadShell[],
        workingThreads: [] as EnvironmentThreadShell[],
        readyThreads: [] as EnvironmentThreadShell[],
      };
    }
    const attention: EnvironmentThreadShell[] = [];
    const attentionKindByThread = new Map<EnvironmentThreadShell, SidebarV3AttentionKind>();
    const working: EnvironmentThreadShell[] = [];
    const ready: EnvironmentThreadShell[] = [];
    for (const thread of activeThreads) {
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const classification = classifyThreadForSidebarV3(thread, {
        lastVisitedAt: threadLastVisitedAtById[threadKey],
        wokeAt: threadWokeAt(thread, { now: snoozeNow }),
      });
      if (classification.attentionKind !== null) {
        attention.push(thread);
        attentionKindByThread.set(thread, classification.attentionKind);
      } else if (classification.section === "working") {
        working.push(thread);
      } else {
        ready.push(thread);
      }
    }
    return {
      // Severity buckets first; the working/ready lists inherit the already-
      // applied section sort from activeThreads.
      attentionThreads: sortAttentionThreadsForSidebarV3(
        attention,
        sidebarV3ThreadSortOrder,
        (thread) => attentionKindByThread.get(thread) ?? "done",
      ),
      workingThreads: working,
      readyThreads: ready,
    };
  }, [
    activeThreads,
    sidebarV3Grouping,
    sidebarV3ThreadSortOrder,
    snoozeNow,
    threadLastVisitedAtById,
  ]);

  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
  const isSearchingThreads = threadSearchQuery.trim().length > 0;
  const searchableThreads = useMemo(
    () => [...pinnedThreads, ...activeThreads, ...snoozedThreads, ...settledThreads],
    [activeThreads, pinnedThreads, settledThreads, snoozedThreads],
  );
  const threadSearchResults = useMemo(
    () => searchSidebarThreadsByTitle(searchableThreads, threadSearchQuery),
    [searchableThreads, threadSearchQuery],
  );
  const threadSearchResultOrderKey = threadSearchResults
    .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
    .join("\0");

  useEffect(() => {
    setActiveSearchResultIndex(0);
  }, [threadSearchResultOrderKey]);

  useEffect(() => {
    if (!isSearchingThreads) return;
    document
      .getElementById(`sidebar-thread-search-result-${activeSearchResultIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSearchResultIndex, isSearchingThreads, threadSearchResultOrderKey]);

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
  const visibleSettledThreads = useMemo(() => {
    if (settledThreads.length <= settledVisibleCount) return settledThreads;
    const visible = settledThreads.slice(0, settledVisibleCount);
    // The open thread must never hide under "Show more": navigating into a
    // deep settled thread (search, deep link) pulls its row into the visible
    // tail so the highlight and the un-settle affordance stay reachable.
    if (routeThreadKey !== null) {
      const routeThread = settledThreads
        .slice(settledVisibleCount)
        .find(
          (thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
        );
      if (routeThread !== undefined) visible.push(routeThread);
    }
    return visible;
  }, [routeThreadKey, settledThreads, settledVisibleCount]);
  const hiddenSettledCount = settledThreads.length - visibleSettledThreads.length;
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + SETTLED_TAIL_PAGE_COUNT),
    [],
  );
  const [settledShelfExpanded, setSettledShelfExpanded] = useState(true);
  const toggleSettledShelf = useCallback(() => setSettledShelfExpanded((value) => !value), []);
  const renderedSettledThreads = useMemo(() => {
    if (settledShelfExpanded) return visibleSettledThreads;
    if (routeThreadKey === null) return [];
    const routeThread = visibleSettledThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? [] : [routeThread];
  }, [routeThreadKey, settledShelfExpanded, visibleSettledThreads]);

  // The snoozed shelf is collapsed by default: out of the way, never gone.
  // Collapsed threads don't render (and so don't participate in jump
  // shortcuts or multi-select), matching the settled tail's paging model.
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useState(false);
  const toggleSnoozedShelf = useCallback(() => setSnoozedShelfExpanded((value) => !value), []);
  const visibleSnoozedThreads = useMemo(() => {
    if (snoozedShelfExpanded) return snoozedThreads;
    // The open thread must never vanish behind the collapsed shelf: a
    // snoozed thread reached by route (deep link, open before snoozing
    // elsewhere) keeps its row — with highlight and wake affordance — same
    // exception the settled tail's "Show more" makes.
    if (routeThreadKey === null) return [];
    const routeThread = snoozedThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? [] : [routeThread];
  }, [routeThreadKey, snoozedShelfExpanded, snoozedThreads]);

  // Status sections collapse like the shelves do: collapsed rows don't
  // render (and so don't participate in jump shortcuts or multi-select).
  // Deliberately NO route-thread exception here: collapsing must visibly
  // collapse — the open thread stays open in the main view, and the section
  // count still says where it went.
  const [attentionExpanded, setAttentionExpanded] = useState(true);
  const [workingExpanded, setWorkingExpanded] = useState(true);
  const [readyExpanded, setReadyExpanded] = useState(true);
  const toggleAttentionSection = useCallback(() => setAttentionExpanded((value) => !value), []);
  const toggleWorkingSection = useCallback(() => setWorkingExpanded((value) => !value), []);
  const toggleReadySection = useCallback(() => setReadyExpanded((value) => !value), []);
  const visibleAttentionThreads = useMemo(
    () => (attentionExpanded ? attentionThreads : []),
    [attentionThreads, attentionExpanded],
  );
  const visibleWorkingThreads = useMemo(
    () => (workingExpanded ? workingThreads : []),
    [workingThreads, workingExpanded],
  );
  const visibleReadyThreads = useMemo(
    () => (readyExpanded ? readyThreads : []),
    [readyThreads, readyExpanded],
  );
  // The live slice of the ordered list mirrors exactly what renders: grouped
  // sections when status grouping is on, the flat inbox otherwise.
  const liveThreads = useMemo(
    () =>
      sidebarV3Grouping === "status"
        ? [...visibleAttentionThreads, ...visibleWorkingThreads, ...visibleReadyThreads]
        : activeThreads,
    [
      activeThreads,
      sidebarV3Grouping,
      visibleAttentionThreads,
      visibleReadyThreads,
      visibleWorkingThreads,
    ],
  );

  const orderedThreads = useMemo(
    () => [...pinnedThreads, ...liveThreads, ...visibleSnoozedThreads, ...renderedSettledThreads],
    [pinnedThreads, liveThreads, visibleSnoozedThreads, renderedSettledThreads],
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

  const clearThreadSearch = useCallback(() => {
    setThreadSearchQuery("");
    setActiveSearchResultIndex(0);
  }, []);
  const selectThreadSearchResult = useCallback(
    (thread: EnvironmentThreadShell) => {
      clearThreadSearch();
      navigateToThread(scopeThreadRef(thread.environmentId, thread.id));
    },
    [clearThreadSearch, navigateToThread],
  );
  const handleThreadSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      // IME composition (Japanese/Chinese input) uses the same keys; committing
      // a candidate must not move the highlight or navigate away mid-compose.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" && isSearchingThreads) {
        event.preventDefault();
        event.stopPropagation();
        clearThreadSearch();
        return;
      }
      if (threadSearchResults.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSearchResultIndex((index) => (index + 1) % threadSearchResults.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSearchResultIndex(
          (index) => (index - 1 + threadSearchResults.length) % threadSearchResults.length,
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = threadSearchResults[activeSearchResultIndex];
        if (result) selectThreadSearchResult(result);
      }
    },
    [
      activeSearchResultIndex,
      clearThreadSearch,
      isSearchingThreads,
      selectThreadSearchResult,
      threadSearchResults,
    ],
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

  const attemptSettle = useCallback(
    (threadRef: ScopedThreadRef, opts: { coSettlingKeys?: ReadonlySet<string> } = {}) => {
      void (async () => {
        const threadKey = scopedThreadKey(threadRef);
        if (settlingThreadKeysRef.current.has(threadKey)) return;
        settlingThreadKeysRef.current.add(threadKey);
        try {
          const navigateAfterSettle = planForwardNavigation(threadKey, opts.coSettlingKeys);
          const result = await settleThread(threadRef);
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
            return;
          }
          // Only move forward if the user is still on the settled thread —
          // a navigation made during the await wins over ours.
          if (routeThreadKeyRef.current === threadKey) {
            navigateAfterSettle?.();
          }
        } finally {
          settlingThreadKeysRef.current.delete(threadKey);
        }
      })();
    },
    [planForwardNavigation, settleThread],
  );
  const attemptUnsettle = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await unsettleThread(threadRef);
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
      })();
    },
    [unsettleThread],
  );
  const attemptUnsnooze = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
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
      })();
    },
    [unsnoozeThread],
  );
  const attemptPin = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await pinThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to pin thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [pinThread],
  );
  const attemptUnpin = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await unpinThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unpin thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [unpinThread],
  );
  // One snooze per thread at a time — same double-dispatch guard as settle.
  const snoozingThreadKeysRef = useRef(new Set<string>());
  const attemptSnooze = useCallback(
    (
      threadRef: ScopedThreadRef,
      preset: SnoozePreset,
      opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
    ) => {
      void (async () => {
        const threadKey = scopedThreadKey(threadRef);
        if (snoozingThreadKeysRef.current.has(threadKey)) return;
        snoozingThreadKeysRef.current.add(threadKey);
        try {
          // Snoozing the open thread moves you forward, same as settle —
          // both park the thread you're done with for now.
          const navigateAfterSnooze = planForwardNavigation(threadKey, opts.coSnoozingKeys);
          const result = await snoozeThread(threadRef, preset.snoozedUntil);
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
            return;
          }
          // Snooze hides the row, so the toast is the only confirmation —
          // and the Undo is the escape hatch for a mis-click.
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `Snoozed until ${snoozeWakeDescription(preset.snoozedUntil, new Date(), timestampFormat)}`,
              timeout: 5_000,
              actionProps: {
                children: "Undo",
                onClick: () => attemptUnsnooze(threadRef),
              },
            }),
          );
          // Only move forward if the user is still on the snoozed thread —
          // a navigation made during the await wins over ours.
          if (routeThreadKeyRef.current === threadKey) {
            navigateAfterSnooze?.();
          }
        } finally {
          snoozingThreadKeysRef.current.delete(threadKey);
        }
      })();
    },
    [attemptUnsnooze, planForwardNavigation, snoozeThread, timestampFormat],
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
      // Snooze (N) is offered when every selected thread can actually take
      // it — a mixed selection with blocked-on-you work would half-apply.
      const selectionNow = new Date();
      const selectedThreads = threadKeys.flatMap((threadKey) => {
        const thread = threadByKeyRef.current.get(threadKey);
        return thread ? [thread] : [];
      });
      const canSnoozeSelection = selectedThreads.every(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true &&
          canSnooze(thread, { now: selectionNow.toISOString() }),
      );
      const titleRegenerationThreads = selectedThreads.filter(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadTitleRegeneration === true,
      );
      const regeneratableTitleThreads = titleRegenerationThreads.filter(
        (thread) => thread.titleRegeneration == null,
      );
      const titleRegenerationMenuItem = buildBulkTitleRegenerationContextMenuItem({
        supportedCount: titleRegenerationThreads.length,
        actionableCount: regeneratableTitleThreads.length,
      });
      const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
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
            ...(titleRegenerationMenuItem ? [titleRegenerationMenuItem] : []),
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
          // Post-snooze navigation must skip threads snoozing in this same
          // batch — they are all leaving the card block together.
          const coSnoozingKeys = new Set(threadKeys);
          for (const thread of selectedThreads) {
            attemptSnooze(scopeThreadRef(thread.environmentId, thread.id), preset, {
              coSnoozingKeys,
            });
          }
          clearSelection();
        }
        return;
      }
      if (clicked.value === "regenerate-title") {
        for (const thread of regeneratableTitleThreads) {
          const result = await updateThreadMetadata({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, regenerateTitle: true },
          });
          if (result._tag === "Success") continue;
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to regenerate thread titles",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        clearSelection();
        return;
      }
      if (clicked.value === "settle") {
        // Post-settle navigation must skip threads settling in this same
        // batch — they are all leaving the card block together. Rows that
        // are already explicitly settled are skipped: nothing to do on a
        // valid mixed selection. Pinned rows ARE included: the decider
        // clears the pin as part of settling, so they park like the rest.
        const coSettlingKeys = new Set(threadKeys);
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread || thread.settledOverride === "settled") continue;
          attemptSettle(scopeThreadRef(thread.environmentId, thread.id), { coSettlingKeys });
        }
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
      attemptSettle,
      attemptSnooze,
      clearSelection,
      confirmThreadDelete,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      serverConfigs,
      updateThreadMetadata,
      timestampFormat,
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
        const threadWorkspacePath =
          thread.worktreePath ??
          projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ??
          null;
        // Un-settle works on every settled row: for explicit settles it
        // clears the override, for auto-settled rows it pins the thread
        // active until real activity clears the pin. Environments without
        // the settlement capability get no lifecycle items at all.
        const supportsSettlement =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
          true;
        const supportsSnooze =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true;
        const supportsPinning =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning === true;
        const supportsTitleRegeneration =
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadTitleRegeneration === true;
        const isRegeneratingTitle = thread.titleRegeneration != null;
        const isSettled = settledThreadKeysRef.current.has(threadKey);
        const isSnoozed = snoozedThreadKeysRef.current.has(threadKey);
        const isPinned = thread.pinnedAt != null;
        // Presets resolve at menu-open time (same as the popover).
        const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
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
              ...(supportsPinning
                ? [
                    isPinned
                      ? { id: "unpin", label: "Unpin thread" }
                      : { id: "pin", label: "Pin thread" },
                  ]
                : []),
              // Both lifecycle actions stay available on pinned threads:
              // settling clears the pin ("done" beats "keep on top"), and
              // snoozing hides the card until wake with the pin intact.
              ...(supportsSettlement
                ? [
                    isSettled
                      ? { id: "unsettle", label: "Un-settle thread" }
                      : { id: "settle", label: "Settle thread" },
                  ]
                : []),
              ...(supportsSnooze
                ? [
                    isSnoozed
                      ? { id: "unsnooze", label: "Wake thread" }
                      : {
                          id: "snooze",
                          label: "Snooze",
                          disabled: !canSnooze(thread, { now: new Date().toISOString() }),
                          children: snoozePresets.map((preset) => ({
                            id: `snooze:${preset.id}`,
                            label: `${preset.label} (${preset.whenLabel})`,
                          })),
                        },
                  ]
                : []),
              { id: "rename", label: "Rename thread" },
              ...(supportsTitleRegeneration
                ? [
                    {
                      id: "regenerate-title",
                      label: isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
                      disabled: isRegeneratingTitle,
                    },
                  ]
                : []),
              { id: "mark-unread", label: "Mark unread" },
              { id: "copy-path", label: "Copy path", icon: "copy" },
              ...(thread.branch ? [{ id: "copy-branch", label: "Copy branch", icon: "copy" }] : []),
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
          case "pin":
            attemptPin(threadRef);
            return;
          case "unpin":
            attemptUnpin(threadRef);
            return;
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "regenerate-title": {
            if (isRegeneratingTitle) return;
            const result = await updateThreadMetadata({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, regenerateTitle: true },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to regenerate thread title",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "mark-unread":
            markThreadUnread(threadKey, thread.latestTurn?.completedAt);
            return;
          case "copy-path":
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
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
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
      attemptPin,
      attemptSettle,
      attemptSnooze,
      attemptUnpin,
      attemptUnsettle,
      attemptUnsnooze,
      confirmThreadDelete,
      copyBranchToClipboard,
      copyPathToClipboard,
      deleteThread,
      handleMultiSelectContextMenu,
      markThreadUnread,
      projectCwdByKey,
      serverConfigs,
      startThreadRename,
      updateThreadMetadata,
      timestampFormat,
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
          <SidebarGroup className="gap-1 p-[var(--sidebar-content-inset)]">
            <div className="flex items-center gap-1">
              <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
                <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                <Input
                  ref={threadSearchInputRef}
                  nativeInput
                  unstyled
                  type="search"
                  value={threadSearchQuery}
                  onChange={(event) => {
                    setThreadSearchQuery(event.currentTarget.value);
                    setActiveSearchResultIndex(0);
                  }}
                  onKeyDown={handleThreadSearchKeyDown}
                  placeholder="Search"
                  aria-label="Search threads"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={isSearchingThreads && threadSearchResults.length > 0}
                  aria-controls={
                    isSearchingThreads && threadSearchResults.length > 0
                      ? "sidebar-thread-search-results"
                      : undefined
                  }
                  aria-activedescendant={
                    isSearchingThreads && threadSearchResults[activeSearchResultIndex]
                      ? `sidebar-thread-search-result-${activeSearchResultIndex}`
                      : undefined
                  }
                  className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:placeholder:text-sidebar-muted-foreground"
                />
                {isSearchingThreads ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 shrink-0 rounded-sm text-sidebar-muted-foreground hover:bg-sidebar-control-surface hover:text-sidebar-foreground"
                    aria-label="Clear thread search"
                    onClick={() => {
                      clearThreadSearch();
                      threadSearchInputRef.current?.focus();
                    }}
                  >
                    <XIcon className="size-3" />
                  </Button>
                ) : null}
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
              <div className="shrink-0">
                <Menu>
                  <MenuTrigger
                    render={
                      <SidebarMenuButton
                        size="icon"
                        type="button"
                        className="relative focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                        aria-label="Sort and grouping options"
                        data-testid="sidebar-v3-sort-menu-trigger"
                      />
                    }
                  >
                    <ArrowUpDownIcon />
                  </MenuTrigger>
                  <MenuPopup align="end" className="w-56">
                    <MenuGroup>
                      <MenuGroupLabel>Grouping</MenuGroupLabel>
                      <MenuRadioGroup
                        value={sidebarV3Grouping}
                        onValueChange={(value) => {
                          if (value === "status" || value === "flat") {
                            updateSettings({ sidebarV3Grouping: value });
                          }
                        }}
                      >
                        <MenuRadioItem value="status">Status sections</MenuRadioItem>
                        <MenuRadioItem value="flat">Flat list</MenuRadioItem>
                      </MenuRadioGroup>
                    </MenuGroup>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Sort within sections</MenuGroupLabel>
                      <MenuRadioGroup
                        value={sidebarV3ThreadSortOrder}
                        onValueChange={(value) => {
                          if (value === "created" || value === "activity") {
                            updateSettings({ sidebarV3ThreadSortOrder: value });
                          }
                        }}
                      >
                        <MenuRadioItem value="created">Created</MenuRadioItem>
                        <MenuRadioItem value="activity">Last activity</MenuRadioItem>
                      </MenuRadioGroup>
                    </MenuGroup>
                  </MenuPopup>
                </Menu>
              </div>
            </div>
            {projectGroups.length > 0 ? (
              <div className="flex items-center gap-1">
                <Menu open={projectScopeMenuOpen} onOpenChange={setProjectScopeMenuOpen}>
                  <MenuTrigger
                    render={
                      <SidebarMenuButton
                        aria-label="Filter threads by project"
                        className="min-w-0 flex-1 ps-[calc(var(--sidebar-row-content-inset)-1px)] focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
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
        <SidebarGroup className="ps-[calc(var(--sidebar-content-inset)+1px)] pe-[var(--sidebar-content-inset)] pb-1 pt-0">
          {isSearchingThreads ? (
            threadSearchResults.length > 0 ? (
              <TooltipProvider
                key="sidebar-thread-search-tooltips-150"
                delay={150}
                closeDelay={0}
                timeout={400}
              >
                <ul
                  id="sidebar-thread-search-results"
                  role="listbox"
                  aria-label="Thread search results"
                  className="flex flex-col gap-px"
                >
                  {threadSearchResults.map((thread, index) => {
                    const threadKey = scopedThreadKey(
                      scopeThreadRef(thread.environmentId, thread.id),
                    );
                    return (
                      <SidebarV3SearchResultRow
                        key={threadKey}
                        thread={thread}
                        projectCwd={
                          projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                        }
                        projectTitle={
                          projectDisplayNameByKey.get(
                            `${thread.environmentId}:${thread.projectId}`,
                          ) ?? null
                        }
                        environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                        providerEntryByInstanceId={providerEntryByInstanceId}
                        isHighlighted={activeSearchResultIndex === index}
                        isRouteActive={routeThreadKey === threadKey}
                        resultId={`sidebar-thread-search-result-${index}`}
                        onHighlight={() => setActiveSearchResultIndex(index)}
                        onSelect={() => selectThreadSearchResult(thread)}
                      />
                    );
                  })}
                </ul>
              </TooltipProvider>
            ) : (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                No threads found
              </p>
            )
          ) : null}
          {!isSearchingThreads ? (
            <TooltipProvider
              key="sidebar-thread-tooltips-150"
              delay={150}
              closeDelay={0}
              timeout={400}
            >
              <ul ref={attachListAutoAnimateRef} role="list" className="flex flex-col gap-px">
                {(() => {
                  const renderThreadRow = (
                    thread: EnvironmentThreadShell,
                    section: "pinned" | "active" | "snoozed" | "settled",
                  ) => {
                    const threadKey = scopedThreadKey(
                      scopeThreadRef(thread.environmentId, thread.id),
                    );
                    return (
                      <SidebarV3Row
                        // One uniform row variant, so a lifecycle transition
                        // is a plain position change — the stable key lets
                        // auto-animate slide the row to its new section.
                        key={threadKey}
                        thread={thread}
                        // Snoozed rows wake; settled rows un-settle (explicit
                        // settles clear the override, auto-settled rows get
                        // pinned active); cards settle.
                        variantAction={
                          section === "snoozed"
                            ? "unsnooze"
                            : section === "settled"
                              ? "unsettle"
                              : "settle"
                        }
                        settlementSupported={
                          serverConfigs.get(thread.environmentId)?.environment.capabilities
                            .threadSettlement === true
                        }
                        snoozeSupported={
                          serverConfigs.get(thread.environmentId)?.environment.capabilities
                            .threadSnooze === true
                        }
                        isPinned={section === "pinned"}
                        snoozeWakeLabelText={
                          section === "snoozed" && thread.snoozedUntil != null
                            ? snoozeWakeLabel(thread.snoozedUntil, {
                                now: new Date().toISOString(),
                              })
                            : null
                        }
                        // All sections: a woken thread can classify straight
                        // into the settled tail (PR merged while snoozed), and
                        // the wake signal must survive the trip. Still-snoozed
                        // rows resolve to null on their own.
                        wokeAt={threadWokeAt(thread, { now: snoozeNow })}
                        isActive={routeThreadKey === threadKey}
                        jumpLabel={showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
                        environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                        projectCwd={
                          projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                        }
                        projectTitle={
                          projectDisplayNameByKey.get(
                            `${thread.environmentId}:${thread.projectId}`,
                          ) ?? null
                        }
                        providerEntryByInstanceId={providerEntryByInstanceId}
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
                        onAcknowledgeWoke={acknowledgeWoke}
                        onChangeRequestState={handleChangeRequestState}
                      />
                    );
                  };
                  // Pinned block: full cards above the inbox, closed by a
                  // thin divider (the pin glyphs carry the meaning, so no
                  // header text). Vanishes entirely at count 0.
                  const items: ReactNode[] = pinnedThreads.map((thread) =>
                    renderThreadRow(thread, "pinned"),
                  );
                  if (pinnedThreads.length > 0) {
                    items.push(
                      <li
                        key="pinned-divider"
                        aria-hidden
                        data-testid="sidebar-v3-pinned-divider"
                        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
                      />,
                    );
                  }
                  // Status sections carry the coarse status in their colored
                  // headers; counts always show so a collapsed (or long)
                  // section still reads at a glance. Empty sections vanish.
                  const renderSectionHeader = (input: {
                    key: string;
                    label: string;
                    count: number;
                    expanded: boolean;
                    onToggle: () => void;
                    accentTextClassName: string;
                    accentLineClassName: string;
                  }) => (
                    <li key={input.key} data-thread-selection-safe className="list-none">
                      <button
                        type="button"
                        onClick={input.onToggle}
                        aria-expanded={input.expanded}
                        data-testid={`sidebar-v3-section-toggle-${input.key}`}
                        className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
                      >
                        <span className={cn("text-xs font-medium", input.accentTextClassName)}>
                          {`${input.label} (${input.count})`}
                        </span>
                        <span className={cn("h-px flex-1", input.accentLineClassName)} />
                        <ChevronDownIcon
                          aria-hidden
                          className={cn(
                            "size-3 transition-transform",
                            input.accentTextClassName,
                            input.expanded && "rotate-180",
                          )}
                        />
                      </button>
                    </li>
                  );
                  if (sidebarV3Grouping === "status") {
                    if (attentionThreads.length > 0) {
                      items.push(
                        renderSectionHeader({
                          key: "attention",
                          label: "Needs attention",
                          count: attentionThreads.length,
                          expanded: attentionExpanded,
                          onToggle: toggleAttentionSection,
                          accentTextClassName: "text-amber-700 dark:text-amber-300",
                          accentLineClassName: "bg-amber-500/25 dark:bg-amber-400/20",
                        }),
                      );
                      for (const thread of visibleAttentionThreads) {
                        items.push(renderThreadRow(thread, "active"));
                      }
                    }
                    if (workingThreads.length > 0) {
                      items.push(
                        renderSectionHeader({
                          key: "working",
                          label: "Working",
                          count: workingThreads.length,
                          expanded: workingExpanded,
                          onToggle: toggleWorkingSection,
                          accentTextClassName: "text-sky-600 dark:text-sky-400",
                          accentLineClassName: "bg-sky-500/20 dark:bg-sky-400/15",
                        }),
                      );
                      for (const thread of visibleWorkingThreads) {
                        items.push(renderThreadRow(thread, "active"));
                      }
                    }
                    if (readyThreads.length > 0) {
                      items.push(
                        renderSectionHeader({
                          key: "ready",
                          label: "Ready",
                          count: readyThreads.length,
                          expanded: readyExpanded,
                          onToggle: toggleReadySection,
                          accentTextClassName: "text-muted-foreground/50",
                          accentLineClassName: "bg-sidebar-border/60",
                        }),
                      );
                      for (const thread of visibleReadyThreads) {
                        items.push(renderThreadRow(thread, "active"));
                      }
                    }
                  } else {
                    for (const thread of activeThreads) {
                      items.push(renderThreadRow(thread, "active"));
                    }
                  }
                  // Snoozed shelf: between the inbox and Settled — out of the
                  // way, never gone. The header always renders while anything
                  // is snoozed (the count is the whole footprint when
                  // collapsed); rows only when expanded. Vanishes entirely at
                  // count 0.
                  if (snoozedThreads.length > 0) {
                    items.push(
                      <li
                        key="snoozed-shelf-header"
                        data-thread-selection-safe
                        className="list-none"
                      >
                        <button
                          type="button"
                          onClick={toggleSnoozedShelf}
                          aria-expanded={snoozedShelfExpanded}
                          data-testid="sidebar-v3-snoozed-shelf-toggle"
                          className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
                        >
                          <span className="text-xs font-medium text-blue-600 dark:text-blue-400">
                            {snoozedShelfExpanded
                              ? "Snoozed"
                              : `Snoozed (${snoozedThreads.length})`}
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
                    for (const thread of visibleSnoozedThreads) {
                      items.push(renderThreadRow(thread, "snoozed"));
                    }
                  }
                  if (settledThreads.length > 0) {
                    items.push(
                      <li
                        key="settled-shelf-header"
                        data-thread-selection-safe
                        className="list-none"
                      >
                        <button
                          type="button"
                          onClick={toggleSettledShelf}
                          aria-expanded={settledShelfExpanded}
                          data-testid="sidebar-v3-settled-shelf-toggle"
                          className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
                        >
                          <span className="text-xs font-medium text-muted-foreground/50">
                            {settledShelfExpanded
                              ? "Settled"
                              : `Settled (${settledThreads.length})`}
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
                  for (const thread of renderedSettledThreads) {
                    items.push(renderThreadRow(thread, "settled"));
                  }
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
          ) : null}
          {!isSearchingThreads &&
          pinnedThreads.length +
            activeThreads.length +
            snoozedThreads.length +
            settledThreads.length ===
            0 ? (
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
                        copyPathToClipboard(member.workspaceRoot, { path: member.workspaceRoot })
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
