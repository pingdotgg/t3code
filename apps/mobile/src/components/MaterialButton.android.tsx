import {
  Box,
  Button,
  CircularProgressIndicator,
  FilledTonalButton,
  Host,
  Row,
  Text,
  TextButton,
} from "@expo/ui/jetpack-compose";
import { defaultMinSize, fillMaxWidth, size } from "@expo/ui/jetpack-compose/modifiers";
import { View } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import type { MaterialButtonProps } from "./MaterialButton";
import { useAndroidControlSizing } from "./useAndroidControlSizing";

export function MaterialButton(props: MaterialButtonProps) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const typography = useScaledTextRole("footnote");
  const { scale, mediumIconSize } = useAndroidControlSizing();
  const tone = props.tone ?? "secondary";
  const Component =
    tone === "text" ? TextButton : tone === "secondary" ? FilledTonalButton : Button;
  const containerColor =
    tone === "primary"
      ? colors["--color-primary"]
      : tone === "danger"
        ? colors["--color-danger"]
        : tone === "text"
          ? "#00000000"
          : colors["--color-secondary"];
  const contentColor =
    tone === "primary"
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
      accessibilityLabel={props.label}
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
        <Host
          matchContents={props.fullWidth ? { vertical: true } : true}
          colorScheme={themeAppearance}
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
                  <CircularProgressIndicator
                    modifiers={[size(mediumIconSize, mediumIconSize)]}
                    strokeWidth={2}
                    color={colors["--color-foreground-muted"]}
                  />
                  <Box modifiers={[size(8 * scale, 1)]} />
                </>
              ) : null}
              <Text style={{ ...typography, fontWeight: "500" }}>{props.label}</Text>
            </Row>
          </Component>
        </Host>
      </View>
    </View>
  );
}
