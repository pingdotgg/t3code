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
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ClockIcon,
  CloudIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  PlusIcon,
  SearchIcon,
  SquarePenIcon,
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
import { useUiStateStore } from "../uiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { openCommandPalette } from "../commandPaletteBus";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { useClientSettings } from "../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../state/server";
import { vcsEnvironment } from "../state/vcs";
import { threadEnvironment } from "../state/threads";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { cn } from "~/lib/utils";
import {
  firstValidTimestampMs,
  hasUnseenCompletion,
  isTrailingDoubleClick,
  resolveAdjacentThreadId,
  resolveSidebarV2Status,
  sortThreadsForSidebarV2,
} from "./Sidebar.logic";
import { prStatusIndicator, resolveThreadPr } from "./ThreadStatusIndicators";
import {
  resolveSnoozePresets,
  snoozeWakeDescription,
  snoozeWakeLabel,
  type SnoozePreset,
} from "./Sidebar.snooze";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../providerInstances";
import { primaryServerProvidersAtom } from "../state/server";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { CommandDialogTrigger } from "./ui/command";
import { Kbd } from "./ui/kbd";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more.
const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;

function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function threadTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  return compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

/**
 * Hover entry point for snooze: a clock button opening the preset menu.
 * Kept as its own component so each row owns its popover state without
 * widening the memoized row's prop surface.
 */
function SnoozePopoverButton(props: {
  onSnooze: (preset: SnoozePreset) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { onSnooze, onOpenChange } = props;
  const [open, setOpen] = useState(false);
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );
  // Presets resolve at open time so "In 1 hour" is relative to the click,
  // not to when the row mounted.
  const presets = useMemo(() => (open ? resolveSnoozePresets(new Date()) : []), [open]);
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Snooze thread"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            className="inline-flex h-full items-center gap-0.5 rounded-md border border-border bg-background px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
          />
        }
      >
        <ClockIcon className="size-3" />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-56" viewportClassName="p-1">
        <div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
          Snooze until
        </div>
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              handleOpenChange(false);
              onSnooze(preset);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 hover:bg-accent hover:text-foreground"
          >
            <span className="flex-1">{preset.label}</span>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
              {snoozeWakeDescription(preset.snoozedUntil, new Date())}
            </span>
          </button>
        ))}
        <div className="mx-1.5 my-1 h-px bg-border/60" />
        {/* Roadmap teasers: event-based wake conditions. Visible-but-disabled
            on purpose — they teach the mental model before they exist. */}
        <div className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground/45">
          <span className="flex-1">Until PR merges</span>
          <span className="rounded-full bg-primary/10 px-1.5 text-[9px] font-semibold tracking-wide text-primary/70">
            SOON
          </span>
        </div>
        <div className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground/45">
          <span className="flex-1">Until next review</span>
          <span className="rounded-full bg-primary/10 px-1.5 text-[9px] font-semibold tracking-wide text-primary/70">
            SOON
          </span>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

