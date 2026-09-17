import { Box, ExtendedFloatingActionButton, Host, Icon, Text } from "@expo/ui/jetpack-compose";
import { fillMaxWidth, onSizeChanged, size } from "@expo/ui/jetpack-compose/modifiers";
import { useCallback, useState } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";

/** Keep the animated width and icon positioning entirely inside Compose, not Yoga. */
export function MaterialScrollComposeButton(props: {
  readonly expanded: boolean;
  readonly onPress: () => void;
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const typography = useScaledTextRole("footnote");
  const [expandedWidth, setExpandedWidth] = useState(56);
  const rememberWidth = useCallback(({ width }: { width: number }) => {
    setExpandedWidth((previous) => Math.max(previous, width));
  }, []);
  return (
    <View pointerEvents="box-none" className={props.className} style={[props.style, { left: 20 }]}>
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
              modifiers={[onSizeChanged(rememberWidth)]}
            >
              <ExtendedFloatingActionButton.Icon>
                <Box modifiers={[size(24, 24)]}>
                  <Icon
                    source={require("../../assets/icons/compose.xml")}
                    size={24}
                    tint={colors["--color-primary-foreground"]}
                  />
                </Box>
              </ExtendedFloatingActionButton.Icon>
              <ExtendedFloatingActionButton.Text>
                <Text
                  color={colors["--color-primary-foreground"]}
                  style={{ ...typography, fontWeight: "500" }}
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
          width: props.expanded ? expandedWidth : 56,
          borderRadius: 16,
          overflow: "hidden",
        }}
      />
    </View>
  );
}
