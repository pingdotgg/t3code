import { ListFilterIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useGT } from "gt-react";

import { memo } from "react";

import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { Button } from "../ui/button";
import { PopoverCreateHandle, PopoverTrigger } from "../ui/popover";
import { useMobileSidebarSheetMounted } from "../ui/sidebar";
import { Toggle } from "../ui/toggle";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

export interface PanelLayoutControlsProps {
  showThreadPanelControl?: boolean;
  threadPanelOpen: boolean;
  threadPanelPresentation: ThreadPanelPresentation;
  threadPanelPopoverHandle?: ReturnType<typeof PopoverCreateHandle>;
  threadPanelShortcutLabel: string | null;
  onToggleThreadPanel: () => void;
  /** Shown instead of the toggle's label when there is no thread to detail. */
  disabledReason?: string | null;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  showThreadPanelControl = true,
  threadPanelOpen,
  threadPanelPresentation,
  threadPanelPopoverHandle,
  threadPanelShortcutLabel,
  onToggleThreadPanel,
  disabledReason = null,
}: PanelLayoutControlsProps) {
  const gt = useGT();
  const mobileSidebarSheetMounted = useMobileSidebarSheetMounted();
  if (mobileSidebarSheetMounted) return null;
  const threadPanelToggle = (
    <Button
      className="relative shrink-0 [-webkit-app-region:no-drag]"
      aria-expanded={threadPanelOpen}
      onClick={threadPanelPresentation === "popover" ? undefined : onToggleThreadPanel}
      disabled={disabledReason !== null}
      aria-label={gt("Toggle thread details panel")}
      variant="ghost"
      size="icon-sm"
    >
      <ListFilterIcon className="size-3.5" />
    </Button>
  );
  const threadPanelControl = (
    <SharedTooltipTrigger
      render={<span className="flex shrink-0" data-thread-panel-toggle />}
      label={
        disabledReason ??
        (threadPanelShortcutLabel
          ? gt("Toggle thread details ({shortcut})", { shortcut: threadPanelShortcutLabel })
          : gt("Toggle thread details"))
      }
      side="bottom"
    >
      {threadPanelPresentation === "popover" ? (
        <PopoverTrigger handle={threadPanelPopoverHandle} render={threadPanelToggle} />
      ) : (
        threadPanelToggle
      )}
    </SharedTooltipTrigger>
  );

  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      {/* The workspace menu (pen ZVAPz) is the pane's only top-right control. */}
      {showThreadPanelControl ? threadPanelControl : null}
    </div>
  );
});

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  maximized,
  onToggle,
  shortcutLabel,
}: {
  maximized: boolean;
  onToggle: () => void;
  shortcutLabel: string | null;
}) {
  const gt = useGT();
  const mobileSidebarSheetMounted = useMobileSidebarSheetMounted();
  if (mobileSidebarSheetMounted) return null;
  const label = maximized ? gt("Restore panel size") : gt("Maximize panel");
  const tooltipLabel = shortcutLabel
    ? maximized
      ? gt("Restore panel size ({shortcut})", { shortcut: shortcutLabel })
      : gt("Maximize panel ({shortcut})", { shortcut: shortcutLabel })
    : label;
  return (
    <SharedTooltipTrigger
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
      label={tooltipLabel}
      side="bottom"
    />
  );
});