const SidebarV2Row = memo(function SidebarV2Row(props: {
  thread: SidebarThreadSummary;
  variant: "card" | "slim";
  // Slim rows are settled (action: un-settle) or snoozed (action: wake);
  // card rows offer settle.
  variantAction: "settle" | "unsettle" | "unsnooze";
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
  onChangeRequestState: (threadKey: string, state: "open" | "closed" | "merged" | null) => void;
}) {
  const {
    isRenaming,
    onChangeRequestState,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onRenameTitleChange,
    onSettle,
    onSnooze,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onUnsettle,
    onUnsnooze,
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
  // shows the pill; visiting clears it.
  const isWoke =
    props.wokeAt !== null &&
    (lastVisitedAt === undefined || Date.parse(lastVisitedAt) < Date.parse(props.wokeAt));
  const shouldRecede = status === "ready" && !isUnread && !isWoke && !props.isActive && !isSelected;
  const topStatus =
    status === "working"
      ? {
          label: "Working",
          icon: "working" as const,
          className:
            "animate-sidebar-working-text font-semibold text-blue-600 motion-reduce:animate-none dark:text-blue-400",
        }
      : status === "approval"
        ? {
            label: "Approval",
            icon: null,
            className: "font-semibold text-amber-700 dark:text-amber-300",
          }
        : status === "input"
          ? {
              label: "Input",
              icon: null,
              className: "font-semibold text-amber-700 dark:text-amber-300",
            }
          : status === "failed"
            ? {
                label: "Failed",
                icon: null,
                className: "font-semibold text-red-700 dark:text-red-300",
              }
            : isWoke
              ? {
                  label: "Woke",
                  icon: "woke" as const,
                  className: "font-semibold text-amber-700 dark:text-amber-300",
                }
              : isUnread
                ? {
                    label: "Done",
                    icon: "done" as const,
                    className: "font-semibold text-emerald-700 dark:text-emerald-300",
                  }
                : null;

  const gitCwd = thread.worktreePath ?? props.projectCwd;
  const gitStatus = useEnvironmentQuery(
    thread.branch != null && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
  // Report the PR state up: the parent partitions rows with effectiveSettled,
  // and a merged/closed PR auto-settles a thread — data only rows have.
  const prState = pr?.state ?? null;
  useEffect(() => {
    onChangeRequestState(threadKey, prState);
  }, [onChangeRequestState, prState, threadKey]);

  const modelInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const driverKind = props.providerEntryByInstanceId.get(modelInstanceId)?.driverKind ?? null;

  const isRemote =
    props.currentEnvironmentId !== null && thread.environmentId !== props.currentEnvironmentId;

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
  const handleSnoozePreset = useCallback(
    (preset: SnoozePreset) => {
      onSnooze(threadRef, preset);
    },
    [onSnooze, threadRef],
  );
  // While the snooze popover is open the pointer leaves the row, which
  // would fade the hover actions out from under the open menu; pin them.
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
  // Snooze is offered only where it can succeed: capability-gated and never
  // on blocked-on-you work (the server would reject it anyway).
  const showSnoozeButton = props.snoozeSupported && canSnooze(thread);
  const handlePrClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (pr?.url) openPrLink(event, pr.url);
    },
    [openPrLink, pr],
  );

  const rowClassName = cn(
    "group/v2-row relative w-full cursor-pointer select-none rounded-md text-left",
    props.isActive
      ? "bg-foreground/[0.11] text-foreground dark:bg-white/[0.11]"
      : isSelected
        ? "bg-foreground/[0.07] text-foreground dark:bg-white/[0.07]"
        : "hover:bg-accent/65",
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
      className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1 text-[13px] text-foreground outline-none focus:border-foreground"
    />
  ) : (
    <span
      className={cn(
        "min-w-0 flex-1 text-[13px] leading-5",
        variant === "card"
          ? cn(
              "line-clamp-2 break-words",
              isUnread || isWoke
                ? "font-semibold text-foreground"
                : status !== "ready"
                  ? "font-semibold text-foreground/95"
                  : shouldRecede
                    ? "font-normal text-muted-foreground/75"
                    : "font-medium text-foreground/90",
            )
          : cn(
              "truncate transition-colors group-hover/v2-row:text-foreground",
              props.isActive
                ? "text-foreground"
                : isUnread
                  ? "font-medium text-muted-foreground"
                  : "text-muted-foreground/60",
            ),
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
          "shrink-0 font-mono text-[10px] hover:underline",
          variant === "slim" && variantAction === "unsettle"
            ? props.isActive
              ? "text-muted-foreground/70"
              : "text-muted-foreground/35 transition-colors group-hover/v2-row:text-muted-foreground/65"
            : prStatus.colorClass,
        )}
        aria-label={prStatus.tooltip}
      >
        #{pr.number}
      </button>
    ) : null;

  if (variant === "slim") {
    return (
      <li
        data-thread-item
        className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_34px]"
      >
        <div
          role="button"
          tabIndex={0}
          data-testid="sidebar-v2-row-slim"
          className={cn(rowClassName, "flex h-[34px] items-center gap-2.5 px-2.5")}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
          onContextMenu={handleContextMenu}
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
              className="size-3.5"
              fallbackIcon={MessageSquareIcon}
            />
          </span>
          {title}
          {/* The PR badge stays outside the hover-fading slot: it must
              remain visible AND clickable while the row is hovered. Only
              the time/jump label yields to the settle affordance. */}
          {prBadge}
          <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end">
            <span className="inline-flex justify-end tabular-nums text-muted-foreground/40 transition-opacity group-hover/v2-row:opacity-0">
              {variantAction === "unsnooze" && props.snoozeWakeLabelText !== null ? (
                // Snoozed rows show when they come BACK, not when they were
                // last touched — the return ticket is the row's whole story.
                <span className="inline-flex items-center gap-1 font-mono text-[11px] text-primary/70">
                  <ClockIcon aria-hidden className="size-3" />
                  {props.snoozeWakeLabelText}
                </span>
              ) : (
                <span className="text-[13px]">
                  {props.jumpLabel ??
                    compactSidebarTimeLabel(
                      formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt),
                    )}
                </span>
              )}
            </span>
            {variantAction === "unsnooze" ? (
              !props.snoozeSupported ? null : (
                <button
                  type="button"
                  aria-label="Wake thread now"
                  onClick={handleUnsnoozeClick}
                  className="absolute inset-y-0 right-0 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/v2-row:opacity-100"
                >
                  <AlarmClockOffIcon className="size-3" />
                </button>
              )
            ) : !props.settlementSupported ? null : variantAction === "unsettle" ? (
              <button
                type="button"
                aria-label="Un-settle thread"
                onClick={handleUnsettleClick}
                className="absolute inset-y-0 right-0 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/v2-row:opacity-100"
              >
                <Undo2Icon className="size-3" />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Settle thread"
                onClick={handleSettleClick}
                className="absolute inset-y-0 right-0 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/v2-row:opacity-100"
              >
                <CheckIcon className="size-3" />
              </button>
            )}
          </span>
        </div>
      </li>
    );
  }

  const diff = latestTurnDiff(thread);

  return (
    <li
      data-thread-item
      className="list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_96px]"
    >
      <div
        role="button"
        tabIndex={0}
        data-testid="sidebar-v2-row-card"
        className={cn(
          // Every card carries a faint tonal fill so threads read as
          // discrete objects; active/selected/hover are brighter tones of
          // the same treatment rather than a different shape.
          "group/v2-row relative w-full cursor-pointer select-none overflow-hidden rounded-lg text-left transition-colors",
          props.isActive
            ? "bg-foreground/[0.11] text-foreground dark:bg-white/[0.11]"
            : isSelected
              ? "bg-foreground/[0.07] text-foreground dark:bg-white/[0.07]"
              : shouldRecede
                ? "bg-foreground/[0.025] hover:bg-accent/45 dark:bg-white/[0.025]"
                : "bg-foreground/[0.035] hover:bg-accent/65 dark:bg-white/[0.035]",
        )}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        <div className="relative z-10 px-2.5 py-2">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <ProjectFavicon
              environmentId={thread.environmentId}
              cwd={props.projectCwd ?? ""}
              className="size-3.5 shrink-0"
            />
            {props.projectTitle ? (
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px] leading-5 text-muted-foreground/70",
                  isUnread || status !== "ready"
                    ? "font-semibold"
                    : shouldRecede
                      ? "font-normal"
                      : "font-medium",
                )}
              >
                {props.projectTitle}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            <span className="relative ml-auto flex h-5 min-w-8 shrink-0 items-center justify-end pl-1 text-[13px]">
              <span
                className={cn(
                  "tabular-nums text-muted-foreground/55 transition-opacity group-hover/v2-row:opacity-0",
                  snoozeMenuOpen && "opacity-0",
                )}
              >
                {props.jumpLabel ? (
                  props.jumpLabel
                ) : topStatus ? (
                  <span
                    role="status"
                    className={cn(
                      "inline-flex items-center gap-1 text-[11px]",
                      topStatus.className,
                    )}
                  >
                    {topStatus.icon === "working" ? (
                      <CircleDashedIcon aria-hidden className="size-3" />
                    ) : topStatus.icon === "done" ? (
                      <CircleCheckIcon aria-hidden className="size-3" />
                    ) : topStatus.icon === "woke" ? (
                      <AlarmClockIcon aria-hidden className="size-3" />
                    ) : null}
                    {topStatus.label}
                  </span>
                ) : (
                  threadTimeLabel(thread)
                )}
              </span>
              {props.settlementSupported || showSnoozeButton ? (
                <span
                  className={cn(
                    "absolute inset-y-0 right-0 flex items-stretch gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/v2-row:opacity-100",
                    snoozeMenuOpen && "opacity-100",
                  )}
                >
                  {showSnoozeButton ? (
                    <SnoozePopoverButton
                      onSnooze={handleSnoozePreset}
                      onOpenChange={setSnoozeMenuOpen}
                    />
                  ) : null}
                  {props.settlementSupported ? (
                    <button
                      type="button"
                      aria-label="Settle thread"
                      onClick={handleSettleClick}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      <CheckIcon className="size-3" />
                      Settle
                    </button>
                  ) : null}
                </span>
              ) : null}
            </span>
          </div>
          <div className="mt-1 flex min-w-0">{title}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/65">
            {thread.branch ? (
              <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-mono [mask-image:linear-gradient(to_right,#000_0,#000_calc(100%-1rem),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,#000_0,#000_calc(100%-1rem),transparent_100%)]">
                {thread.branch}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            {prBadge}
            {diff ? (
              <span className="shrink-0 font-mono">
                <span className="text-emerald-600 dark:text-emerald-400">+{diff.insertions}</span>{" "}
                <span className="text-red-600 dark:text-red-400">−{diff.deletions}</span>
              </span>
            ) : null}
            <span className="ml-auto inline-flex shrink-0 items-center gap-1">
              {driverKind ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="inline-flex shrink-0 items-center opacity-60" />}
                  >
                    <ProviderInstanceIcon
                      driverKind={driverKind}
                      displayName={thread.session?.providerName ?? modelInstanceId}
                      iconClassName="size-3"
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{thread.modelSelection.model}</TooltipPopup>
                </Tooltip>
              ) : null}
              {isRemote ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex shrink-0 items-center text-muted-foreground/50" />
                    }
                  >
                    <CloudIcon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    Running on {props.environmentLabel ?? "a remote environment"}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          </div>
          {status === "failed" && thread.session?.lastError ? (
            <div
              className="mt-0.5 min-w-0 truncate text-[10px] text-red-600/75 dark:text-red-400/70"
              title={thread.session.lastError}
            >
              {thread.session.lastError}
            </div>
          ) : null}
        </div>
      </div>
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

export default function SidebarV2() {
  const projects = useProjects();
  const threads = useThreadShells();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const autoSettleAfterDays = useClientSettings((s) => s.sidebarAutoSettleAfterDays);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const { settleThread, unsettleThread, snoozeThread, unsnoozeThread, deleteThread } =
    useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
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
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
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
  const projectTitleByKey = useMemo(
    () =>
      new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project.title])),
    [projects],
  );

  // now is quantized to the minute so effectiveSettled memoization doesn't
  // churn on every render; auto-settle thresholds are day-granular anyway.
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  useEffect(() => {
    const id = window.setInterval(
      () => setNowMinute(new Date().toISOString().slice(0, 16)),
      60_000,
    );
    return () => window.clearInterval(id);
  }, []);

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

  // Project scope: chips above the list. Scoping filters the list AND
  // becomes the new-thread target — one visible control doing both jobs the
  // old per-project headers did.
  const [projectScopeKey, setProjectScopeKey] = useState<string | null>(null);
  const scopedProject = useMemo(
    () =>
      projectScopeKey === null
        ? null
        : (projects.find(
            (project) => `${project.environmentId}:${project.id}` === projectScopeKey,
          ) ?? null),
    [projectScopeKey, projects],
  );
  useEffect(() => {
    if (
      projectScopeKey !== null &&
      !projects.some((project) => `${project.environmentId}:${project.id}` === projectScopeKey)
    ) {
      setProjectScopeKey(null);
    }
  }, [projectScopeKey, projects]);
  // Scope flips drop the selection: rows selected under the old scope may be
  // hidden now, and bulk actions must never count or touch invisible rows.
  useEffect(() => {
    clearSelection();
  }, [clearSelection, projectScopeKey]);

  // Settled threads stay in the live shell stream (settled ≠ archived), so
  // the partition works directly off live shells: no archived-snapshot
  // merging, no optimistic holds. Archived threads remain hidden here —
  // archive keeps its original "remove from sidebar" meaning.
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const { activeThreads, snoozedThreads, settledThreads } = useMemo(() => {
    const now = `${nowMinute}:00.000Z`;
    const visible = threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        (scopedProject === null ||
          (thread.environmentId === scopedProject.environmentId &&
            thread.projectId === scopedProject.id)),
    );
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
      const changeRequestState = changeRequestStateByKey.get(threadKey) ?? null;
      // Snooze outranks settled classification: an explicitly snoozed thread
      // belongs to the shelf even if it would also auto-settle (the shelf's
      // wake time is a stronger statement about when it matters again).
      if (supportsSnooze && effectiveSnoozed(thread, { now })) {
        snoozed.push(thread);
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
      activeThreads: sortThreadsForSidebarV2(active),
      // Soonest wake first: "what comes back next" is the shelf's question.
      snoozedThreads: snoozed.toSorted(
        (left, right) =>
          firstValidTimestampMs(left.snoozedUntil ?? null) -
          firstValidTimestampMs(right.snoozedUntil ?? null),
      ),
      settledThreads: settled.toSorted(
        (left, right) =>
          firstValidTimestampMs(right.latestUserMessageAt, right.updatedAt) -
          firstValidTimestampMs(left.latestUserMessageAt, left.updatedAt),
      ),
    };
  }, [
    autoSettleAfterDays,
    changeRequestStateByKey,
    nowMinute,
    scopedProject,
    serverConfigs,
    threads,
  ]);

  // The settled tail renders in pages: history shouldn't dominate the
  // sidebar, and the common lookups are recent. Expansion resets when the
  // filter context changes so a scope/search flip never inherits a deep
  // page state.
  const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_TAIL_INITIAL_COUNT);
  const settledResetKey = `${projectScopeKey ?? "all"}`;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(SETTLED_TAIL_INITIAL_COUNT);
  }
  const hiddenSettledCount = Math.max(0, settledThreads.length - settledVisibleCount);
  const visibleSettledThreads = useMemo(
    () => (hiddenSettledCount > 0 ? settledThreads.slice(0, settledVisibleCount) : settledThreads),
    [hiddenSettledCount, settledThreads, settledVisibleCount],
  );
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + SETTLED_TAIL_PAGE_COUNT),
    [],
  );

  // The snoozed shelf is collapsed by default: out of the way, never gone.
  // Collapsed threads don't render (and so don't participate in jump
  // shortcuts or multi-select), matching the settled tail's paging model.
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useState(false);
  const toggleSnoozedShelf = useCallback(() => setSnoozedShelfExpanded((value) => !value), []);
  const visibleSnoozedThreads = snoozedShelfExpanded ? snoozedThreads : [];

  const orderedThreads = useMemo(
    () => [...activeThreads, ...visibleSnoozedThreads, ...visibleSettledThreads],
    [activeThreads, visibleSnoozedThreads, visibleSettledThreads],
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
  const attemptSettle = useCallback(
    (threadRef: ScopedThreadRef, opts: { coSettlingKeys?: ReadonlySet<string> } = {}) => {
      void (async () => {
        const threadKey = scopedThreadKey(threadRef);
        if (settlingThreadKeysRef.current.has(threadKey)) return;
        settlingThreadKeysRef.current.add(threadKey);
        try {
          // Settling the thread you're looking at moves you forward: the next
          // remaining card (never a settled or snoozed row, never one
          // settling in the same batch), or a fresh draft in this project
          // when it was the last active one. Snapshot the target before the
          // settle mutates the partition. Background settles never navigate.
          const shell = threadByKeyRef.current.get(threadKey);
          let navigateAfterSettle: (() => void) | null = null;
          if (routeThreadKey === threadKey) {
            const orderedKeys = orderedThreadKeysRef.current;
            const settledKeys = settledThreadKeysRef.current;
            const snoozedKeys = snoozedThreadKeysRef.current;
            const currentIndex = orderedKeys.indexOf(threadKey);
            const nextCardKey =
              currentIndex === -1
                ? null
                : ([
                    ...orderedKeys.slice(currentIndex + 1),
                    ...orderedKeys.slice(0, currentIndex),
                  ].find(
                    (key) =>
                      !settledKeys.has(key) &&
                      !snoozedKeys.has(key) &&
                      !opts.coSettlingKeys?.has(key),
                  ) ?? null);
            const nextThread = nextCardKey ? threadByKeyRef.current.get(nextCardKey) : null;
            navigateAfterSettle = nextThread
              ? () => navigateToThread(scopeThreadRef(nextThread.environmentId, nextThread.id))
              : shell
                ? () =>
                    void handleNewThreadRef.current(
                      scopeProjectRef(shell.environmentId, shell.projectId),
                    )
                : () => void router.navigate({ to: "/" });
          }
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
    [navigateToThread, routeThreadKey, router, settleThread],
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
  // One snooze per thread at a time — same double-dispatch guard as settle.
  const snoozingThreadKeysRef = useRef(new Set<string>());
  const attemptSnooze = useCallback(
    (threadRef: ScopedThreadRef, preset: SnoozePreset) => {
      void (async () => {
        const threadKey = scopedThreadKey(threadRef);
        if (snoozingThreadKeysRef.current.has(threadKey)) return;
        snoozingThreadKeysRef.current.add(threadKey);
        try {
          const result = await snoozeThread(threadRef, preset.snoozedUntil);
          if (result._tag === "Failure") {
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
              title: `Snoozed until ${snoozeWakeDescription(preset.snoozedUntil, new Date())}`,
              timeout: 5_000,
              actionProps: {
                children: "Undo",
                onClick: () => attemptUnsnooze(threadRef),
              },
            }),
          );
        } finally {
          snoozingThreadKeysRef.current.delete(threadKey);
        }
      })();
    },
    [attemptUnsnooze, snoozeThread],
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
      const snoozableThreads = threadKeys.flatMap((threadKey) => {
        const thread = threadByKeyRef.current.get(threadKey);
        return thread ? [thread] : [];
      });
      const canSnoozeSelection =
        snoozableThreads.length === count &&
        snoozableThreads.every(
          (thread) =>
            serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze ===
              true && canSnooze(thread),
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
                      label: `${preset.label} (${snoozeWakeDescription(preset.snoozedUntil, new Date())})`,
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
          for (const thread of snoozableThreads) {
            attemptSnooze(scopeThreadRef(thread.environmentId, thread.id), preset);
          }
          clearSelection();
        }
        return;
      }
      if (clicked.value === "settle") {
        // Post-settle navigation must skip threads settling in this same
        // batch — they are all leaving the card block together. Rows that
        // are already explicitly settled are skipped: nothing to do on a
        // valid mixed selection.
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
        // Presets resolve at menu-open time (same as the popover).
        const snoozePresets = resolveSnoozePresets(new Date());
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
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
                          disabled: !canSnooze(thread),
                          children: snoozePresets.map((preset) => ({
                            id: `snooze:${preset.id}`,
                            label: `${preset.label} (${snoozeWakeDescription(preset.snoozedUntil, new Date())})`,
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
    if (projects.length <= 1) {
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
  }, [isMobile, newThreadContext, projects.length, setOpenMobile]);

  const commandPaletteShortcutLabel = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  // Same resolution as v1: prefer the local-thread binding, fall back to
  // chat.new, no platform gating — web users have working shortcuts too.
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal") ??
    shortcutLabelForCommand(keybindings, "chat.new");
  const projectScrollerRef = useRef<HTMLDivElement>(null);
  const [canScrollProjectsRight, setCanScrollProjectsRight] = useState(false);
  const updateProjectScrollFade = useCallback(() => {
    const scroller = projectScrollerRef.current;
    if (!scroller) return;
    setCanScrollProjectsRight(
      scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1,
    );
  }, []);
  useEffect(() => {
    const scroller = projectScrollerRef.current;
    if (!scroller) return;

    updateProjectScrollFade();
    const resizeObserver = new ResizeObserver(updateProjectScrollFade);
    resizeObserver.observe(scroller);
    return () => resizeObserver.disconnect();
  }, [projects, updateProjectScrollFade]);

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="gap-0">
        <SidebarGroup className="px-2 pb-2 pt-3">
          <SidebarMenu className="flex-row gap-1">
            <SidebarMenuItem className="min-w-0 flex-1">
              <CommandDialogTrigger
                render={
                  <SidebarMenuButton
                    size="sm"
                    className="gap-2 border border-border bg-background/60 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-0"
                    data-testid="command-palette-trigger"
                  />
                }
              >
                <SearchIcon className="size-3.5 text-muted-foreground/70" />
                <span className="flex-1 truncate text-left text-xs">Search</span>
                {commandPaletteShortcutLabel ? (
                  <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">
                    {commandPaletteShortcutLabel}
                  </Kbd>
                ) : null}
              </CommandDialogTrigger>
            </SidebarMenuItem>
            <SidebarMenuItem className="shrink-0">
              <SidebarMenuButton
                size="sm"
                className="size-7 justify-center border border-border bg-background/60 p-0 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                onClick={handleNewThreadClick}
                disabled={projects.length === 0}
                aria-label="New thread"
                tooltip={{
                  children: newThreadShortcutLabel
                    ? `New thread (${newThreadShortcutLabel})`
                    : "New thread",
                  side: "right",
                }}
              >
                <SquarePenIcon className="size-3.5 text-muted-foreground/70" />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {projects.length > 0 ? (
          <SidebarGroup className="px-2 pb-1 pt-1">
            <div className="relative">
              <div
                ref={projectScrollerRef}
                onScroll={updateProjectScrollFade}
                className={cn(
                  "flex items-center gap-1 overflow-x-auto pr-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                  canScrollProjectsRight &&
                    "[mask-image:linear-gradient(to_right,#000_0,#000_calc(100%-4.5rem),transparent_calc(100%-2rem))] [-webkit-mask-image:linear-gradient(to_right,#000_0,#000_calc(100%-4.5rem),transparent_calc(100%-2rem))]",
                )}
                role="tablist"
                aria-label="Filter threads by project"
              >
                {projects.length > 1 ? (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={projectScopeKey === null}
                    onClick={() => setProjectScopeKey(null)}
                    className={cn(
                      "shrink-0 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
                      projectScopeKey === null
                        ? "border-foreground/15 bg-accent text-foreground"
                        : "border-black/15 text-muted-foreground hover:border-black/40 hover:text-foreground dark:border-white/15 dark:hover:border-white/40",
                    )}
                  >
                    All
                  </button>
                ) : null}
                {projects.map((project) => {
                  const scopeKey = `${project.environmentId}:${project.id}`;
                  const isScoped = projectScopeKey === scopeKey;
                  return (
                    <button
                      key={scopeKey}
                      type="button"
                      role="tab"
                      aria-selected={isScoped}
                      onClick={() => setProjectScopeKey(isScoped ? null : scopeKey)}
                      className={cn(
                        "flex shrink-0 items-center gap-1.5 rounded-md border py-1 pl-1.5 pr-2.5 text-[11px] font-medium transition-colors",
                        isScoped
                          ? "border-foreground/15 bg-accent text-foreground"
                          : "border-black/15 text-muted-foreground hover:border-black/40 hover:text-foreground dark:border-white/15 dark:hover:border-white/40",
                      )}
                    >
                      <ProjectFavicon
                        environmentId={project.environmentId}
                        cwd={project.workspaceRoot}
                        className="size-3.5"
                      />
                      <span className="max-w-28 truncate">{project.title}</span>
                    </button>
                  );
                })}
              </div>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex w-12 items-center justify-end bg-gradient-to-r from-transparent via-card/90 to-card">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label="Add project"
                        onClick={openAddProjectCommandPalette}
                        className="pointer-events-auto flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground/70 shadow-sm transition-colors hover:bg-accent hover:text-foreground"
                      />
                    }
                  >
                    <FolderPlusIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">Add project</TooltipPopup>
                </Tooltip>
              </div>
            </div>
          </SidebarGroup>
        ) : null}
        <SidebarGroup className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          <ul ref={attachListAutoAnimateRef} className="flex flex-col gap-px">
            {(() => {
              const renderThreadRow = (
                thread: EnvironmentThreadShell,
                section: "active" | "snoozed" | "settled",
              ) => {
                const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
                // Settled and snoozed are the ONLY things that collapse a
                // row: every other thread is a full card. Density comes from
                // users (or the auto rules) actually parking work, not from
                // the sidebar second-guessing what still matters.
                const isCard = section === "active";
                const rowVariant = isCard ? "card" : "slim";
                return (
                  <SidebarV2Row
                    // Keyed per variant on purpose: when a thread settles,
                    // the card fades out in place and the slim row fades in
                    // at its settled position instead of one element
                    // FLIP-sliding through every row in between (rows here
                    // are translucent, so a crossing row reads as text
                    // painted over text).
                    key={`${threadKey}:${rowVariant}`}
                    thread={thread}
                    variant={rowVariant}
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
                    snoozeWakeLabelText={
                      section === "snoozed" && thread.snoozedUntil != null
                        ? snoozeWakeLabel(thread.snoozedUntil, new Date())
                        : null
                    }
                    wokeAt={isCard ? threadWokeAt(thread, { now: `${nowMinute}:00.000Z` }) : null}
                    isActive={routeThreadKey === threadKey}
                    jumpLabel={showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
                    currentEnvironmentId={primaryEnvironmentId}
                    environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                    projectCwd={
                      projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                    }
                    projectTitle={
                      projectTitleByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
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
                    onSettle={attemptSettle}
                    onUnsettle={attemptUnsettle}
                    onSnooze={attemptSnooze}
                    onUnsnooze={attemptUnsnooze}
                    onChangeRequestState={handleChangeRequestState}
                  />
                );
              };
              const items: ReactNode[] = activeThreads.map((thread) =>
                renderThreadRow(thread, "active"),
              );
              // Snoozed shelf: between the inbox and Settled — out of the
              // way, never gone. The header is always rendered while
              // anything is snoozed (the count is the whole footprint when
              // collapsed); rows only when expanded. Vanishes entirely at
              // count 0.
              if (snoozedThreads.length > 0) {
                items.push(
                  <li key="snoozed-shelf-header" data-thread-selection-safe className="list-none">
                    <button
                      type="button"
                      onClick={toggleSnoozedShelf}
                      aria-expanded={snoozedShelfExpanded}
                      data-testid="sidebar-v2-snoozed-shelf-toggle"
                      className="mb-1 mt-3 flex w-full items-center gap-2 px-2.5 text-left"
                    >
                      <ChevronRightIcon
                        aria-hidden
                        className={cn(
                          "size-3 text-primary/60 transition-transform",
                          snoozedShelfExpanded && "rotate-90",
                        )}
                      />
                      <span className="text-[10px] font-medium text-primary/70">
                        Snoozed · {snoozedThreads.length}
                      </span>
                      <span className="h-px flex-1 bg-primary/15" />
                    </button>
                  </li>,
                );
                for (const thread of visibleSnoozedThreads) {
                  items.push(renderThreadRow(thread, "snoozed"));
                }
              }
              // The divider is its own keyed list item (not part of the
              // first settled row): it keeps one stable DOM node at the
              // boundary, so settling a thread slides it instead of
              // teleporting it along with whichever row happens to be first
              // in the tail. Matching the pre-shelf behavior, it only shows
              // when something sits above it.
              if (
                visibleSettledThreads.length > 0 &&
                (activeThreads.length > 0 || snoozedThreads.length > 0)
              ) {
                items.push(
                  <li
                    key="settled-divider"
                    aria-hidden
                    data-thread-selection-safe
                    className="list-none"
                  >
                    <div className="mb-1 mt-3 flex items-center gap-2 px-2.5">
                      <span className="text-[10px] font-medium text-muted-foreground/50">
                        Settled
                      </span>
                      <span className="h-px flex-1 bg-border/60" />
                    </div>
                  </li>,
                );
              }
              for (const thread of visibleSettledThreads) {
                items.push(renderThreadRow(thread, "settled"));
              }
              return items;
            })()}
            {hiddenSettledCount > 0 ? (
              <li className="list-none">
                <button
                  type="button"
                  onClick={showMoreSettled}
                  className="mt-1 flex h-[30px] w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-black/15 font-mono text-[11px] text-muted-foreground transition-colors hover:border-solid hover:border-black/30 hover:text-foreground dark:border-white/15 dark:hover:border-white/30"
                >
                  Show {Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more
                  <span className="text-muted-foreground/50">
                    ({hiddenSettledCount} settled hidden)
                  </span>
                </button>
              </li>
            ) : null}
          </ul>
          {orderedThreads.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
              {projects.length === 0 ? (
                <>
                  <span>No projects yet</span>
                  <button
                    type="button"
                    onClick={openAddProjectCommandPalette}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <PlusIcon className="size-3" />
                    Add project
                  </button>
                </>
              ) : scopedProject ? (
                `No threads in ${scopedProject.title} yet`
              ) : (
                "No threads yet"
              )}
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <SidebarSeparator />
      <SidebarChromeFooter />
    </>
  );
}
