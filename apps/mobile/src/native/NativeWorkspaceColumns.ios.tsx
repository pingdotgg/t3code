import { useState, type ReactNode } from "react";
import { requireOptionalNativeModule } from "expo";
import { Platform, View } from "react-native";
import { Split } from "react-native-screens/experimental";
import { NativeLayoutObserver } from "./NativeLayoutObserver";
import type { NativeLayoutMetrics } from "../lib/reserved-regions";
import { NativeColumnLayoutMetricsContext } from "../features/layout/native-layout-metrics";

import { useUniwindTheme } from "../lib/useUniwindTheme";

interface WorkspaceColumnsProps {
  readonly sidebar: ReactNode;
  readonly sidebarWidth: number;
  readonly sidebarVisible: boolean;
  readonly onSidebarWidthChange: (width: number) => void;
  readonly inspector: ReactNode;
  readonly inspectorVisible: boolean;
  readonly inspectorWidth: number;
  readonly onInspectorHide: () => void;
  readonly onInspectorClosed: () => void;
  readonly children: ReactNode;
}

const nativeControls = requireOptionalNativeModule<{ readonly supportsWorkspaceColumns?: boolean }>(
  "T3NativeControls",
);
export const NATIVE_WORKSPACE_COLUMNS_SUPPORTED =
  Number(Platform.Version) >= 27.1 && nativeControls?.supportsWorkspaceColumns === true;

/** UIKit keeps primary-column bars horizontal and gives the detail the Duo rail. */
export function NativeWorkspaceColumns(props: WorkspaceColumnsProps) {
  const theme = useUniwindTheme();
  const [columnMetrics, setColumnMetrics] = useState<NativeLayoutMetrics | null>(null);
  // UIKit exposes the column's backing surface during the transition.
  const contentBackground = { backgroundColor: theme["--color-screen"] };

  if (!NATIVE_WORKSPACE_COLUMNS_SUPPORTED) {
    return (
      <View testID="adaptive-workspace-layout" style={{ flex: 1, flexDirection: "row" }}>
        {props.sidebar}
        {props.children}
        {props.inspector}
      </View>
    );
  }

  // Both columns remain mounted when UIKit collapses to the outer display.
  return (
    <Split.Host
      testID="adaptive-workspace-layout"
      style={contentBackground}
      preferredSplitBehavior="tile"
      preferredDisplayMode={props.sidebarVisible ? "oneBesideSecondary" : "secondaryOnly"}
      topColumnForCollapsing="secondary"
      displayModeButtonVisibility="never"
      presentsWithGesture={false}
      showInspector={props.inspectorVisible}
      onInspectorHide={props.onInspectorHide}
      primaryBackgroundStyle="none"
      columnMetrics={{
        minimumPrimaryColumnWidth: 280,
        maximumPrimaryColumnWidth: Math.max(380, props.sidebarWidth),
        preferredPrimaryColumnWidthOrFraction: props.sidebarWidth,
        minimumSecondaryColumnWidth: 320,
        minimumInspectorColumnWidth: 220,
        maximumInspectorColumnWidth: Math.max(420, props.inspectorWidth),
        preferredInspectorColumnWidthOrFraction: props.inspectorWidth,
      }}
    >
      <Split.Column
        style={{ backgroundColor: theme["--color-drawer"] }}
        onLayout={(event) => props.onSidebarWidthChange(event.nativeEvent.layout.width)}
      >
        {props.sidebar}
      </Split.Column>
      <Split.Inspector style={contentBackground} onDidDisappear={props.onInspectorClosed}>
        {props.inspector}
      </Split.Inspector>
      <Split.Column style={contentBackground}>
        <View className="flex-1 flex-row bg-screen">
          <NativeLayoutObserver onChange={setColumnMetrics} />
          <NativeColumnLayoutMetricsContext value={columnMetrics}>
            {props.children}
          </NativeColumnLayoutMetricsContext>
        </View>
      </Split.Column>
    </Split.Host>
  );
}
