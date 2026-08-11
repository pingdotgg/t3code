import { memo } from "react";
import { ActivityIcon, DiffIcon, GlobeIcon, TerminalSquareIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ChatPanelTogglesState {
  terminalAvailable: boolean;
  terminalOpen: boolean;
  browserPreviewOpen: boolean;
  insightsOpen: boolean;
  diffOpen: boolean;
  isGitRepo: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  onToggleTerminal: () => void;
  onToggleBrowserPreview: () => void;
  onToggleInsights: () => void;
  onToggleDiff: () => void;
}

interface ChatPanelTogglesProps extends ChatPanelTogglesState {
  orientation: "vertical" | "horizontal";
  className?: string;
}

const TOGGLE_CLASS = "shrink-0 border-transparent shadow-none hover:border-input hover:shadow-xs/5";

/**
 * The four panel toggles (insights, browser, terminal, diff).
 *
 * They used to sit in the header next to label-bearing controls whose intrinsic
 * widths made the trailing cluster look unevenly spaced. On a wide pane they
 * now render as a vertical rail on the pane's right edge — a uniform column
 * beside the surfaces they open — leaving the header to thread-scoped actions.
 *
 * A narrow layout cannot spare a permanent column without squeezing the
 * composer, so the same toggles render inline in the header instead. The swap
 * rides the breakpoint that already turns the right panels into sheets, so the
 * rail and the surfaces it opens can never disagree about how much room a pane
 * has, and resizing needs no measurement.
 */
export const ChatPanelToggles = memo(function ChatPanelToggles({
  orientation,
  className,
  terminalAvailable,
  terminalOpen,
  browserPreviewOpen,
  insightsOpen,
  diffOpen,
  isGitRepo,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  onToggleTerminal,
  onToggleBrowserPreview,
  onToggleInsights,
  onToggleDiff,
}: ChatPanelTogglesProps) {
  const isRail = orientation === "vertical";
  const tooltipSide = isRail ? "left" : "bottom";

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1",
        isRail &&
          // `pe` carries the right safe-area inset: as the pane's outermost
          // column the rail has to clear a notch or rounded corner itself.
          "w-[calc(env(safe-area-inset-right)+--spacing(9))] flex-col border-s border-border py-2 ps-1.5 pe-[calc(env(safe-area-inset-right)+--spacing(1.5))]",
        className,
      )}
      data-chat-panel-toggles={orientation}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className={TOGGLE_CLASS}
              pressed={insightsOpen}
              onPressedChange={onToggleInsights}
              aria-label="Toggle insights panel"
              variant="outline"
              size="xs"
            >
              <ActivityIcon className="size-3" />
            </Toggle>
          }
        />
        <TooltipPopup side={tooltipSide}>Toggle insights panel</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className={TOGGLE_CLASS}
              pressed={browserPreviewOpen}
              onPressedChange={onToggleBrowserPreview}
              aria-label="Toggle browser preview"
              variant="outline"
              size="xs"
            >
              <GlobeIcon className="size-3" />
            </Toggle>
          }
        />
        <TooltipPopup side={tooltipSide}>Toggle browser preview</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className={TOGGLE_CLASS}
              pressed={terminalOpen}
              onPressedChange={onToggleTerminal}
              aria-label="Toggle terminal drawer"
              variant="outline"
              size="xs"
              disabled={!terminalAvailable}
            >
              <TerminalSquareIcon className="size-3" />
            </Toggle>
          }
        />
        <TooltipPopup side={tooltipSide}>
          {!terminalAvailable
            ? "Terminal is unavailable until this thread has an active project."
            : terminalToggleShortcutLabel
              ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
              : "Toggle terminal drawer"}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className={TOGGLE_CLASS}
              pressed={diffOpen}
              onPressedChange={onToggleDiff}
              aria-label="Toggle diff panel"
              variant="outline"
              size="xs"
              disabled={!isGitRepo && !diffOpen}
            >
              <DiffIcon className="size-3" />
            </Toggle>
          }
        />
        <TooltipPopup side={tooltipSide}>
          {!isGitRepo && !diffOpen
            ? "Diff panel is unavailable because this project is not a git repository."
            : diffToggleShortcutLabel
              ? `Toggle diff panel (${diffToggleShortcutLabel})`
              : "Toggle diff panel"}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});
