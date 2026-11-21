import { useGT } from "gt-react-native";
import { defineNativePluginFeature } from "../../../plugins/features";
import {
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { NumberField } from "../../../components/ui/NumberField";

export type AutoSettleDaysFieldProps = Pick<
  ComponentProps<typeof NumberField>,
  "value" | "onValueChange" | "disabled"
>;

function BuiltinAutoSettleDaysField(props: AutoSettleDaysFieldProps) {
  const gt = useGT();
  return (
    <NumberField
      {...props}
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      label={gt("Days before auto-settle")}
      formatValue={(value) =>
        gt("{count, plural, one {{count} day} other {{count} days}}", { count: value })
      }
    />
  );
}

export const AutoSettleDaysField = defineNativePluginFeature(
  "native.features.settings.components.auto-settle-days-field",
  BuiltinAutoSettleDaysField,
);
