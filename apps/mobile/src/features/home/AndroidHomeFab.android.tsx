import { useRef, useState, type ComponentProps } from "react";
import {
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScrollComposeButton } from "../../components/ScrollComposeButton.android";
import {
  androidHomeFabPosition,
  type AndroidHomeFabLayout as SharedAndroidHomeFabLayout,
} from "./AndroidHomeFab.shared";
import { useWorkspaceState } from "../../state/workspace";
import { FabScrollContext } from "./FabScrollContext";
import { updateFabScroll } from "./fab-scroll";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { WorkspaceTabsContext, useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { FLOATING_TABS, floatingTabsMetrics } from "../layout/workspace/floating-workspace-tabs";
import { useEnabledNavigationTabs } from "../layout/workspace/navigation-tabs";
import {
  useAppearancePreferences,
  useAndroidFloatingTabs,
} from "../settings/appearance/AppearancePreferencesProvider";

export function AndroidHomeFabLayout(props: ComponentProps<typeof SharedAndroidHomeFabLayout>) {
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const insets = useSafeAreaInsets();
  const { appearance } = useAppearancePreferences();
  const { fontScale } = useWindowDimensions();
  const [layoutWidth, setLayoutWidth] = useState<number | null>(null);
  const { state } = useWorkspaceState();
  const [expanded, setExpanded] = useState(true);
  const { scale, fabSize } = useAndroidControlSizing();
  const enabledTabs = useEnabledNavigationTabs();
  const barWidth =
    layoutWidth === null
      ? undefined
      : layoutWidth - (Math.max(insets.left, FLOATING_TABS.edge) - FLOATING_TABS.edge);
  const size = floatingTabsEnabled
    ? floatingTabsMetrics(enabledTabs.length + 1, scale, fabSize, barWidth).height
    : fabSize;
  const workspace = useWorkspaceTabs();
  const bottomClearance = insets.bottom + FLOATING_TABS.bottom + FLOATING_TABS.edge + size;
  const context = floatingTabsEnabled && workspace ? { ...workspace, bottomClearance } : workspace;
  const scrollState = useRef({ anchor: 0, expanded: true });
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const next = updateFabScroll(
      scrollState.current,
      contentOffset.y,
      contentSize.height - layoutMeasurement.height,
    );
    if (next.expanded !== scrollState.current.expanded) setExpanded(next.expanded);
    scrollState.current = next;
  };

  // Remount only the FAB when its font or pane changes to clear the cached expanded width.
  // Floating navigation shares this row; Material split views put New thread in the rail.
  return (
    <View className="flex-1" onLayout={(event) => setLayoutWidth(event.nativeEvent.layout.width)}>
      <WorkspaceTabsContext value={context}>
        <FabScrollContext value={onScroll}>{props.children}</FabScrollContext>
      </WorkspaceTabsContext>
      {!props.disabled &&
      (floatingTabsEnabled || workspace === null) &&
      (!props.sidebar || floatingTabsEnabled) &&
      state.hasConnections &&
      layoutWidth !== null ? (
        <ScrollComposeButton
          key={`${appearance.baseFontSize}:${fontScale}:${layoutWidth}`}
          size={size}
          expanded={floatingTabsEnabled ? false : expanded}
          onPress={props.onStartNewTask}
          className="absolute"
          style={
            floatingTabsEnabled
              ? {
                  right: FLOATING_TABS.edge,
                  bottom: insets.bottom + FLOATING_TABS.bottom,
                }
              : androidHomeFabPosition(insets.bottom, props.sidebar)
          }
        />
      ) : null}
    </View>
  );
}
