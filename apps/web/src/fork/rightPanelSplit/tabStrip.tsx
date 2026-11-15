import {
  PointerSensor,
  type PointerSensorOptions,
  TouchSensor,
  type TouchSensorOptions,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { ContextMenuItem } from "@t3tools/contracts";
import {
  type ComponentProps,
  createContext,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  useContext,
  useRef,
} from "react";

import type { PreviewPanelShell } from "~/components/preview/PreviewPanelShell";
import { workspaceAreaProps } from "~/lib/workspaceFocus";
import type { RightPanelSurface } from "~/rightPanelStore";

import type { PaneSide, SplitMenuAction } from "./splitLayout.logic";

/** Split entries for a tab's context menu. */
export interface RightPanelTabMenu {
  readonly items: (surface: RightPanelSurface) => ContextMenuItem<SplitMenuAction>[];
  readonly select: (action: SplitMenuAction, surface: RightPanelSurface) => void;
}

export interface TabDragData {
  readonly kind: "tab";
  readonly title: string;
  readonly pane: PaneSide | null;
}

/**
 * What a `RightPanelTabs` inside ChatView's split view knows about its pane. Absent on the Pull
 * requests page. Inside it, one drag context spans every strip, so a tab can leave its strip.
 */
export interface RightPanelPane {
  /** Null for the only pane. */
  readonly side: PaneSide | null;
  readonly focused: boolean;
  readonly tabMenu: RightPanelTabMenu;
  /** Runs before a press activates its tab, so a drop can give the pane back what it showed. */
  readonly notePress: (surfaceId: string) => void;
}

export const RightPanelPaneContext = createContext<RightPanelPane | null>(null);

export function useRightPanelPane(): RightPanelPane | null {
  return useContext(RightPanelPaneContext);
}

export function useTabDragData(title: string): TabDragData {
  return { kind: "tab", title, pane: useRightPanelPane()?.side ?? null };
}

/** Close, mute and the rename input: a press on them neither activates nor drags. */
function isTabControl(target: EventTarget | null, tab: EventTarget | null): boolean {
  if (!(target instanceof Element) || !(tab instanceof Element)) return false;
  const control = target.closest("button:not([data-tab-title]), input");
  return control !== null && control !== tab && tab.contains(control);
}

/**
 * Activation for a whole tab. A primary mouse or pen press activates at once, before any drag
 * threshold can swallow it, and keeps focus where activation put it (a terminal). Touch and
 * keyboard activate on click; the click that ends a press activation does nothing.
 */
export function useTabPress(
  surface: RightPanelSurface,
  onActivate: (surface: RightPanelSurface) => void,
) {
  const pane = useRightPanelPane();
  const pressActivated = useRef(false);
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      pressActivated.current = false;
      if (event.button !== 0 || (event.pointerType !== "mouse" && event.pointerType !== "pen")) {
        return;
      }
      if (isTabControl(event.target, event.currentTarget)) return;
      pressActivated.current = true;
      pane?.notePress(surface.id);
      onActivate(surface);
    },
    onMouseDown: (event: ReactMouseEvent<HTMLElement>) => {
      // An open rename input still ends on a press elsewhere on its tab.
      if (event.currentTarget.querySelector("input")) return;
      if (event.button === 0 && !isTabControl(event.target, event.currentTarget)) {
        event.preventDefault();
      }
    },
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (isTabControl(event.target, event.currentTarget)) return;
      const endsPress = pressActivated.current && event.detail !== 0;
      pressActivated.current = false;
      if (!endsPress) onActivate(surface);
    },
  };
}

class TabPointerSensor extends PointerSensor {
  static override activators = [
    {
      eventName: "onPointerDown" as const,
      handler: (event: ReactPointerEvent, { onActivation }: PointerSensorOptions) => {
        const { nativeEvent } = event;
        if (!nativeEvent.isPrimary || nativeEvent.button !== 0) return false;
        if (nativeEvent.pointerType === "touch") return false;
        if (isTabControl(event.target, event.currentTarget)) return false;
        onActivation?.({ event: nativeEvent });
        return true;
      },
    },
  ];
}

class TabTouchSensor extends TouchSensor {
  static override activators = [
    {
      eventName: "onTouchStart" as const,
      handler: (event: ReactTouchEvent, { onActivation }: TouchSensorOptions) => {
        if (event.nativeEvent.touches.length > 1) return false;
        if (isTabControl(event.target, event.currentTarget)) return false;
        onActivation?.({ event: event.nativeEvent });
        return true;
      },
    },
  ];
}

/** A touch drag needs a hold, so a swipe scrolls the strip and a tap activates. */
export function useTabDragSensors() {
  return useSensors(
    useSensor(TabPointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TabTouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
}

const PANE_LABELS: Record<PaneSide, string> = { left: "Left pane", right: "Right pane" };

/**
 * What a split view's `RightPanelTabs` renders instead of its own `PreviewPanelShell`; the split
 * view owns the one shell. Only the focused pane is a workspace area, so programmatic focus never
 * lands in the other one.
 */
export function SplitPaneFrame(props: ComponentProps<typeof PreviewPanelShell>) {
  const pane = useRightPanelPane();
  const label = pane?.side ? PANE_LABELS[pane.side] : (props.workspaceLabel ?? "Workspace panel");
  const area =
    props.workspaceArea && pane?.focused !== false
      ? {
          ...workspaceAreaProps("panel", 4, label),
          "data-workspace-focus-key": props.workspaceFocusKey,
        }
      : { role: "region", "aria-label": label };
  return (
    <div
      {...area}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      onMouseDown={props.onMouseDown}
      onMouseUp={props.onMouseUp}
    >
      {props.children}
    </div>
  );
}
