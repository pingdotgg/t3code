import Stack from "expo-router/stack";
import { useResolveClassNames } from "uniwind";
import { useThemeColor } from "../../lib/useThemeColor";

export const unstable_settings = {
  anchor: "index",
};

export default function ConnectionsLayout() {
  const contentStyle = useResolveClassNames("bg-sheet");
  const connSheetBg = useThemeColor("--color-sheet");
  const headerTint = useThemeColor("--color-foreground");

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
