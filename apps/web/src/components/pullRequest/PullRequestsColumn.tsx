import { T, useGT } from "gt-react";
import { Plug2Icon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { isElectron } from "~/env";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ToolbarGroup } from "../ToolbarGroup";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { PullRequestCompactFilterMenu } from "./PullRequestCompactFilterMenu";
import type { PullRequestFilterOption } from "./PullRequestListFilters";

/** Below this the toolbar's labeled buttons keep only their icons, so the search keeps room. */
const TOOLBAR_LABELS_MIN_WIDTH = 600;

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
  titlebarControls,
  rightPanelOpen,
  rightPanelPresent,
  maximizedAway,
  listBody,
  scrollRef,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  host: string | undefined;
  hostMenuOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onHost: (host: string | undefined) => void;
  searchInput: ReactNode;
  /** The three list menus render as ghost buttons in the toolbar pill; `collapsed` keeps their icons. */
  sortMenu: (toolbar: { collapsed: boolean }) => ReactNode;
  filtersMenu: (toolbar: { collapsed: boolean }) => ReactNode;
  savedViewsMenu: (toolbar: { collapsed: boolean }) => ReactNode;
  titlebarControls: ReactNode;
  rightPanelOpen: boolean;
  rightPanelPresent: boolean;
  maximizedAway: boolean;
  listBody: ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const gt = useGT();
  const contentArea = workspaceAreaProps("pull-requests", 1, gt("Pull requests"));
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the toolbar row to drop the button labels when it is narrow
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const measure = () => setCollapsed(toolbar.clientWidth < TOOLBAR_LABELS_MIN_WIDTH);
    measure();
    return observeResize(toolbar, measure);
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener focuses the search input on Cmd/Ctrl+F
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      const input = toolbarRef.current?.querySelector("input");
      input?.focus();
      input?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      {...contentArea}
      inert={maximizedAway}
      className={cn(
        "@container/pr-list flex min-h-0 min-w-0 flex-col overflow-x-hidden",
        maximizedAway ? "w-0 flex-none" : "flex-1",
      )}
    >
      {/* The chat header's frame: glass at the shell header's height, over the card below. */}
      <header
        className={cn(
          "relative z-10 flex h-(--shell-header-height) min-h-(--shell-header-height) shrink-0 items-center bg-transparent! [--control-radius:9999px]",
          isElectron
            ? cn(
                "drag-region px-3 sm:px-5",
                !rightPanelOpen && "wco:pr-(--workspace-native-controls-inset)",
              )
            : "pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        {titlebarControls}
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
            rightPanelOpen ? "pr-10" : "pr-24",
          )}
        >
          <WorkspaceBreadcrumb
            ariaLabel={gt("Pull requests breadcrumb")}
            className="flex-1 overflow-clip [overflow-clip-margin:2px]"
          >
            <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
              <h1 className="min-w-0 truncate">
                <WorkspaceBreadcrumbText>
                  <T>Pull requests</T>
                </WorkspaceBreadcrumbText>
              </h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </div>
      </header>

      <div
        data-pr-card=""
        data-shell-sidebar-edge=""
        data-shell-join-right={rightPanelPresent ? "" : undefined}
        className={cn(
          // The chat card: same fill and inset, right corners round unless the panel joins them.
          "relative z-0 mb-(--shell-inset) flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden shell-inner-panel [--background:var(--shell-card)]",
          !rightPanelPresent &&
            "mr-(--shell-inset) rounded-tr-(--shell-corner) rounded-br-(--shell-corner)",
        )}
      >
        {/* Search fills the row; the controls sit in Conn's toolbar pills, as on the Tasks board. */}
        <div
          ref={toolbarRef}
          data-pr-toolbar=""
          className="flex shrink-0 items-center gap-2 border-b border-(--shell-divider)! px-2 py-toolbar"
        >
          {searchInput}
          {/* Shape the list: its order, what it holds, and the views that save both. */}
          <ToolbarGroup role="group" aria-label={gt("List")} className="shrink-0">
            {sortMenu({ collapsed })}
            {filtersMenu({ collapsed })}
            {savedViewsMenu({ collapsed })}
          </ToolbarGroup>
          {/* Which provider's pull requests are read: a source, not a list setting. */}
          <ToolbarGroup role="group" aria-label={gt("Provider")} className="shrink-0">
            <PullRequestCompactFilterMenu
              grouped
              label={gt("Filter by provider")}
              triggerIcon={
                host === undefined ? <Plug2Icon aria-hidden className="size-4" /> : undefined
              }
              triggerLabel={gt("All", { $context: "all providers" })}
              iconOnly={collapsed || host !== undefined}
              value={host ?? ""}
              options={hostMenuOptions}
              onChange={(next) => onHost(next === "" ? undefined : next)}
            />
          </ToolbarGroup>
          <ToolbarGroup role="group" aria-label={gt("Refresh")} className="shrink-0">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost-muted"
                    size="icon-toolbar"
                    aria-label={gt("Refresh pull requests")}
                    onClick={onRefresh}
                    disabled={refreshing}
                  />
                }
              >
                <RefreshIcon size="md" refreshing={refreshing} />
              </TooltipTrigger>
              <TooltipPopup>{gt("Refresh pull requests")}</TooltipPopup>
            </Tooltip>
          </ToolbarGroup>
        </div>

        {/* Full width, with the toolbar row's 8px side inset: the list's icons then line up with the search field's. */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-background">
          <div className="flex min-h-full flex-col gap-4 px-2 pt-3.5 pb-12">{listBody}</div>
        </div>
      </div>
    </div>
  );
}
