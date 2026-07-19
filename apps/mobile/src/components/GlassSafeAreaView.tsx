import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../lib/useThemeColor";

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
  const insets = useSafeAreaInsets();
  const headerColor = useThemeColor("--color-header");
  const headerBorderColor = useThemeColor("--color-header-border");
  const glassTint = useThemeColor("--color-glass-tint");
  const headerPaddingTop = insets.top + 16;
  const surfaceStyle = {
    borderRadius: 0,
    backgroundColor: headerColor,
    borderBottomWidth: 1,
    borderBottomColor: headerBorderColor,
  } as const;

  return (
    <View style={[surfaceStyle, style]}>
      <GlassSurface
        chrome="none"
        glassEffectStyle="regular"
        tintColor={glassTint}
        style={{ borderRadius: 0, backgroundColor: "transparent" }}
      >
        <View
          className="flex-row items-center gap-2.5 px-5 pb-4"
          style={{ paddingTop: headerPaddingTop }}
        >
          <View className="items-start justify-center">{leftSlot}</View>
          <View className="flex-1 items-center justify-center overflow-hidden">{centerSlot}</View>
          <View className="items-end justify-center">{rightSlot}</View>
        </View>
      </GlassSurface>
    </View>
  );
}
