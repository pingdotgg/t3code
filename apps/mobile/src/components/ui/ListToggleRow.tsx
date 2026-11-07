import { Pressable } from "react-native";

import { AppText } from "./AppText";
import { ListRowLayout, type ListRowContentProps } from "./ListRowLayout";
import { SettingResetButton } from "./SettingResetButton";
import { ThemedSwitch } from "./ThemedSwitch";

export function ListToggleRow(
  props: Omit<ListRowContentProps, "detail"> & {
    readonly value: boolean | null;
    readonly onValueChange: (value: boolean) => void;
    readonly resetVisible?: boolean;
    readonly resetDisabled?: boolean;
    readonly onReset?: () => void;
  },
) {
  const showReset = props.resetVisible === true && props.onReset !== undefined;
  // Disabled rows and clean rows hide the button: it only offers an action when dirty.
  const reset =
    showReset && props.disabled !== true && props.resetDisabled === false ? (
      <SettingResetButton label={props.label} onPress={props.onReset} />
    ) : null;
  return (
    <ListRowLayout
      icon={props.icon}
      label={props.label}
      description={props.description}
      disabled={props.disabled}
      accessory={
        props.value === null ? (
          <Pressable
            accessibilityLabel={`Set ${props.label} on for selected environments`}
            accessibilityRole="button"
            accessibilityHint={props.description}
            accessibilityState={{ disabled: Boolean(props.disabled) }}
            disabled={props.disabled}
            className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
            onPress={() => props.onValueChange(true)}
          >
            <AppText className="text-sm font-t3-medium text-foreground">Mixed · Set on</AppText>
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
      trailing={reset}
    />
  );
}
