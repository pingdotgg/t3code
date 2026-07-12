import { BlurTargetView } from "expo-blur";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StatusBar, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createStaticNavigation, DarkTheme, DefaultTheme } from "@react-navigation/native";

import { RegistryContext } from "@effect/atom-react";
import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { AppearancePreferencesProvider } from "./features/settings/appearance/AppearancePreferencesProvider";
import { RootStack } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { OverlayPortalHost } from "./components/OverlayPortal";
import { appBlurTargetRef } from "./lib/appBlurTarget";
import { useThemeColor } from "./lib/useThemeColor";

import "../global.css";

const appLinking = {
  prefixes: [Linking.createURL("/"), "t3code://", "t3code-dev://", "t3code-preview://"],
  // The Expo dev client launches the app via
  // <scheme>://expo-development-client/?url=<packager> — that URL addresses
  // the launcher, not app navigation. Without this filter it falls through
  // to the NotFound wildcard route on every dev launch.
  filter: (url: string) => !url.includes("expo-development-client"),
};

const Navigation = createStaticNavigation(RootStack);

export default function App() {
  const colorScheme = useColorScheme();
  const statusBarBg = useThemeColor("--color-status-bar");

  useEffect(() => {
    SplashScreen.hide();
  }, []);

  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudAuthProvider>
        <AppearancePreferencesProvider>
          <GestureHandlerRootView className="flex-1">
            <KeyboardProvider statusBarTranslucent>
              <SafeAreaProvider>
                <StatusBar
                  barStyle={colorScheme === "dark" ? "light-content" : "dark-content"}
                  backgroundColor={statusBarBg}
                  translucent
                />
                {/* The navigation theme drives the NATIVE header appearance: native-stack
                    forwards `dark` as the nav bar's overrideUserInterfaceStyle. Without
                    this, React Navigation defaults to its light theme and every native
                    header (glass buttons, title, materials) is forced light even when
                    the system is in dark mode. */}
                {/* Blur target for Android dropdown backdrops — see appBlurTarget.ts. */}
                <BlurTargetView ref={appBlurTargetRef} style={{ flex: 1 }}>
                  <Navigation
                    linking={appLinking}
                    theme={colorScheme === "dark" ? DarkTheme : DefaultTheme}
                  />
                  <ConfirmDialogHost />
                </BlurTargetView>
                {/* Anchored-menu overlays render here — in-window, so the
                    keyboard stays up while a dropdown is open. */}
                <OverlayPortalHost />
              </SafeAreaProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </AppearancePreferencesProvider>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}
