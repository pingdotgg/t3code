import "../../global.css";
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_700Bold,
  useFonts,
} from "@expo-google-fonts/dm-sans";
import { usePathname } from "expo-router";
import Stack from "expo-router/stack";
import { useCallback } from "react";
import { StatusBar, useColorScheme, useWindowDimensions } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useResolveClassNames } from "uniwind";

import { LoadingScreen } from "../components/LoadingScreen";

import { useWorkspaceState } from "../state/workspace";
import { useThreadOutboxDrain } from "../state/use-thread-outbox-drain";
import { RegistryContext } from "@effect/atom-react";
import { appAtomRegistry } from "../state/atom-registry";
import { CloudAuthProvider } from "../features/cloud/CloudAuthProvider";
import {
  ClerkSettingsSheetDetentProvider,
  useClerkSettingsSheetDetent,
} from "../features/cloud/ClerkSettingsSheetDetent";
import { useAgentNotificationNavigation } from "../features/agent-awareness/notificationNavigation";
import {
  AdaptiveWorkspaceLayout,
  useAdaptiveWorkspaceLayout,
} from "../features/layout/AdaptiveWorkspaceLayout";
import { deriveStableFormSheetDetent } from "../lib/layout";
import { useThemeColor } from "../lib/useThemeColor";
import { HardwareKeyboardCommandProvider } from "../features/keyboard/HardwareKeyboardCommandProvider";

function AppNavigator() {
  const pathname = usePathname();
  const expandedSettingsRouteIsActive =
    pathname === "/settings/archive" || pathname === "/settings/auth";

  return (
    <ClerkSettingsSheetDetentProvider initiallyExpanded={expandedSettingsRouteIsActive}>
      <AppNavigatorContent />
    </ClerkSettingsSheetDetentProvider>
  );
}

function AppNavigatorContent() {
  const { state } = useWorkspaceState();
  const colorScheme = useColorScheme();
  const statusBarBg = useThemeColor("--color-status-bar");
  useAgentNotificationNavigation();
  useThreadOutboxDrain();

  if (state.isLoadingConnections) {
    return <LoadingScreen message="Loading remote workspace…" />;
  }

  return (
    <>
      <StatusBar
        barStyle={colorScheme === "dark" ? "light-content" : "dark-content"}
        backgroundColor={String(statusBarBg)}
        translucent
      />
      <AdaptiveWorkspaceLayout>
        <WorkspaceNavigator />
      </AdaptiveWorkspaceLayout>
    </>
  );
}

function WorkspaceNavigator() {
  const { collapse, isExpanded } = useClerkSettingsSheetDetent();
  const { layout } = useAdaptiveWorkspaceLayout();
  const { height } = useWindowDimensions();
  const sheetStyle = useResolveClassNames("bg-sheet");

  const handleSettingsTransitionEnd = useCallback(
    (event: { data: { closing: boolean } }) => {
      if (event.data.closing) {
        collapse();
      }
    },
    [collapse],
  );

  const connectionSheetScreenOptions = {
    contentStyle: sheetStyle,
    gestureEnabled: true,
    headerShown: false,
    presentation: "formSheet" as const,
    sheetAllowedDetents: [0.55, 0.7],
    sheetGrabberVisible: true,
  };
  const settingsScreenOptions = layout.usesSplitView
    ? {
        animation: "none" as const,
        contentStyle: sheetStyle,
        gestureEnabled: false,
        headerShown: false,
        presentation: "card" as const,
      }
    : {
        ...connectionSheetScreenOptions,
        sheetAllowedDetents: isExpanded ? [0.92] : [0.7],
      };
  const newTaskScreenOptions = {
    contentStyle: sheetStyle,
    gestureEnabled: true,
    headerShown: false,
    presentation: "formSheet" as const,
    sheetAllowedDetents: [layout.usesSplitView ? deriveStableFormSheetDetent(height) : 0.92],
    sheetGrabberVisible: !layout.usesSplitView,
  };

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen
        name="index"
        options={{
          contentStyle: { backgroundColor: "transparent" },
          headerShown: true,
          headerTransparent: true,
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name="settings"
        listeners={{ transitionEnd: handleSettingsTransitionEnd }}
        options={settingsScreenOptions}
      />
      <Stack.Screen name="connections" options={connectionSheetScreenOptions} />
      <Stack.Screen name="new" options={newTaskScreenOptions} />
      <Stack.Screen
        name="threads/[environmentId]/[threadId]"
        options={{
          animation: layout.usesSplitView ? "none" : "slide_from_right",
          contentStyle: { backgroundColor: "transparent" },
          gestureEnabled: !layout.usesSplitView,
          headerShown: false,
        }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_700Bold,
  });
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudAuthProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <KeyboardProvider statusBarTranslucent>
            <SafeAreaProvider>
              <HardwareKeyboardCommandProvider>
                {fontsLoaded ? (
                  <AppNavigator />
                ) : (
                  <LoadingScreen message="Loading remote workspace…" />
                )}
              </HardwareKeyboardCommandProvider>
            </SafeAreaProvider>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}
