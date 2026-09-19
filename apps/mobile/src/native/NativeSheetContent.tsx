import type { ReactNode } from "react";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { NATIVE_WORKSPACE_COLUMNS_SUPPORTED } from "./NativeWorkspaceColumns";

/** Reserve the sheet's own side bars without moving its native navigation chrome. */
export function NativeSheetContent(props: { readonly children: ReactNode }) {
  if (!NATIVE_WORKSPACE_COLUMNS_SUPPORTED) return <>{props.children}</>;

  // A floating sheet can have different insets from the workspace underneath it.
  return (
    <SafeAreaProvider style={{ flex: 1 }}>
      <SafeAreaView edges={["left", "right"]} style={{ flex: 1 }}>
        {props.children}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
