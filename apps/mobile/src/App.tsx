import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StatusBar, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createStaticNavigation, DarkTheme, DefaultTheme } from "@react-navigation/native";

import { RegistryContext } from "@effect/atom-react";
import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { AppearancePreferencesProvider } from "./features/settings/appearance/AppearancePreferencesProvider";
import { RootStack } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { useThemeColor } from "./lib/useThemeColor";

import "../global.css";

const appLinking = {
  prefixes: [Linking.createURL("/"), "t3code://", "t3code-dev://", "t3code-preview://"],
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
          <GestureHandlerRootView style={{ flex: 1 }}>
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
                <Navigation
                  linking={appLinking}
                  theme={colorScheme === "dark" ? DarkTheme : DefaultTheme}
                />
              </SafeAreaProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </AppearancePreferencesProvider>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}
