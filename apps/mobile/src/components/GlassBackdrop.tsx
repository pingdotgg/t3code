import { BlurView } from "expo-blur";
import { Platform, StyleSheet, View, type ColorValue } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { themeColorWithAlpha } from "../lib/mobileTheme";

/** Frosted backdrop for containers that clip their children to their shape. */
export function GlassBackdrop(props: { readonly fallbackColor?: ColorValue }) {
  const { themeAppearance, themeVariables } = useAppearancePreferences();
  const supportsBlur = Platform.OS === "ios";
  const color = props.fallbackColor ?? themeVariables["--color-glass-fallback"];
  const colorStyle = {
    backgroundColor: supportsBlur ? color : themeColorWithAlpha(String(color), 1),
  };

  return (
    <>
      {supportsBlur ? (
        <BlurView
          pointerEvents="none"
          intensity={80}
          tint={themeAppearance === "dark" ? "dark" : "default"}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View
        pointerEvents="none"
        className="absolute inset-0 bg-glass-fallback"
        style={colorStyle}
      />
    </>
  );
}
