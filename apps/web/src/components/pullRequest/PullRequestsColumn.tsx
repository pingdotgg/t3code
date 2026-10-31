import type { PullRequestListState } from "@t3tools/contracts";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
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
  onFocusWithin,
}: {
  searchInput: ReactNode;
  searchValue: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * An unmount fires no blur, which is the point: whoever unmounted this can still see the reader
   * was mid-typing and move the focus somewhere that continues the sentence.
   */
  onFocusWithin?: (focused: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the search input DOM node when the topbar search opens
  useEffect(() => {
    if (!open) return;
    containerRef.current?.querySelector("input")?.focus();
  }, [open]);
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

/**
 * The pull request list column. Its header holds the whole scope on one row: the page and the
 * host it reads on the left, then state, sort, filters, a folded search and refresh on the
 * right. In a narrow column the menus drop their words and keep their glyphs. The header is
 * the window drag region; its interactive children opt out through the `.drag-region`
 */
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
  rightPanelControl,
  titlebarControls,
  rightPanelOpen,
  maximizedAway,
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
  rightPanelControl: ReactNode;
  titlebarControls: ReactNode;
  rightPanelOpen: boolean;
  maximizedAway: boolean;
  listBody: ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const contentArea = workspaceAreaProps("pull-requests", 1, "Pull requests");
  const [searchOpen, setSearchOpen] = useState(false);
  const topbarSearchRef = useRef<HTMLDivElement | null>(null);
  // shortcut would otherwise do nothing. It unfolds the header search and selects the query
  // the way a find field would.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener focuses the visible search input on Cmd/Ctrl+F
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
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
  }, []);
  const searchExpanded = searchOpen || searchValue.length > 0;

  return (
    <div
      {...contentArea}
      inert={maximizedAway}
      className={cn(
        "@container/pr-list flex min-h-0 min-w-0 flex-col overflow-x-hidden bg-background",
        maximizedAway ? "w-0 flex-none" : "flex-1",
      )}
    >
      {}
      <WorkspacePageHeader
        electron={isElectron}
        reserveNativeControls={!rightPanelOpen}
        className="relative bg-background"
      >
        {titlebarControls}
        <WorkspaceBreadcrumb ariaLabel="Pull request scope" className="overflow-hidden">
          {/* An expanded search owns the scarce horizontal space in a narrow column. The page
              title stays available to readers either way. */}
          <WorkspaceBreadcrumbItem
            current
            className={cn("gap-1.5", searchExpanded && "sr-only @3xl/pr-list:not-sr-only")}
          >
            <PullRequestGlyph.pullRequest aria-hidden className="size-3.5 shrink-0" />
            <h1 className="truncate">Pull requests</h1>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator
            className={cn(searchExpanded && "hidden @3xl/pr-list:flex")}
          >
            <ChevronRightIcon className="size-3" />
          </WorkspaceBreadcrumbSeparator>
          <WorkspaceBreadcrumbItem className="shrink">
            <PullRequestCompactFilterMenu
              label="Filter by provider"
              value={host ?? ""}
              options={hostMenuOptions}
              onChange={(next) => onHost(next === "" ? undefined : next)}
            />
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <div className="min-w-0 flex-1" />
        <div ref={topbarSearchRef} className="flex shrink items-center gap-0.5">
          <PullRequestCompactFilterMenu
            label="Filter by state"
            value={state}
            options={STATE_TABS}
            onChange={onState}
            className="shrink-0"
            labelClassName="hidden @3xl/pr-list:inline"
          />
          {sortMenu}
          {filtersMenu}
          <ExpandableSearch
            searchInput={searchInput}
            searchValue={searchValue}
            open={searchOpen}
            onOpenChange={setSearchOpen}
          />
          <PullRequestRefreshControl compact refreshing={refreshing} onRefresh={onRefresh} />
        </div>
        {rightPanelControl}
      </WorkspacePageHeader>

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
