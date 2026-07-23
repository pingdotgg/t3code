import { autoAnimate } from "@formkit/auto-animate";
import { useAtomValue } from "@effect/atom-react";
import { effectiveSettled } from "@t3tools/client-runtime/state/thread-settled";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  MessageSquareIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SquarePenIcon,
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
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { cn } from "~/lib/utils";
import {
  firstValidTimestampMs,
  hasUnseenCompletion,
  isTrailingDoubleClick,
  resolveAdjacentThreadId,
  resolveSidebarV2Status,
  shouldNavigateAfterProjectRemoval,
  sortThreadsForSidebarV2,
} from "./Sidebar.logic";
import { resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import { prStatusIndicator, resolveThreadPr } from "./ThreadStatusIndicators";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "./chat/providerIconUtils";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../providerInstances";
import { primaryServerProvidersAtom } from "../state/server";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { CommandDialogTrigger } from "./ui/command";
import { Kbd } from "./ui/kbd";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { SidebarContent, SidebarGroup, SidebarMenuButton, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { useComposerDraftStore } from "../composerDraftStore";

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
      sideOffset={8}
      className="dropdown-glass max-w-80 border-0! bg-[color-mix(in_srgb,var(--background)_var(--glass-opacity),transparent)] text-left whitespace-normal shadow-lg/10 before:hidden dark:shadow-none"
    >
      <div className="flex max-w-80 flex-col gap-2 p-2">
        <div className="whitespace-nowrap text-sm font-medium text-foreground">{thread.title}</div>
        <div className="grid gap-1.5 text-xs text-muted-foreground">
          {projectTitle ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProjectFavicon
                environmentId={thread.environmentId}
                cwd={projectCwd ?? ""}
                className="size-4 shrink-0"
              />
              <div className="min-w-0 wrap-break-word text-foreground/90">{projectTitle}</div>
            </div>
          ) : null}
          {environmentLabel ? (
            <div className="flex min-w-0 items-center gap-2">
              <ServerIcon className="size-4 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 wrap-break-word text-foreground/90">{environmentLabel}</div>
            </div>
          ) : null}
          {thread.branch ? (
            <div className="flex min-w-0 items-center gap-2">
              <GitBranchIcon className="size-4 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 wrap-break-word text-foreground/90">{thread.branch}</div>
            </div>
          ) : null}
          {branchMismatch ? (
            <div className="flex min-w-0 items-start gap-2 text-warning">
              <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 stroke-current" />
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
                iconClassName="size-4 shrink-0"
              />
              <div className="min-w-0 wrap-break-word text-foreground/90">{modelLabel}</div>
            </div>
          ) : null}
          {thread.session?.lastError ? (
            <div className="flex min-w-0 items-center gap-2 text-red-600 dark:text-red-400">
              <CircleAlertIcon className="size-4 shrink-0 stroke-current" />
              <div className="min-w-0 wrap-break-word">{thread.session.lastError}</div>
            </div>
          ) : null}
        </div>
      </div>
    </TooltipPopup>
  );
}

