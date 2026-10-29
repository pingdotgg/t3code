import { useAndroidFloatingTabs } from "../settings/appearance/AppearancePreferencesProvider";
import { WorkspaceNoTabs } from "./WorkspaceNoTabs";
import { useEnabledNavigationTabs } from "./navigation-tabs";
import { NAVIGATION_TAB_ORDER } from "./navigation-tab-order";
import { useNavigationState } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { FLOATING_TABS, floatingTabsMetrics } from "./floating-workspace-tabs";
import { View } from "react-native";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";
import { PullRequestToolbar } from "../pull-requests/PullRequestToolbar.android";
import { selectedPullRequestKey } from "../pull-requests/pullRequestSelection";
import { AndroidHomeFabLayout } from "../home/AndroidHomeFab";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import { useAndroidWorkspaceRoot } from "./AndroidWorkspaceTabsProvider";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceTabPanes } from "./WorkspaceTabPanes";
import { WorkspaceThreadSidebar } from "./WorkspaceThreadSidebar";
import { WorkspaceAppBarScope } from "../../components/ui/WorkspaceAppBar.android";

/** The Home route in the sidebar column: the selected tab's list. */
export function AndroidWorkspaceSidebar() {
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const workspace = useWorkspaceTabs()!;
  const enabled = useEnabledNavigationTabs();
  const insets = useSafeAreaInsets();
  const { scale, fabSize } = useAndroidControlSizing();
  const { layout, revealPrimarySidebar, startNewTask } = useAdaptiveWorkspaceLayout();
  const selectedPullRequest = useNavigationState(selectedPullRequestKey);
  // Settings and Usage cover the sidebar.
  const coveredByPage =
    (useAndroidWorkspaceRoot()?.settingsOpen ?? false) || workspace.state.selectedTab === "usage";
  const floating = floatingTabsMetrics(enabled.length + 1, scale, fabSize);
  const bottomClearance = floatingTabsEnabled
    ? insets.bottom + FLOATING_TABS.bottom + FLOATING_TABS.edge + floating.height
    : 16;
  const context = { ...workspace, bottomClearance };
  if (enabled.length === 0) return <WorkspaceNoTabs />;
  return (
    <WorkspaceAppBarScope>
      <WorkspaceTabPanes
        tabs={NAVIGATION_TAB_ORDER}
        selected={workspace.state.selectedTab}
        renderTab={(tab) =>
          tab === "threads" ? (
            <AndroidHomeFabLayout
              sidebar
              disabled={coveredByPage}
              paneWidth={layout.listPaneWidth ?? undefined}
              onStartNewTask={startNewTask}
            >
              <WorkspaceThreadSidebar />
            </AndroidHomeFabLayout>
          ) : tab !== "pullRequests" ? (
            <View className="flex-1 bg-screen" />
          ) : (
            <WorkspaceTabsContext value={context}>
              <PullRequestsScreen
                sidebar
                selectedPullRequestKey={selectedPullRequest}
                renderFrame={(filters, list) => (
                  <View className="flex-1 bg-header">
                    <PullRequestToolbar
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
