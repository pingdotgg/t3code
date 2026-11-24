import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

const meterVariants = cva(
  "block w-full min-w-0 overflow-hidden rounded-full forced-colors:border",
  {
    defaultVariants: {
      size: "xs",
      tone: "neutral",
    },
    variants: {
      size: {
        xs: "h-1",
        sm: "h-1.5",
      },
      tone: {
        neutral: "surface-badge",
        warning: "bg-warning-tint",
        destructive: "bg-error-tint",
        success: "bg-success-tint",
      },
    },
  },
);

const meterFillVariants = cva(
  "block h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none forced-colors:bg-[Highlight]",
  {
    defaultVariants: {
      tone: "neutral",
    },
    variants: {
      tone: {
        neutral: "bg-primary",
        warning: "bg-warning",
        destructive: "bg-destructive",
        success: "bg-success",
      },
    },
  },
);

type MeterAccessibleName =
  | {
      "aria-label": string;
      "aria-labelledby"?: string;
      "aria-hidden"?: false | undefined;
    }
  | {
      "aria-labelledby": string;
      "aria-label"?: string;
      "aria-hidden"?: false | undefined;
    }
  | {
      "aria-hidden": true | "true";
      "aria-label"?: undefined;
      "aria-labelledby"?: undefined;
    };

type MeterProps = Omit<
  React.ComponentProps<"span">,
  "aria-hidden" | "aria-label" | "aria-labelledby" | "children" | "role"
> &
  VariantProps<typeof meterVariants> &
  MeterAccessibleName & {
    value: number;
    min?: number;
    max?: number;
    role?: "meter" | "progressbar";
  };

/**
 * Horizontal fill meter or progress bar. Renders inline spans so it can sit
 * inside cards, notices, and interactive controls without invalid HTML, and
 * stays static while idle.
 */
function Meter({
  value,
  min = 0,
  max = 100,
  tone = "neutral",
  size = "xs",
  role = "meter",
  className,
  ...props
}: MeterProps) {
  const span = max - min;
  const clamped = Math.max(min, Math.min(max, value));
  const percent = span > 0 ? ((clamped - min) / span) * 100 : 0;
  const hidden = props["aria-hidden"] === true || props["aria-hidden"] === "true";

  return (
    <span
      data-slot="meter"
      data-tone={tone}
      role={hidden ? undefined : role}
      aria-valuemin={hidden ? undefined : min}
      aria-valuemax={hidden ? undefined : max}
      aria-valuenow={hidden ? undefined : clamped}
      className={cn(meterVariants({ size, tone }), className)}
      {...props}
    >
      <span
        data-slot="meter-fill"
        className={meterFillVariants({ tone })}
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}

export { Meter, type MeterProps };
