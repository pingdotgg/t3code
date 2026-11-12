import { SymbolView } from "./AppSymbol";
import { NativeThemeHost } from "./NativeThemeHost.android";
import {
  Box,
  Button as ComposeButton,
  LoadingIndicator,
  FilledTonalButton,
  Row,
  RNHostView,
  Text,
  TextButton,
} from "@expo/ui/jetpack-compose";
import { defaultMinSize, fillMaxWidth, size } from "@expo/ui/jetpack-compose/modifiers";
import { View } from "react-native";

import { useControlTheme } from "./useControlTheme";
import { useScaledTextRole } from "../../features/settings/appearance/useScaledTextRole";
import type { ButtonProps } from "./Button";
import { useAndroidControlSizing } from "./useAndroidControlSizing";

export function Button(props: ButtonProps) {
  const { colors } = useControlTheme();
  const typography = useScaledTextRole("footnote");
  const { scale, mediumIconSize } = useAndroidControlSizing();
  const tone = props.tone ?? "secondary";
  const Component =
    tone === "text" ? TextButton : tone === "secondary" ? FilledTonalButton : ComposeButton;
  const containerColor =
    tone === "contrast"
      ? colors["--color-foreground"]
      : tone === "primary"
        ? colors["--color-primary"]
        : tone === "danger"
          ? colors["--color-danger"]
          : tone === "text"
            ? "#00000000"
            : colors["--color-secondary"];
  const contentColor =
    tone === "contrast"
      ? colors["--color-screen"]
      : tone === "primary"
        ? colors["--color-primary-foreground"]
        : tone === "danger"
          ? colors["--color-danger-foreground"]
          : tone === "text"
            ? colors["--color-primary-text"]
            : colors["--color-secondary-foreground"];
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{
        disabled: Boolean(props.disabled || props.loading),
        busy: Boolean(props.loading),
      }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={() => {
        if (!props.disabled && !props.loading) props.onPress();
      }}
      style={props.fullWidth ? { width: "100%" } : { alignSelf: "flex-start" }}
    >
      <View importantForAccessibility="no-hide-descendants">
        <NativeThemeHost
          matchContents={props.fullWidth ? { vertical: true } : true}
          ignoreSafeAreaKeyboardInsets
          style={props.fullWidth ? { width: "100%" } : { alignSelf: "flex-start" }}
        >
          <Component
            enabled={!props.disabled && !props.loading}
            onClick={props.onPress}
            modifiers={[
              defaultMinSize({ minHeight: 48 }),
              ...(props.fullWidth ? [fillMaxWidth()] : []),
            ]}
            colors={{
              containerColor,
              contentColor,
              disabledContainerColor: colors["--color-subtle-strong"],
              disabledContentColor: colors["--color-foreground-muted"],
            }}
          >
            <Row verticalAlignment="center">
              {props.loading ? (
                <>
                  <LoadingIndicator
                    modifiers={[size(mediumIconSize, mediumIconSize)]}
                    color={colors["--color-foreground-muted"]}
                  />
                  <Box modifiers={[size(8 * scale, 1)]} />
                </>
              ) : props.icon ? (
                <>
                  <RNHostView matchContents modifiers={[size(mediumIconSize, mediumIconSize)]}>
                    <View style={{ width: mediumIconSize, height: mediumIconSize }}>
                      <SymbolView
                        name={props.icon}
                        size={mediumIconSize}
                        tintColor={
                          props.disabled ? colors["--color-foreground-muted"] : contentColor
                        }
                      />
                    </View>
                  </RNHostView>
                  <Box modifiers={[size(8 * scale, 1)]} />
                </>
              ) : null}
              <Text style={{ ...typography, fontWeight: "500" }}>{props.label}</Text>
            </Row>
          </Component>
        </NativeThemeHost>
      </View>
    </View>
  );
}
