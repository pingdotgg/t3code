import { HeaderHeightContext } from "@react-navigation/elements";
import { use } from "react";
import { Platform } from "react-native";

import { useAdaptiveWorkspaceLayout } from "../../features/layout/adaptive-workspace-context";
import { NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET } from "../../features/layout/native-mail-search-toolbar";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import type { AppBarSearch } from "./AppBar.types";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { IOS_NAV_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { useToolbarLayout } from "./useToolbarLayout";

/**
 * How far below the screen's top edge its AppBar ends: where content that scrolls under a
 * translucent bar starts, and where an overlay pinned under the bar goes. Measured by the native
 * column or stack on iOS; Android draws the bar in-tree from the toolbar geometry.
 */
export function useBarInset(): number {
  const headerHeight = use(HeaderHeightContext);
  const columnMetrics = useNativeColumnLayoutMetrics();
  const insets = useSafeAreaInsets();
  const toolbar = useToolbarLayout();
  if (Platform.OS === "android") {
    return toolbar.paddingTop + toolbar.height + toolbar.paddingBottom;
  }
  return headerHeight ?? columnMetrics?.safeArea.top ?? insets.top + IOS_NAV_BAR_HEIGHT;
}

/**
 * How far the bar covers the top of the body below it: the bar inset where the body runs under
 * the iOS bar, 0 on Android, where the bar sits above the body in flow.
 */
export function useBarOverlap(): number {
  const barInset = useBarInset();
  return Platform.OS === "android" ? 0 : barInset;
}

/**
 * The content's top safe area under the AppBar: a translucent bar's height, zero under a solid
 * one or on Android, where the bar sits in flow. For scroll content insets, which must not
 * double-count a solid bar.
 */
export function useContentTopInset(): number {
  const insets = useSafeAreaInsets();
  const columnMetrics = useNativeColumnLayoutMetrics();
  return Platform.OS === "ios" ? (columnMetrics?.safeArea.top ?? insets.top) : 0;
}

/** How much of the screen's bottom edge an AppBar `search` covers: iOS's bottom search toolbar. */
export function useSearchToolbarInset(search: AppBarSearch | undefined): number {
  const { layout } = useAdaptiveWorkspaceLayout();
  const usesNativeMailSearchToolbar = useNativeMailSearchToolbar();
  return search !== undefined &&
    (search.compactToolbar ?? !layout.usesSplitView) &&
    usesNativeMailSearchToolbar
    ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET
    : 0;
}
