import { GripVertical } from "lucide-react";
import { useRef } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { Button } from "../ui/button";
import { useQuietThreadShell } from "../../state/entities";
import type { ThreadRouteTarget } from "../../threadRoutes";

export function SplitChatDragHandle({
  target,
  onMove,
  onDrop,
  onEnd,
  onMoveByKeyboard,
}: {
  readonly target: ThreadRouteTarget;
  readonly onMove: (point: { x: number; y: number }, title: string) => void;
  readonly onDrop: (point: { x: number; y: number }) => void;
  readonly onEnd: () => void;
  readonly onMoveByKeyboard: (direction: number) => void;
}) {
  const thread = useQuietThreadShell(target.kind === "server" ? target.threadRef : null);
  const title = thread?.title || "New thread";
  const cleanupRef = useRef<(() => void) | null>(null);
  const move = useStableCallback(onMove);
  const drop = useStableCallback(onDrop);
  const end = useStableCallback(onEnd);
  const handleRef = useStableCallback((node: HTMLButtonElement | null) => {
    if (node) return () => cleanupRef.current?.();
  });

  return (
    <Button
      ref={handleRef}
      variant="ghost"
      size="icon-xs"
      aria-label="Drag chat to rearrange"
      title="Drag chat to rearrange. Use the arrow keys to move it."
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        onMoveByKeyboard(event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || cleanupRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        const origin = { x: event.clientX, y: event.clientY };
        const pointerId = event.pointerId;
        const handle = event.currentTarget;
        let point = origin;
        let started = false;
        let frame: number | null = null;
        handle.setPointerCapture(pointerId);
        const flush = () => {
          frame = null;
          move(point, title);
        };
        const cleanup = () => {
          cleanupRef.current = null;
          if (frame !== null) cancelAnimationFrame(frame);
          window.removeEventListener("pointermove", pointerMove);
          window.removeEventListener("pointerup", pointerUp);
          window.removeEventListener("pointercancel", cancel);
          window.removeEventListener("blur", cancel);
          window.removeEventListener("keydown", keyDown, true);
          handle.removeEventListener("lostpointercapture", cancel);
          if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
          document.body.style.removeProperty("cursor");
          document.body.style.removeProperty("user-select");
          end();
        };
        const pointerMove = (next: PointerEvent) => {
          if (next.pointerId !== pointerId) return;
          point = { x: next.clientX, y: next.clientY };
          if (!started && Math.hypot(point.x - origin.x, point.y - origin.y) < 6) return;
          started = true;
          document.body.style.cursor = "grabbing";
          document.body.style.userSelect = "none";
          if (frame === null) frame = requestAnimationFrame(flush);
        };
        const pointerUp = (next: PointerEvent) => {
          if (next.pointerId !== pointerId) return;
          try {
            if (started) drop({ x: next.clientX, y: next.clientY });
          } catch (error) {
            cleanup();
            throw error;
          }
          cleanup();
        };
        const cancel = () => cleanup();
        const keyDown = (next: KeyboardEvent) => {
          if (next.key !== "Escape") return;
          next.preventDefault();
          next.stopPropagation();
          cleanup();
        };
        cleanupRef.current = cleanup;
        window.addEventListener("pointermove", pointerMove);
        window.addEventListener("pointerup", pointerUp);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("blur", cancel);
        window.addEventListener("keydown", keyDown, true);
        handle.addEventListener("lostpointercapture", cancel);
      }}
    >
      <GripVertical />
    </Button>
  );
}
