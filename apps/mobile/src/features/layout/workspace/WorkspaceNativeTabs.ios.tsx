import {
  WORKSPACE_TAB_LABELS,
  NAVIGATION_TAB_ICONS,
  useEnabledNavigationTabs,
} from "./navigation-tabs";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { View, useWindowDimensions, type NativeSyntheticEvent } from "react-native";
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
} from "./workspace-tabs-state";
import {
  NativeWorkspaceTabActivityContext,
  WorkspaceSlotOptionsContext,
} from "../../../native/v5-workspace-context";
import {
  useCompactWorkspaceTabs,
  useFloatingWorkspaceTabs,
  useSystemWorkspaceTabBar,
} from "./useSystemWorkspaceTabBar";
import { useControlTheme } from "../../../components/ui/useControlTheme";
import { useDeviceType } from "../../../native/native-layout-metrics";
import { WorkspaceSidebarTabs } from "./WorkspaceSidebarTabs";
import { useAdaptiveWorkspaceLayout, useWorkspacePaneState } from "../AdaptiveWorkspaceLayout";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";

const PULL_REQUEST_ICON = require("../../../../assets/icons/pull-request.png");

/** Retain each native controller tree; removing its root can leave RNS's stack empty. */
function RetainedWorkspaceTab(props: {
  readonly slot: string;
  readonly active: boolean;
  readonly setMountedSlots: Dispatch<SetStateAction<ReadonlySet<string>>>;
  readonly children: ReactNode;
}) {
  const workspace = useWorkspaceTabs()!;
  // Whether this slot is the visible one, read by cleanups after the switch has committed.
  const activeRef = useRef(props.active);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed active flag to a ref that header cleanups read after the tab switch commits
  useLayoutEffect(() => {
    activeRef.current = props.active;
  }, [props.active]);
  const isActive = () => activeRef.current;
  const activity = {
    active: props.active,
    isActive,
  };
  const [optionsByRoute, setOptionsByRoute] = useState<ReadonlyMap<string, object>>(new Map());
  // Stable, so writers and the cleanups that depend on them don't re-run on every write.
  const setRouteOptions = (routeKey: string, options: object) =>
    setOptionsByRoute((current) =>
      new Map(current).set(routeKey, { ...current.get(routeKey), ...options }),
    );
  const slotOptions = { byRoute: optionsByRoute, set: setRouteOptions };
  const [content, setContent] = useState(
    props.active ? { workspace, children: props.children } : null,
  );
  if (props.active && (content?.workspace !== workspace || content?.children !== props.children))
    setContent({ workspace, children: props.children });
  const mounted = content !== null;
  const { slot, setMountedSlots } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports the slot's first native mount to the host, which holds the switch until then
  useEffect(() => {
    if (!mounted) return;
    // The header options this mount wrote reach UIKit in the commit after it.
    const frame = requestAnimationFrame(() =>
      setMountedSlots((current) => (current.has(slot) ? current : new Set(current).add(slot))),
    );
    return () => {
      cancelAnimationFrame(frame);
      // A replacement slot (e.g. a re-enabled fourth tab) must report its own mount.
      setMountedSlots((current) => {
        if (!current.has(slot)) return current;
        const next = new Set(current);
        next.delete(slot);
        return next;
      });
    };
  }, [mounted, slot, setMountedSlots]);
  return content ? (
    <NativeWorkspaceTabActivityContext value={activity}>
      <WorkspaceSlotOptionsContext value={slotOptions}>
        <WorkspaceTabsContext value={content.workspace}>{content.children}</WorkspaceTabsContext>
      </WorkspaceSlotOptionsContext>
    </NativeWorkspaceTabActivityContext>
  ) : null;
}

