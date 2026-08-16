import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Pin, Plus, X } from "lucide-react";
import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DraftId } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { hasUnseenCompletion } from "../Sidebar.logic";
import { useUiStateStore } from "~/uiStateStore";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectFavicon } from "../ProjectFavicon";
import { useThreadShell } from "../../state/entities";
import { serverTabKey, useWorkspaceTabsStore, type WorkspaceTab } from "../../workspaceTabsStore";

interface WorkspaceTabsProps {
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly activeThreadId?: ThreadId | undefined;
  readonly draftId?: DraftId | undefined;
  readonly activeThreadTitle: string;
  readonly activeProjectName?: string | undefined;
  readonly activeProjectCwd?: string | null | undefined;
  readonly activeProjectFaviconPath?: string | null | undefined;
  readonly isWorking?: boolean | undefined;
  readonly onNewTab: () => void;
  readonly renamingTitle?: string | null | undefined;
  readonly onCommitRename?: ((title: string) => void) | undefined;
  readonly onCancelRename?: (() => void) | undefined;
  readonly onRenameKeyDown?: ((event: ReactKeyboardEvent<HTMLInputElement>) => void) | undefined;
  readonly onOpenThreadMenu?: ((targetRect?: DOMRect) => void) | undefined;
}

function ServerThreadTabItem({
  tab,
  isActive,
  isDragged,
  isDragOver,
  renamingTitle,
  onCommitRename,
  onRenameKeyDown,
  onOpenThreadMenu,
  onActivate,
  onClose,
  onAuxClick,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: {
  readonly tab: WorkspaceTab;
  readonly isActive: boolean;
  readonly isDragged: boolean;
  readonly isDragOver: boolean;
  readonly renamingTitle?: string | null | undefined;
  readonly onCommitRename?: ((title: string) => void) | undefined;
  readonly onRenameKeyDown?: ((event: ReactKeyboardEvent<HTMLInputElement>) => void) | undefined;
  readonly onOpenThreadMenu?: ((targetRect?: DOMRect) => void) | undefined;
  readonly onActivate: () => void;
  readonly onClose: (e: ReactMouseEvent) => void;
  readonly onAuxClick: (e: ReactMouseEvent) => void;
  readonly onContextMenu: (e: ReactMouseEvent) => void;
  readonly onDragStart: (e: ReactDragEvent) => void;
  readonly onDragOver: (e: ReactDragEvent) => void;
  readonly onDragLeave: () => void;
  readonly onDrop: (e: ReactDragEvent) => void;
  readonly onDragEnd: () => void;
}) {
  const itemRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const threadRef = useMemo(
    () => scopeThreadRef(tab.environmentId, tab.threadId),
    [tab.environmentId, tab.threadId],
  );
  const threadKey = useMemo(() => scopedThreadKey(threadRef), [threadRef]);
  const shell = useThreadShell(threadRef);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const isUnread = useMemo(() => {
    if (isActive || !shell) return false;
    return hasUnseenCompletion({ ...shell, lastVisitedAt });
  }, [isActive, shell, lastVisitedAt]);
  const title = shell?.title || tab.title || "Thread";
  const fullLabel = tab.projectName ? `${tab.projectName} · ${title}` : title;

  useEffect(() => {
    if (isActive && itemRef.current) {
      itemRef.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }, [isActive]);

  const isRenaming = isActive && renamingTitle !== null && renamingTitle !== undefined;

  return (
    <div
      ref={itemRef}
      draggable={!isRenaming}
      data-active-tab={isActive ? "true" : "false"}
      data-tab-key={tab.key}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onAuxClick={onAuxClick}
      onContextMenu={onContextMenu}
      className={cn(
        "group/tab shrink-0 transition-opacity duration-150 [-webkit-app-region:no-drag]",
        isActive ? "opacity-100" : "opacity-60 hover:opacity-100",
        isDragged && "opacity-40 scale-95",
        isDragOver && !isDragged && "ring-2 ring-primary/80 opacity-100",
      )}
    >
      <Group aria-label={fullLabel} className="shrink-0">
        {isRenaming ? (
          <div className="flex h-7 items-center rounded-s-[var(--control-radius)] border border-e-0 border-input bg-popover px-2 text-xs dark:bg-input/32">
            <input
              autoFocus
              aria-label="Thread title"
              className="w-28 bg-transparent text-xs font-medium text-foreground outline-none ring-1 ring-ring/50 focus:ring-ring"
              defaultValue={renamingTitle}
              onBlur={(event) => {
                onCommitRename?.(event.currentTarget.value);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={onRenameKeyDown}
            />
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={fullLabel}
                  onClick={onActivate}
                  className={cn(
                    "max-w-44 ps-[8.5px] text-xs font-normal",
                    isActive
                      ? "bg-accent font-medium text-foreground ring-1 ring-ring/40 shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <ProjectFavicon
                    environmentId={tab.environmentId}
                    cwd={tab.projectCwd ?? ""}
                    faviconPath={tab.faviconPath}
                    className="size-3.5 shrink-0"
                  />
                  <span className="truncate">{title}</span>
                  {tab.pinned ? <Pin className="size-2.5 shrink-0 rotate-45 opacity-60" /> : null}
                  {isUnread ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -top-0.5 -right-0.5 size-2 rounded-full bg-destructive shadow-xs ring-1 ring-background"
                    />
                  ) : null}
                </Button>
              }
            />
            <TooltipPopup side="bottom">{fullLabel}</TooltipPopup>
          </Tooltip>
        )}
        {isActive ? (
          <>
            <GroupSeparator />
            <Button
              ref={triggerRef}
              size="icon-xs"
              variant="outline"
              aria-label={`Thread actions for ${title}`}
              aria-haspopup="menu"
              onClick={(event) => {
                event.stopPropagation();
                if (triggerRef.current && onOpenThreadMenu) {
                  onOpenThreadMenu(triggerRef.current.getBoundingClientRect());
                }
              }}
              className="bg-accent text-foreground ring-1 ring-ring/40 shadow-xs"
            >
              <ChevronDown className="size-3 text-muted-foreground hover:text-foreground" />
            </Button>
          </>
        ) : null}
        <GroupSeparator />
        <Button
          size="icon-xs"
          variant="outline"
          aria-label={`Close ${title}`}
          onClick={onClose}
          className={cn(
            "text-muted-foreground hover:text-foreground",
            isActive && "bg-accent ring-1 ring-ring/40 shadow-xs text-foreground",
          )}
        >
          <X className="size-3.5" />
        </Button>
      </Group>
    </div>
  );
}

export function WorkspaceTabs({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  activeProjectCwd,
  activeProjectFaviconPath,
  onNewTab,
  renamingTitle,
  onCommitRename,
  onRenameKeyDown,
  onOpenThreadMenu,
}: WorkspaceTabsProps) {
  const navigate = useNavigate();
  const tabs = useWorkspaceTabsStore((state) => state.tabs);
  const openTab = useWorkspaceTabsStore((state) => state.openTab);
  const closeTab = useWorkspaceTabsStore((state) => state.closeTab);
  const closeOtherTabs = useWorkspaceTabsStore((state) => state.closeOtherTabs);
  const closeTabsToRight = useWorkspaceTabsStore((state) => state.closeTabsToRight);
  const closeAllTabs = useWorkspaceTabsStore((state) => state.closeAllTabs);
  const reorderTabs = useWorkspaceTabsStore((state) => state.reorderTabs);
  const togglePinTab = useWorkspaceTabsStore((state) => state.togglePinTab);

  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  const currentTabKey = activeThreadId
    ? serverTabKey(activeThreadEnvironmentId, activeThreadId)
    : null;

  const isDraftActive = !activeThreadId || Boolean(draftId);

  useEffect(() => {
    if (!activeThreadId) return;
    openTab({
      key: serverTabKey(activeThreadEnvironmentId, activeThreadId),
      kind: "server",
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle || "Thread",
      projectName: activeProjectName,
      projectCwd: activeProjectCwd,
      faviconPath: activeProjectFaviconPath,
    });
  }, [
    activeProjectCwd,
    activeProjectFaviconPath,
    activeProjectName,
    activeThreadEnvironmentId,
    activeThreadId,
    activeThreadTitle,
    openTab,
  ]);

  const effectiveTabs = useMemo(() => {
    if (
      !activeThreadId ||
      tabs.some(
        (t) => t.threadId === activeThreadId && t.environmentId === activeThreadEnvironmentId,
      )
    ) {
      return tabs;
    }
    const currentTab: WorkspaceTab = {
      key: serverTabKey(activeThreadEnvironmentId, activeThreadId),
      kind: "server",
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle || "Thread",
      projectName: activeProjectName,
      projectCwd: activeProjectCwd,
      faviconPath: activeProjectFaviconPath,
    };
    return [currentTab, ...tabs];
  }, [
    activeProjectCwd,
    activeProjectFaviconPath,
    activeProjectName,
    activeThreadEnvironmentId,
    activeThreadId,
    activeThreadTitle,
    tabs,
  ]);

  const handleNavigateToTab = useCallback(
    (tab: WorkspaceTab) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: tab.environmentId, threadId: tab.threadId },
      });
    },
    [navigate],
  );

  const handleCloseTab = useCallback(
    (tab: WorkspaceTab, event?: ReactMouseEvent) => {
      event?.stopPropagation();
      event?.preventDefault();

      const nextActive = closeTab(tab.key);
      if (tab.key === currentTabKey) {
        if (nextActive) {
          handleNavigateToTab(nextActive);
        } else {
          onNewTab();
        }
      }
    },
    [closeTab, currentTabKey, handleNavigateToTab, onNewTab],
  );

  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, tab: WorkspaceTab) => {
      if (event.button === 1) {
        event.preventDefault();
        event.stopPropagation();
        handleCloseTab(tab);
      }
    },
    [handleCloseTab],
  );

  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, tab: WorkspaceTab) => {
      const api = readLocalApi();
      if (!api) return;

      event.preventDefault();
      event.stopPropagation();

      const tabIndex = effectiveTabs.findIndex((t) => t.key === tab.key);
      if (tabIndex < 0) return;

      const items = [
        { id: "close", label: "Close" },
        {
          id: "close-others",
          label: "Close others",
          disabled: effectiveTabs.length <= 1,
        },
        {
          id: "close-to-right",
          label: "Close to the right",
          disabled: tabIndex >= effectiveTabs.length - 1,
        },
        {
          id: "close-all",
          label: "Close all",
          disabled: effectiveTabs.length === 0,
        },
        {
          id: "toggle-pin",
          label: tab.pinned ? "Unpin tab" : "Pin tab",
        },
      ];

      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (action) {
        case "close":
          handleCloseTab(tab);
          break;
        case "close-others": {
          closeOtherTabs(tab.key);
          const remainingTabs = useWorkspaceTabsStore.getState().tabs;
          const isCurrentStillOpen = remainingTabs.some((t) => t.key === currentTabKey);
          if (!isCurrentStillOpen) {
            handleNavigateToTab(tab);
          }
          break;
        }
        case "close-to-right": {
          closeTabsToRight(tab.key);
          const remainingTabs = useWorkspaceTabsStore.getState().tabs;
          const isCurrentStillOpen = remainingTabs.some((t) => t.key === currentTabKey);
          if (!isCurrentStillOpen) {
            handleNavigateToTab(tab);
          }
          break;
        }
        case "close-all": {
          closeAllTabs();
          const { tabs: remainingTabs, activeTabKey } = useWorkspaceTabsStore.getState();
          const isCurrentStillOpen = remainingTabs.some((t) => t.key === currentTabKey);
          if (!isCurrentStillOpen) {
            const nextActiveTab = remainingTabs.find((t) => t.key === activeTabKey);
            if (nextActiveTab) {
              handleNavigateToTab(nextActiveTab);
            } else {
              onNewTab();
            }
          }
          break;
        }
        case "toggle-pin":
          togglePinTab(tab.key);
          break;
        case null:
          break;
      }
    },
    [
      closeAllTabs,
      closeOtherTabs,
      closeTabsToRight,
      currentTabKey,
      effectiveTabs,
      handleCloseTab,
      handleNavigateToTab,
      onNewTab,
      togglePinTab,
    ],
  );

  const handleDragStart = useCallback((e: ReactDragEvent, tabKey: string) => {
    e.dataTransfer.setData("text/plain", tabKey);
    e.dataTransfer.effectAllowed = "move";
    setDraggedKey(tabKey);
  }, []);

  const handleDragOver = useCallback((e: ReactDragEvent, tabKey: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverKey(tabKey);
  }, []);

  const handleDragLeave = useCallback((tabKey: string) => {
    setDragOverKey((prev) => (prev === tabKey ? null : prev));
  }, []);

  const handleDrop = useCallback(
    (e: ReactDragEvent, targetKey: string) => {
      e.preventDefault();
      if (draggedKey && draggedKey !== targetKey) {
        reorderTabs(draggedKey, targetKey);
      }
      setDraggedKey(null);
      setDragOverKey(null);
    },
    [draggedKey, reorderTabs],
  );

  const handleDragEnd = useCallback(() => {
    setDraggedKey(null);
    setDragOverKey(null);
  }, []);

  const handleWheel = useCallback((e: ReactWheelEvent<HTMLDivElement>) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const viewport = e.currentTarget.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    viewport.scrollLeft += e.deltaY;
  }, []);

  return (
    <div
      className="flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
      data-workspace-tabs=""
    >
      <ScrollArea
        hideScrollbars
        className="h-full min-w-0 flex-1 rounded-none"
        data-workspace-tab-list=""
      >
        <div
          onWheel={handleWheel}
          className="flex h-full w-max min-w-full items-center gap-1.5 px-0.5"
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  aria-label="New thread"
                  data-active-tab={isDraftActive ? "true" : "false"}
                  data-tab-key="new-thread"
                  onClick={onNewTab}
                  className={cn(
                    "shrink-0 ps-[8.5px] text-xs font-normal [-webkit-app-region:no-drag]",
                    isDraftActive
                      ? "bg-accent font-medium text-foreground ring-1 ring-ring/40 shadow-xs"
                      : "text-foreground",
                  )}
                >
                  <Plus className="size-3.5 shrink-0" />
                  <span className="truncate">New thread</span>
                </Button>
              }
            />
            <TooltipPopup side="bottom">New thread</TooltipPopup>
          </Tooltip>

          {effectiveTabs.map((tab) => {
            const isActive = tab.key === currentTabKey;
            const isDragged = tab.key === draggedKey;
            const isDragOver = tab.key === dragOverKey;

            return (
              <ServerThreadTabItem
                key={tab.key}
                tab={tab}
                isActive={isActive}
                isDragged={isDragged}
                isDragOver={isDragOver}
                renamingTitle={renamingTitle}
                onCommitRename={onCommitRename}
                onRenameKeyDown={onRenameKeyDown}
                onOpenThreadMenu={(rect) => {
                  if (rect && onOpenThreadMenu) {
                    onOpenThreadMenu(rect);
                  }
                }}
                onActivate={() => handleNavigateToTab(tab)}
                onClose={(e) => handleCloseTab(tab, e)}
                onAuxClick={(e) => handleTabAuxClick(e, tab)}
                onContextMenu={(e) => void handleTabContextMenu(e, tab)}
                onDragStart={(e) => handleDragStart(e, tab.key)}
                onDragOver={(e) => handleDragOver(e, tab.key)}
                onDragLeave={() => handleDragLeave(tab.key)}
                onDrop={(e) => handleDrop(e, tab.key)}
                onDragEnd={handleDragEnd}
              />
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
