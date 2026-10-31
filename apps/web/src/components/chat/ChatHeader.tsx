import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { PlusIcon, SquarePenIcon, SquareTerminal } from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { isTrailingDoubleClick } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { readLocalApi } from "~/localApi";
import { useAtomValue } from "@effect/atom-react";
import { primaryServerKeybindingsAtom } from "../../state/server";
import type { ContextMenuItem } from "@t3tools/contracts";
import type { LayoutBesideKind } from "../../layout/layoutActions";
import { beginLayoutTabDrag } from "../../layout/layoutDrag";
import { threadEnvironment } from "../../state/threads";
import { canShareWithGuestAtom } from "./guestShareAvailability";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { ProjectFavicon } from "../ProjectFavicon";
import { PANE_TAB_CLASS, PaneNotch, PaneTabButton } from "../PaneNotch";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { surfaceShortcutActionForKey } from "../RightPanelTabs";
import { SURFACE_LAUNCHER_ENTRIES } from "../SurfaceLauncher";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { GuestShareIndicator } from "./GuestShareControls";
import { useLayoutPane } from "../../layout/layoutPaneContext";
import {
  LAYOUT_TAB_ICON_CLASS,
  LAYOUT_TAB_SLOT_CLASS,
  LayoutPaneTab,
  LayoutTabCloseButton,
  buildLayoutTabMenuItems,
  closeLayoutTabOnMiddleClick,
  isLayoutTabMenuId,
  runLayoutTabMenuAction,
  useLayoutPaneSiblingTabs,
} from "../../layout/PaneTabs";
import { useLayoutStore } from "../../layout/layoutStore";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeThreadLinkOrigin?: string | null | undefined;
  isServerThread: boolean;
  activeProject: EnvironmentProject | null;
  parentThreadLink: { threadId: ThreadId; title: string } | null;
  onOpenThread: (threadId: ThreadId) => void;
  rightPanelOpen: boolean;
  /**
   * Room the header's floating controls take at its end, in px, so the notch's
   * tabs truncate before they run under them. Unset keeps the default room.
   */
  trailingInset?: number | null | undefined;
  /** Opens a new thread in this project as a new tab of the pane. */
  onNewThreadInProject: () => void;
  /** What the "+" menu can open beside the chat after a new thread. */
  besideAvailable: ReadonlySet<LayoutBesideKind>;
  onOpenBeside: (kind: LayoutBesideKind) => void;
  newTabShortcutLabel?: string | null | undefined;
  onOpenProjectSettings?: (() => void) | undefined;
  onFindInThread?: ((threadRef: ScopedThreadRef) => void) | undefined;
  /** The chat's terminal pane while hidden (cmd+J): its notch offers it back. */
  hiddenTerminal?: HiddenTerminalChip | null | undefined;
}

export interface HiddenTerminalChip {
  readonly shortcutLabel: string | null;
  readonly onShow: () => void;
}

function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

// Delay the input-swallowing native menu through the double-click rename interval.
const TITLE_MENU_OPEN_DELAY_MS = 500;

