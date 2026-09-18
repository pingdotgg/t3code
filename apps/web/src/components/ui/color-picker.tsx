import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import type { HsvColor } from "../../lib/color";
import { cn } from "../../lib/utils";

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

/** Keep pointer capture and drag completion consistent across color controls. */
function useColorDrag(
  update: (event: PointerEvent<HTMLDivElement>) => void,
  onInteractionEnd?: () => void,
) {
  const [isDragging, setIsDragging] = useState(false);
  const pointerId = useRef<number | null>(null);
  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = null;
    setIsDragging(false);
    onInteractionEnd?.();
  };
  return {
    // The thumb stays inside the control at its extremes, and only animates
    // keyboard adjustments, never continuous pointer movement.
    thumbTransition: isDragging
      ? undefined
      : "left 80ms linear, top 80ms linear, background-color 80ms linear",
    handlers: {
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (pointerId.current !== null || event.button !== 0) return;
        pointerId.current = event.pointerId;
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsDragging(true);
        update(event);
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        if (pointerId.current === event.pointerId) update(event);
      },
      onPointerUp: stopDragging,
      onPointerCancel: stopDragging,
      onLostPointerCapture: stopDragging,
    },
  };
}

type ColorControlProps<T> = {
  label: string;
  value: T;
  onChange: (value: T) => void;
  /** Flush pending consumer updates when pointer interaction finishes. */
  onInteractionEnd?: () => void;
  className?: string;
};

export function ColorSaturationValuePlane({
  label,
  value,
  onChange,
  onInteractionEnd,
  className,
  variant = "inset",
}: ColorControlProps<HsvColor> & { variant?: "inset" | "edge" }) {
  const instructionsId = useId();
  const { handlers, thumbTransition } = useColorDrag((event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    onChange({
      ...value,
      s: clamp((event.clientX - bounds.left) / bounds.width),
      v: 1 - clamp((event.clientY - bounds.top) / bounds.height),
    });
  }, onInteractionEnd);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.1 : 0.02;
    const nextValue = { ...value };
    if (event.key === "ArrowLeft") nextValue.s = clamp(value.s - step);
    if (event.key === "ArrowRight") nextValue.s = clamp(value.s + step);
    if (event.key === "ArrowUp") nextValue.v = clamp(value.v + step);
    if (event.key === "ArrowDown") nextValue.v = clamp(value.v - step);
    onChange(nextValue);
  };

  return (
    <div
      aria-label={label}
      aria-describedby={instructionsId}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value.s * 100)}
      aria-valuetext={`saturation ${Math.round(value.s * 100)}%, brightness ${Math.round(value.v * 100)}%`}
      className={cn(
        "relative cursor-crosshair touch-none overflow-hidden bg-[linear-gradient(to_top,#000,transparent),linear-gradient(to_right,#fff,transparent)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
        variant === "edge" ? "h-36 rounded-none" : "h-32 rounded-lg",
        className,
      )}
      role="slider"
      style={{
        backgroundColor: `hsl(${value.h} 100% 50%)`,
      }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      {...handlers}
    >
      <span id={instructionsId} className="sr-only">
        Use Left and Right arrows to adjust saturation, and Up and Down arrows to adjust brightness.
        Hold Shift for larger steps.
      </span>
      <span
        className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.4)]"
        style={{
          left: `calc(${value.s} * (100% - 0.75rem) + 0.375rem)`,
          top: `calc(${1 - value.v} * (100% - 0.75rem) + 0.375rem)`,
          transition: thumbTransition,
        }}
      />
    </div>
  );
}

export function ColorHueSlider({
  label,
  value,
  onChange,
  onInteractionEnd,
  className,
}: ColorControlProps<number>) {
  const { handlers, thumbTransition } = useColorDrag((event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    onChange(clamp((event.clientX - bounds.left) / bounds.width) * 360);
  }, onInteractionEnd);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
    onChange((value + direction * step + 360) % 360);
  };

  return (
    <div
      aria-label={label}
      aria-valuemax={360}
      aria-valuemin={0}
      aria-valuenow={Math.round(value)}
      className={cn(
        "relative flex h-6 cursor-pointer touch-none items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
        className,
      )}
      role="slider"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      {...handlers}
    >
      <span
        aria-hidden
        className="h-2.5 w-full rounded-full bg-[linear-gradient(to_right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)] shadow-[inset_0_0_0_1px_rgb(0_0_0_/_12%)]"
      />
      <span
        className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.4)]"
        style={{
          left: `calc(${value / 360} * (100% - 1rem) + 0.5rem)`,
          backgroundColor: `hsl(${value} 100% 50%)`,
          transition: thumbTransition,
        }}
      />
    </div>
  );
}
