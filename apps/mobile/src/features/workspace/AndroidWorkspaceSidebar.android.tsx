import { useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";

export function AndroidWorkspaceSidebar(props: {
  readonly children: ReactNode;
  readonly onRequestVisibility: () => void;
  readonly selectedPullRequestKey: string | null;
}) {
  const workspace = useWorkspaceTabs()!;
  const context = useMemo(() => ({ ...workspace, bottomClearance: 16 }), [workspace]);
  return workspace.state.selectedTab === "threads" ? (
    props.children
  ) : (
    <WorkspaceTabsContext value={context}>
      <View className="flex-1 bg-header">
        <PullRequestsScreen
          sidebar
          selectedPullRequestKey={props.selectedPullRequestKey}
          onRequestVisibility={props.onRequestVisibility}
        />
      </View>
    </WorkspaceTabsContext>
  );
}
