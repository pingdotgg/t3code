import type { ReactNode } from "react";
import { View } from "react-native";

export interface WorkspaceColumnsProps {
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

export const NATIVE_WORKSPACE_COLUMNS_SUPPORTED = false;

export function NativeWorkspaceColumns(props: WorkspaceColumnsProps) {
  return (
    <View testID="adaptive-workspace-layout" style={{ flex: 1, flexDirection: "row" }}>
      {props.sidebar}
      {props.children}
      {props.inspector}
    </View>
  );
}
