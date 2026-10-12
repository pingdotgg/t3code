import { requireNativeView } from "expo";
import { CommonActions, useNavigation } from "@react-navigation/native";
import { androidWorkspaceNavigationState } from "../../lib/android-workspace-navigation";
import {
  Keyboard,
  processColor,
  View,
  type NativeSyntheticEvent,
  type ViewProps,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardState } from "react-native-keyboard-controller";

import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { flattenThemeColor, themeColorWithAlpha } from "../../lib/mobileTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

export const ANDROID_WORKSPACE_RAIL_WIDTH = 80;

interface NativeNavigationProps extends ViewProps {
  readonly rail: boolean;
  readonly selectedTab: WorkspaceTab;
  readonly dark: boolean;
  readonly textScale: number;
  readonly containerColor: number;
  readonly selectedColor: number;
  readonly indicatorColor: number;
  readonly unselectedColor: number;
  readonly onTabSelected: (event: NativeSyntheticEvent<{ readonly tab: WorkspaceTab }>) => void;
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
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const { scale } = useAndroidControlSizing();
  const rail = Boolean(props.rail);
  const containerColor = rail
    ? colors["--color-header"]
    : flattenThemeColor(
        themeColorWithAlpha(colors["--color-header-foreground"], 0.05),
        flattenThemeColor(colors["--color-header"], colors["--color-screen"]),
      );
  if (!rail && keyboardVisible) return null;

  return (
    <View
      style={{
        backgroundColor: containerColor,
        ...(rail
          ? {
              flex: 1,
              width: ANDROID_WORKSPACE_RAIL_WIDTH * Math.max(1, scale),
              paddingTop: insets.top,
              paddingBottom: insets.bottom,
            }
          : { paddingBottom: insets.bottom }),
      }}
    >
      <NativeNavigation
        rail={rail}
        selectedTab={workspace.state.selectedTab}
        dark={themeAppearance === "dark"}
        textScale={scale}
        containerColor={nativeColor(containerColor)}
        selectedColor={nativeColor(colors["--color-secondary-foreground"])}
        indicatorColor={nativeColor(colors["--color-secondary"])}
        unselectedColor={nativeColor(colors["--color-header-foreground"])}
        onTabSelected={(event) => {
          Keyboard.dismiss();
          const tab = event.nativeEvent.tab;
          if (tab !== workspace.state.selectedTab) {
            workspace.dispatch({ type: "select", tab });
            navigation.dispatch((state) =>
              CommonActions.reset(androidWorkspaceNavigationState(state)),
            );
          }
          props.onSelect?.();
        }}
        style={rail ? { flex: 1 } : { height: 80 * Math.max(1, scale) }}
      />
    </View>
  );
}
