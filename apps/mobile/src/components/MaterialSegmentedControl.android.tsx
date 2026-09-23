import { Host } from "@expo/ui/jetpack-compose";
import { MaterialSegmentedButtons } from "./MaterialSegmentedButtons.android";
import { View } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import type { SegmentedControlProps } from "./SegmentedControl.types";

export function MaterialSegmentedControl<Value extends number | string>(
  props: SegmentedControlProps<Value>,
) {
  const { themeAppearance } = useAppearancePreferences();
  return (
    <View className={props.className}>
      <View importantForAccessibility="no-hide-descendants">
        <Host
          matchContents={{ vertical: true }}
          colorScheme={themeAppearance}
          ignoreSafeAreaKeyboardInsets
          style={{ width: "100%" }}
        >
          <MaterialSegmentedButtons {...props} />
        </Host>
      </View>
      <View pointerEvents="none" className="absolute inset-0 flex-row">
        {props.options.map((option) => (
          <View
            key={String(option.value)}
            accessible
            accessibilityRole={props.role ?? "button"}
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ selected: option.value === props.selected }}
            accessibilityActions={[{ name: "activate" }]}
            onAccessibilityAction={() => props.onSelect(option.value)}
            className="flex-1"
          />
        ))}
      </View>
    </View>
  );
}
