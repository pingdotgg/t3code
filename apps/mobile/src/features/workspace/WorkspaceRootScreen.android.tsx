import { useMemo } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { EmptyState } from "../../components/EmptyState";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { HomeRouteScreen } from "../home/HomeRouteScreen";
import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";
import { MaterialPullRequestToolbar } from "../pull-requests/MaterialPullRequestToolbar.android";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";

export function WorkspaceRootScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const workspace = useWorkspaceTabs()!;
  const { fabClearance } = useAndroidControlSizing();
  const insets = useSafeAreaInsets();
  const context = useMemo(
    () => ({
      ...workspace,
      // The Chats FABs sit above the bottom inset; the list clears both.
      bottomClearance:
        workspace.state.selectedTab === "threads" ? Math.max(insets.bottom, 16) + fabClearance : 16,
    }),
    [workspace, fabClearance, insets.bottom],
  );

  // Split lists live beside the navigator; Home remains an empty detail pane.
  if (layout.usesSplitView) {
    return workspace.state.selectedTab === "threads" ? (
      <HomeRouteScreen />
    ) : (
      <>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <AndroidScreenHeader title="Pull requests" />
        <View className="flex-1 items-center justify-center px-10">
          <EmptyState
            title="Select a pull request"
            detail="Choose a pull request from the sidebar to review it."
            variant="plain"
          />
        </View>
      </>
    );
  }

  return (
    <WorkspaceTabsContext value={context}>
      <View className="flex-1 bg-header">
        <NativeStackScreenOptions options={{ headerShown: false }} />
        {/* Chats/PRs switch lives in each list's header; no bottom bar. */}
        {workspace.state.selectedTab === "threads" ? (
          <HomeRouteScreen />
        ) : (
          <>
            <MaterialPullRequestToolbar />
            <MaterialScreenContent>
              <PullRequestsScreen />
            </MaterialScreenContent>
          </>
        )}
      </View>
    </WorkspaceTabsContext>
  );
}
