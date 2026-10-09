import type { ReactNode } from "react";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { useNativeWorkspaceColumnsSupported } from "./NativeWorkspaceColumns";

/** Reserve the sheet's own side bars without moving its native navigation chrome. */
export function NativeSheetContent(props: { readonly children: ReactNode }) {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  if (!usesNativeWorkspaceColumns) return <>{props.children}</>;

  // A floating sheet can have different insets from the workspace underneath it.
  return (
    <SafeAreaProvider style={{ flex: 1 }}>
      <SafeAreaView edges={["left", "right"]} style={{ flex: 1 }}>
        {props.children}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
