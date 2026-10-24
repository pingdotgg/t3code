import { useNavigation } from "@react-navigation/native";
import {
  WORKSPACE_TAB_LABELS,
  NAVIGATION_TAB_ICONS,
  useEnabledNavigationTabs,
} from "./navigation-tabs";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Keyboard, View, useWindowDimensions, type NativeSyntheticEvent } from "react-native";
import {
  Tabs,
  type TabSelectedEvent,
  type TabSelectionPreventedEvent,
  type TabSelectionRejectedEvent,
} from "react-native-screens";

import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import {
  NATIVE_WORKSPACE_TAB_SLOTS,
  workspaceTabForNativeSlot,
  workspaceUsesColumns,
  type WorkspaceTab,
} from "./workspace-tabs-state";
import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";
import { useCompactWorkspaceTabs, useSystemWorkspaceTabBar } from "./useSystemWorkspaceTabBar";
import { useControlTheme } from "../../components/ui/useControlTheme";
import { useDeviceType } from "../../native/native-layout-metrics";
import { WorkspaceSidebarTabs } from "./WorkspaceSidebarTabs";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

const PULL_REQUEST_ICON = require("../../../assets/icons/pull-request.png");

/** Retain each native controller tree; removing its root can leave RNS's stack empty. */
function RetainedWorkspaceTab(props: {
  readonly tab: WorkspaceTab;
  readonly active: boolean;
  readonly children: ReactNode;
}) {
  const workspace = useWorkspaceTabs()!;
  const { isTabActive } = workspace;
  const isActive = useCallback(() => isTabActive(props.tab), [isTabActive, props.tab]);
  const activity = useMemo(
    () => ({
      active: props.active,
      isActive,
    }),
    [props.active, isActive],
  );
  const [content, setContent] = useState(
    props.active ? { workspace, children: props.children } : null,
  );
  if (props.active && (content?.workspace !== workspace || content?.children !== props.children))
    setContent({ workspace, children: props.children });
  return content ? (
    <NativeWorkspaceTabActivityContext value={activity}>
      <WorkspaceTabsContext value={content.workspace}>{content.children}</WorkspaceTabsContext>
    </NativeWorkspaceTabActivityContext>
  ) : null;
}

export function WorkspaceNativeTabs(props: {
  readonly children: ReactNode;
  readonly hidden: boolean;
  readonly onSelect: () => void;
}) {
  const workspace = useWorkspaceTabs()!;
  const order = useEnabledNavigationTabs();
  const primaryTabs = order.slice(0, 4);
  const overflow = order[4];
  const navigation = useNavigation();
  const [provenance, setProvenance] = useState(0);
  const systemTabBar = useSystemWorkspaceTabBar();
  const deviceType = useDeviceType();
  const compactTabs = useCompactWorkspaceTabs();
  const { layout, startNewTask } = useAdaptiveWorkspaceLayout();
  const compactSidebarTabs = deviceType === "phone" || !layout.usesSplitView;
  const { width } = useWindowDimensions();
  const { colors } = useControlTheme();
  const selectedTab = workspace.state.selectedTab;
  const selectedSlot = workspace.settingsOpen ? -1 : primaryTabs.indexOf(selectedTab);
  const request = useMemo(
    () => ({
      selectedScreenKey:
        selectedSlot === -1 ? "settings" : NATIVE_WORKSPACE_TAB_SLOTS[selectedSlot]!,
      baseProvenance: provenance,
    }),
    [selectedSlot, provenance],
  );
  return (
    <View style={{ flex: 1 }}>
      <Tabs.Host
        navStateRequest={request}
        tabBarHidden={props.hidden || !systemTabBar}
        ios={{
          tabBarControllerMode: "tabBar",
          tabBarMinimizeBehavior: "never",
          tabBarTintColor: colors["--color-primary"],
        }}
        onTabSelectionPrevented={({
          nativeEvent,
        }: NativeSyntheticEvent<TabSelectionPreventedEvent>) => {
          if (nativeEvent.preventedScreenKey === "settings") {
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            });
          }
        }}
        onTabSelectionRejected={({
          nativeEvent,
        }: NativeSyntheticEvent<TabSelectionRejectedEvent>) =>
          setProvenance(nativeEvent.provenance)
        }
        onTabSelected={({ nativeEvent }: NativeSyntheticEvent<TabSelectedEvent>) => {
          setProvenance(nativeEvent.provenance);
          if (nativeEvent.actionOrigin === "programmatic-js") return;
          const tab = workspaceTabForNativeSlot(primaryTabs, nativeEvent.selectedScreenKey);
          // UIKit sends reselects here even when preventNativeSelection is enabled.
          if (tab === "settings") {
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            });
            return;
          }
          if (!tab) return;
          Keyboard.dismiss();
          props.onSelect();
          workspace.dispatch({ type: "select", tab });
        }}
      >
        {NATIVE_WORKSPACE_TAB_SLOTS.map((slot, index) => {
          const settings = slot === "settings";
          const tab = settings ? (overflow ?? selectedTab) : primaryTabs[index];
          if (!tab) return null;
          return (
            <Tabs.Screen
              // Stable slot controllers keep UIKit's stacks attached when a section moves into Settings.
              key={slot}
              screenKey={slot}
              title=""
              tabBarItemAccessibilityLabel={settings ? "Settings" : WORKSPACE_TAB_LABELS[tab]}
              preventNativeSelection={settings}
              ios={{
                icon: settings
                  ? { type: "sfSymbol", name: "gearshape" }
                  : tab === "pullRequests"
                    ? { type: "templateSource", templateSource: PULL_REQUEST_ICON }
                    : { type: "sfSymbol", name: NAVIGATION_TAB_ICONS[tab] },
                selectedIcon:
                  !settings && tab === "threads"
                    ? { type: "sfSymbol", name: "text.bubble.fill" }
                    : undefined,
                overrideScrollViewContentInsetAdjustmentBehavior: false,
              }}
            >
              <RetainedWorkspaceTab
                tab={tab}
                active={settings ? selectedSlot === -1 : selectedSlot === index}
              >
                {props.children}
              </RetainedWorkspaceTab>
            </Tabs.Screen>
          );
        })}
      </Tabs.Host>
      {(deviceType === "pad" ||
        compactTabs ||
        (layout.primarySidebarOverlaysContent &&
          (workspace.settingsOpen || !workspaceUsesColumns(selectedTab)))) &&
      !props.hidden ? (
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            left: 0,
            bottom: 0,
            width: layout.listPaneWidth ?? width,
            height: 128,
          }}
        >
          <WorkspaceSidebarTabs
            compact={compactSidebarTabs}
            reserveComposeSpace={compactSidebarTabs}
            onNewTask={
              compactSidebarTabs && !workspace.settingsOpen && selectedTab === "threads"
                ? startNewTask
                : undefined
            }
          />
        </View>
      ) : null}
    </View>
  );
}
