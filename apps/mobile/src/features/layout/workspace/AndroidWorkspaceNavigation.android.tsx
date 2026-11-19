import { selectedNavigationTab, visibleNavigationTabs } from "./navigation-tab-order";
import { requireNativeView } from "expo";
import { CommonActions, useNavigation } from "@react-navigation/native";
import { selectThreadQuickAccess } from "@t3tools/client-runtime/state/thread-quick-access";
import {
  Keyboard,
  processColor,
  useWindowDimensions,
  View,
  type NativeSyntheticEvent,
  type ViewProps,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAndroidControlSizing } from "../../../components/ui/useAndroidControlSizing";
import { useToolbarLayout } from "../../../components/ui/useToolbarLayout";
import { rootNavigationRef } from "../../../lib/rootNavigation";
import { useWorkspaceConnectionState } from "../../../state/workspace";
import { useWorkspaceEnvironments } from "../../../state/workspace";
import { useVisibleThreadShells } from "../../../state/entities";
import { scopedThreadKey } from "../../../lib/scopedEntities";
import { androidWorkspaceNavigationColors } from "./android-workspace-navigation-colors";
import {
  androidWorkspaceTabNavigationState,
  type AndroidWorkspaceNavigationTab,
} from "./android-workspace-tabs";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import { useSoftKeyboardShowing } from "../../keyboard/useSoftKeyboardShowing";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { useAndroidWorkspaceRoot } from "./AndroidWorkspaceTabsProvider";
import { useSelectWorkspaceDetail } from "./useSelectWorkspaceDetail";
import { useNavigationTabOrder, useHiddenNavigationTabs } from "./navigation-tabs";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { FLOATING_TABS, floatingTabsMetrics } from "./floating-workspace-tabs";

// Matches RAIL_WIDTH in the native rail.
export const ANDROID_WORKSPACE_RAIL_WIDTH = 72;

interface NativeNavigationProps extends ViewProps {
  readonly rail: boolean;
  readonly floating: boolean;
  readonly tabs: readonly string[];
  readonly selectedTab: AndroidWorkspaceNavigationTab;
  readonly dark: boolean;
  readonly textScale: number;
  readonly newEnabled: boolean;
  readonly safeAreaTop: number;
  readonly safeAreaBottom: number;
  readonly headerHeight: number;
  readonly containerColor: number;
  readonly selectedColor: number;
  readonly indicatorColor: number;
  readonly unselectedColor: number;
  readonly actionColor: number;
  readonly actionContentColor: number;
  readonly environmentLabel: string;
  readonly environmentOnline: boolean;
  readonly quickThreadKeys: readonly string[];
  readonly quickThreadTitles: readonly string[];
  readonly quickThreadWorking: readonly boolean[];
  readonly selectedThreadKey: string;
  readonly onTabSelected: (
    event: NativeSyntheticEvent<{ readonly tab: AndroidWorkspaceNavigationTab }>,
  ) => void;
  readonly onNewThread: () => void;
  readonly onEnvironmentSelected: () => void;
  readonly onThreadSelected: (event: NativeSyntheticEvent<{ readonly key: string }>) => void;
  readonly onOverlayChange: (event: NativeSyntheticEvent<{ readonly overlay: boolean }>) => void;
}

const NativeNavigation = requireNativeView<NativeNavigationProps>("T3WorkspaceNavigation");

function nativeColor(value: string) {
  const color = processColor(value);
  return typeof color === "number" ? color : 0;
}

