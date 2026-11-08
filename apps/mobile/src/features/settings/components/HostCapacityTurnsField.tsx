import { MAX_MAX_RUNNING_TURNS, MIN_MAX_RUNNING_TURNS } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { NumberField } from "../../../components/ui/NumberField";

export type HostCapacityTurnsFieldProps = Pick<
  ComponentProps<typeof NumberField>,
  "value" | "onValueChange" | "disabled"
>;

export function HostCapacityTurnsField(props: HostCapacityTurnsFieldProps) {
  return (
    <NumberField
      {...props}
      min={MIN_MAX_RUNNING_TURNS}
      max={MAX_MAX_RUNNING_TURNS}
      label="Maximum running turns"
      formatValue={(value) => `${value} ${value === 1 ? "turn" : "turns"}`}
    />
  );
}
