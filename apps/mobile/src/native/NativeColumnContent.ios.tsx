import { HeaderHeightContext } from "@react-navigation/elements";
import { use, useState, type ReactNode } from "react";
import { View, type ColorValue } from "react-native";
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaFrame,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { NativeColumnLayoutMetricsContext } from "./native-layout-metrics";
import type { NativeLayoutMetrics } from "../lib/reserved-regions";
import { NativeLayoutObserver } from "./NativeLayoutObserver";
import {
  NativeWorkspaceTabActivityContext,
  WorkspaceColumnMetricsContext,
} from "./v5-workspace-context";

export function NativeColumnContent(props: {
  readonly children: ReactNode;
  readonly primary?: boolean;
  readonly insetTop?: boolean;
  readonly insetHorizontally?: boolean;
  readonly backgroundColor?: ColorValue;
  /** Shares this column's metrics across workspace tabs; see `WorkspaceColumnMetricsContext`. */
  readonly column?: string;
}) {
  const tabActivity = use(NativeWorkspaceTabActivityContext);
  const shared = use(WorkspaceColumnMetricsContext);
  const [measured, setMeasured] = useState<NativeLayoutMetrics | null>(null);
  const onMetrics = (next: NativeLayoutMetrics) => {
    // A hidden tab's insets lack the bars UIKit lays out only for the selected tab.
    if (tabActivity && !tabActivity.isActive()) return;
    setMeasured(next);
    if (props.column !== undefined) shared?.publish(props.column, next);
  };
  const metrics =
    measured ?? (props.column === undefined ? null : (shared?.byColumn.get(props.column) ?? null));
  // Until the body measures itself, its provider would hand down the window's insets. A native
  // scroll view given that top inset and then 0 is left scrolled down by the difference.
  const windowInsets = useSafeAreaInsets();
  const bodyMetrics = {
    frame: useSafeAreaFrame(),
    insets: {
      top: props.insetTop === false ? windowInsets.top : 0,
      bottom: windowInsets.bottom,
      left: props.insetHorizontally === false ? windowInsets.left : 0,
      right: props.insetHorizontally === false ? windowInsets.right : 0,
    },
  };
  return (
    <View className={props.primary ? "flex-1 bg-drawer" : "flex-1 bg-header"}>
      <SafeAreaProvider style={{ flex: 1 }}>
        <SafeAreaView
          edges={{
            top: props.insetTop === false ? "off" : "additive",
            left: props.insetHorizontally === false ? "off" : "additive",
            right: props.insetHorizontally === false ? "off" : "additive",
          }}
          style={{ flex: 1 }}
        >
          <View
            className={`flex-1 overflow-hidden ${props.primary ? "bg-drawer" : "bg-screen"} ${props.insetTop === false ? "" : "rounded-t-[28px]"}`}
            style={
              props.backgroundColor === undefined
                ? undefined
                : { backgroundColor: props.backgroundColor }
            }
          >
            {/* Descendants measure the inset body so they don't reserve the native bar twice. */}
            <SafeAreaProvider initialMetrics={bodyMetrics} style={{ flex: 1 }}>
              <NativeLayoutObserver onChange={onMetrics} />
              <NativeColumnLayoutMetricsContext value={metrics}>
                <HeaderHeightContext value={metrics?.safeArea.top ?? undefined}>
                  {props.children}
                </HeaderHeightContext>
              </NativeColumnLayoutMetricsContext>
            </SafeAreaProvider>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    </View>
  );
}
