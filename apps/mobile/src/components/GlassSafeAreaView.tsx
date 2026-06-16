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
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 20,
            paddingTop: headerPaddingTop,
            paddingBottom: 16,
            gap: 10,
          }}
        >
          <View style={{ alignItems: "flex-start", justifyContent: "center" }}>{leftSlot}</View>
          <View
            style={{ flex: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" }}
          >
            {centerSlot}
          </View>
          <View style={{ alignItems: "flex-end", justifyContent: "center" }}>{rightSlot}</View>
        </View>
      </GlassSurface>
    </View>
  );
}
