import { Platform, Pressable, Switch, View, type SwitchProps } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { SymbolView } from "./AppSymbol";

export function ThemedSwitch(props: SwitchProps) {
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  if (materialYouStyleLayoutActive) {
    return (
      <Pressable
        accessibilityHint={props.accessibilityHint}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="switch"
        accessibilityState={{ checked: Boolean(props.value), disabled: props.disabled }}
        disabled={props.disabled}
        hitSlop={8}
        onPress={() => props.onValueChange?.(!props.value)}
        style={props.style}
        testID={props.testID}
        className={props.disabled ? "opacity-40" : "active:opacity-70"}
      >
        <View
          className={
            props.value
              ? "h-8 w-[52px] items-end justify-center rounded-full border-2 border-switch-active-track bg-switch-active-track px-0.5"
              : "h-8 w-[52px] items-start justify-center rounded-full border-2 border-switch-inactive-thumb bg-switch-inactive-track px-0.5"
          }
        >
          <View
            className={
              props.value
                ? "size-6 items-center justify-center rounded-full bg-switch-active-thumb"
                : "size-6 items-center justify-center rounded-full bg-switch-inactive-thumb"
            }
          >
            <SymbolView
              name={props.value ? "checkmark" : "xmark"}
              size={13}
              tintColorClassName={
                props.value ? "accent-switch-active-track" : "accent-switch-inactive-track"
              }
              type="monochrome"
            />
          </View>
        </View>
      </Pressable>
    );
  }

  return (
    <Switch
      {...props}
      ios_backgroundColorClassName="accent-switch-inactive-track"
      thumbColorClassName={
        Platform.OS === "android"
          ? props.value
            ? "accent-switch-active-thumb"
            : "accent-switch-inactive-thumb"
          : undefined
      }
      trackColorOffClassName="accent-switch-inactive-track"
      trackColorOnClassName="accent-switch-active-track"
    />
  );
}
