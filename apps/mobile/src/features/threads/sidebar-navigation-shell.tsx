import { createV5StackNavigator as createNativeStackNavigator } from "../../native/createV5StackNavigator";
import { NavigationContainer, NavigationIndependentTree } from "@react-navigation/native";
import { type NativeStackNavigationOptions } from "@react-navigation/native-stack";
import type { ReactNode } from "react";
import { Platform } from "react-native";

import { getCompactBrandHeaderOptions } from "../../components/CompactBrandTitle";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { useMobileNavigationTheme } from "../../lib/useMobileNavigationTheme";

const SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type SidebarScreenOptions = NativeStackNavigationOptions & {
  // Same patched RNS option the GLASS/SOLID presets in Stack.tsx use — the
  // iOS 26 "editor" navigation-item style leading-aligns the inline title.
  readonly unstable_navigationItemStyle?: "editor";
};

const SIDEBAR_SCREEN_OPTIONS: SidebarScreenOptions = {
  contentStyle: { backgroundColor: "transparent" },
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? { backgroundColor: "transparent" } : undefined,
  ...getCompactBrandHeaderOptions({ fontSize: 18, fontWeight: "800" }),
  headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
  scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED ? SCROLL_EDGE_EFFECTS : undefined,
  unstable_navigationItemStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? "editor" : undefined,
};

const SidebarStack = createNativeStackNavigator();

export function SidebarNavigationShell(props: { readonly children: ReactNode }) {
  const navigationTheme = useMobileNavigationTheme("sidebar");

  return (
    <NavigationIndependentTree>
      <NavigationContainer theme={navigationTheme}>
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
