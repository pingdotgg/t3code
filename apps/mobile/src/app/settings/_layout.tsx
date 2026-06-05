import Stack from "expo-router/stack";
import { useColorScheme } from "react-native";
import { useResolveClassNames } from "uniwind";

export const unstable_settings = {
  anchor: "index",
};

export default function SettingsLayout() {
  const contentStyle = useResolveClassNames("bg-sheet");
  const isDark = useColorScheme() === "dark";
  const sheetBg = isDark ? "rgba(14, 14, 14, 0.98)" : "rgba(242, 242, 247, 0.98)";
  const headerTint = isDark ? "#f5f5f5" : "#262626";

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
      <Stack.Screen
        name="waitlist"
        options={{ animation: "slide_from_right", title: "Join the waitlist" }}
      />
    </Stack>
  );
}
