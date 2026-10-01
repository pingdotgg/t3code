import { memo } from "react";
import {
  ActivityIcon,
  DiffIcon,
  FolderTreeIcon,
  GitPullRequestIcon,
  GlobeIcon,
  TerminalSquareIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSettings } from "~/hooks/useSettings";

export interface ChatPanelTogglesState {
  terminalAvailable: boolean;
  terminalOpen: boolean;
  filesAvailable: boolean;
  filesOpen: boolean;
  browserPreviewOpen: boolean;
  insightsOpen: boolean;
  diffOpen: boolean;
  pullRequestsAvailable: boolean;
  pullRequestsOpen: boolean;
  isGitRepo: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  onToggleTerminal: () => void;
  onToggleFiles: () => void;
  onToggleBrowserPreview: () => void;
  onToggleInsights: () => void;
  onToggleDiff: () => void;
  onTogglePullRequests: () => void;
}

interface ChatPanelTogglesProps extends ChatPanelTogglesState {
  orientation: "vertical" | "horizontal";
  className?: string;
}

const TOGGLE_CLASS = "shrink-0 border-transparent shadow-none hover:border-input hover:shadow-xs/5";

/**
 * The five panel toggles (insights, browser, files, terminal, diff).
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
  filesAvailable,
  filesOpen,
  browserPreviewOpen,
  insightsOpen,
  diffOpen,
  pullRequestsAvailable,
  pullRequestsOpen,
  isGitRepo,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  onToggleTerminal,
  onToggleFiles,
  onToggleBrowserPreview,
  onToggleInsights,
  onToggleDiff,
  onTogglePullRequests,
}: ChatPanelTogglesProps) {
  const isRail = orientation === "vertical";
  const tooltipSide = isRail ? "left" : "bottom";
  const showInsights = useSettings((s) => s.headerShowInsightsToggle);
  const showBrowser = useSettings((s) => s.headerShowBrowserToggle);
  const showFiles = useSettings((s) => s.headerShowFilesToggle);
  const showTerminal = useSettings((s) => s.headerShowTerminalToggle);
  const showDiff = useSettings((s) => s.headerShowDiffToggle);

  if (
    !showInsights &&
    !showBrowser &&
    !showFiles &&
    !showTerminal &&
    !showDiff &&
    !pullRequestsAvailable
  ) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1",
        isRail &&
          // `pe` carries the right safe-area inset: as the pane's outermost
          // column the rail has to clear a notch or rounded corner itself.
          "w-[calc(env(safe-area-inset-right)+--spacing(9))] flex-col border-s border-border py-2 ps-1.5 pe-[calc(env(safe-area-inset-right)+--spacing(1.5))] wco:pt-[calc(env(titlebar-area-height)+--spacing(2))]",
        className,
      )}
      data-chat-panel-toggles={orientation}
    >
      {showInsights ? (
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
      ) : null}
      {showBrowser ? (
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
      ) : null}
      {showFiles ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className={TOGGLE_CLASS}
                pressed={filesOpen}
                onPressedChange={onToggleFiles}
                aria-label="Toggle file browser"
                variant="outline"
                size="xs"
                disabled={!filesAvailable}
              >
                <FolderTreeIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side={tooltipSide}>
            {filesAvailable
              ? "Toggle file browser"
              : "File browser is unavailable until this thread has an active project."}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {showTerminal ? (
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
      ) : null}
      {showDiff ? (
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
      ) : null}
      {pullRequestsAvailable ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className={TOGGLE_CLASS}
                pressed={pullRequestsOpen}
                onPressedChange={onTogglePullRequests}
                aria-label="Toggle pull requests panel"
                variant="outline"
                size="xs"
              >
                <GitPullRequestIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side={tooltipSide}>Toggle pull requests panel</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
});
