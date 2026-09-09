import { BlurView } from "expo-blur";
import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import { useContext, type ReactNode, type Ref, type RefObject } from "react";
import {
  Platform,
  StyleSheet,
  useColorScheme,
  View,
  type ColorValue,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import { withUniwind } from "uniwind";

import { cn } from "../lib/cn";
import { GlassBlurTargetContext } from "../lib/glassBlurTarget";
import { themeColorWithAlpha } from "../lib/mobileTheme";

// Explicit mappings keep the native glassEffectStyle enum out of style-array conversion.
const ThemedGlassView = withUniwind(GlassView, {
  style: { fromClassName: "className" },
  tintColor: { fromClassName: "tintColorClassName", styleProperty: "accentColor" },
});

interface GlassSurfaceProps extends ViewProps {
  readonly ref?: Ref<View>;
  readonly children: ReactNode;
  readonly glassEffectStyle?: "clear" | "regular" | "none";
  readonly tintColor?: ColorValue;
  readonly tintColorClassName?: string;
  readonly chrome?: "default" | "none";
  /** Base color for the frosted tint, or solid fill when blur is unavailable. */
  readonly fallbackColor?: ColorValue;
  readonly blurTarget?: RefObject<View | null>;
  /** Uniwind styling used only when native Liquid Glass is unavailable. */
  readonly fallbackClassName?: string;
}

export function GlassSurface({
  ref,
  children,
  glassEffectStyle = "regular",
  chrome = "default",
  tintColor,
  tintColorClassName,
  fallbackColor,
  blurTarget,
  fallbackClassName,
  className,
  style,
  ...props
}: GlassSurfaceProps) {
  const isDarkMode = useColorScheme() === "dark";
  const inheritedBlurTarget = useContext(GlassBlurTargetContext);
  const target = blurTarget ?? inheritedBlurTarget;
  const supportsBlur =
    Platform.OS === "ios" ||
    (Platform.OS === "android" && Platform.Version >= 31 && target !== undefined);
  const backgroundColor =
    fallbackColor === undefined ? undefined : themeColorWithAlpha(String(fallbackColor), 1);
  const supportsGlass = Platform.OS === "ios" && isGlassEffectAPIAvailable();
  const surfaceStyle: ViewStyle = {
    borderRadius: 32,
    overflow: "hidden",
    shadowColor: chrome === "none" ? "transparent" : "#000000",
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
      <ThemedGlassView
        {...props}
        ref={ref}
        className={cn(
          chrome === "none"
            ? "border-0 border-transparent bg-transparent"
            : "border border-border bg-glass-surface",
          className,
        )}
        glassEffectStyle={glassEffectStyle}
        tintColor={tintColor === undefined ? undefined : String(tintColor)}
        tintColorClassName={
          tintColorClassName ?? (tintColor === undefined ? "accent-glass-tint" : undefined)
        }
        colorScheme={isDarkMode ? "dark" : "light"}
        style={[surfaceStyle, style]}
      >
        {children}
      </ThemedGlassView>
    );
  }

  return (
    <View
      {...props}
      ref={ref}
      className={cn(
        chrome === "none" ? "border-0 border-transparent" : "border border-border",
        fallbackClassName,
        className,
      )}
      style={[surfaceStyle, style]}
    >
      {supportsBlur ? (
        <BlurView
          pointerEvents="none"
          blurTarget={target}
          blurMethod="dimezisBlurViewSdk31Plus"
          intensity={80}
          tint={isDarkMode ? "dark" : "default"}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View
        pointerEvents="none"
        className="absolute inset-0 bg-card"
        style={{ backgroundColor, opacity: supportsBlur ? (isDarkMode ? 0.25 : 0.55) : 1 }}
      />
      {children}
    </View>
  );
}
