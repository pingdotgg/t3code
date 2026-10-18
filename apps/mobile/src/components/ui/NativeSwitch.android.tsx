import { NativeThemeHost } from "./NativeThemeHost.android";
import { Switch as ComposeSwitch } from "@expo/ui/jetpack-compose";
import { Pressable, View } from "react-native";
import type { ThemedSwitchProps } from "./NativeSwitch.types";

import { useControlTheme } from "./useControlTheme";

/**
 * Material's native switch, with the same palette and accessibility contract as our RN controls.
 * Compose only draws it. The RN Pressable owns the touch so it wins over a pressable parent row;
 * with Compose handling touches, a tap on the switch ran the row's onPress instead.
 */
export function NativeSwitch(props: ThemedSwitchProps) {
  const { colors } = useControlTheme();

  return (
    <Pressable
      disabled={props.disabled}
      onPress={() => props.onValueChange?.(!props.value)}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      accessibilityRole="switch"
      accessibilityState={{ checked: Boolean(props.value), disabled: Boolean(props.disabled) }}
      style={props.style}
      testID={props.testID}
    >
      <View importantForAccessibility="no-hide-descendants" pointerEvents="none">
        <NativeThemeHost ignoreSafeAreaKeyboardInsets style={{ width: 52, height: 48 }}>
          <ComposeSwitch
            value={Boolean(props.value)}
            enabled={!props.disabled}
            colors={{
              checkedTrackColor: colors["--color-switch-active-track"],
              checkedThumbColor: colors["--color-switch-active-thumb"],
              checkedBorderColor: colors["--color-switch-active-track"],
              uncheckedTrackColor: colors["--color-switch-inactive-track"],
              uncheckedThumbColor: colors["--color-switch-inactive-thumb"],
              uncheckedBorderColor: colors["--color-switch-inactive-thumb"],
            }}
          />
        </NativeThemeHost>
      </View>
    </Pressable>
  );
}
