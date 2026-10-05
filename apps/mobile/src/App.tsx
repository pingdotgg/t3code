import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createStaticNavigation } from "@react-navigation/native";

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { resolveLanguage } from "@t3tools/client-runtime/i18n";
import { changeLanguage, i18n } from "./i18n";
import { mobilePreferencesAtom } from "./state/preferences";
import { ThreadArrangementHost } from "./features/threads/ThreadArrangementSheet";
import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { prepareNativeShowcaseCapture } from "./features/showcase/nativeShowcaseScene";
import { IncomingShareProvider } from "./features/sharing/IncomingShareProvider";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "./features/settings/appearance/AppearancePreferencesProvider";
import { RootStack } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { OverlayPortalHost } from "./components/OverlayPortal";
import { shouldHandleAppLink } from "./lib/appLinking";
import { useMobileNavigationTheme } from "./lib/useMobileNavigationTheme";
import { SubscriptionUsageCoordinator } from "./widgets/SubscriptionUsageCoordinator";
import { VoiceInputProvider } from "./features/voice-input/VoiceInputProvider";
import { GlobalVoiceInputControl } from "./features/voice-input/GlobalVoiceInputControl";

import "../global.css";

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  prepareNativeShowcaseCapture();
}

void SplashScreen.preventAutoHideAsync().catch(() => {
  // The native module can be unavailable in non-native test environments.
});

const appLinking = {
  prefixes: [Linking.createURL("/"), "t3code://", "t3code-dev://", "t3code-preview://"],
  // Keep the compact thread list available beneath a directly opened thread.
  config: { initialRouteName: "Home" },
  filter: shouldHandleAppLink,
};

const Navigation = createStaticNavigation(RootStack);

/**
 * Applies the stored language preference to i18next.
 *
 * The host locale is read here rather than at module load so a language the
 * user picked is never overridden by the device on startup.
 */
function LanguageSync() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const languagePreference = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.languagePreference ?? "system")
    : "system";

  useEffect(() => {
    const language = resolveLanguage(languagePreference, [deviceLocale()]);
    if (i18n.resolvedLanguage !== language) {
      void changeLanguage(language);
    }
  }, [languagePreference]);

  return null;
}

/**
 * The device's preferred locale.
 *
 * Hermes reads this from the native locale settings, so it is coarser than
 * `expo-localization.getLocales()`; bring that in if per-region matching is
 * ever needed.
 */
function deviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();

  useEffect(() => {
    if (isReady) void SplashScreen.hide();
  }, [isReady]);

  return null;
}

export default function App() {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudAuthProvider>
        <AppearancePreferencesProvider>
          <AppContent />
        </AppearancePreferencesProvider>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}

function AppContent() {
  const { themeAppearance } = useAppearancePreferences();
  const navigationTheme = useMobileNavigationTheme();

  return (
    <>
      <SplashScreenCoordinator />
      <LanguageSync />
      <SubscriptionUsageCoordinator />
      <GestureHandlerRootView className="flex-1">
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            <VoiceInputProvider>
              <StatusBar barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"} />
              {/* The navigation theme drives the NATIVE header appearance: native-stack
                forwards `dark` as the nav bar's overrideUserInterfaceStyle. Without
                this, React Navigation defaults to its light theme and every native
                header (glass buttons, title, materials) is forced light even when
                the system is in dark mode. */}
              <GlobalVoiceInputControl>
                <IncomingShareProvider>
                  <Navigation linking={appLinking} theme={navigationTheme} />
                </IncomingShareProvider>
                <ConfirmDialogHost />
                <ThreadArrangementHost />
              </GlobalVoiceInputControl>
              {/* Anchored-menu overlays render here — in-window, so the
                keyboard stays up while a dropdown is open. */}
              <OverlayPortalHost />
            </VoiceInputProvider>
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </>
  );
}
