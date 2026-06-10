import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import { Platform, useColorScheme, View, type ViewProps, type ViewStyle } from "react-native";

export interface GlassSurfaceProps extends ViewProps {
  readonly children: ReactNode;
  readonly glassEffectStyle?: "clear" | "regular" | "none";
  readonly tintColor?: string;
  readonly chrome?: "default" | "none";
}

export function GlassSurface({
  children,
  glassEffectStyle = "regular",
  chrome = "default",
  tintColor,
  style,
  ...props
}: GlassSurfaceProps) {
  const isDarkMode = useColorScheme() === "dark";
  const supportsGlass = Platform.OS === "ios" && isGlassEffectAPIAvailable();
  const surfaceStyle: ViewStyle = {
    borderRadius: 32,
    overflow: "hidden",
    borderWidth: chrome === "none" ? 0 : 1,
    borderColor:
      chrome === "none"
        ? "transparent"
        : isDarkMode
          ? "rgba(255,255,255,0.08)"
          : "rgba(226,232,240,0.9)",
    backgroundColor:
      chrome === "none"
        ? "transparent"
        : isDarkMode
          ? "rgba(15,23,42,0.78)"
          : "rgba(255,255,255,0.72)",
    shadowColor: chrome === "none" ? "transparent" : "#020617",
    shadowOpacity: chrome === "none" ? 0 : isDarkMode ? 0.22 : 0.08,
    shadowRadius: chrome === "none" ? 0 : 28,
    shadowOffset:
      chrome === "none"
        ? {
            width: 0,
            height: 0,
          }
        : {
            width: 0,
            height: 14,
          },
    elevation: chrome === "none" ? 0 : 12,
  };

  if (supportsGlass) {
    return (
      <GlassView
        {...props}
        glassEffectStyle={glassEffectStyle}
        tintColor={tintColor ?? (isDarkMode ? "rgba(15,23,42,0.18)" : "rgba(255,255,255,0.18)")}
        colorScheme={isDarkMode ? "dark" : "light"}
        style={[surfaceStyle, style]}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <View {...props} style={[surfaceStyle, style]}>
      {children}
    </View>
  );
}
