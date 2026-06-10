import { Stack } from "expo-router";
import { useThemeColor } from "../../../lib/useThemeColor";

export default function AddProjectLayout() {
  const sheetStyle = {
    backgroundColor: useThemeColor("--color-sheet"),
  };

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: sheetStyle }}>
      <Stack.Screen name="index" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="repository" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="destination" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="local" options={{ animation: "slide_from_right" }} />
    </Stack>
  );
}
