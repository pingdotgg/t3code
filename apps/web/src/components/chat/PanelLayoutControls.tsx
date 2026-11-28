import {
  PanelBottomIcon,
  PanelRightIcon,
  SquareMenuIcon,
  Maximize2Icon,
  Minimize2Icon,
} from "lucide-react";
import { useGT } from "gt-react";
import { memo, type ReactNode, useLayoutEffect, useRef } from "react";

import { cn } from "~/lib/utils";

import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { PopoverCreateHandle, PopoverTrigger } from "../ui/popover";
import { useMobileSidebarSheetMounted } from "../ui/sidebar";
import { Toggle } from "../ui/toggle";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

/** Matches the inline-end inset of `ThreadPanelHeaderControl`. */
const THREAD_PANEL_HEADER_INSET_PX = 12;

export interface PanelLayoutControlsProps {
  showThreadPanelControl?: boolean;
  showTerminalControl?: boolean;
  showRightPanelControl?: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  threadPanelOpen: boolean;
  threadPanelPresentation: ThreadPanelPresentation;
  threadPanelPopoverHandle?: ReturnType<typeof PopoverCreateHandle>;
  threadPanelShortcutLabel: string | null;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  rightPanelUnavailableLabel?: string;
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
  threadPanelPopoverHandle,
  threadPanelShortcutLabel,
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  rightPanelUnavailableLabel,
  onToggleTerminal,
  onToggleThreadPanel,
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  const gt = useGT();
  const threadPanelToggle = (
    <Toggle
      className="relative shrink-0 [-webkit-app-region:no-drag]"
      pressed={threadPanelOpen}
      onPressedChange={threadPanelPresentation === "popover" ? undefined : onToggleThreadPanel}
      aria-label={gt("Toggle thread details panel")}
      variant="ghost"
      size="sm"
    >
      <SquareMenuIcon className="size-4" />
    </Toggle>
  );
  const threadPanelControl = (
    <SharedTooltipTrigger
      render={<span className="flex shrink-0" data-thread-panel-toggle />}
      label={
        threadPanelShortcutLabel
          ? gt("Toggle thread details ({shortcut})", { shortcut: threadPanelShortcutLabel })
          : gt("Toggle thread details")
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
      {showThreadPanelControl ? threadPanelControl : null}
      {showTerminalControl ? (
        <SharedTooltipTrigger
          render={<span className="flex shrink-0" />}
          label={
            terminalAvailable
              ? terminalShortcutLabel
                ? gt("Toggle terminal drawer ({shortcut})", { shortcut: terminalShortcutLabel })
                : gt("Toggle terminal drawer")
              : gt("Terminal drawer is unavailable")
          }
          side="bottom"
        >
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={terminalOpen}
            onPressedChange={onToggleTerminal}
            aria-label={gt("Toggle terminal drawer")}
            variant="ghost"
            size="sm"
            disabled={!terminalAvailable}
          >
            <PanelBottomIcon className="size-4" />
          </Toggle>
        </SharedTooltipTrigger>
      ) : null}
      {showRightPanelControl ? (
        <SharedTooltipTrigger
          render={<span className="flex shrink-0" />}
          label={
            rightPanelAvailable
              ? rightPanelShortcutLabel
                ? gt("Toggle right panel ({shortcut})", { shortcut: rightPanelShortcutLabel })
                : gt("Toggle right panel")
              : (rightPanelUnavailableLabel ?? gt("Right panel is unavailable"))
          }
          side="bottom"
        >
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={rightPanelOpen}
            onPressedChange={onToggleRightPanel}
            aria-label={gt("Toggle right panel")}
            data-right-panel-toggle
            variant="ghost"
            size="sm"
            disabled={!rightPanelAvailable}
          >
            <PanelRightIcon className="size-4 rtl:rotate-180" />
          </Toggle>
        </SharedTooltipTrigger>
      ) : null}
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
          {maximized ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
        </Toggle>
      }
      label={tooltipLabel}
      side="bottom"
    />
  );
});

