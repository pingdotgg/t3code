import { LoadingIndicator, Host } from "@expo/ui/jetpack-compose";
import { size as composeSize } from "@expo/ui/jetpack-compose/modifiers";
import { StyleSheet, View, type ActivityIndicatorProps } from "react-native";
import { useResolveClassNames, withUniwind } from "uniwind";

function AndroidActivityIndicator({
  animating = true,
  color,
  colorClassName: _colorClassName,
  className: _className,
  hidesWhenStopped: _hidesWhenStopped,
  size = "small",
  style,
  ...viewProps
}: ActivityIndicatorProps) {
  const { color: primaryColor } = useResolveClassNames("text-primary");
  const diameter = typeof size === "number" ? size : size === "large" ? 48 : 20;

  return (
    <View
      accessible={animating}
      accessibilityRole="progressbar"
      accessibilityState={{ busy: animating }}
      {...viewProps}
      style={[styles.container, style]}
    >
      <View
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        style={{ width: diameter, height: diameter }}
      >
        {animating ? (
          <Host ignoreSafeAreaKeyboardInsets style={{ flex: 1 }}>
            <LoadingIndicator
              color={color ?? primaryColor}
              modifiers={[composeSize(diameter, diameter)]}
            />
          </Host>
        ) : null}
      </View>
    </View>
  );
}

export const AppActivityIndicator = withUniwind(AndroidActivityIndicator);

const styles = StyleSheet.create({
  container: { alignItems: "center", justifyContent: "center" },
});