export function AndroidWorkspaceNavigation(props: {
  readonly onNewThread: () => void;
  readonly rail?: boolean;
  readonly floating?: boolean;
  readonly fillWidth?: boolean;
  readonly paneWidth?: number;
  readonly onSelect?: () => void;
  /** The rail needs the whole workspace while the original menu expands over the list. */
  readonly onOverlayChange?: (overlay: boolean) => void;
}) {
  const workspace = useWorkspaceTabs()!;
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  const root = useAndroidWorkspaceRoot();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const toolbar = useToolbarLayout();
  const connectionState = useWorkspaceConnectionState();
  const environments = useWorkspaceEnvironments();
  const quickThreads = selectThreadQuickAccess(useVisibleThreadShells());
  const selectDetail = useSelectWorkspaceDetail();
  const keyboardVisible = useSoftKeyboardShowing();
  const { layout } = useAdaptiveWorkspaceLayout();
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const { scale, fabSize } = useAndroidControlSizing();
  const window = useWindowDimensions();
  const rail = Boolean(props.rail);
  const floating = !rail && Boolean(props.floating);
  const tabs = [...visibleNavigationTabs(order, hidden, rail ? 5 : 4), "settings"];
  const selectedThread = quickThreads.find(({ thread }) =>
    rootNavigationRef
      .getRootState()
      ?.routes.some(
        (route) =>
          route.name === "Thread" &&
          (route.params as ReactNavigation.RootParamList["Thread"] | undefined)?.environmentId ===
            thread.environmentId &&
          (route.params as ReactNavigation.RootParamList["Thread"] | undefined)?.threadId ===
            thread.id,
      ),
  )?.thread;
  const currentEnvironmentId =
    selectedThread?.environmentId ?? quickThreads[0]?.thread.environmentId;
  const currentEnvironment =
    environments.find((environment) => environment.environmentId === currentEnvironmentId) ??
    environments[0];
  const { containerColor, indicatorColor, selectedColor, unselectedColor } =
    androidWorkspaceNavigationColors(colors, rail, floating);
  const selectedTab = selectedNavigationTab(
    order,
    workspace.state.selectedTab,
    root?.settingsOpen ?? false,
    hidden,
    rail ? 5 : 4,
  );
  // FloatingWorkspaceTabs starts the bar at the left inset, so a cutout narrows the room.
  const barWidth =
    (props.paneWidth ?? window.width) -
    (Math.max(insets.left, FLOATING_TABS.edge) - FLOATING_TABS.edge);
  const metrics = floatingTabsMetrics(tabs.length, scale, fabSize, barWidth, props.fillWidth);
  if (!rail && keyboardVisible) return null;

  return (
    <View
      style={
        // The rail draws its own surface and pads the system bars; while open it spans the
        // workspace, so the rest of it must stay transparent.
        rail
          ? { flex: 1 }
          : floating
            ? undefined
            : { backgroundColor: containerColor, paddingBottom: insets.bottom }
      }
    >
      <NativeNavigation
        rail={rail}
        floating={floating}
        tabs={tabs}
        selectedTab={selectedTab}
        dark={themeAppearance === "dark"}
        textScale={scale}
        newEnabled={connectionState.hasConnections}
        safeAreaTop={toolbar.paddingTop}
        safeAreaBottom={insets.bottom}
        headerHeight={toolbar.height}
        containerColor={nativeColor(containerColor)}
        selectedColor={nativeColor(selectedColor)}
        indicatorColor={nativeColor(indicatorColor)}
        unselectedColor={nativeColor(unselectedColor)}
        actionColor={nativeColor(colors["--color-primary"])}
        actionContentColor={nativeColor(colors["--color-primary-foreground"])}
        environmentLabel={currentEnvironment?.environmentLabel ?? "Environment"}
        environmentOnline={currentEnvironment?.connectionState === "connected"}
        quickThreadKeys={quickThreads.map(({ thread }) =>
          scopedThreadKey(thread.environmentId, thread.id),
        )}
        quickThreadTitles={quickThreads.map(({ thread }) => thread.title)}
        quickThreadWorking={quickThreads.map(({ working }) => working)}
        selectedThreadKey={
          selectedThread ? scopedThreadKey(selectedThread.environmentId, selectedThread.id) : ""
        }
        onTabSelected={(event) => {
          Keyboard.dismiss();
          const tab = event.nativeEvent.tab;
          if (tab !== "settings") workspace.dispatch({ type: "select", tab });
          // Reset the root stack even when a nested settings navigator has focus.
          // The provider renders inside the root stack's layout, so the container's root state is
          // that stack's current state.
          const rootState = rootNavigationRef.getRootState();
          if (root && rootState) {
            navigation.dispatch({
              ...CommonActions.reset(
                androidWorkspaceTabNavigationState(rootState, tab, layout.usesSplitView),
              ),
              target: root.key,
            });
          }
          props.onSelect?.();
        }}
        onNewThread={() => {
          Keyboard.dismiss();
          props.onNewThread();
        }}
        onEnvironmentSelected={() => {
          Keyboard.dismiss();
          workspace.dispatch({ type: "select", tab: "threads" });
          props.onSelect?.();
        }}
        onThreadSelected={(event) => {
          Keyboard.dismiss();
          const selected = quickThreads.find(
            ({ thread }) =>
              scopedThreadKey(thread.environmentId, thread.id) === event.nativeEvent.key,
          )?.thread;
          if (!selected) return;
          selectDetail({
            name: "Thread",
            params: { environmentId: selected.environmentId, threadId: selected.id },
          });
        }}
        onOverlayChange={(event) => props.onOverlayChange?.(event.nativeEvent.overlay)}
        style={
          rail
            ? { flex: 1 }
            : floating
              ? {
                  width: metrics.pill + 2 * FLOATING_TABS.shadow,
                  height: metrics.height + 2 * FLOATING_TABS.shadow,
                }
              : { height: 80 * Math.max(1, scale) }
        }
      />
    </View>
  );
}

export function FloatingWorkspaceTabs(props: {
  readonly fillWidth?: boolean;
  readonly onNewThread: () => void;
  readonly paneWidth?: number;
  readonly onSelect?: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: Math.max(insets.left, FLOATING_TABS.edge) - FLOATING_TABS.shadow,
        right: 0,
        bottom: insets.bottom + FLOATING_TABS.bottom - FLOATING_TABS.shadow,
        alignItems: "flex-start",
      }}
    >
      <AndroidWorkspaceNavigation {...props} floating />
    </View>
  );
}
