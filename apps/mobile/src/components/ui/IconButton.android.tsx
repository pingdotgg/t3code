import type { IconButtonProps } from "./IconButton.types";
import { NativeThemeHost } from "./NativeThemeHost.android";
import {
  FilledIconButton,
  FilledTonalIconButton,
  IconButton as ComposeIconButton,
} from "@expo/ui/jetpack-compose";
import { size } from "@expo/ui/jetpack-compose/modifiers";
import { View } from "react-native";

import { useControlTheme } from "./useControlTheme";
import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { SymbolView } from "./AppSymbol";

export function IconButton(props: IconButtonProps) {
  const { colors } = useControlTheme();
  const { iconSize, buttonSize } = useAndroidControlSizing();
  const variant = props.variant ?? "standard";
  const Component =
    variant === "standard"
      ? ComposeIconButton
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
        <NativeThemeHost
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
        </NativeThemeHost>
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