export function WorkspaceNativeTabs(props: {
  readonly children: ReactNode;
  readonly hidden: boolean;
  /** The sidebar column draws the tabs itself, so they leave with it. */
  readonly tabsInSidebarColumn?: boolean;
}) {
  const workspace = useWorkspaceTabs()!;
  const order = useEnabledNavigationTabs();
  const primaryTabs = order.slice(0, 4);
  const overflow = order[4];
  const selectTab = useSelectWorkspaceTab();
  const [provenance, setProvenance] = useState(0);
  const systemTabBar = useSystemWorkspaceTabBar();
  const deviceType = useDeviceType();
  const compactTabs = useCompactWorkspaceTabs();
  const { layout } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  // The tabs belong to the sidebar; over a page with the sidebar hidden they'd cover the composer.
  const hiddenWithSidebar =
    deviceType === "pad" &&
    layout.usesSplitView &&
    workspaceUsesColumns(workspace.state.selectedTab, workspace.settingsOpen) &&
    !panes.primarySidebarVisible;
  const floatingTabs = useFloatingWorkspaceTabs();
  const { width } = useWindowDimensions();
  const { colors } = useControlTheme();
  const selectedTab = workspace.state.selectedTab;
  const selectedSlot = workspace.settingsOpen ? -1 : primaryTabs.indexOf(selectedTab);
  const selectedScreenKey =
    selectedSlot === -1 ? "settings" : NATIVE_WORKSPACE_TAB_SLOTS[selectedSlot]!;
  // A slot mounts its content the first time it's selected. Showing it in that same commit
  // shows a blank controller, then its header animates in, so the switch waits for the mount.
  const [mountedSlots, setMountedSlots] = useState<ReadonlySet<string>>(() => new Set());
  const [shownScreenKey, setShownScreenKey] = useState(selectedScreenKey);
  if (shownScreenKey !== selectedScreenKey && mountedSlots.has(selectedScreenKey))
    setShownScreenKey(selectedScreenKey);
  const request = { selectedScreenKey: shownScreenKey, baseProvenance: provenance };
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
        onTabSelectionRejected={({
          nativeEvent,
        }: NativeSyntheticEvent<TabSelectionRejectedEvent>) =>
          setProvenance(nativeEvent.provenance)
        }
        onTabSelectionPrevented={({
          nativeEvent,
        }: NativeSyntheticEvent<TabSelectionPreventedEvent>) => {
          const tab = workspaceTabForNativeSlot(primaryTabs, nativeEvent.preventedScreenKey);
          if (tab) selectTab(tab);
        }}
        onTabSelected={({ nativeEvent }: NativeSyntheticEvent<TabSelectedEvent>) => {
          setProvenance(nativeEvent.provenance);
          if (nativeEvent.actionOrigin === "programmatic-js") return;
          const tab = workspaceTabForNativeSlot(primaryTabs, nativeEvent.selectedScreenKey);
          if (tab) selectTab(tab);
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
              // Taps on an unmounted slot select it from JS, which shows it once it has mounted.
              preventNativeSelection={!mountedSlots.has(slot) && slot !== shownScreenKey}
              title=""
              tabBarItemAccessibilityLabel={settings ? "Settings" : WORKSPACE_TAB_LABELS[tab]}
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
                slot={slot}
                setMountedSlots={setMountedSlots}
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
        (layout.variant === "medium" &&
          !workspaceUsesColumns(selectedTab, workspace.settingsOpen))) &&
      !props.hidden &&
      !props.tabsInSidebarColumn &&
      !hiddenWithSidebar ? (
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            left: 0,
            bottom: 0,
            // UIKit can shrink the sidebar to 280pt independently of its preferred width.
            width:
              deviceType === "pad" && (floatingTabs || layout.usesSplitView)
                ? Math.min(280, layout.listPaneWidth ?? width, width)
                : (layout.listPaneWidth ?? width),
            height: 128,
          }}
        >
          <WorkspaceSidebarTabsFooter />
        </View>
      ) : null}
    </View>
  );
}

/** The workspace tabs at the foot of the sidebar. */
export function WorkspaceSidebarTabsFooter() {
  const workspace = useWorkspaceTabs()!;
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  const compact = useFloatingWorkspaceTabs();
  return (
    <WorkspaceSidebarTabs
      compact={compact}
      reserveComposeSpace={compact}
      onNewTask={
        compact && !workspace.settingsOpen && workspace.state.selectedTab === "threads"
          ? startNewTask
          : undefined
      }
    />
  );
}
