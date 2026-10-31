import type { ReactNode } from "react";
import { Platform, View } from "react-native";

export function ScreenContent({
  children,
  header,
  insetHorizontal = false,
  fitToContents = false,
}: {
  readonly children: ReactNode;
  readonly header?: ReactNode;
  readonly insetHorizontal?: boolean;
  readonly fitToContents?: boolean;
}) {
  if (Platform.OS !== "android") {
    return (
      <>
        {header}
        {children}
      </>
    );
  }

  const content = (
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
  if (header === undefined) return content;

  // Material sheets drag unless the first nested-scrolling view is the touched scroll view, and the
  // header's Compose RNHostView enables nested scrolling, so the header must follow the content.
  return (
    <View className={fitToContents ? "shrink flex-col-reverse" : "flex-1 flex-col-reverse"}>
      {content}
      {header}
    </View>
  );
}
