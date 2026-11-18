import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { T, useGT, Var } from "gt-react";
import { GitForkIcon, SquarePenIcon, SquareTerminal } from "lucide-react";
import {
  memo,
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
import { beginLayoutContentDrag, beginLayoutTabDrag } from "../../layout/layoutDrag";
import { THREAD_TERMINAL_SURFACE_ID } from "../../layout/layoutModel";
import { threadEnvironment } from "../../state/threads";
import { canShareWithGuestAtom } from "./guestShareAvailability";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  PANE_GHOST_TAB_TITLE_CLASS,
  PANE_INACTIVE_TAB_TITLE_CLASS,
  PANE_TAB_CLASS,
  PANE_TAB_TITLE_CLASS,
  PaneNotch,
  PaneTabButton,
} from "../PaneNotch";
import { ContentButton } from "../ui/button";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { GuestShareIndicator } from "./GuestShareControls";
import { useLayoutPane } from "../../layout/layoutPaneContext";
import {
  LAYOUT_TAB_ICON_CLASS,
  LAYOUT_TAB_SLOT_CLASS,
  LayoutPaneTab,
  LayoutNewTabButton,
  LayoutPaneTabStrip,
  LayoutTabCloseButton,
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
import { useProject, useQuietThreadShell } from "../../state/entities";
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
  onOpenProjectSettings?: (() => void) | undefined;
  onFindInThread?: ((threadRef: ScopedThreadRef) => void) | undefined;
  /** The chat's terminal pane while hidden (cmd+J): its notch offers it back. */
  hiddenTerminal?: HiddenTerminalChip | null | undefined;
  onNewSideChat?: (() => void) | undefined;
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
  onOpenProjectSettings,
  onFindInThread,
  hiddenTerminal,
  onNewSideChat,
}: ChatHeaderProps) {
  const gt = useGT();
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
  const activeProjectName = activeProject?.isScratch ? gt("No project") : activeProject?.title;
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
      toastManager.add({ type: "warning", title: gt("Thread title cannot be empty") });
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
          title: gt("Failed to rename thread"),
          description: error instanceof Error ? error.message : gt("An error occurred."),
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
    onNewSideChat,
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
                    label: gt("Project settings"),
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
      event.preventDefault();
      renameCommittedRef.current = true;
      stopRenaming();
    }
  };
  const tabIcon = ghostOf ? (
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
  // The parent's own tab already leads this one in the strip.
  const parentTabShown =
    parentThreadLink !== null &&
    siblingTabs.before.some(
      (tab) =>
        tab.content.kind === "chat" &&
        tab.content.target.kind === "server" &&
        tab.content.target.threadRef.threadId === parentThreadLink.threadId,
    );
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
          {siblingTabs.before.map((tab) => (
            <LayoutPaneTab key={tab.id} tab={tab} />
          ))}
          {parentThreadLink && !parentTabShown ? (
            <ParentThreadTab
              environmentId={activeThreadEnvironmentId}
              link={parentThreadLink}
              onOpenThread={onOpenThread}
            />
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
                aria-label={gt("Thread title")}
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
                        aria-label={gt("Thread actions for {title}", { title: activeThreadTitle })}
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
                      onPointerDown={(event) =>
                        beginLayoutContentDrag(event, {
                          kind: "surface",
                          threadRef: scopeThreadRef(activeThreadEnvironmentId, activeThreadId),
                          surface: { id: THREAD_TERMINAL_SURFACE_ID, kind: "thread-terminal" },
                        })
                      }
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
                  <span className="min-w-0 truncate">
                    <T>Terminal</T>
                  </span>
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  {hiddenTerminal.shortcutLabel
                    ? gt("Show the terminal ({shortcut})", {
                        shortcut: hiddenTerminal.shortcutLabel,
                      })
                    : gt("Show the terminal")}
                  <br />
                  {activeThreadTitle}
                  <br />
                  {hiddenTerminal.running ? gt("Process running") : gt("Idle")}
                </TooltipPopup>
              </Tooltip>
            </span>
          ) : null}
        </LayoutPaneTabStrip>
        {layoutTabId !== null ? <LayoutNewTabButton tabId={layoutTabId} /> : null}
        {renamingTitle === null && activeThreadLinkOrigin ? (
          <Tooltip>
            <TooltipTrigger render={<Badge variant="info" size="sm" />}>
              <T>
                From <Var>{activeThreadLinkOrigin}</Var>
              </T>
            </TooltipTrigger>
            <TooltipPopup side="top">
              <T>
                Started by an agent on <Var>{activeThreadLinkOrigin}</Var> through a linked
                environment.
              </T>
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </PaneNotch>
      {isServerThread ? <GuestShareIndicator threadRef={activeThreadRef} /> : null}
    </div>
  );
});

/**
 * A subagent thread's way back to its parent when the parent has no tab in
 * this pane: an inactive tab like any other, ahead of the thread's own.
 */
function ParentThreadTab({
  environmentId,
  link,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: { threadId: ThreadId; title: string };
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const gt = useGT();
  const parent = useQuietThreadShell(scopeThreadRef(environmentId, link.threadId));
  const project = useProject(
    parent ? scopeProjectRef(parent.environmentId, parent.projectId) : null,
  );
  return (
    <span className={LAYOUT_TAB_SLOT_CLASS}>
      <Tooltip>
        <TooltipTrigger
          render={
            <ContentButton
              variant="tab"
              type="button"
              aria-label={gt("Open parent thread: {title}", { title: link.title })}
              onClick={() => onOpenThread(link.threadId)}
              onPointerDown={(event) =>
                beginLayoutContentDrag(event, {
                  kind: "thread",
                  threadRef: scopeThreadRef(environmentId, link.threadId),
                })
              }
            />
          }
        >
          {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
          <span className={PANE_INACTIVE_TAB_TITLE_CLASS} dir={textDirection(link.title)}>
            {link.title}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom" className="whitespace-pre-line">
          {`${link.title}\n${gt("Parent thread")}`}
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}
