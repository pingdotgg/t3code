import { useAtomValue } from "@effect/atom-react";
import { PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { isElectron } from "../../env";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  LAYOUT_TAB_ICON_CLASS,
  LAYOUT_TAB_SLOT_CLASS,
  LayoutPaneTab,
  LayoutPaneTabStrip,
  LayoutTabCloseButton,
  showLayoutTabMenu,
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

/** Utility pages share this tab chrome. */
export function SettingsTabNotch({
  icon,
  children,
  title = "Settings",
}: {
  icon: ReactNode;
  children: ReactNode;
  title?: string;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "tab.new");
  const { tabId } = useLayoutPane();
  const siblingTabs = useLayoutPaneSiblingTabs();
  return (
    <PaneNotch>
      <LayoutPaneTabStrip>
        {siblingTabs.before.map((tab) => (
          <LayoutPaneTab key={tab.id} tab={tab} />
        ))}
        <span className={LAYOUT_TAB_SLOT_CLASS}>
          {/* Uncapped, unlike a chat tab: its breadcrumb filters use the header's free room. */}
          <div
            className={cn(PANE_TAB_CLASS, "max-w-none")}
            data-layout-pane-tab={tabId ?? undefined}
            data-layout-settings-tab=""
            onContextMenu={(event) => {
              if (tabId === null) return;
              event.preventDefault();
              void showLayoutTabMenu(tabId, { x: event.clientX, y: event.clientY }, keybindings);
            }}
          >
            <span className={LAYOUT_TAB_ICON_CLASS}>{icon}</span>
            {children}
          </div>
          {tabId !== null ? <LayoutTabCloseButton tabId={tabId} title={title} /> : null}
        </span>
        {siblingTabs.after.map((tab) => (
          <LayoutPaneTab key={tab.id} tab={tab} />
        ))}
      </LayoutPaneTabStrip>
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
              }}
            />
          }
        >
          <PlusIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">New tab{shortcut ? ` (${shortcut})` : ""}</TooltipPopup>
      </Tooltip>
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
  transparent = false,
  className,
  children,
}: {
  trailingEdge?: boolean;
  transparent?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const pane = useLayoutPane();
  const { leadingEdge } = pane;
  const trailingEdge = trailingEdgeOverride ?? pane.trailingEdge;
  return (
    <WorkspacePageHeader
      electron={isElectron}
      reserveNativeControls={isElectron && trailingEdge}
      collapsedSidebarInset={leadingEdge}
      className={cn("relative z-10 md:pl-0", className)}
      data-pane-header=""
      data-floating-pane-header={transparent ? undefined : ""}
    >
      <div className="flex w-full min-w-0 items-center gap-3 self-stretch">{children}</div>
    </WorkspacePageHeader>
  );
}
