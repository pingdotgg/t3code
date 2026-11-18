import { NavigationContainer, NavigationIndependentTree } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Platform } from "react-native";

import { useMobileNavigationTheme } from "../../lib/useMobileNavigationTheme";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { createV5StackNavigator } from "../../native/createV5StackNavigator";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import type { AppScreenOptions } from "../../native/glass-header-options";
import { pageRoute } from "./route-options";

/**
 * Screen options for a stack nested in a sheet, so its pages push inside the sheet with the
 * same bar as a sheet route. Android hides the native header: pages draw AppBar in-tree.
 */
export function useSheetStackOptions(): AppScreenOptions {
  const theme = useUniwindTheme();
  const background = theme["--color-sheet-solid"];
  return {
    ...pageRoute({ itemStyle: "standard" }),
    animation: Platform.OS === "android" ? "default" : "slide_from_right",
    contentStyle: { backgroundColor: background },
    gestureEnabled: true,
    headerShown: Platform.OS !== "android",
    headerStyle: { backgroundColor: NATIVE_LIQUID_GLASS_SUPPORTED ? "transparent" : background },
    headerTintColor: theme["--color-foreground"],
  };
}

const Standalone = createV5StackNavigator<{ Standalone: undefined }>();

/**
 * One native stack screen outside the app's navigation tree, for content that needs a native bar
 * but is not a route: a popover, or a column the workspace hosts. Its bar is set from inside with
 * AppBar or SheetHeader like any screen.
 */
export function StandaloneStack(props: {
  readonly surface?: "screen" | "sidebar";
  readonly options?: AppScreenOptions;
  readonly children: ReactNode;
}) {
  const navigationTheme = useMobileNavigationTheme(props.surface);
  return (
    <NavigationIndependentTree>
      <NavigationContainer theme={navigationTheme}>
        <Standalone.Navigator
          screenOptions={{
            ...pageRoute({ itemStyle: "standard" }),
            contentStyle: { backgroundColor: "transparent" },
            headerShown: Platform.OS !== "android",
            ...props.options,
          }}
        >
          <Standalone.Screen name="Standalone">{() => props.children}</Standalone.Screen>
        </Standalone.Navigator>
      </NavigationContainer>
    </NavigationIndependentTree>
  );
}
