import { GripVerticalIcon, XIcon } from "lucide-react";
import { useRef } from "react";

import { usePaneLayoutStore } from "../../paneLayoutStore";
import { Button } from "../ui/button";

const PANE_SELECTOR = "[data-pane-index]";

function paneIndexAt(x: number, y: number): number | null {
  const pane = document.elementFromPoint(x, y)?.closest<HTMLElement>(PANE_SELECTOR);
  return pane ? Number(pane.dataset.paneIndex) : null;
}

function paneAt(index: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-pane-index="${index}"]`);
}

/**
 * Grip and close button in the pane's own header, revealed while the pane is hovered or focused.
 * Dragging the grip over another pane and releasing swaps the two conversations. The highlight is
 * set on the DOM directly, so a drag never re-renders the chats.
 */
export function PaneHeaderControls({ index, onClose }: { index: number; onClose: () => void }) {
  const drag = useRef<{ over: number | null; cursor: string } | null>(null);

  const setOver = (state: { over: number | null }, next: number | null) => {
    if (state.over === next) return;
    if (state.over !== null) paneAt(state.over)?.removeAttribute("data-pane-drop-target");
    if (next !== null) paneAt(next)?.setAttribute("data-pane-drop-target", "");
    state.over = next;
  };
  const finish = (swap: boolean) => {
    const state = drag.current;
    drag.current = null;
    if (!state) return;
    document.body.style.cursor = state.cursor;
    paneAt(index)?.removeAttribute("data-pane-dragging");
    const target = state.over;
    setOver(state, null);
    if (swap && target !== null) usePaneLayoutStore.getState().swapPanes(index, target);
  };

  return (
    <div className="ml-1 flex shrink-0 items-center opacity-0 transition-opacity group-focus-within/pane:opacity-100 group-hover/pane:opacity-100">
      <Button
        aria-label="Drag to move pane"
        className="cursor-grab touch-none active:cursor-grabbing"
        size="icon-xs"
        variant="ghost-muted"
        onLostPointerCapture={() => finish(false)}
        onPointerCancel={() => finish(false)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { over: null, cursor: document.body.style.cursor };
          document.body.style.cursor = "grabbing";
          paneAt(index)?.setAttribute("data-pane-dragging", "");
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          if (!state) return;
          const over = paneIndexAt(event.clientX, event.clientY);
          setOver(state, over === index ? null : over);
        }}
        onPointerUp={() => finish(true)}
      >
        <GripVerticalIcon />
      </Button>
      <Button aria-label="Close pane" size="icon-xs" variant="ghost-muted" onClick={onClose}>
        <XIcon />
      </Button>
    </div>
  );
}
