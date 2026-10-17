import { useMemo } from "react";
import { View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { HomeRouteScreen } from "../home/HomeRouteScreen";
import { PullRequestFilterMenuProvider } from "../pull-requests/PullRequestFilterMenuContext";
import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";
import { PullRequestToolbar } from "../pull-requests/PullRequestToolbar.android";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidWorkspaceNavigation } from "./AndroidWorkspaceNavigation";
import { useAndroidWorkspaceRoot } from "./AndroidWorkspaceTabsProvider";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceTabTransition } from "./WorkspaceTabTransition";

export function WorkspaceRootScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const workspace = useWorkspaceTabs()!;
  const root = useAndroidWorkspaceRoot();
  const insets = useSafeAreaInsets();
  const { fabClearance } = useAndroidControlSizing();
  const context = useMemo(
    () => ({
      ...workspace,
      bottomClearance: workspace.state.selectedTab === "threads" ? fabClearance + 16 : 16,
    }),
    [workspace, fabClearance],
  );
  // Settings covers Home, which stays blank so the outgoing tab fades straight into
  // Settings instead of flashing Chats on the way.
  const tab = root?.settingsOpen ? "settings" : workspace.state.selectedTab;

  if (layout.usesSplitView) {
    return (
      <WorkspaceTabTransition tab={tab}>
        {tab === "settings" ? null : tab === "threads" ? (
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
        )}
      </WorkspaceTabTransition>
    );
  }

  return (
    <WorkspaceTabsContext value={context}>
      <View className="flex-1 bg-header">
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <SafeAreaInsetsContext value={{ ...insets, bottom: 0 }}>
          <WorkspaceTabTransition tab={tab}>
            {tab === "settings" ? null : tab === "threads" ? (
              <HomeRouteScreen />
            ) : (
              <PullRequestFilterMenuProvider>
                <PullRequestToolbar />
                <ScreenContent>
                  <PullRequestsScreen />
                </ScreenContent>
              </PullRequestFilterMenuProvider>
            )}
          </WorkspaceTabTransition>
        </SafeAreaInsetsContext>
        <AndroidWorkspaceNavigation />
      </View>
    </WorkspaceTabsContext>
  );
}
