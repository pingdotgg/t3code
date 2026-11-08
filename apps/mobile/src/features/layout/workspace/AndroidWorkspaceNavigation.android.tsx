import { selectedNavigationTab, visibleNavigationTabs } from "./navigation-tab-order";
import { requireNativeView } from "expo";
import { CommonActions, useNavigation } from "@react-navigation/native";
import {
  Keyboard,
  Pressable,
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
import { androidWorkspaceNavigationColors } from "./android-workspace-navigation-colors";
import {
  androidWorkspaceTabNavigationState,
  type AndroidWorkspaceNavigationTab,
} from "./android-workspace-tabs";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import { useSoftKeyboardShowing } from "../../keyboard/useSoftKeyboardShowing";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { useAndroidWorkspaceRoot } from "./AndroidWorkspaceTabsProvider";
import { useNavigationTabOrder, useHiddenNavigationTabs } from "./navigation-tabs";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { FLOATING_TABS, floatingTabsMetrics } from "./floating-workspace-tabs";
import { NAVIGATION_TAB_ICONS, WORKSPACE_TAB_LABELS } from "./navigation-tabs";
import { AppText } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";

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
  readonly onTabSelected: (
    event: NativeSyntheticEvent<{ readonly tab: AndroidWorkspaceNavigationTab }>,
  ) => void;
  readonly onNewThread: () => void;
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
  /** The rail needs the whole workspace while it widens over the list. */
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
  const keyboardVisible = useSoftKeyboardShowing();
  const { layout, keyboardHoldsSidebar } = useAdaptiveWorkspaceLayout();
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const { scale, fabSize } = useAndroidControlSizing();
  const window = useWindowDimensions();
  const rail = Boolean(props.rail);
  const floating = !rail && Boolean(props.floating);
  const tabs: readonly AndroidWorkspaceNavigationTab[] = [
    ...visibleNavigationTabs(order, hidden, rail ? 5 : 4),
    "settings",
  ];
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
  const selectTab = (tab: AndroidWorkspaceNavigationTab) => {
    Keyboard.dismiss();
    if (tab !== "settings") workspace.dispatch({ type: "select", tab });
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
  };
  // The composer's keyboard slides the sidebar away with the bar on it; other keyboards don't.
  if (!rail && keyboardVisible && !keyboardHoldsSidebar) return null;

  if (!rail) {
    return (
      <View
        style={
          floating
            ? {
                width: metrics.pill + 2 * FLOATING_TABS.shadow,
                height: metrics.height + 2 * FLOATING_TABS.shadow,
                padding: FLOATING_TABS.shadow,
              }
            : { backgroundColor: colors["--color-screen"], paddingBottom: insets.bottom }
        }
      >
        <View
          className={
            floating
              ? "flex-1 flex-row items-center rounded-2xl border border-border-subtle bg-card-alt px-1"
              : "mx-2 mb-2 flex-row items-center gap-1"
          }
          style={floating ? undefined : { minHeight: 56 * Math.max(1, scale) }}
          accessibilityRole="tablist"
        >
          {tabs.map((tab) => {
            const selected = selectedTab === tab;
            const label = tab === "settings" ? "Settings" : WORKSPACE_TAB_LABELS[tab];
            return (
              <Pressable
                key={tab}
                accessibilityRole="tab"
                accessibilityLabel={label}
                accessibilityState={{ selected }}
                onPress={() => selectTab(tab)}
                android_ripple={{ color: colors["--color-subtle-strong"] }}
                className={
                  selected
                    ? "flex-1 items-center justify-center gap-1 overflow-hidden rounded-xl bg-subtle-strong py-1.5"
                    : "flex-1 items-center justify-center gap-1 overflow-hidden rounded-xl py-1.5"
                }
                style={{ minHeight: floating ? metrics.height : 48 * Math.max(1, scale) }}
              >
                <SymbolView
                  name={tab === "settings" ? "gearshape" : NAVIGATION_TAB_ICONS[tab]}
                  size={20 * scale}
                  tintColorClassName={selected ? "accent-foreground" : "accent-foreground-muted"}
                />
                {!floating ? (
                  <AppText
                    textRole="micro"
                    numberOfLines={1}
                    className={
                      selected ? "font-t3-medium text-foreground" : "text-foreground-muted"
                    }
                  >
                    {label}
                  </AppText>
                ) : null}
              </Pressable>
            );
          })}
          {!floating ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New thread"
              accessibilityState={{ disabled: !connectionState.hasConnections }}
              disabled={!connectionState.hasConnections}
              onPress={() => {
                Keyboard.dismiss();
                props.onNewThread();
              }}
              android_ripple={{ color: colors["--color-primary-foreground"] }}
              className="ml-1 items-center justify-center overflow-hidden rounded-xl bg-primary disabled:opacity-35"
              style={{ width: 48 * Math.max(1, scale), height: 48 * Math.max(1, scale) }}
            >
              <SymbolView
                name="plus"
                size={22 * scale}
                tintColorClassName="accent-primary-foreground"
              />
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <NativeNavigation
        rail={rail}
        floating={false}
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
        onTabSelected={(event) => selectTab(event.nativeEvent.tab)}
        onNewThread={() => {
          Keyboard.dismiss();
          props.onNewThread();
        }}
        onOverlayChange={(event) => props.onOverlayChange?.(event.nativeEvent.overlay)}
        style={{ flex: 1 }}
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
