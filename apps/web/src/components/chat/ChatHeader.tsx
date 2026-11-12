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
import { GitForkIcon, PlusIcon, SquarePenIcon, SquareTerminal } from "lucide-react";
import {
  Fragment,
  memo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { isTrailingDoubleClick } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Separator } from "../ui/separator";
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
import {
  PANE_GHOST_TAB_TITLE_CLASS,
  PANE_TAB_CLASS,
  PANE_TAB_TITLE_CLASS,
  PaneNotch,
  PaneTabButton,
} from "../PaneNotch";
import { Button, ContentButton } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { surfaceShortcutActionForKey } from "../RightPanelTabs";
import { SURFACE_LAUNCHER_ENTRIES, SurfaceMenuItems, surfaceMenuActions } from "../SurfaceLauncher";
import { useBrowserDefaults } from "~/browser/browserDefaults";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { GuestShareIndicator } from "./GuestShareControls";
import { useLayoutPane } from "../../layout/layoutPaneContext";
import {
  LAYOUT_TAB_ICON_CLASS,
  LAYOUT_TAB_SLOT_CLASS,
  LayoutPaneTab,
  LayoutPaneTabStrip,
  LayoutTabCloseButton,
  ParentThreadLinkLabel,
  buildLayoutTabMenuItems,
  closeLayoutTabOnMiddleClick,
  ghostTabTooltip,
  finishLayoutTabRename,
  isLayoutTabMenuId,
  runLayoutTabMenuAction,
  useLayoutPaneSiblingTabs,
  useLayoutTabGhostOf,
  useLayoutTabGhostShown,
  useLayoutTabRenameRequested,
} from "../../layout/PaneTabs";
import { useQuietThreadShell } from "../../state/entities";
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
  onOpenBeside: (kind: LayoutBesideKind, paneId?: string | null, browserProfileId?: string) => void;
  newTabShortcutLabel?: string | null | undefined;
  onOpenProjectSettings?: (() => void) | undefined;
  onFindInThread?: ((threadRef: ScopedThreadRef) => void) | undefined;
  /** The chat's terminal pane while hidden (cmd+J): its notch offers it back. */
  hiddenTerminal?: HiddenTerminalChip | null | undefined;
}

