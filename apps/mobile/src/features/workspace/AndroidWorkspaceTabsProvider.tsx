import type { ReactNode } from "react";
import { Platform } from "react-native";
import { WorkspaceTabsProvider } from "./WorkspaceTabsContext";

/** Android's persistent sidebar and compact root share one tab controller. */
export function AndroidWorkspaceTabsProvider(props: { readonly children: ReactNode }) {
  return Platform.OS === "android" ? (
    <WorkspaceTabsProvider>{props.children}</WorkspaceTabsProvider>
  ) : (
    props.children
  );
}
