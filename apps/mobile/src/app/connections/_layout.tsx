import Stack from "expo-router/stack";
import { useColorScheme } from "react-native";
import { useResolveClassNames } from "uniwind";

export const unstable_settings = {
  anchor: "index",
};

export default function ConnectionsLayout() {
  const contentStyle = useResolveClassNames("bg-sheet");
  const isDark = useColorScheme() === "dark";
  const connSheetBg = isDark ? "rgba(14, 14, 14, 0.98)" : "rgba(242, 242, 247, 0.98)";
  const headerTint = isDark ? "#f5f5f5" : "#262626";

  return (
    <Stack
      screenOptions={{
        contentStyle,
        headerStyle: { backgroundColor: connSheetBg },
        headerTintColor: headerTint,
        headerTitleStyle: { fontFamily: "DMSans_700Bold" },
        headerShadowVisible: false,
        headerBackButtonDisplayMode: "minimal",
      }}
    >
      <Stack.Screen name="index" options={{ animation: "none" }} />
      <Stack.Screen name="new" options={{ animation: "slide_from_right" }} />
    </Stack>
  );
}
