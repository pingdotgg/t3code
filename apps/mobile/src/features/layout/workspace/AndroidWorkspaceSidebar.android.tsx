import { useAndroidFloatingTabs } from "../../settings/appearance/AppearancePreferencesProvider";
import { WorkspaceNoTabs } from "./WorkspaceNoTabs";
import { useEnabledNavigationTabs } from "./navigation-tabs";
import { NAVIGATION_TAB_ORDER } from "./navigation-tab-order";
import { useNavigationState } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAndroidControlSizing } from "../../../components/ui/useAndroidControlSizing";
import { FLOATING_TABS } from "./floating-workspace-tabs";
import { View } from "react-native";
import { AppBar } from "../../../components/ui/AppBar";
import { BotsScreen, useOpenNewBot } from "../../bots/BotsScreen";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { PullRequestsScreen } from "../../pull-requests/PullRequestsScreen";
import { ListSearchToolbar } from "./ListSearchToolbar.android";
import { IssuesScreen } from "../../issues/IssuesScreen";
import { selectedIssueKey } from "../../issues/issueParams";
import { selectedPullRequestKey } from "../../pull-requests/pullRequestSelection";
import { AndroidHomeFabLayout } from "../../home/AndroidHomeFab";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { useAndroidWorkspaceRoot } from "./AndroidWorkspaceTabsProvider";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceTabPanes } from "./WorkspaceTabPanes";
import { WorkspaceThreadSidebar } from "./WorkspaceThreadSidebar";
import { WorkspaceAppBarScope } from "../../../components/ui/WorkspaceAppBar.android";

/** The Home route in the sidebar column: the selected tab's list. */
export function AndroidWorkspaceSidebar() {
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const workspace = useWorkspaceTabs()!;
  const enabled = useEnabledNavigationTabs();
  const insets = useSafeAreaInsets();
  const { fabSize } = useAndroidControlSizing();
  const { revealPrimarySidebar, startNewTask } = useAdaptiveWorkspaceLayout();
  const selectedPullRequest = useNavigationState(selectedPullRequestKey);
  const selectedIssue = useNavigationState(selectedIssueKey);
  // Settings covers the sidebar.
  const coveredByPage = useAndroidWorkspaceRoot()?.settingsOpen ?? false;
  const bottomClearance = floatingTabsEnabled
    ? insets.bottom + FLOATING_TABS.bottom + FLOATING_TABS.edge + fabSize
    : 16;
  const context = { ...workspace, bottomClearance };
  const openNewBot = useOpenNewBot();
  if (enabled.length === 0) return <WorkspaceNoTabs />;
  return (
    <WorkspaceAppBarScope>
      <WorkspaceTabPanes
        tabs={NAVIGATION_TAB_ORDER}
        selected={workspace.state.selectedTab}
        renderTab={(tab) =>
          tab === "threads" ? (
            <AndroidHomeFabLayout sidebar disabled={coveredByPage} onStartNewTask={startNewTask}>
              <WorkspaceThreadSidebar />
            </AndroidHomeFabLayout>
          ) : tab === "bots" ? (
            <WorkspaceTabsContext value={context}>
              <View className="flex-1 bg-header">
                <AppBar
                  embedded
                  title="Bots"
                  actions={[{ accessibilityLabel: "New bot", icon: "plus", onPress: openNewBot }]}
                />
                <ScreenContent insetHorizontal>
                  <BotsScreen sidebar />
                </ScreenContent>
              </View>
            </WorkspaceTabsContext>
          ) : tab === "issues" ? (
            <WorkspaceTabsContext value={context}>
              <IssuesScreen
                sidebar
                selectedIssueKey={selectedIssue}
                renderFrame={(filters, list) => (
                  <View className="flex-1 bg-header">
                    <ListSearchToolbar
                      tab="issues"
                      filters={filters}
                      onRequestVisibility={revealPrimarySidebar}
                    />
                    <ScreenContent insetHorizontal>{list}</ScreenContent>
                  </View>
                )}
              />
            </WorkspaceTabsContext>
          ) : (
            <WorkspaceTabsContext value={context}>
              <PullRequestsScreen
                sidebar
                selectedPullRequestKey={selectedPullRequest}
                renderFrame={(filters, list) => (
                  <View className="flex-1 bg-header">
                    <ListSearchToolbar
                      tab="pullRequests"
                      filters={filters}
                      onRequestVisibility={revealPrimarySidebar}
                    />
                    <ScreenContent insetHorizontal>{list}</ScreenContent>
                  </View>
                )}
              />
            </WorkspaceTabsContext>
          )
        }
      />
    </WorkspaceAppBarScope>
  );
}
