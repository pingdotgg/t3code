import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { type KeyboardEvent, type PointerEvent, useContext, useRef } from "react";

import { PANEL_MIN_WIDTH, panelAtom, setPanelWidth } from "./panel";
import { pausePage } from "./pageBounds";

const KEY_STEP_PX = 24;
/** What the window keeps beside the panel: the sidebar and a canvas that still pans. */
const RESERVED_PX = 240 + 200;

const maxWidth = () => Math.max(PANEL_MIN_WIDTH, window.innerWidth - RESERVED_PX);
const clampWidth = (width: number) =>
  Math.min(maxWidth(), Math.max(PANEL_MIN_WIDTH, Math.round(width)));

/** The panel's left edge, which drags or takes the arrow keys to set the panel's width. */
export function ResizeHandle() {
  const registry = useContext(RegistryContext);
  const width = useAtomValue(panelAtom).width;
  const dragging = useRef(false);
  const end = () => {
    dragging.current = false;
    pausePage(false);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === "ArrowLeft" ? KEY_STEP_PX : event.key === "ArrowRight" ? -KEY_STEP_PX : 0;
    if (delta === 0) return;
    event.preventDefault();
    setPanelWidth(registry, clampWidth(width + delta));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuenow={width}
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={maxWidth()}
      tabIndex={0}
      data-testid="browser-resize"
      onKeyDown={key}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
        pausePage(true);
      }}
      onPointerMove={(event) => {
        if (dragging.current)
          setPanelWidth(registry, clampWidth(window.innerWidth - event.clientX));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-focus/40 focus-visible:bg-focus/60"
    />
  );
}
