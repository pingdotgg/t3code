import type { ReactNode } from "react";
import { Platform } from "react-native";
import { WorkspaceTabsProvider } from "./WorkspaceTabsContext";

export function AndroidWorkspaceTabsProvider(props: { readonly children: ReactNode }) {
  return Platform.OS === "android" ? (
    <WorkspaceTabsProvider>{props.children}</WorkspaceTabsProvider>
  ) : (
    props.children
  );
}
