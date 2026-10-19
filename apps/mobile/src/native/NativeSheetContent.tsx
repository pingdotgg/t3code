import type { ReactNode } from "react";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { useNativeWorkspaceColumnsSupported } from "./NativeWorkspaceColumns";

export function NativeSheetContent(props: { readonly children: ReactNode }) {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  if (!usesNativeWorkspaceColumns) return <>{props.children}</>;

  return (
    <SafeAreaProvider style={{ flex: 1 }}>
      <SafeAreaView edges={["left", "right"]} style={{ flex: 1 }}>
        {props.children}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
