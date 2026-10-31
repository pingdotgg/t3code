import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { isElectron } from "../../env";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  LAYOUT_TAB_ICON_CLASS,
  LAYOUT_TAB_SLOT_CLASS,
  LayoutPaneTab,
  LayoutTabCloseButton,
  useLayoutPaneSiblingTabs,
} from "../../layout/PaneTabs";
import { useLayoutPane } from "../../layout/layoutPaneContext";
import { openLayoutNewTab } from "../../layout/layoutActions";
import { useLayoutStore } from "../../layout/layoutStore";
import { cn } from "../../lib/utils";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { PANE_TAB_CLASS, PaneNotch } from "../PaneNotch";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Utility pages share this tab chrome; standalone pages omit layout siblings. */
export function SettingsTabNotch({
  icon,
  children,
  title = "Settings",
  modal = false,
}: {
  icon: ReactNode;
  children: ReactNode;
  title?: string;
  modal?: boolean;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "tab.new");
  const { tabId } = useLayoutPane();
  const navigate = useNavigate();
  const siblingTabs = useLayoutPaneSiblingTabs();
  return (
    <PaneNotch>
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {modal ? null : siblingTabs.before.map((tab) => <LayoutPaneTab key={tab.id} tab={tab} />)}
        <span className={cn(LAYOUT_TAB_SLOT_CLASS, "min-w-15")}>
          {/* Uncapped, unlike a chat tab: its breadcrumb filters use the header's free room. */}
          <div className={cn(PANE_TAB_CLASS, "max-w-none")} data-layout-settings-tab="">
            <span className={LAYOUT_TAB_ICON_CLASS}>{icon}</span>
            {children}
          </div>
          {!modal && tabId !== null ? <LayoutTabCloseButton tabId={tabId} title={title} /> : null}
        </span>
        {modal ? null : siblingTabs.after.map((tab) => <LayoutPaneTab key={tab.id} tab={tab} />)}
      </div>
      {modal ? null : (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="bare"
              size="icon-xs"
              data-pane-notch-add=""
              aria-label="New tab"
              onClick={() => {
                if (tabId !== null) useLayoutStore.getState().focusTab(tabId);
                openLayoutNewTab();
                // A page outside the layout (pull requests, usage) goes to it.
                if (tabId === null) void navigate({ to: "/" });
              }}
            />
          }
        >
          <PlusIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">New tab{shortcut ? ` (${shortcut})` : ""}</TooltipPopup>
      </Tooltip>
      )}
    </PaneNotch>
  );
}

/**
 * The Settings pane's header row, laid out like a chat pane's: only the pane
 * at the window's top-left makes room for the collapsed sidebar's controls,
 * and only the one at its top-right for the window's caption buttons, unless
 * `trailingEdge` says a panel beside the header holds that corner.
 */
export function SettingsPaneHeader({
  trailingEdge: trailingEdgeOverride,
  modal = false,
  className,
  children,
}: {
  trailingEdge?: boolean;
  modal?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const pane = useLayoutPane();
  const { leadingEdge } = pane;
  const trailingEdge = trailingEdgeOverride ?? pane.trailingEdge;
  return (
    <WorkspacePageHeader
      electron={isElectron && !modal}
      reserveNativeControls={isElectron && trailingEdge && !modal}
      collapsedSidebarInset={leadingEdge && !modal}
      className={cn("relative z-10 md:pl-0", className)}
      data-pane-header=""
      data-floating-pane-header=""
    >
      <div className="flex w-full min-w-0 items-center gap-3 self-stretch">{children}</div>
    </WorkspacePageHeader>
  );
}
