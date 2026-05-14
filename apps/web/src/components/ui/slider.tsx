"use client";

import { type CSSProperties, useId, useState } from "react";

import { cn } from "~/lib/utils";

type SliderProps = {
  "aria-label"?: string;
  className?: string;
  fill?: string;
  label?: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step?: number;
  thumb?: string;
  value: number;
  valueLabel?: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function Slider({
  className,
  fill,
  label,
  max,
  min,
  onChange,
  step = 1,
  thumb,
  value,
  valueLabel,
  ...props
}: SliderProps) {
  const inputId = useId();
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const clampedValue = clamp(value, min, max);
  const normalizedProgress = max === min ? 0 : (clampedValue - min) / (max - min);
  const progress = normalizedProgress * 100;
  const thumbWidthPx = 3;
  const thumbOffsetPx = thumbWidthPx / 2;
  const tickCount = 11;
  const activeTickIndex = Math.floor(normalizedProgress * (tickCount - 1));

  return (
    <div
      className={cn(
        "relative flex h-[38px] w-full touch-none items-center overflow-hidden rounded-[14px] border px-3 transition-[background,border-color,box-shadow]",
        hovered ? "border-ring/55 bg-foreground/[0.055]" : "border-border/70 bg-foreground/[0.035]",
        focused ? "ring-2 ring-ring/20" : null,
        className,
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={
        {
          boxShadow: "0 1px 2px #00000040, inset 0 1px #ffffff09, inset 0 0 #00000029",
        } satisfies CSSProperties
      }
    >
      <div
        className="pointer-events-none absolute inset-y-0 left-0 rounded-lg transition-colors"
        style={
          {
            width: `${progress}%`,
            background:
              fill ??
              (hovered
                ? "color-mix(in srgb, var(--primary) 14%, transparent)"
                : "color-mix(in srgb, var(--foreground) 7%, transparent)"),
          } satisfies CSSProperties
        }
      />

      {label ? (
        <span className="text-ui-xs relative z-10 min-w-16 flex-1 select-none truncate pr-3 font-bold text-foreground/80">
          {label}
        </span>
      ) : (
        <span className="relative z-10 flex-1" aria-hidden />
      )}

      <span
        className={cn(
          "pointer-events-none absolute top-1/2 grid -translate-y-1/2 grid-cols-11 items-center opacity-45 transition-opacity",
          label ? "left-[78px] right-14" : "left-3 right-14",
          hovered ? "opacity-65" : null,
        )}
        aria-hidden="true"
      >
        {Array.from({ length: tickCount }, (_, index) => (
          <span
            key={index}
            className={cn(
              "mx-auto h-0.5 w-0.5 rounded-full transition-colors",
              index <= activeTickIndex
                ? hovered
                  ? "bg-primary/85"
                  : "bg-foreground/60"
                : "bg-foreground/25",
            )}
          />
        ))}
      </span>

      {valueLabel ? (
        <span className="text-ui-xs relative z-10 block min-w-11 select-none pl-3 text-right font-bold text-foreground/55">
          {valueLabel}
        </span>
      ) : null}

      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute z-10 w-[3px] rounded-full bg-primary shadow-[0_1px_1px_#0006] transition-[left,opacity,top,bottom,width,transform]",
          hovered ? "top-[7px] bottom-[7px] opacity-100" : "top-[11px] bottom-[11px] opacity-85",
        )}
        style={{
          background: thumb ?? "var(--primary)",
          left: `clamp(0px, calc(${progress}% - ${thumbOffsetPx}px), calc(100% - ${thumbWidthPx}px))`,
          transform: `scaleX(${hovered ? 1.25 : 1})`,
        }}
      />
      <input
        {...props}
        aria-valuetext={valueLabel}
        id={inputId}
        className="absolute inset-0 z-20 m-0 h-full w-full cursor-pointer appearance-none opacity-0"
        max={max}
        min={min}
        onBlur={() => setFocused(false)}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        onFocus={() => setFocused(true)}
        step={step}
        type="range"
        value={clampedValue}
      />
    </div>
  );
}

export { Slider, type SliderProps };
