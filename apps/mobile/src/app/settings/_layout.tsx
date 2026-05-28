import Stack from "expo-router/stack";
import { useResolveClassNames } from "uniwind";

import { useThemeColor } from "../../lib/useThemeColor";

export const unstable_settings = {
  anchor: "index",
};

export default function SettingsLayout() {
  const contentStyle = useResolveClassNames("bg-sheet");
  const sheetBg = String(useThemeColor("--color-sheet"));
  const headerTint = String(useThemeColor("--color-icon"));

  return (
    <Stack
      screenOptions={{
        contentStyle,
        headerBackButtonDisplayMode: "minimal",
        headerShadowVisible: false,
        headerStyle: { backgroundColor: sheetBg },
        headerTintColor: headerTint,
        headerTitleStyle: { fontFamily: "DMSans_700Bold" },
      }}
    >
      <Stack.Screen name="index" options={{ animation: "none", title: "Settings" }} />
      <Stack.Screen
        name="environments"
        options={{ animation: "slide_from_right", title: "Environments" }}
      />
      <Stack.Screen
        name="environment-new"
        options={{ animation: "slide_from_right", title: "Add Environment" }}
      />
    </Stack>
  );
}
