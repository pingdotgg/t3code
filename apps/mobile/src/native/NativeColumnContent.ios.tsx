import { HeaderHeightContext } from "@react-navigation/elements";
import { use, useState, type ReactNode } from "react";
import { View, type ColorValue } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
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
  return (
    <View
      className={props.primary ? "flex-1 bg-drawer" : "flex-1 bg-screen"}
      style={
        props.backgroundColor === undefined ? undefined : { backgroundColor: props.backgroundColor }
      }
    >
      <SafeAreaProvider style={{ flex: 1 }}>
        <SafeAreaView
          edges={props.insetHorizontally === false ? [] : ["left", "right"]}
          style={{ flex: 1 }}
        >
          {/* Observe the inset body. UIKit can reserve other columns in its safe area. */}
          <View style={{ flex: 1 }}>
            <NativeLayoutObserver onChange={onMetrics} />
            <NativeColumnLayoutMetricsContext value={metrics}>
              <HeaderHeightContext value={metrics?.safeArea.top ?? undefined}>
                {props.children}
              </HeaderHeightContext>
            </NativeColumnLayoutMetricsContext>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    </View>
  );
}
