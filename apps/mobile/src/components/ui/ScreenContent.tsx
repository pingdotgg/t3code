import type { ReactNode } from "react";
import { Platform, View } from "react-native";

/** Keeps the header surface visible behind rounded Android content corners. */
export function ScreenContent({
  children,
  insetHorizontal = false,
  fitToContents = false,
}: {
  readonly children: ReactNode;
  readonly insetHorizontal?: boolean;
  readonly fitToContents?: boolean;
}) {
  if (Platform.OS !== "android") return children;

  return (
    <View className={fitToContents ? "shrink bg-header" : "flex-1 bg-header"}>
      <View
        className="overflow-hidden rounded-t-[28px] bg-sheet-solid"
        style={{
          flexShrink: 1,
          flexGrow: fitToContents ? 0 : 1,
          flexBasis: fitToContents ? "auto" : 0,
          marginHorizontal: insetHorizontal ? 4 : 0,
        }}
      >
        {children}
      </View>
    </View>
  );
}
