import {
  Box,
  ExtendedFloatingActionButton,
  FloatingActionButton,
  Host,
  LargeFloatingActionButton,
  Text,
} from "@expo/ui/jetpack-compose";
import { size } from "@expo/ui/jetpack-compose/modifiers";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

export function MaterialFloatingActionButton(props: {
  readonly onPress: () => void;
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly variant?: "extended" | "large";
  readonly expanded?: boolean;
  readonly tone?: "primary" | "secondary";
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const typography = useScaledTextRole("footnote");
  const primary = props.tone === "primary";
  const containerColor = colors[primary ? "--color-primary" : "--color-secondary"];
  const contentColor =
    colors[primary ? "--color-primary-foreground" : "--color-secondary-foreground"];
  const Component =
    props.variant === "extended"
      ? ExtendedFloatingActionButton
      : props.variant === "large"
        ? LargeFloatingActionButton
        : FloatingActionButton;
  const iconSize = props.variant === "large" ? 36 : 24;
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={props.onPress}
      className={props.className}
      style={props.style}
    >
      <View importantForAccessibility="no-hide-descendants">
        <Host matchContents colorScheme={themeAppearance} ignoreSafeAreaKeyboardInsets>
          <Component
            containerColor={containerColor}
            onClick={props.onPress}
            expanded={props.expanded}
          >
            <Component.Icon>
              <Box modifiers={[size(iconSize, iconSize)]} />
            </Component.Icon>
            {props.variant === "extended" ? (
              <ExtendedFloatingActionButton.Text>
                <Text color={contentColor} style={{ ...typography, fontWeight: "500" }}>
                  {props.label}
                </Text>
              </ExtendedFloatingActionButton.Text>
            ) : null}
          </Component>
        </Host>
      </View>
      {/* The RN icon stays outside Compose so it cannot intercept native button taps. */}
      <View
        pointerEvents="none"
        className="absolute inset-y-0 justify-center"
        style={
          props.variant === "extended" ? { left: 16 } : { left: 0, right: 0, alignItems: "center" }
        }
      >
        <SymbolView
          name={props.icon}
          size={iconSize}
          tintColorClassName={primary ? "accent-primary-foreground" : "accent-secondary-foreground"}
        />
      </View>
    </View>
  );
}
