import {
  ListFilterIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelBottomIcon,
  PanelRightIcon,
} from "lucide-react";
import { memo, type ReactElement, type ReactNode, type RefObject } from "react";

import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface PanelLayoutControlsProps {
  showThreadPanelControl?: boolean;
  showTerminalControl?: boolean;
  showRightPanelControl?: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  threadPanelOpen: boolean;
  threadPanelPresentation: ThreadPanelPresentation;
  threadPanelPopoverAnchor?: RefObject<Element | null>;
  threadPanelPopoverContent?: ReactNode;
  threadPanelShortcutLabel: string | null;
  threadPanelHasAttention: boolean;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  /** Running + waiting subagents in this thread; badges the right panel toggle. */
  liveAgentCount: number;
  onToggleTerminal: () => void;
  onToggleThreadPanel: () => void;
  onToggleRightPanel: () => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  showThreadPanelControl = true,
  showTerminalControl = true,
  showRightPanelControl = true,
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  threadPanelOpen,
  threadPanelPresentation,
  threadPanelPopoverAnchor,
  threadPanelPopoverContent,
  threadPanelShortcutLabel,
  threadPanelHasAttention,
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  liveAgentCount,
  onToggleTerminal,
  onToggleThreadPanel,
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  const threadPanelToggle = (
    <Toggle
      className="relative shrink-0 [-webkit-app-region:no-drag]"
      pressed={threadPanelOpen}
      aria-label="Toggle thread details panel"
      variant="ghost"
      size="sm"
    >
      <ListFilterIcon className="size-4" />
      {threadPanelHasAttention ? (
        <span
          className="absolute right-1 top-1 size-1.5 rounded-full bg-warning ring-2 ring-background"
          aria-hidden="true"
        />
      ) : null}
    </Toggle>
  );
  const threadPanelTooltip = (trigger: ReactElement) => (
    <Tooltip>
      <TooltipTrigger
        render={trigger}
        {...(threadPanelPresentation === "popover" ? {} : { onClick: onToggleThreadPanel })}
      />
      <TooltipPopup side="bottom">
        Toggle thread details
        {threadPanelShortcutLabel ? ` (${threadPanelShortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );

  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      {showThreadPanelControl ? (
        threadPanelPresentation === "popover" ? (
          <Popover
            open={threadPanelOpen}
            onOpenChange={(open) => {
              if (open !== threadPanelOpen) onToggleThreadPanel();
            }}
          >
            {threadPanelTooltip(<PopoverTrigger render={threadPanelToggle} />)}
            <PopoverPopup
              anchor={threadPanelPopoverAnchor}
              align="end"
              alignOffset={0}
              collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
              side="bottom"
              sideOffset={0}
              positionerClassName="w-[min(var(--thread-details-panel-width),var(--anchor-width))] !transition-none"
              className="w-full !overflow-visible rounded-none border-0 bg-transparent shadow-none before:hidden [--viewport-inline-padding:0] [-webkit-backdrop-filter:none] [backdrop-filter:none]"
              viewportClassName="!overflow-visible p-2"
            >
              {threadPanelPopoverContent}
            </PopoverPopup>
          </Popover>
        ) : (
          threadPanelTooltip(threadPanelToggle)
        )
      ) : null}
      {showTerminalControl ? (
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
                <PanelBottomIcon className="size-4" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {terminalAvailable
              ? `Toggle terminal drawer${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
              : "Terminal drawer is unavailable"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {showRightPanelControl ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 [-webkit-app-region:no-drag]"
                pressed={rightPanelOpen}
                onPressedChange={onToggleRightPanel}
                aria-label={
                  liveAgentCount > 0
                    ? `Toggle right panel, ${liveAgentCount} ${liveAgentCount === 1 ? "agent" : "agents"} working`
                    : "Toggle right panel"
                }
                variant="ghost"
                size="sm"
                disabled={!rightPanelAvailable}
              >
                <PanelRightIcon className="size-4" />
                {liveAgentCount > 0 ? (
                  <span
                    aria-hidden
                    className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
                  >
                    {liveAgentCount}
                  </span>
                ) : null}
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {rightPanelAvailable
              ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}${
                  liveAgentCount > 0
                    ? ` · ${liveAgentCount} ${liveAgentCount === 1 ? "agent" : "agents"} working`
                    : ""
                }`
              : "Right panel is unavailable"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
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
              <Minimize2Icon className="size-4" />
            ) : (
              <Maximize2Icon className="size-4" />
            )}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});
