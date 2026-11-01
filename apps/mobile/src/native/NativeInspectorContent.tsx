import type { ReactNode } from "react";
import { SafeAreaView } from "react-native-safe-area-context";

import { useNativeWorkspaceColumnsSupported } from "./NativeWorkspaceColumns";

// Pads with the inspector column's insets, which the column leaves to its panes so their
// native headers lay out against the vertical bar themselves.
export function NativeInspectorContent(props: { readonly children: ReactNode }) {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  if (!usesNativeWorkspaceColumns) return <>{props.children}</>;

  return (
    <SafeAreaView edges={["left", "right"]} style={{ flex: 1 }}>
      {props.children}
    </SafeAreaView>
  );
}