/** The thread panel toggle while the inline panel owns the window controls. */
export function ThreadPanelHeaderControl(props: PanelLayoutControlsProps) {
  const mobileSidebarSheetMounted = useMobileSidebarSheetMounted();
  return (
    <div
      className={cn(
        "absolute top-[var(--workspace-controls-top)] end-[calc(env(safe-area-inset-right)+0.75rem)] rtl:end-[calc(env(safe-area-inset-left)+0.75rem)] z-50 flex h-[var(--workspace-topbar-height)] items-center [-webkit-app-region:no-drag]",
        mobileSidebarSheetMounted && "hidden",
      )}
      data-workspace-titlebar-controls
    >
      <PanelLayoutControls {...props} showTerminalControl={false} showRightPanelControl={false} />
    </div>
  );
}

/** The window's trailing panel controls, with the maximize toggle while the panel is open. */
export function WorkspaceTitlebarControls(props: {
  readonly showMaximizeControl: boolean;
  readonly rightPanelOpen: boolean;
  readonly animationsActive: boolean;
  readonly maximized: boolean;
  readonly onToggleMaximized: () => void;
  readonly maximizeShortcutLabel: string | null;
  readonly children: ReactNode;
}) {
  const { rightPanelOpen, maximized } = props;
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const previous = useRef({ rightPanelOpen, maximized });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the toggle's slide before the commit that swapped it in paints; the animation is cancelled on change or unmount.
  useLayoutEffect(() => {
    const { rightPanelOpen: wasOpen, maximized: wasMaximized } = previous.current;
    previous.current = { rightPanelOpen, maximized };
    if (!wasOpen || rightPanelOpen || wasMaximized) return;
    const toggle = controlsRef.current?.querySelector("[data-thread-panel-toggle]");
    const panel = toggle?.ownerDocument.querySelector("[data-preview-panel-mode='inline']");
    const timing = panel?.getAnimations()[0]?.effect?.getTiming();
    if (!toggle || !panel || !timing) return;
    // The header's toggle was just removed, so slide this one in from where it sat.
    const panelBounds = panel.getBoundingClientRect();
    const toggleBounds = toggle.getBoundingClientRect();
    const offset =
      getComputedStyle(toggle).direction === "rtl"
        ? panelBounds.right + THREAD_PANEL_HEADER_INSET_PX - toggleBounds.left
        : panelBounds.left - THREAD_PANEL_HEADER_INSET_PX - toggleBounds.right;
    const animation = toggle.animate(
      [{ transform: `translateX(${offset}px)` }, { transform: "none" }],
      { ...timing, easing: getComputedStyle(panel).transitionTimingFunction },
    );
    return () => animation.cancel();
  }, [rightPanelOpen, maximized]);

  const mobileSidebarSheetMounted = useMobileSidebarSheetMounted();
  return (
    <div
      ref={controlsRef}
      className={cn(
        "pointer-events-none fixed top-[var(--workspace-controls-top)] end-[var(--workspace-controls-right)] rtl:end-[var(--workspace-controls-left)] z-50 me-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]",
        mobileSidebarSheetMounted && "hidden",
      )}
      data-workspace-titlebar-controls
    >
      {props.showMaximizeControl ? (
        <span
          aria-hidden={!props.rightPanelOpen}
          // Fading out on close would show it beside the thread details toggle that replaces it.
          className={cn(
            "flex shrink-0",
            props.rightPanelOpen &&
              props.animationsActive &&
              "motion-safe:transition-opacity motion-safe:duration-(--panel-animation-duration) motion-safe:ease-out",
            props.rightPanelOpen
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none absolute end-full me-1 opacity-0",
          )}
          inert={!props.rightPanelOpen}
        >
          <RightPanelMaximizeControl
            maximized={props.maximized}
            onToggle={props.onToggleMaximized}
            shortcutLabel={props.maximizeShortcutLabel}
          />
        </span>
      ) : null}
      <div className="pointer-events-auto flex h-full items-center">{props.children}</div>
    </div>
  );
}
