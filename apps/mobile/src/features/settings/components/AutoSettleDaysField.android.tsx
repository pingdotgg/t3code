import {
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts";
import { View } from "react-native";

import { AppText } from "../../../components/AppText";
import { MaterialIconButton } from "../../../components/MaterialIconButton";
import type { AutoSettleDaysFieldProps } from "./AutoSettleDaysField";

export function AutoSettleDaysField(props: AutoSettleDaysFieldProps) {
  const adjust = (amount: number) => {
    if (props.disabled) return;
    const next = Math.max(
      MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
      Math.min(MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS, props.value + amount),
    );
    if (next !== props.value) props.onValueChange(next);
  };

  return (
    <View className="shrink-0 flex-row items-center">
      {/* Match the 32dp switch track while retaining 48dp button touch targets. */}
      <View
        pointerEvents="none"
        className="absolute inset-x-0 rounded-full bg-subtle"
        style={{ height: 32 }}
      />
      <MaterialIconButton
        icon="minus"
        accessibilityLabel="Decrease days before auto-settle"
        disabled={props.disabled || props.value <= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
        onPress={() => adjust(-1)}
      />
      <AppText
        className="min-w-8 text-center text-base"
        style={{ fontVariant: ["tabular-nums"] }}
        accessibilityLabel={`${props.value} ${props.value === 1 ? "day" : "days"} before auto-settle`}
        accessibilityLiveRegion="polite"
      >
        {props.value}
      </AppText>
      <MaterialIconButton
        icon="plus"
        accessibilityLabel="Increase days before auto-settle"
        disabled={props.disabled || props.value >= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
        onPress={() => adjust(1)}
      />
    </View>
  );
}
