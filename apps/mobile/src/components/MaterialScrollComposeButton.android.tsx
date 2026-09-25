import { Box, ExtendedFloatingActionButton, Host, Icon, Text } from "@expo/ui/jetpack-compose";
import {
  defaultMinSize,
  fillMaxWidth,
  graphicsLayer,
  height,
  onSizeChanged,
  size,
} from "@expo/ui/jetpack-compose/modifiers";
import { useCallback, useState } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { resolveScaledTextRole } from "../lib/appearancePreferences";

/** Keep the animated width and icon positioning entirely inside Compose, not Yoga. */
export function MaterialScrollComposeButton(props: {
  readonly expanded: boolean;
  readonly onPress: () => void;
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const { appearance, themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const typography = resolveScaledTextRole("footnote", appearance.baseFontSize);
  const { iconSize, fabSize } = useAndroidControlSizing();
  // Scale the native 56dp minimum; keep text and icons at their requested sizes.
  const nativeSize = Math.max(56, fabSize);
  const scale = fabSize / nativeSize;
  const nativeIconSize = Math.round(iconSize / scale);
  const [buttonWidth, setButtonWidth] = useState(nativeSize);
  const rememberWidth = useCallback(({ width }: { width: number }) => {
    setButtonWidth((previous) => Math.max(previous, width));
  }, []);
  return (
    <View
      pointerEvents="box-none"
      className={props.className}
      style={[props.style, { left: 20, height: fabSize }]}
    >
      <View pointerEvents="none" importantForAccessibility="no-hide-descendants">
        <Host
          matchContents={{ vertical: true }}
          colorScheme={themeAppearance}
          ignoreSafeAreaKeyboardInsets
          style={{ width: "100%" }}
        >
          <Box modifiers={[fillMaxWidth()]} contentAlignment="centerEnd">
            <ExtendedFloatingActionButton
              expanded={props.expanded}
              containerColor={colors["--color-primary"]}
              modifiers={[
                defaultMinSize({ minWidth: nativeSize }),
                height(nativeSize),
                graphicsLayer({
                  scaleX: scale,
                  scaleY: scale,
                  transformOriginX: 1,
                  transformOriginY: 0,
                }),
                onSizeChanged(rememberWidth),
              ]}
            >
              <ExtendedFloatingActionButton.Icon>
                <Box modifiers={[size(nativeIconSize, nativeIconSize)]}>
                  <Icon
                    source={require("../../assets/icons/compose.xml")}
                    size={nativeIconSize}
                    tint={colors["--color-primary-foreground"]}
                  />
                </Box>
              </ExtendedFloatingActionButton.Icon>
              <ExtendedFloatingActionButton.Text>
                <Text
                  color={colors["--color-primary-foreground"]}
                  style={{
                    fontSize: typography.fontSize / scale,
                    lineHeight: typography.lineHeight / scale,
                    fontWeight: "500",
                  }}
                >
                  New thread
                </Text>
              </ExtendedFloatingActionButton.Text>
            </ExtendedFloatingActionButton>
          </Box>
        </Host>
      </View>
      {/* The visual host is wider than the button; only this target intercepts list touches. */}
      <Pressable
        onPress={props.onPress}
        accessibilityRole="button"
        accessibilityLabel="New thread"
        android_ripple={{ foreground: true }}
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          // Release the label area as soon as collapse starts, before native measurements arrive.
          width: props.expanded ? buttonWidth * scale : fabSize,
          borderRadius: 16 * scale,
          overflow: "hidden",
        }}
      />
    </View>
  );
}
