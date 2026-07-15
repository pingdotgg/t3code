import { autoAnimate } from "@formkit/auto-animate";
import { useAtomValue } from "@effect/atom-react";
import { effectiveSettled } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon, CloudIcon, PlusIcon, SearchIcon, Undo2Icon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
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
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
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
import { useOpenAddProjectCommandPalette } from "../commandPaletteContext";
import { onOpenNewThreadPicker } from "../newThreadPickerBus";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import {
  resolveThreadActionProjectRef,
  startNewThreadFromContext,
  startNewThreadInProjectFromContext,
} from "../lib/chatThreadActions";
import { useClientSettings } from "../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { vcsEnvironment } from "../state/vcs";
import { threadEnvironment } from "../state/threads";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { cn } from "~/lib/utils";
import {
  isTrailingDoubleClick,
  resolveAdjacentThreadId,
  resolveSidebarV2Status,
  sortThreadsForSidebarV2,
  type SidebarV2Status,
} from "./Sidebar.logic";
import { prStatusIndicator, resolveThreadPr } from "./ThreadStatusIndicators";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Row heights are fixed per variant so the list only changes shape at
// lifecycle transitions (settle/unsettle), never from streaming updates.
// Cards are square, hard-edged blocks: a solid full-saturation edge strip
// carries the state color; the border stays neutral and high-contrast.
const CARD_EDGE_BY_STATUS: Partial<Record<SidebarV2Status, string>> = {
  approval: "bg-amber-500 dark:bg-amber-400",
  working: "bg-sky-500 animate-status-pulse dark:bg-sky-400",
  failed: "bg-red-500",
};

const STATUS_WORD_BY_STATUS: Partial<
  Record<SidebarV2Status, { label: string; className: string }>
> = {
  approval: { label: "Needs approval", className: "text-amber-600 dark:text-amber-400" },
  working: { label: "Working", className: "text-sky-600 dark:text-sky-400" },
  failed: { label: "Failed", className: "text-red-600 dark:text-red-400" },
};

// The working timer re-renders once per second only for rows that show it.
function useTickWhile(active: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(id);
  }, [active]);
  return active ? Date.now() : 0;
}

function threadTimeLabel(thread: SidebarThreadSummary, status: SidebarV2Status): string {
  if (status === "working" && thread.latestTurn?.startedAt) {
    return formatElapsedDurationLabel(thread.latestTurn.startedAt);
  }
  if (status === "approval") {
    // Approval activities bump shell.updatedAt in the projection pipeline.
    // The shell has no dedicated request timestamp, so this is the closest
    // accurate wait-start signal shared by the label and approval ordering.
    return `waiting ${formatElapsedDurationLabel(thread.updatedAt)}`;
  }
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  return formatRelativeTimeLabel(timestamp);
}

