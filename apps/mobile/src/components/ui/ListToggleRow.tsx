import { Pressable } from "react-native";

import { AppText } from "./AppText";
import { ListRowLayout, type ListRowContentProps } from "./ListRowLayout";
import { ThemedSwitch } from "./ThemedSwitch";

export function ListToggleRow(
  props: Omit<ListRowContentProps, "detail"> & {
    readonly value: boolean | null;
    readonly mixedValue?: boolean;
    readonly onValueChange: (value: boolean) => void;
  },
) {
  const mixedValue = props.mixedValue ?? true;
  const mixedLabel = mixedValue ? "on" : "off";
  return (
    <ListRowLayout
      icon={props.icon}
      label={props.label}
      description={props.description}
      disabled={props.disabled}
      accessory={
        props.value === null ? (
          <Pressable
            accessibilityLabel={`Set ${props.label} ${mixedLabel} for selected environments`}
            accessibilityRole="button"
            accessibilityHint={props.description}
            accessibilityState={{ disabled: Boolean(props.disabled) }}
            disabled={props.disabled}
            className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
            onPress={() => props.onValueChange(mixedValue)}
          >
            <AppText className="text-sm font-t3-medium text-foreground">
              Mixed · Set {mixedLabel}
            </AppText>
          </Pressable>
        ) : (
          <ThemedSwitch
            accessibilityLabel={props.label}
            accessibilityHint={props.description}
            disabled={props.disabled}
            onValueChange={props.onValueChange}
            value={props.value}
          />
        )
      }
    />
  );
}
