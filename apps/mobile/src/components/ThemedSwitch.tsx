import { Platform, Pressable, Switch, View, type SwitchProps } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useThemeColor } from "../lib/useThemeColor";
import { SymbolView } from "./AppSymbol";

export function ThemedSwitch(props: SwitchProps) {
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  const activeTrack = String(useThemeColor("--color-switch-active-track"));
  const inactiveTrack = String(useThemeColor("--color-switch-inactive-track"));
  const activeThumb = String(useThemeColor("--color-switch-active-thumb"));
  const inactiveThumb = String(useThemeColor("--color-switch-inactive-thumb"));
  const value = Boolean(props.value);

  if (Platform.OS === "android" && materialYouStyleLayoutActive) {
    const track = value ? activeTrack : inactiveTrack;
    const thumb = value ? activeThumb : inactiveThumb;

    return (
      <Pressable
        accessibilityHint={props.accessibilityHint}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="switch"
        accessibilityState={{ checked: value, disabled: props.disabled }}
        disabled={props.disabled}
        hitSlop={8}
        onPress={() => props.onValueChange?.(!value)}
        style={{ opacity: props.disabled ? 0.38 : 1 }}
        testID={props.testID}
      >
        <View
          style={{
            alignItems: value ? "flex-end" : "flex-start",
            backgroundColor: track,
            borderColor: value ? track : inactiveThumb,
            borderRadius: 16,
            borderWidth: 2,
            height: 32,
            justifyContent: "center",
            paddingHorizontal: 2,
            width: 52,
          }}
        >
          <View
            style={{
              alignItems: "center",
              backgroundColor: thumb,
              borderRadius: 12,
              height: 24,
              justifyContent: "center",
              width: 24,
            }}
          >
            <SymbolView
              name={value ? "checkmark" : "xmark"}
              size={13}
              tintColor={value ? activeTrack : inactiveTrack}
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
      ios_backgroundColor={inactiveTrack}
      thumbColor={Platform.OS === "android" ? (value ? activeThumb : inactiveThumb) : undefined}
      trackColor={{ false: inactiveTrack, true: activeTrack }}
    />
  );
}
