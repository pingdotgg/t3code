import { useAndroidFloatingTabs } from "../settings/appearance/AppearancePreferencesProvider";
import { WorkspaceNoTabs } from "./WorkspaceNoTabs";
import { useEnabledNavigationTabs } from "./navigation-tabs";
import { NAVIGATION_TAB_ORDER } from "./navigation-tab-order";
import { type ReactNode } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { FLOATING_TABS, floatingTabsMetrics } from "./floating-workspace-tabs";
import { View } from "react-native";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";
import { PullRequestToolbar } from "../pull-requests/PullRequestToolbar.android";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceTabPanes } from "./WorkspaceTabPanes";

export function AndroidWorkspaceSidebar(props: {
  readonly children: ReactNode;
  readonly onRequestVisibility: () => void;
  readonly selectedPullRequestKey: string | null;
}) {
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const workspace = useWorkspaceTabs()!;
  const enabled = useEnabledNavigationTabs();
  const insets = useSafeAreaInsets();
  const { scale, fabSize } = useAndroidControlSizing();
  const floating = floatingTabsMetrics(enabled.length + 1, scale, fabSize);
  const bottomClearance = floatingTabsEnabled
    ? insets.bottom + FLOATING_TABS.bottom + FLOATING_TABS.edge + floating.height
    : 16;
  const context = { ...workspace, bottomClearance };
  if (enabled.length === 0) return <WorkspaceNoTabs />;
  return (
    <WorkspaceTabPanes
      tabs={NAVIGATION_TAB_ORDER}
      selected={workspace.state.selectedTab}
      renderTab={(tab) =>
        tab === "threads" ? (
          props.children
        ) : tab !== "pullRequests" ? (
          <View className="flex-1 bg-screen" />
        ) : (
          <WorkspaceTabsContext value={context}>
            <PullRequestsScreen
              sidebar
              selectedPullRequestKey={props.selectedPullRequestKey}
              renderFrame={(filters, list) => (
                <View className="flex-1 bg-header">
                  <PullRequestToolbar
                    filters={filters}
                    onRequestVisibility={props.onRequestVisibility}
                  />
                  <ScreenContent insetHorizontal>{list}</ScreenContent>
                </View>
              )}
            />
          </WorkspaceTabsContext>
        )
      }
    />
  );
}