const SidebarV2Row = memo(function SidebarV2Row(props: {
  thread: SidebarThreadSummary;
  variant: "card" | "slim";
  // Slim rows are either settled (action: un-settle) or merely quiet
  // (seen Ready threads — action: settle).
  variantAction: "settle" | "unsettle";
  // False on environments whose server predates thread.settle/unsettle:
  // the lifecycle affordances hide entirely rather than fail on click.
  settlementSupported: boolean;
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

  // Same semantics as v1 (never-visited counts as read): flipping the beta
  // flag must not light up every historical thread as unread.
  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarV2Status(thread);
  const shouldRecede = status === "ready" && !isUnread && !props.isActive && !isSelected;
  // Status hues follow the system-wide convention set by sidebar v1 and the
  // mobile Live Activity/widgets (amber approval, indigo input, sky working)
  // so a thread reads the same color everywhere it surfaces.
  const topStatus =
    status === "working"
      ? {
          label: "Working",
          icon: "working" as const,
          className:
            "animate-sidebar-working-text text-sky-600 motion-reduce:animate-none dark:text-sky-400",
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
            : isUnread
              ? {
                  label: "Done",
                  icon: "done" as const,
                  className: "text-emerald-700 dark:text-emerald-300",
                }
              : null;

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
    hasDedicatedWorktree: thread.worktreePath !== null,
  });
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
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

  const isRemote =
    props.currentEnvironmentId !== null && thread.environmentId !== props.currentEnvironmentId;

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

  // All Sidebar V2 rows share one surface model. Live threads used to look
  // like elevated cards while settled threads were plain rows, leaving neither
  // a useful hierarchy nor a reliable hover cue. Status now lives in the row
  // content; surface is reserved for interaction (hover, multi-select, route).
  const rowSurfaceClassName = cn(
    "group/v2-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none",
    variant === "card" && "backdrop-blur-[16px]",
    props.isActive
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : isSelected
        ? "bg-sidebar-row-selected text-sidebar-foreground"
        : shouldRecede
          ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
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
        variant === "card"
          ? cn(
              "truncate",
              isUnread
                ? "text-foreground"
                : status !== "ready"
                  ? "text-foreground/95"
                  : shouldRecede
                    ? "text-muted-foreground/80"
                    : "text-foreground/90",
            )
          : cn(
              "truncate group-hover/v2-row:text-foreground",
              props.isActive
                ? "text-foreground"
                : isUnread
                  ? "text-muted-foreground"
                  : "text-muted-foreground/70",
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
          "shrink-0 font-mono text-xs hover:underline",
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
                <span className="text-xs">
                  {props.jumpLabel ??
                    compactSidebarTimeLabel(
                      formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt),
                    )}
                </span>
              </span>
              {!props.settlementSupported ? null : variantAction === "unsettle" ? (
                <button
                  type="button"
                  aria-label="Un-settle thread"
                  onClick={handleUnsettleClick}
                  className="absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md border border-sidebar-border bg-sidebar-row-hover px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/v2-row:opacity-100 dark:border-transparent dark:inset-ring-1 dark:inset-ring-white/5"
                >
                  <Undo2Icon className="size-3" />
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="Settle thread"
                  onClick={handleSettleClick}
                  className="absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md border border-sidebar-border bg-sidebar-row-hover px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/v2-row:opacity-100 dark:border-transparent dark:inset-ring-1 dark:inset-ring-white/5"
                >
                  <CheckIcon className="size-3" />
                </button>
              )}
            </span>
          </TooltipTrigger>
          {detailsTooltip}
        </Tooltip>
      </li>
    );
  }

  const diff = latestTurnDiff(thread);

  return (
    <li
      data-thread-item
      className="list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_96px]"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              role="button"
              tabIndex={0}
              data-testid="sidebar-v2-row-card"
              className={rowSurfaceClassName}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          }
        >
          <div className="relative z-10 h-[4.875rem] px-2.5 py-2">
            <div className="flex h-5 min-w-0 items-center gap-1.5">
              <ProjectFavicon
                environmentId={thread.environmentId}
                cwd={props.projectCwd ?? ""}
                className="size-4 shrink-0"
              />
              {props.projectTitle ? (
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground/85">
                  {props.projectTitle}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              <span className="relative ml-auto flex h-5 min-w-8 shrink-0 items-center justify-end pl-1 text-xs">
                <span className="tabular-nums text-muted-foreground/65 transition-opacity group-hover/v2-row:opacity-0">
                  {props.jumpLabel ? (
                    props.jumpLabel
                  ) : topStatus ? (
                    <span
                      role="status"
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
                      {topStatus.label}
                    </span>
                  ) : (
                    threadTimeLabel(thread)
                  )}
                </span>
                {props.settlementSupported ? (
                  <button
                    type="button"
                    aria-label="Settle thread"
                    onClick={handleSettleClick}
                    className="absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md border border-sidebar-border bg-sidebar-row-hover px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/v2-row:opacity-100 dark:border-transparent dark:inset-ring-1 dark:inset-ring-white/5"
                  >
                    <CheckIcon className="size-3" />
                    Settle
                  </button>
                ) : null}
              </span>
            </div>
            <div className="mt-1 flex min-w-0">{title}</div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/75">
              {thread.branch ? (
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">{thread.branch}</span>
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
                {isRemote ? (
                  <span
                    aria-label={props.environmentLabel ?? "Remote environment"}
                    className="inline-flex shrink-0 items-center text-sidebar-muted-foreground/70"
                  >
                    <ServerIcon aria-hidden className="size-4" />
                  </span>
                ) : null}
                {driverKind ? (
                  <span className="inline-flex shrink-0 items-center opacity-60">
                    <ProviderInstanceIcon
                      driverKind={driverKind}
                      displayName={thread.session?.providerName ?? modelInstanceId}
                      iconClassName="size-4"
                    />
                  </span>
                ) : null}
              </span>
            </div>
          </div>
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

export default function SidebarV2() {
  const projects = useProjects();
  const threads = useThreadShells();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const autoSettleAfterDays = useClientSettings((s) => s.sidebarAutoSettleAfterDays);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const { settleThread, unsettleThread, deleteThread } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const deleteProject = useAtomCommand(projectEnvironment.delete, {
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
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
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

  // Project scope: one menu above the list. Scoping filters the list without
  // making the header width depend on the number or length of project names.
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

  const handleRemoveProject = useCallback(
    async (project: EnvironmentProject) => {
      const api = readLocalApi();
      if (!api) return;

      const projectThreads = threads.filter(
        (thread) =>
          thread.environmentId === project.environmentId && thread.projectId === project.id,
      );
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          projectThreads.length > 0
            ? [
                `Remove project "${project.title}" and delete its ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}?`,
                `Path: ${project.workspaceRoot}`,
                "This permanently clears conversation history for those threads.",
                "This removes only the project entry, not the files on disk.",
                "This action cannot be undone.",
              ].join("\n")
            : [
                `Remove project "${project.title}"?`,
                `Path: ${project.workspaceRoot}`,
                "This removes only the project entry, not the files on disk.",
              ].join("\n"),
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;

      const projectRef = scopeProjectRef(project.environmentId, project.id);
      const result = await deleteProject({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          ...(projectThreads.length > 0 ? { force: true } : {}),
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
        return;
      }

      const draftStore = useComposerDraftStore.getState();
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
      const shouldNavigate = shouldNavigateAfterProjectRemoval({
        routeTarget: routeTargetRef.current,
        projectThreads,
        projectDraftId: projectDraftThread?.draftId ?? null,
      });
      if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(projectRef);

      if (shouldNavigate) {
        void router.navigate({ to: "/" });
      }
    },
    [deleteProject, router, threads],
  );

  // Settled threads stay in the live shell stream (settled ≠ archived), so
  // the partition works directly off live shells: no archived-snapshot
  // merging, no optimistic holds. Archived threads remain hidden here —
  // archive keeps its original "remove from sidebar" meaning.
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
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
      // Threads on servers without the settlement capability (old server,
      // or descriptor not loaded yet) never classify as settled: the user
      // could neither un-settle nor pin them, so auto-settling them would
      // strand rows in a tail with no working affordances.
      const supportsSettlement =
        serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement === true;
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const changeRequestState = changeRequestStateByKey.get(threadKey) ?? null;
      if (
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
  const settledResetKey = projectScopeKey ?? "all";
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

  const orderedThreads = useMemo(
    () => [...activeThreads, ...visibleSettledThreads],
    [activeThreads, visibleSettledThreads],
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
          // remaining card (never a settled row, never one settling in the
          // same batch), or a fresh draft in this project when it was the
          // last active one. Snapshot the target before the settle mutates
          // the partition. Background settles never navigate.
          const shell = threadByKeyRef.current.get(threadKey);
          let navigateAfterSettle: (() => void) | null = null;
          if (routeThreadKey === threadKey) {
            const orderedKeys = orderedThreadKeysRef.current;
            const settledKeys = settledThreadKeysRef.current;
            const currentIndex = orderedKeys.indexOf(threadKey);
            const nextCardKey =
              currentIndex === -1
                ? null
                : ([
                    ...orderedKeys.slice(currentIndex + 1),
                    ...orderedKeys.slice(0, currentIndex),
                  ].find((key) => !settledKeys.has(key) && !opts.coSettlingKeys?.has(key)) ?? null);
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
        // Un-settle works on every settled row: for explicit settles it
        // clears the override, for auto-settled rows it pins the thread
        // active until real activity clears the pin. Environments without
        // the settlement capability get no lifecycle items at all.
        const supportsSettlement =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
          true;
        const isSettled = settledThreadKeysRef.current.has(threadKey);
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
              { id: "rename", label: "Rename thread" },
              { id: "mark-unread", label: "Mark unread" },
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
      attemptUnsettle,
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
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="gap-0">
        <SidebarGroup className="px-2 pb-2 pt-3">
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <CommandDialogTrigger
                render={
                  <SidebarMenuButton
                    size="sm"
                    type="button"
                    aria-label="Search threads and commands"
                    className="h-8 gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                    data-testid="command-palette-trigger"
                  />
                }
              >
                <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                <div className="flex-1 truncate text-left">Search</div>
                {commandPaletteShortcutLabel ? (
                  <Kbd className="h-4 min-w-0 rounded-sm bg-sidebar-control-surface px-1.5 text-[10px] text-sidebar-muted-foreground ring-1 ring-sidebar-border">
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
                      size="sm"
                      type="button"
                      className="relative size-8 justify-center rounded-md border-0 bg-transparent p-0 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                      onClick={handleNewThreadClick}
                      disabled={projects.length === 0}
                      aria-label="New thread"
                    />
                  }
                >
                  <SquarePenIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                  <span
                    className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                    aria-hidden="true"
                  />
                </TooltipTrigger>
                <TooltipPopup side="right">
                  {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
                </TooltipPopup>
              </Tooltip>
            </div>
          </div>
        </SidebarGroup>
        {projects.length > 0 ? (
          <SidebarGroup className="px-2 pb-2 pt-0">
            <div className="flex items-center gap-1">
              <Menu>
                <MenuTrigger
                  aria-label="Filter threads by project"
                  className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                >
                  {scopedProject ? (
                    <ProjectFavicon
                      environmentId={scopedProject.environmentId}
                      cwd={scopedProject.workspaceRoot}
                      className="size-4 shrink-0"
                    />
                  ) : (
                    <FolderIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {scopedProject?.title ?? "All projects"}
                  </span>
                  <ChevronDownIcon className="size-4 shrink-0 text-sidebar-muted-foreground/70" />
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
                    {projects.map((project) => {
                      const scopeKey = `${project.environmentId}:${project.id}`;
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
                          <span className="min-w-0 truncate text-sm">{project.title}</span>
                          <button
                            type="button"
                            aria-label={`Remove project ${project.title}`}
                            title={`Remove ${project.title}`}
                            className="ml-auto inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/55 outline-none transition-colors hover:bg-destructive/12 hover:text-destructive focus-visible:bg-destructive/12 focus-visible:text-destructive focus-visible:ring-2 focus-visible:ring-destructive/40"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void handleRemoveProject(project);
                            }}
                          >
                            <Trash2Icon className="size-3.5" />
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
                      size="sm"
                      className="relative size-8 shrink-0 justify-center rounded-md bg-transparent p-0 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                      onClick={openAddProjectCommandPalette}
                      type="button"
                      aria-label="New project"
                    />
                  }
                >
                  <FolderPlusIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                  <span
                    className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                    aria-hidden="true"
                  />
                </TooltipTrigger>
                <TooltipPopup side="right">New project</TooltipPopup>
              </Tooltip>
            </div>
          </SidebarGroup>
        ) : null}
        <SidebarGroup className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          <TooltipProvider
            key="sidebar-thread-tooltips-150"
            delay={150}
            closeDelay={0}
            timeout={400}
          >
            <ul ref={attachListAutoAnimateRef} role="list" className="flex flex-col gap-px">
              {orderedThreads.flatMap((thread, threadIndex) => {
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
                    scopedThreadKey(
                      scopeThreadRef(previousThread.environmentId, previousThread.id),
                    ),
                  );
                const showSettledGap = !isCard && previousWasCard;
                const row = (
                  <SidebarV2Row
                    // Keyed per variant on purpose: when a thread settles, the
                    // card fades out in place and the slim row fades in at its
                    // settled position instead of one element FLIP-sliding
                    // through every row in between (rows here are translucent,
                    // so a crossing row reads as text painted over text).
                    key={`${threadKey}:${isCard ? "card" : "slim"}`}
                    thread={thread}
                    variant={isCard ? "card" : "slim"}
                    // Every settled row can un-settle: explicit settles clear
                    // the override, auto-settled rows get pinned active.
                    variantAction={isSettledRow ? "unsettle" : "settle"}
                    settlementSupported={
                      serverConfigs.get(thread.environmentId)?.environment.capabilities
                        .threadSettlement === true
                    }
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
                if (!showSettledGap) return [row];
                // The divider is its own keyed list item (not part of the first
                // settled row): it keeps one stable DOM node at the boundary,
                // so settling a thread slides it instead of teleporting it
                // along with whichever row happens to be first in the tail —
                // and row heights stay independent of neighbor classification.
                return [
                  <li
                    key="settled-divider"
                    aria-hidden
                    data-thread-selection-safe
                    className="list-none"
                  >
                    <div className="mb-1 mt-3 flex items-center gap-2 px-2.5">
                      <span className="text-xs font-medium text-muted-foreground/50">Settled</span>
                      <span className="h-px flex-1 bg-sidebar-border/60" />
                    </div>
                  </li>,
                  row,
                ];
              })}
              {hiddenSettledCount > 0 ? (
                <li className="list-none">
                  <button
                    type="button"
                    onClick={showMoreSettled}
                    className="mt-1 flex h-[30px] w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border font-mono text-[11px] text-muted-foreground transition-colors hover:border-solid hover:border-input hover:bg-background/45 hover:text-foreground dark:border-white/15 dark:hover:border-white/30 dark:hover:bg-transparent"
                  >
                    Show {Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more
                    <span className="text-muted-foreground/50">
                      ({hiddenSettledCount} settled hidden)
                    </span>
                  </button>
                </li>
              ) : null}
            </ul>
          </TooltipProvider>
          {orderedThreads.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
              {projects.length === 0 ? (
                <>
                  <span>No projects yet</span>
                  <button
                    type="button"
                    onClick={openAddProjectCommandPalette}
                    className="inline-flex items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-[11px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
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
      <SidebarChromeFooter />
    </>
  );
}