const SidebarV2Row = memo(function SidebarV2Row(props: {
  thread: SidebarThreadSummary;
  variant: "card" | "slim";
  // Slim rows are either settled (action: un-settle) or merely quiet
  // (seen Ready threads — action: settle).
  variantAction: "settle" | "unsettle";
  // Draws a hairline above the first settled row after a group's card
  // block, so active work and the history tail read as separate zones
  // inside each project section.
  showQuietDivider?: boolean;
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
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onUnsettle,
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

  const status = resolveSidebarV2Status(thread);
  useTickWhile(variant === "card" && (status === "working" || status === "approval"));

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

  const isUnread =
    thread.latestTurn?.completedAt != null &&
    (lastVisitedAt == null ||
      Date.parse(thread.latestTurn.completedAt) > Date.parse(lastVisitedAt));

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
  const handlePrClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (pr?.url) openPrLink(event, pr.url);
    },
    [openPrLink, pr],
  );

  const rowClassName = cn(
    "group/v2-row relative w-full cursor-pointer select-none text-left",
    props.isActive
      ? "bg-foreground/10 dark:bg-white/[0.12]"
      : isSelected
        ? "bg-primary/15 dark:bg-primary/20"
        : "hover:bg-foreground/5 dark:hover:bg-white/[0.06]",
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
      className="min-w-0 flex-1 border border-border bg-background px-1 text-[13px] text-foreground outline-none focus:border-foreground"
    />
  ) : (
    <span
      className={cn(
        "min-w-0 flex-1 text-[13px] leading-5",
        // Cards get two lines of title — a truncated single line hid too much.
        variant === "card"
          ? cn(
              "line-clamp-2 break-words",
              isUnread ? "font-semibold text-foreground" : "font-medium text-foreground/90",
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
        className={cn("shrink-0 font-mono text-[10px] hover:underline", prStatus.colorClass)}
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
        {props.showQuietDivider ? (
          <div aria-hidden className="mb-1.5 mt-2.5 flex items-center gap-2 px-0.5">
            <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/60">
              Settled
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>
        ) : null}
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
            />
          </span>
          {title}
          {prBadge}
          <span className="relative flex h-6 w-14 shrink-0 items-center justify-end">
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground/40 transition-opacity group-hover/v2-row:opacity-0">
              {props.jumpLabel ??
                formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt)}
            </span>
            {variantAction === "unsettle" ? (
              <button
                type="button"
                aria-label="Un-settle thread"
                onClick={handleUnsettleClick}
                className="absolute inset-y-0 right-0 inline-flex items-center gap-1 border border-border bg-background px-2 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/v2-row:opacity-100"
              >
                <Undo2Icon className="size-3" />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Settle thread"
                onClick={handleSettleClick}
                className="absolute inset-y-0 right-0 inline-flex items-center gap-1 border border-border bg-background px-2 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/v2-row:opacity-100"
              >
                <CheckIcon className="size-3" />
              </button>
            )}
          </span>
        </div>
      </li>
    );
  }

  const statusEdge = CARD_EDGE_BY_STATUS[status];
  const statusWord = STATUS_WORD_BY_STATUS[status];
  const diff = latestTurnDiff(thread);
  const workingTimer =
    status === "working" && thread.latestTurn?.startedAt
      ? formatElapsedDurationLabel(thread.latestTurn.startedAt)
      : null;

  return (
    <li
      data-thread-item
      className="list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_100px]"
    >
      <div
        role="button"
        tabIndex={0}
        data-testid="sidebar-v2-row-card"
        className={cn(
          "group/v2-row relative w-full cursor-pointer select-none overflow-hidden border bg-card text-left transition-colors dark:bg-white/[0.04]",
          props.isActive
            ? "border-foreground/70 bg-foreground/5 dark:border-foreground/75 dark:bg-white/[0.08]"
            : isSelected
              ? "border-primary/70 bg-primary/10 dark:bg-primary/15"
              : "border-black/12 hover:border-black/30 dark:border-white/12 dark:hover:border-white/30",
        )}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        {statusEdge ? (
          <span aria-hidden className={cn("absolute inset-y-0 left-0 z-10 w-[3px]", statusEdge)} />
        ) : null}
        {/* Title bar: the card is a tiny window whose chrome carries project
            identity — favicon + name up top, separated by a hairline, so
            "which project" reads before the thread content does. */}
        <div
          className={cn(
            "flex items-center gap-1.5 border-b py-1 pl-[15px] pr-3",
            props.isActive
              ? "border-black/20 bg-black/[0.06] dark:border-white/25 dark:bg-white/[0.06]"
              : "border-black/10 bg-black/[0.03] dark:border-white/10 dark:bg-white/[0.03]",
          )}
        >
          <ProjectFavicon
            environmentId={thread.environmentId}
            cwd={props.projectCwd ?? ""}
            className="size-3"
          />
          {props.projectTitle ? (
            <span className="min-w-0 truncate font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {props.projectTitle}
            </span>
          ) : null}
          <span className="relative ml-auto flex h-4 w-16 shrink-0 items-center justify-end">
            <span
              className={cn(
                "font-mono text-[10px] tabular-nums transition-opacity group-hover/v2-row:opacity-0",
                status === "approval"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground/50",
              )}
            >
              {props.jumpLabel ?? workingTimer ?? threadTimeLabel(thread, status)}
            </span>
            <button
              type="button"
              aria-label="Settle thread"
              onClick={handleSettleClick}
              className="absolute inset-y-0 right-0 inline-flex items-center gap-1 border border-border bg-background px-2 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/v2-row:opacity-100"
            >
              <CheckIcon className="size-3" />
              Settle
            </button>
          </span>
        </div>
        <div className="py-2 pl-[15px] pr-3">
          <div className="flex items-start gap-2.5">
            {title}
            {diff ? (
              <span className="shrink-0 font-mono text-[11px] leading-5">
                <span className="text-emerald-600 dark:text-emerald-400">+{diff.insertions}</span>{" "}
                <span className="text-red-600 dark:text-red-400">−{diff.deletions}</span>
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground/70">
            {statusWord ? (
              <span
                className={cn(
                  "shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]",
                  statusWord.className,
                )}
              >
                {statusWord.label}
              </span>
            ) : null}
            {status === "failed" && thread.session?.lastError ? (
              <span className="min-w-0 truncate text-red-600/80 dark:text-red-400/80">
                {thread.session.lastError}
              </span>
            ) : (
              <>
                {thread.branch ? (
                  <span className="min-w-0 truncate font-mono text-muted-foreground/70">
                    {thread.branch}
                  </span>
                ) : null}
                {prBadge}
              </>
            )}
            <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
              {driverKind ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="inline-flex shrink-0 items-center opacity-70" />}
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
  const { settleThread, unsettleThread, archiveThread, deleteThread } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const newThreadContext = useHandleNewThread();
  const openAddProjectCommandPalette = useOpenAddProjectCommandPalette();
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

  const { activeThreads, settledThreads } = useMemo(() => {
    const now = `${nowMinute}:00.000Z`;
    const visible = threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        (scopedProject === null ||
          (thread.environmentId === scopedProject.environmentId &&
            thread.projectId === scopedProject.id)),
    );
    const active: EnvironmentThreadShell[] = [];
    const settled: EnvironmentThreadShell[] = [];
    for (const thread of visible) {
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const changeRequestState = changeRequestStateByKey.get(threadKey) ?? null;
      if (effectiveSettled(thread, { now, autoSettleAfterDays, changeRequestState })) {
        settled.push(thread);
      } else {
        active.push(thread);
      }
    }
    return {
      activeThreads: sortThreadsForSidebarV2(active),
      settledThreads: settled.toSorted(
        (left, right) =>
          Date.parse(right.latestUserMessageAt ?? right.updatedAt) -
          Date.parse(left.latestUserMessageAt ?? left.updatedAt),
      ),
    };
  }, [autoSettleAfterDays, changeRequestStateByKey, nowMinute, scopedProject, threads]);

  const orderedThreads = useMemo(
    () => [...activeThreads, ...settledThreads],
    [activeThreads, settledThreads],
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

  const attemptSettle = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await settleThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [settleThread],
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

  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            { id: "settle", label: `Settle (${count})` },
            { id: "mark-unread", label: `Mark unread (${count})` },
            { id: "delete", label: `Delete (${count})`, destructive: true },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure") return;
      if (clicked.value === "settle") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread) continue;
          attemptSettle(scopeThreadRef(thread.environmentId, thread.id));
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
      const deletedThreadKeys = new Set(threadKeys);
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
      }
      removeFromSelection(threadKeys);
    },
    [
      attemptSettle,
      clearSelection,
      confirmThreadDelete,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
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
        // Match what the user sees: a row renders slim iff it is in the
        // settled partition, so the menu label mirrors that exact state.
        const isSettled = settledThreadKeysRef.current.has(threadKey);
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              isSettled
                ? { id: "unsettle", label: "Un-settle thread" }
                : { id: "settle", label: "Settle thread" },
              { id: "rename", label: "Rename thread" },
              { id: "mark-unread", label: "Mark unread" },
              { id: "archive", label: "Archive" },
              { id: "delete", label: "Delete", destructive: true, icon: "trash" },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "settle":
            attemptSettle(threadRef);
            return;
          case "unsettle":
            attemptUnsettle(threadRef);
            return;
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "mark-unread":
            markThreadUnread(threadKey, thread.latestTurn?.completedAt);
            return;
          case "archive": {
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
      attemptSettle,
      attemptUnsettle,
      confirmThreadDelete,
      deleteThread,
      handleMultiSelectContextMenu,
      markThreadUnread,
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

  useEffect(() => {
    const sync = (event: KeyboardEvent) => setShowJumpHints(event.metaKey || event.ctrlKey);
    const clear = () => setShowJumpHints(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);

  const attachListAutoAnimateRef = useCallback((node: HTMLUListElement | null) => {
    if (!node) return;
    autoAnimate(node, { duration: 150, easing: "ease-out" });
  }, []);

  // New thread defaults to the project you're in (active thread's project,
  // falling back to the top project) — same resolution the command palette
  // uses. The chevron menu is the explicit project picker the flat list no
  // longer gets from per-project headers.
  const [newThreadPickerOpen, setNewThreadPickerOpen] = useState(false);
  // chat.new (mod+shift+o / mod+n) is handled by the _chat route layout; in
  // v2 with multiple projects it opens this picker via the event bus.
  useEffect(() => onOpenNewThreadPicker(() => setNewThreadPickerOpen(true)), []);
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
    setNewThreadPickerOpen(true);
  }, [isMobile, newThreadContext, projects.length, setOpenMobile]);
  const createThreadInProject = useCallback(
    (environmentId: (typeof projects)[number]["environmentId"], projectId: string) => {
      setNewThreadPickerOpen(false);
      if (isMobile) setOpenMobile(false);
      const project = projects.find(
        (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
      );
      if (!project) return;
      void startNewThreadInProjectFromContext(
        {
          activeDraftThread: newThreadContext.activeDraftThread,
          activeThread: newThreadContext.activeThread ?? undefined,
          defaultProjectRef: newThreadContext.defaultProjectRef,
          handleNewThread: newThreadContext.handleNewThread,
        },
        scopeProjectRef(project.environmentId, project.id),
      );
    },
    [isMobile, newThreadContext, projects, setOpenMobile],
  );
  const contextualProjectRef = resolveThreadActionProjectRef({
    activeDraftThread: newThreadContext.activeDraftThread,
    activeThread: newThreadContext.activeThread ?? undefined,
    defaultProjectRef: newThreadContext.defaultProjectRef,
    handleNewThread: newThreadContext.handleNewThread,
  });
  const newThreadTargetRef = scopedProject
    ? scopeProjectRef(scopedProject.environmentId, scopedProject.id)
    : contextualProjectRef;
  const newThreadTargetProject = newThreadTargetRef
    ? (projects.find(
        (project) =>
          project.environmentId === newThreadTargetRef.environmentId &&
          project.id === newThreadTargetRef.projectId,
      ) ?? null)
    : null;
  // Picker order: the contextual default first (preselected), everything else
  // after — the common case is Enter/click on the top row.
  const newThreadPickerProjects = useMemo(() => {
    if (!newThreadTargetProject) return projects;
    return [
      newThreadTargetProject,
      ...projects.filter(
        (project) =>
          project.environmentId !== newThreadTargetProject.environmentId ||
          project.id !== newThreadTargetProject.id,
      ),
    ];
  }, [newThreadTargetProject, projects]);

  const commandPaletteShortcutLabel = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  const newThreadShortcutLabel = shortcutLabelForCommand(keybindings, "chat.new");

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="gap-0">
        <SidebarGroup className="px-2 pt-2 pb-1">
          <SidebarMenu>
            <SidebarMenuItem>
              <CommandDialogTrigger
                render={
                  <SidebarMenuButton
                    size="sm"
                    className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-0"
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
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                onClick={handleNewThreadClick}
                disabled={projects.length === 0}
              >
                <PlusIcon className="size-3.5 text-muted-foreground/70" />
                <span className="flex-1 truncate text-left text-xs">New thread</span>
                {newThreadShortcutLabel ? (
                  <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">
                    {newThreadShortcutLabel}
                  </Kbd>
                ) : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {projects.length > 0 ? (
          <SidebarGroup className="px-2 pb-1 pt-0.5">
            <div
              className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
                    "shrink-0 border px-2.5 py-1 font-mono text-[11px] font-medium uppercase tracking-wide transition-colors",
                    projectScopeKey === null
                      ? "border-foreground bg-foreground text-background"
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
                      "flex shrink-0 items-center gap-1.5 border py-1 pl-1.5 pr-2.5 font-mono text-[11px] font-medium transition-colors",
                      isScoped
                        ? "border-foreground bg-foreground/10 text-foreground dark:bg-white/[0.1]"
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
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Add project"
                      onClick={openAddProjectCommandPalette}
                      className="flex size-6 shrink-0 items-center justify-center border border-dashed border-black/20 text-muted-foreground/60 transition-colors hover:border-solid hover:border-black/40 hover:text-foreground dark:border-white/20 dark:hover:border-white/40"
                    />
                  }
                >
                  <PlusIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Add project</TooltipPopup>
              </Tooltip>
            </div>
          </SidebarGroup>
        ) : null}
        <SidebarGroup className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          <ul ref={attachListAutoAnimateRef} className="flex flex-col gap-px">
            {orderedThreads.map((thread, threadIndex) => {
              const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
              const isSettledRow = settledThreadKeys.has(threadKey);
              // Settled is the ONLY thing that collapses a row: every
              // not-settled thread is a full card. Density comes from users
              // (or the auto rules) actually settling work, not from the
              // sidebar second-guessing what still matters.
              const isCard = !isSettledRow;
              const previousThread = threadIndex > 0 ? orderedThreads[threadIndex - 1] : null;
              const previousWasCard =
                previousThread != null &&
                !settledThreadKeys.has(
                  scopedThreadKey(scopeThreadRef(previousThread.environmentId, previousThread.id)),
                );
              const showQuietDivider = !isCard && previousWasCard;
              return (
                <SidebarV2Row
                  showQuietDivider={showQuietDivider}
                  key={threadKey}
                  thread={thread}
                  variant={isCard ? "card" : "slim"}
                  variantAction={isSettledRow ? "unsettle" : "settle"}
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
                  onChangeRequestState={handleChangeRequestState}
                />
              );
            })}
          </ul>
          {orderedThreads.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
              {projects.length === 0 ? (
                <>
                  <span>No projects yet</span>
                  <button
                    type="button"
                    onClick={openAddProjectCommandPalette}
                    className="inline-flex items-center gap-1.5 border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
      <Dialog open={newThreadPickerOpen} onOpenChange={setNewThreadPickerOpen}>
        <DialogPopup className="max-w-sm p-0">
          <DialogHeader className="px-4 pb-2 pt-4">
            <DialogTitle className="text-sm">New thread in…</DialogTitle>
          </DialogHeader>
          <div
            className="flex flex-col gap-0.5 px-2 pb-3"
            role="listbox"
            aria-label="Choose a project for the new thread"
            onKeyDown={(event) => {
              if (
                event.key !== "ArrowDown" &&
                event.key !== "ArrowUp" &&
                event.key !== "Home" &&
                event.key !== "End"
              ) {
                return;
              }
              const container = event.currentTarget;
              const options = [...container.querySelectorAll<HTMLButtonElement>("button")];
              if (options.length === 0) return;
              const currentIndex = options.findIndex((option) => option === document.activeElement);
              const nextIndex =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? options.length - 1
                    : event.key === "ArrowDown"
                      ? (currentIndex + 1) % options.length
                      : (currentIndex - 1 + options.length) % options.length;
              event.preventDefault();
              options[nextIndex]?.focus();
            }}
          >
            {newThreadPickerProjects.map((project, index) => {
              const isDefault = index === 0 && newThreadTargetProject !== null;
              return (
                <button
                  key={`${project.environmentId}:${project.id}`}
                  type="button"
                  autoFocus={isDefault}
                  onClick={() => createThreadInProject(project.environmentId, project.id)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                    "hover:bg-accent focus:bg-accent focus:outline-none",
                    isDefault && "bg-accent/50",
                  )}
                >
                  <ProjectFavicon
                    environmentId={project.environmentId}
                    cwd={project.workspaceRoot}
                    className="size-4"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-foreground">
                      {project.title}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground/60">
                      {project.workspaceRoot}
                    </span>
                  </span>
                  {isDefault ? (
                    <Kbd className="h-4 shrink-0 rounded-sm px-1.5 text-[10px]">↵</Kbd>
                  ) : null}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => {
                setNewThreadPickerOpen(false);
                openAddProjectCommandPalette();
              }}
              className="mt-1 flex items-center gap-2.5 rounded-lg border border-dashed border-border px-2.5 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:bg-accent focus:text-foreground focus:outline-none"
            >
              <PlusIcon className="size-4" />
              Add project
            </button>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