const OPEN_BESIDE_MENU: ContextMenuItem<LayoutBesideKind>[] = [
  { id: "browser", label: "Browser", icon: "globe" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "files", label: "Files", icon: "folder" },
  { id: "diff", label: "Diff", icon: "file-diff" },
];
export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
  activeThreadLinkOrigin,
  isServerThread,
  activeProject,
  parentThreadLink,
  onOpenThread,
  rightPanelOpen,
  trailingInset,
  onNewThreadInProject,
  besideAvailable,
  onOpenBeside,
  newTabShortcutLabel,
  onOpenProjectSettings,
  onFindInThread,
  hiddenTerminal,
}: ChatHeaderProps) {
  // Right-click "+" for a terminal, browser, files or diff beside the chat (pen HQTgu).
  const openBesideMenu = (event: React.MouseEvent) => {
    const api = readLocalApi();
    const items = OPEN_BESIDE_MENU.filter((item) => besideAvailable.has(item.id));
    if (!api || items.length === 0) return;
    event.preventDefault();
    // The header's own menu would replace this one.
    event.stopPropagation();
    void api.contextMenu.show(items, { x: event.clientX, y: event.clientY }).then((kind) => {
      if (kind) onOpenBeside(kind);
    });
  };
  const { tabId: layoutTabId } = useLayoutPane();
  // Drag the tab out of its notch to split (pen T5Hy0Q).
  const handleTabPointerDown = (event: React.PointerEvent) => {
    if (layoutTabId !== null) beginLayoutTabDrag(event, layoutTabId);
  };
  const siblingTabs = useLayoutPaneSiblingTabs();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const layoutMenuItems = () =>
    layoutTabId === null
      ? []
      : buildLayoutTabMenuItems(useLayoutStore.getState().layout, layoutTabId, keybindings);
  const runLayoutMenuAction = (id: string) => {
    if (layoutTabId !== null && isLayoutTabMenuId(id)) runLayoutTabMenuAction(id, layoutTabId);
  };
  const activeProjectName = activeProject?.isScratch ? "No project" : activeProject?.title;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
  const canOperateThread = useEnvironmentScope(
    activeThreadEnvironmentId,
    AuthOrchestrationOperateScope,
  );
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(activeThreadEnvironmentId));
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renaming, setRenaming] = useState<{
    threadId: ThreadId;
    environmentId: EnvironmentId;
    title: string;
  } | null>(null);
  if (
    renaming !== null &&
    (renaming.threadId !== activeThreadId ||
      renaming.environmentId !== activeThreadEnvironmentId ||
      !canOperateThread)
  ) {
    setRenaming(null);
  }
  const renamingTitle =
    canOperateThread &&
    renaming?.threadId === activeThreadId &&
    renaming.environmentId === activeThreadEnvironmentId
      ? renaming.title
      : null;
  const renameCommittedRef = useRef(false);
  const startRename = () => {
    if (
      !isServerThread ||
      !readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)
    )
      return;
    renameCommittedRef.current = false;
    setRenaming({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle,
    });
  };
  const commitRename = (title: string) => {
    setRenaming(null);
    if (!readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)) return;
    const resolution = resolveRenameCommit({
      title,
      originalTitle: renamingTitle ?? activeThreadTitle,
    });
    if (resolution.action === "reject-empty") {
      toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
      return;
    }
    if (resolution.action === "noop") return;
    void updateThreadMetadata({
      environmentId: activeThreadEnvironmentId,
      input: { threadId: activeThreadId, title: resolution.title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    });
  };
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    onStartRename: startRename,
    onFind: onFindInThread,
    canShareWithGuest,
    leadingItems: layoutMenuItems,
    onLeadingAction: runLayoutMenuAction,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleMenuTimerRef = useRef<number | null>(null);
  const cancelPendingTitleMenu = () => {
    if (titleMenuTimerRef.current === null) return;
    clearTimeout(titleMenuTimerRef.current);
    titleMenuTimerRef.current = null;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the pending title-menu timer when the thread switches or the header unmounts
  useEffect(
    () => () => {
      if (titleMenuTimerRef.current === null) return;
      clearTimeout(titleMenuTimerRef.current);
      titleMenuTimerRef.current = null;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A pending title menu belongs to the thread that was clicked, so switching threads drops it.
    [activeThreadEnvironmentId, activeThreadId],
  );
  const openTitleMenuNow = () => {
    cancelPendingTitleMenu();
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const openMenuFromTitle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (isTrailingDoubleClick(event.detail)) return;
    // Keyboard activation can never be the first half of a double-click, so
    // it opens without waiting.
    if (event.detail === 0 || window.desktopBridge === undefined) {
      openTitleMenuNow();
      return;
    }
    cancelPendingTitleMenu();
    titleMenuTimerRef.current = window.setTimeout(() => {
      titleMenuTimerRef.current = null;
      openTitleMenuNow();
    }, TITLE_MENU_OPEN_DELAY_MS);
  };
  const handleTitleDoubleClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    cancelPendingTitleMenu();
    closeMenu();
    startRename();
  };
  const handleHeaderContextMenu = (event: ReactMouseEvent) => {
    if (renamingTitle !== null) return;
    if (!isServerThread) {
      const layoutItems = layoutMenuItems();
      if (onOpenProjectSettings === undefined && layoutItems.length === 0) return;
      cancelPendingTitleMenu();
      event.preventDefault();
      const api = readLocalApi();
      if (!api) return;
      void api.contextMenu
        .show<string>(
          [
            ...layoutItems,
            ...(onOpenProjectSettings
              ? [
                  {
                    id: "project-settings",
                    label: "Project settings",
                    icon: "settings",
                    separatorBefore: layoutItems.length > 0,
                  },
                ]
              : []),
          ],
          { x: event.clientX, y: event.clientY },
        )
        .then((action) => {
          if (action === "project-settings") onOpenProjectSettings?.();
          else if (action !== null) runLayoutMenuAction(action);
        });
      return;
    }
    cancelPendingTitleMenu();
    event.preventDefault();
    openMenu({ x: event.clientX, y: event.clientY });
  };
  const handleTabAuxClick = (event: ReactMouseEvent) => {
    if (layoutTabId === null) return;
    cancelPendingTitleMenu();
    closeLayoutTabOnMiddleClick(event, layoutTabId);
  };
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      renameCommittedRef.current = true;
      commitRename(event.currentTarget.value);
    } else if (event.key === "Escape") {
      renameCommittedRef.current = true;
      setRenaming(null);
    }
  };
  const tabIcon = isServerThread ? (
    activeProject ? (
      <ProjectFavicon project={activeProject} className="size-3.5" />
    ) : null
  ) : (
    <SquarePenIcon aria-hidden className="size-3.5 shrink-0 text-foreground" />
  );
  // The project name left the header with the breadcrumb; the tab's tooltip
  // keeps it, in the breadcrumb's old order.
  const tabTooltip = activeProjectName
    ? `${activeProjectName} / ${activeThreadTitle}`
    : activeThreadTitle;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center self-stretch",
        trailingInset == null && (rightPanelOpen ? "pr-10" : "pr-24"),
      )}
      style={trailingInset == null ? undefined : { paddingInlineEnd: trailingInset }}
      onContextMenu={handleHeaderContextMenu}
    >
      <PaneNotch>
        {/* Tabs that still do not fit clip here instead of running under "+". */}
        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          {siblingTabs.before.map((tab) => (
            <LayoutPaneTab key={tab.id} tab={tab} />
          ))}
          {parentThreadLink ? (
            <ParentThreadTab link={parentThreadLink} onOpenThread={onOpenThread} />
          ) : null}
          {renamingTitle !== null ? (
            <div
              className={cn(
                PANE_TAB_CLASS,
                "inset-ring inset-ring-ring/50 focus-within:inset-ring-ring",
              )}
            >
              {tabIcon}
              <input
                autoFocus
                dir="auto"
                aria-label="Thread title"
                className="min-w-24 max-w-full bg-transparent outline-none [field-sizing:content]"
                defaultValue={renamingTitle}
                onBlur={(event) => {
                  if (renameCommittedRef.current) return;
                  if (
                    event.relatedTarget instanceof HTMLElement &&
                    event.relatedTarget.closest("button")
                  ) {
                    setRenaming(null);
                    return;
                  }
                  commitRename(event.currentTarget.value);
                }}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={handleRenameKeyDown}
              />
            </div>
          ) : (
            // The pane's own tab always keeps its icon.
            <span className={cn(LAYOUT_TAB_SLOT_CLASS, "min-w-15 overflow-hidden")}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    isServerThread ? (
                      <PaneTabButton
                        ref={titleButtonRef}
                        type="button"
                        aria-label={`Thread actions for ${activeThreadTitle}`}
                        aria-haspopup="menu"
                        onClick={openMenuFromTitle}
                        onAuxClick={handleTabAuxClick}
                        onPointerDown={handleTabPointerDown}
                        onDoubleClick={canOperateThread ? handleTitleDoubleClick : undefined}
                        onBlur={cancelPendingTitleMenu}
                      />
                    ) : (
                      <div
                        className={PANE_TAB_CLASS}
                        onAuxClick={handleTabAuxClick}
                        onPointerDown={handleTabPointerDown}
                      />
                    )
                  }
                >
                  <span className={LAYOUT_TAB_ICON_CLASS}>{tabIcon}</span>
                  <h2 className="min-w-0 truncate" dir={textDirection(activeThreadTitle)}>
                    {activeThreadTitle}
                  </h2>
                </TooltipTrigger>
                <TooltipPopup side="bottom">{tabTooltip}</TooltipPopup>
              </Tooltip>
              {layoutTabId !== null ? (
                <LayoutTabCloseButton tabId={layoutTabId} title={activeThreadTitle} />
              ) : null}
            </span>
          )}
          {siblingTabs.after.map((tab) => (
            <LayoutPaneTab key={tab.id} tab={tab} />
          ))}
          {hiddenTerminal ? (
            // The hidden terminal keeps a tab like any other pane tab.
            <span className={cn(LAYOUT_TAB_SLOT_CLASS, "min-w-8.5 shrink-[2] overflow-hidden")}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      data-hidden-terminal-chip=""
                      className={cn(
                        PANE_TAB_CLASS,
                        "cursor-pointer text-left text-muted-foreground hover:surface-ghost-hover hover:text-foreground",
                      )}
                      onClick={hiddenTerminal.onShow}
                    />
                  }
                >
                  <SquareTerminal aria-hidden className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">Terminal</span>
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  Show the terminal
                  {hiddenTerminal.shortcutLabel ? ` (${hiddenTerminal.shortcutLabel})` : ""}
                </TooltipPopup>
              </Tooltip>
            </span>
          ) : null}
        </div>
        {activeProject ? (
          <NewTabMenu
            projectName={activeProjectName ?? activeProject.title}
            newTabShortcutLabel={newTabShortcutLabel}
            besideAvailable={besideAvailable}
            onNewThread={onNewThreadInProject}
            onOpenBeside={onOpenBeside}
            onContextMenu={openBesideMenu}
          />
        ) : null}
        {renamingTitle === null && activeThreadLinkOrigin ? (
          <Tooltip>
            <TooltipTrigger render={<Badge variant="info" size="sm" />}>
              From {activeThreadLinkOrigin}
            </TooltipTrigger>
            <TooltipPopup side="top">
              Started by an agent on {activeThreadLinkOrigin} through a linked environment.
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </PaneNotch>
      {isServerThread ? <GuestShareIndicator threadRef={activeThreadRef} /> : null}
    </div>
  );
});