export interface HiddenTerminalChip {
  readonly shortcutLabel: string | null;
  readonly running: boolean;
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
  const ghostShown = useLayoutTabGhostShown(layoutTabId);
  const ghostOf = useLayoutTabGhostOf(ghostShown ? layoutTabId : null);
  const ghostParent = useQuietThreadShell(ghostOf);
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
  const renameRequested = useLayoutTabRenameRequested(layoutTabId);
  if (renaming === null && renameRequested && canOperateThread && isServerThread) {
    setRenaming({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle,
    });
  }
  const renamingTitle =
    canOperateThread &&
    renaming?.threadId === activeThreadId &&
    renaming.environmentId === activeThreadEnvironmentId
      ? renaming.title
      : null;
  const stopRenaming = () => {
    setRenaming(null);
    finishLayoutTabRename(layoutTabId);
  };
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
    stopRenaming();
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
  const openMenuFromTitle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (isTrailingDoubleClick(event.detail)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  // A native menu takes the second click, so only the in-page menu lets a double-click reach here.
  const handleTitleDoubleClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
    closeMenu();
    // A ghost tab is kept first; the next double-click renames.
    if (ghostShown && layoutTabId !== null) {
      useLayoutStore.getState().keepTab(layoutTabId);
      return;
    }
    startRename();
  };
  const handleHeaderContextMenu = (event: ReactMouseEvent) => {
    if (renamingTitle !== null) return;
    if (!isServerThread) {
      const layoutItems = layoutMenuItems();
      if (onOpenProjectSettings === undefined && layoutItems.length === 0) return;
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
    event.preventDefault();
    openMenu({ x: event.clientX, y: event.clientY });
  };
  const handleTabAuxClick = (event: ReactMouseEvent) => {
    if (layoutTabId === null) return;
    closeLayoutTabOnMiddleClick(event, layoutTabId);
  };
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      renameCommittedRef.current = true;
      commitRename(event.currentTarget.value);
    } else if (event.key === "Escape") {
      renameCommittedRef.current = true;
      stopRenaming();
    }
  };
  // `parentThreadLink` is set only for a subagent, however its tab was opened.
  const tabIcon =
    ghostOf || parentThreadLink ? (
      <GitForkIcon aria-hidden className="size-3.5 shrink-0" />
    ) : isServerThread ? (
      activeProject ? (
        <ProjectFavicon project={activeProject} className="size-3.5" />
      ) : null
    ) : (
      <SquarePenIcon aria-hidden className="size-3.5 shrink-0 text-foreground" />
    );
  // The project name left the header with the breadcrumb; the tab's tooltip
  // keeps it, in the breadcrumb's old order.
  const plainTooltip = activeProjectName
    ? `${activeProjectName} / ${activeThreadTitle}`
    : activeThreadTitle;
  const tabTooltip = ghostShown
    ? ghostTabTooltip(ghostOf ? activeThreadTitle : plainTooltip, ghostParent?.title)
    : plainTooltip;
  // The parent's own tab, when it leads this one in the strip, becomes the back link.
  const parentTabId =
    parentThreadLink === null
      ? null
      : (siblingTabs.before.find(
          (tab) =>
            tab.content.kind === "chat" &&
            tab.content.target.kind === "server" &&
            tab.content.target.threadRef.threadId === parentThreadLink.threadId,
        )?.id ?? null);
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
        <LayoutPaneTabStrip>
          {siblingTabs.before.map((tab) =>
            tab.id === parentTabId ? (
              <Fragment key={tab.id}>
                <LayoutPaneTab tab={tab} parentLink />
                <ParentThreadLinkSeparator />
              </Fragment>
            ) : (
              <LayoutPaneTab key={tab.id} tab={tab} />
            ),
          )}
          {parentThreadLink && parentTabId === null ? (
            <>
              <ParentThreadLink link={parentThreadLink} onOpenThread={onOpenThread} />
              <ParentThreadLinkSeparator />
            </>
          ) : null}
          {renamingTitle !== null ? (
            <div
              className={cn(
                PANE_TAB_CLASS,
                "max-w-full shrink-0 inset-ring inset-ring-ring/50 focus-within:inset-ring-ring",
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
                    stopRenaming();
                    return;
                  }
                  commitRename(event.currentTarget.value);
                }}
                onFocus={(event) => {
                  renameCommittedRef.current = false;
                  event.currentTarget.select();
                }}
                onKeyDown={handleRenameKeyDown}
              />
            </div>
          ) : (
            <span className={LAYOUT_TAB_SLOT_CLASS}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    isServerThread ? (
                      <PaneTabButton
                        data-layout-pane-tab={layoutTabId ?? undefined}
                        type="button"
                        aria-label={`Thread actions for ${activeThreadTitle}`}
                        aria-haspopup="menu"
                        onClick={openMenuFromTitle}
                        onAuxClick={handleTabAuxClick}
                        onPointerDown={handleTabPointerDown}
                        onDoubleClick={canOperateThread ? handleTitleDoubleClick : undefined}
                      />
                    ) : (
                      <div
                        className={PANE_TAB_CLASS}
                        data-layout-pane-tab={layoutTabId ?? undefined}
                        onAuxClick={handleTabAuxClick}
                        onPointerDown={handleTabPointerDown}
                      />
                    )
                  }
                >
                  <span className={LAYOUT_TAB_ICON_CLASS}>{tabIcon}</span>
                  <h2
                    className={cn(
                      "min-w-0",
                      PANE_TAB_TITLE_CLASS,
                      ghostShown && PANE_GHOST_TAB_TITLE_CLASS,
                    )}
                    dir={textDirection(activeThreadTitle)}
                  >
                    {activeThreadTitle}
                  </h2>
                </TooltipTrigger>
                <TooltipPopup side="bottom" className="whitespace-pre-line">
                  {tabTooltip}
                </TooltipPopup>
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
            <span className={LAYOUT_TAB_SLOT_CLASS}>
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
                  <SquareTerminal
                    aria-hidden
                    className={cn(
                      "size-3.5 shrink-0",
                      hiddenTerminal.running && "text-success-foreground",
                    )}
                  />
                  <span className="min-w-0 truncate">Terminal</span>
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  Show the terminal
                  {hiddenTerminal.shortcutLabel ? ` (${hiddenTerminal.shortcutLabel})` : ""}
                  <br />
                  {activeThreadTitle}
                  <br />
                  {hiddenTerminal.running ? "Process running" : "Idle"}
                </TooltipPopup>
              </Tooltip>
            </span>
          ) : null}
        </LayoutPaneTabStrip>
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
  onOpenBeside: (kind: LayoutBesideKind, paneId?: string | null, browserProfileId?: string) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const [open, setOpen] = useState(false);
  const browserProfiles = useBrowserDefaults().profiles;
  const actions = surfaceMenuActions({
    onNewThread: props.onNewThread,
    surfaces: Object.fromEntries(
      SURFACE_LAUNCHER_ENTRIES.map((item) => [
        item.kind,
        {
          available: props.besideAvailable.has(item.kind),
          onClick: () => props.onOpenBeside(item.kind),
        },
      ]),
    ),
  });
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
        <SurfaceMenuItems
          actions={actions}
          browserProfiles={browserProfiles}
          onAddBrowserInProfile={(profileId) => props.onOpenBeside("browser", undefined, profileId)}
          onClose={() => setOpen(false)}
        />
      </MenuPopup>
    </Menu>
  );
}

/** Sets the parent's back link apart from the child tabs after it. */
function ParentThreadLinkSeparator() {
  return <Separator orientation="vertical" className="mx-0.5 h-4" />;
}

/** A subagent thread's way back to its parent when the parent has no tab in this pane. */
function ParentThreadLink({
  link,
  onOpenThread,
}: {
  readonly link: { threadId: ThreadId; title: string };
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <span className={LAYOUT_TAB_SLOT_CLASS}>
      <Tooltip>
        <TooltipTrigger
          render={
            <ContentButton
              variant="tab"
              type="button"
              aria-label={`Back to parent thread: ${link.title}`}
              onClick={() => onOpenThread(link.threadId)}
            />
          }
        >
          <ParentThreadLinkLabel title={link.title} />
        </TooltipTrigger>
        <TooltipPopup side="bottom" className="whitespace-pre-line">
          {`${link.title}\nParent thread`}
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}
