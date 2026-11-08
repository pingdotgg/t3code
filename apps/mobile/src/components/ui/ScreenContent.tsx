import type { ReactNode } from "react";
import { Platform, View, type LayoutChangeEvent } from "react-native";

import { useAdaptiveWorkspaceLayout } from "../../features/layout/adaptive-workspace-context";
import { MOBILE_SHAPE } from "../../lib/designTokens";

const SURFACE_CLASS_NAMES = {
  sheet: "bg-card-alt",
  screen: "bg-card-alt",
  canvas: "bg-card-alt",
  drawer: "bg-drawer",
} as const;

/**
 * The body below a screen's AppBar. On Android it is the rounded card every pane and sheet
 * draws under its bar; a screen picks only the card's surface.
 */
export function ScreenContent({
  children,
  surface = "sheet",
  insetHorizontal = true,
  fitToContents = false,
  onLayout,
}: {
  readonly children: ReactNode;
  readonly surface?: keyof typeof SURFACE_CLASS_NAMES;
  /** Keeps the card off the window edge. Defaults to on. */
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
    <View className={fitToContents ? "shrink bg-screen" : "flex-1 bg-screen"}>
      <View
        className={`overflow-hidden ${SURFACE_CLASS_NAMES[surface]}`}
        collapsable={false}
        onLayout={onLayout}
        style={{
          flexShrink: 1,
          flexGrow: fitToContents ? 0 : 1,
          flexBasis: fitToContents ? "auto" : 0,
          borderRadius: MOBILE_SHAPE.content,
          marginHorizontal: insetHorizontal ? (layout.usesSplitView ? 4 : 8) : 0,
          marginBottom: 8,
        }}
      >
        {children}
      </View>
    </View>
  );
}
