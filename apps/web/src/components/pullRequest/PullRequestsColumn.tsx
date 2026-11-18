import { T, useGT } from "gt-react";
import { Plug2Icon } from "lucide-react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import { cn } from "~/lib/utils";
import { useLayoutPaneFocusedRef } from "~/layout/layoutPaneContext";
import { Button } from "../ui/button";
import { PANE_BODY_UNDER_HEADER_CLASS } from "../PaneNotch";
import { RefreshIcon } from "../ui/refresh-icon";
import { SettingsPaneHeader, SettingsTabNotch } from "../settings/SettingsTabNotch";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { PullRequestGlyph } from "./pullRequestIcons";
import { PullRequestCompactFilterMenu } from "./PullRequestCompactFilterMenu";
import type { PullRequestFilterOption } from "./PullRequestListFilters";

export function PullRequestsColumn({
  refreshing,
  onRefresh,
  host,
  hostMenuOptions,
  onHost,
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
  refreshing: boolean;
  onRefresh: () => void;
  host: string | undefined;
  hostMenuOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onHost: (host: string | undefined) => void;
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
  const gt = useGT();
  const contentArea = workspaceAreaProps("pull-requests", 1, gt("Pull requests"));
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
      {/* A closed right panel leaves this column full-width, so the header reserves native
          window controls. */}
      <SettingsPaneHeader transparent trailingEdge={!rightPanelOpen}>
        <SettingsTabNotch
          title={gt("Pull requests")}
          icon={
            <PullRequestGlyph.pullRequest
              aria-hidden
              className="size-3.5 shrink-0 text-foreground"
            />
          }
        >
          <h1 className="truncate">
            <T>Pull requests</T>
          </h1>
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
                <PullRequestCompactFilterMenu
                  label={gt("Filter by provider")}
                  iconOnly={host !== undefined}
                  triggerIcon={<Plug2Icon aria-hidden className="size-4" />}
                  triggerLabel={gt("All", { $context: "all providers" })}
                  value={host ?? ""}
                  options={hostMenuOptions}
                  onChange={(next) => onHost(next === "" ? undefined : next)}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={gt("Refresh pull requests")}
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
