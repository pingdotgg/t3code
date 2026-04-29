"use client";

import { type CSSProperties, useId, useState } from "react";

import { cn } from "~/lib/utils";

type SliderProps = {
  "aria-label"?: string;
  className?: string;
  fill?: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step?: number;
  value: number;
  valueLabel?: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function Slider({
  className,
  fill,
  max,
  min,
  onChange,
  step = 1,
  value,
  valueLabel,
  ...props
}: SliderProps) {
  const inputId = useId();
  const [focused, setFocused] = useState(false);
  const clampedValue = clamp(value, min, max);
  const normalizedProgress = max === min ? 0 : (clampedValue - min) / (max - min);
  const progressInsetPercent = 2;
  const progress = progressInsetPercent + normalizedProgress * (99 - progressInsetPercent * 2);
  const thumbWidthPx = 4;
  const thumbOffsetPx = thumbWidthPx / 2;

  return (
    <div className={cn("relative h-12 w-full", className)}>
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-8 overflow-hidden rounded-lg border border-border/70 bg-card text-card-foreground shadow-sm/4 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:shadow-[inset_0_1px_--theme(--color-black/4%)] transition-[border-color,box-shadow] dark:bg-input/56 dark:shadow-none dark:before:shadow-[inset_0_-1px_--theme(--color-white/6%)]",
        )}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-lg"
          style={
            {
              width: `${progress}%`,
              background: fill ?? "var(--primary)",
              opacity: 0,
            } satisfies CSSProperties
          }
        />
        {valueLabel ? (
          <div className="absolute inset-y-0 right-0 flex items-center p-2.5 text-ui-xs font-medium text-muted-foreground">
            {valueLabel}
          </div>
        ) : null}
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/2 w-2 h-4.5 -translate-y-1/2 rounded-full border border-border transition-[left,transform,border-color] bg-primary"
        style={{
          left: `clamp(0px, calc(${progress}% - ${thumbOffsetPx}px), calc(100% - ${thumbWidthPx}px))`,
          transform: `translateY(-50%) scale(${focused ? 1.03 : 1})`,
        }}
      />
      <input
        {...props}
        id={inputId}
        className="absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none opacity-0"
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
