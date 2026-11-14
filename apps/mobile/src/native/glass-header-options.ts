import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { Platform } from "react-native";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "./native-glass";
import { nativeHeaderScrollEdgeEffects } from "./scrollEdgeEffects";

export type AppScreenOptions = NativeStackNavigationOptions & {
  readonly unstable_navigationItemStyle?: "editor";
  readonly unstable_headerMinimizationBehavior?: "onScrollUp" | "never";
};

/** A transparent bar that content scrolls under, with UIKit's scroll-edge blur where it has one. */
export const GLASS_HEADER_OPTIONS: AppScreenOptions = {
  headerBackButtonDisplayMode: "minimal",
  headerBackTitle: "",
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? { backgroundColor: "transparent" } : undefined,
  headerTitleStyle: { fontSize: 18, fontWeight: "800" },
  headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
  scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED
    ? nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version)
    : undefined,
  unstable_navigationItemStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? "editor" : undefined,
};
