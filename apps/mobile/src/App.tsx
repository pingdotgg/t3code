import { PermissionUpdateNotice } from "./features/connection/PermissionUpdateNotice";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createStaticNavigation, getStateFromPath } from "@react-navigation/native";

import { RegistryContext } from "@effect/atom-react";
import { ProjectChipIconRasterizer } from "./native/ProjectChipIconImages";
import { ThreadArrangementHost } from "./features/threads/ThreadArrangementSheet";
import * as Dialog from "./components/ui/Dialog";
import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { prepareNativeShowcaseCapture } from "./features/showcase/nativeShowcaseScene";
import { IncomingShareProvider } from "./features/sharing/IncomingShareProvider";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "./features/settings/appearance/AppearancePreferencesProvider";
import { RootStack } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { subscribeComposerDraftModelReconciliation } from "./state/use-composer-drafts";
import { environmentThreadShells } from "./state/threads";
import { environmentShell } from "./state/shell";
import { OverlayPortalHost } from "./components/ui/OverlayPortal";
import { shouldHandleAppLink, restoreDraftLinkState } from "./lib/appLinking";
import { useMobileNavigationTheme } from "./lib/useMobileNavigationTheme";
import { useUiRuntimeMemoryWarningGc } from "./lib/useUiRuntimeMemoryWarningGc";
import { SubscriptionUsageCoordinator } from "./widgets/SubscriptionUsageCoordinator";
import { VoiceInputProvider } from "./features/voice-input/VoiceInputProvider";
import { GlobalVoiceInputControl } from "./features/voice-input/GlobalVoiceInputControl";
import { restoreSettingsLinkState } from "./features/settings/settings-navigation";
import {
  hydrateWorkspaceSelections,
  launchWorkspaceURL,
  recordWorkspaceSelections,
  settingsLinkPage,
} from "./features/workspace/workspace-selection-store";
import { NativeLayoutMetricsProvider } from "./native/native-layout-metrics";

import "../global.css";

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  prepareNativeShowcaseCapture();
}

void SplashScreen.preventAutoHideAsync().catch(() => {});
void hydrateWorkspaceSelections();

const appLinking = {
  prefixes: [Linking.createURL("/"), "t3code://", "t3code-dev://", "t3code-preview://"],
  config: { initialRouteName: "Home" },
  filter: shouldHandleAppLink,
  getInitialURL: async () => (await Linking.getInitialURL()) ?? (await launchWorkspaceURL()),
  getStateFromPath: (path: string, options: Parameters<typeof getStateFromPath>[1]) =>
    restoreSettingsLinkState(
      restoreDraftLinkState(getStateFromPath(path, options), path),
      settingsLinkPage(),
    ),
};

const Navigation = createStaticNavigation(RootStack);

function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();

  useEffect(() => {
    if (isReady) void SplashScreen.hide();
  }, [isReady]);

  return null;
}

export default function App() {
  useUiRuntimeMemoryWarningGc();
  useEffect(
    () =>
      subscribeComposerDraftModelReconciliation({
        registry: appAtomRegistry,
        threadShellAtom: environmentThreadShells.threadShellAtom,
        threadRefsAtom: environmentThreadShells.threadRefsAtom,
        shellStateAtom: environmentShell.stateAtom,
      }),
    [],
  );

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
      <SubscriptionUsageCoordinator />
      <PermissionUpdateNotice />
      <GestureHandlerRootView className="flex-1">
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            <VoiceInputProvider>
              <StatusBar barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"} />
              {/* native-stack needs the theme's dark flag to select dark native headers. */}
              <GlobalVoiceInputControl>
                <NativeLayoutMetricsProvider>
                  <IncomingShareProvider>
                    <Navigation
                      linking={appLinking}
                      theme={navigationTheme}
                      onStateChange={recordWorkspaceSelections}
                    />
                  </IncomingShareProvider>
                  <Dialog.Host />
                  <ThreadArrangementHost />
                  <ProjectChipIconRasterizer />
                </NativeLayoutMetricsProvider>
              </GlobalVoiceInputControl>
              <OverlayPortalHost />
            </VoiceInputProvider>
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </>
  );
}
