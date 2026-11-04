import {
  MAX_AUTO_ARCHIVE_SETTLED_AFTER_DAYS,
  MAX_AUTO_SETTLE_FINISHED_CHILDREN_AFTER_HOURS,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { NumberField } from "../../../components/ui/NumberField";

const UNITS = {
  day: {
    min: MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
    max: MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
    noun: "day",
    label: "Days before auto-settle",
  },
  // 0 hours is the off state, owned by the switch beside this field.
  hour: {
    min: 1,
    max: MAX_AUTO_SETTLE_FINISHED_CHILDREN_AFTER_HOURS,
    noun: "hour",
    label: "Hours before a finished child chat settles",
  },
  // 0 days is the off state, owned by the switch beside this field.
  archiveDay: {
    min: 1,
    max: MAX_AUTO_ARCHIVE_SETTLED_AFTER_DAYS,
    noun: "day",
    label: "Days settled before a thread is archived",
  },
} as const;

export type AutoSettleDurationFieldProps = Pick<
  ComponentProps<typeof NumberField>,
  "value" | "onValueChange" | "disabled"
> & { readonly unit: keyof typeof UNITS };

export function AutoSettleDurationField({ unit, ...props }: AutoSettleDurationFieldProps) {
  const { min, max, noun, label } = UNITS[unit];
  return (
    <NumberField
      {...props}
      min={min}
      max={max}
      label={label}
      formatValue={(value) => `${value} ${value === 1 ? noun : `${noun}s`}`}
    />
  );
}
