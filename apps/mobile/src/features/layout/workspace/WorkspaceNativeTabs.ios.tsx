import { useGT, useMessages } from "gt-react-native";
import {
  WORKSPACE_TAB_LABELS,
  NAVIGATION_TAB_ICONS,
  useEnabledNavigationTabs,
} from "./navigation-tabs";
import {
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { View, type NativeSyntheticEvent } from "react-native";
import { Tabs, type TabSelectedEvent, type TabSelectionRejectedEvent } from "react-native-screens";

import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { NavigationTab } from "./navigation-tab-order";
import {
  NATIVE_WORKSPACE_TAB_SLOTS,
  workspaceTabForNativeSlot,
  workspaceUsesColumns,
} from "./workspace-tabs-state";
import {
  NativeWorkspaceTabActivityContext,
  NativeWorkspaceModeContext,
  WorkspaceColumnMetricsContext,
  WorkspaceSlotOptionsContext,
} from "../../../native/v5-workspace-context";
import type { NativeLayoutMetrics } from "../../../lib/reserved-regions";
import { useCompactWorkspaceTabs, useSystemWorkspaceTabBar } from "./useSystemWorkspaceTabBar";
import { useControlTheme } from "../../../components/ui/useControlTheme";
import { useDeviceType } from "../../../native/native-layout-metrics";
import { WorkspaceTabDock } from "./WorkspaceTabDock";
import { useAdaptiveWorkspaceLayout, useWorkspacePaneState } from "../AdaptiveWorkspaceLayout";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";

const PULL_REQUEST_ICON = require("../../../../assets/icons/pull-request.png");
const ISSUE_ICON = require("../../../../assets/icons/issue.png");

/** Retain each native controller tree; removing its root can leave RNS's stack empty. */
function RetainedWorkspaceTab(props: {
  readonly slot: string;
  readonly tab: NavigationTab;
  readonly active: boolean;
  /** Render a slot that hasn't been shown yet: its header, and the page it opens with. */
  readonly prewarm: boolean;
  readonly setMountedSlots: Dispatch<SetStateAction<ReadonlySet<string>>>;
  readonly setPrewarmRequests: Dispatch<SetStateAction<ReadonlyMap<string, number>>>;
  readonly children: (workspace: SlotWorkspace, headerOnly: boolean) => ReactNode;
}) {
  const workspace = useWorkspaceTabs()!;
  // Whether this slot is the visible one, read by cleanups after the switch has committed.
  const activeRef = useRef(props.active);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed active flag to a ref that header cleanups read after the tab switch commits
  useLayoutEffect(() => {
    activeRef.current = props.active;
  }, [props.active]);
  const isActive = () => activeRef.current;
  const [content, setContent] = useState(
    props.active
      ? { source: workspace, workspace, children: props.children, headerOnly: false }
      : null,
  );
  const stale = content?.source !== workspace || content?.children !== props.children;
  if (props.active && (content?.headerOnly !== false || stale))
    setContent({ source: workspace, workspace, children: props.children, headerOnly: false });
  // A slot not shown yet follows the workspace, so the page it opens with stays current.
  else if (!props.active && props.prewarm && (content === null || (content.headerOnly && stale)))
    setContent({
      source: workspace,
      workspace: {
        ...workspace,
        settingsOpen: props.slot === "settings",
        state: { ...workspace.state, selectedTab: props.tab },
      },
      children: props.children,
      headerOnly: true,
    });
  const activity = {
    active: props.active,
    isActive,
    headerOnly: content?.headerOnly === true,
  };
  const [optionsByRoute, setOptionsByRoute] = useState<ReadonlyMap<string, object>>(new Map());
  // Stable, so writers and the cleanups that depend on them don't re-run on every write.
  const setRouteOptions = (routeKey: string, options: object) =>
    setOptionsByRoute((current) =>
      new Map(current).set(routeKey, { ...current.get(routeKey), ...options }),
    );
  const slotOptions = { byRoute: optionsByRoute, set: setRouteOptions };
  const mounted = content !== null && !content.headerOnly;
  const headerOnly = content?.headerOnly === true;
  const { slot, setMountedSlots, setPrewarmRequests } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports the slot's mount to the host, which uncovers the tab then
  useEffect(() => {
    if (!mounted) return;
    // Each header write commits in the render after it; the slot is ready once a frame passes
    // without one, which is when its native header and content are in place.
    const frame = requestAnimationFrame(() =>
      setMountedSlots((current) => (current.has(slot) ? current : new Set(current).add(slot))),
    );
    return () => cancelAnimationFrame(frame);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each header write re-arms the frame
  }, [mounted, optionsByRoute, slot, setMountedSlots]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a replacement slot (e.g. a re-enabled fourth tab) must report its own mount
  useEffect(
    () => () =>
      setMountedSlots((current) => {
        if (!current.has(slot)) return current;
        const next = new Set(current);
        next.delete(slot);
        return next;
      }),
    [slot, setMountedSlots],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks UIKit to prewarm a hidden header after each write, since bar items it rebuilds fade in on their own first entry
  useEffect(() => {
    if (!headerOnly || optionsByRoute.size === 0) return;
    const frame = requestAnimationFrame(() =>
      setPrewarmRequests((current) => new Map(current).set(slot, (current.get(slot) ?? 0) + 1)),
    );
    return () => cancelAnimationFrame(frame);
  }, [headerOnly, optionsByRoute, slot, setPrewarmRequests]);
  return content ? (
    <NativeWorkspaceTabActivityContext value={activity}>
      <WorkspaceSlotOptionsContext value={slotOptions}>
        <WorkspaceTabsContext value={content.workspace}>
          {content.children(content.workspace, content.headerOnly)}
        </WorkspaceTabsContext>
      </WorkspaceSlotOptionsContext>
    </NativeWorkspaceTabActivityContext>
  ) : null;
}

type SlotWorkspace = NonNullable<ReturnType<typeof useWorkspaceTabs>>;

export function WorkspaceNativeTabs(props: {
  /** Renders a slot's tree for its own tab, which can lay out differently from the shown one. */
  readonly children: (workspace: SlotWorkspace, headerOnly: boolean) => ReactNode;
  readonly hidden: boolean;
  /** The sidebar column draws the tabs itself, so they leave with it. */
  readonly tabsInSidebarColumn?: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const workspace = useWorkspaceTabs()!;
  const order = useEnabledNavigationTabs();
  const primaryTabs = order.slice(0, 4);
  const overflow = order[4];
  const selectTab = useSelectWorkspaceTab();
  const [provenance, setProvenance] = useState(0);
  const systemTabBar = useSystemWorkspaceTabBar();
  const nativeColumns = use(NativeWorkspaceModeContext);
  const deviceType = useDeviceType();
  const compactTabs = useCompactWorkspaceTabs();
  const { layout } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  // The tabs belong to the sidebar; over a page with the sidebar hidden they'd cover the composer.
  const hiddenWithSidebar =
    deviceType === "pad" &&
    layout.usesSplitView &&
    workspaceUsesColumns(
      workspace.state.selectedTab,
      workspace.settingsOpen,
      nativeColumns,
      layout.usesSplitView,
    ) &&
    !panes.primarySidebarVisible;
  const { colors } = useControlTheme();
  const selectedTab = workspace.state.selectedTab;
  const selectedSlot = workspace.settingsOpen ? -1 : primaryTabs.indexOf(selectedTab);
  const selectedScreenKey =
    selectedSlot === -1 ? "settings" : NATIVE_WORKSPACE_TAB_SLOTS[selectedSlot]!;
  // A slot renders its body the first time it's selected. Until it has, UIKit keeps the last
  // tab's snapshot over it, so the switch never shows a half-built tab.
  const [mountedSlots, setMountedSlots] = useState<ReadonlySet<string>>(() => new Set());
  // Once the first tab is up, the others mount their headers for UIKit to put in the window
  // once: iOS 26 fades bar items in the first time they enter it, which a first visit would show.
  const [prewarm, setPrewarm] = useState(false);
  const [columnMetrics, setColumnMetrics] = useState<ReadonlyMap<string, NativeLayoutMetrics>>(
    () => new Map(),
  );
  const sharedColumnMetrics = {
    byColumn: columnMetrics,
    publish: (column: string, metrics: NativeLayoutMetrics) =>
      setColumnMetrics((current) =>
        JSON.stringify(current.get(column)) === JSON.stringify(metrics)
          ? current
          : new Map(current).set(column, metrics),
      ),
  };
  const [prewarmRequests, setPrewarmRequests] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const prewarmReady = mountedSlots.size > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- waits for the JS thread to go idle after the first tab mounts
  useEffect(() => {
    if (!prewarmReady || prewarm) return;
    const handle = requestIdleCallback(() => setPrewarm(true), { timeout: 2_000 });
    return () => cancelIdleCallback(handle);
  }, [prewarmReady, prewarm]);
  const request = { selectedScreenKey, baseProvenance: provenance };
  return (
    <View style={{ flex: 1 }}>
      <WorkspaceColumnMetricsContext value={sharedColumnMetrics}>
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
                title=""
                tabBarItemAccessibilityLabel={
                  settings ? gt("Settings") : m(WORKSPACE_TAB_LABELS[tab])
                }
                ios={{
                  prewarmRequest: prewarmRequests.get(slot) ?? 0,
                  contentReady: mountedSlots.has(slot),
                  icon: settings
                    ? { type: "sfSymbol", name: "gearshape" }
                    : tab === "pullRequests"
                      ? { type: "templateSource", templateSource: PULL_REQUEST_ICON }
                      : tab === "issues"
                        ? { type: "templateSource", templateSource: ISSUE_ICON }
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
                  tab={tab}
                  prewarm={prewarm}
                  setMountedSlots={setMountedSlots}
                  setPrewarmRequests={setPrewarmRequests}
                  active={settings ? selectedSlot === -1 : selectedSlot === index}
                >
                  {props.children}
                </RetainedWorkspaceTab>
              </Tabs.Screen>
            );
          })}
        </Tabs.Host>
      </WorkspaceColumnMetricsContext>
      {(deviceType === "pad" ||
        compactTabs ||
        (layout.variant === "medium" &&
          !workspaceUsesColumns(
            selectedTab,
            workspace.settingsOpen,
            nativeColumns,
            layout.usesSplitView,
          ))) &&
      !props.hidden &&
      !props.tabsInSidebarColumn &&
      // The legacy iPad sidebar now owns the tabs so they hide with it.
      //
      // 旧版 iPad 的标签栏由侧栏承载，从而与侧栏一起隐藏。
      !(deviceType === "pad" && !nativeColumns && layout.usesSplitView) &&
      !hiddenWithSidebar ? (
        <WorkspaceTabDock placement="window" />
      ) : null}
    </View>
  );
}
