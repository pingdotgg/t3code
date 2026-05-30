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
    backgroundColor: isDarkMode ? "rgba(10,10,10,0.97)" : "rgba(255,255,255,0.97)",
    borderBottomWidth: 1,
    borderBottomColor: isDarkMode ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
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
