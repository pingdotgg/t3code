import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  NavigationIndependentTree,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import type { ReactNode } from "react";
import { Platform, useColorScheme } from "react-native";

import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";

const SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type SidebarScreenOptions = NativeStackNavigationOptions & {
  // Same patched RNS option the GLASS/SOLID presets in Stack.tsx use — the
  // iOS 26 "editor" navigation-item style leading-aligns the inline title.
  readonly unstable_navigationItemStyle?: "editor";
};

/**
 * Static chrome for the sidebar column: a real UINavigationBar with a fixed
 * inline title (no large title — saves vertical space, left-aligned via the
 * editor item style) and the search bar pinned below it, scroll-edge blur
 * sampling the list. Only genuinely dynamic values (search callbacks, header
 * items) are set by the screen content via NativeStackScreenOptions.
 */
const SIDEBAR_SCREEN_OPTIONS: SidebarScreenOptions = {
  contentStyle: { backgroundColor: "transparent" },
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerStyle: { backgroundColor: "transparent" },
  headerTitleStyle: { fontSize: 18, fontWeight: "800" },
  headerTransparent: true,
  scrollEdgeEffects: SCROLL_EDGE_EFFECTS,
  title: "Threads",
  unstable_navigationItemStyle: "editor",
};

const SidebarStack = createNativeStackNavigator();

/**
 * Hosts the iPad sidebar pane inside its own single-screen native stack.
 *
 * The stack is navigation-inert — nothing is ever pushed onto it. It exists so
 * the sidebar column owns a real UINavigationBar (large title, native bar
 * button items, UISearchController), mirroring how each column of a
 * UISplitViewController has its own UINavigationController. All real
 * navigation still flows through the root stack via callbacks minted in
 * AdaptiveWorkspaceLayout; NavigationIndependentTree only isolates the
 * navigation hooks used for header configuration inside the pane.
 */
export function SidebarNavigationShell(props: { readonly children: ReactNode }) {
  const colorScheme = useColorScheme();

  return (
    <NavigationIndependentTree>
      <NavigationContainer theme={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
        <SidebarStack.Navigator
          screenOptions={SIDEBAR_SCREEN_OPTIONS}
          initialRouteName="SidebarThreads"
        >
          <SidebarStack.Screen name="SidebarThreads">{() => props.children}</SidebarStack.Screen>
        </SidebarStack.Navigator>
      </NavigationContainer>
    </NavigationIndependentTree>
  );
}
