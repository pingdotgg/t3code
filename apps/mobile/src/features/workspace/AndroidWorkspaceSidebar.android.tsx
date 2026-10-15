import { useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";
import { MaterialPullRequestToolbar } from "../pull-requests/MaterialPullRequestToolbar.android";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { IssuesScreen } from "../issues/IssuesScreen";

export function AndroidWorkspaceSidebar(props: {
  readonly children: ReactNode;
  readonly onRequestVisibility: () => void;
  readonly selectedPullRequestKey: string | null;
  readonly selectedIssueKey: string | null;
}) {
  const workspace = useWorkspaceTabs()!;
  const context = useMemo(() => ({ ...workspace, bottomClearance: 16 }), [workspace]);
  return workspace.state.selectedTab === "threads" ? (
    props.children
  ) : (
    <WorkspaceTabsContext value={context}>
      <View className="flex-1 bg-header">
        <MaterialPullRequestToolbar
          tab={workspace.state.selectedTab}
          onRequestVisibility={props.onRequestVisibility}
        />
        <MaterialScreenContent insetHorizontal>
          {workspace.state.selectedTab === "pullRequests" ? (
            <PullRequestsScreen sidebar selectedPullRequestKey={props.selectedPullRequestKey} />
          ) : (
            <IssuesScreen sidebar selectedIssueKey={props.selectedIssueKey} />
          )}
        </MaterialScreenContent>
      </View>
    </WorkspaceTabsContext>
  );
}