/**
 * The notch's "+": choose a new thread (N) or what to open beside the chat,
 * by click or by letter while the menu is open. cmd+T still opens a new
 * thread without it.
 */
function NewTabMenu(props: {
  projectName: string;
  newTabShortcutLabel: string | null | undefined;
  besideAvailable: ReadonlySet<LayoutBesideKind>;
  onNewThread: () => void;
  onOpenBeside: (kind: LayoutBesideKind) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const [open, setOpen] = useState(false);
  const actions = [
    {
      label: "New thread",
      icon: SquarePenIcon,
      shortcut: "N",
      available: true,
      onClick: props.onNewThread,
    },
    // Then what the launcher offers, as it offers them.
    ...SURFACE_LAUNCHER_ENTRIES.map((item) => ({
      label: item.label,
      icon: item.icon,
      shortcut: item.shortcut,
      available: props.besideAvailable.has(item.kind),
      onClick: () => props.onOpenBeside(item.kind),
    })),
  ];
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = surfaceShortcutActionForKey(actions, event.nativeEvent);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    action.onClick();
  };
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  variant="bare"
                  size="icon-xs"
                  data-pane-notch-add=""
                  aria-label={`New tab in ${props.projectName}`}
                  onContextMenu={props.onContextMenu}
                />
              }
            />
          }
        >
          <PlusIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          New tab in {props.projectName}
          {props.newTabShortcutLabel ? ` (${props.newTabShortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="bottom" sideOffset={6} onKeyDownCapture={handleKeyDown}>
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <MenuItem
              key={action.label}
              disabled={!action.available}
              aria-keyshortcuts={action.shortcut}
              onClick={action.onClick}
            >
              <Icon />
              {action.label}
              <MenuShortcut>{action.shortcut}</MenuShortcut>
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}

/**
 * A subagent thread's way back to its parent: a muted notch control ahead of
 * the thread's own tab.
 */
function ParentThreadTab({
  link,
  onOpenThread,
}: {
  readonly link: { threadId: ThreadId; title: string };
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="sm"
            aria-label={`Open parent thread: ${link.title}`}
            onClick={() => onOpenThread(link.threadId)}
            className="min-w-0 max-w-40 shrink [-webkit-app-region:no-drag]"
          />
        }
      >
        <span className="min-w-0 truncate">{link.title}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{link.title}</TooltipPopup>
    </Tooltip>
  );
}
