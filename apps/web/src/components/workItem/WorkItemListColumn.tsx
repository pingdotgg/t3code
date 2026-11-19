import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import { cn } from "~/lib/utils";
import { useLayoutPaneFocusedRef } from "~/layout/layoutPaneContext";
import { Button } from "../ui/button";
import { PANE_BODY_UNDER_HEADER_CLASS } from "../PaneNotch";
import { RefreshIcon } from "../ui/refresh-icon";
import { SettingsPaneHeader, SettingsTabNotch } from "../settings/SettingsTabNotch";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { workspaceAreaProps } from "../../lib/workspaceFocus";

/**
 * A list page's column, shared by Pull requests and Issues: the notch tab with the page's name,
 * the pinned search and list controls, and the scrolling list under them.
 */
export function WorkItemListColumn({
  area,
  title,
  icon,
  refreshLabel,
  refreshing,
  onRefresh,
  providerMenu,
  searchInput,
  sortMenu,
  filtersMenu,
  savedViewsMenu,
  rightPanelOpen,

  maximizedAway,
  split,
  listBody,
  scrollRef,
}: {
  /** The workspace focus area the list's content answers to. */
  area: string;
  title: string;
  icon: ReactNode;
  refreshLabel: string;
  refreshing: boolean;
  onRefresh: () => void;
  /** The filter by host or tracker, absent when there is only one to read. */
  providerMenu: ReactNode;
  searchInput: ReactNode;
  sortMenu: ReactNode;
  filtersMenu: ReactNode;
  savedViewsMenu: ReactNode;
  rightPanelOpen: boolean;

  maximizedAway: boolean;
  /** Whether the list sits beside an open review as its own pane. */
  split: boolean;
  listBody: ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const contentArea = workspaceAreaProps(area, 1, title);
  const focusedRef = useLayoutPaneFocusedRef();
  const searchRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener focuses the visible search input on Cmd/Ctrl+F
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!focusedRef.current || event.defaultPrevented) return;
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      const input = searchRef.current?.querySelector("input");
      input?.focus();
      input?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusedRef]);

  return (
    <div
      {...contentArea}
      inert={maximizedAway}
      data-pane-notch-host={split ? "" : undefined}
      className={cn(
        "pane-mobile-chrome @container/pr-list flex min-h-0 min-w-0 flex-col overflow-x-hidden md:bg-background",
        maximizedAway ? "w-0 flex-none" : "flex-1",
        // Beside an open review the list is a pane of its own, its corner given to the notch.
        split && "overflow-hidden md:rounded-pane md:rounded-ss-none",
      )}
    >
      {/* Beside an open review that pane holds the window's top-right corner; otherwise
          the layout pane's own edge decides. */}
      <SettingsPaneHeader transparent trailingEdge={split || rightPanelOpen ? false : undefined}>
        <SettingsTabNotch title={title} icon={icon}>
          <h1 className="truncate">{title}</h1>
        </SettingsTabNotch>
      </SettingsPaneHeader>

      <div
        data-surface-reaches-under-header=""
        className={cn("flex min-h-0 flex-1 flex-col", PANE_BODY_UNDER_HEADER_CLASS)}
      >
        {/* Outside the scroller, the controls stay pinned without moving or covering rows. */}
        <div className="scrollbar-gutter-both shrink-0 overflow-x-hidden bg-background">
          <WorkspacePageContainer width="expanded" className="pt-under-header-6 pb-4">
            <div className="flex flex-wrap items-center gap-2">
              <div
                ref={searchRef}
                className="min-w-0 basis-full @lg/pr-list:min-w-56 @lg/pr-list:basis-56 @lg/pr-list:flex-1"
              >
                {searchInput}
              </div>
              <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
                {sortMenu}
                {filtersMenu}
                {savedViewsMenu}
                {providerMenu}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={refreshLabel}
                  onClick={onRefresh}
                  disabled={refreshing}
                >
                  <RefreshIcon size="md" refreshing={refreshing} />
                </Button>
              </div>
            </div>
          </WorkspacePageContainer>
        </div>
        <div
          ref={scrollRef}
          className="scrollbar-gutter-both min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        >
          <WorkspacePageContainer width="expanded" className="min-h-full gap-4 pt-0">
            {listBody}
          </WorkspacePageContainer>
        </div>
      </div>
    </div>
  );
}
