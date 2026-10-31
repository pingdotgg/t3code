import { ListFilterIcon } from "lucide-react";
import { Maximize2, Minimize2 } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { memo, type ReactNode, type Ref } from "react";
import { cn } from "~/lib/utils";
import { useLayoutPane } from "../../layout/layoutPaneContext";

import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { PopoverCreateHandle, PopoverTrigger } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
  const threadPanelToggle = (
    <Toggle
      className="relative shrink-0 [-webkit-app-region:no-drag]"
      pressed={threadPanelOpen}
      onPressedChange={threadPanelPresentation === "popover" ? undefined : onToggleThreadPanel}
      disabled={disabledReason !== null}
      aria-label="Toggle thread details panel"
      variant="ghost"
      size="sm"
    >
      <ListFilterIcon className="size-3.5" />
    </Toggle>
  );
  const threadPanelControl = (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        {threadPanelPresentation === "popover" ? (
          <PopoverTrigger handle={threadPanelPopoverHandle} render={threadPanelToggle} />
        ) : (
          threadPanelToggle
        )}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {disabledReason ?? (
          <>
            Toggle thread details
            {threadPanelShortcutLabel ? ` (${threadPanelShortcutLabel})` : ""}
          </>
        )}
      </TooltipPopup>
    </Tooltip>
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
            <MorphIcon className="size-3.5" icon={maximized ? Minimize2 : Maximize2} />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});

/** The thread panel toggle on a header whose right side the inline right panel covers. */
export function ThreadPanelHeaderControl(props: PanelLayoutControlsProps) {
  return (
    <div
      className="absolute top-[var(--workspace-pane-local-controls-top)] right-[calc(env(safe-area-inset-right)+0.75rem)] z-50 flex h-[var(--workspace-topbar-height)] items-center [-webkit-app-region:no-drag] md:right-[calc(env(safe-area-inset-right)+0.5rem)]"
      data-workspace-titlebar-controls
    >
      <PanelLayoutControls {...props} />
    </div>
  );
}

/** The pane's top-right panel controls. */
export function WorkspaceTitlebarControls({
  children,
  ref,
}: {
  readonly children: ReactNode;
  readonly ref?: Ref<HTMLDivElement> | undefined;
}) {
  const layoutPane = useLayoutPane();
  return (
    <div
      ref={ref}
      className={cn(
        "pointer-events-none z-50 flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]",
        // Several panes each carry their own cluster at their own top-right.
        layoutPane.split
          ? "absolute top-[var(--workspace-pane-local-controls-top)] right-[var(--workspace-pane-local-controls-right)]"
          : "fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] mr-px",
      )}
      data-workspace-titlebar-controls
    >
      <div className="pointer-events-auto flex h-full items-center gap-1.5">{children}</div>
    </div>
  );
}
