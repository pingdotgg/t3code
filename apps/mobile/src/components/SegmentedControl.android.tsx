import {
  Host,
  SegmentedButton,
  SingleChoiceSegmentedButtonRow,
  Text,
} from "@expo/ui/jetpack-compose";
import { defaultMinSize, fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import { View } from "react-native";

import { useControlTheme } from "./useControlTheme";
import type { SegmentedControlProps } from "./SegmentedControl.types";

function HostedSegmentedControl<Value extends number | string>(
  props: SegmentedControlProps<Value>,
) {
  const { colorScheme } = useControlTheme();
  return (
    <View className={props.className}>
      <View importantForAccessibility="no-hide-descendants">
        <Host
          matchContents={{ vertical: true }}
          colorScheme={colorScheme}
          ignoreSafeAreaKeyboardInsets
          style={{ width: "100%" }}
        >
          <SegmentedControlContent {...props} />
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

export type { SegmentedControlProps } from "./SegmentedControl.types";

/** Compose content shared by screen controls and native dialogs, inside their existing Host. */
function SegmentedControlContent<Value extends number | string>(
  props: SegmentedControlProps<Value>,
) {
  const { themeVariables: colors } = useAppearancePreferences();
  const typography = useScaledTextRole("footnote");
  return (
    <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
      {props.options.map((option) => (
        <SegmentedButton
          key={String(option.value)}
          selected={option.value === props.selected}
          onClick={() => props.onSelect(option.value)}
          modifiers={[defaultMinSize({ minHeight: 48 })]}
          colors={{
            activeContainerColor: colors["--color-secondary"],
            activeContentColor: colors["--color-secondary-foreground"],
            inactiveContainerColor: "transparent",
            inactiveContentColor: colors["--color-foreground"],
            activeBorderColor: colors["--color-border"],
            inactiveBorderColor: colors["--color-border"],
          }}
        >
          <SegmentedButton.Label>
            <Text style={typography}>{option.label}</Text>
          </SegmentedButton.Label>
        </SegmentedButton>
      ))}
    </SingleChoiceSegmentedButtonRow>
  );
}

/** Content is for callers already inside an Android native Host. */
export const SegmentedControl = Object.assign(HostedSegmentedControl, {
  Content: SegmentedControlContent,
});
