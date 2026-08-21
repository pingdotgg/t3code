import { autoAnimate } from "@formkit/auto-animate";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  canSettle,
  canSnooze,
  changeRequestAutoSettles,
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
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ClockIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  MessageSquareIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
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
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isMacPlatform } from "~/lib/utils";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { readLocalApi } from "../localApi";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { openCommandPalette } from "../commandPaletteBus";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { useClientSettings } from "../hooks/useSettings";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../state/server";
import { vcsEnvironment } from "../state/vcs";
import { threadEnvironment } from "../state/threads";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { environmentSnapshotAtom } from "../state/shell";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { formatRelativeTimeLabel, parseTimestampDate } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { cn } from "~/lib/utils";
import { buildThreadActionMenuItems } from "./threadActionMenu.logic";
import {
  animatePinnedLayoutChanges,
  buildBulkTitleRegenerationContextMenuItem,
  formatWorkingDurationLabel,
  firstValidTimestampMs,
  hasUnseenCompletion,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  planPinnedReorder,
  resolveAdjacentThreadId,
  resolveSettledTimestamp,
  resolveSidebarThreadStatus,
  searchSidebarThreadsByTitle,
  shouldCreateNewThreadInCurrentProject,
  resolveWorkingStartedAt,
  sortLogicalProjectsForSidebar,
  sortPinnedThreadsForSidebar,
  sortSettledThreadsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
import {
  captureSidebarDndPointerAnchor,
  createSidebarDndDraggableId,
  createSidebarDndRowId,
  createSidebarDndSectionId,
  parseSidebarDndId,
  resolveSidebarDndAction,
  resolveSidebarDndPreviewVariant,
  type SidebarDndAction,
  type SidebarDndPointerAnchor,
  type SidebarDndPreviewVariant,
  type SidebarDndSection,
} from "./Sidebar.dnd.logic";
import { resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import {
  ThreadWorktreeIndicator,
  nextThreadChangeRequestSnapshot,
  prStatusIndicator,
  resolveDisplayedThreadPr,
  resolveDisplayedThreadPrProvider,
  setThreadChangeRequestSnapshot,
  settledPrHoverColorClass,
  terminalStatusFromRunningIds,
  threadChangeRequestSnapshotsAtom,
  type ThreadChangeRequestSnapshot,
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
import {
  deriveProviderEntriesByEnvironment,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { SidebarContent, SidebarGroup, SidebarMenuButton, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarThreadDragPreview } from "./sidebar/SidebarThreadDragPreview";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../composerDraftStore";

// Settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more.
const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;
// Keep the v2 key so existing preferences survive the v2-to-default rename.
const SETTLED_SHELF_EXPANDED_KEY = "t3code:sidebar-v2:settled-expanded";
const SNOOZED_SHELF_EXPANDED_KEY = "t3code:sidebar-v2:snoozed-expanded";
const SIDEBAR_DND_SECTION_ORDER = [
  "pinned",
  "regular",
  "snoozed",
  "settled",
] satisfies ReadonlyArray<SidebarDndSection>;
const SIDEBAR_DND_EMPTY_RAIL_HEIGHT = 48;

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

const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, ProviderInstanceEntry> = new Map();

function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

function SidebarThreadTooltip({
  thread,
  projectTitle,
  projectCwd,
  projectFaviconPath,
  environmentLabel,
  providerEntry,
  showInstanceBadge,
  modelInstanceId,
  modelLabel,
  branchMismatch,
  terminalStatus,
  terminalProcessCount,
}: {
  thread: SidebarThreadSummary;
  projectTitle: string | null;
  projectCwd: string | null;
  projectFaviconPath: string | null;
  environmentLabel: string | null;
  providerEntry: ProviderInstanceEntry | null;
  showInstanceBadge: boolean;
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalProcessCount: number;
}) {
  const driverKind = providerEntry?.driverKind ?? null;
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
                faviconPath={projectFaviconPath}
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
                displayName={
                  providerEntry?.displayName ?? thread.session?.providerName ?? modelInstanceId
                }
                accentColor={providerEntry?.accentColor}
                // Initials would swallow a size-3 glyph: accent dot, name in label.
                showBadge={showInstanceBadge && providerEntry?.accentColor !== undefined}
                badgeContent="none"
                badgeClassName="h-2 min-w-2 px-0"
                iconClassName="size-3 shrink-0 grayscale opacity-60"
              />
              <div className="min-w-0 truncate text-foreground/75">
                {showInstanceBadge && providerEntry
                  ? `${modelLabel} · ${providerEntry.displayName}`
                  : modelLabel}
              </div>
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

/**
 * Hover entry point for snooze: a clock button opening the preset menu.
 * Controlled by the row (which also uses the open state to pin its hover
 * actions while the menu is up).
 */
function SnoozePopoverButton(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (preset: SnoozePreset) => void;
  timestampFormat: TimestampFormat;
}) {
  const { open, onOpenChange, onSnooze, timestampFormat } = props;
  // Presets resolve at open time so "In 1 hour" is relative to the click,
  // not to when the row mounted.
  const presets = useMemo(
    () => (open ? resolveSnoozePresets(new Date(), timestampFormat) : []),
    [open, timestampFormat],
  );
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
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
            />
          }
        >
          <ClockIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>Snooze thread</TooltipPopup>
      </Tooltip>
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

type SidebarThreadDndRowBag = {
  readonly listeners: ReturnType<typeof useDraggable>["listeners"];
  readonly setNodeRef: (node: HTMLElement | null) => void;
  readonly transform: ReturnType<typeof useDraggable>["transform"];
  readonly transition: string | undefined;
  readonly isDragging: boolean;
  readonly isSortable: boolean;
};

function SortableSidebarThreadRow(props: {
  threadKey: string;
  section: SidebarDndSection;
  disabled: boolean;
  onNodeChange: (threadKey: string, node: HTMLElement | null) => void;
  children: (bag: SidebarThreadDndRowBag) => ReactNode;
}) {
  const id = createSidebarDndDraggableId({ section: props.section, threadKey: props.threadKey });
  const sortable = useSortable({
    id,
    disabled: props.disabled,
    animateLayoutChanges: animatePinnedLayoutChanges,
    data: { section: props.section, threadKey: props.threadKey },
  });
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      sortable.setNodeRef(node);
      props.onNodeChange(props.threadKey, node);
    },
    [props.onNodeChange, props.threadKey, sortable.setNodeRef],
  );
  useEffect(
    () => () => {
      props.onNodeChange(props.threadKey, null);
    },
    [props.onNodeChange, props.threadKey],
  );
  return props.children({
    listeners: sortable.listeners,
    setNodeRef,
    transform: sortable.transform,
    transition: sortable.transition,
    isDragging: sortable.isDragging,
    isSortable: true,
  });
}

function DraggableSidebarThreadRow(props: {
  threadKey: string;
  section: SidebarDndSection;
  dragDisabled: boolean;
  dropDisabled: boolean;
  onNodeChange: (threadKey: string, node: HTMLElement | null) => void;
  children: (bag: SidebarThreadDndRowBag) => ReactNode;
}) {
  const draggable = useDraggable({
    id: createSidebarDndDraggableId({
      section: props.section,
      threadKey: props.threadKey,
    }),
    disabled: props.dragDisabled,
    data: { section: props.section, threadKey: props.threadKey },
  });
  const droppable = useDroppable({
    id: createSidebarDndRowId({ section: props.section, threadKey: props.threadKey }),
    disabled: props.dropDisabled,
    data: { section: props.section, threadKey: props.threadKey },
  });
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      draggable.setNodeRef(node);
      droppable.setNodeRef(node);
      props.onNodeChange(props.threadKey, node);
    },
    [draggable.setNodeRef, droppable.setNodeRef, props.onNodeChange, props.threadKey],
  );
  useEffect(
    () => () => {
      props.onNodeChange(props.threadKey, null);
    },
    [props.onNodeChange, props.threadKey],
  );
  return props.children({
    listeners: draggable.listeners,
    setNodeRef,
    // Sorted lists never apply the draggable transform to their source row.
    transform: null,
    transition: undefined,
    isDragging: draggable.isDragging,
    isSortable: false,
  });
}

function SidebarThreadSectionDropZone(props: {
  section: SidebarDndSection;
  disabled: boolean;
  children: (bag: {
    readonly setNodeRef: (node: HTMLElement | null) => void;
    readonly isOver: boolean;
  }) => ReactNode;
}) {
  const droppable = useDroppable({
    id: createSidebarDndSectionId({ section: props.section }),
    disabled: props.disabled,
    data: { section: props.section },
  });
  return props.children({ setNodeRef: droppable.setNodeRef, isOver: droppable.isOver });
}

function SidebarThreadViewportDropRail(props: {
  section: SidebarDndSection;
  top: number;
  setDropNodeRef: (node: HTMLElement | null) => void;
  onNodeChange: (section: SidebarDndSection, node: HTMLElement | null) => void;
  children: ReactNode;
}) {
  const setNodeRef = useCallback(
    (node: HTMLDivElement | null) => {
      props.setDropNodeRef(node);
      props.onNodeChange(props.section, node);
    },
    [props.onNodeChange, props.section, props.setDropNodeRef],
  );

  return (
    <div
      ref={setNodeRef}
      className="pointer-events-auto absolute inset-x-0 z-30"
      style={{ top: props.top }}
    >
      {props.children}
    </div>
  );
}

function SidebarThreadDropIndicator(props: { edge: "before" | "after" }) {
  return (
    <span
      aria-hidden
      data-testid="sidebar-thread-drop-indicator"
      className={cn(
        "pointer-events-none absolute inset-x-2.5 z-30 h-0 border-t-2 border-primary",
        props.edge === "before" ? "top-0" : "bottom-0",
      )}
    />
  );
}

