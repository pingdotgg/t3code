import { Maximize2Icon, Minimize2Icon, PanelBottomIcon } from "lucide-react";
import { memo } from "react";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarPanelIcon } from "../icons/custom";

interface PanelLayoutControlsProps {
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  onToggleTerminal: () => void;
  onToggleRightPanel: () => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  onToggleTerminal,
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      <TerminalDrawerToggleControl
        available={terminalAvailable}
        open={terminalOpen}
        shortcutLabel={terminalShortcutLabel}
        onToggle={onToggleTerminal}
      />
      <RightPanelToggleControl
        available={rightPanelAvailable}
        open={rightPanelOpen}
        shortcutLabel={rightPanelShortcutLabel}
        onToggle={onToggleRightPanel}
      />
    </div>
  );
});

export const TerminalDrawerToggleControl = memo(function TerminalDrawerToggleControl({
  available,
  open,
  shortcutLabel,
  onToggle,
}: {
  available: boolean;
  open: boolean;
  shortcutLabel: string | null;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={open}
            onPressedChange={onToggle}
            aria-label="Toggle terminal drawer"
            variant="ghost"
            size="sm"
            disabled={!available}
          >
            <PanelBottomIcon className="size-3.5" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {available
          ? `Toggle terminal drawer${shortcutLabel ? ` (${shortcutLabel})` : ""}`
          : "Terminal drawer is unavailable"}
      </TooltipPopup>
    </Tooltip>
  );
});

export const RightPanelToggleControl = memo(function RightPanelToggleControl({
  available,
  open,
  shortcutLabel,
  onToggle,
}: {
  available: boolean;
  open: boolean;
  shortcutLabel: string | null;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={open}
            onPressedChange={onToggle}
            aria-label={open ? "Close right panel" : "Open right panel"}
            variant="ghost"
            size="sm"
            disabled={!available}
          >
            <SidebarPanelIcon className="size-4 rotate-180" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {available
          ? `${open ? "Close" : "Open"} right panel${shortcutLabel ? ` (${shortcutLabel})` : ""}`
          : "Right panel is unavailable"}
      </TooltipPopup>
    </Tooltip>
  );
});

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  maximized,
  onToggle,
}: {
  maximized: boolean;
  onToggle: () => void;
}) {
  const label = maximized ? "Restore panel size" : "Maximize panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost"
            size="sm"
          >
            {maximized ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});
