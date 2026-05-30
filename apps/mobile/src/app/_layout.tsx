import "../../global.css";
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_700Bold,
  useFonts,
} from "@expo-google-fonts/dm-sans";
import Stack from "expo-router/stack";
import { StatusBar, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useCSSVariable, useResolveClassNames } from "uniwind";

import { LoadingScreen } from "../components/LoadingScreen";

import {
  useRemoteEnvironmentBootstrap,
  useRemoteEnvironmentState,
} from "../state/use-remote-environment-registry";
import { RegistryContext } from "@effect/atom-react";
import { appAtomRegistry } from "../state/atom-registry";

function AppNavigator() {
  const { isLoadingSavedConnection } = useRemoteEnvironmentState();
  const colorScheme = useColorScheme();
  const statusBarBg = useCSSVariable("--color-status-bar");
  const sheetStyle = useResolveClassNames("bg-sheet");

  const newTaskScreenOptions = {
    contentStyle: sheetStyle,
    gestureEnabled: true,
    headerShown: false,
    presentation: "formSheet" as const,
    sheetAllowedDetents: [0.92],
    sheetGrabberVisible: true,
  };

  const connectionSheetScreenOptions = {
    contentStyle: sheetStyle,
    gestureEnabled: true,
    headerShown: false,
    presentation: "formSheet" as const,
    sheetAllowedDetents: [0.55, 0.7],
    sheetGrabberVisible: true,
  };

  if (isLoadingSavedConnection) {
    return <LoadingScreen message="Loading remote workspace…" />;
  }

  return (
    <>
      <StatusBar
        barStyle={colorScheme === "dark" ? "light-content" : "dark-content"}
        backgroundColor={statusBarBg as string}
        translucent
      />
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
        <Stack.Screen name="connections" options={connectionSheetScreenOptions} />
        <Stack.Screen name="new" options={newTaskScreenOptions} />
        <Stack.Screen
          name="threads/[environmentId]/[threadId]"
          options={{
            animation: "slide_from_right",
            contentStyle: { backgroundColor: "transparent" },
            gestureEnabled: true,
            headerShown: false,
          }}
        />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_700Bold,
  });
  useRemoteEnvironmentBootstrap();

  return (
    <RegistryContext value={appAtomRegistry}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            {fontsLoaded ? <AppNavigator /> : <LoadingScreen message="Loading remote workspace…" />}
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </RegistryContext>
  );
}
