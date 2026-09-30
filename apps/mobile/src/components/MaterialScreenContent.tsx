import type { ReactNode } from "react";
import { Platform, View } from "react-native";

/** Keeps the header surface visible behind rounded Android content corners. */
export function MaterialScreenContent({
  children,
  insetHorizontal = false,
  fitToContents = false,
}: {
  readonly children: ReactNode;
  /** Match the master-list gutters for secondary panes, not full-width content. */
  readonly insetHorizontal?: boolean;
  /** Allow native form sheets to measure their content instead of filling a fixed detent. */
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
