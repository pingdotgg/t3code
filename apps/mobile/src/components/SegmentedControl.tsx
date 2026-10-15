import { Picker } from "@expo/ui/swift-ui";
import { View } from "react-native";

import { useControlTheme } from "./useControlTheme";
import { NativeThemeHost } from "./NativeThemeHost";
import type { SegmentedControlProps } from "./SegmentedControl.types";

export type { SegmentedControlProps } from "./SegmentedControl.types";

/** Let UIKit own segment sizing, selection, and accessibility through SwiftUI. */
export function SegmentedControl<Value extends string | number>(
  props: SegmentedControlProps<Value>,
) {
  const { colors } = useControlTheme();
  return (
    <View className={props.className}>
      <View accessibilityElementsHidden>
        <NativeThemeHost matchContents={{ vertical: true }} style={{ width: "100%" }}>
          <Picker
            selection={props.selected}
            onSelectionChange={props.onSelect}
            segments={props.options.map((option) => ({
              label: option.label,
              value: option.value,
            }))}
            segmentColors={{
              background: colors["--color-card"],
              selectedBackground: colors["--color-secondary"],
              text: colors["--color-foreground-muted"],
              selectedText: colors["--color-secondary-foreground"],
            }}
          />
        </NativeThemeHost>
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
