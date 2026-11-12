import type { ReactNode } from "react";
import { Platform, View, type LayoutChangeEvent } from "react-native";

import { useAdaptiveWorkspaceLayout } from "../../features/layout/adaptive-workspace-context";

const SURFACE_CLASS_NAMES = {
  sheet: "bg-sheet-solid",
  screen: "bg-screen",
  canvas: "bg-thread-canvas",
  drawer: "bg-drawer",
} as const;

/**
 * The body below a screen's AppBar. On Android it is the rounded card every pane and sheet
 * draws under its bar; a screen picks only the card's surface.
 */
export function ScreenContent({
  children,
  surface = "sheet",
  insetHorizontal,
  fitToContents = false,
  onLayout,
}: {
  readonly children: ReactNode;
  readonly surface?: keyof typeof SURFACE_CLASS_NAMES;
  /** Keeps the card off the window edge. Defaults to on wherever the workspace is split. */
  readonly insetHorizontal?: boolean;
  readonly fitToContents?: boolean;
  readonly onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const { layout } = useAdaptiveWorkspaceLayout();
  if (Platform.OS !== "android") {
    return onLayout ? (
      <View className="flex-1" onLayout={onLayout}>
        {children}
      </View>
    ) : (
      children
    );
  }

  return (
    <View className={fitToContents ? "shrink bg-header" : "flex-1 bg-header"}>
      <View
        className={`overflow-hidden rounded-t-[28px] ${SURFACE_CLASS_NAMES[surface]}`}
        collapsable={false}
        onLayout={onLayout}
        style={{
          flexShrink: 1,
          flexGrow: fitToContents ? 0 : 1,
          flexBasis: fitToContents ? "auto" : 0,
          marginHorizontal: (insetHorizontal ?? layout.usesSplitView) ? 4 : 0,
        }}
      >
        {children}
      </View>
    </View>
  );
}
