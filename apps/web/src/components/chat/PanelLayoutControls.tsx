import { Maximize2Icon, Minimize2Icon, PanelBottomIcon, PanelRightIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface PanelLayoutControlsProps {
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  rightPanelMaximized: boolean;
  canMaximizeRightPanel: boolean;
  onToggleTerminal: () => void;
  onToggleRightPanel: () => void;
  onToggleRightPanelMaximized: () => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  rightPanelMaximized,
  canMaximizeRightPanel,
  onToggleTerminal,
  onToggleRightPanel,
  onToggleRightPanelMaximized,
}: PanelLayoutControlsProps) {
  return (
    <div
      className={cn("workspace-titlebar-controls z-50 gap-1 [-webkit-app-region:no-drag]")}
      data-panel-layout-controls
    >
      {rightPanelOpen ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 [-webkit-app-region:no-drag]"
                pressed={rightPanelMaximized}
                onPressedChange={onToggleRightPanelMaximized}
                aria-label={rightPanelMaximized ? "Restore panel size" : "Maximize panel"}
                variant="ghost"
                size="sm"
                disabled={!canMaximizeRightPanel}
              >
                {rightPanelMaximized ? (
                  <Minimize2Icon className="size-3.5" />
                ) : (
                  <Maximize2Icon className="size-3.5" />
                )}
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {canMaximizeRightPanel
              ? rightPanelMaximized
                ? "Restore panel size"
                : "Maximize panel"
              : "Panel maximization is unavailable at this width"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={terminalOpen}
              onPressedChange={onToggleTerminal}
              aria-label="Toggle terminal drawer"
              variant="ghost"
              size="sm"
              disabled={!terminalAvailable}
            >
              <PanelBottomIcon className="size-3.5" />
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          {terminalAvailable
            ? `Toggle terminal drawer${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
            : "Terminal drawer is unavailable"}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={rightPanelOpen}
              onPressedChange={onToggleRightPanel}
              aria-label="Toggle right panel"
              variant="ghost"
              size="sm"
              disabled={!rightPanelAvailable}
            >
              <PanelRightIcon className="size-3.5" />
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          {rightPanelAvailable
            ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}`
            : "Right panel is unavailable"}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});
