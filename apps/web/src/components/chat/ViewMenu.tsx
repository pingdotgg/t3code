import type { ScopedThreadRef } from "@t3tools/contracts";
import { FileDiff, Files, Globe2, LayoutPanelLeft, PanelLeft, TerminalSquare } from "lucide-react";
import type { ComponentType } from "react";

import { resetDockLayout } from "../../dock/dockActions";
import {
  selectRightPanelKindShown,
  useRightPanelStore,
  type RightPanelKind,
} from "../../rightPanelStore";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { useSidebar, useSidebarVisibility } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ViewMenuSurface {
  readonly kind: RightPanelKind;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly available: boolean;
  readonly shortcut: string | null;
  /** Brings the surface up: its existing tab, or a new one. Hiding is the same for every kind. */
  readonly onShow: () => void;
}

function ViewMenuSurfaceItem(props: {
  readonly threadRef: ScopedThreadRef;
  readonly surface: ViewMenuSurface;
}) {
  const { threadRef, surface } = props;
  const Icon = surface.icon;
  const shown = useRightPanelStore((state) =>
    selectRightPanelKindShown(state.byThreadKey, threadRef, surface.kind),
  );
  return (
    <MenuCheckboxItem
      checked={shown}
      closeOnClick
      disabled={!surface.available}
      onCheckedChange={() => {
        if (shown) useRightPanelStore.getState().hideKind(threadRef, surface.kind);
        else surface.onShow();
      }}
    >
      <span className="flex items-center gap-2">
        <Icon className="size-4" />
        {surface.label}
        {surface.shortcut ? <MenuShortcut>{surface.shortcut}</MenuShortcut> : null}
      </span>
    </MenuCheckboxItem>
  );
}

/** Shows and hides panels by name, because a panel can now be anywhere in the window. */
export function ViewMenu(props: {
  readonly threadRef: ScopedThreadRef;
  readonly surfaces: readonly ViewMenuSurface[];
  readonly panelsOpen: boolean;
  readonly panelsAvailable: boolean;
  readonly panelsShortcut: string | null;
  readonly threadsShortcut: string | null;
  readonly onTogglePanels: () => void;
}) {
  const { toggleSidebar } = useSidebar();
  const threadsShown = useSidebarVisibility();
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label="View"
                  className="shrink-0 [-webkit-app-region:no-drag]"
                  data-right-panel-toggle
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <LayoutPanelLeft className="size-4" />
            </MenuTrigger>
          }
        />
        <TooltipPopup side="bottom">View</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" sideOffset={6}>
        <MenuCheckboxItem checked={threadsShown} closeOnClick onCheckedChange={toggleSidebar}>
          <span className="flex items-center gap-2">
            <PanelLeft className="size-4" />
            Threads
            {props.threadsShortcut ? <MenuShortcut>{props.threadsShortcut}</MenuShortcut> : null}
          </span>
        </MenuCheckboxItem>
        {props.surfaces.map((surface) => (
          <ViewMenuSurfaceItem key={surface.kind} threadRef={props.threadRef} surface={surface} />
        ))}
        <MenuSeparator />
        <MenuItem disabled={!props.panelsAvailable} onClick={props.onTogglePanels}>
          {props.panelsOpen ? "Hide all panels" : "Show all panels"}
          {props.panelsShortcut ? <MenuShortcut>{props.panelsShortcut}</MenuShortcut> : null}
        </MenuItem>
        <MenuItem onClick={resetDockLayout}>Reset panel layout</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export const VIEW_MENU_ICONS = {
  terminal: TerminalSquare,
  files: Files,
  diff: FileDiff,
  browser: Globe2,
} as const;
