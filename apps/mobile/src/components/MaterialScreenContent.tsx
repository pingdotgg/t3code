import type { ReactNode } from "react";
import { Platform, View } from "react-native";

/** Android content surface below the header: flat, square edges, full width. */
export function MaterialScreenContent({
  children,
  fitToContents = false,
}: {
  readonly children: ReactNode;
  /** Allow native form sheets to measure their content instead of filling a fixed detent. */
  readonly fitToContents?: boolean;
}) {
  if (Platform.OS !== "android") return children;

  return (
    <View className={fitToContents ? "shrink bg-header" : "flex-1 bg-header"}>
      <View
        className="bg-sheet-solid"
        style={{
          flexShrink: 1,
          flexGrow: fitToContents ? 0 : 1,
          flexBasis: fitToContents ? "auto" : 0,
        }}
      >
        {children}
      </View>
    </View>
  );
}
