import { useAndroidFloatingTabs } from "../../settings/appearance/AppearancePreferencesProvider";
import { WorkspaceNoTabs } from "./WorkspaceNoTabs";
import { useEnabledNavigationTabs } from "./navigation-tabs";
import { NAVIGATION_TAB_ORDER } from "./navigation-tab-order";
import { View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { AppBar } from "../../../components/ui/AppBar";
import { EmptyState } from "../../../components/ui/EmptyState";
import { WorkspaceEmptyDetail } from "../WorkspaceEmptyDetail";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { useAndroidControlSizing } from "../../../components/ui/useAndroidControlSizing";
import { HomeRouteScreen } from "../../home/HomeRouteScreen";
import { BotsScreen, useOpenNewBot } from "../../bots/BotsScreen";
import { PullRequestsScreen } from "../../pull-requests/PullRequestsScreen";
import { ListSearchToolbar } from "./ListSearchToolbar.android";
import { IssuesScreen } from "../../issues/IssuesScreen";
import { useAdaptiveWorkspaceLayout } from "../AdaptiveWorkspaceLayout";
import { AndroidWorkspaceNavigation, FloatingWorkspaceTabs } from "./AndroidWorkspaceNavigation";
import { FLOATING_TABS } from "./floating-workspace-tabs";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceTabPanes } from "./WorkspaceTabPanes";
import { WorkspaceAppBarScope } from "../../../components/ui/WorkspaceAppBar.android";
import { usePaneRole } from "../../../components/ui/Pane";
import { AndroidWorkspaceSidebar } from "./AndroidWorkspaceSidebar.android";
import type { WorkspaceTab } from "./workspace-tabs-state";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";
import { useHardwareBack } from "../../../lib/backHandler";

const TABS: readonly WorkspaceTab[] = NAVIGATION_TAB_ORDER;

export function WorkspaceRootScreen() {
  return usePaneRole() === "sidebar" ? <AndroidWorkspaceSidebar /> : <WorkspaceRoot />;
}

function WorkspaceRoot() {
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const { layout, startNewTask } = useAdaptiveWorkspaceLayout();
  const workspace = useWorkspaceTabs()!;
  const enabled = useEnabledNavigationTabs();
  const insets = useSafeAreaInsets();
  const { fabClearance, fabSize } = useAndroidControlSizing();
  const context = {
    ...workspace,
    bottomClearance: layout.usesSplitView
      ? workspace.bottomClearance
      : floatingTabsEnabled
        ? insets.bottom + FLOATING_TABS.bottom + FLOATING_TABS.edge + fabSize
        : workspace.state.selectedTab === "threads"
          ? fabClearance + 16
          : 16,
  };
  const tab = workspace.state.selectedTab;
  const openNewBot = useOpenNewBot();
  const selectTab = useSelectWorkspaceTab();
  // Tabs are panes of Home, not routes, so Back has nothing to pop and would leave the app.
  // An open search keeps Back for itself.
  useHardwareBack(
    tab !== "threads" &&
      enabled.includes("threads") &&
      workspace.state.tabs[tab].searchMode === "resting",
    () => {
      selectTab("threads");
      return true;
    },
  );

  return (
    <WorkspaceTabsContext value={context}>
      <View className={layout.usesSplitView ? "flex-1 bg-screen" : "flex-1 bg-header"}>
        {!layout.usesSplitView ? (
          <NativeStackScreenOptions options={{ headerShown: false }} />
        ) : null}
        <SafeAreaInsetsContext
          value={
            layout.usesSplitView ? insets : floatingTabsEnabled ? insets : { ...insets, bottom: 0 }
          }
        >
          {enabled.length === 0 ? (
            layout.usesSplitView ? (
              <View className="flex-1 bg-screen" />
            ) : (
              <WorkspaceNoTabs />
            )
          ) : (
            <WorkspaceAppBarScope enabled={!layout.usesSplitView}>
              <WorkspaceTabPanes
                tabs={TABS}
                selected={tab}
                renderTab={(tab) =>
                  tab === "threads" ? (
                    <HomeRouteScreen />
                  ) : tab === "bots" ? (
                    layout.usesSplitView ? (
                      <>
                        <NativeStackScreenOptions options={{ headerShown: false }} />
                        <AppBar embedded title="Bots" />
                        <View className="flex-1 items-center justify-center px-10">
                          <EmptyState
                            title="Select a bot"
                            detail="Choose a bot from the sidebar."
                            variant="plain"
                          />
                        </View>
                      </>
                    ) : (
                      <>
                        <AppBar
                          embedded
                          title="Bots"
                          actions={[
                            { accessibilityLabel: "New bot", icon: "plus", onPress: openNewBot },
                          ]}
                        />
                        <ScreenContent>
                          <BotsScreen />
                        </ScreenContent>
                      </>
                    )
                  ) : layout.usesSplitView ? (
                    <>
                      <NativeStackScreenOptions options={{ headerShown: false }} />
                      <AppBar embedded title={tab === "issues" ? "Issues" : "Pull requests"} />
                      <WorkspaceEmptyDetail tab={tab} />
                    </>
                  ) : tab === "issues" ? (
                    <IssuesScreen
                      renderFrame={(filters, list) => (
                        <>
                          <ListSearchToolbar tab="issues" filters={filters} />
                          <ScreenContent>{list}</ScreenContent>
                        </>
                      )}
                    />
                  ) : (
                    <PullRequestsScreen
                      renderFrame={(filters, list) => (
                        <>
                          <ListSearchToolbar tab="pullRequests" filters={filters} />
                          <ScreenContent>{list}</ScreenContent>
                        </>
                      )}
                    />
                  )
                }
              />
            </WorkspaceAppBarScope>
          )}
        </SafeAreaInsetsContext>
        {layout.usesSplitView ? null : floatingTabsEnabled ? (
          <FloatingWorkspaceTabs fillWidth onNewThread={startNewTask} />
        ) : (
          <AndroidWorkspaceNavigation onNewThread={startNewTask} />
        )}
      </View>
    </WorkspaceTabsContext>
  );
}
