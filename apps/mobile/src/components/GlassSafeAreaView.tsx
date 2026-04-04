import type { ReactNode } from "react";
import { useColorScheme, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassSurface } from "./GlassSurface";

export interface GlassSafeAreaViewProps {
  readonly leftSlot?: ReactNode;
  readonly centerSlot?: ReactNode;
  readonly rightSlot?: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}

export function GlassSafeAreaView({
  leftSlot,
  centerSlot,
  rightSlot,
  style,
}: GlassSafeAreaViewProps) {
  const isDarkMode = useColorScheme() === "dark";
  const insets = useSafeAreaInsets();
  const headerPaddingTop = insets.top + 16;
  const surfaceStyle = {
    borderRadius: 0,
    backgroundColor: isDarkMode ? "rgba(2,6,23,0.18)" : "rgba(248,250,252,0.2)",
    borderBottomWidth: 1,
    borderBottomColor: isDarkMode ? "rgba(255,255,255,0.08)" : "rgba(148,163,184,0.16)",
  } as const;

  return (
    <View style={[surfaceStyle, style]}>
      <GlassSurface
        chrome="none"
        glassEffectStyle="regular"
        tintColor={isDarkMode ? "rgba(15,23,42,0.24)" : "rgba(255,255,255,0.18)"}
        style={{ borderRadius: 0, backgroundColor: "transparent" }}
      >
        <View
          className="flex-row items-center px-5 pb-4 pt-4"
          style={{ paddingTop: headerPaddingTop }}
        >
          <View className="min-w-[48px] items-start justify-center">{leftSlot}</View>
          <View className="flex-1 items-center justify-center">{centerSlot}</View>
          <View className="min-w-[48px] items-end justify-center">{rightSlot}</View>
        </View>
      </GlassSurface>
    </View>
  );
}
