import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
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
  const insets = useSafeAreaInsets();
  const headerPaddingTop = insets.top + 16;

  return (
    <View className="border-b border-header-border bg-header" style={style}>
      <GlassSurface
        chrome="none"
        glassEffectStyle="regular"
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
