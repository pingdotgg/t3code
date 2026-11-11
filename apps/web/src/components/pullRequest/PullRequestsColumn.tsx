import type { PullRequestInvolvement, PullRequestListState } from "@t3tools/contracts";
import { Plug2Icon, SearchIcon } from "lucide-react";
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
import { PullRequestCompactFilterMenu } from "./PullRequestCompactFilterMenu";
import type { PullRequestFilterOption } from "./PullRequestListFilters";
import { INVOLVEMENT_TABS, STATE_TABS } from "./pullRequestListOptions";

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

export function PullRequestsColumn({
  refreshing,
  onRefresh,
  searchValue,
  involvement,
  state,
  host,
  hostMenuOptions,
  onInvolvement,
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
  involvement: PullRequestInvolvement;
  state: PullRequestListState;
  host: string | undefined;
  hostMenuOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onInvolvement: (involvement: PullRequestInvolvement) => void;
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
  const markerRef = useRef<HTMLDivElement | null>(null);
  const [condensed, setCondensed] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- IntersectionObserver on the scroll marker condenses the topbar
  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const observer = new IntersectionObserver(
      ([entry]) => setCondensed(entry ? !entry.isIntersecting : false),
      { root: scrollRef.current },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [scrollRef]);
  // Typing into the topbar search narrows the list, and a short enough list un-scrolls the
  // page — which dissolves the condensed topbar and unmounts the very input being typed in.
  const topbarSearchFocusedRef = useRef(false);
  const inFlowSearchRef = useRef<HTMLDivElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const topbarSearchRef = useRef<HTMLDivElement | null>(null);
  const searchExpanded = searchOpen || searchValue.length > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener focuses the visible search input on Cmd/Ctrl+F
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      // A closed topbar search has no input yet; opening it mounts one that focuses itself.
      if (condensed) setSearchOpen(true);
      const input = (condensed ? topbarSearchRef : inFlowSearchRef).current?.querySelector("input");
      input?.focus();
      input?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [condensed]);
  if (!condensed && searchOpen) setSearchOpen(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus to the in-flow search when the topbar search it was typed in unmounts
  useEffect(() => {
    if (condensed) return;
    if (!topbarSearchFocusedRef.current) return;
    topbarSearchFocusedRef.current = false;
    const input = inFlowSearchRef.current?.querySelector("input");
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [condensed]);

  return (
    <div
      {...contentArea}
      inert={maximizedAway}
      className={cn(
        "@container/pr-list flex min-h-0 min-w-0 flex-col overflow-x-hidden bg-background",
        maximizedAway ? "w-0 flex-none" : "flex-1",
      )}
    >
      <WorkspacePageHeader
        electron={isElectron}
        reserveNativeControls={!rightPanelOpen}
        className="relative bg-background"
      >
        {titlebarControls}
        {condensed ? (
          <WorkspaceBreadcrumb ariaLabel="Pull request scope" className="overflow-hidden">
            <WorkspaceBreadcrumbItem current className={cn(searchExpanded && "sr-only")}>
              <h1 className="truncate">Pull requests</h1>
            </WorkspaceBreadcrumbItem>
            {searchExpanded ? null : <WorkspaceBreadcrumbSeparator />}
            <WorkspaceBreadcrumbItem className="shrink gap-1.5">
              <PullRequestCompactFilterMenu
                label="Filter by state"
                value={state}
                options={STATE_TABS}
                onChange={onState}
                className="shrink-0"
              />
              <PullRequestCompactFilterMenu
                label="Filter by involvement"
                value={involvement}
                options={INVOLVEMENT_TABS}
                onChange={onInvolvement}
              />
              {hostMenuOptions.length > 2 ? (
                <PullRequestCompactFilterMenu
                  label="Filter by host"
                  value={host ?? ""}
                  options={hostMenuOptions}
                  onChange={(next) => onHost(next === "" ? undefined : next)}
                />
              ) : null}
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        ) : (
          <WorkspaceBreadcrumb ariaLabel="Pull requests breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Pull requests</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        )}
        <div className="min-w-0 flex-1" />
        {condensed ? (
          <div ref={topbarSearchRef} className="flex shrink items-center gap-1.5">
            <ExpandableSearch
              searchInput={searchInput}
              searchValue={searchValue}
              open={searchOpen}
              onOpenChange={setSearchOpen}
              onFocusWithin={(focused) => {
                topbarSearchFocusedRef.current = focused;
              }}
            />
            <PullRequestRefreshControl compact refreshing={refreshing} onRefresh={onRefresh} />
          </div>
        ) : null}
        {rightPanelControl}
      </WorkspacePageHeader>

      <div
        ref={scrollRef}
        className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto"
      >
        <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
          <div className="flex flex-col gap-3">
            <div ref={inFlowSearchRef} className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 basis-full @lg/pr-list:basis-0 @lg/pr-list:flex-1">
                {searchInput}
              </div>
              {sortMenu}
              {filtersMenu}
              <PullRequestCompactFilterMenu
                label="Filter by provider"
                outlined
                iconOnly={host !== undefined}
                triggerIcon={<Plug2Icon aria-hidden className="size-4" />}
                triggerLabel="All"
                value={host ?? ""}
                options={hostMenuOptions}
                onChange={(next) => onHost(next === "" ? undefined : next)}
              />
              {!condensed ? (
                <PullRequestRefreshControl refreshing={refreshing} onRefresh={onRefresh} />
              ) : null}
            </div>
            <div ref={markerRef} aria-hidden className="-mt-3 h-px w-full" />
          </div>

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
      variant={compact ? "ghost" : "outline"}
      aria-label="Refresh pull requests"
      onClick={onRefresh}
      disabled={refreshing}
    >
      <RefreshIcon size="md" refreshing={refreshing} />
    </Button>
  );
}
