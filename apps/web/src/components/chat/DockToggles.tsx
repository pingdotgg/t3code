import { memo } from "react";
import { PanelBottomIcon, PanelRightIcon } from "lucide-react";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface DockTogglesProps {
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  isGitRepo: boolean;
  diffOpen: boolean;
  diffToggleShortcutLabel: string | null;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
}

const toggleClassName =
  "size-7 shrink-0 border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground data-pressed:border-border/80 data-pressed:bg-foreground/10 data-pressed:text-foreground dark:data-pressed:bg-foreground/10";

/**
 * The dock controls cluster: the bottom + right panel toggles. Rendered in the
 * chat header when the right dock is closed, and in the right dock's tab bar
 * (as trailing controls) when it is open — so the toggles read as belonging to
 * whichever surface is currently active.
 */
export const DockToggles = memo(function DockToggles({
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  isGitRepo,
  diffOpen,
  diffToggleShortcutLabel,
  onToggleTerminal,
  onToggleDiff,
}: DockTogglesProps) {
  return (
    <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className={toggleClassName}
              pressed={terminalOpen}
              onPressedChange={onToggleTerminal}
              aria-label="Toggle bottom panel"
              variant="default"
              size="xs"
              disabled={!terminalAvailable}
            >
              <PanelBottomIcon className="size-3" />
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
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
              className={toggleClassName}
              pressed={diffOpen}
              onPressedChange={onToggleDiff}
              aria-label="Toggle right panel"
              variant="default"
              size="xs"
              disabled={!isGitRepo && !diffOpen}
            >
              <PanelRightIcon className="size-3" />
            </Toggle>
          }
        />
        <TooltipPopup side="bottom" align="end">
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
