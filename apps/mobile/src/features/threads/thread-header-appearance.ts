import { Platform } from "react-native";
import {
  nativeHeaderScrollEdgeEffects,
  type AppNativeStackNavigationOptions,
} from "../../native/StackHeader";

export function threadHeaderAppearance(
  usesNativeHeaderGlass: boolean,
): AppNativeStackNavigationOptions {
  return {
    headerShown: true,
    // A completed project flow can reuse the chooser's route key and dynamic options.
    headerSearchBarOptions: undefined,
    headerTransparent: usesNativeHeaderGlass,
    headerStyle: usesNativeHeaderGlass ? { backgroundColor: "transparent" } : undefined,
    headerShadowVisible: false,
    scrollEdgeEffects: usesNativeHeaderGlass
      ? nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version)
      : undefined,
    headerTitleStyle: usesNativeHeaderGlass ? { fontSize: 17, fontWeight: "800" } : undefined,
    contentStyle: undefined,
  };
}