// One unsent draft session the user has invested content in. Two lines,
// nothing else: project name, then the typed prompt. All the draft's
// settings (model, env mode, branch, worktree) still travel with it —
// clicking is a plain navigation to /draft/$draftId, which touches nothing.
// While the draft is open the row renders a frozen snapshot (see
// SidebarDraftBlock); memoized so per-keystroke block re-renders skip it
// entirely.
const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
  projectTitle: string | null;
  projectCwd: string | null;
  projectFaviconPath: string | null;
  isActive: boolean;
  onNavigate: (draftId: DraftId) => void;
  onDiscard: (draftId: DraftId) => void;
}) {
  const { composer, draftId, onDiscard, onNavigate, session } = props;
  const promptPreview = composer.prompt.trim().split("\n", 1)[0] ?? "";
  // images mirrors persistedAttachments once rehydration finishes; before
  // that only the persisted list is populated, hence max not sum.
  const attachmentCount =
    Math.max(composer.images.length, composer.persistedAttachments.length) +
    composer.terminalContexts.length +
    composer.elementContexts.length +
    composer.previewAnnotations.length +
    composer.reviewComments.length;
  const preview =
    promptPreview.length > 0
      ? promptPreview
      : `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;
  const handleActivate = useCallback(() => onNavigate(draftId), [draftId, onNavigate]);
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      // Keys targeting the nested discard button belong to the button:
      // preventDefault here would swallow Space's synthesized click and
      // navigate instead of discarding.
      if ((event.target as HTMLElement).closest("button")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onNavigate(draftId);
      }
    },
    [draftId, onNavigate],
  );
  const handleDiscard = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onDiscard(draftId);
    },
    [draftId, onDiscard],
  );
  return (
    <li className="list-none py-0.5">
      <div
        role="button"
        tabIndex={0}
        data-testid="sidebar-draft-row"
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left text-sidebar-foreground outline-none select-none",
          props.isActive
            ? "bg-sidebar-row-active"
            : "bg-amber-400/[0.04] hover:bg-amber-400/[0.08]",
        )}
        onClick={handleActivate}
        onKeyDown={handleKeyDown}
      >
        <div className="relative z-10 px-[var(--sidebar-row-content-inset)] py-[var(--sidebar-content-inset)]">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <SquarePenIcon
              aria-hidden
              className="size-3 shrink-0 text-amber-600 dark:text-amber-300/80"
            />
            <ProjectFavicon
              environmentId={session.environmentId}
              cwd={props.projectCwd ?? ""}
              faviconPath={props.projectFaviconPath}
              className="size-4 shrink-0"
            />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label">
              {props.projectTitle}
            </span>
            <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-end">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Discard draft"
                      onClick={handleDiscard}
                      className="pointer-events-none inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
                    >
                      <XIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup side="top">Discard draft</TooltipPopup>
              </Tooltip>
            </span>
          </div>
          <div className="mt-0.5 truncate text-sm font-medium text-foreground/90">{preview}</div>
        </div>
      </div>
    </li>
  );
});

interface SidebarDraftRowData {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
}

// Draft sessions with user content, surfaced above the pinned block so an
// interrupted "new thread" stays one click away. Self-contained (own store
// subscription + closing divider) so per-keystroke composer updates
// re-render only this block, never the whole sidebar. Vanishes at count 0.
const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  projectCwdByKey: ReadonlyMap<string, string>;
  projectFaviconPathByKey: ReadonlyMap<string, string | null | undefined>;
  scopedProjectKeys: ReadonlySet<string> | null;
  routeDraftId: string | null;
  onNavigateToDraft: (draftId: DraftId) => void;
}) {
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore((store) => store.draftsByThreadKey);
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  // The open draft's row is FROZEN at the moment the draft became the route:
  // it stays visible (like a thread row) but never repaints while the user
  // types. A draft that was never navigated away from has no snapshot to
  // freeze, so a fresh typing session shows no row at all. Captured
  // synchronously on route change (setState-during-render derived state) so
  // the row never flickers out for a frame between route change and capture.
  const [frozenActive, setFrozenActive] = useState<{
    routeDraftId: string | null;
    row: SidebarDraftRowData | null;
  }>({ routeDraftId: null, row: null });
  if (frozenActive.routeDraftId !== props.routeDraftId) {
    let row: SidebarDraftRowData | null = null;
    if (props.routeDraftId !== null) {
      const draftId = DraftId.make(props.routeDraftId);
      const store = useComposerDraftStore.getState();
      const session = store.getDraftSession(draftId);
      const composer = store.getComposerDraft(draftId);
      row =
        session && session.promotedTo == null && composer && composerDraftHasUserContent(composer)
          ? { draftId, session, composer }
          : null;
    }
    setFrozenActive({ routeDraftId: props.routeDraftId, row });
  }
  const drafts = useMemo(() => {
    const rows: SidebarDraftRowData[] = [];
    // Every non-promoted session with content gets a row, mapped or not:
    // new-thread surfaces mint fresh drafts and leave invested ones behind
    // unmapped, so the mapping only knows about the latest per project.
    for (const [draftKey, session] of Object.entries(draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (
        props.scopedProjectKeys !== null &&
        !props.scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
      ) {
        continue;
      }
      if (draftKey === props.routeDraftId) {
        // Open draft: render the frozen entry snapshot, or nothing for a
        // draft that has never been left. Gated on the LIVE session above so
        // send/discard still removes the row immediately.
        if (frozenActive.routeDraftId === draftKey && frozenActive.row !== null) {
          rows.push(frozenActive.row);
        }
        continue;
      }
      const composer = draftsByThreadKey[draftKey];
      if (!composer || !composerDraftHasUserContent(composer)) {
        continue;
      }
      rows.push({ draftId: DraftId.make(draftKey), session, composer });
    }
    rows.sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
    return rows;
  }, [
    draftThreadsByThreadKey,
    draftsByThreadKey,
    frozenActive,
    props.routeDraftId,
    props.scopedProjectKeys,
  ]);
  const handleDiscard = useCallback(
    (draftId: DraftId) => {
      // The /draft/$draftId route redirects home on its own when the draft
      // it renders disappears, so discarding the open draft needs no
      // special-casing here.
      clearDraftThread(draftId);
    },
    [clearDraftThread],
  );
  if (drafts.length === 0) {
    return null;
  }
  return (
    <>
      {drafts.map(({ composer, draftId, session }) => {
        const projectKey = `${session.environmentId}:${session.projectId}`;
        return (
          <SidebarDraftRow
            key={draftId}
            draftId={draftId}
            session={session}
            composer={composer}
            projectTitle={props.projectDisplayNameByKey.get(projectKey) ?? null}
            projectCwd={props.projectCwdByKey.get(projectKey) ?? null}
            projectFaviconPath={props.projectFaviconPathByKey.get(projectKey) ?? null}
            isActive={draftId === props.routeDraftId}
            onNavigate={props.onNavigateToDraft}
            onDiscard={handleDiscard}
          />
        );
      })}
      <li
        aria-hidden
        data-testid="sidebar-draft-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});

const SidebarThreadRow = memo(function SidebarThreadRow(props: {
  thread: SidebarThreadSummary;
  variant: "card" | "slim";
  // Slim rows are either settled (action: un-settle) or merely quiet
  // (seen Ready threads — action: settle).
  variantAction: "settle" | "unsettle" | "unsnooze";
  // False on environments whose server predates thread.settle/unsettle:
  // the lifecycle affordances hide entirely rather than fail on click.
  settlementSupported: boolean;
  autoSettleOnMerge: boolean;
  // Same contract for thread.snooze/unsnooze.
  snoozeSupported: boolean;
  // Renders the pin glyph. Pinned cards keep the full settle/snooze quick
  // actions: both move the thread out of Pinned. The glyph is also the
  // in-row pin state cue (the pinned block has no header), so it always
  // shows while pinned; it only becomes a clickable unpin quick-action once
  // the pinning capability is confirmed, and stays a passive marker while
  // the descriptor is not loaded. Pinning itself lives in the context menu.
  pinningSupported: boolean;
  isPinned: boolean;
  // Applied to the exact row root measured by DnD Kit. Sorted rows never use
  // the draggable transform; Pinned alone receives sortable transforms.
  dnd?: SidebarThreadDndRowBag | undefined;
  dndDimmed: boolean;
  dndInert: boolean;
  dropIndicator: "before" | "after" | null;
  // Compact wake countdown ("2h") for rows in the snoozed shelf.
  snoozeWakeLabelText: string | null;
  // When a snooze ended (timer or early wake); drives the Woke pill until
  // the user visits the thread.
  wokeAt: string | null;
  isActive: boolean;
  openPullRequestsInRightPanel: boolean;
  jumpLabel: string | null;
  currentEnvironmentId: string | null;
  environmentLabel: string | null;
  projectCwd: string | null;
  projectFaviconPath: string | null;
  projectTitle: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  timestampFormat: TimestampFormat;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  onSnooze: (threadRef: ScopedThreadRef, preset: SnoozePreset) => void;
  onUnsnooze: (threadRef: ScopedThreadRef) => void;
  onUnpin: (threadRef: ScopedThreadRef) => void;
  onAcknowledgeWoke: (threadRef: ScopedThreadRef, visitedAt: string) => void;
  changeRequestSnapshot: ThreadChangeRequestSnapshot | null;
  onChangeRequestSnapshot: (
    threadKey: string,
    snapshot: ThreadChangeRequestSnapshot | null,
  ) => void;
}) {
  const {
    isRenaming,
    changeRequestSnapshot,
    onChangeRequestSnapshot,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onAcknowledgeWoke,
    onRenameTitleChange,
    onSettle,
    onSnooze,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onUnsettle,
    onUnsnooze,
    onUnpin,
    openPullRequestsInRightPanel,
    renamingTitle,
    thread,
    variant,
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

  const gitCwd = thread.worktreePath ?? props.projectCwd;
  const gitStatus = useEnvironmentQuery(
    (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const retainTerminalOnBranchMismatch = thread.worktreePath === null;
  const pr = resolveDisplayedThreadPr({
    threadBranch: thread.branch,
    gitStatus: gitStatus.data,
    snapshot: changeRequestSnapshot,
    retainTerminalOnBranchMismatch,
  });

  // Same semantics as the legacy sidebar (never-visited counts as read):
  // switching sidebars must not light up every historical thread as unread.
  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarThreadStatus(thread);
  // A woken thread returns in Regular's natural order. The pill stays until
  // the user re-engages by reading a completion-triggered wake, clicking it,
  // sending a message, settling, archiving, or reaching a change request
  // state that settles the thread. Timer wakes survive a mere visit. An
  // unparseable visit timestamp counts as never-visited, so corrupt local
  // data cannot eat the wake signal.
  const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
  const wokeAtDate = props.wokeAt === null ? null : parseTimestampDate(props.wokeAt);
  const isWoke =
    wokeAtDate !== null &&
    (lastVisitedDate === null || lastVisitedDate < wokeAtDate) &&
    !changeRequestAutoSettles(pr, {
      autoSettleOnMerge: props.autoSettleOnMerge,
      thread,
    });
  // In-flight rows (working, or waiting on approval/input) fade as a whole:
  // there is nothing for the user to do yet, so prominence is reserved for
  // rows that need a human — done (unread), read-but-unsettled, failed, and
  // freshly woken. The status label keeps its hue, so waiting rows stay
  // findable. In-flight rows recede the same as read-ready ones (inbox-zero:
  // working threads aren't your problem yet) — only the colored status label
  // stands out.
  const isInFlight =
    status === "working" || status === "monitoring" || status === "approval" || status === "input";
  const shouldRecede =
    (status === "ready" || isInFlight) && !isUnread && !isWoke && !props.isActive && !isSelected;
  // Status hues follow the system-wide convention set by sidebar v1 and the
  // mobile Live Activity/widgets (amber approval, indigo input, sky working)
  // so a thread reads the same color everywhere it surfaces.
  const topStatus =
    status === "working"
      ? {
          label: "Working",
          icon: "working" as const,
          // No shimmer: a label that animates forever is noise in a sidebar
          // full of them (and repaints every vsync on high-refresh displays).
          // Working is a background state, so it rests at the dim end of what
          // the old pulse cycled through; only the thread you have open gets
          // the label at full strength.
          className: cn("text-sky-600 dark:text-sky-400", !props.isActive && "opacity-75"),
        }
      : status === "monitoring"
        ? {
            // Monitoring is calm background presence, not active progress
            // (monitoring-pill D6), so it keeps the label at full strength.
            label: "Monitoring",
            icon: null,
            className: "text-sky-600 dark:text-sky-400",
          }
        : status === "approval"
          ? {
              label: "Approval",
              icon: null,
              className: "text-amber-700 dark:text-amber-300",
            }
          : status === "input"
            ? {
                label: "Input",
                icon: null,
                className: "text-indigo-600 dark:text-indigo-300",
              }
            : status === "failed"
              ? {
                  label: "Failed",
                  icon: null,
                  className: "text-red-700 dark:text-red-300",
                }
              : isWoke
                ? {
                    label: "Woke",
                    icon: "woke" as const,
                    className: "text-amber-700 dark:text-amber-300",
                  }
                : isUnread
                  ? {
                      label: "Done",
                      icon: "done" as const,
                      className: "text-emerald-700 dark:text-emerald-300",
                    }
                  : null;
  const isWokeStatus = topStatus?.icon === "woke";

  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: gitStatus.data?.refName ?? null,
  });
  const prProvider = resolveDisplayedThreadPrProvider({
    threadBranch: thread.branch,
    gitStatus: gitStatus.data,
    snapshot: changeRequestSnapshot,
    retainTerminalOnBranchMismatch,
  });
  const prStatus = prStatusIndicator(pr, prProvider);
  const settledPrHoverClass = pr ? settledPrHoverColorClass(pr.state) : undefined;
  useEffect(() => {
    const nextSnapshot = nextThreadChangeRequestSnapshot({
      threadBranch: thread.branch,
      gitStatus: gitStatus.data,
      snapshot: changeRequestSnapshot,
      retainTerminalOnBranchMismatch,
    });
    if (nextSnapshot === undefined) return;
    onChangeRequestSnapshot(threadKey, nextSnapshot);
  }, [
    changeRequestSnapshot,
    gitStatus.data,
    onChangeRequestSnapshot,
    retainTerminalOnBranchMismatch,
    thread.branch,
    threadKey,
  ]);

  const modelInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const driverKind = providerEntry?.driverKind ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;

  const isRemote =
    props.currentEnvironmentId !== null && thread.environmentId !== props.currentEnvironmentId;

  const detailsTooltip = (
    <SidebarThreadTooltip
      thread={thread}
      projectTitle={props.projectTitle}
      projectCwd={props.projectCwd}
      projectFaviconPath={props.projectFaviconPath}
      environmentLabel={props.environmentLabel}
      providerEntry={providerEntry}
      showInstanceBadge={showInstanceBadge}
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
  const handleDndPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (
      event.pointerType === "touch" ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey
    ) {
      event.stopPropagation();
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (
      target.closest(
        "button, a, input, textarea, select, [contenteditable='true'], [data-thread-selection-safe]",
      )
    ) {
      event.stopPropagation();
    }
  }, []);
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
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
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
  const handleSettleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onSettle(threadRef);
    },
    [onSettle, threadRef],
  );
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
  const handleUnpinClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnpin(threadRef);
    },
    [onUnpin, threadRef],
  );
  const handleSnoozePreset = useCallback(
    (preset: SnoozePreset) => {
      onSnooze(threadRef, preset);
    },
    [onSnooze, threadRef],
  );
  // While the snooze popover is open the pointer leaves the row, which
  // would fade the hover actions out from under the open menu; pin them.
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  // Snooze is offered only where it can succeed: capability-gated and never
  // on blocked-on-you work or queued turns (the server rejects both).
  const showSnoozeButton =
    !props.dndInert &&
    props.snoozeSupported &&
    canSnooze(thread, { now: new Date().toISOString() });
  // If the thread becomes blocked while the popover is open, the button
  // unmounts without firing onOpenChange(false). Deriving the flag keeps a
  // stale true from permanently hiding the status label / pinning the
  // hover actions, and the effect clears the raw state so the popover
  // doesn't resurrect if the button later remounts.
  const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton;
  useEffect(() => {
    if (!showSnoozeButton) setSnoozeMenuOpen(false);
  }, [showSnoozeButton]);
  const handlePrClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (!pr?.url) return;
      const openedInRightPanel = openPrLink(
        event,
        pr.url,
        openPullRequestsInRightPanel ? threadRef : undefined,
      );
      if (openedInRightPanel && openPullRequestsInRightPanel && !props.isActive) {
        onThreadActivate(threadRef);
      }
    },
    [onThreadActivate, openPrLink, openPullRequestsInRightPanel, pr, props.isActive, threadRef],
  );

  // All sidebar rows share one surface model. Live threads used to look
  // like elevated cards while settled threads were plain rows, leaving neither
  // a useful hierarchy nor a reliable hover cue. Status now lives in the row
  // content; surface is reserved for interaction (hover, multi-select, route).
  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none",
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
        "min-w-0 flex-1 text-sm transition-opacity motion-reduce:transition-none",
        shouldRecede ? "font-normal" : "font-medium",
        variant === "card"
          ? cn(
              "truncate",
              isUnread || isWoke
                ? "text-foreground"
                : shouldRecede
                  ? "text-secondary-label"
                  : status === "failed"
                    ? "text-foreground/95"
                    : "text-foreground/90",
            )
          : cn(
              "truncate group-hover/sidebar-row:text-foreground",
              props.isActive || isWoke
                ? "text-foreground"
                : isUnread
                  ? "text-muted-foreground"
                  : "text-secondary-label/70",
            ),
        isRegeneratingTitle && "opacity-[0.55]",
      )}
    >
      {thread.title}
    </span>
  );

  // A real link so cmd/ctrl+click and middle-click open the host in the
  // browser. A plain click still opens T3's pull request view.
  const prBadge =
    prStatus && pr ? (
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={handlePrClick}
        className={cn(
          // Sidebar chrome follows the interface font; tabular digits keep the
          // number from reflowing as PR states stream in.
          "shrink-0 text-xs tabular-nums hover:underline",
          variant === "slim" && variantAction === "unsettle"
            ? props.isActive
              ? "text-secondary-label"
              : cn("text-secondary-label transition-colors", settledPrHoverClass)
            : prStatus.colorClass,
        )}
        aria-label={prStatus.tooltip}
      >
        #{pr.number}
      </a>
    ) : null;
  const terminalStatusIcon = terminalStatus ? (
    <span
      role="img"
      aria-label={terminalProcessLabel(terminalProcessCount)}
      data-testid={`sidebar-terminal-status-${thread.id}`}
      className={cn("inline-flex shrink-0 items-center justify-center", terminalStatus.colorClass)}
    >
      <TerminalIcon className={cn("size-3.5", terminalStatus.pulse && "animate-status-pulse")} />
    </span>
  ) : null;
  const pinIndicator = props.isPinned ? (
    props.pinningSupported ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Unpin thread"
              onClick={handleUnpinClick}
              className="inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <PinIcon aria-hidden className="size-3 shrink-0" />
        </TooltipTrigger>
        <TooltipPopup>Unpin thread</TooltipPopup>
      </Tooltip>
    ) : (
      <PinIcon
        aria-label="Pinned"
        role="img"
        className="size-3 shrink-0 text-muted-foreground/65"
      />
    )
  ) : null;

  if (variant === "slim") {
    const dnd = props.dnd;
    return (
      <li
        data-thread-item
        data-thread-key={threadKey}
        data-dnd-source={props.dndDimmed || undefined}
        data-dnd-transformed={(dnd?.isSortable === true && dnd.transform !== null) || undefined}
        ref={dnd?.setNodeRef}
        inert={props.dndInert ? true : undefined}
        {...(dnd?.listeners ?? {})}
        onPointerDownCapture={dnd ? handleDndPointerDownCapture : undefined}
        className={cn(
          "relative list-none [content-visibility:auto] [contain-intrinsic-size:auto_34px]",
          dnd && "touch-pan-y cursor-grab active:cursor-grabbing",
          props.dndDimmed && "opacity-35",
          props.dndInert && "pointer-events-none",
        )}
      >
        {props.dropIndicator ? <SidebarThreadDropIndicator edge={props.dropIndicator} /> : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                role="button"
                tabIndex={props.dndInert ? -1 : 0}
                aria-disabled={props.dndInert || undefined}
                data-testid="sidebar-row-slim"
                aria-busy={isRegeneratingTitle || undefined}
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
                  "opacity-40 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
              )}
            >
              <ProjectFavicon
                environmentId={thread.environmentId}
                cwd={props.projectCwd ?? ""}
                faviconPath={props.projectFaviconPath}
                className="size-4"
                fallbackIcon={MessageSquareIcon}
              />
            </span>
            {title}
            {pinIndicator}
            {terminalStatusIcon}
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
                  "inline-flex justify-end tabular-nums text-secondary-label transition-opacity",
                  !isWoke && "group-hover/sidebar-row:opacity-0",
                )}
              >
                {variantAction === "unsnooze" && props.snoozeWakeLabelText !== null ? (
                  // Snoozed rows show when they come BACK, not when they were
                  // last touched — the return ticket is the row's whole story.
                  <span className="text-xs text-blue-600 tabular-nums dark:text-blue-400">
                    {props.snoozeWakeLabelText}
                  </span>
                ) : isWoke ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label="Dismiss Woke notification"
                          onClick={handleAcknowledgeWokeClick}
                          className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium text-amber-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-300"
                        >
                          <AlarmClockIcon aria-hidden className="size-3" />
                          <span role="status">Woke</span>
                        </button>
                      }
                    />
                    <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
                  </Tooltip>
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
                      "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100",
                      isWoke && "group-hover/sidebar-row:static",
                    )}
                  >
                    <AlarmClockOffIcon className="mb-px size-3" />
                  </button>
                )
              ) : !props.settlementSupported ? null : variantAction === "unsettle" ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label="Un-settle thread"
                        onClick={handleUnsettleClick}
                        className={cn(
                          "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100",
                          isWoke && "group-hover/sidebar-row:static",
                        )}
                      />
                    }
                  >
                    <Undo2Icon className="mb-px size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Un-settle thread</TooltipPopup>
                </Tooltip>
              ) : (
                <button
                  type="button"
                  aria-label="Settle thread"
                  onClick={handleSettleClick}
                  className={cn(
                    "pointer-events-none absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100",
                    isWoke && "group-hover/sidebar-row:static",
                  )}
                >
                  <CheckIcon className="size-3" />
                </button>
              )}
            </span>
            {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
          </TooltipTrigger>
          {detailsTooltip}
        </Tooltip>
      </li>
    );
  }

  const diff = latestTurnDiff(thread);

  const dnd = props.dnd;
  return (
    <li
      data-thread-item
      data-thread-key={threadKey}
      data-dnd-source={props.dndDimmed || undefined}
      data-dnd-transformed={(dnd?.isSortable === true && dnd.transform !== null) || undefined}
      ref={dnd?.setNodeRef}
      inert={props.dndInert ? true : undefined}
      style={
        dnd?.isSortable
          ? {
              transform: CSS.Translate.toString(dnd.transform),
              transition: dnd.transition,
            }
          : undefined
      }
      {...(dnd?.listeners ?? {})}
      onPointerDownCapture={dnd ? handleDndPointerDownCapture : undefined}
      className={cn(
        "relative list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_96px]",
        dnd && "touch-pan-y cursor-grab active:cursor-grabbing",
        dnd?.isDragging && "z-20",
        props.dndDimmed && "opacity-35",
        props.dndInert && "pointer-events-none",
      )}
    >
      {props.dropIndicator ? <SidebarThreadDropIndicator edge={props.dropIndicator} /> : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              role="button"
              tabIndex={props.dndInert ? -1 : 0}
              aria-disabled={props.dndInert || undefined}
              data-testid="sidebar-row-card"
              aria-busy={isRegeneratingTitle || undefined}
              className={rowSurfaceClassName}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          }
        >
          <div className="relative z-10 h-[4.875rem] px-[var(--sidebar-row-content-inset)] py-[var(--sidebar-content-inset)]">
            <div className="flex h-5 min-w-0 items-center gap-1.5">
              <ProjectFavicon
                environmentId={thread.environmentId}
                cwd={props.projectCwd ?? ""}
                faviconPath={props.projectFaviconPath}
                className="size-4 shrink-0"
              />
              {props.projectTitle ? (
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-secondary-label text-xs",
                    shouldRecede ? "font-normal" : "font-medium",
                  )}
                >
                  {props.projectTitle}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              {pinIndicator}
              {/* The visible state owns this slot's width: status at rest,
                  actions on hover/keyboard focus or while the popover is open. Keeping
                  the hidden state out of flow lets the project label reclaim
                  space without either state overlapping it. */}
              <span className="group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
                {/* Read-only status labels yield to the hover actions. Woke is
                    itself an action, so it stays pointer-enabled and visible
                    while the other controls appear beside it. */}
                <span
                  className={cn(
                    isWokeStatus
                      ? "pointer-events-auto"
                      : "pointer-events-none group-has-[:focus-visible]/sidebar-status-slot:absolute group-has-[:focus-visible]/sidebar-status-slot:right-0 group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-hover/sidebar-row:absolute group-hover/sidebar-row:right-0 group-hover/sidebar-row:opacity-0",
                    "flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity",
                    snoozeMenuOpen && "pointer-events-none absolute right-0 opacity-0",
                  )}
                >
                  {topStatus ? (
                    isWokeStatus ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label="Dismiss Woke notification"
                              onClick={handleAcknowledgeWokeClick}
                              className={cn(
                                "inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
                                topStatus.className,
                              )}
                            >
                              <AlarmClockIcon aria-hidden className="size-4 shrink-0" />
                              <span role="status">{topStatus.label}</span>
                            </button>
                          }
                        />
                        <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
                      </Tooltip>
                    ) : (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 font-medium",
                          topStatus.className,
                        )}
                      >
                        {topStatus.icon === "working" ? (
                          <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
                        ) : topStatus.icon === "done" ? (
                          <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
                        ) : null}
                        {/* The label alone is the live region: a role="status"
                            wrapper around the ticking duration would make
                            screen readers announce every second. */}
                        <span role="status">{topStatus.label}</span>
                        {status === "working" ? (
                          <span aria-hidden>
                            <WorkingDuration startedAt={resolveWorkingStartedAt(thread)} />
                          </span>
                        ) : null}
                      </span>
                    )
                  ) : (
                    threadTimeLabel(thread)
                  )}
                </span>
                {props.settlementSupported || showSnoozeButton ? (
                  <span
                    className={cn(
                      // focus-visible, not focus-within: a mouse click leaves
                      // the Settle button focused, and a plain focus-within
                      // would keep the controls pinned over the status label
                      // once the pointer moves away (e.g. after a failed
                      // settle) instead of cross-fading back.
                      "pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:static group-hover/sidebar-row:opacity-100",
                      snoozeMenuOpen && "pointer-events-auto static opacity-100",
                    )}
                  >
                    {showSnoozeButton ? (
                      <SnoozePopoverButton
                        open={snoozeMenuOpen}
                        onOpenChange={setSnoozeMenuOpen}
                        onSnooze={handleSnoozePreset}
                        timestampFormat={props.timestampFormat}
                      />
                    ) : null}
                    {props.settlementSupported ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label="Settle thread"
                              onClick={handleSettleClick}
                              className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                            />
                          }
                        >
                          <CheckIcon className="size-3.5" />
                          Settle
                        </TooltipTrigger>
                        <TooltipPopup>Settle thread</TooltipPopup>
                      </Tooltip>
                    ) : null}
                  </span>
                ) : null}
              </span>
            </div>
            <div className="mt-1 flex min-w-0">
              {title}
              {isRegeneratingTitle ? (
                <span role="status" className="sr-only">
                  Regenerating title
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
              {/* Always the branch. The plan step used to take this slot while
                  working, but it truncated to a half-sentence and dropped the
                  branch, so the row lost its most stable identifier. */}
              {thread.branch ? (
                <>
                  <ThreadWorktreeIndicator thread={thread} />
                  <span className="min-w-0 flex-1 truncate whitespace-nowrap">{thread.branch}</span>
                </>
              ) : (
                <span className="flex-1" />
              )}
              {terminalStatusIcon}
              {prBadge}
              {diff ? (
                <span className="shrink-0 font-mono">
                  <span className="text-emerald-600 dark:text-emerald-400">+{diff.insertions}</span>{" "}
                  <span className="text-red-600 dark:text-red-400">−{diff.deletions}</span>
                </span>
              ) : null}
              <span
                aria-hidden
                className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1"
              >
                {isRemote ? (
                  <span className="inline-flex shrink-0 items-center text-sidebar-muted-foreground/70">
                    <ServerIcon aria-hidden className="size-3.5" />
                  </span>
                ) : null}
                {driverKind ? (
                  <span className="inline-flex shrink-0 items-center">
                    <ProviderInstanceIcon
                      driverKind={driverKind}
                      displayName={
                        providerEntry?.displayName ??
                        thread.session?.providerName ??
                        modelInstanceId
                      }
                      accentColor={providerEntry?.accentColor}
                      showBadge={showInstanceBadge}
                      // Glyph dims, badge stays saturated; offset matches the composer trigger.
                      iconClassName="size-3.5 opacity-60"
                      badgeClassName="right-[-0.1875rem] bottom-[-0.1875rem] h-3 min-w-3 px-0.5 text-[7px]"
                    />
                  </span>
                ) : null}
              </span>
            </div>
          </div>
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

type SidebarThreadDragPhase = "dragging" | "awaiting-snooze-choice" | "committing" | "reconciling";

type SidebarThreadDragTransaction = {
  readonly phase: SidebarThreadDragPhase;
  readonly sourceThread: EnvironmentThreadShell;
  readonly sourceThreadKey: string;
  readonly sourceSection: SidebarDndSection;
  readonly sourceIndex: number;
  readonly sourceRect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly pointerAnchor: SidebarDndPointerAnchor;
  readonly targetSection: SidebarDndSection | null;
  readonly targetThreadKey: string | null;
  readonly targetEdge: "before" | "after" | null;
  readonly destinationSection: SidebarDndSection | null;
  readonly pinnedOrder: readonly string[] | null;
  readonly snoozedUntil: string | null;
  readonly receiptSequencesByEnvironment: ReadonlyMap<
    EnvironmentThreadShell["environmentId"],
    number
  > | null;
  readonly viewportRailTopBySection: ReadonlyMap<SidebarDndSection, number> | null;
};

type SidebarPinnedInsertionPlan = {
  readonly order: readonly string[];
  readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
  readonly threadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
};

interface SidebarThreadDropTarget {
  readonly targetSection: SidebarDndSection;
  readonly targetThreadKey: string | null;
  readonly targetEdge: "before" | "after" | null;
}

type SidebarLayoutCorrection =
  | { readonly kind: "stable" }
  | { readonly kind: "corrected" }
  | {
      readonly kind: "clamped";
      readonly edge: "start" | "end";
      readonly missingScrollRange: number;
    };

interface SidebarScrollRangeHold {
  readonly node: HTMLUListElement;
  readonly originalMinHeight: string;
  readonly originalPaddingTop: string;
  readonly originalPaddingBottom: string;
  readonly height: number;
  readonly topInset: number;
  readonly bottomInset: number;
}

type SidebarAutoAnimateController = ReturnType<typeof autoAnimate> & {
  readonly destroy?: () => void;
};

function sidebarThreadKey(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function sidebarDndSectionIndex(
  section: SidebarDndSection,
  threadKey: string,
  sections: Readonly<Record<SidebarDndSection, readonly EnvironmentThreadShell[]>>,
): number {
  const index = sections[section].findIndex((thread) => sidebarThreadKey(thread) === threadKey);
  return Math.max(0, index);
}

function insertSidebarThreadAt(
  threads: readonly EnvironmentThreadShell[],
  thread: EnvironmentThreadShell,
  index: number,
): EnvironmentThreadShell[] {
  const next = [...threads];
  next.splice(Math.min(Math.max(0, index), next.length), 0, thread);
  return next;
}

function movePinnedThreadAtEdge(input: {
  keys: readonly string[];
  activeKey: string;
  overKey: string;
  edge: "before" | "after";
}): string[] | null {
  if (!input.keys.includes(input.activeKey)) return null;
  if (input.activeKey === input.overKey) return [...input.keys];

  const next = input.keys.filter((key) => key !== input.activeKey);
  const overIndex = next.indexOf(input.overKey);
  if (overIndex === -1) return null;
  const insertionIndex = overIndex + (input.edge === "after" ? 1 : 0);
  next.splice(insertionIndex, 0, input.activeKey);
  return next;
}

function SidebarThreadDragOverlayContent(props: {
  transaction: SidebarThreadDragTransaction;
  variant: SidebarDndPreviewVariant;
  projectTitle: string | null;
  projectCwd: string | null;
  projectFaviconPath: string | null;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<Animation | null>(null);
  const geometryRef = useRef<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const previewHeight = props.variant === "card" ? 82 : 36;
  const previewWidth = props.transaction.sourceRect.width;
  const left =
    props.transaction.pointerAnchor.x * props.transaction.sourceRect.width -
    props.transaction.pointerAnchor.x * previewWidth;
  const top =
    props.transaction.pointerAnchor.y * props.transaction.sourceRect.height -
    props.transaction.pointerAnchor.y * previewHeight;

  useLayoutEffect(() => {
    const node = innerRef.current;
    if (node === null) return;
    const nextGeometry = { width: previewWidth, height: previewHeight };
    const previousGeometry = geometryRef.current;
    geometryRef.current = nextGeometry;
    if (previousGeometry === null) {
      return;
    }
    const interruptedRect =
      animationRef.current?.playState === "running" ? node.getBoundingClientRect() : null;
    animationRef.current?.cancel();
    const settledRect = node.getBoundingClientRect();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const fromWidth = interruptedRect?.width ?? previousGeometry.width;
    const fromHeight = interruptedRect?.height ?? previousGeometry.height;
    const scaleX = settledRect.width > 0 ? fromWidth / settledRect.width : 1;
    const scaleY = settledRect.height > 0 ? fromHeight / settledRect.height : 1;
    const settledAnchorX = settledRect.left + props.transaction.pointerAnchor.x * settledRect.width;
    const settledAnchorY = settledRect.top + props.transaction.pointerAnchor.y * settledRect.height;
    const translateX =
      interruptedRect === null
        ? 0
        : interruptedRect.left +
          props.transaction.pointerAnchor.x * interruptedRect.width -
          settledAnchorX;
    const translateY =
      interruptedRect === null
        ? 0
        : interruptedRect.top +
          props.transaction.pointerAnchor.y * interruptedRect.height -
          settledAnchorY;
    animationRef.current = node.animate(
      [
        {
          transform: `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`,
          opacity: 0.88,
        },
        { transform: "translate(0, 0) scale(1, 1)", opacity: 1 },
      ],
      { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "both" },
    );
  }, [left, previewHeight, previewWidth, props.variant]);
  useEffect(() => () => animationRef.current?.cancel(), []);

  return (
    <div
      aria-hidden
      className="relative"
      style={{
        width: props.transaction.sourceRect.width,
        height: props.transaction.sourceRect.height,
      }}
    >
      <div
        ref={innerRef}
        className="absolute"
        style={{
          left,
          top,
          width: previewWidth,
          height: previewHeight,
          transformOrigin: `${props.transaction.pointerAnchor.x * 100}% ${props.transaction.pointerAnchor.y * 100}%`,
          willChange: "transform, opacity",
        }}
      >
        <SidebarThreadDragPreview
          thread={props.transaction.sourceThread}
          variant={props.variant}
          projectTitle={props.projectTitle}
          projectCwd={props.projectCwd}
          projectFaviconPath={props.projectFaviconPath}
        />
      </div>
    </div>
  );
}

const SidebarSearchResultRow = memo(function SidebarSearchResultRow(props: {
  thread: SidebarThreadSummary;
  projectCwd: string | null;
  projectFaviconPath: string | null;
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
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
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
            faviconPath={props.projectFaviconPath}
            className="size-4 shrink-0"
            fallbackIcon={MessageSquareIcon}
          />
          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground/55 tabular-nums">
            {threadTimeLabel(thread)}
          </span>
        </TooltipTrigger>
        <SidebarThreadTooltip
          thread={thread}
          projectTitle={props.projectTitle}
          projectCwd={props.projectCwd}
          projectFaviconPath={props.projectFaviconPath}
          environmentLabel={props.environmentLabel}
          providerEntry={providerEntry}
          showInstanceBadge={showInstanceBadge}
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

export default function Sidebar() {
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const threads = useThreadShells();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const autoSettleAfterDays = useClientSettings((s) => s.sidebarAutoSettleAfterDays);
  const autoSettleOnMerge = useClientSettings((s) => s.sidebarAutoSettleOnMerge);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    reorderPinnedThread,
    archiveThread,
    deleteThread,
  } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
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
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: threadId,
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
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  // Threads on non-primary environments (T3 Connect, hosted) resolve their
  // provider entry from their own environment's config: default instance ids
  // are driver slugs, so a flat map would collide across environments.
  const providerEntriesByEnvironment = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([environmentId, config]) => [environmentId, config.providers] as const,
        ),
      ),
    [serverConfigs],
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
  const projectFaviconPathByKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [`${project.environmentId}:${project.id}`, project.faviconPath]),
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

  const changeRequestSnapshotByKey = useAtomValue(threadChangeRequestSnapshotsAtom);

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
  // Count-only subscription: the parent needs "are there draft rows" for the
  // empty state, while SidebarDraftBlock owns the per-keystroke content
  // subscription. Selecting a number keeps typing in a draft composer from
  // re-rendering the whole sidebar. Approximates the block's row filter
  // (every non-promoted session with content); it can overcount by one for
  // an open never-left draft, which only softens the empty state.
  const routeDraftIdForRows = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const visibleDraftSessionCount = useComposerDraftStore((store) => {
    let count = 0;
    for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (!composerDraftHasUserContent(store.draftsByThreadKey[draftKey])) {
        continue;
      }
      if (
        scopedProjectKeys !== null &&
        !scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
      ) {
        continue;
      }
      count += 1;
    }
    return count;
  });
  // Scope flips drop the selection: rows selected under the old scope may be
  // hidden now, and bulk actions must never count or touch invisible rows.
  useEffect(() => {
    clearSelection();
  }, [clearSelection, projectScopeKey]);

  const handleProjectSettings = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, projectGroup: SidebarProjectSnapshot) => {
      event.preventDefault();
      event.stopPropagation();
      setProjectScopeMenuOpen(false);
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/projects/$projectKey",
        params: { projectKey: projectGroup.projectKey },
      });
    },
    [isMobile, router, setOpenMobile],
  );

  // Settled threads stay in the live shell stream (settled ≠ archived), so
  // the partition works directly off live shells: no archived-snapshot
  // merging, no optimistic holds. Archived threads remain hidden here —
  // archive keeps its original "remove from sidebar" meaning.
  const {
    pinnedThreads,
    reorderablePinnedKeys,
    activeThreads,
    snoozedThreads,
    settledThreads,
    snoozeNow,
  } = useMemo(() => {
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
        serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement === true;
      const supportsSnooze =
        serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true;
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const snapshot = changeRequestSnapshotByKey.get(threadKey);
      const changeRequest =
        snapshot != null && (thread.worktreePath === null || snapshot.branch === thread.branch)
          ? snapshot.pr
          : null;
      // User lifecycle commands keep these categories exclusive. Snooze is
      // checked first so a transient stale projection still honors "hide
      // until Tuesday" instead of flashing the thread in another section.
      if (supportsSnooze && effectiveSnoozed(thread, { now: preciseNow })) {
        snoozed.push(thread);
      } else if (thread.pinnedAt != null) {
        pinned.push(thread);
      } else if (
        supportsSettlement &&
        effectiveSettled(thread, {
          now,
          autoSettleAfterDays,
          autoSettleOnMerge,
          changeRequest,
        })
      ) {
        settled.push(thread);
      } else if (thread.pinnedAt != null) {
        pinned.push(thread);
      } else {
        active.push(thread);
      }
    }
    // One shared rule on every platform (see sortPinnedThreadsByOrderKey):
    // user-arranged keys first, keyless threads in creation order below.
    // Server capability only gates DRAGGING — it must not influence the
    // sort, or mixed-version fleets would render different pinned orders on
    // web and mobile from the same data.
    return {
      pinnedThreads: sortPinnedThreadsForSidebar(pinned),
      reorderablePinnedKeys: new Set(
        pinned
          .filter(
            (thread) =>
              serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinReorder ===
              true,
          )
          .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
      ),
      activeThreads: sortThreadsForSidebar(active),
      // Soonest wake first: "what comes back next" is the shelf's question.
      snoozedThreads: snoozed.toSorted(
        (left, right) =>
          firstValidTimestampMs(left.snoozedUntil ?? null) -
          firstValidTimestampMs(right.snoozedUntil ?? null),
      ),
      settledThreads: sortSettledThreadsForSidebar(settled),
      snoozeNow: preciseNow,
    };
  }, [
    autoSettleAfterDays,
    autoSettleOnMerge,
    changeRequestSnapshotByKey,
    nowMinute,
    scopedProjectKeys,
    serverConfigs,
    snoozeWakeTick,
    threads,
  ]);

  const canonicalSectionByThreadKey = useMemo(() => {
    const sections = new Map<string, SidebarDndSection>();
    for (const thread of pinnedThreads) sections.set(sidebarThreadKey(thread), "pinned");
    for (const thread of activeThreads) sections.set(sidebarThreadKey(thread), "regular");
    for (const thread of snoozedThreads) sections.set(sidebarThreadKey(thread), "snoozed");
    for (const thread of settledThreads) sections.set(sidebarThreadKey(thread), "settled");
    return sections;
  }, [activeThreads, pinnedThreads, settledThreads, snoozedThreads]);
  const allThreadByKey = useMemo(
    () => new Map(threads.map((thread) => [sidebarThreadKey(thread), thread] as const)),
    [threads],
  );
  // Pinned placement is global even when the sidebar is project-scoped. A
  // visible boundary therefore keeps hidden pinned neighbors in its order
  // calculation instead of moving them as a side effect of filtering.
  const allPinnedThreads = useMemo(
    () =>
      sortPinnedThreadsForSidebar(
        threads.filter((thread) => thread.archivedAt === null && thread.pinnedAt != null),
      ),
    [threads],
  );
  const allThreadByKeyRef = useRef(allThreadByKey);
  allThreadByKeyRef.current = allThreadByKey;
  const canonicalSectionByThreadKeyRef = useRef(canonicalSectionByThreadKey);
  canonicalSectionByThreadKeyRef.current = canonicalSectionByThreadKey;

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
  const [settledShelfExpanded, setSettledShelfExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const toggleSettledShelf = useCallback(
    () => setSettledShelfExpanded((value) => !value),
    [setSettledShelfExpanded],
  );
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
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useLocalStorage(
    SNOOZED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleSnoozedShelf = useCallback(
    () => setSnoozedShelfExpanded((value) => !value),
    [setSnoozedShelfExpanded],
  );
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

  const orderedThreads = useMemo(
    () => [...pinnedThreads, ...activeThreads, ...visibleSnoozedThreads, ...renderedSettledThreads],
    [pinnedThreads, activeThreads, visibleSnoozedThreads, renderedSettledThreads],
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

  const navigateToDraft = useCallback(
    (draftId: DraftId) => {
      // Unconditional: also drops a stale selection anchor left by
      // plain-click navigation, so a later shift-click starts fresh
      // instead of ranging from a row that is no longer the context.
      // (clearSelection no-ops when there is nothing to clear.)
      clearSelection();
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({ to: "/draft/$draftId", params: { draftId } });
    },
    [clearSelection, isMobile, router, setOpenMobile],
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
      if (isSidebarNestedLinkClick(event.target)) return;
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
  // Drag-to-reorder for the pinned block. A drop computes ONE fractional key
  // for the moved thread and sends it to that thread's own server (see
  // planPinnedReorder for the keyless-neighbor materialization case, which
  // instead rewrites every key in the section). The optimistic order keeps
  // the card where it was dropped until EVERY key the drop wrote is
  // reflected in canonical state — a section rewrite is several sequential
  // writes, and releasing on the first landed key would expose the
  // half-written canonical order, reshuffling the block once per write.
  // A failed write clears the override (the card snaps back) with a toast.
  // A key we did NOT write landing (a concurrent client's reorder that must
  // win) and ANY membership change (new pin, unpin, snooze/wake) also
  // release it: the override can't say where members it never saw belong,
  // and holding it would launder a stale order into later drags.
  const threadDndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const [dragTransaction, setDragTransactionState] = useState<SidebarThreadDragTransaction | null>(
    null,
  );
  const dragTransactionRef = useRef<SidebarThreadDragTransaction | null>(null);
  const setDragTransaction = useCallback(
    (
      next:
        | SidebarThreadDragTransaction
        | null
        | ((current: SidebarThreadDragTransaction | null) => SidebarThreadDragTransaction | null),
    ) => {
      const resolved = typeof next === "function" ? next(dragTransactionRef.current) : next;
      dragTransactionRef.current = resolved;
      setDragTransactionState(resolved);
    },
    [],
  );
  const sidebarViewportRef = useRef<HTMLDivElement>(null);
  const sidebarViewportOverlayRef = useRef<HTMLDivElement>(null);
  const viewportRailSectionsRef = useRef(new Set<SidebarDndSection>());
  const threadListNodeRef = useRef<HTMLUListElement | null>(null);
  const sidebarScrollRangeHoldRef = useRef<SidebarScrollRangeHold | null>(null);
  const threadRowNodesRef = useRef(new Map<string, HTMLElement>());
  const autoAnimateControllerRef = useRef<SidebarAutoAnimateController | null>(null);
  const autoAnimatePausedRef = useRef(false);
  const viewportOverflowAnchorRef = useRef("");
  const correctedScrollTopRef = useRef<number | null>(null);
  const retainedLayoutAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const rawPointerRef = useRef<{ x: number; y: number } | null>(null);
  const releasePointerRef = useRef<{ x: number; y: number } | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const pointerListenerCleanupRef = useRef<(() => void) | null>(null);
  const pinnedReorderInFlightRef = useRef(false);
  const snoozeDropEpochRef = useRef(0);
  const handleViewportRailNodeChange = useCallback(
    (section: SidebarDndSection, node: HTMLElement | null) => {
      if (node === null) {
        viewportRailSectionsRef.current.delete(section);
        return;
      }
      viewportRailSectionsRef.current.add(section);
    },
    [],
  );
  const handleThreadRowNodeChange = useCallback((threadKey: string, node: HTMLElement | null) => {
    if (node === null) {
      threadRowNodesRef.current.delete(threadKey);
      return;
    }
    threadRowNodesRef.current.set(threadKey, node);
  }, []);
  const pauseSidebarLayoutMotion = useCallback(() => {
    if (autoAnimatePausedRef.current) return;
    autoAnimatePausedRef.current = true;
    autoAnimateControllerRef.current?.disable();
    const viewport = sidebarViewportRef.current;
    if (viewport === null) return;
    viewportOverflowAnchorRef.current = viewport.style.overflowAnchor;
    viewport.style.overflowAnchor = "none";
  }, []);
  const chooseSidebarLayoutAnchor = useCallback(
    (preferred: HTMLElement | null, excludedThreadKey: string | null = null) => {
      const viewport = sidebarViewportRef.current;
      if (viewport === null) return null;
      const canAnchor = (element: HTMLElement) => {
        if (!element.isConnected || element.dataset.dndTransformed === "true") return false;
        const rect = element.getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom;
      };
      if (preferred !== null && canAnchor(preferred)) return preferred;
      for (const [threadKey, element] of threadRowNodesRef.current) {
        if (threadKey === excludedThreadKey) continue;
        if (canAnchor(element)) return element;
      }
      return null;
    },
    [],
  );
  const retainSidebarLayoutAnchor = useCallback(
    (preferred: HTMLElement | null = null, excludedThreadKey: string | null = null) => {
      const anchor = chooseSidebarLayoutAnchor(preferred, excludedThreadKey);
      retainedLayoutAnchorRef.current =
        anchor === null ? null : { element: anchor, top: anchor.getBoundingClientRect().top };
    },
    [chooseSidebarLayoutAnchor],
  );
  const correctSidebarLayoutAnchor = useCallback((): SidebarLayoutCorrection => {
    const viewport = sidebarViewportRef.current;
    const retained = retainedLayoutAnchorRef.current;
    if (
      viewport === null ||
      retained === null ||
      !retained.element.isConnected ||
      retained.element.dataset.dndTransformed === "true"
    ) {
      retainSidebarLayoutAnchor();
      return { kind: "stable" };
    }
    const nextTop = retained.element.getBoundingClientRect().top;
    const delta = nextTop - retained.top;
    if (Math.abs(delta) > 0.5) {
      const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const previousScrollTop = viewport.scrollTop;
      const requestedScrollTop = previousScrollTop + delta;
      const nextScrollTop = Math.min(maxScrollTop, Math.max(0, requestedScrollTop));
      viewport.scrollTop = nextScrollTop;
      const appliedScrollTop = viewport.scrollTop;
      if (Math.abs(appliedScrollTop - previousScrollTop) > 0.5) {
        correctedScrollTopRef.current = appliedScrollTop;
      }
      if (Math.abs(appliedScrollTop - requestedScrollTop) > 0.5) {
        return {
          kind: "clamped",
          edge: requestedScrollTop < 0 ? "start" : "end",
          missingScrollRange: Math.abs(appliedScrollTop - requestedScrollTop),
        };
      }
    }
    retainedLayoutAnchorRef.current = {
      element: retained.element,
      top: retained.element.getBoundingClientRect().top,
    };
    return { kind: Math.abs(delta) > 0.5 ? "corrected" : "stable" };
  }, [retainSidebarLayoutAnchor]);
  const clearSidebarScrollRangeHold = useCallback(() => {
    const hold = sidebarScrollRangeHoldRef.current;
    if (hold === null) return;
    hold.node.style.minHeight = hold.originalMinHeight;
    hold.node.style.paddingTop = hold.originalPaddingTop;
    hold.node.style.paddingBottom = hold.originalPaddingBottom;
    sidebarScrollRangeHoldRef.current = null;
  }, []);
  const holdSidebarScrollRange = useCallback(() => {
    const node = threadListNodeRef.current;
    if (node === null) return;
    const current = sidebarScrollRangeHoldRef.current;
    if (current !== null && current.node !== node) {
      current.node.style.minHeight = current.originalMinHeight;
      current.node.style.paddingTop = current.originalPaddingTop;
      current.node.style.paddingBottom = current.originalPaddingBottom;
      sidebarScrollRangeHoldRef.current = null;
    }
    const activeHold = sidebarScrollRangeHoldRef.current;
    const height = Math.max(activeHold?.height ?? 0, node.getBoundingClientRect().height);
    const next = {
      node,
      originalMinHeight: activeHold?.originalMinHeight ?? node.style.minHeight,
      originalPaddingTop: activeHold?.originalPaddingTop ?? node.style.paddingTop,
      originalPaddingBottom: activeHold?.originalPaddingBottom ?? node.style.paddingBottom,
      height,
      topInset: activeHold?.topInset ?? 0,
      bottomInset: activeHold?.bottomInset ?? 0,
    } satisfies SidebarScrollRangeHold;
    sidebarScrollRangeHoldRef.current = next;
    node.style.minHeight = `${height}px`;
    node.style.paddingTop =
      next.topInset === 0
        ? next.originalPaddingTop
        : `calc(${next.originalPaddingTop || "0px"} + ${next.topInset}px)`;
    node.style.paddingBottom =
      next.bottomInset === 0
        ? next.originalPaddingBottom
        : `calc(${next.originalPaddingBottom || "0px"} + ${next.bottomInset}px)`;
  }, []);
  const extendSidebarScrollRange = useCallback(
    (edge: "start" | "end", missingScrollRange: number) => {
      const hold = sidebarScrollRangeHoldRef.current;
      if (hold === null || missingScrollRange <= 0.5) return false;
      const next = {
        ...hold,
        height: hold.height + missingScrollRange,
        topInset: hold.topInset + (edge === "start" ? missingScrollRange : 0),
        bottomInset: hold.bottomInset + (edge === "end" ? missingScrollRange : 0),
      } satisfies SidebarScrollRangeHold;
      sidebarScrollRangeHoldRef.current = next;
      next.node.style.minHeight = `${next.height}px`;
      next.node.style.paddingTop =
        next.topInset === 0
          ? next.originalPaddingTop
          : `calc(${next.originalPaddingTop || "0px"} + ${next.topInset}px)`;
      next.node.style.paddingBottom =
        next.bottomInset === 0
          ? next.originalPaddingBottom
          : `calc(${next.originalPaddingBottom || "0px"} + ${next.bottomInset}px)`;
      return true;
    },
    [],
  );
  const releaseSidebarScrollRangeIfSafe = useCallback(() => {
    const hold = sidebarScrollRangeHoldRef.current;
    if (hold === null) return true;
    const viewport = sidebarViewportRef.current;
    if (viewport === null || !hold.node.isConnected) {
      clearSidebarScrollRangeHold();
      return true;
    }

    const anchor = chooseSidebarLayoutAnchor(null);
    const previousAnchorTop = anchor?.getBoundingClientRect().top ?? null;
    const previousScrollTop = viewport.scrollTop;

    const previousOverflowAnchor = viewport.style.overflowAnchor;
    viewport.style.overflowAnchor = "none";
    try {
      if (hold.topInset > 0.5) {
        viewport.scrollTop = Math.max(0, previousScrollTop - hold.topInset);
      }
      hold.node.style.minHeight = hold.originalMinHeight;
      hold.node.style.paddingTop = hold.originalPaddingTop;
      hold.node.style.paddingBottom = hold.originalPaddingBottom;
      const naturalMaxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const anchorDelta =
        anchor === null || previousAnchorTop === null
          ? 0
          : anchor.getBoundingClientRect().top - previousAnchorTop;
      const requestedScrollTop = viewport.scrollTop + anchorDelta;
      const outsideNaturalRange =
        requestedScrollTop < -0.5 || requestedScrollTop > naturalMaxScrollTop + 0.5;
      const temporaryInsetReachedNaturalBoundary =
        (requestedScrollTop < -0.5 && hold.topInset > 0.5) ||
        (requestedScrollTop > naturalMaxScrollTop + 0.5 && hold.bottomInset > 0.5);
      if (outsideNaturalRange && !temporaryInsetReachedNaturalBoundary) {
        hold.node.style.minHeight = `${hold.height}px`;
        hold.node.style.paddingTop =
          hold.topInset === 0
            ? hold.originalPaddingTop
            : `calc(${hold.originalPaddingTop || "0px"} + ${hold.topInset}px)`;
        hold.node.style.paddingBottom =
          hold.bottomInset === 0
            ? hold.originalPaddingBottom
            : `calc(${hold.originalPaddingBottom || "0px"} + ${hold.bottomInset}px)`;
        viewport.scrollTop = previousScrollTop;
        return false;
      }
      viewport.scrollTop = Math.min(naturalMaxScrollTop, Math.max(0, requestedScrollTop));
      correctedScrollTopRef.current = viewport.scrollTop;
      sidebarScrollRangeHoldRef.current = null;
      return true;
    } finally {
      viewport.style.overflowAnchor = previousOverflowAnchor;
    }
  }, [chooseSidebarLayoutAnchor, clearSidebarScrollRangeHold]);
  const cleanupTrackedPointer = useCallback(() => {
    pointerListenerCleanupRef.current?.();
    pointerListenerCleanupRef.current = null;
    activePointerIdRef.current = null;
    rawPointerRef.current = null;
    releasePointerRef.current = null;
  }, []);
  const canDropThreadInSection = useCallback(
    (thread: EnvironmentThreadShell, source: SidebarDndSection, destination: SidebarDndSection) => {
      const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
      const action = resolveSidebarDndAction({ source, destination });
      switch (action) {
        case "noop":
          return true;
        case "reorder-pinned":
          return capabilities?.threadPinReorder === true;
        case "pin":
          // Exact placement needs both the category command and an order key.
          return capabilities?.threadPinning === true && capabilities.threadPinReorder === true;
        case "unpin":
          return capabilities?.threadPinning === true;
        case "unsettle":
          return capabilities?.threadSettlement === true;
        case "unsnooze":
          return capabilities?.threadSnooze === true;
        case "settle":
          return (
            capabilities?.threadSettlement === true &&
            canSettle(thread, { now: new Date().toISOString() })
          );
        case "snooze":
          return (
            capabilities?.threadSnooze === true &&
            canSnooze(thread, { now: new Date().toISOString() })
          );
      }
    },
    [serverConfigs],
  );
  const canDragThread = useCallback(
    (thread: EnvironmentThreadShell, source: SidebarDndSection) =>
      SIDEBAR_DND_SECTION_ORDER.some((destination) => {
        const action = resolveSidebarDndAction({ source, destination });
        return action !== "noop" && canDropThreadInSection(thread, source, destination);
      }),
    [canDropThreadInSection],
  );
  const moveClampedEmptyRailsToViewport = useCallback(
    (transaction: SidebarThreadDragTransaction) => {
      if (transaction.phase !== "dragging" || transaction.viewportRailTopBySection !== null) {
        return false;
      }
      const sourceOrderIndex = SIDEBAR_DND_SECTION_ORDER.indexOf(transaction.sourceSection);
      const sections = [
        { section: "pinned", threads: pinnedThreads },
        { section: "regular", threads: activeThreads },
        { section: "snoozed", threads: snoozedThreads },
        { section: "settled", threads: settledThreads },
      ] satisfies ReadonlyArray<{
        readonly section: SidebarDndSection;
        readonly threads: readonly EnvironmentThreadShell[];
      }>;
      const overlaySections = sections
        .slice(0, sourceOrderIndex)
        .filter(
          ({ section, threads }) =>
            threads.length === 0 &&
            canDropThreadInSection(transaction.sourceThread, transaction.sourceSection, section),
        )
        .map(({ section }) => section);
      if (overlaySections.length === 0) return false;
      setDragTransaction((current) => {
        if (
          current === null ||
          current.sourceThreadKey !== transaction.sourceThreadKey ||
          current.viewportRailTopBySection !== null
        ) {
          return current;
        }
        return {
          ...current,
          viewportRailTopBySection: new Map(
            overlaySections.map((section, index) => [
              section,
              index * SIDEBAR_DND_EMPTY_RAIL_HEIGHT,
            ]),
          ),
        };
      });
      return true;
    },
    [
      activeThreads,
      canDropThreadInSection,
      pinnedThreads,
      setDragTransaction,
      settledThreads,
      snoozedThreads,
    ],
  );
  const correctSidebarDragLayout = useCallback(
    (transaction: SidebarThreadDragTransaction) => {
      const correction = correctSidebarLayoutAnchor();
      if (correction.kind !== "clamped") return;
      if (correction.edge === "end" && moveClampedEmptyRailsToViewport(transaction)) return;
      if (!extendSidebarScrollRange(correction.edge, correction.missingScrollRange)) {
        retainSidebarLayoutAnchor();
        return;
      }
      if (correctSidebarLayoutAnchor().kind === "clamped") {
        retainSidebarLayoutAnchor();
      }
    },
    [
      correctSidebarLayoutAnchor,
      extendSidebarScrollRange,
      moveClampedEmptyRailsToViewport,
      retainSidebarLayoutAnchor,
    ],
  );
  useLayoutEffect(() => {
    if (dragTransaction !== null) {
      holdSidebarScrollRange();
      correctSidebarDragLayout(dragTransaction);
      return;
    }
    if (pinnedReorderInFlightRef.current) return;
    if (!autoAnimatePausedRef.current) {
      releaseSidebarScrollRangeIfSafe();
      return;
    }
    correctSidebarLayoutAnchor();
    autoAnimatePausedRef.current = false;
    const viewport = sidebarViewportRef.current;
    if (viewport !== null) {
      viewport.style.overflowAnchor = viewportOverflowAnchorRef.current;
    }
    autoAnimateControllerRef.current?.enable();
    retainedLayoutAnchorRef.current = null;
    releaseSidebarScrollRangeIfSafe();
  });
  useEffect(() => {
    if (dragTransaction === null) return;
    const viewport = sidebarViewportRef.current;
    if (viewport === null) return;
    const handleScroll = () => {
      const correctedScrollTop = correctedScrollTopRef.current;
      if (correctedScrollTop !== null && Math.abs(viewport.scrollTop - correctedScrollTop) <= 0.5) {
        return;
      }
      correctedScrollTopRef.current = null;
      const retained = retainedLayoutAnchorRef.current;
      if (retained === null || !retained.element.isConnected) {
        retainSidebarLayoutAnchor();
        return;
      }
      retainedLayoutAnchorRef.current = {
        element: retained.element,
        top: retained.element.getBoundingClientRect().top,
      };
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [dragTransaction, retainSidebarLayoutAnchor]);
  useEffect(() => {
    if (dragTransaction !== null || sidebarScrollRangeHoldRef.current === null) return;
    const viewport = sidebarViewportRef.current;
    if (viewport === null) return;
    const handleScroll = () => {
      if (releaseSidebarScrollRangeIfSafe()) {
        viewport.removeEventListener("scroll", handleScroll);
      }
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [dragTransaction, releaseSidebarScrollRangeIfSafe]);
  useEffect(() => {
    if (dragTransaction === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const transaction = dragTransactionRef.current;
      if (transaction !== null) {
        holdSidebarScrollRange();
        correctSidebarDragLayout(transaction);
      }
    });
    if (sidebarViewportRef.current !== null) observer.observe(sidebarViewportRef.current);
    if (threadListNodeRef.current !== null) observer.observe(threadListNodeRef.current);
    return () => observer.disconnect();
  }, [correctSidebarDragLayout, dragTransaction, holdSidebarScrollRange]);
  useEffect(
    () => () => {
      cleanupTrackedPointer();
      clearSidebarScrollRangeHold();
      autoAnimateControllerRef.current?.destroy?.();
    },
    [cleanupTrackedPointer, clearSidebarScrollRangeHold],
  );
  const [optimisticPinnedOrder, setOptimisticPinnedOrder] = useState<{
    readonly order: readonly string[];
    /** pinOrderKey per thread as of the drop — the baseline that tells a
        concurrent client's write apart from one of our own landing. */
    readonly keysAtDrop: ReadonlyMap<string, string | null>;
    /** The keys this drop writes (one per planned assignment). The
        override holds until all of them appear in canonical state. */
    readonly assignedKeys: ReadonlyMap<string, string>;
  } | null>(null);
  const orderedPinnedThreads = useMemo(() => {
    if (optimisticPinnedOrder === null) return pinnedThreads;
    return orderItemsByPreferredIds({
      items: pinnedThreads,
      preferredIds: optimisticPinnedOrder.order,
      getId: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    });
  }, [optimisticPinnedOrder, pinnedThreads]);
  const pinnedSortingOverIndex = useMemo(() => {
    const transaction = dragTransaction;
    if (
      transaction === null ||
      transaction.phase !== "dragging" ||
      transaction.sourceSection !== "pinned" ||
      transaction.targetSection !== "pinned" ||
      transaction.targetThreadKey === null ||
      transaction.targetEdge === null
    ) {
      return null;
    }
    const keys = orderedPinnedThreads
      .map(sidebarThreadKey)
      .filter((threadKey) => reorderablePinnedKeys.has(threadKey));
    const previewOrder = movePinnedThreadAtEdge({
      keys,
      activeKey: transaction.sourceThreadKey,
      overKey: transaction.targetThreadKey,
      edge: transaction.targetEdge,
    });
    return previewOrder?.indexOf(transaction.sourceThreadKey) ?? null;
  }, [dragTransaction, orderedPinnedThreads, reorderablePinnedKeys]);
  const pinnedSortingStrategy = useCallback<SortingStrategy>(
    (args) =>
      verticalListSortingStrategy({
        ...args,
        overIndex: pinnedSortingOverIndex ?? args.overIndex,
      }),
    [pinnedSortingOverIndex],
  );
  useEffect(() => {
    if (optimisticPinnedOrder === null) return;
    const canonical = pinnedThreads.filter((thread) =>
      reorderablePinnedKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
    );
    const canonicalKeys = canonical.map((thread) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    );
    // The override represents one drop against one snapshot of the world.
    // Release it when the world moves on: membership changed (pin/unpin/
    // snooze/wake — the override can't say where members it never saw
    // belong), a key changed to something we did NOT write (a concurrent
    // client's reorder that must win), every key we wrote has landed, or
    // canonical already matches. Releasing on the FIRST landed key instead
    // of the last exposes the half-written order mid-materialization and
    // the block visibly reshuffles once per write.
    const membershipChanged =
      canonicalKeys.length !== optimisticPinnedOrder.order.length ||
      canonicalKeys.some((key) => !optimisticPinnedOrder.order.includes(key));
    const foreignKeyLanded = canonical.some((thread, index) => {
      const threadKey = canonicalKeys[index]!;
      const currentKey = thread.pinOrderKey ?? null;
      if (currentKey === optimisticPinnedOrder.keysAtDrop.get(threadKey)) return false;
      return currentKey !== optimisticPinnedOrder.assignedKeys.get(threadKey);
    });
    const currentKeyByThreadKey = new Map(
      canonical.map((thread, index) => [canonicalKeys[index]!, thread.pinOrderKey ?? null]),
    );
    const allAssignmentsLanded = [...optimisticPinnedOrder.assignedKeys].every(
      ([threadKey, orderKey]) => currentKeyByThreadKey.get(threadKey) === orderKey,
    );
    const orderConfirmed =
      !membershipChanged &&
      canonicalKeys.every((key, index) => key === optimisticPinnedOrder.order[index]);
    if (membershipChanged || foreignKeyLanded || allAssignmentsLanded || orderConfirmed) {
      pinnedReorderInFlightRef.current = false;
      setOptimisticPinnedOrder(null);
    }
  }, [optimisticPinnedOrder, pinnedThreads, reorderablePinnedKeys]);
  const attemptPin = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        // Fresh pins take the top of the arranged run: pinThread computes a
        // key before the smallest key across all pinned shells, so the new
        // pin lands at the head of the global arranged run.
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

  const handlePinnedReorder = useCallback(
    (activeKey: string, overKey: string | null, targetEdge: "before" | "after" | null) => {
      if (
        pinnedReorderInFlightRef.current ||
        overKey === null ||
        targetEdge === null ||
        activeKey === overKey
      ) {
        return;
      }
      const reorderable = orderedPinnedThreads.filter((thread) =>
        reorderablePinnedKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
      );
      const keys = reorderable.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      );
      const newOrder = movePinnedThreadAtEdge({
        keys,
        activeKey,
        overKey,
        edge: targetEdge,
      });
      if (newOrder === null) return;
      if (newOrder.every((key, index) => key === keys[index])) return;
      const threadByKey = new Map(reorderable.map((thread, index) => [keys[index]!, thread]));
      const keysAtDrop = new Map(
        reorderable.map((thread, index) => [keys[index]!, thread.pinOrderKey ?? null]),
      );
      const assignments = planPinnedReorder({
        orderedIds: newOrder,
        keysById: keysAtDrop,
        movedId: activeKey,
      });
      if (assignments.length === 0) return;
      pinnedReorderInFlightRef.current = true;
      setOptimisticPinnedOrder({
        order: newOrder,
        keysAtDrop,
        assignedKeys: new Map(
          assignments.map((assignment) => [assignment.id, assignment.orderKey]),
        ),
      });
      void (async () => {
        // Sequential, stop on first failure. There is deliberately no
        // rollback: every key write is a complete, valid placement on its
        // own, so a partial materialization leaves a sensible order (and
        // the next drag repairs the rest) — unwinding writes across
        // servers would trade that for real inconsistency windows.
        for (const assignment of assignments) {
          const thread = threadByKey.get(assignment.id);
          if (thread === undefined) continue;
          const result = await reorderPinnedThread(
            scopeThreadRef(thread.environmentId, thread.id),
            assignment.orderKey,
          );
          if (result._tag === "Failure") {
            // Any failure — interrupted included — releases the override:
            // a key that never lands would otherwise hold it until some
            // unrelated world change came along.
            pinnedReorderInFlightRef.current = false;
            setOptimisticPinnedOrder(null);
            if (isAtomCommandInterrupted(result)) return;
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to reorder pinned threads",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
            return;
          }
        }
      })();
    },
    [orderedPinnedThreads, reorderPinnedThread, reorderablePinnedKeys],
  );
  const planPinnedInsertion = useCallback(
    (transaction: SidebarThreadDragTransaction): SidebarPinnedInsertionPlan | null => {
      if (transaction.sourceSection === "pinned" || transaction.targetSection !== "pinned") {
        return null;
      }
      const existingKeys = allPinnedThreads.map(sidebarThreadKey);
      let insertionIndex = existingKeys.length;
      if (transaction.targetThreadKey !== null) {
        const targetIndex = existingKeys.indexOf(transaction.targetThreadKey);
        if (targetIndex !== -1) {
          insertionIndex = targetIndex + (transaction.targetEdge === "after" ? 1 : 0);
        }
      } else if (existingKeys.length === 0) {
        insertionIndex = 0;
      }
      const order = [...existingKeys];
      order.splice(insertionIndex, 0, transaction.sourceThreadKey);
      const threadByKey = new Map(
        allPinnedThreads.map((thread) => [sidebarThreadKey(thread), thread] as const),
      );
      threadByKey.set(transaction.sourceThreadKey, transaction.sourceThread);
      const keysById = new Map(
        allPinnedThreads.map((thread) => [sidebarThreadKey(thread), thread.pinOrderKey ?? null]),
      );
      keysById.set(transaction.sourceThreadKey, null);
      const assignments = planPinnedReorder({
        orderedIds: order,
        keysById,
        movedId: transaction.sourceThreadKey,
      });
      if (assignments.length === 0) return null;
      for (const assignment of assignments) {
        const thread = threadByKey.get(assignment.id);
        if (thread === undefined) return null;
        const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
        if (assignment.id === transaction.sourceThreadKey) {
          if (capabilities?.threadPinning !== true || capabilities.threadPinReorder !== true) {
            return null;
          }
        } else if (capabilities?.threadPinReorder !== true) {
          return null;
        }
      }
      return { order, assignments, threadByKey };
    },
    [allPinnedThreads, serverConfigs],
  );
  // One snooze per thread at a time — same double-dispatch guard as settle.
  const snoozingThreadKeysRef = useRef(new Set<string>());
  const performSnooze = useCallback(
    async (
      threadRef: ScopedThreadRef,
      preset: SnoozePreset,
      opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
    ) => {
      const threadKey = scopedThreadKey(threadRef);
      if (snoozingThreadKeysRef.current.has(threadKey)) {
        return { status: "skipped" } as const;
      }
      snoozingThreadKeysRef.current.add(threadKey);
      try {
        // Snoozing the open thread moves you forward, same as settle —
        // both park the thread you're done with for now.
        const navigateAfterSnooze = planForwardNavigation(threadKey, opts.coSnoozingKeys);
        const result = await snoozeThread(threadRef, preset.snoozedUntil);
        if (result._tag === "Failure") {
          // Never navigate away from a thread that did not snooze.
          return isAtomCommandInterrupted(result)
            ? ({ status: "interrupted" } as const)
            : ({ status: "failure", error: squashAtomCommandFailure(result) } as const);
        }
        // Only move forward if the user is still on the snoozed thread —
        // a navigation made during the await wins over ours.
        if (routeThreadKeyRef.current === threadKey) {
          navigateAfterSnooze?.();
        }
        return { status: "success", sequence: result.value.sequence } as const;
      } finally {
        snoozingThreadKeysRef.current.delete(threadKey);
      }
    },
    [planForwardNavigation, snoozeThread],
  );
  const attemptSnooze = useCallback(
    (
      threadRef: ScopedThreadRef,
      preset: SnoozePreset,
      opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
    ) => {
      void (async () => {
        const outcome = await performSnooze(threadRef, preset, opts);
        if (outcome.status === "failure") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to snooze thread",
              description:
                outcome.error instanceof Error ? outcome.error.message : "An error occurred.",
            }),
          );
          return;
        }
        if (outcome.status !== "success") return;
        // Snooze hides the row, so the toast is the only confirmation. Wake
        // is explicit: Snooze no longer promises to restore an old category.
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: `Snoozed until ${snoozeWakeDescription(preset.snoozedUntil, new Date(), timestampFormat)}`,
            timeout: 5_000,
            actionProps: {
              children: "Wake",
              onClick: () => attemptUnsnooze(threadRef),
            },
          }),
        );
      })();
    },
    [attemptUnsnooze, performSnooze, timestampFormat],
  );

  const finishSidebarDragTransaction = useCallback(
    (options: { excludeSource?: boolean } = {}) => {
      const transaction = dragTransactionRef.current;
      snoozeDropEpochRef.current += 1;
      if (transaction?.phase === "awaiting-snooze-choice") {
        void readLocalApi()?.contextMenu.close();
      }
      cleanupTrackedPointer();
      retainSidebarLayoutAnchor(
        options.excludeSource || transaction === null
          ? null
          : (threadRowNodesRef.current.get(transaction.sourceThreadKey) ?? null),
        options.excludeSource && transaction !== null ? transaction.sourceThreadKey : null,
      );
      setDragTransaction(null);
    },
    [cleanupTrackedPointer, retainSidebarLayoutAnchor, setDragTransaction],
  );
  const beginSidebarDropReconciliation = useCallback(
    (input: {
      transaction: SidebarThreadDragTransaction;
      destinationSection: SidebarDndSection;
      receiptSequencesByEnvironment: ReadonlyMap<EnvironmentThreadShell["environmentId"], number>;
      pinnedOrder?: readonly string[] | null;
      snoozedUntil?: string | null;
    }) => {
      retainSidebarLayoutAnchor(null, input.transaction.sourceThreadKey);
      setDragTransaction({
        ...input.transaction,
        phase: "reconciling",
        targetSection: input.destinationSection,
        destinationSection: input.destinationSection,
        pinnedOrder: input.pinnedOrder ?? null,
        snoozedUntil: input.snoozedUntil ?? null,
        receiptSequencesByEnvironment: input.receiptSequencesByEnvironment,
      });
    },
    [retainSidebarLayoutAnchor, setDragTransaction],
  );
  const reportSidebarDropFailure = useCallback(
    (
      title: string,
      result: Parameters<typeof isAtomCommandInterrupted>[0] & { readonly _tag: "Failure" },
    ) => {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
    [],
  );
  const sourceStillMatchesDragStart = useCallback((transaction: SidebarThreadDragTransaction) => {
    const current = allThreadByKeyRef.current.get(transaction.sourceThreadKey);
    return (
      current !== undefined &&
      current.archivedAt === null &&
      canonicalSectionByThreadKeyRef.current.get(transaction.sourceThreadKey) ===
        transaction.sourceSection
    );
  }, []);
  const commitSidebarLifecycleDrop = useCallback(
    (
      transaction: SidebarThreadDragTransaction,
      destinationSection: SidebarDndSection,
      action: Exclude<SidebarDndAction, "noop" | "reorder-pinned" | "snooze">,
      pinnedPlan: SidebarPinnedInsertionPlan | null,
    ) => {
      void (async () => {
        if (!sourceStillMatchesDragStart(transaction)) {
          finishSidebarDragTransaction();
          return;
        }
        setDragTransaction({
          ...transaction,
          phase: "committing",
          targetSection: destinationSection,
          destinationSection,
          pinnedOrder: pinnedPlan?.order ?? null,
          snoozedUntil: null,
          receiptSequencesByEnvironment: null,
        });
        const threadRef = scopeThreadRef(
          transaction.sourceThread.environmentId,
          transaction.sourceThread.id,
        );
        const receiptSequences = new Map<EnvironmentThreadShell["environmentId"], number>();
        const recordReceipt = (
          environmentId: EnvironmentThreadShell["environmentId"],
          sequence: number,
        ) => {
          receiptSequences.set(
            environmentId,
            Math.max(receiptSequences.get(environmentId) ?? 0, sequence),
          );
        };
        if (action === "pin") {
          if (pinnedPlan === null) {
            finishSidebarDragTransaction();
            return;
          }
          for (const assignment of pinnedPlan.assignments) {
            if (assignment.id === transaction.sourceThreadKey) continue;
            const thread = pinnedPlan.threadByKey.get(assignment.id);
            if (thread === undefined) {
              finishSidebarDragTransaction();
              return;
            }
            const result = await reorderPinnedThread(
              scopeThreadRef(thread.environmentId, thread.id),
              assignment.orderKey,
            );
            if (result._tag === "Failure") {
              finishSidebarDragTransaction();
              reportSidebarDropFailure("Failed to prepare pinned order", result);
              return;
            }
            recordReceipt(thread.environmentId, result.value.sequence);
          }
          const sourceAssignment = pinnedPlan.assignments.find(
            (assignment) => assignment.id === transaction.sourceThreadKey,
          );
          if (sourceAssignment === undefined) {
            finishSidebarDragTransaction();
            return;
          }
          const result = await pinThread(threadRef, { orderKey: sourceAssignment.orderKey });
          if (result._tag === "Failure") {
            finishSidebarDragTransaction();
            reportSidebarDropFailure("Failed to pin thread", result);
            return;
          }
          recordReceipt(transaction.sourceThread.environmentId, result.value.sequence);
          beginSidebarDropReconciliation({
            transaction,
            destinationSection,
            receiptSequencesByEnvironment: receiptSequences,
            pinnedOrder: pinnedPlan.order,
          });
          return;
        }

        const navigateAfterSettle =
          action === "settle" ? planForwardNavigation(transaction.sourceThreadKey) : null;
        const result =
          action === "unpin"
            ? await unpinThread(threadRef)
            : action === "unsettle"
              ? await unsettleThread(threadRef)
              : action === "unsnooze"
                ? await unsnoozeThread(threadRef)
                : await settleThread(threadRef);
        if (result._tag === "Failure") {
          finishSidebarDragTransaction();
          reportSidebarDropFailure(
            action === "unpin"
              ? "Failed to unpin thread"
              : action === "unsettle"
                ? "Failed to un-settle thread"
                : action === "unsnooze"
                  ? "Failed to wake thread"
                  : "Failed to settle thread",
            result,
          );
          return;
        }
        if (action === "settle") {
          if (routeThreadKeyRef.current === transaction.sourceThreadKey) {
            navigateAfterSettle?.();
          }
        }
        recordReceipt(transaction.sourceThread.environmentId, result.value.sequence);
        beginSidebarDropReconciliation({
          transaction,
          destinationSection,
          receiptSequencesByEnvironment: receiptSequences,
        });
      })();
    },
    [
      beginSidebarDropReconciliation,
      finishSidebarDragTransaction,
      pinThread,
      planForwardNavigation,
      reorderPinnedThread,
      reportSidebarDropFailure,
      setDragTransaction,
      settleThread,
      sourceStillMatchesDragStart,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
    ],
  );
  const openSidebarSnoozeDropMenu = useCallback(
    (transaction: SidebarThreadDragTransaction, position: { x: number; y: number }) => {
      const epoch = snoozeDropEpochRef.current + 1;
      snoozeDropEpochRef.current = epoch;
      setDragTransaction({
        ...transaction,
        phase: "awaiting-snooze-choice",
        targetSection: "snoozed",
        destinationSection: "snoozed",
        pinnedOrder: null,
        snoozedUntil: null,
        receiptSequencesByEnvironment: null,
      });
      void (async () => {
        const api = readLocalApi();
        if (api === undefined) {
          finishSidebarDragTransaction();
          return;
        }
        const menuPresets = resolveSnoozePresets(new Date(), timestampFormat);
        const selected = await settlePromise(() =>
          api.contextMenu.show(
            menuPresets.map((preset) => ({
              id: `snooze:${preset.id}`,
              label: `${preset.label} (${preset.whenLabel})`,
            })),
            position,
          ),
        );
        if (snoozeDropEpochRef.current !== epoch) return;
        if (selected._tag === "Failure" || selected.value === null) {
          finishSidebarDragTransaction();
          return;
        }
        const selectedId = selected.value.startsWith("snooze:")
          ? selected.value.slice("snooze:".length)
          : null;
        const preset = resolveSnoozePresets(new Date(), timestampFormat).find(
          (candidate) => candidate.id === selectedId,
        );
        if (preset === undefined || !sourceStillMatchesDragStart(transaction)) {
          finishSidebarDragTransaction();
          return;
        }
        setDragTransaction({
          ...transaction,
          phase: "committing",
          targetSection: "snoozed",
          destinationSection: "snoozed",
          pinnedOrder: null,
          snoozedUntil: preset.snoozedUntil,
          receiptSequencesByEnvironment: null,
        });
        const threadRef = scopeThreadRef(
          transaction.sourceThread.environmentId,
          transaction.sourceThread.id,
        );
        const outcome = await performSnooze(threadRef, preset);
        if (outcome.status === "failure") {
          finishSidebarDragTransaction();
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to snooze thread",
              description:
                outcome.error instanceof Error ? outcome.error.message : "An error occurred.",
            }),
          );
          return;
        }
        if (outcome.status !== "success") {
          finishSidebarDragTransaction();
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: `Snoozed until ${snoozeWakeDescription(preset.snoozedUntil, new Date(), timestampFormat)}`,
            timeout: 5_000,
            actionProps: {
              children: "Wake",
              onClick: () => attemptUnsnooze(threadRef),
            },
          }),
        );
        beginSidebarDropReconciliation({
          transaction,
          destinationSection: "snoozed",
          receiptSequencesByEnvironment: new Map([
            [transaction.sourceThread.environmentId, outcome.sequence],
          ]),
          snoozedUntil: preset.snoozedUntil,
        });
      })();
    },
    [
      attemptUnsnooze,
      beginSidebarDropReconciliation,
      finishSidebarDragTransaction,
      performSnooze,
      setDragTransaction,
      sourceStillMatchesDragStart,
      timestampFormat,
    ],
  );

  const threadCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      const viewportRailSections = viewportRailSectionsRef.current;
      return pointerCollisions.toSorted((left, right) => {
        const leftId = parseSidebarDndId(left.id);
        const rightId = parseSidebarDndId(right.id);
        const priority = (id: ReturnType<typeof parseSidebarDndId>) => {
          if (id?.kind === "section" && viewportRailSections.has(id.section)) {
            return 0;
          }
          return id?.kind === "section" ? 2 : 1;
        };
        return priority(leftId) - priority(rightId);
      });
    }
    return closestCenter(args);
  }, []);
  const handleThreadDragStart = useCallback(
    (event: DragStartEvent) => {
      if (pinnedReorderInFlightRef.current) return;
      const id = parseSidebarDndId(event.active.id);
      if (id === null || id.kind !== "draggable") return;
      const sourceThread = allThreadByKeyRef.current.get(id.threadKey);
      const sourceNode = threadRowNodesRef.current.get(id.threadKey);
      if (sourceThread === undefined || sourceNode === undefined) return;
      const sourceSection = canonicalSectionByThreadKeyRef.current.get(id.threadKey);
      if (sourceSection === undefined || !canDragThread(sourceThread, sourceSection)) return;
      const sourceRect = sourceNode.getBoundingClientRect();
      const activator = event.activatorEvent instanceof PointerEvent ? event.activatorEvent : null;
      const pointer = {
        x:
          activator !== null && Number.isFinite(activator.clientX)
            ? activator.clientX
            : sourceRect.left + sourceRect.width / 2,
        y:
          activator !== null && Number.isFinite(activator.clientY)
            ? activator.clientY
            : sourceRect.top + sourceRect.height / 2,
      };
      cleanupTrackedPointer();
      rawPointerRef.current = pointer;
      releasePointerRef.current = null;
      activePointerIdRef.current =
        activator !== null && Number.isFinite(activator.pointerId) ? activator.pointerId : null;
      const updatePointer = (pointerEvent: PointerEvent) => {
        if (
          activePointerIdRef.current !== null &&
          pointerEvent.pointerId !== activePointerIdRef.current
        ) {
          return;
        }
        rawPointerRef.current = { x: pointerEvent.clientX, y: pointerEvent.clientY };
      };
      const captureReleasePointer = (pointerEvent: PointerEvent) => {
        if (
          activePointerIdRef.current !== null &&
          pointerEvent.pointerId !== activePointerIdRef.current
        ) {
          return;
        }
        releasePointerRef.current = { x: pointerEvent.clientX, y: pointerEvent.clientY };
      };
      window.addEventListener("pointermove", updatePointer, true);
      window.addEventListener("pointerup", captureReleasePointer, true);
      window.addEventListener("pointercancel", captureReleasePointer, true);
      pointerListenerCleanupRef.current = () => {
        window.removeEventListener("pointermove", updatePointer, true);
        window.removeEventListener("pointerup", captureReleasePointer, true);
        window.removeEventListener("pointercancel", captureReleasePointer, true);
      };
      const sections = {
        pinned: orderedPinnedThreads,
        regular: activeThreads,
        snoozed: visibleSnoozedThreads,
        settled: renderedSettledThreads,
      } satisfies Readonly<Record<SidebarDndSection, readonly EnvironmentThreadShell[]>>;
      pauseSidebarLayoutMotion();
      holdSidebarScrollRange();
      retainSidebarLayoutAnchor(sourceNode);
      setDragTransaction({
        phase: "dragging",
        sourceThread,
        sourceThreadKey: id.threadKey,
        sourceSection,
        sourceIndex: sidebarDndSectionIndex(sourceSection, id.threadKey, sections),
        sourceRect: {
          left: sourceRect.left,
          top: sourceRect.top,
          width: sourceRect.width,
          height: sourceRect.height,
        },
        pointerAnchor: captureSidebarDndPointerAnchor({ pointer, sourceRect }),
        targetSection: sourceSection,
        targetThreadKey: id.threadKey,
        targetEdge: null,
        destinationSection: null,
        pinnedOrder: null,
        snoozedUntil: null,
        receiptSequencesByEnvironment: null,
        viewportRailTopBySection: null,
      });
    },
    [
      activeThreads,
      canDragThread,
      cleanupTrackedPointer,
      holdSidebarScrollRange,
      orderedPinnedThreads,
      pauseSidebarLayoutMotion,
      renderedSettledThreads,
      retainSidebarLayoutAnchor,
      setDragTransaction,
      visibleSnoozedThreads,
    ],
  );
  const resolveThreadDropTarget = useCallback(
    (
      current: SidebarThreadDragTransaction,
      over: DragMoveEvent["over"],
    ): SidebarThreadDropTarget | null => {
      if (over === null) return null;
      const overId = parseSidebarDndId(over.id);
      if (overId === null) {
        return null;
      }
      const destination = overId.section;
      if (!canDropThreadInSection(current.sourceThread, current.sourceSection, destination)) {
        return null;
      }
      let targetThreadKey = overId.kind === "section" ? null : overId.threadKey;
      let targetEdge: "before" | "after" | null = null;
      const pointerY = rawPointerRef.current?.y ?? over.rect.top + over.rect.height / 2;
      if (targetThreadKey !== null) {
        if (destination === "pinned" && !reorderablePinnedKeys.has(targetThreadKey)) return null;
        targetEdge = pointerY < over.rect.top + over.rect.height / 2 ? "before" : "after";
      } else if (destination === "pinned" && orderedPinnedThreads.length > 0) {
        const first = orderedPinnedThreads[0];
        const last = orderedPinnedThreads.at(-1);
        const before = pointerY < over.rect.top + over.rect.height / 2;
        const target = before ? first : last;
        if (target !== undefined) {
          targetThreadKey = sidebarThreadKey(target);
          targetEdge = before ? "before" : "after";
        }
      }
      return { targetSection: destination, targetThreadKey, targetEdge };
    },
    [canDropThreadInSection, orderedPinnedThreads, reorderablePinnedKeys],
  );
  const updateThreadDragTarget = useCallback(
    (over: DragMoveEvent["over"]) => {
      const current = dragTransactionRef.current;
      if (current === null || current.phase !== "dragging") return;
      const target = resolveThreadDropTarget(current, over);
      if (target === null) {
        if (current.targetSection === null) return;
        setDragTransaction({
          ...current,
          targetSection: null,
          targetThreadKey: null,
          targetEdge: null,
        });
        return;
      }
      if (
        current.targetSection === target.targetSection &&
        current.targetThreadKey === target.targetThreadKey &&
        current.targetEdge === target.targetEdge
      ) {
        return;
      }
      setDragTransaction({
        ...current,
        ...target,
      });
    },
    [resolveThreadDropTarget, setDragTransaction],
  );
  const handleThreadDragMove = useCallback(
    (event: DragMoveEvent) => updateThreadDragTarget(event.over),
    [updateThreadDragTarget],
  );
  const handleThreadDragOver = useCallback(
    (event: DragOverEvent) => updateThreadDragTarget(event.over),
    [updateThreadDragTarget],
  );
  const handleThreadDragCancel = useCallback(
    (_event: DragCancelEvent) => finishSidebarDragTransaction(),
    [finishSidebarDragTransaction],
  );
  const handleThreadDragEnd = useCallback(
    (event: DragEndEvent) => {
      const current = dragTransactionRef.current;
      const releasePoint = releasePointerRef.current ?? rawPointerRef.current;
      const target =
        current !== null && current.phase === "dragging"
          ? resolveThreadDropTarget(current, event.over)
          : null;
      cleanupTrackedPointer();
      if (current === null || current.phase !== "dragging" || target === null) {
        finishSidebarDragTransaction();
        return;
      }
      const finalized = { ...current, ...target };
      const action = resolveSidebarDndAction({
        source: finalized.sourceSection,
        destination: finalized.targetSection,
      });
      if (action === "noop") {
        finishSidebarDragTransaction();
        return;
      }
      if (action === "reorder-pinned") {
        handlePinnedReorder(
          finalized.sourceThreadKey,
          finalized.targetThreadKey,
          finalized.targetEdge,
        );
        finishSidebarDragTransaction();
        return;
      }
      if (action === "snooze") {
        openSidebarSnoozeDropMenu(
          finalized,
          releasePoint ?? {
            x: finalized.sourceRect.left + finalized.sourceRect.width / 2,
            y: finalized.sourceRect.top + finalized.sourceRect.height / 2,
          },
        );
        return;
      }
      const pinnedPlan = action === "pin" ? planPinnedInsertion(finalized) : null;
      if (action === "pin" && pinnedPlan === null) {
        finishSidebarDragTransaction();
        return;
      }
      commitSidebarLifecycleDrop(finalized, finalized.targetSection, action, pinnedPlan);
    },
    [
      cleanupTrackedPointer,
      commitSidebarLifecycleDrop,
      finishSidebarDragTransaction,
      handlePinnedReorder,
      openSidebarSnoozeDropMenu,
      planPinnedInsertion,
      resolveThreadDropTarget,
    ],
  );
  useLayoutEffect(() => {
    if (
      dragTransaction === null ||
      dragTransaction.phase !== "reconciling" ||
      dragTransaction.receiptSequencesByEnvironment === null
    ) {
      return;
    }
    for (const [environmentId, receiptSequence] of dragTransaction.receiptSequencesByEnvironment) {
      const snapshot = appAtomRegistry.get(environmentSnapshotAtom(environmentId));
      if (snapshot === null || snapshot.snapshotSequence < receiptSequence) return;
    }
    // Once every owning shell has crossed its receipt, canonical state is
    // authoritative. A different section here is a later writer, not a UI
    // state the local drop should keep masking.
    finishSidebarDragTransaction({ excludeSource: true });
  }, [dragTransaction, finishSidebarDragTransaction, threads]);
  useLayoutEffect(() => {
    if (
      dragTransaction === null ||
      (dragTransaction.phase !== "dragging" && dragTransaction.phase !== "awaiting-snooze-choice")
    ) {
      return;
    }
    if (isSearchingThreads || !sourceStillMatchesDragStart(dragTransaction)) {
      finishSidebarDragTransaction();
    }
  }, [
    dragTransaction,
    finishSidebarDragTransaction,
    isSearchingThreads,
    projectScopeKey,
    sourceStillMatchesDragStart,
    threads,
  ]);

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
          clearSelection();
          const outcomes = await Promise.all(
            selectedThreads.map(async (thread) => {
              const threadRef = scopeThreadRef(thread.environmentId, thread.id);
              const outcome = await performSnooze(threadRef, preset, { coSnoozingKeys });
              return { outcome, threadRef };
            }),
          );
          const snoozedThreadRefs = outcomes.flatMap(({ outcome, threadRef }) =>
            outcome.status === "success" ? [threadRef] : [],
          );
          const failures = outcomes.flatMap(({ outcome }) =>
            outcome.status === "failure" ? [outcome.error] : [],
          );

          if (snoozedThreadRefs.length > 0) {
            const snoozedCount = snoozedThreadRefs.length;
            const failedCount = failures.length;
            toastManager.add(
              stackedThreadToast({
                type: failedCount > 0 ? "warning" : "success",
                title:
                  failedCount > 0
                    ? `Snoozed ${snoozedCount} of ${selectedThreads.length} threads`
                    : `Snoozed ${snoozedCount} thread${snoozedCount === 1 ? "" : "s"}`,
                description:
                  failedCount > 0
                    ? `${failedCount} thread${failedCount === 1 ? "" : "s"} couldn't be snoozed.`
                    : undefined,
                timeout: 5_000,
                actionProps: {
                  children: "Wake",
                  onClick: () => {
                    for (const threadRef of snoozedThreadRefs) attemptUnsnooze(threadRef);
                  },
                },
              }),
            );
          } else if (failures.length > 0) {
            const firstError = failures[0];
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to snooze threads",
                description:
                  firstError instanceof Error ? firstError.message : "An error occurred.",
              }),
            );
          }
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
            { variant: "destructive" },
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
      performSnooze,
      removeFromSelection,
      serverConfigs,
      attemptUnsnooze,
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
        // Un-settle works on every settled row. For explicit settles it
        // clears the override; for auto-settled rows it keeps the thread
        // active until real activity clears that choice. Environments without
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
            buildThreadActionMenuItems({
              branch: thread.branch ?? null,
              isPinned,
              isSettled,
              isSnoozed,
              canSnoozeNow: canSnooze(thread, { now: new Date().toISOString() }),
              isRegeneratingTitle,
              isRunning:
                thread.session?.status === "running" && thread.session.activeTurnId != null,
              supports: {
                settlement: supportsSettlement,
                snooze: supportsSnooze,
                pinning: supportsPinning,
                titleRegeneration: supportsTitleRegeneration,
              },
              snoozePresets,
            }),
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
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive thread "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            let didArchive = false;
            const result = await archiveThread(threadRef, {
              onArchived: () => {
                didArchive = true;
              },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: didArchive
                    ? "Thread archived, but navigation failed"
                    : "Failed to archive thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
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
      archiveThread,
      attemptPin,
      attemptSettle,
      attemptSnooze,
      attemptUnpin,
      attemptUnsettle,
      attemptUnsnooze,
      confirmThreadArchive,
      confirmThreadDelete,
      copyBranchToClipboard,
      copyPathToClipboard,
      copyThreadIdToClipboard,
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
  const terminalFocused = useTerminalFocus();
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
      },
    },
  );
  useEffect(() => {
    setShowJumpHints(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow]);

  const boardSections = useMemo(() => {
    let pinned = [...orderedPinnedThreads];
    let regular = [...activeThreads];
    let snoozed = [...visibleSnoozedThreads];
    let settled = [...renderedSettledThreads];
    const transaction = dragTransaction;
    if (transaction === null) return { pinned, regular, snoozed, settled };

    const withoutSource = (items: readonly EnvironmentThreadShell[]) =>
      items.filter((thread) => sidebarThreadKey(thread) !== transaction.sourceThreadKey);
    pinned = withoutSource(pinned);
    regular = withoutSource(regular);
    snoozed = withoutSource(snoozed);
    settled = withoutSource(settled);

    if (transaction.phase !== "reconciling" || transaction.destinationSection === null) {
      switch (transaction.sourceSection) {
        case "pinned":
          pinned = insertSidebarThreadAt(pinned, transaction.sourceThread, transaction.sourceIndex);
          break;
        case "regular":
          regular = insertSidebarThreadAt(
            regular,
            transaction.sourceThread,
            transaction.sourceIndex,
          );
          break;
        case "snoozed":
          snoozed = insertSidebarThreadAt(
            snoozed,
            transaction.sourceThread,
            transaction.sourceIndex,
          );
          break;
        case "settled":
          settled = insertSidebarThreadAt(
            settled,
            transaction.sourceThread,
            transaction.sourceIndex,
          );
          break;
      }
      return { pinned, regular, snoozed, settled };
    }

    const now = new Date().toISOString();
    switch (transaction.destinationSection) {
      case "pinned": {
        const optimistic = {
          ...transaction.sourceThread,
          pinnedAt: now,
          settledOverride: "active" as const,
          settledAt: null,
          snoozedAt: null,
          snoozedUntil: null,
        };
        pinned = orderItemsByPreferredIds({
          items: [...pinned, optimistic],
          preferredIds: transaction.pinnedOrder ?? [],
          getId: sidebarThreadKey,
        });
        break;
      }
      case "regular":
        regular = sortThreadsForSidebar([
          ...regular,
          {
            ...transaction.sourceThread,
            pinnedAt: null,
            pinOrderKey: null,
            settledOverride: "active" as const,
            settledAt: null,
            snoozedAt: null,
            snoozedUntil: null,
          },
        ]);
        break;
      case "snoozed":
        snoozed = [
          ...snoozed,
          {
            ...transaction.sourceThread,
            pinnedAt: null,
            pinOrderKey: null,
            settledOverride: "active" as const,
            settledAt: null,
            snoozedAt: now,
            snoozedUntil: transaction.snoozedUntil,
          },
        ].toSorted(
          (left, right) =>
            firstValidTimestampMs(left.snoozedUntil ?? null) -
            firstValidTimestampMs(right.snoozedUntil ?? null),
        );
        break;
      case "settled":
        settled = sortSettledThreadsForSidebar([
          ...settled,
          {
            ...transaction.sourceThread,
            pinnedAt: null,
            pinOrderKey: null,
            settledOverride: "settled" as const,
            settledAt: now,
            snoozedAt: null,
            snoozedUntil: null,
          },
        ]);
        break;
    }
    return { pinned, regular, snoozed, settled };
  }, [
    activeThreads,
    dragTransaction,
    orderedPinnedThreads,
    renderedSettledThreads,
    visibleSnoozedThreads,
  ]);
  const dropIndicatorByThreadKey = useMemo(() => {
    const indicators = new Map<string, "before" | "after">();
    const transaction = dragTransaction;
    if (
      transaction === null ||
      transaction.phase === "reconciling" ||
      transaction.targetThreadKey === null ||
      transaction.targetEdge === null
    ) {
      return indicators;
    }
    indicators.set(transaction.targetThreadKey, transaction.targetEdge);
    return indicators;
  }, [dragTransaction]);
  const isTemporarySectionRailVisible = useCallback(
    (section: SidebarDndSection) => {
      const transaction = dragTransaction;
      if (transaction === null || transaction.phase === "reconciling") return false;
      const sectionIsEmpty =
        boardSections[section].length === 0 &&
        (section !== "snoozed" || snoozedThreads.length === 0) &&
        (section !== "settled" || settledThreads.length === 0);
      return (
        sectionIsEmpty &&
        canDropThreadInSection(transaction.sourceThread, transaction.sourceSection, section)
      );
    },
    [
      boardSections,
      canDropThreadInSection,
      dragTransaction,
      settledThreads.length,
      snoozedThreads.length,
    ],
  );
  const dragPreviewVariant =
    dragTransaction?.phase === "dragging"
      ? resolveSidebarDndPreviewVariant({
          source: dragTransaction.sourceSection,
          destination: dragTransaction.targetSection,
        })
      : null;

  const attachListAutoAnimateRef = useCallback(
    (node: HTMLUListElement | null) => {
      if (threadListNodeRef.current === node) return;
      clearSidebarScrollRangeHold();
      autoAnimateControllerRef.current?.destroy?.();
      threadListNodeRef.current = node;
      autoAnimateControllerRef.current =
        node === null ? null : autoAnimate(node, { duration: 150, easing: "ease-out" });
    },
    [clearSidebarScrollRangeHold],
  );

  // New thread defaults to the project you're in (active thread's project,
  // falling back to the top project) — same resolution the command palette
  // uses. The command palette already offers a "New thread in..." submenu
  // for multi-project setups.
  const handleNewThreadClick = useCallback(
    (event?: ReactMouseEvent) => {
      // One project: nothing to pick, create immediately. Shift+click creates
      // directly in the current project even with several projects, skipping
      // the palette picker.
      if (shouldCreateNewThreadInCurrentProject(event?.shiftKey ?? false, projectGroups.length)) {
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
    },
    [isMobile, newThreadContext, projectGroups.length, setOpenMobile],
  );

  // The button mirrors chat.new: in multi-project setups both route through
  // the command palette's "New thread in..." picker, and in single-project
  // setups both create immediately. In multi-project setups the label is only
  // the picker's shortcut: falling back to chat.newLocal would advertise the
  // same shortcut for both the picker and direct create. In single-project
  // setups both commands create directly, so chat.newLocal is a valid
  // fallback. The second tooltip line (multi-project only) advertises
  // shift+click and its keyboard twin chat.newLocal for direct create.
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    (projectGroups.length <= 1 ? shortcutLabelForCommand(keybindings, "chat.newLocal") : undefined);
  const newThreadInProjectShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newLocal");
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        viewportRef={sidebarViewportRef}
        viewportOverlayRef={sidebarViewportOverlayRef}
        className="gap-0"
        fixedHeader={
          // Lifted above the stage backdrop, whose fade bleeds below the
          // header and would otherwise paint across the search row's outline.
          <SidebarGroup className="relative z-[1] gap-1 p-[var(--sidebar-content-inset)]">
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
                    size="icon-micro"
                    variant="ghost"
                    className="shrink-0 text-sidebar-muted-foreground hover:bg-sidebar-control-surface hover:text-sidebar-foreground"
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
                    {projectGroups.length > 1 ? (
                      <span className="flex flex-col gap-0.5">
                        <span>
                          {newThreadShortcutLabel
                            ? `New thread (${newThreadShortcutLabel})`
                            : "New thread"}
                        </span>
                        <span className="text-muted-foreground">
                          New thread in current project: Shift+click
                          {newThreadInProjectShortcutLabel
                            ? ` (${newThreadInProjectShortcutLabel})`
                            : ""}
                        </span>
                      </span>
                    ) : newThreadShortcutLabel ? (
                      `New thread (${newThreadShortcutLabel})`
                    ) : (
                      "New thread"
                    )}
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
                        className="min-w-0 flex-1 ps-[calc(var(--sidebar-row-content-inset)-1px)] focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                      />
                    }
                  >
                    {scopedProjectGroup ? (
                      <ProjectFavicon
                        environmentId={scopedProjectGroup.environmentId}
                        cwd={scopedProjectGroup.workspaceRoot}
                        faviconPath={scopedProjectGroup.faviconPath}
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
                        className="h-8 min-h-8 py-0 text-sm font-medium [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
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
                            className="h-8 min-h-8 py-0 text-sm font-medium [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
                          >
                            <ProjectFavicon
                              environmentId={project.environmentId}
                              cwd={project.workspaceRoot}
                              faviconPath={project.faviconPath}
                              className="size-4 shrink-0"
                            />
                            <span className="min-w-0 truncate text-sm">{project.displayName}</span>
                            <Button
                              size="icon-xs"
                              variant="ghost-muted"
                              aria-label={`Project settings for ${project.displayName}`}
                              title={`Project settings for ${project.displayName}`}
                              className="ml-auto size-6 [--control-icon-color:currentColor] text-icon-muted focus-visible:bg-accent focus-visible:text-foreground"
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                void handleProjectSettings(event, project);
                              }}
                            >
                              <SettingsIcon className="size-3.5" />
                            </Button>
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
                      <SidebarSearchResultRow
                        key={threadKey}
                        thread={thread}
                        projectCwd={
                          projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                        }
                        projectFaviconPath={
                          projectFaviconPathByKey.get(
                            `${thread.environmentId}:${thread.projectId}`,
                          ) ?? null
                        }
                        projectTitle={
                          projectDisplayNameByKey.get(
                            `${thread.environmentId}:${thread.projectId}`,
                          ) ?? null
                        }
                        environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                        providerEntryByInstanceId={
                          providerEntriesByEnvironment.get(thread.environmentId) ??
                          EMPTY_PROVIDER_ENTRIES
                        }
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
              <DndContext
                sensors={threadDndSensors}
                collisionDetection={threadCollisionDetection}
                modifiers={[restrictToVerticalAxis]}
                measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
                autoScroll={{
                  layoutShiftCompensation: false,
                  canScroll: (element) => element === sidebarViewportRef.current,
                }}
                onDragStart={handleThreadDragStart}
                onDragMove={handleThreadDragMove}
                onDragOver={handleThreadDragOver}
                onDragCancel={handleThreadDragCancel}
                onDragEnd={handleThreadDragEnd}
              >
                <ul ref={attachListAutoAnimateRef} role="list" className="flex flex-col gap-px">
                  {(() => {
                    const activeDropTransaction =
                      dragTransaction?.phase === "dragging" ? dragTransaction : null;
                    const sectionDropDisabled = (section: SidebarDndSection) =>
                      activeDropTransaction === null ||
                      !canDropThreadInSection(
                        activeDropTransaction.sourceThread,
                        activeDropTransaction.sourceSection,
                        section,
                      );
                    const renderThreadRow = (
                      thread: EnvironmentThreadShell,
                      section: SidebarDndSection,
                    ) => {
                      const threadKey = sidebarThreadKey(thread);
                      const isCard = section === "regular" || section === "pinned";
                      const rowVariant = isCard ? "card" : "slim";
                      const dndDimmed =
                        dragTransaction?.sourceThreadKey === threadKey &&
                        dragTransaction.phase !== "reconciling";
                      const dndInert =
                        dragTransaction?.sourceThreadKey === threadKey &&
                        dragTransaction.phase !== "dragging";
                      const renderVisualRow = (dnd: SidebarThreadDndRowBag) => (
                        <SidebarThreadRow
                          thread={thread}
                          variant={rowVariant}
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
                          autoSettleOnMerge={autoSettleOnMerge}
                          snoozeSupported={
                            serverConfigs.get(thread.environmentId)?.environment.capabilities
                              .threadSnooze === true
                          }
                          pinningSupported={
                            serverConfigs.get(thread.environmentId)?.environment.capabilities
                              .threadPinning === true
                          }
                          isPinned={section === "pinned"}
                          dnd={dnd}
                          dndDimmed={dndDimmed}
                          dndInert={dndInert}
                          dropIndicator={dropIndicatorByThreadKey.get(threadKey) ?? null}
                          snoozeWakeLabelText={
                            section === "snoozed" && thread.snoozedUntil != null
                              ? snoozeWakeLabel(thread.snoozedUntil, {
                                  now: new Date().toISOString(),
                                })
                              : null
                          }
                          wokeAt={threadWokeAt(thread, { now: snoozeNow })}
                          isActive={routeThreadKey === threadKey}
                          openPullRequestsInRightPanel={routeThreadRef !== null}
                          jumpLabel={showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
                          currentEnvironmentId={primaryEnvironmentId}
                          environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                          projectCwd={
                            projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ??
                            null
                          }
                          projectFaviconPath={
                            projectFaviconPathByKey.get(
                              `${thread.environmentId}:${thread.projectId}`,
                            ) ?? null
                          }
                          projectTitle={
                            projectDisplayNameByKey.get(
                              `${thread.environmentId}:${thread.projectId}`,
                            ) ?? null
                          }
                          providerEntryByInstanceId={
                            providerEntriesByEnvironment.get(thread.environmentId) ??
                            EMPTY_PROVIDER_ENTRIES
                          }
                          timestampFormat={timestampFormat}
                          onThreadClick={handleThreadClick}
                          onThreadActivate={navigateToThread}
                          onStartRename={startThreadRename}
                          onRenameTitleChange={setRenamingTitle}
                          onCommitRename={commitThreadRename}
                          onCancelRename={cancelThreadRename}
                          isRenaming={renamingThreadKey === threadKey}
                          renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
                          onContextMenu={handleThreadContextMenu}
                          onSettle={attemptSettle}
                          onUnsettle={attemptUnsettle}
                          onSnooze={attemptSnooze}
                          onUnsnooze={attemptUnsnooze}
                          onUnpin={attemptUnpin}
                          onAcknowledgeWoke={acknowledgeWoke}
                          changeRequestSnapshot={changeRequestSnapshotByKey.get(threadKey) ?? null}
                          onChangeRequestSnapshot={setThreadChangeRequestSnapshot}
                        />
                      );
                      const dragDisabled =
                        optimisticPinnedOrder !== null ||
                        !canDragThread(thread, section) ||
                        (dragTransaction !== null && dragTransaction.phase !== "dragging");
                      const dropDisabled = sectionDropDisabled(section);
                      const rowKey = `${threadKey}:${rowVariant}`;
                      return section === "pinned" && reorderablePinnedKeys.has(threadKey) ? (
                        <SortableSidebarThreadRow
                          key={rowKey}
                          threadKey={threadKey}
                          section={section}
                          disabled={dragDisabled}
                          onNodeChange={handleThreadRowNodeChange}
                        >
                          {renderVisualRow}
                        </SortableSidebarThreadRow>
                      ) : (
                        <DraggableSidebarThreadRow
                          key={rowKey}
                          threadKey={threadKey}
                          section={section}
                          dragDisabled={dragDisabled}
                          dropDisabled={dropDisabled}
                          onNodeChange={handleThreadRowNodeChange}
                        >
                          {renderVisualRow}
                        </DraggableSidebarThreadRow>
                      );
                    };
                    const rail = (section: SidebarDndSection, label: string, isOver: boolean) => (
                      <div data-testid={`sidebar-${section}-drop-rail`} className="h-12 p-1">
                        <div
                          className={cn(
                            "flex h-10 items-center justify-center rounded-md border border-dashed text-xs font-medium text-muted-foreground/60",
                            isOver && "border-primary bg-primary/5 text-primary",
                          )}
                        >
                          {label}
                        </div>
                      </div>
                    );
                    const showPinnedRail = isTemporarySectionRailVisible("pinned");
                    const showRegularRail = isTemporarySectionRailVisible("regular");
                    const showSnoozedRail = isTemporarySectionRailVisible("snoozed");
                    const showSettledRail = isTemporarySectionRailVisible("settled");
                    const visibleRailBySection = new Map<SidebarDndSection, boolean>([
                      ["pinned", showPinnedRail],
                      ["regular", showRegularRail],
                      ["snoozed", showSnoozedRail],
                      ["settled", showSettledRail],
                    ]);
                    const viewportRailTopBySection = dragTransaction?.viewportRailTopBySection;
                    const viewportOverlayHost = sidebarViewportOverlayRef.current;
                    const viewportRailSections = new Set<SidebarDndSection>();
                    if (
                      viewportRailTopBySection !== null &&
                      viewportRailTopBySection !== undefined
                    ) {
                      for (const section of viewportRailTopBySection.keys()) {
                        if (
                          visibleRailBySection.get(section) === true &&
                          viewportOverlayHost !== null
                        ) {
                          viewportRailSections.add(section);
                        }
                      }
                    }
                    const renderViewportRail = (
                      section: SidebarDndSection,
                      label: string,
                      isOver: boolean,
                      setNodeRef: (node: HTMLElement | null) => void,
                    ) => {
                      const top = viewportRailTopBySection?.get(section);
                      if (
                        top === undefined ||
                        viewportOverlayHost === null ||
                        !viewportRailSections.has(section)
                      ) {
                        return null;
                      }
                      return createPortal(
                        <SidebarThreadViewportDropRail
                          section={section}
                          top={top}
                          setDropNodeRef={setNodeRef}
                          onNodeChange={handleViewportRailNodeChange}
                        >
                          {rail(section, label, isOver)}
                        </SidebarThreadViewportDropRail>,
                        viewportOverlayHost,
                        `sidebar-${section}-viewport-drop-rail`,
                      );
                    };
                    return (
                      <>
                        <SidebarDraftBlock
                          projectDisplayNameByKey={projectDisplayNameByKey}
                          projectCwdByKey={projectCwdByKey}
                          projectFaviconPathByKey={projectFaviconPathByKey}
                          scopedProjectKeys={scopedProjectKeys}
                          routeDraftId={routeDraftIdForRows}
                          onNavigateToDraft={navigateToDraft}
                        />
                        <SidebarThreadSectionDropZone
                          section="pinned"
                          disabled={sectionDropDisabled("pinned")}
                        >
                          {({ setNodeRef, isOver }) => {
                            const viewportRail = showPinnedRail
                              ? renderViewportRail("pinned", "Pinned", isOver, setNodeRef)
                              : null;
                            if (viewportRail !== null) return viewportRail;
                            return (
                              <li ref={setNodeRef} className="relative list-none">
                                <SortableContext
                                  items={boardSections.pinned
                                    .map((thread) => sidebarThreadKey(thread))
                                    .filter((threadKey) => reorderablePinnedKeys.has(threadKey))
                                    .map((threadKey) =>
                                      createSidebarDndDraggableId({
                                        section: "pinned",
                                        threadKey,
                                      }),
                                    )}
                                  strategy={pinnedSortingStrategy}
                                >
                                  <ul
                                    role="list"
                                    aria-label="Pinned threads"
                                    className="flex flex-col gap-px"
                                  >
                                    {boardSections.pinned.map((thread) =>
                                      renderThreadRow(thread, "pinned"),
                                    )}
                                  </ul>
                                </SortableContext>
                                {showPinnedRail ? rail("pinned", "Pinned", isOver) : null}
                              </li>
                            );
                          }}
                        </SidebarThreadSectionDropZone>
                        {(boardSections.pinned.length > 0 || showPinnedRail) &&
                        !viewportRailSections.has("pinned") ? (
                          <li
                            aria-hidden
                            data-testid="sidebar-pinned-divider"
                            className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
                          />
                        ) : null}
                        <SidebarThreadSectionDropZone
                          section="regular"
                          disabled={sectionDropDisabled("regular")}
                        >
                          {({ setNodeRef, isOver }) => {
                            const viewportRail = showRegularRail
                              ? renderViewportRail("regular", "Regular", isOver, setNodeRef)
                              : null;
                            if (viewportRail !== null) return viewportRail;
                            return (
                              <li ref={setNodeRef} className="relative list-none">
                                <ul
                                  role="list"
                                  aria-label="Regular threads"
                                  className="flex flex-col gap-px"
                                >
                                  {boardSections.regular.map((thread) =>
                                    renderThreadRow(thread, "regular"),
                                  )}
                                </ul>
                                {showRegularRail ? rail("regular", "Regular", isOver) : null}
                              </li>
                            );
                          }}
                        </SidebarThreadSectionDropZone>
                        <SidebarThreadSectionDropZone
                          section="snoozed"
                          disabled={sectionDropDisabled("snoozed")}
                        >
                          {({ setNodeRef, isOver }) => {
                            const collapsedHeaderDropOver = isOver && !snoozedShelfExpanded;
                            const viewportRail = showSnoozedRail
                              ? renderViewportRail("snoozed", "Snooze", isOver, setNodeRef)
                              : null;
                            if (viewportRail !== null) return viewportRail;
                            return (
                              <li ref={setNodeRef} className="relative list-none">
                                {snoozedThreads.length > 0 ? (
                                  <div data-thread-selection-safe>
                                    <button
                                      type="button"
                                      onClick={toggleSnoozedShelf}
                                      aria-expanded={snoozedShelfExpanded}
                                      data-testid="sidebar-snoozed-shelf-toggle"
                                      className={cn(
                                        "mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left transition-colors",
                                        collapsedHeaderDropOver &&
                                          "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-sidebar-ring/50",
                                      )}
                                    >
                                      <span
                                        className={cn(
                                          "text-xs font-medium",
                                          collapsedHeaderDropOver
                                            ? "text-sidebar-accent-foreground"
                                            : "text-blue-600 dark:text-blue-400",
                                        )}
                                      >
                                        {snoozedShelfExpanded
                                          ? "Snoozed"
                                          : `Snoozed (${snoozedThreads.length})`}
                                      </span>
                                      <span
                                        className={cn(
                                          "h-px flex-1",
                                          collapsedHeaderDropOver
                                            ? "bg-sidebar-ring/50"
                                            : "bg-blue-500/20 dark:bg-blue-400/15",
                                        )}
                                      />
                                      <ChevronDownIcon
                                        aria-hidden
                                        className={cn(
                                          "size-3 transition-transform",
                                          snoozedShelfExpanded && "rotate-180",
                                          collapsedHeaderDropOver
                                            ? "text-sidebar-accent-foreground"
                                            : "text-blue-600 dark:text-blue-400",
                                        )}
                                      />
                                    </button>
                                  </div>
                                ) : null}
                                <ul
                                  role="list"
                                  aria-label="Snoozed threads"
                                  className="flex flex-col gap-px"
                                >
                                  {boardSections.snoozed.map((thread) =>
                                    renderThreadRow(thread, "snoozed"),
                                  )}
                                </ul>
                                {showSnoozedRail ? rail("snoozed", "Snooze", isOver) : null}
                              </li>
                            );
                          }}
                        </SidebarThreadSectionDropZone>
                        <SidebarThreadSectionDropZone
                          section="settled"
                          disabled={sectionDropDisabled("settled")}
                        >
                          {({ setNodeRef, isOver }) => {
                            const collapsedHeaderDropOver = isOver && !settledShelfExpanded;
                            const viewportRail = showSettledRail
                              ? renderViewportRail("settled", "Settled", isOver, setNodeRef)
                              : null;
                            if (viewportRail !== null) return viewportRail;
                            return (
                              <li ref={setNodeRef} className="relative list-none">
                                {settledThreads.length > 0 ? (
                                  <div data-thread-selection-safe>
                                    <button
                                      type="button"
                                      onClick={toggleSettledShelf}
                                      aria-expanded={settledShelfExpanded}
                                      data-testid="sidebar-settled-shelf-toggle"
                                      className={cn(
                                        "mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left transition-colors",
                                        collapsedHeaderDropOver &&
                                          "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-sidebar-ring/50",
                                      )}
                                    >
                                      <span
                                        className={cn(
                                          "text-xs font-medium",
                                          collapsedHeaderDropOver
                                            ? "text-sidebar-accent-foreground"
                                            : "text-muted-foreground/50",
                                        )}
                                      >
                                        {settledShelfExpanded
                                          ? "Settled"
                                          : `Settled (${settledThreads.length})`}
                                      </span>
                                      <span
                                        className={cn(
                                          "h-px flex-1",
                                          collapsedHeaderDropOver
                                            ? "bg-sidebar-ring/50"
                                            : "bg-sidebar-border/60",
                                        )}
                                      />
                                      <ChevronDownIcon
                                        aria-hidden
                                        className={cn(
                                          "size-3 transition-transform",
                                          settledShelfExpanded && "rotate-180",
                                          collapsedHeaderDropOver
                                            ? "text-sidebar-accent-foreground"
                                            : "text-muted-foreground/50",
                                        )}
                                      />
                                    </button>
                                  </div>
                                ) : null}
                                <ul
                                  role="list"
                                  aria-label="Settled threads"
                                  className="flex flex-col gap-px"
                                >
                                  {boardSections.settled.map((thread) =>
                                    renderThreadRow(thread, "settled"),
                                  )}
                                </ul>
                                {showSettledRail ? rail("settled", "Settled", isOver) : null}
                                {settledShelfExpanded && hiddenSettledCount > 0 ? (
                                  <button
                                    type="button"
                                    onClick={showMoreSettled}
                                    className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                                  >
                                    <PlusIcon aria-hidden className="size-4 shrink-0" />
                                    Show {Math.min(
                                      hiddenSettledCount,
                                      SETTLED_TAIL_PAGE_COUNT,
                                    )}{" "}
                                    more
                                  </button>
                                ) : null}
                              </li>
                            );
                          }}
                        </SidebarThreadSectionDropZone>
                      </>
                    );
                  })()}
                </ul>
                <DragOverlay adjustScale={false} dropAnimation={null}>
                  {dragTransaction?.phase === "dragging" && dragPreviewVariant !== null ? (
                    <SidebarThreadDragOverlayContent
                      transaction={dragTransaction}
                      variant={dragPreviewVariant}
                      projectTitle={
                        projectDisplayNameByKey.get(
                          `${dragTransaction.sourceThread.environmentId}:${dragTransaction.sourceThread.projectId}`,
                        ) ?? null
                      }
                      projectCwd={
                        projectCwdByKey.get(
                          `${dragTransaction.sourceThread.environmentId}:${dragTransaction.sourceThread.projectId}`,
                        ) ?? null
                      }
                      projectFaviconPath={
                        projectFaviconPathByKey.get(
                          `${dragTransaction.sourceThread.environmentId}:${dragTransaction.sourceThread.projectId}`,
                        ) ?? null
                      }
                    />
                  ) : null}
                </DragOverlay>
              </DndContext>
            </TooltipProvider>
          ) : null}
          {!isSearchingThreads &&
          visibleDraftSessionCount === 0 &&
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
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-[11px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
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
      <SidebarChromeFooter />
    </>
  );
}
