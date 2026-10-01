import {
  FilledIconButton,
  FilledTonalIconButton,
  Host,
  IconButton,
} from "@expo/ui/jetpack-compose";
import { size } from "@expo/ui/jetpack-compose/modifiers";
import { View } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

export function MaterialIconButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly variant?: "standard" | "primary" | "tonal" | "danger";
  readonly tintColorClassName?: string;
}) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const { iconSize, buttonSize } = useAndroidControlSizing();
  const variant = props.variant ?? "standard";
  const Component =
    variant === "standard"
      ? IconButton
      : variant === "tonal"
        ? FilledTonalIconButton
        : FilledIconButton;
  const containerColor =
    variant === "primary"
      ? colors["--color-primary"]
      : variant === "danger"
        ? colors["--color-danger"]
        : colors["--color-secondary"];
  const iconTint = props.disabled
    ? "accent-icon-subtle"
    : variant === "primary"
      ? "accent-primary-foreground"
      : variant === "danger"
        ? "accent-danger-foreground"
        : variant === "tonal"
          ? "accent-secondary-foreground"
          : (props.tintColorClassName ?? "accent-foreground");
  return (
    <View
      accessible
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(props.disabled), selected: props.selected }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={() => {
        if (!props.disabled) props.onPress?.();
      }}
      style={{ width: buttonSize, height: buttonSize }}
    >
      <View importantForAccessibility="no-hide-descendants">
        <Host
          colorScheme={themeAppearance}
          ignoreSafeAreaKeyboardInsets
          style={{ width: buttonSize, height: buttonSize }}
        >
          <Component
            onClick={props.onPress}
            enabled={!props.disabled}
            modifiers={[size(buttonSize, buttonSize)]}
            colors={
              variant === "standard"
                ? undefined
                : { containerColor, disabledContainerColor: colors["--color-subtle-strong"] }
            }
          >
            {null}
          </Component>
        </Host>
      </View>
      {/* Keep RN SVG measurement outside Compose; the native button owns touch and ripple. */}
      <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
        <SymbolView
          name={props.icon === "ellipsis" ? { ios: "ellipsis", android: "more_vert" } : props.icon}
          size={iconSize}
          tintColorClassName={iconTint}
          type="monochrome"
        />
      </View>
    </View>
  );
}
