import { requireNativeView } from "expo";
import { CommonActions, useNavigation } from "@react-navigation/native";
import {
  Keyboard,
  processColor,
  View,
  type NativeSyntheticEvent,
  type ViewProps,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardState } from "react-native-keyboard-controller";

import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { useWorkspaceConnectionState } from "../../state/workspace";
import { androidWorkspaceNavigationColors } from "./android-workspace-navigation-colors";
import {
  androidWorkspaceTabNavigationState,
  type AndroidWorkspaceNavigationTab,
} from "./android-workspace-tabs";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useAndroidWorkspaceRoot } from "./AndroidWorkspaceTabsProvider";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";

// Material's wide navigation rail is a fixed 96dp; labels scale inside it.
export const ANDROID_WORKSPACE_RAIL_WIDTH = 96;

interface NativeNavigationProps extends ViewProps {
  readonly rail: boolean;
  readonly selectedTab: AndroidWorkspaceNavigationTab;
  readonly dark: boolean;
  readonly textScale: number;
  readonly newEnabled: boolean;
  readonly safeAreaTop: number;
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
}

const NativeNavigation = requireNativeView<NativeNavigationProps>("T3WorkspaceNavigation");

function nativeColor(value: string) {
  const color = processColor(value);
  return typeof color === "number" ? color : 0;
}

export function AndroidWorkspaceNavigation(props: {
  readonly rail?: boolean;
  readonly onSelect?: () => void;
}) {
  const workspace = useWorkspaceTabs()!;
  const root = useAndroidWorkspaceRoot();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const toolbar = useToolbarLayout();
  const connectionState = useWorkspaceConnectionState();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const { scale } = useAndroidControlSizing();
  const rail = Boolean(props.rail);
  const { containerColor, indicatorColor, selectedColor, unselectedColor } =
    androidWorkspaceNavigationColors(colors, rail);
  const selectedTab: AndroidWorkspaceNavigationTab = root?.settingsOpen
    ? "settings"
    : workspace.state.selectedTab;
  if (!rail && keyboardVisible) return null;

  return (
    <View
      style={{
        backgroundColor: containerColor,
        ...(rail
          ? {
              flex: 1,
              width: ANDROID_WORKSPACE_RAIL_WIDTH,
              paddingTop: toolbar.paddingTop,
              paddingBottom: insets.bottom,
            }
          : { paddingBottom: insets.bottom }),
      }}
    >
      <NativeNavigation
        rail={rail}
        selectedTab={selectedTab}
        dark={themeAppearance === "dark"}
        textScale={scale}
        newEnabled={connectionState.hasConnections}
        safeAreaTop={toolbar.paddingTop}
        headerHeight={toolbar.height}
        containerColor={nativeColor(containerColor)}
        selectedColor={nativeColor(selectedColor)}
        indicatorColor={nativeColor(indicatorColor)}
        unselectedColor={nativeColor(unselectedColor)}
        actionColor={nativeColor(colors["--color-primary"])}
        actionContentColor={nativeColor(colors["--color-primary-foreground"])}
        onTabSelected={(event) => {
          Keyboard.dismiss();
          const tab = event.nativeEvent.tab;
          if (tab !== selectedTab) {
            if (tab !== "settings") workspace.dispatch({ type: "select", tab });
            // Reset the root stack even when a nested settings navigator has focus.
            if (root) {
              navigation.dispatch({
                ...CommonActions.reset(androidWorkspaceTabNavigationState(root.getState(), tab)),
                target: root.key,
              });
            }
          }
          props.onSelect?.();
        }}
        onNewThread={() => {
          Keyboard.dismiss();
          navigation.navigate("NewTaskSheet", { screen: "NewTask" });
        }}
        style={rail ? { flex: 1 } : { height: 80 * Math.max(1, scale) }}
      />
    </View>
  );
}
