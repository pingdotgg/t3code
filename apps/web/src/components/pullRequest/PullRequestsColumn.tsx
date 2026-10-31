import type { PullRequestListState } from "@t3tools/contracts";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { cn } from "~/lib/utils";
import { useLayoutPaneFocusedRef } from "~/layout/layoutPaneContext";
import { Button } from "../ui/button";
import { PaneNotch } from "../PaneNotch";
import { RefreshIcon } from "../ui/refresh-icon";
import { SettingsPaneHeader, SettingsTabNotch } from "../settings/SettingsTabNotch";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { PullRequestGlyph } from "./pullRequestIcons";
import { PullRequestCompactFilterMenu } from "./PullRequestCompactFilterMenu";
import type { PullRequestFilterOption } from "./PullRequestListFilters";
import { STATE_TABS } from "./pullRequestListOptions";

function ExpandableSearch({
  searchInput,
  searchValue,
  open,
  onOpenChange,
  containerRef,
  onFocusWithin,
}: {
  searchInput: ReactNode;
  searchValue: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  containerRef: RefObject<HTMLDivElement | null>;
  /**
   * An unmount fires no blur, which is the point: whoever unmounted this can still see the reader
   * was mid-typing and move the focus somewhere that continues the sentence.
   */
  onFocusWithin?: (focused: boolean) => void;
}) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the search input DOM node when the topbar search opens
  useEffect(() => {
    if (!open) return;
    containerRef.current?.querySelector("input")?.focus();
  }, [containerRef, open]);
  if (open || searchValue.length > 0) {
    return (
      <div
        ref={containerRef}
        className="w-56 min-w-24 shrink"
        onFocus={() => onFocusWithin?.(true)}
        onBlur={() => {
          onFocusWithin?.(false);
          if (searchValue.length === 0) onOpenChange(false);
        }}
      >
        {searchInput}
      </div>
    );
  }
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label="Search pull requests"
      onClick={() => onOpenChange(true)}
    >
      <SearchIcon className="size-4" />
    </Button>
  );
}

/** Header controls opt out of the window drag region; narrow columns fold them. */
export function PullRequestsColumn({
  refreshing,
  onRefresh,
  searchValue,
  state,
  host,
  hostMenuOptions,
  onState,
  onHost,
  searchInput,
  sortMenu,
  filtersMenu,
  compactMenu,
  rightPanelOpen,
  maximizedAway,
  split,
  listBody,
  scrollRef,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  searchValue: string;
  state: PullRequestListState;
  host: string | undefined;
  hostMenuOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onState: (state: PullRequestListState) => void;
  onHost: (host: string | undefined) => void;
  searchInput: ReactNode;
  sortMenu: ReactNode;
  filtersMenu: ReactNode;
  /** State, sort, filters and refresh in one menu, for a narrow column. */
  compactMenu: ReactNode;
  rightPanelOpen: boolean;
  maximizedAway: boolean;
  /** Whether the list sits beside an open review as its own pane. */
  split: boolean;
  listBody: ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const contentArea = workspaceAreaProps("pull-requests", 1, "Pull requests");
  const focusedRef = useLayoutPaneFocusedRef();
  const [searchOpen, setSearchOpen] = useState(false);
  const topbarSearchRef = useRef<HTMLDivElement | null>(null);
  // shortcut would otherwise do nothing. It unfolds the header search and selects the query
  // the way a find field would.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener focuses the visible search input on Cmd/Ctrl+F
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!focusedRef.current || event.defaultPrevented) return;
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      setSearchOpen(true);
      const input = topbarSearchRef.current?.querySelector("input");
      input?.focus();
      input?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusedRef]);
  const searchExpanded = searchOpen || searchValue.length > 0;

  return (
    <div
      {...contentArea}
      inert={maximizedAway}
      data-pane-notch-host={split ? "" : undefined}
      className={cn(
        "@container/pr-list flex min-h-0 min-w-0 flex-col overflow-x-hidden bg-background",
        maximizedAway ? "w-0 flex-none" : "flex-1",
        // Beside an open review the list is a pane of its own, its corner given to the notch.
        split && "overflow-hidden surface-grain md:rounded-pane md:rounded-ss-none",
      )}
    >
      {/* A closed right panel leaves this column full-width, so the header reserves native
          window controls. */}
      <SettingsPaneHeader trailingEdge={!rightPanelOpen}>
        <SettingsTabNotch
          title="Pull requests"
          icon={
            <PullRequestGlyph.pullRequest
              aria-hidden
              className="size-3.5 shrink-0 text-foreground"
            />
          }
        >
          <nav aria-label="Pull request scope" className="flex min-w-0 items-center gap-1.75">
            {/* An expanded search owns the scarce horizontal space in a narrow column. The page
                title stays available to readers either way. */}
            <h1 className={cn("shrink-0", searchExpanded && "sr-only @3xl/pr-list:not-sr-only")}>
              Pull requests
            </h1>
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-dim-foreground",
                searchExpanded && "hidden @3xl/pr-list:block",
              )}
            />
            <PullRequestCompactFilterMenu
              inline
              className="shrink"
              label="Filter by provider"
              value={host ?? ""}
              options={hostMenuOptions}
              onChange={(next) => onHost(next === "" ? undefined : next)}
            />
          </nav>
        </SettingsTabNotch>
        <PaneNotch side="right" className="ms-auto shrink-0 gap-0.5">
          <div className="hidden items-center gap-0.5 @3xl/pr-list:flex">
            <PullRequestCompactFilterMenu
              label="Filter by state"
              value={state}
              options={STATE_TABS}
              onChange={onState}
              className="shrink-0"
            />
            {sortMenu}
            {filtersMenu}
          </div>
          <ExpandableSearch
            searchInput={searchInput}
            searchValue={searchValue}
            open={searchOpen}
            onOpenChange={setSearchOpen}
            containerRef={topbarSearchRef}
          />
          <div className="flex items-center @3xl/pr-list:hidden">{compactMenu}</div>
          <div className="hidden items-center @3xl/pr-list:flex">
            <PullRequestRefreshControl compact refreshing={refreshing} onRefresh={onRefresh} />
          </div>
        </PaneNotch>
      </SettingsPaneHeader>

      <div ref={scrollRef} className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
          {listBody}
        </WorkspacePageContainer>
      </div>
    </div>
  );
}

function PullRequestRefreshControl({
  compact = false,
  refreshing,
  onRefresh,
}: {
  compact?: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <Button
      size={compact ? "icon-sm" : "icon"}
      variant="ghost-muted"
      aria-label="Refresh pull requests"
      onClick={onRefresh}
      disabled={refreshing}
    >
      <RefreshIcon size="md" refreshing={refreshing} />
    </Button>
  );
}
