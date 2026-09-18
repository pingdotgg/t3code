import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

import type { HsvColor } from "../../lib/color";
import { cn } from "../../lib/utils";

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

/** Keep pointer capture and drag completion consistent across color controls. */
function useColorDrag(
  update: (event: PointerEvent<HTMLDivElement>) => void,
  onInteractionEnd?: () => void,
  focusTarget?: RefObject<HTMLElement | null>,
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
        (focusTarget?.current ?? event.currentTarget).focus({ preventScroll: true });
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
  const saturationRef = useRef<HTMLInputElement>(null);
  const { handlers, thumbTransition } = useColorDrag(
    (event) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      onChange({
        ...value,
        s: clamp((event.clientX - bounds.left) / bounds.width),
        v: 1 - clamp((event.clientY - bounds.top) / bounds.height),
      });
    },
    onInteractionEnd,
    saturationRef,
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>, axis: "s" | "v") => {
    const step = event.shiftKey ? 0.1 : 0.02;
    let nextValue: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        nextValue = clamp(value[axis] + step);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        nextValue = clamp(value[axis] - step);
        break;
      case "Home":
        nextValue = 0;
        break;
      case "End":
        nextValue = 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    onChange({ ...value, [axis]: nextValue });
  };

  return (
    <div
      aria-label={`${label} saturation and brightness`}
      role="group"
      className={cn(
        "relative cursor-crosshair touch-none overflow-hidden bg-[linear-gradient(to_top,#000,transparent),linear-gradient(to_right,#fff,transparent)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-popover",
        variant === "edge" ? "h-36 rounded-none" : "h-32 rounded-lg",
        className,
      )}
      style={{
        backgroundColor: `hsl(${value.h} 100% 50%)`,
      }}
      {...handlers}
    >
      <span id={instructionsId} className="sr-only">
        Use arrow keys to adjust the focused value. Hold Shift for larger steps. Use Home and End
        for the minimum and maximum. Press Tab to move between saturation and brightness.
      </span>
      {(
        [
          ["s", "Saturation"],
          ["v", "Brightness"],
        ] as const
      ).map(([axis, axisLabel]) => (
        <label key={axis} className="contents">
          <input
            ref={axis === "s" ? saturationRef : undefined}
            type="range"
            min={0}
            max={100}
            step="any"
            value={value[axis] * 100}
            aria-label={`${label} ${axisLabel.toLowerCase()}`}
            aria-describedby={instructionsId}
            aria-valuetext={`${Math.round(value[axis] * 100)}%`}
            className="peer sr-only"
            onKeyDown={(event) => handleKeyDown(event, axis)}
            onChange={(event) =>
              onChange({ ...value, [axis]: event.currentTarget.valueAsNumber / 100 })
            }
          />
          <span
            aria-hidden
            className="pointer-events-none invisible absolute bottom-2 left-2 z-10 rounded bg-popover px-1.5 py-0.5 text-xs text-popover-foreground peer-focus-visible:visible"
          >
            {axisLabel} {Math.round(value[axis] * 100)}%
          </span>
        </label>
      ))}
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
